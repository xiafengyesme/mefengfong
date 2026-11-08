//! FONG GTCRN 降噪 — Rust 实现
//!
//! 链路：48 kHz → 分频 → 16 kHz 低通支路跑 GTCRN → 3:1 插值回 48k → 叠加高频 → 干湿混合
//!
//! 关键常数（全部有实测依据，见 docs/GTCRN接入报告.md）：
//!   - 分频点 7.6 kHz（GTCRN 训练上限 8 kHz）
//!   - 算法延迟 1 帧 = 768 samples @ 48 kHz = 16 ms
//!   - wet = 0.7（实测拐点）

pub mod aec;
pub mod fir_hp;
pub mod fir_lp;
pub mod gtcrn48;
pub mod light;
pub mod specsub;
pub mod spectrum;
pub mod howl;
pub mod lowlatency;
pub mod transient;

use fir_hp::HP_TAPS;
use fir_lp::LP_TAPS;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};

pub const SR48: usize = 48_000;
pub const SR16: usize = 16_000;
pub const DS: usize = 3;
pub const HOP48: usize = 768; // 16 ms
pub const NFFT: usize = 512;
pub const HOP16: usize = NFFT / 2; // 256
pub const NBIN: usize = NFFT / 2 + 1; // 257

/// 算法延迟（样本数 @ 48 kHz）。调用方必须按此对齐输出。
pub const FRAME_DELAY: usize = HOP48;

pub const DEFAULT_WET: f32 = 0.7;

// ONNX state shapes（来自 gtcrn.onnx 的输入声明）
const CC_SHAPE: [usize; 5] = [2, 1, 16, 16, 33];
const TC_SHAPE: [usize; 5] = [2, 3, 1, 1, 16];
const IC_SHAPE: [usize; 4] = [2, 1, 33, 16];

fn cc_size() -> usize {
    CC_SHAPE.iter().product()
}
fn tc_size() -> usize {
    TC_SHAPE.iter().product()
}
fn ic_size() -> usize {
    IC_SHAPE.iter().product()
}

/// 简单 FIR（直接卷积，95 taps，单帧 768 样本足够快）
#[derive(Clone)]
struct Fir {
    taps: &'static [f32; 95],
    hist: [f32; 95],
}

impl Fir {
    fn new(taps: &'static [f32; 95]) -> Self {
        Self {
            taps,
            hist: [0.0; 95],
        }
    }

    /// 流式滤波：输入 frame，写出同长度输出
    fn process(&mut self, input: &[f32], output: &mut [f32]) {
        let n = self.taps.len();
        debug_assert_eq!(input.len(), output.len());
        for (i, &x) in input.iter().enumerate() {
            // 移位历史
            for k in (1..n).rev() {
                self.hist[k] = self.hist[k - 1];
            }
            self.hist[0] = x;
            let mut acc = 0.0f32;
            for k in 0..n {
                acc += self.taps[k] * self.hist[k];
            }
            output[i] = acc;
        }
    }

    fn reset(&mut self) {
        self.hist = [0.0; 95];
    }
}

pub struct Denoiser {
    // ONNX
    session: ort::session::Session,
    cc: Vec<f32>,
    tc: Vec<f32>,
    ic: Vec<f32>,

    // 分频
    lp: Fir,
    hp: Fir,

    // 16k STFT
    fft_fwd: std::sync::Arc<dyn RealToComplex<f32>>,
    fft_inv: std::sync::Arc<dyn ComplexToReal<f32>>,
    win: [f32; NFFT],
    ana_mem: [f32; NFFT - HOP16],
    syn_mem: [f32; NFFT - HOP16],

    // 缓冲
    fft_in: Vec<f32>,
    fft_out: Vec<realfft::num_complex::Complex32>,
    ifft_in: Vec<realfft::num_complex::Complex32>,
    ifft_out: Vec<f32>,
    mix_buf: Vec<f32>, // [1, 257, 1, 2]
    enh_buf: Vec<f32>,

    pub wet: f32,

    // profiling
    pub last_onnx_us: f64,
    pub last_fir_us: f64,
    pub last_fft_us: f64,
}

impl Denoiser {
    /// `onnx_path` 为 gtcrn.onnx 的路径；`ort_dylib` 为 onnxruntime 动态库路径
    pub fn new(onnx_path: &str, ort_dylib: Option<&str>) -> Result<Self, String> {
        let env = if let Some(p) = ort_dylib {
            ort::init_from(p)
                .map_err(|e| format!("load onnxruntime: {e}"))?
                .build()
                .map_err(|e| format!("env: {e}"))?
        } else {
            ort::init()
                .build()
                .map_err(|e| format!("env: {e}"))?
        };
        let session = ort::session::Session::builder(&env)
            .and_then(|mut b| {
                b = b.with_intra_threads(1)?;
                b.commit_from_file(onnx_path)
            })
            .map_err(|e| format!("session: {e}"))?;

        let mut planner = RealFftPlanner::<f32>::new();
        let fft_fwd = planner.plan_fft_forward(NFFT);
        let fft_in = fft_fwd.make_input_vec();
        let fft_out = fft_fwd.make_output_vec();
        let fft_inv = planner.plan_fft_inverse(NFFT);
        let ifft_in = fft_inv.make_input_vec();
        let ifft_out = fft_inv.make_output_vec();

        // Hann 窗（periodic）
        let mut win = [0.0f32; NFFT];
        for (i, w) in win.iter_mut().enumerate() {
            *w = 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / NFFT as f32).cos();
        }

        Ok(Self {
            session,
            cc: vec![0.0; cc_size()],
            tc: vec![0.0; tc_size()],
            ic: vec![0.0; ic_size()],
            lp: Fir::new(&LP_TAPS),
            hp: Fir::new(&HP_TAPS),
            fft_fwd,
            fft_inv,
            win,
            ana_mem: [0.0; NFFT - HOP16],
            syn_mem: [0.0; NFFT - HOP16],
            fft_in,
            fft_out,
            ifft_in,
            ifft_out,
            mix_buf: vec![0.0; NBIN * 2],
            enh_buf: vec![0.0; NBIN * 2],
            wet: DEFAULT_WET,
            last_onnx_us: 0.0,
            last_fir_us: 0.0,
            last_fft_us: 0.0,
        })
    }

    pub fn reset(&mut self) {
        self.cc.iter_mut().for_each(|v| *v = 0.0);
        self.tc.iter_mut().for_each(|v| *v = 0.0);
        self.ic.iter_mut().for_each(|v| *v = 0.0);
        self.lp.reset();
        self.hp.reset();
        self.ana_mem = [0.0; NFFT - HOP16];
        self.syn_mem = [0.0; NFFT - HOP16];
    }

    /// 处理一帧 768 样本 @ 48 kHz
    pub fn process_frame(&mut self, input: &[f32], output: &mut [f32]) -> Result<(), String> {
        assert_eq!(input.len(), HOP48);
        assert_eq!(output.len(), HOP48);

        let t_fir = std::time::Instant::now();
        // 1) 分频
        let mut low = [0.0f32; HOP48];
        let mut high = [0.0f32; HOP48];
        self.lp.process(input, &mut low);
        self.hp.process(input, &mut high);

        self.last_fir_us = t_fir.elapsed().as_secs_f64() * 1e6;

        let t_fft = std::time::Instant::now();
        // 2) 3:1 抽取
        let mut x16 = [0.0f32; HOP16];
        for i in 0..HOP16 {
            x16[i] = low[i * DS];
        }

        // 3) STFT
        self.fft_in[..NFFT - HOP16].copy_from_slice(&self.ana_mem);
        self.fft_in[NFFT - HOP16..].copy_from_slice(&x16);
        for i in 0..NFFT {
            self.fft_in[i] *= self.win[i];
        }
        self.ana_mem.copy_from_slice(&x16);

        self.fft_fwd
            .process_with_scratch(&mut self.fft_in, &mut self.fft_out, &mut [])
            .map_err(|e| format!("fft: {e:?}"))?;

        // 4) 组 ONNX 输入 [1, 257, 1, 2]
        for i in 0..NBIN {
            self.mix_buf[i * 2] = self.fft_out[i].re;
            self.mix_buf[i * 2 + 1] = self.fft_out[i].im;
        }

        self.last_fft_us = t_fft.elapsed().as_secs_f64() * 1e6;

        // 5) ONNX 推理
        let t_onnx = std::time::Instant::now();
        self.run_onnx()?;
        self.last_onnx_us = t_onnx.elapsed().as_secs_f64() * 1e6;

        // 6) 反 STFT
        for i in 0..NBIN {
            self.ifft_in[i] = realfft::num_complex::Complex32::new(
                self.enh_buf[i * 2],
                self.enh_buf[i * 2 + 1],
            );
        }
        // realfft 的数学约束：DC 与 Nyquist bin 的虚部必须为 0（实信号）
        self.ifft_in[0].im = 0.0;
        self.ifft_in[NBIN - 1].im = 0.0;
        self.fft_inv
            .process_with_scratch(&mut self.ifft_in, &mut self.ifft_out, &mut [])
            .map_err(|e| format!("ifft: {e:?}"))?;

        // 7) 加窗 + 重叠相加
        //    realfft 的反变换不做 1/N 归一化（numpy 的 ifft 会做），必须补 1/N。
        //    再乘 COLA 归一化 2/1.5（hann 窗 50% overlap 的 sum(w²)=1.5，且正反各一次）。
        let scale = (1.0 / NFFT as f32) * (2.0 / 1.5);
        for i in 0..NFFT {
            self.ifft_out[i] *= self.win[i] * scale;
        }
        let mut out16 = [0.0f32; HOP16];
        for i in 0..HOP16 {
            out16[i] = self.ifft_out[i] + self.syn_mem[i];
        }
        self.syn_mem.copy_from_slice(&self.ifft_out[HOP16..]);

        // 8) 3:1 插值（线性，足够因为后面还有 16k 带宽）
        //    注意：这里必须和 Python 的 resample_poly 近似，用线性插值
        let mut y48 = [0.0f32; HOP48];
        for i in 0..HOP16 {
            let a = out16[i];
            let b = if i + 1 < HOP16 { out16[i + 1] } else { out16[i] };
            for k in 0..DS {
                let t = (k as f32 + 1.0) / (DS as f32 + 1.0);
                y48[i * DS + k] = a + (b - a) * t;
            }
        }

        // 9) 高频 + 干湿混合
        let w = self.wet;
        for i in 0..HOP48 {
            let enhanced = y48[i] + high[i];
            output[i] = w * enhanced + (1.0 - w) * input[i];
        }
        Ok(())
    }

    fn run_onnx(&mut self) -> Result<(), String> {
        use ort::value::Tensor;

        let mix = Tensor::from_array(([1usize, NBIN, 1, 2], self.mix_buf.clone()))
            .map_err(|e| format!("mix tensor: {e}"))?;
        let cc = Tensor::from_array((
            [
                CC_SHAPE[0], CC_SHAPE[1], CC_SHAPE[2], CC_SHAPE[3], CC_SHAPE[4],
            ],
            self.cc.clone(),
        ))
        .map_err(|e| format!("cc tensor: {e}"))?;
        let tc = Tensor::from_array((
            [
                TC_SHAPE[0], TC_SHAPE[1], TC_SHAPE[2], TC_SHAPE[3], TC_SHAPE[4],
            ],
            self.tc.clone(),
        ))
        .map_err(|e| format!("tc tensor: {e}"))?;
        let ic = Tensor::from_array((
            [IC_SHAPE[0], IC_SHAPE[1], IC_SHAPE[2], IC_SHAPE[3]],
            self.ic.clone(),
        ))
        .map_err(|e| format!("ic tensor: {e}"))?;

        let outputs = self
            .session
            .run(ort::inputs![
                "mix" => mix,
                "conv_cache" => cc,
                "tra_cache" => tc,
                "inter_cache" => ic,
            ])
            .map_err(|e| format!("run: {e}"))?;

        // enh [1,257,1,2]
        let (shape, data) = outputs["enh"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("enh: {e}"))?;
        debug_assert_eq!(shape.len(), 4);
        self.enh_buf.copy_from_slice(data);

        let (_, d) = outputs["conv_cache_out"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("cc out: {e}"))?;
        self.cc.copy_from_slice(d);

        let (_, d) = outputs["tra_cache_out"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("tc out: {e}"))?;
        self.tc.copy_from_slice(d);

        let (_, d) = outputs["inter_cache_out"]
            .try_extract_tensor::<f32>()
            .map_err(|e| format!("ic out: {e}"))?;
        self.ic.copy_from_slice(d);

        Ok(())
    }
}
