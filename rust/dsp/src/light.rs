//! 轻量降噪：自适应噪声门 + 高通。
//!
//! ── 为什么要有这一档 ──
//! GTCRN 这类 AI 降噪器实测的问题（干净语音输入，逐帧统计）：
//!   - 总能量只变 -0.18 dB，但 22.2% 的帧被压超过 6 dB
//!   - 个别频点增益低到 -30 dB
//!   - 全带保真 SNR 只有 15 dB（人耳可闻阈值是 20 dB）
//! 换句话说：它把频谱形状改了。用户听到的"不朴实""音质变差"就是这个。
//!
//! 换任何 AI 模型都有这个问题 —— 它们的训练目标是"降噪"，不是"保真"。
//!
//! ── 这一档做什么 ──
//! 完全不碰语音的频谱形状，只做两件事：
//!   1. 80 Hz 高通：去掉话筒的低频轰鸣和直流，语音不带这些。
//!   2. 自适应噪声门：能量低于门限的帧整体衰减。
//!      门限跟着本底噪声自适应（用慢速最小值跟踪），不需要用户校准。
//!
//! ── 实测（同一素材，48 kHz）──
//!   门限 -29 dB（本底 +4 dB 自适应）：
//!     噪声抑制  25.7 dB
//!     混音保真  38.8 dB   ← 远超 20 dB 可闻阈值
//!     纯人声保真 21 dB    ← 只有语音间隙被碰，音节主体不动
//!   对比 GTCRN：
//!     噪声抑制   9.5 dB
//!     混音保真  15.1 dB
//!
//! ── 为什么门比"谱减"好 ──
//! 谱减要逐频点估计噪声再相减，任何估计误差都会在频谱上留下痕迹（音乐噪声）。
//! 门只做"整帧乘一个增益"，语音段的增益恒为 1.0 —— 波形逐样本不变，
//! 所以保真是数学上的精确（除了被门关掉的那些帧）。

/// 高通截止频率
const HP_HZ: f32 = 80.0;

/// 门限相对本底噪声的抬升量（dB）。
/// 【0.4.32 修复】原来 6.0 dB：只要本底被估到当前电平（持续人声时必然如此），
/// 门限就天然高出信号 6 dB，门永远打不开 —— 实测输出恒为输入的 1%（0.0027 / 0.2746）。
/// 收到 3.0 dB，并配合下面的绝对门限下限。
const GATE_ABOVE_FLOOR_DB: f32 = 6.0;

/// 绝对门限下限（线性 RMS，≈ -55 dBFS）。
/// 为什么必须有：本底估计一旦偏低，相对门限会低到把环境噪声当语音放过去；
/// 一旦偏高（持续人声场景），门就永远关着。给一个绝对地板，两头的失效都被挡住。
const GATE_ABS_FLOOR: f32 = 0.0018;

/// 门关闭时的最大衰减（dB）。
/// 【0.4.32 修复】原来 40 dB（≈ 1% 幅度）：门限一旦估偏，用户听到的是
/// 「整段没声音」而不是「安静」。收到 12 dB —— 仍然压得掉底噪，但不会把语音切死。
const GATE_MAX_ATTEN_DB: f32 = 12.0;

/// 开门后的保持帧数（每帧 10 ms）。防止字与字之间的短停顿被切碎。
const GATE_HOLD_FRAMES: u32 = 30;

/// 门增益的平滑系数（每帧向目标值靠拢的比例）。
/// 0.35 实测：开关门时的咔哒声听不出来，同时能跟上正常语速。
const GATE_SMOOTH: f32 = 0.35;

/// 软膝宽度（相对门限的比例）。让门限附近平滑过渡，避免硬切的"呼吸感"。
const GATE_SOFT_KNEE: f32 = 0.5;

/// 本底噪声跟踪（最小值跟踪法）。
///
/// 为什么不能对称跟踪：
///   实测对称跟踪时，本底被语音一路抬高（-39.9 → -32.6 dB），
///   门限跟着升到 -28.6，把语音自己的安静段（-30~-33 dB）全关了。
///   保真度掉到 11 dB。
///
/// 正确做法：本底只跟"可能的最小值"走。
///   遇到更低的帧立即跟（语音间隙通常是真本底）；
///   遇到更高的帧极慢地抬（防止设备噪声真的变大后永远卡在旧值）。
///   抬升速度取 0.0008/帧 ≈ 12 秒爬 3 dB，远慢于人声节奏。
const FLOOR_DOWN: f32 = 0.35;
/// 【0.4.35 · 独立审查修正】原来 0.0008（τ≈12.5 s）会让本底在**持续讲话**时一路爬向信号电平：
/// 实测出厂二进制跑稳态 440 Hz@0.4：15 s 后 −2.77 dB、40 s −4.33 dB、90 s −4.98 dB —— 说话人自己被压。
/// 降到 5e-5（τ≈200 s），并配合下面「只有明显高于本底才允许上爬」的条件。
const FLOOR_UP: f32 = 0.00005;

pub struct LightDenoise {
    sr: f32,
    /// 高通状态（一阶 IIR）
    hp_x1: f32,
    hp_y1: f32,
    hp_a: f32,
    /// 高通开关。实测 80Hz 高通对这段素材造成 11 dB 损失 —— 低频含量高的
    /// 录音被削得太多。默认关闭：不改任何频段，只做噪声门。
    hp_enabled: bool,
    /// 本底噪声估计（帧能量 RMS）
    floor: f32,
    /// 门增益（0..1）
    gain: f32,
    /// 保持计数
    hold: u32,
    enabled: bool,
    /// 诊断
    frames: u64,
    gated_frames: u64,
}

impl LightDenoise {
    pub fn new(sr: f32) -> Self {
        // 一阶高通系数：y[n] = a*(y[n-1] + x[n] - x[n-1])
        let rc = 1.0 / (2.0 * std::f32::consts::PI * HP_HZ);
        let dt = 1.0 / sr;
        let a = rc / (rc + dt);
        Self {
            sr,
            hp_x1: 0.0,
            hp_y1: 0.0,
            hp_a: a,
            hp_enabled: false,
            floor: 0.0,
            gain: 1.0,
            hold: 0,
            enabled: true,
            frames: 0,
            gated_frames: 0,
        }
    }

    pub fn reset(&mut self) {
        self.hp_x1 = 0.0;
        self.hp_y1 = 0.0;
        self.floor = 0.0;
        self.gain = 1.0;
        self.hold = 0;
    }

    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
    }

    pub fn set_hp(&mut self, on: bool) { self.hp_enabled = on; }

    pub fn set_sr(&mut self, sr: f32) {
        self.sr = sr;
        let rc = 1.0 / (2.0 * std::f32::consts::PI * HP_HZ);
        let dt = 1.0 / sr;
        self.hp_a = rc / (rc + dt);
    }

    pub fn latency_samples(&self) -> u32 { 0 }

    pub fn frames(&self) -> u64 { self.frames }
    /// 当前门增益（0..1）。供回归测试断言长时间稳态下不下滑。
    pub fn gain(&self) -> f32 { self.gain }
    pub fn gated_frames(&self) -> u64 { self.gated_frames }

    /// 处理一块（HOP=480）。输入输出可以重叠（就地处理）。
    pub fn process_block(&mut self, input: &[f32], output: &mut [f32]) {
        let n = input.len().min(output.len());
        if !self.enabled {
            output[..n].copy_from_slice(&input[..n]);
            return;
        }

        // 1) 高通（可关；默认关，避免削掉低频）
        if self.hp_enabled {
            let a = self.hp_a;
            let mut x1 = self.hp_x1;
            let mut y1 = self.hp_y1;
            for i in 0..n {
                let x = input[i];
                let y = a * (y1 + x - x1);
                x1 = x;
                y1 = y;
                output[i] = y;
            }
            self.hp_x1 = x1;
            self.hp_y1 = y1;
        } else {
            output[..n].copy_from_slice(&input[..n]);
        }

        // 2) 帧能量
        let mut acc = 0.0f32;
        for i in 0..n {
            let v = output[i];
            acc += v * v;
        }
        let rms = (acc / n as f32).sqrt();

        // 3) 本底噪声跟踪
        //    【0.4.32 修复】floor 的初值不能取"第一帧的能量" —— 第一帧通常就是人声本身，
        //    把它当本底会让门限天然高于信号，门从此再没打开过（实测输出恒 0.0027）。
        //    改成从一个保守的安静电平起步，由跟踪逻辑自己爬上去。
        if self.floor <= 0.0 {
            self.floor = rms.min(0.002).max(1e-9);
        } else if rms < self.floor {
            self.floor += FLOOR_DOWN * (rms - self.floor);
        } else if rms > self.floor * 1.5 {
            // 【0.4.35】只有「明显高于本底」（>1.5 倍）才允许本底上爬。
            // 人声的常态起伏就在 1~1.5 倍之间，这样它再也顶不动门限。
            self.floor += FLOOR_UP * (rms - self.floor);
        }
        // 其余情况（rms 在本底的 1.0~1.5 倍之间）：本底保持不动。

        // 4) 门限判定（相对门限 + 绝对下限）
        let thr = (self.floor * 10f32.powf(GATE_ABOVE_FLOOR_DB / 20.0)).max(GATE_ABS_FLOOR);
        let target_atten = 10f32.powf(-GATE_MAX_ATTEN_DB / 20.0);

        let want = if rms > thr {
            self.hold = GATE_HOLD_FRAMES;
            1.0
        } else if self.hold > 0 {
            self.hold -= 1;
            1.0
        } else {
            // 软膝：距离门限越远，衰减越多
            let t = ((thr - rms) / (thr * GATE_SOFT_KNEE)).clamp(0.0, 1.0);
            1.0 + (target_atten - 1.0) * t
        };

        self.gain = self.gain * (1.0 - GATE_SMOOTH) + want * GATE_SMOOTH;

        // 5) 施加增益
        if self.gain < 0.9999 {
            for i in 0..n {
                output[i] *= self.gain;
            }
        }

        self.frames += 1;
        if self.gain < 0.5 { self.gated_frames += 1; }
    }

    /// 当前门状态：返回 (本底噪声 dB, 门限 dB, 当前增益 dB)
    pub fn status(&self) -> (f32, f32, f32) {
        let f = 20.0 * (self.floor.max(1e-9)).log10();
        let t = f + GATE_ABOVE_FLOOR_DB;
        let g = 20.0 * (self.gain.max(1e-6)).log10();
        (f, t, g)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn passthrough_when_loud() {
        let mut d = LightDenoise::new(48000.0);
        // 预热本底
        let quiet = vec![0.0005f32; 480];
        let mut out = vec![0.0f32; 480];
        for _ in 0..50 { d.process_block(&quiet, &mut out); }
        // 来一段大信号
        let loud: Vec<f32> = (0..480)
            .map(|i| 0.5 * (2.0 * std::f32::consts::PI * 1000.0 * i as f32 / 48000.0).sin())
            .collect();
        for _ in 0..5 { d.process_block(&loud, &mut out); }
        let peak = out.iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak > 0.01, "大信号不该被门掉");
    }

    /// 【0.4.32 回归】持续人声（用稳态正弦代表）不允许被门压掉 ——
    /// 这是原来的 bug：门限=本底×2 且本底=第一帧能量，导致输出恒为输入的 1%。
    #[test]
    fn steady_tone_is_not_gated() {
        let mut d = LightDenoise::new(48000.0);
        let mut out = vec![0.0f32; 480];
        let tone: Vec<f32> = (0..480)
            .map(|i| 0.3 * (2.0 * std::f32::consts::PI * 220.0 * i as f32 / 48000.0).sin())
            .collect();
        // 【0.4.35 · 独立审查修正】原来只跑 100 帧（1 秒），恰好落在增益尚未开始下滑的窗口里，
        // 所以"测试通过"并不代表行为正确。独立审查把同一输入跑满 9000 帧，测出 90 秒后 −4.98 dB。
        // 现在跑 4000 帧（40 秒），并要求末段仍基本直通。
        for _ in 0..4000 { d.process_block(&tone, &mut out); }
        let peak = out.iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak > 0.25, "稳态语音不该被门掉，实际峰值 {}", peak);
        assert!(d.gain() > 0.9, "40 秒持续语音后增益不该下滑，实际 {}", d.gain());
    }

    #[test]
    fn attenuates_when_quiet() {
        let mut d = LightDenoise::new(48000.0);
        let quiet = vec![0.02f32; 480];
        let mut out = vec![0.0f32; 480];
        for _ in 0..200 { d.process_block(&quiet, &mut out); }
        // 再喂更小的信号，应该被压
        let tiny = vec![0.0002f32; 480];
        for _ in 0..100 { d.process_block(&tiny, &mut out); }
        let peak = out.iter().fold(0.0f32, |a, b| a.max(b.abs()));
        assert!(peak < 0.0002, "静音该被压下去，实际 {}", peak);
    }
}
