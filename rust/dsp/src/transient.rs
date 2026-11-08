//! 瞬态抑制（键盘声）—— 比 TS3 的 WebRTC TransientSuppressor 更保守
//!
//! TS3 用的是 WebRTC APM 的 `TransientSuppressor`，原理是"对数域谱减 + 音高保护"。
//! 它的做法是**削弱**瞬态帧，但会连带损伤人声起始。
//!
//! 我们的改进（核心差异）：
//!   **不做谱减，只做"帧级门控 + 短时保持"**
//!
//!   1. 检测瞬态：谱通量突增 + 谱平坦度高 + 谐波性低
//!   2. 判定：三者同时满足才判为键盘声
//!   3. 抑制：对瞬态帧做**整帧衰减**（-12 dB），而不是动频谱
//!      → 频谱结构不变，没有 musical noise
//!   4. 保护：如果该帧被 VAD 判为语音起始，则不抑制（防止吃掉第一个字）
//!
//! 为什么不用谱减：
//!   谱减会在瞬态帧制造"空洞"，听感是"哒"变成"噗"。整帧衰减只是把那一帧变轻，
//!   听感是"哒"变小声，更自然。

/// 瞬态检测参数
#[derive(Clone, Debug)]
pub struct TransientConfig {
    /// 谱通量突增阈值（dB）
    pub flux_threshold_db: f32,
    /// 谱平坦度阈值（0-1，越高越像噪声）
    pub flatness_threshold: f32,
    /// 谐波性阈值（0-1，越低越像噪声）
    pub harmonicity_threshold: f32,
    /// 抑制深度（dB）
    pub attenuation_db: f32,
    /// 衰减保持帧数（避免"哒"被切成两半）
    pub hold_frames: u32,
    /// 估算谱通量用的历史帧数
    pub history: usize,
}

impl Default for TransientConfig {
    fn default() -> Self {
        Self {
            flux_threshold_db: 12.0,
            flatness_threshold: 0.45,
            harmonicity_threshold: 0.30,
            attenuation_db: -12.0,
            hold_frames: 2,
            history: 8,
        }
    }
}

pub struct TransientSuppressor {
    cfg: TransientConfig,
    /// 历史谱通量
    flux_hist: Vec<f32>,
    /// 前一帧的幅度谱
    prev_mag: Vec<f32>,
    /// 衰减保持计数
    hold: u32,
    /// 统计
    pub suppressed_frames: u64,
    pub total_frames: u64,
    pub enabled: bool,
}

impl TransientSuppressor {
    pub fn new(nbin: usize, cfg: TransientConfig) -> Self {
        Self {
            cfg,
            flux_hist: Vec::with_capacity(16),
            prev_mag: vec![0.0; nbin],
            hold: 0,
            suppressed_frames: 0,
            total_frames: 0,
            enabled: true,
        }
    }

    /// 谱平坦度：几何均值 / 算术均值。接近 1 = 白噪，接近 0 = 有强谐波
    pub fn spectral_flatness_pub(mag: &[f32]) -> f32 {
        Self::spectral_flatness(mag)
    }

    fn spectral_flatness(mag: &[f32]) -> f32 {
        let mut log_sum = 0.0f64;
        let mut lin_sum = 0.0f64;
        let mut n = 0;
        for &m in mag {
            let v = m as f64 + 1e-12;
            log_sum += v.ln();
            lin_sum += v;
            n += 1;
        }
        if n == 0 || lin_sum <= 0.0 {
            return 0.0;
        }
        let geo = (log_sum / n as f64).exp();
        let arith = lin_sum / n as f64;
        (geo / arith) as f32
    }

    /// 谐波性：自相关在基频周期处的峰值。
    /// 简化实现：对幅度谱做倒谱近似 —— 取谱的峰值间隔规律性
    fn harmonicity(mag: &[f32], bin_hz: f32) -> f32 {
        // 找 80-400 Hz 范围内的谱能量峰值
        let lo = (80.0 / bin_hz) as usize;
        let hi = ((400.0 / bin_hz) as usize).min(mag.len());
        if hi <= lo + 2 {
            return 0.0;
        }
        let mut peak = 0.0f32;
        let mut mean = 0.0f32;
        for i in lo..hi {
            peak = peak.max(mag[i]);
            mean += mag[i];
        }
        mean /= (hi - lo) as f32;
        if mean <= 1e-12 {
            return 0.0;
        }
        // 峰值/均值比越高，谐波结构越明显
        ((peak / mean - 1.0) / 8.0).clamp(0.0, 1.0)
    }

    /// 每帧调用。`mag` 是幅度谱，`vad_speech` 是语音门/VAD 的判定。
    ///
    /// 返回本帧应施加的线性增益（1.0 = 不处理）
    pub fn process(&mut self, mag: &[f32], vad_speech: bool, bin_hz: f32) -> f32 {
        self.total_frames += 1;
        if !self.enabled || mag.len() != self.prev_mag.len() || mag.is_empty() {
            return 1.0;
        }

        // 1) 谱通量：本帧与上帧的正向差异总和
        let mut flux = 0.0f32;
        for i in 0..mag.len() {
            let d = mag[i] - self.prev_mag[i];
            if d > 0.0 {
                flux += d;
            }
        }
        self.prev_mag.copy_from_slice(mag);

        // 基线：历史中位数
        self.flux_hist.push(flux);
        if self.flux_hist.len() > self.cfg.history {
            self.flux_hist.remove(0);
        }
        let mut sorted = self.flux_hist.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let baseline = sorted[sorted.len() / 2].max(1e-9);
        let flux_db = 20.0 * (flux / baseline).log10();

        // 2) 谱平坦度 & 谐波性
        let flatness = Self::spectral_flatness(mag);
        let harm = Self::harmonicity(mag, bin_hz);

        // 3) 三条件同时满足 → 瞬态噪声
        let is_transient = flux_db > self.cfg.flux_threshold_db
            && flatness > self.cfg.flatness_threshold
            && harm < self.cfg.harmonicity_threshold;

        // 4) 保护：语音起始帧不抑制（防止吃掉第一个字）
        let protect = vad_speech && harm > self.cfg.harmonicity_threshold * 0.8;

        if is_transient && !protect {
            self.hold = self.cfg.hold_frames;
            self.suppressed_frames += 1;
        }

        // 5) 输出增益（带保持，避免"哒"被切成两半）
        if self.hold > 0 {
            self.hold -= 1;
            10f32.powf(self.cfg.attenuation_db / 20.0)
        } else {
            1.0
        }
    }

    pub fn reset(&mut self) {
        self.flux_hist.clear();
        self.prev_mag.iter_mut().for_each(|v| *v = 0.0);
        self.hold = 0;
    }
}
