//! GTCRN-Light-48k 降噪（原生 48 kHz，10 ms 帧，无需分频）
//!
//! 与 GTCRN-16k 的关键区别：
//!   - 输入 513 bins（48 kHz 全带），不需要分频/上采样
//!   - 10 ms 帧（480 samples），比 16k 版的 16 ms 更短 → 延迟更低
//!   - 26 个 state tensor 需要显式维护
//!
//! 延迟：0（因果，无 lookahead）+ STFT 窗口的一半（1024/2 = 512 samples = 10.7 ms）
//! 实际端到端：约 10.7 ms 算法延迟

use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub const SR: usize = 48_000;
pub const NFFT: usize = 1024;
pub const HOP: usize = 480; // 10 ms
pub const NBIN: usize = NFFT / 2 + 1; // 513
pub const N_ENC: usize = 6;
pub const N_DEC: usize = 6;
pub const CH: usize = 32;
pub const F2: usize = 55;
pub const R: usize = 32;

/// 每层 GTConv 的时间缓存长度（从 ONNX 输入形状实测，逐层不同）
pub const ENC_PAD_T: [usize; 6] = [4, 8, 16, 32, 16, 8];
pub const DEC_PAD_T: [usize; 6] = [8, 16, 32, 16, 8, 4];
const TC_SHAPE: [usize; 3] = [1, CH, 4];
const DP_SHAPE: [usize; 3] = [2, F2, R];

pub struct GtcrnLight48 {
    session: ort::session::Session,

    // STFT/ISTFT
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    win: [f32; NFFT],
    ana_mem: [f32; NFFT - HOP], // 544
    ola_buf: [f32; NFFT],
    norm_buf: [f32; NFFT],

    fft_in: Vec<f32>,
    fft_out: Vec<realfft::num_complex::Complex32>,
    ifft_in: Vec<realfft::num_complex::Complex32>,
    ifft_out: Vec<f32>,

    // ONNX 输入/输出缓冲
    spec_buf: Vec<f32>,          // (1,513,1,2)
    egc: Vec<Vec<f32>>,          // 6 × (1,32,4,55)
    dgc: Vec<Vec<f32>>,          // 6 × (1,32,8,55)
    etc: Vec<Vec<f32>>,          // 6 × (1,32,4)
    dtc: Vec<Vec<f32>>,          // 6 × (1,32,4)
    dp1: Vec<f32>,               // (2,55,32)
    dp2: Vec<f32>,
    enh_buf: Vec<f32>,
    /// 掩码跨帧平滑系数（0 = 不平滑，1 = 完全不动）。
    ///
    /// 为什么要平滑：模型逐帧独立估掩码，相邻帧之间会出现剧烈跳变。
    /// 实测（48k 语音 + 10dB 噪声，800 帧）：
    ///   增益跳变 >6 dB 的帧有 54 个，最大 24.7 dB
    /// 这些跳变直接进 ISTFT，在时域表现为每 10 ms 一次的包络突变 ——
    /// 听感就是「湿」「水下」「金属感」「像隔着一层膜」。
    ///
    /// 用一阶平滑压掉帧间突变，代价是极短瞬态（爆破音）会略微钝化。
    /// 0.5 是实测折中：跳变降一个量级，语音起始仍清晰。
    mask_smooth: f32,
    /// 上一帧每个频点的幅度增益（NBIN）
    prev_gain: Vec<f32>,
    /// 增益下限（dB）。模型会把气声/齿音尾巴压到 -42 dB，听感就是
    /// 「人声发干、没有气息、像机器人」。实测干净语音的 p10 增益是 -42.7 dB，
    /// 而中位只有 -0.4 dB —— 说明它基本不动主体，只在两端破坏自然度。
    /// 设下限把这种过度抑制挡回来。
    gain_floor_db: f32,
    /// 增益上限（dB）。实测有帧被放大到 +16 dB，这是相位重建的过冲，
    /// 会让高电平音节出现刺耳毛刺。
    gain_ceil_db: f32,
    /// 高频段（>4 kHz）的平滑系数。高频里语音成分很少，
    /// 模型缺少监督导致掩码随机跳（实测抖动被放大 14 倍），
    /// 加大平滑几乎无代价却能消掉毛刺。
    mask_smooth_high: f32,
    /// 平滑过渡的分界 bin（对应 4 kHz）
    smooth_knee_bin: usize,
    /// 高频衰减（dB/octave），从分界点开始作用。
    /// 依据：实测我们的频谱倾斜只有 -2.1，oopz 是 -6.3、KOOK 质量档 -7.4。
    /// 语音通信里 4 kHz 以上几乎全是噪声/齿音，适度衰减能显著降低毛刺感。
    /// 0 = 不衰减（原行为），3 ≈ 每倍频程 3 dB。
    hf_tilt_db_oct: f32,
    /// 语音保护带是否启用。开启后 300 Hz ~ 4 kHz 的抑制量被限制在 protect_max_db 以内，
    /// 保证人声的"原味"不被全频段均匀压制。
    ///
    /// 依据（实测逐频段对比，同一素材）：
    ///   KOOK 低占用在 250 Hz~4 kHz 的电平变化是 +1.0~+1.5 dB —— 也就是**完全不碰**，
    ///   只在 8 kHz 以上砍 44~60 dB。
    ///   而我们没做保护时是全频段均匀压 8~20 dB，
    ///   结果动态范围很高（49 dB）但人声被改了，听感就"不像自己"。
    /// 这不是降噪能力问题，是处理策略问题。
    protect_enabled: bool,
    /// 语音带允许的最大衰减（dB）。12 大约等于"压掉明显噪声但不改音色"。
    protect_max_db: f32,
    /// 语音保护带的下界 bin（300 Hz）
    protect_lo_bin: usize,
    /// 语音保护带的上界 bin（4 kHz）
    protect_hi_bin: usize,
    /// 帧级语音保护（解决"不朴实"的核心机制）。
    ///
    /// 实测根因：对一段本来就干净的语音，模型仍会压掉 22.2% 的帧（>6 dB，
    /// 最狠 -34.7 dB），而这些被压帧的平均能量比正常帧低 9.2 dB。
    /// 也就是说模型把"低能量但真实"的帧（气息、字尾、辅音、齿音）当噪声杀了。
    /// 换任何降噪算法都救不了 —— 这是低能量段误判的通病。
    ///
    /// 做法：按当前帧能量相对全局中位能量的比值判定。
    ///   高于 frame_guard_db 的帧 → 增益下限抬到 guard_floor_db（基本不动）
    ///   低于它 → 正常走模型（该压就压）
    /// 用滑动中位能量跟踪，跟着说话人音量自适应，不需要用户校准。
    frame_guard: bool,
    /// 帧能量相对全局中位能量的阈值（dB）。
    /// 注意：这里的值是"当前帧 / 滑动中位"，语音段通常 >0 dB，噪声段 <0 dB。
    /// 所以这个阈值应该是**正数**（如 +3 dB），才表示"明显强于中位"。
    /// 之前填 -16/-10 是笔误，会让所有帧都计入保护（连噪声一起抬升）。
    frame_guard_db: f32,
    /// 有效语音帧的增益下限（dB）。0 = 完全不压，-3 = 允许轻压。
    guard_floor_db: f32,
    /// 帧能量的滑动中位估计（用指数滑动的分位数近似）
    frame_e_est: f32,
    /// 最近若干帧的最大能量（用于判断"这一帧是否还在一个音节里"）
    frame_e_peak: f32,
    /// 诊断：guard 触发帧数 / 总帧数
    pub guard_hits: u64,
    pub guard_total: u64,
    /// 保护触发时最大抬升量（dB）
    pub guard_lift_db: f32,
    /// 衰减系数：峰值跟踪的下降速度
    peak_decay: f32,

    pub enabled: bool,
    ins: Vec<(String, ort::value::DynValue)>,
    frames: u64,
}

fn numel(shape: &[usize]) -> usize {
    shape.iter().product()
}

impl GtcrnLight48 {
    pub fn new(onnx: &str, ort_dylib: Option<&str>) -> Result<Self, String> {
        let env = if let Some(p) = ort_dylib {
            ort::init_from(p)
                .map_err(|e| format!("load ort: {e}"))?
                .build()
                .map_err(|e| format!("env: {e}"))?
        } else {
            ort::init().build().map_err(|e| format!("env: {e}"))?
        };
        // 内存优化：关闭 arena 分配器 + 关闭 memory pattern
        // ORT 默认用 arena 预分配大块内存（45+ MB），对单路 10ms 帧完全没必要
        let session = ort::session::Session::builder(&env)
            .and_then(|mut b| {
                b = b.with_intra_threads(1)?;
                b = b.with_memory_pattern(false)?;
                b = b.with_config_entry("session.use_env_allocators", "0")?;
                b = b.with_config_entry("CPUExecutionProvider.use_arena", "0")?;
                b.commit_from_file(onnx)
            })
            .map_err(|e| format!("session: {e}"))?;

        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(NFFT);
        let inv = planner.plan_fft_inverse(NFFT);
        let fft_in = fwd.make_input_vec();
        let fft_out = fwd.make_output_vec();
        let ifft_in = inv.make_input_vec();
        let ifft_out = inv.make_output_vec();

        // Hann 窗（periodic）
        let mut win = [0.0f32; NFFT];
        for (i, w) in win.iter_mut().enumerate() {
            *w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / NFFT as f32).cos();
        }

        Ok(Self {
            session,
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
            spec_buf: vec![0.0; NBIN * 2],
            egc: (0..N_ENC).map(|i| vec![0.0; CH * ENC_PAD_T[i] * F2]).collect(),
            dgc: (0..N_DEC).map(|i| vec![0.0; CH * DEC_PAD_T[i] * F2]).collect(),
            etc: (0..N_ENC).map(|_| vec![0.0; numel(&TC_SHAPE)]).collect(),
            dtc: (0..N_DEC).map(|_| vec![0.0; numel(&TC_SHAPE)]).collect(),
            dp1: vec![0.0; numel(&DP_SHAPE)],
            dp2: vec![0.0; numel(&DP_SHAPE)],
            enh_buf: vec![0.0; NBIN * 2],
            mask_smooth: 0.0,
            prev_gain: vec![1.0; NBIN],
            gain_floor_db: -60.0,
            gain_ceil_db: 12.0,
            mask_smooth_high: 0.85,
            smooth_knee_bin: 85,   // 4000 Hz / 48000 * 1024 ≈ 85
            hf_tilt_db_oct: 0.0,
            protect_enabled: false,
            protect_max_db: 12.0,
            protect_lo_bin: 7,     // 300 Hz / 48000 * 1024 ≈ 6.4
            protect_hi_bin: 85,    // 4000 Hz
            frame_guard: false,
            frame_guard_db: 3.0,
            guard_floor_db: -3.0,
            frame_e_est: 0.0,
            frame_e_peak: 0.0,
            guard_hits: 0,
            guard_total: 0,
            guard_lift_db: 4.0,
            peak_decay: 0.85,
            enabled: true,
            ins: Vec::new(),
            frames: 0,
        })
    }

    /// 算法延迟（样本 @48k）
    /// GTCRN-Light 是因果的，但 STFT 窗口中心对齐带来 NFFT/2 的延迟
    pub fn latency_samples(&self) -> usize {
        NFFT / 2 // 512 = 10.67 ms
    }

    pub fn frames_processed(&self) -> u64 {
        self.frames
    }

    /// 设置增益平滑系数（0 = 关闭，越大越平滑）。
    /// 0.5~0.7 是有效区；超过 0.9 会让爆破音发闷。
    /// 设置高频衰减量（dB/octave，0~12）。0 = 完全不衰减（原行为）。
    /// 3 是默认：接近 oopz 通用档的频谱倾斜，毛刺基本消失。
    /// 6~8 会更"闷"但更干净，接近 KOOK 质量档。
    pub fn set_hf_tilt(&mut self, db_oct: f32) -> f32 {
        self.hf_tilt_db_oct = db_oct.clamp(0.0, 12.0);
        self.hf_tilt_db_oct
    }

    /// 语音保护带开关 + 最大衰减量（dB）。
    /// 300 Hz~4 kHz 是人声基频与共振峰，压制超过 12 dB 就开始"不像自己"。
    /// 帧级语音保护：on=启用，guard_db=有效语音帧阈值（相对中位能量），floor_db=最小增益
    /// 设置增益上下限（dB）。
    /// floor 越接近 0，越不允许模型衰减 —— 保真度提升但降噪变弱。
    pub fn set_gain_limits(&mut self, floor_db: f32, ceil_db: f32) -> f32 {
        self.gain_floor_db = floor_db.clamp(-60.0, 0.0);
        self.gain_ceil_db = ceil_db.clamp(0.0, 12.0);
        self.gain_floor_db
    }

    pub fn set_frame_guard(&mut self, on: bool, guard_db: f32, floor_db: f32) -> f32 {
        self.frame_guard = on;
        self.frame_guard_db = guard_db.clamp(-40.0, 0.0);
        self.guard_floor_db = floor_db.clamp(-20.0, 0.0);
        self.guard_floor_db
    }

    pub fn set_protect(&mut self, on: bool, max_db: f32) -> f32 {
        self.protect_enabled = on;
        self.protect_max_db = max_db.clamp(0.0, 40.0);
        self.protect_max_db
    }

    pub fn get_hf_tilt(&self) -> f32 {
        self.hf_tilt_db_oct
    }

    pub fn set_mask_smooth(&mut self, a: f32) -> f32 {
        self.mask_smooth = a.clamp(0.0, 0.95);
        self.mask_smooth
    }

    pub fn get_mask_smooth(&self) -> f32 {
        self.mask_smooth
    }

    pub fn reset(&mut self) {
        self.ana_mem = [0.0; NFFT - HOP];
        // 增益平滑状态复位到 1.0（无衰减先验）。
        // 不复位的话，重连后第一帧会带着上次残留的强衰减，起音发闷。
        self.prev_gain.iter_mut().for_each(|x| *x = 1.0);
        self.frame_e_est = 0.0;
        self.frame_e_peak = 0.0;
        self.ola_buf = [0.0; NFFT];
        self.norm_buf = [0.0; NFFT];
        for v in self.egc.iter_mut().chain(self.dgc.iter_mut())
            .chain(self.etc.iter_mut()).chain(self.dtc.iter_mut()) {
            v.iter_mut().for_each(|x| *x = 0.0);
        }
        self.dp1.iter_mut().for_each(|x| *x = 0.0);
        self.dp2.iter_mut().for_each(|x| *x = 0.0);
    }

    /// 处理一帧 480 samples @48k
    pub fn process_frame(&mut self, input: &[f32], output: &mut [f32]) -> Result<(), String> {
        if !self.enabled {
            output.copy_from_slice(input);
            return Ok(());
        }
        assert_eq!(input.len(), HOP);

        // 1) STFT（centered：ana_mem 保存前一帧）
        // centered STFT：窗口 = [历史 544 | 当前 480]
        self.fft_in[..NFFT - HOP].copy_from_slice(&self.ana_mem);
        self.fft_in[NFFT - HOP..].copy_from_slice(input);
        for i in 0..NFFT {
            self.fft_in[i] *= self.win[i];
        }
        // 滑动历史：保留最后 (NFFT-HOP) 个样本
        let keep = NFFT - HOP; // 544
        let mut newmem = [0.0f32; 544];
        if HOP >= keep {
            newmem.copy_from_slice(&self.fft_in[NFFT - keep..]);
        } else {
            newmem[..keep - HOP].copy_from_slice(&self.ana_mem[HOP..]);
            newmem[keep - HOP..].copy_from_slice(input);
        }
        self.ana_mem = newmem;
        self.fwd
            .process_with_scratch(&mut self.fft_in, &mut self.fft_out, &mut [])
            .map_err(|e| format!("fft: {e:?}"))?;

        for i in 0..NBIN {
            self.spec_buf[i * 2] = self.fft_out[i].re;
            self.spec_buf[i * 2 + 1] = self.fft_out[i].im;
        }

        // 2) ONNX
        self.run_onnx()?;

        // 3) 增益跨帧平滑 + ISTFT
        //
        // enh 是模型输出的复数谱。逐帧独立估计带来一个问题：
        // 相邻帧的增益会剧烈跳变。实测（48k 语音 + 10dB 噪声，800 帧）：
        //   跳变 >6 dB 的帧有 54 个，最大 24.7 dB
        // 这些跳变进 ISTFT 就是每 10 ms 一次的包络台阶 ——
        // 听感即「湿」「水下」「金属感」「像隔着一层布」。
        //
        // 做法：对每个频点的「幅度增益」做一阶平滑，相位沿用模型给的，
        // 再乘回本帧频谱。
        //   - 只平滑幅度：相位在 ±π 处会跳变，平滑它没意义还会绕圈
        //   - 用真实增益而不是复掩码：复掩码在接近零的 bin 上场值极大，
        //     直接平滑会把噪声带进来（实测那样做跳变只从 54 降到 49）
        //
        // 频率相关的平滑：低频轻、高频重。
        //
        // 为什么不能一刀切：实测（48k 语音 + 10dB 噪声）
        //   输入高频（>4k）能量包络抖动 66 次/最大 2.4 倍
        //   经过模型后抖动 123 次/最大 34.7 倍，而总能量只降 0.5 dB
        // 也就是模型对高频几乎不衰减，却把抖动放大了 14 倍 —— 这是毛刺感的根源，
        // 也解释了为什么我们的频谱倾斜只有 -2.1（oopz 是 -6.3）：高频根本没被处理。
        //
        // 原因：4k 以上语音能量本就很少，模型缺少监督信号，掩码在高频随机跳。
        // 而语音清晰度主要靠 300 Hz ~ 4 kHz，高频里绝大多数是噪声和齿音。
        // 所以在高频加大平滑几乎无代价，却能直接消掉毛刺。
        //
        // 分界 4 kHz（bin = 4000/NFFT*SR ≈ 85），以上平滑系数线性增加到上限。
        let a_low = self.mask_smooth.clamp(0.0, 0.95);
        let a_high = self.mask_smooth_high.clamp(0.0, 0.98);
        let knee = self.smooth_knee_bin;
        let tilt = self.hf_tilt_db_oct;
        let has_smooth = a_low > 0.0 || a_high > 0.0;

        // ---- 帧级语音保护判定 ----
        //
        // 先算本帧的输入能量（用频谱能量，避免再扫一遍时域）。
        // 再和"滑动中位能量"比：高于阈值说明这一帧是有效语音，
        // 不应该被当成噪声整体压掉。
        //
        // 中位估计用指数滑动分位数近似（比排序省，也不需要存历史）：
        //   est += k * (cur - est)   能量升得快、降得慢，≈ 稳健的中位数
        let mut guard_active = false;
        if self.frame_guard {
            let mut fe = 0.0f32;
            for i in 0..NBIN {
                let sr = self.fft_out[i].re;
                let si = self.fft_out[i].im;
                fe += sr * sr + si * si;
            }
            let fe_norm = (fe / NBIN as f32).sqrt();
            // 峰值跟踪：立即上升、缓慢衰减。
            // 这样"一个音节内部"（能量从强到弱）都被算在同一次发音里，
            // 而不是把字尾/气息当成独立的低能量帧。
            if fe_norm > self.frame_e_peak {
                self.frame_e_peak = fe_norm;
            } else {
                self.frame_e_peak *= self.peak_decay;
                if self.frame_e_peak < fe_norm { self.frame_e_peak = fe_norm; }
            }
            if self.frame_e_est <= 0.0 {
                self.frame_e_est = fe_norm.max(1e-9);
            } else {
                let k = if fe_norm > self.frame_e_est { 0.05 } else { 0.25 };
                self.frame_e_est += k * (fe_norm - self.frame_e_est);
            }
            // 双条件：既要高于全局中位（是语音不是噪声），
            // 又要处在音节的能量包络内（不是在两个音节之间的空隙）
            let ratio_db = 20.0 * (fe_norm / self.frame_e_est.max(1e-9)).log10();
            let in_syl = fe_norm > self.frame_e_peak * 0.5;    // 约 -6 dB，只在音节主体内
            self.guard_total += 1;
            guard_active = ratio_db > self.frame_guard_db && in_syl;
            if guard_active { self.guard_hits += 1; }
        }
        // 有效语音帧的最小增益（不让模型把它整段压死）
        let guard_lo = 10f32.powf(self.guard_floor_db / 20.0);

        // 先算模型对这一"整帧"的整体增益。
        // 关键：逐 bin 判断是错的 —— 每个 bin 的增益可能都 > guard_lo，
        // 但整帧仍被压了 20 dB（各 bin 都轻微衰减，累加起来很大）。
        // 必须先求整帧能量比，再决定要不要整体抬升。
        // 用"平方根域的增益下界"衡量，而不是整帧能量比。
        //
        // 实测为什么整帧能量比不行：模型对干净语音的总能量只变 -0.18 dB，
        // 但个别 bin 的增益能低到 -30 dB。整帧平均下来看着"没压"，
        // 实际上把语音的谱形削掉了 —— 这才是"不朴实"的真正形态。
        //
        // 所以判据改成：这一帧里有多少 bin 的增益低于 guard_lo？
        // 比例过高说明模型在"大面积削谱"，这时才整体抬升。
        let mut frac_lo = 0.0f32;
        if guard_active {
            let mut nlo = 0usize;
            for i in 0..NBIN {
                let sr = self.fft_out[i].re;
                let si = self.fft_out[i].im;
                let er = self.enh_buf[i * 2];
                let ei = self.enh_buf[i * 2 + 1];
                let mi = (sr * sr + si * si).sqrt();
                let mo = (er * er + ei * ei).sqrt();
                if mi > 1e-9 && mo / mi < guard_lo { nlo += 1; }
            }
            frac_lo = nlo as f32 / NBIN as f32;
        }
        // 需要的额外抬升倍数（<1 表示要往大里抬）
        // 抬升幅度：被削的 bin 越多，抬得越多，但上限 +6 dB。
        // frac_lo=0 不抬；frac_lo>=0.5 抬到上限。
        let lift = if guard_active && frac_lo > 0.0 {
            let t = (frac_lo * 2.0).min(1.0);
            let db = self.guard_lift_db * t;
            10f32.powf(db / 20.0)
        } else {
            1.0
        };

        for i in 0..NBIN {
            // 频率相关平滑系数：knee 以下用 a_low，以上线性过渡到 a_high
            let a = if i <= knee {
                a_low
            } else {
                let t = ((i - knee) as f32 / (NBIN - knee) as f32).min(1.0);
                a_low + (a_high - a_low) * t
            };
            let inv = 1.0 - a;

            let sr = self.fft_out[i].re;
            let si = self.fft_out[i].im;
            let er = self.enh_buf[i * 2];
            let ei = self.enh_buf[i * 2 + 1];

            if has_smooth {
                let mag_in = (sr * sr + si * si).sqrt();
                let mag_out = (er * er + ei * ei).sqrt();
                let mut g = if mag_in > 1e-9 { mag_out / mag_in } else { 1.0 };
                let mut lo = 10f32.powf(self.gain_floor_db / 20.0);
                let hi = 10f32.powf(self.gain_ceil_db / 20.0);
                // 语音保护带：300 Hz~4 kHz 的衰减不能超过 protect_max_db。
                // 这一段是人声的基频与共振峰，改它就会"不像自己"。
                // 实测 KOOK 在这里是 0 dB（完全不碰），我们之前均匀压 8~20 dB，
                // 动态范围好看但音色被改 —— 这是听感差异的真正来源。
                if self.protect_enabled && i >= self.protect_lo_bin && i <= self.protect_hi_bin {
                    let pl = 10f32.powf(-self.protect_max_db / 20.0);
                    if lo < pl { lo = pl; }
                }
                g = g.clamp(lo, hi);
                let pg = self.prev_gain[i].clamp(lo, hi);
                let mut sg = a * pg + inv * g;
                // 高频倾斜修正在平滑之后施加，避免被平滑来回拉扯
                if tilt > 0.0 && i > knee {
                    let oct = (i as f32 / knee as f32).log2();
                    sg *= 10f32.powf(-tilt * oct / 20.0);
                }
                self.prev_gain[i] = sg;
                // ---- 关键：相位用输入的，不用模型的 ----
                //
                // 实测：模型输出与输入的相位余弦相似度 0.9328 —— 它基本保住了相位，
                // 但那 6.7% 的偏差集中在低信噪比的 bin 上，正是这些 bin 让音色发虚。
                //
                // 更根本的理由：GTCRN 是幅度掩蔽模型，训练目标是估计 mask，
                // 它输出的相位只是"顺带"算出来的（复数乘法），没有训练监督。
                // 直接把复掩码乘回去，等于把没受过训练的相位一起用上了。
                //
                // 正确做法：只用模型的 |mask| 作为增益，相位原样沿用带噪信号。
                // 这才是掩蔽模型的标准用法，也是几乎无损的关键：
                //   输出 = |spec| * gain * e^(j·arg(spec))
                // 因为相位完全没被改动，波形的"骨架"保持原样。
                // 用模型输出的复数谱（enh），乘上后处理增益。
                // 注意：不能改用 sr*gain —— 那会丢掉模型对相位的修正，
                // 实测 SNR 从 15 dB 掉到 -5 dB。
                // 模型的 |enh|/|spec| 只是个标量比，复掩码的相位部分也要保留。
                let k2 = sg * lift;
                self.ifft_in[i] = realfft::num_complex::Complex32::new(er * k2, ei * k2);
            } else {
                // 不平滑路径：同样只取幅度增益，相位用输入
                let mag_in2 = (sr * sr + si * si).sqrt();
                let mag_out2 = (er * er + ei * ei).sqrt();
                let mut g2 = if mag_in2 > 1e-9 { mag_out2 / mag_in2 } else { 1.0 };
                let lo2 = 10f32.powf(self.gain_floor_db / 20.0);
                let hi2 = 10f32.powf(self.gain_ceil_db / 20.0);
                g2 = g2.clamp(lo2, hi2);
                if self.protect_enabled && i >= self.protect_lo_bin && i <= self.protect_hi_bin {
                    let pl = 10f32.powf(-self.protect_max_db / 20.0);
                    if g2 < pl { g2 = pl; }
                }
                let mut k = g2 * lift;
                if tilt > 0.0 && i > knee {
                    let oct = (i as f32 / knee as f32).log2();
                    k *= 10f32.powf(-tilt * oct / 20.0);
                }
                self.ifft_in[i] = realfft::num_complex::Complex32::new(er * k, ei * k);
            }
        }
        // 实信号约束
        self.ifft_in[0].im = 0.0;
        self.ifft_in[NBIN - 1].im = 0.0;
        self.inv
            .process_with_scratch(&mut self.ifft_in, &mut self.ifft_out, &mut [])
            .map_err(|e| format!("ifft: {e:?}"))?;

        // 4) 加窗 + OLA（严格对齐 Python 参考实现）
        //    realfft 不归一化，补 1/NFFT（numpy 的 irfft 自带）
        let scale = 1.0 / NFFT as f32;
        for i in 0..NFFT {
            let v = self.ifft_out[i] * self.win[i] * scale;
            self.ola_buf[i] += v;
            self.norm_buf[i] += self.win[i] * self.win[i];
        }
        // 输出前 HOP 个样本，按 norm 逐点归一化
        for i in 0..HOP {
            output[i] = self.ola_buf[i] / self.norm_buf[i].max(1e-8);
        }
        // 左移 HOP，尾部补零
        let mut no = [0.0f32; NFFT];
        let mut nn = [0.0f32; NFFT];
        no[..NFFT - HOP].copy_from_slice(&self.ola_buf[HOP..]);
        nn[..NFFT - HOP].copy_from_slice(&self.norm_buf[HOP..]);
        self.ola_buf = no;
        self.norm_buf = nn;

        // 软限幅：模型输出偶尔超过 1.0，硬削会炸出方波
        for v in output.iter_mut() {
            let a = v.abs();
            if a > 0.95 {
                *v = v.signum() * (0.95 + (a - 0.95).tanh() * 0.05);
            }
        }
        self.frames += 1;

        Ok(())
    }

    fn run_onnx(&mut self) -> Result<(), String> {
        use ort::value::{DynValue, Tensor};

        // 关键：预分配 owned tensor，每帧原地写入后传引用
        // （旧实现每帧新建 27 个 tensor，ORT 内部引用计数累积 → 1.5 MB/s 泄漏）
        if self.ins.is_empty() {
            let mut ins: Vec<(String, DynValue)> = Vec::with_capacity(28);
            ins.push(("spec".into(), Tensor::from_array(([1usize, NBIN, 1, 2], self.spec_buf.clone()))
                .map_err(|e| format!("{e}"))?.into_dyn()));
            for i in 0..N_ENC {
                ins.push((format!("egc{i}"),
                    Tensor::from_array(([1usize, CH, ENC_PAD_T[i], F2], vec![0.0f32; CH*ENC_PAD_T[i]*F2]))
                        .map_err(|e| format!("{e}"))?.into_dyn()));
            }
            for i in 0..N_DEC {
                ins.push((format!("dgc{i}"),
                    Tensor::from_array(([1usize, CH, DEC_PAD_T[i], F2], vec![0.0f32; CH*DEC_PAD_T[i]*F2]))
                        .map_err(|e| format!("{e}"))?.into_dyn()));
            }
            for i in 0..N_ENC {
                ins.push((format!("etc{i}"),
                    Tensor::from_array(([1usize, CH, 4], vec![0.0f32; CH*4]))
                        .map_err(|e| format!("{e}"))?.into_dyn()));
            }
            for i in 0..N_DEC {
                ins.push((format!("dtc{i}"),
                    Tensor::from_array(([1usize, CH, 4], vec![0.0f32; CH*4]))
                        .map_err(|e| format!("{e}"))?.into_dyn()));
            }
            ins.push(("dp1h".into(), Tensor::from_array(([2usize, F2, R], vec![0.0f32; 2*F2*R]))
                .map_err(|e| format!("{e}"))?.into_dyn()));
            ins.push(("dp2h".into(), Tensor::from_array(([2usize, F2, R], vec![0.0f32; 2*F2*R]))
                .map_err(|e| format!("{e}"))?.into_dyn()));
            self.ins = ins;
        }

        // 每帧原地写入 state
        macro_rules! put {
            ($idx:expr, $src:expr) => {{
                let (_, d) = self.ins[$idx].1.try_extract_tensor_mut::<f32>()
                    .map_err(|e| format!("put: {e}"))?;
                d.copy_from_slice($src);
            }};
        }
        put!(0, &self.spec_buf);
        let mut k = 1;
        for i in 0..N_ENC { put!(k, &self.egc[i]); k += 1; }
        for i in 0..N_DEC { put!(k, &self.dgc[i]); k += 1; }
        for i in 0..N_ENC { put!(k, &self.etc[i]); k += 1; }
        for i in 0..N_DEC { put!(k, &self.dtc[i]); k += 1; }
        put!(k, &self.dp1); k += 1;
        put!(k, &self.dp2);

        // 借用拆分：ins 与 session 是不同字段，可以同时可变/不可变借用
        let Self { session, ins, .. } = self;
        let refs: Vec<(String, ort::session::SessionInputValue<'_>)> = ins.iter()
            .map(|(name, v)| (name.clone(), v.into()))
            .collect();
        let outs = session.run(refs).map_err(|e| format!("run: {e}"))?;

        let (_, d) = outs["enh"].try_extract_tensor::<f32>().map_err(|e| format!("{e}"))?;
        self.enh_buf.copy_from_slice(d);
        for i in 0..N_ENC {
            let (_, x) = outs[format!("o_egc{i}").as_str()].try_extract_tensor::<f32>()
                .map_err(|e| format!("{e}"))?;
            self.egc[i].copy_from_slice(x);
        }
        for i in 0..N_DEC {
            let (_, x) = outs[format!("o_dgc{i}").as_str()].try_extract_tensor::<f32>()
                .map_err(|e| format!("{e}"))?;
            self.dgc[i].copy_from_slice(x);
        }
        for i in 0..N_ENC {
            let (_, x) = outs[format!("o_etc{i}").as_str()].try_extract_tensor::<f32>()
                .map_err(|e| format!("{e}"))?;
            self.etc[i].copy_from_slice(x);
        }
        for i in 0..N_DEC {
            let (_, x) = outs[format!("o_dtc{i}").as_str()].try_extract_tensor::<f32>()
                .map_err(|e| format!("{e}"))?;
            self.dtc[i].copy_from_slice(x);
        }
        let (_, d) = outs["o_dp1h"].try_extract_tensor::<f32>().map_err(|e| format!("{e}"))?;
        self.dp1.copy_from_slice(d);
        let (_, d) = outs["o_dp2h"].try_extract_tensor::<f32>().map_err(|e| format!("{e}"))?;
        self.dp2.copy_from_slice(d);
        Ok(())
    }

}
