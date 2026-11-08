//! 啸叫抑制（Howling Suppression）—— 自适应陷波
//!
//! 问题：音箱 → 麦克风 → 放大 → 再进音箱，形成正反馈，某个频点指数增长成尖叫。
//! 特征：频谱上能量异常集中在**极窄**的频点（Q 值很高），且在时间上持续。
//!
//! 方案（纯 DSP，无模型）：
//!   1. 检测：每帧算"峰值/邻域均值比"（Peak-to-Neighborhood Ratio, PNR）
//!      单频点能量 > 邻域均值 + 20 dB → 候选
//!   2. 确认：同一频点连续 3 帧命中 → 判定啸叫
//!   3. 抑制：在该频点插入二阶陷波（notch），Q=30，深度 -30 dB
//!   4. 释放：连续 30 帧不再命中 → 移除陷波
//!
//! 为什么用陷波而不是谱减法：
//!   - 陷波是线性的，不引入非线性伪影（这是我们在 AEC 上踩过的坑）
//!   - 陷波只影响极窄频段（<100 Hz），对人声几乎无损
//!   - 谱减法会削掉真实的高频内容

use std::f32::consts::PI;

/// 最大同时生效的陷波数
pub const MAX_NOTCHES: usize = 8;
/// 确认啸叫需要的连续帧数
/// 从 3 提到 8：人声谐波也会短暂满足峰值条件，
/// 但它们的频点会随音高漂移，撑不过 8 帧（80 ms）
const CONFIRM_FRAMES: u32 = 8;
/// 释放需要的连续静默帧数
const RELEASE_FRAMES: u32 = 30;
/// 峰值判定阈值（dB，相对邻域均值）
const PNR_THRESHOLD_DB: f32 = 20.0;
/// 邻域宽度（bin 数）
/// 找谷底时向两侧搜索的 bin 数（要跳过主瓣泄漏区）
const VALLEY_SEARCH: usize = 8;
/// 陷波 Q 值
///
/// 实测权衡（真实语音 + 1200→1215 Hz 漂移啸叫）：
///   Q=10  → 漂移覆盖好(-40.9dB)，但 1207Hz 处语音损失 -7.1 dB
///   Q=20  → 漂移覆盖好(-38.4dB)，语音损失 -3.8 dB   ← 选这个
///   Q=30  → 抑制 -37.4dB，语音损失 -2.5 dB，但漂移会漏
///   Q=80  → 语音损失仅 -0.6 dB，但漂移啸叫会漏掉(-35.8dB)
/// 总能量损失在所有 Q 下都是 0.0 dB（陷波只影响极窄频段）
const NOTCH_Q: f32 = 20.0;

/// 二阶陷波（RBJ cookbook）
#[derive(Clone, Copy, Debug)]
struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    // 状态（两通道共享一组，因为人声是单声道）
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
    freq: f32,
}

impl Biquad {
    fn notch(freq: f32, sr: f32, q: f32) -> Self {
        let w0 = 2.0 * PI * freq / sr;
        let cos_w0 = w0.cos();
        let alpha = w0.sin() / (2.0 * q);
        let a0 = 1.0 + alpha;
        Self {
            b0: 1.0 / a0,
            b1: -2.0 * cos_w0 / a0,
            b2: 1.0 / a0,
            a1: -2.0 * cos_w0 / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
            freq,
        }
    }

    #[inline]
    fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }
}

/// 一个陷波槽位
struct Notch {
    filter: Biquad,
    bin: usize,
    hit_frames: u32,
    miss_frames: u32,
    active: bool,
    /// 最近命中时的细化 bin 位置（含小数），用于检查频点稳定性
    recent_bins: Vec<f32>,
}

pub struct HowlSuppressor {
    sr: f32,
    nbin: usize,
    bin_hz: f32,
    notches: Vec<Notch>,
    /// 最近确认的啸叫频点（用于 UI 显示/日志）
    pub detected_hz: Vec<f32>,
    /// 统计：累计检测到的啸叫次数
    pub howl_events: u64,
    enabled: bool,
}

impl HowlSuppressor {
    /// `nbin` 是频谱 bin 数（如 FFT 1024 → 513），`sr` 采样率
    pub fn new(nbin: usize, sr: f32) -> Self {
        let bin_hz = sr / ((nbin - 1) as f32 * 2.0);
        Self {
            sr,
            nbin,
            bin_hz,
            notches: Vec::with_capacity(MAX_NOTCHES),
            detected_hz: Vec::new(),
            howl_events: 0,
            enabled: true,
        }
    }

    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
        if !on {
            self.notches.clear();
        }
    }

    /// 检测啸叫候选频点。`mag` 是幅度谱（长度 nbin）
    ///
    /// 返回本帧确认的啸叫 bin 列表（空 = 无啸叫）
    pub fn detect(&mut self, mag: &[f32]) -> Vec<usize> {
        if !self.enabled || mag.len() != self.nbin || self.nbin < 2 * VALLEY_SEARCH + 3 {
            return Vec::new();
        }

        // 只看 150 Hz 以上（低频有 DC 和工频干扰，不判啸叫）
        let start = ((150.0 / self.bin_hz) as usize).max(VALLEY_SEARCH + 2);
        let end = self.nbin.min(((min_hz(self.sr) / self.bin_hz) as usize));

        // 检测思路修正（实测得出）：
        //   用"邻域均值"会被频谱泄漏污染 —— 单频能量扩散到相邻 bin，
        //   自己把自己抬高，PNR 只有 3-6 dB，检测不出来。
        //   正确做法：找局部极大值，然后和"最近的谷底"比。
        //   实测真实啸叫在 1207 Hz 的峰/谷比是 +32 dB，区分度极高。
        let mut hits: Vec<(usize, f32)> = Vec::new();
        for i in start..end {
            // 必须是局部极大（左右都比自己小）
            if i == 0 || i + 1 >= self.nbin {
                continue;
            }
            if mag[i] <= mag[i - 1] || mag[i] <= mag[i + 1] {
                continue;
            }
            // 找左右 ±VALLEY_SEARCH 范围内的最低点（谷底）
            let mut valley = mag[i];
            for k in 1..=VALLEY_SEARCH {
                if i >= k {
                    valley = valley.min(mag[i - k]);
                }
                if i + k < self.nbin {
                    valley = valley.min(mag[i + k]);
                }
            }
            if valley <= 1e-12 {
                continue;
            }
            let pnr_db = 20.0 * (mag[i] / valley).log10();
            if pnr_db > PNR_THRESHOLD_DB {
                // 抛物线插值：用邻 bin 的值估算真实峰值位置，
                // 否则 FFT 分辨率（46.9 Hz/bin）会让陷波打偏，Q=30 时带宽只有 40 Hz
                let a = mag[i - 1].max(1e-12).ln();
                let b = mag[i].max(1e-12).ln();
                let c = mag[i + 1].max(1e-12).ln();
                let denom = a - 2.0 * b + c;
                let delta = if denom.abs() > 1e-9 {
                    (0.5 * (a - c) / denom).clamp(-0.5, 0.5)
                } else {
                    0.0
                };
                hits.push((i, delta));
            }
        }

        // 确认：与已有槽位匹配或新建
        for &(bin, delta) in &hits {
            let mut matched = false;
            for n in self.notches.iter_mut() {
                // 允许 ±3 bin 的漂移（啸叫频点会缓慢移动）
                if (n.bin as i32 - bin as i32).abs() <= 3 {
                    n.hit_frames += 1;
                    n.miss_frames = 0;
                    matched = true;
                    n.recent_bins.push(bin as f32 + delta);
                    if n.recent_bins.len() > 8 {
                        n.recent_bins.remove(0);
                    }
                    // 稳定性检查：最近 8 次命中的频点标准差 < 3 Hz 才算真啸叫
                    // 人声谐波会随音高漂移，标准差通常 > 10 Hz
                    let stable = if n.recent_bins.len() >= 4 {
                        let m: f32 = n.recent_bins.iter().sum::<f32>() / n.recent_bins.len() as f32;
                        let var: f32 = n.recent_bins.iter().map(|v| (v - m) * (v - m)).sum::<f32>()
                            / n.recent_bins.len() as f32;
                        var.sqrt() * self.bin_hz < 3.0
                    } else {
                        false
                    };
                    if !n.active && n.hit_frames >= CONFIRM_FRAMES && stable {
                        n.active = true;
                        self.howl_events += 1;
                    }
                    break;
                }
            }
            if !matched && self.notches.len() < MAX_NOTCHES {
                // 用插值后的精确频点
                let freq = (bin as f32 + delta) * self.bin_hz;
                self.notches.push(Notch {
                    filter: Biquad::notch(freq, self.sr, NOTCH_Q),
                    bin,
                    hit_frames: 1,
                    miss_frames: 0,
                    active: false,
                    recent_bins: vec![bin as f32 + delta],
                });
            }
        }

        // 未命中的槽位累计 miss
        for n in self.notches.iter_mut() {
            if !hits.iter().any(|&(b, _)| (b as i32 - n.bin as i32).abs() <= 3) {
                n.miss_frames += 1;
                if n.miss_frames > RELEASE_FRAMES {
                    n.hit_frames = 0;
                    n.active = false;
                }
            }
        }

        // 清理长期失效且已释放的槽位
        self.notches.retain(|n| n.active || n.hit_frames > 0);

        // 更新对外可见的列表
        self.detected_hz = self
            .notches
            .iter()
            .filter(|n| n.active)
            .map(|n| n.filter.freq)
            .collect();

        self.notches
            .iter()
            .filter(|n| n.active)
            .map(|n| n.bin)
            .collect()
    }

    /// 对时域样本应用所有生效的陷波
    pub fn apply(&mut self, samples: &mut [f32]) {
        if !self.enabled {
            return;
        }
        for n in self.notches.iter_mut() {
            if !n.active {
                continue;
            }
            for s in samples.iter_mut() {
                *s = n.filter.process(*s);
            }
        }
    }

    pub fn active_count(&self) -> usize {
        self.notches.iter().filter(|n| n.active).count()
    }
}

fn min_hz(sr: f32) -> f32 {
    // 上限取 Nyquist 的 90%，避免边界效应
    sr * 0.45
}
