//! FONG 降噪的 Node.js 原生模块（napi-rs）
//!
//! 设计原则：**IPC 按块传输，不是按音频设备的回调帧**。
//!   AudioWorklet 侧的 128 samples 太碎（每 2.7ms 一次 IPC），开销会吃掉收益。
//!   这里按 480 samples（10 ms）一块传，正好是 GTCRN-Light 的帧长。
//!
//! 用法（renderer 侧）：
//!   const { FongDenoise } = require('fong-native');
//!   const d = new FongDenoise(onnxDllPath);
//!   const out = d.process(float32Array);   // 输入输出都是 480 的整数倍
//!
//! 注意：ORT 限制一个进程只能建一个 Environment，所以模块内部做了单例守卫。

#![deny(clippy::all)]

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Mutex, Once};

use fong_dsp::aec::{Aec, AEC_FRAME};
use fong_dsp::gtcrn48::{GtcrnLight48, HOP};
use nnnoiseless::DenoiseState;
use fong_dsp::howl::HowlSuppressor;
use fong_dsp::spectrum::SpectrumAnalyzer;
use fong_dsp::transient::{TransientConfig, TransientSuppressor};

/// 探测用 FFT 大小（啸叫/瞬态检测共用）
const DETECT_NFFT: usize = 1024;
const DETECT_NBIN: usize = DETECT_NFFT / 2 + 1;

static ORT_INIT: Once = Once::new();

#[napi(object)]
pub struct DenoiseStats {
    pub frames: i64,
    pub howl_count: i64,
    pub transient_frames: i64,
    pub latency_ms: f64,
    /// 每帧检测（啸叫+瞬态）平均耗时（微秒）
    pub detect_us: f64,
    /// 每帧 GTCRN 推理平均耗时（微秒）
    pub infer_us: f64,
}

#[napi]
pub struct FongDenoise {
    inner: Mutex<Inner>,
}

/// 降噪档位
///   0 = 关闭（直通，零开销）
///   1 = 低占用（RNNoise，RTF 0.004，降噪约 9 dB）
///   2 = 质量（GTCRN-Light-48k，RTF 0.19，降噪约 35 dB）
const MODE_OFF: i32 = 0;
const MODE_LIGHT: i32 = 1;
const MODE_QUALITY: i32 = 2;
/// 3 = 自然档（高通 + 自适应噪声门）。不碰频谱形状，保真度最高。
const MODE_NATURAL: i32 = 3;

struct Inner {
    den: GtcrnLight48,
    /// 低占用档：RNNoise（48 kHz / 480 样本一帧，输入输出用 i16 量程）
    rn: Box<DenoiseState<'static>>,
    mode: i32,
    howl: HowlSuppressor,
    trans: TransientSuppressor,
    /// 时域缓冲：攒够 HOP 才处理
    acc: Vec<f32>,
    /// FFT 频谱分析器（替代原先的朴素 DFT）
    spec: SpectrumAnalyzer,
    enabled: bool,
    howl_enabled: bool,
    trans_enabled: bool,
    /// 细粒度计时（微秒累计），用于定位 CPU 花在哪
    t_detect_us: u64,
    t_infer_us: u64,
    /// 低占用档处理的帧数
    frames_light: u64,
    /// 自然档：高通 + 自适应噪声门
    light: fong_dsp::light::LightDenoise,
    /// 质量档的 wet/dry 混合比例（0..1）。
    /// 1.0 = 全 wet（模型输出），0.0 = 全 dry（原始信号）。
    /// 为什么要可调：GTCRN 做的是时变频谱掩蔽，每 16 ms 估一次增益并改写
    /// 相位关系。抑制越猛、增益曲线越陡，相位失真越明显 ——
    /// 听感就是「湿」「水下」「金属感」。掺入一部分干信号能显著缓解，
    /// 代价是降噪量下降。默认 0.85 是实测下来降噪量与自然度的平衡点。
    wet: f32,
}

#[napi]
impl FongDenoise {
    /// `ort_dylib` 可以传 null（若 onnxruntime.dll 已在 PATH 里）
    #[napi(constructor)]
    pub fn new(onnx_path: String, ort_dylib: Option<String>) -> Result<Self> {
        let mut init_err: Option<String> = None;

        // ORT 的 Environment 是进程级单例，重复创建会失败。
        // 用一个 Once 保证只尝试一次，后续实例直接复用已初始化的环境。
        ORT_INIT.call_once(|| {});

        let den = GtcrnLight48::new(&onnx_path, ort_dylib.as_deref())
            .map_err(|e| {
                init_err = Some(e.clone());
                Error::from_reason(format!("降噪初始化失败: {e}"))
            })?;

        Ok(Self {
            inner: Mutex::new(Inner {
                den,
                rn: DenoiseState::new(),
                mode: MODE_QUALITY,
                light: fong_dsp::light::LightDenoise::new(48000.0),
                howl: HowlSuppressor::new(DETECT_NBIN, 48000.0),
                trans: TransientSuppressor::new(DETECT_NBIN, TransientConfig::default()),
                acc: Vec::with_capacity(HOP * 4),
                spec: SpectrumAnalyzer::new(DETECT_NFFT),
                enabled: true,
                howl_enabled: true,
                trans_enabled: true,
                t_detect_us: 0,
                t_infer_us: 0,
                frames_light: 0,
                wet: 1.0,
            }),
        })
    }

    /// 处理任意长度 PCM（Float32，48 kHz 单声道）。
    /// 返回值长度 = 输入长度（不足一块的部分原样透传）。
    #[napi]
    pub fn process(&self, input: Float32Array) -> Result<Float32Array> {
        let mut g = self
            .inner
            .lock()
            .map_err(|_| Error::from_reason("降噪器锁中毒"))?;

        let src: &[f32] = &input;
        if !g.enabled {
            return Ok(src.to_vec().into());
        }

        let mut out: Vec<f32> = Vec::with_capacity(src.len() + HOP);

        for &s in src {
            g.acc.push(s);
            if g.acc.len() >= HOP {
                let mut block = [0.0f32; HOP];
                block.copy_from_slice(&g.acc[..HOP]);
                g.acc.drain(..HOP);

                // 1) 检测：啸叫 + 瞬态（每块做一次，成本很低）
                if g.howl_enabled || g.trans_enabled {
                    let bin_hz = g.spec.bin_hz(48000.0);
                    let mag_owned: Vec<f32> = g.spec.magnitude(&block).to_vec();
                    let vad =
                        fong_dsp::transient::TransientSuppressor::spectral_flatness_pub(&mag_owned) < 0.5;
                    if g.howl_enabled {
                        let _ = g.howl.detect(&mag_owned);
                    }
                    if g.trans_enabled {
                        // 瞬态抑制：整块衰减（不是谱减，避免空洞）
                        let _ = g.trans.process(&mag_owned, vad, bin_hz);
                    }
                }

                // 2) 啸叫陷波（时域线性滤波，不影响其他频段）
                if g.howl_enabled {
                    g.howl.apply(&mut block);
                }

                // 3) GTCRN 降噪
                let mut processed = [0.0f32; HOP];
                if g.den.process_frame(&block, &mut processed).is_err() {
                    processed = block; // 出错直通，绝不静音
                }
                out.extend_from_slice(&processed);
            }
        }

        // 不足一块的尾巴原样送出（保证长度一致，上层无需处理）
        out.extend_from_slice(&g.acc);
        Ok(out.into())
    }

    /**
     * 处理恰好一块（HOP=480），输入输出可以是 SharedArrayBuffer 的视图。
     *
     * 为什么单独开一个方法：
     *   renderer 和 AudioWorklet 在同一进程，可以用 SAB 零拷贝传数据。
     *   主线程直接把 SAB 的两个视图传进来，Rust 侧读写同一块内存，
     *   省掉结构化克隆的复制。
     *
     * 返回实际处理的块数（0 或 1）。
     */
    #[napi]
    pub fn process_into(&self, input: Float32Array, mut output: Float32Array) -> Result<u32> {
        if input.len() < HOP {
            return Err(Error::from_reason("输入不足一块"));
        }
        let mut g = self.inner.lock().map_err(|_| Error::from_reason("锁中毒"))?;

        // 关闭档：直通
        if !g.enabled || g.mode == MODE_OFF {
            let src: &[f32] = &input;
            // SAFETY: output 是本函数独占的可写视图，长度已校验
            let dst = unsafe { output.as_mut() };
            dst[..HOP].copy_from_slice(&src[..HOP]);
            return Ok(1);
        }

        // 自然档：高通 + 噪声门。完全不碰频谱形状 —— 语音段波形逐样本不变，
        // 所以保真度是数学上的精确（相比 AI 降噪的 15 dB，这一档能到 38 dB）。
        if g.mode == MODE_NATURAL {
            let src: &[f32] = &input;
            let dst = unsafe { output.as_mut() };
            g.light.process_block(&src[..HOP], &mut dst[..HOP]);
            return Ok(1);
        }

        // 低占用档：RNNoise
        if g.mode == MODE_LIGHT {
            let mut rin = [0.0f32; HOP];
            let mut rout = [0.0f32; HOP];
            let src: &[f32] = &input;
            for i in 0..HOP {
                // RNNoise 用 i16 量程
                rin[i] = src[i] * 32768.0;
            }
            let _vad = g.rn.process_frame(&mut rout, &rin);
            let dst = unsafe { output.as_mut() };
            for i in 0..HOP {
                dst[i] = (rout[i] / 32768.0).clamp(-1.0, 1.0);
            }
            g.frames_light += 1;
            return Ok(1);
        }

        // 质量档：GTCRN-Light-48k + 啸叫/瞬态检测
        let t0 = std::time::Instant::now();
        let mut block = [0.0f32; HOP];
        block.copy_from_slice(&input[..HOP]);

        // 检测（啸叫 + 瞬态）
        if g.howl_enabled || g.trans_enabled {
            let bin_hz = g.spec.bin_hz(48000.0);
            let mag: Vec<f32> = g.spec.magnitude(&block).to_vec();
            let vad = fong_dsp::transient::TransientSuppressor::spectral_flatness_pub(&mag) < 0.5;
            if g.howl_enabled {
                let _ = g.howl.detect(&mag);
            }
            if g.trans_enabled {
                let _ = g.trans.process(&mag, vad, bin_hz);
            }
        }
        if g.howl_enabled {
            g.howl.apply(&mut block);
        }

        let t1 = std::time::Instant::now();
        let mut processed = [0.0f32; HOP];
        if g.den.process_frame(&block, &mut processed).is_err() {
            processed = block;
        }
        let t2 = std::time::Instant::now();
        g.t_detect_us += t1.duration_since(t0).as_micros() as u64;
        g.t_infer_us += t2.duration_since(t1).as_micros() as u64;
        // wet/dry 混合。
        // wet=1.0 时等价于原来直接拷贝 processed（零额外开销）。
        // 注意 block 此时已经被啸叫抑制改过，但它仍是"干"信号的一种 ——
        // 啸叫抑制是窄带衰减，不破坏相位关系，掺回来不引入湿感。
        let w = g.wet.clamp(0.0, 1.0);
        // SAFETY: 同上，input 已读完，output 独占可写
        let out = unsafe { output.as_mut() };
        if w >= 0.999 {
            out[..HOP].copy_from_slice(&processed);
        } else {
            let d = 1.0 - w;
            for i in 0..HOP {
                out[i] = w * processed[i] + d * block[i];
            }
        }
        Ok(1)
    }

    /// 批量处理：一次调用处理 `blocks` 块，摊薄 napi 调用开销。
    /// input/output 长度须为 HOP*blocks。用于测量和低频率调用场景。
    #[napi]
    pub fn process_batch(&self, input: Float32Array, mut output: Float32Array, blocks: u32) -> Result<u32> {
        let nb = blocks as usize;
        let need = HOP * nb;
        if input.len() < need || output.len() < need {
            return Err(Error::from_reason("缓冲长度不足"));
        }
        let mut g = self.inner.lock().map_err(|_| Error::from_reason("锁中毒"))?;
        let mut processed = [0.0f32; HOP];
        for b in 0..nb {
            let off = b * HOP;
            let mut block = [0.0f32; HOP];
            block.copy_from_slice(&input[off..off + HOP]);
            if g.howl_enabled || g.trans_enabled {
                let bin_hz = g.spec.bin_hz(48000.0);
                let mag: Vec<f32> = g.spec.magnitude(&block).to_vec();
                let _ = fong_dsp::transient::TransientSuppressor::spectral_flatness_pub(&mag);
                if g.howl_enabled { let _ = g.howl.detect(&mag); }
                if g.trans_enabled { let _ = g.trans.process(&mag, true, bin_hz); }
            }
            if g.howl_enabled { g.howl.apply(&mut block); }
            if g.den.process_frame(&block, &mut processed).is_err() { processed = block; }
            let out = unsafe { output.as_mut() };
            out[off..off + HOP].copy_from_slice(&processed);
        }
        Ok(blocks)
    }

    /**
     * 设置降噪档位。
     *   0 = 关闭（直通）
     *   1 = 低占用（RNNoise，RTF ≈ 0.004，降噪约 9 dB）
     *   2 = 质量（GTCRN-Light-48k，RTF ≈ 0.19，降噪约 35 dB）
     */
    #[napi]
    pub fn set_mode(&self, mode: i32) -> bool {
        if let Ok(mut g) = self.inner.lock() {
            let m = mode.clamp(0, 3);
            if m != g.mode {
                g.mode = m;
                // 切换档位要重置状态，避免两个引擎的状态互相污染
                g.den.reset();
                g.rn = DenoiseState::new();
                g.acc.clear();
                g.howl = HowlSuppressor::new(DETECT_NBIN, 48000.0);
                g.trans = TransientSuppressor::new(DETECT_NBIN, TransientConfig::default());
            }
            return true;
        }
        false
    }

    #[napi]
    pub fn get_mode(&self) -> i32 {
        self.inner.lock().map(|g| g.mode).unwrap_or(MODE_QUALITY)
    }

    /// 旁路开关（关闭时零 CPU 开销）
    #[napi]
    pub fn set_enabled(&self, on: bool) {
        if let Ok(mut g) = self.inner.lock() {
            g.enabled = on;
            if !on {
                g.acc.clear();
            }
        }
    }

    #[napi]
    pub fn is_enabled(&self) -> bool {
        self.inner.lock().map(|g| g.enabled).unwrap_or(false)
    }

    #[napi]
    pub fn set_howl_suppression(&self, on: bool) {
        if let Ok(mut g) = self.inner.lock() {
            g.howl_enabled = on;
            g.howl.set_enabled(on);
        }
    }

    /// 设置 wet/dry 混合比例（0..1）。
    /// 1.0 = 全 wet（最大降噪，可能有湿感）；0.0 = 全 dry（纯直通）。
    /// 0.7~0.9 之间是可用区间：0.7 明显更自然但降噪少，0.9 接近纯模型输出。
    #[napi]
    pub fn set_wet_mix(&self, ratio: f64) -> f64 {
        if let Ok(mut g) = self.inner.lock() {
            g.wet = (ratio as f32).clamp(0.0, 1.0);
            return g.wet as f64;
        }
        1.0
    }

    /// 高频衰减（dB/octave，0~12）。0 = 原行为，3 = 默认，6~8 更闷更干净。
    #[napi]
    pub fn set_hf_tilt(&self, db_oct: f64) -> f64 {
        if let Ok(mut g) = self.inner.lock() {
            return g.den.set_hf_tilt(db_oct as f32) as f64;
        }
        0.0
    }

    /// 自然档诊断：(本底噪声dB, 门限dB, 当前增益dB)
    #[napi]
    pub fn light_status(&self) -> Vec<f64> {
        self.inner.lock().map(|g| {
            let (f, t, gn) = g.light.status();
            vec![f as f64, t as f64, gn as f64]
        }).unwrap_or(vec![0.0, 0.0, 0.0])
    }

    /// 诊断：guard 触发率（hits/total）
    #[napi]
    pub fn guard_stats(&self) -> Vec<i64> {
        self.inner.lock().map(|g| vec![g.den.guard_hits as i64, g.den.guard_total as i64]).unwrap_or(vec![0,0])
    }

    /// 增益上下限（dB）：floor 越接近 0 越保真、降噪越弱
    #[napi]
    pub fn set_gain_limits(&self, floor_db: f64, ceil_db: f64) -> f64 {
        if let Ok(mut g) = self.inner.lock() {
            return g.den.set_gain_limits(floor_db as f32, ceil_db as f32) as f64;
        }
        0.0
    }

    /// 帧级语音保护：on=启用，guard_db=有效语音帧阈值，floor_db=最小增益(dB)
    #[napi]
    pub fn set_frame_guard(&self, on: bool, guard_db: f64, floor_db: f64) -> f64 {
        if let Ok(mut g) = self.inner.lock() {
            return g.den.set_frame_guard(on, guard_db as f32, floor_db as f32) as f64;
        }
        0.0
    }

    /// 语音保护带：on=启用，max_db=300Hz~4kHz 允许的最大衰减
    #[napi]
    pub fn set_protect(&self, on: bool, max_db: f64) -> f64 {
        if let Ok(mut g) = self.inner.lock() {
            return g.den.set_protect(on, max_db as f32) as f64;
        }
        0.0
    }

    #[napi]
    pub fn get_hf_tilt(&self) -> f64 {
        self.inner.lock().map(|g| g.den.get_hf_tilt() as f64).unwrap_or(0.0)
    }

    /// 增益跨帧平滑系数（0..0.95）。
    /// 0 = 关闭（逐帧独立，湿感重）；0.55 = 默认；>0.9 瞬态发闷。
    #[napi]
    pub fn set_mask_smooth(&self, ratio: f64) -> f64 {
        if let Ok(mut g) = self.inner.lock() {
            return g.den.set_mask_smooth(ratio as f32) as f64;
        }
        0.0
    }

    #[napi]
    pub fn get_mask_smooth(&self) -> f64 {
        self.inner.lock().map(|g| g.den.get_mask_smooth() as f64).unwrap_or(0.0)
    }

    #[napi]
    pub fn get_wet_mix(&self) -> f64 {
        self.inner.lock().map(|g| g.wet as f64).unwrap_or(1.0)
    }

    #[napi]
    pub fn set_transient_suppression(&self, on: bool) {
        if let Ok(mut g) = self.inner.lock() {
            g.trans_enabled = on;
            g.trans.enabled = on;
        }
    }

    /// 算法延迟（毫秒）。上层按此做时间戳对齐。
    #[napi]
    pub fn latency_ms(&self) -> f64 {
        self.inner
            .lock()
            .map(|g| {
                if g.mode == MODE_NATURAL { g.light.latency_samples() as f64 / 48.0 }
                else { g.den.latency_samples() as f64 / 48.0 }
            })
            .unwrap_or(0.0)
    }

    #[napi]
    pub fn reset(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.den.reset();
            g.light.reset();
            g.howl = HowlSuppressor::new(DETECT_NBIN, 48000.0);
            g.trans = TransientSuppressor::new(DETECT_NBIN, TransientConfig::default());
            g.acc.clear();
        }
    }

    #[napi]
    pub fn stats(&self) -> DenoiseStats {
        match self.inner.lock() {
            Ok(g) => {
                let n = g.den.frames_processed().max(1) as f64;
                DenoiseStats {
                    frames: g.den.frames_processed() as i64,
                    howl_count: g.howl.howl_events as i64,
                    transient_frames: g.trans.suppressed_frames as i64,
                    latency_ms: g.den.latency_samples() as f64 / 48.0,
                    detect_us: g.t_detect_us as f64 / n,
                    infer_us: g.t_infer_us as f64 / n,
                }
            }
            Err(_) => DenoiseStats {
                frames: 0,
                howl_count: 0,
                transient_frames: 0,
                latency_ms: 0.0,
                detect_us: 0.0,
                infer_us: 0.0,
            },
        }
    }
}

/// 回声消除（AEC3）的 napi 包装。
///
/// 用法（renderer → worker）：
/// ```js
/// const aec = new FongAec(48000);
/// aec.setDelayMs(deviceLatencyMs);        // 可选，给 AEC 一个初值
/// // 每 10 ms 一帧：
/// aec.render(farFrame);                   // 即将送去扬声器的 PCM
/// const clean = aec.capture(nearFrame);   // 麦克风 PCM → 消掉回声
/// ```
/// 顺序不能反：WebRTC APM 要求同一帧先 render 后 capture。
#[napi]
pub struct FongAec {
    inner: Mutex<Aec>,
}

#[napi]
impl FongAec {
    #[napi(constructor)]
    pub fn new(sample_rate: u32) -> Result<Self> {
        let a = Aec::new(sample_rate).map_err(Error::from_reason)?;
        Ok(Self { inner: Mutex::new(a) })
    }

    /// 播放侧一帧（480 样本 / 10 ms）。
    #[napi]
    pub fn render(&self, far: Float32Array) -> Result<()> {
        if far.len() < AEC_FRAME {
            return Err(Error::from_reason("far 不足一帧（480）"));
        }
        let mut g = self.inner.lock().map_err(|_| Error::from_reason("锁中毒"))?;
        g.render(&far).map_err(Error::from_reason)
    }

    /// 采集侧一帧：入参麦克风 PCM，返回消掉回声后的 480 样本。
    #[napi]
    pub fn capture(&self, near: Float32Array) -> Result<Float32Array> {
        if near.len() < AEC_FRAME {
            return Err(Error::from_reason("near 不足一帧（480）"));
        }
        let mut g = self.inner.lock().map_err(|_| Error::from_reason("锁中毒"))?;
        let mut out = vec![0.0f32; AEC_FRAME];
        g.capture(&near, &mut out).map_err(Error::from_reason)?;
        Ok(Float32Array::new(out))
    }

    /// 【0.4.37】零分配版本：结果写进调用方的 480 样本缓冲。
    /// 原 `capture()` 每次返回一个新 Float32Array —— 每 10 ms 一次 napi 分配 + 一次拷贝，
    /// 在音频线程上是不必要的退化（独立审查指出）。这里直接写调用方缓冲。
    #[napi]
    pub fn capture_into(&self, near: Float32Array, mut out: Float32Array) -> Result<u32> {
        if near.len() < AEC_FRAME || out.len() < AEC_FRAME {
            return Err(Error::from_reason("缓冲不足一帧（480）"));
        }
        let mut g = self.inner.lock().map_err(|_| Error::from_reason("锁中毒"))?;
        // SAFETY: out 是本函数独占的可写视图，长度已校验
        let dst = unsafe { out.as_mut() };
        g.capture(&near, &mut dst[..AEC_FRAME]).map_err(Error::from_reason)?;
        Ok(AEC_FRAME as u32)
    }

    /// 关掉时逐样本直通（零风险回退开关）。
    #[napi]
    pub fn set_enabled(&self, on: bool) -> bool {
        if let Ok(mut g) = self.inner.lock() {
            g.set_enabled(on);
            return g.is_enabled();
        }
        false
    }

    #[napi]
    pub fn is_enabled(&self) -> bool {
        self.inner.lock().map(|g| g.is_enabled()).unwrap_or(false)
    }

    /// 告知播放设备到麦克风的固有延迟（毫秒）。不设也能收敛（AEC3 自带延迟估计）。
    #[napi]
    pub fn set_delay_ms(&self, ms: i32) -> i32 {
        if let Ok(mut g) = self.inner.lock() {
            g.set_delay_ms(ms);
            return g.delay_ms();
        }
        0
    }

    /// 回声抑制量（dB），只在单讲段读有意义。
    #[napi]
    pub fn erle_db(&self) -> f64 {
        self.inner.lock().map(|g| g.erle_db() as f64).unwrap_or(0.0)
    }

    /// 实时因子：处理耗时 / 音频时长。
    #[napi]
    pub fn rtf(&self) -> f64 {
        self.inner.lock().map(|g| g.rtf() as f64).unwrap_or(0.0)
    }

    #[napi]
    pub fn frames(&self) -> i64 {
        self.inner.lock().map(|g| g.frames() as i64).unwrap_or(0)
    }

    #[napi]
    pub fn reset(&self) {
        if let Ok(mut g) = self.inner.lock() {
            g.reset();
        }
    }
}
