//! 温和谱减 + 高通链（纯 DSP，无模型）
//!
//! 定位：低占用档的替代/升级。RNNoise 实测降噪 8.95 dB、RTF 0.0043，
//! 但它是 16 kHz 单帧 10 ms 的 GRU，高频完全不管（16k 上限 8 kHz），
//! 而且换歌/换环境时需要重新收敛。这条链是纯算术，零模型、零收敛期、
//! 48 kHz 全带，代价只有一次 1024 点 FFT。
//!
//! 三段结构（顺序即信号流）：
//!   1. 高通：80 Hz 二阶 Butterworth（RBJ），切掉直流、桌面震动、空调低频
//!   2. 谱减：最小值统计估噪声 + 判决引导先验 SNR + Wiener 增益
//!   3. 语音保护：300 Hz~4 kHz 的衰减封顶（与人声基频/共振峰对应）
//!
//! 为什么用「判决引导 + Wiener」而不是教科书谱减（|X|²-α|N|² 再开方）：
//!   教科书谱减在每帧独立判断，噪声残留会随机出现在不同频点，
//!   ISTFT 后就是「音乐噪声」（musical noise）—— 听感是水泡声。
//!   判决引导（Ephraim-Malah 1984）把上一帧的增益纳入本次估计：
//!     ξ = γ_dd·(G_prev²·P_prev)/N̂ + (1-γ_dd)·max(P/N̂ - 1, 0)
//!   相邻帧的增益因此连续，水泡声基本消失。这是 WebRTC APM 的 NS 也在用的思路。
//!
//! 为什么噪声估计用最小值统计而不是 VAD：
//!   VAD 在连续噪声里会误判成语音，噪声估计被抬高 → 降噪失效；
//!   在持续说话时又会判成语音，噪声估计冻结 → 突然安静时降噪过猛。
//!   最小值统计（Martin 1994）只假设「任意 1 秒窗口内噪声功率取到最小值」，
//!   与有没有语音无关，跟踪慢但永不失效，正是通话场景需要的。
//!
//! 参数依据（全部在 work/pf 下的实测扫描里定，见 docs/谱减高通链-实测.md）：
//!   alpha  过减系数：1.0 = 无偏；越大越干净但开始吃气声
//!   beta   谱底：0.03~0.1，防止增益归零产生「空洞」
//!   n_bias 最小值统计的偏差补偿（平滑周期图的最小值系统性低于真值）
//!   hp     高通截止：80 Hz 对人声（男声基频 85 Hz 起）无感

use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::f32::consts::PI;
use std::sync::Arc;

pub const NFFT: usize = 1024;
pub const HOP: usize = 480;
pub const NBIN: usize = NFFT / 2 + 1;

#[derive(Clone, Debug)]
pub struct SpecSubConfig {
    /// 过减系数 α：噪声谱估计乘以它再减
    pub alpha: f32,
    /// 谱底 β（线性增益下限，0.03 ≈ -30 dB）
    pub beta: f32,
    /// 判决引导平滑系数（0.9~0.98；越高越连续，响应越慢）
    pub dd: f32,
    /// 功率谱平滑系数（最小值统计的输入）
    pub n_smooth: f32,
    /// 最小值统计偏差补偿
    pub n_bias: f32,
    /// 最小值统计窗长（帧，10 ms/帧；64 ≈ 0.64 s）
    pub min_window: usize,
    /// 绝对增益下限（dB）
    pub gain_floor_db: f32,
    /// 语音保护带内允许的最大衰减（dB）
    pub max_att_db: f32,
    /// 语音保护是否由 VAD 调度。
    /// 关闭时保护带**常开**——静音段也被护住，噪声压不下去（实测输出 SNR 卡在 20 dB）；
    /// 开启时只在判为语音的帧启用保护，静音帧放开衰减。
    pub protect_on_speech: bool,
    /// VAD 判决用的 SNR 门限（dB，全帧后验 SNR）
    pub vad_db: f32,
    /// VAD 保持帧数（语音结束后继续保护的帧数，防吃尾音）
    pub vad_hold: u32,
    /// 非语音帧的过减系数（比 alpha 更狠）。
    /// 为什么分两档：语音段要「不改人声」，静音段要「压到底」——
    /// 一个系数同时满足两件事是不可能的。RNNoise 输出 SNR 41.9 dB 就是靠
    /// 语音门控把静音段压到 -40 dB 以下，代价是 8 kHz 以上全损。
    pub alpha_silence: f32,
    /// 非语音帧的增益下限（dB）
    pub floor_silence_db: f32,
    /// 非语音帧是否清掉判决引导（DD）的历史。
    /// DD 递归会把语音帧的高增益记 3~5 帧，语音一停静音段仍被顶在高增益上，
    /// 实测这是输出 SNR 卡在 22 dB 的真正原因（改 alpha/floor 都不动）。
    pub dd_reset_on_silence: bool,
    /// 语音保护带下界（Hz）
    pub protect_lo_hz: f32,
    /// 语音保护带上界（Hz）
    pub protect_hi_hz: f32,
    /// 高通截止（Hz，0 = 关闭）
    pub hp_hz: f32,
}

impl Default for SpecSubConfig {
    fn default() -> Self {
        Self {
            alpha: 1.6,
            beta: 0.06,
            dd: 0.96,
            n_smooth: 0.85,
            n_bias: 1.5,
            min_window: 64,
            gain_floor_db: -30.0,
            max_att_db: 12.0,
            protect_on_speech: true,
            vad_db: 3.0,
            vad_hold: 12,
            alpha_silence: 6.0,
            floor_silence_db: -45.0,
            dd_reset_on_silence: true,
            protect_lo_hz: 300.0,
            protect_hi_hz: 4000.0,
            hp_hz: 80.0,
        }
    }
}

/// 二阶 Butterworth 高通（RBJ cookbook），单通道
#[derive(Clone, Copy, Debug)]
pub struct BiquadHp {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    x1: f32,
    x2: f32,
    y1: f32,
    y2: f32,
}

impl BiquadHp {
    pub fn new(freq: f32, sr: f32) -> Self {
        if freq <= 0.0 {
            return Self { b0: 1.0, b1: 0.0, b2: 0.0, a1: 0.0, a2: 0.0, x1: 0.0, x2: 0.0, y1: 0.0, y2: 0.0 };
        }
        let w0 = 2.0 * PI * freq / sr;
        let cos_w0 = w0.cos();
        let alpha = w0.sin() / (2.0 * 0.70710678); // Q = 1/√2
        let a0 = 1.0 + alpha;
        Self {
            b0: (1.0 + cos_w0) / 2.0 / a0,
            b1: -(1.0 + cos_w0) / a0,
            b2: (1.0 + cos_w0) / 2.0 / a0,
            a1: -2.0 * cos_w0 / a0,
            a2: (1.0 - alpha) / a0,
            x1: 0.0,
            x2: 0.0,
            y1: 0.0,
            y2: 0.0,
        }
    }

    #[inline]
    pub fn process(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.b1 * self.x1 + self.b2 * self.x2
            - self.a1 * self.y1
            - self.a2 * self.y2;
        self.x2 = self.x1;
        self.x1 = x;
        self.y2 = self.y1;
        self.y1 = y;
        y
    }

    pub fn reset(&mut self) {
        self.x1 = 0.0;
        self.x2 = 0.0;
        self.y1 = 0.0;
        self.y2 = 0.0;
    }
}

pub struct SpectralSubtractor {
    cfg: SpecSubConfig,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    win: [f32; NFFT],
    ana_mem: [f32; NFFT - HOP],
    ola_buf: [f32; NFFT],
    norm_buf: [f32; NFFT],

    fft_in: Vec<f32>,
    fft_out: Vec<realfft::num_complex::Complex32>,
    ifft_in: Vec<realfft::num_complex::Complex32>,
    ifft_out: Vec<f32>,

    /// 平滑后的功率谱（最小值统计的输入）
    ps: Vec<f32>,
    /// 环形历史（min_window × NBIN）
    hist: Vec<f32>,
    hidx: usize,
    hist_fill: usize,
    /// 上一帧的输入功率与增益（判决引导）
    prev_p: Vec<f32>,
    prev_g: Vec<f32>,

    lo_bin: usize,
    hi_bin: usize,
    hp: BiquadHp,
    /// VAD 保持计数器
    hold: u32,

    pub frames: u64,
    pub enabled: bool,
}

impl SpectralSubtractor {
    pub fn new(cfg: SpecSubConfig) -> Self {
        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(NFFT);
        let inv = planner.plan_fft_inverse(NFFT);
        let mut win = [0.0f32; NFFT];
        for (i, w) in win.iter_mut().enumerate() {
            *w = 0.5 - 0.5 * (2.0 * PI * i as f32 / NFFT as f32).cos();
        }
        let fft_in = fwd.make_input_vec();
        let fft_out = fwd.make_output_vec();
        let ifft_in = inv.make_input_vec();
        let ifft_out = inv.make_output_vec();
        let w = cfg.min_window.max(4);
        let bin_hz = 48_000.0 / NFFT as f32;
        let lo_bin = ((cfg.protect_lo_hz / bin_hz) as usize).max(1);
        let hi_bin = ((cfg.protect_hi_hz / bin_hz) as usize).min(NBIN - 1);
        let hp = BiquadHp::new(cfg.hp_hz, 48_000.0);
        Self {
            cfg,
            fwd,
            inv,
            win,
            ana_mem: [0.0; NFFT - HOP],
            ola_buf: [0.0; NFFT],
            norm_buf: [0.0; NFFT],
            fft_in,
            fft_out,
            ifft_in,
            ifft_out,
            ps: vec![0.0; NBIN],
            hist: vec![0.0; w * NBIN],
            hidx: 0,
            hist_fill: 0,
            prev_p: vec![0.0; NBIN],
            prev_g: vec![1.0; NBIN],
            lo_bin,
            hi_bin,
            hp,
            hold: 0,
            frames: 0,
            enabled: true,
        }
    }

    pub fn config(&self) -> &SpecSubConfig {
        &self.cfg
    }

    pub fn set_config(&mut self, cfg: SpecSubConfig) {
        let bin_hz = 48_000.0 / NFFT as f32;
        self.lo_bin = ((cfg.protect_lo_hz / bin_hz) as usize).max(1);
        self.hi_bin = ((cfg.protect_hi_hz / bin_hz) as usize).min(NBIN - 1);
        self.hp = BiquadHp::new(cfg.hp_hz, 48_000.0);
        if cfg.min_window.max(4) != self.cfg.min_window.max(4) {
            self.hist = vec![0.0; cfg.min_window.max(4) * NBIN];
            self.hidx = 0;
            self.hist_fill = 0;
        }
        self.cfg = cfg;
    }

    /// 算法延迟（样本 @48k）。
    ///
    /// 实测（单脉冲法）：输入在第 5000 样本，输出峰值在第 5544 样本 → 544。
    /// 不是 NFFT/2=512，因为 centered STFT 把当前 480 样本放在窗口尾部，
    /// 输出块取的是窗口最前 HOP 个样本，对应 NFFT-HOP=544 之前的输入。
    /// 544 / 48 = 11.33 ms。
    pub fn latency_samples(&self) -> usize {
        NFFT - HOP
    }

    pub fn reset(&mut self) {
        self.ana_mem = [0.0; NFFT - HOP];
        self.ola_buf = [0.0; NFFT];
        self.norm_buf = [0.0; NFFT];
        self.ps.iter_mut().for_each(|x| *x = 0.0);
        self.hist.iter_mut().for_each(|x| *x = 0.0);
        self.hidx = 0;
        self.hist_fill = 0;
        self.prev_p.iter_mut().for_each(|x| *x = 0.0);
        self.prev_g.iter_mut().for_each(|x| *x = 1.0);
        self.hp.reset();
        self.hold = 0;
        self.frames = 0;
    }

    /// 处理一帧 480 samples @48k
    pub fn process_frame(&mut self, input: &[f32], output: &mut [f32]) {
        debug_assert_eq!(input.len(), HOP);
        debug_assert_eq!(output.len(), HOP);

        // ---- 1) STFT（centered，与 gtcrn48 完全同一套分析） ----
        self.fft_in[..NFFT - HOP].copy_from_slice(&self.ana_mem);
        self.fft_in[NFFT - HOP..].copy_from_slice(input);
        for i in 0..NFFT {
            self.fft_in[i] *= self.win[i];
        }
        // 历史缓冲必须从**未加窗**的输入更新。
        // 之前的写法 copy 自 fft_in[NFFT-keep..]（已乘窗），
        // 下一帧再乘一次窗 → 每帧多衰减一次，SNR 从 10 dB 掉到 4 dB。
        let keep = NFFT - HOP; // 544 > HOP(480)
        let mut newmem = [0.0f32; 544];
        newmem[..keep - HOP].copy_from_slice(&self.ana_mem[HOP..]);
        newmem[keep - HOP..].copy_from_slice(input);
        self.ana_mem = newmem;
        if self
            .fwd
            .process_with_scratch(&mut self.fft_in, &mut self.fft_out, &mut [])
            .is_err()
        {
            output.copy_from_slice(input);
            return;
        }

        // ---- 2) 逐 bin 估增益 ----
        let cfg = &self.cfg;
        let w_len = self.hist.len() / NBIN;
        let filled = self.hist_fill.max(1);
        let n_smooth = cfg.n_smooth;
        let dd = cfg.dd;
        let alpha = cfg.alpha;
        let beta = cfg.beta.clamp(0.0, 1.0);
        // 谱底 β 与绝对增益下限取更宽松的那个
        let floor_lin = 10f32.powf(cfg.gain_floor_db / 20.0).max(beta).min(1.0);
        // 语音保护带：衰减封顶 max_att_db
        let protect_lin = 10f32.powf(-cfg.max_att_db / 20.0).max(floor_lin).min(1.0);
        let eps = 1e-12f32;

        // 全帧后验 SNR，用于决定这一帧要不要启用语音保护。
        // 为什么按帧判：保护带的存在意义是"别改人声"，静音帧里没有人声，
        // 保护只会把噪声一起护住。实测常开保护时输出 SNR 卡在 20 dB。
        let (mut e_sig, mut e_all) = (0.0f32, 0.0f32);
        for i in 0..NBIN {
            let p = self.fft_out[i].re * self.fft_out[i].re
                + self.fft_out[i].im * self.fft_out[i].im;
            let off = self.hidx * NBIN + i;
            let mut mn = f32::MAX;
            for k in 0..filled {
                let idx = (self.hidx + w_len - k) % w_len;
                let v = self.hist[idx * NBIN + i];
                if v < mn { mn = v; }
            }
            if mn == f32::MAX { mn = 0.0; }
            e_all += p;
            e_sig += (p - mn.max(0.0)).max(0.0);
            let _ = off;
        }
        let frame_snr_db = 10.0 * ((e_sig + eps) / (e_all - e_sig).max(eps)).log10();
        if frame_snr_db > cfg.vad_db {
            self.hold = cfg.vad_hold;
        } else if self.hold > 0 {
            self.hold -= 1;
        }
        let in_speech = self.hold > 0;
        let protect_now = !cfg.protect_on_speech || in_speech;
        // 语音帧用 alpha / floor，非语音帧用更狠的一档
        let alpha_now = if in_speech { alpha } else { cfg.alpha_silence.max(alpha) };
        let floor_now_db = if in_speech { cfg.gain_floor_db } else { cfg.floor_silence_db.min(cfg.gain_floor_db) };
        let floor_now = 10f32.powf(floor_now_db / 20.0).max(beta).min(1.0);
        // 静音帧清掉 DD 记忆，否则语音尾音的高增益会被递归续命
        let dd_now = if !in_speech && cfg.dd_reset_on_silence { 0.0 } else { dd };

        for i in 0..NBIN {
            let re = self.fft_out[i].re;
            let im = self.fft_out[i].im;
            let p = re * re + im * im;

            // 平滑功率谱
            let ps = n_smooth * self.ps[i] + (1.0 - n_smooth) * p;
            self.ps[i] = ps;
            // 写入环形历史
            let off = self.hidx * NBIN + i;
            self.hist[off] = ps;

            // 滑窗最小值（马丁最小值统计）
            let mut mn = f32::MAX;
            for k in 0..filled {
                let idx = (self.hidx + w_len - k) % w_len;
                let v = self.hist[idx * NBIN + i];
                if v < mn {
                    mn = v;
                }
            }
            if mn == f32::MAX {
                mn = 0.0;
            }
            // 偏差补偿后的噪声功率，再过减
            let noise = (mn * cfg.n_bias).max(eps);
            let sub = (noise * alpha_now).max(eps);

            // 判决引导先验 SNR
            let post = p / sub;
            let prev = (self.prev_g[i] * self.prev_g[i] * self.prev_p[i]) / sub;
            let snr_pri = dd_now * prev + (1.0 - dd_now) * (post - 1.0).max(0.0);

            // Wiener 增益
            let mut g = if snr_pri > 0.0 {
                snr_pri / (1.0 + snr_pri)
            } else {
                0.0
            };
            // 语音保护带：只有判为语音的帧才把衰减封顶
            let fl = if protect_now && i >= self.lo_bin && i <= self.hi_bin {
                protect_lin
            } else {
                floor_now
            };
            if g < fl {
                g = fl;
            }
            if g > 1.0 {
                g = 1.0;
            }

            self.prev_p[i] = p;
            self.prev_g[i] = g;

            self.ifft_in[i] = realfft::num_complex::Complex32::new(re * g, im * g);
        }
        self.hidx = (self.hidx + 1) % w_len;
        if self.hist_fill < w_len {
            self.hist_fill += 1;
        }

        self.ifft_in[0].im = 0.0;
        self.ifft_in[NBIN - 1].im = 0.0;
        if self
            .inv
            .process_with_scratch(&mut self.ifft_in, &mut self.ifft_out, &mut [])
            .is_err()
        {
            output.copy_from_slice(input);
            return;
        }

        // ---- 3) 加窗 + OLA ----
        let scale = 1.0 / NFFT as f32;
        for i in 0..NFFT {
            let v = self.ifft_out[i] * self.win[i] * scale;
            self.ola_buf[i] += v;
            self.norm_buf[i] += self.win[i] * self.win[i];
        }
        for i in 0..HOP {
            output[i] = self.ola_buf[i] / self.norm_buf[i].max(1e-8);
        }
        let mut no = [0.0f32; NFFT];
        let mut nn = [0.0f32; NFFT];
        no[..NFFT - HOP].copy_from_slice(&self.ola_buf[HOP..]);
        nn[..NFFT - HOP].copy_from_slice(&self.norm_buf[HOP..]);
        self.ola_buf = no;
        self.norm_buf = nn;

        // ---- 4) 高通 + 软限幅 ----
        for v in output.iter_mut() {
            let y = self.hp.process(*v);
            let a = y.abs();
            *v = if a > 0.95 {
                y.signum() * (0.95 + (a - 0.95).tanh() * 0.05)
            } else {
                y
            };
        }
        self.frames += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hp_kills_dc() {
        let mut hp = BiquadHp::new(80.0, 48_000.0);
        let mut last = 0.0;
        for _ in 0..48000 {
            last = hp.process(1.0);
        }
        assert!(last.abs() < 1e-3, "直流残留 {last}");
    }

    #[test]
    fn passes_1k_tone() {
        let mut hp = BiquadHp::new(80.0, 48_000.0);
        let mut peak = 0.0f32;
        for i in 0..48000 {
            let x = (2.0 * PI * 1000.0 * i as f32 / 48000.0).sin();
            let y = hp.process(x);
            if i > 24000 && y.abs() > peak {
                peak = y.abs();
            }
        }
        assert!(peak > 0.98, "1 kHz 被衰减到 {peak}");
    }

    #[test]
    fn silence_in_silence_out() {
        let mut s = SpectralSubtractor::new(SpecSubConfig::default());
        let inp = [0.0f32; HOP];
        let mut out = [0.0f32; HOP];
        for _ in 0..20 {
            s.process_frame(&inp, &mut out);
        }
        assert!(out.iter().all(|v| v.is_finite() && v.abs() < 1e-6));
    }
}
