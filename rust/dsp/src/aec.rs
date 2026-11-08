//! 回声消除（AEC3）—— 直接消费 WebRTC AudioProcessing 的纯 Rust 端口 `sonora`。
//!
//! ── 为什么自己接，而不是用浏览器的 ──
//! Chromium 把 APM 做成了黑盒，而且在 `saturated_echo` / `low_noise_render` 两个状态下
//! 会把抑制增益直接打到 0.001（-60 dB）—— 表现就是"对方一说话，我这边瞬间变小甚至断掉"。
//! 我们自己接之后：参考信号是我们**自己送去播放的 PCM**，什么时候跑、跑多强都由我们决定。
//!
//! ── 三条硬约束（与本项目其它 DSP 一致）──
//! 1. **不加延迟**：48 kHz / 480 样本一帧（10 ms），与 GTCRN 的 HOP 完全相同；
//!    AEC3 是帧内处理，没有 lookahead 累积。整链延迟账本见 `docs/延迟账本.md`。
//! 2. **不重复处理**：只开 AEC3 + 高通；NS 与 AGC2 关掉 —— 降噪交给 GTCRN，
//!    增益策略交给上层。两层降噪叠加我们已经踩过一次坑（gate + VAD 自锁）。
//! 3. **不改变现有行为**：默认 `enabled = true` 但只有被上层显式接入才生效；
//!    接入前的通话路径与本模块无关。
//!
//! ── 参考信号怎么来 ──
//! `render()` 吃的是"我们正要送给扬声器的 PCM"。Electron 里播放走 `<audio>` 元素
//! （拿不到 PCM），所以在 `Mic.actx` 内对每条远端轨建 `MediaStreamAudioSourceNode` →
//! 混音 → 一个专用 worklet，把 PCM 通过 SAB 交给 worker 侧的 AEC。
//! 这条链与现有播放链并行，互不影响。

use sonora::{
    config::{Config, EchoCanceller, HighPassFilter},
    AudioProcessing, StreamConfig,
};

/// 一帧样本数：48 kHz × 10 ms。与 `gtcrn48::HOP` 保持一致，接进主链不需要重采样。
pub const AEC_FRAME: usize = 480;

pub struct Aec {
    apm: AudioProcessing,
    sample_rate: u32,
    enabled: bool,
    frames: u64,
    /// 自算 ERLE 用的能量累计（只在单讲段有意义，由上层或测试决定何时统计）
    e_near: f64,
    e_out: f64,
    t_us: u64,
    delay_ms: i32,
    /// render 侧的输出缓冲（APM 的 API 要求 src/dest 成对）。
    /// 我们关掉了 AGC2/NS，所以这里的内容与输入一致，纯粹为了满足接口且避免每次分配。
    render_out: [f32; AEC_FRAME],
}

impl Aec {
    /// 建 AEC。`sample_rate` 目前只支持 48000（AEC3 内部最高处理率 48 kHz）。
    pub fn new(sample_rate: u32) -> Result<Self, String> {
        if sample_rate != 48000 {
            return Err(format!("AEC3 只支持 48 kHz，收到 {sample_rate}"));
        }
        let mut cfg = Config::default();
        cfg.echo_canceller = Some(EchoCanceller::default());
        cfg.high_pass_filter = Some(HighPassFilter::default());
        // 关掉这两项：降噪与增益由我们自己控制，避免与 GTCRN / 上层增益策略叠乘
        cfg.noise_suppression = None;
        cfg.gain_controller2 = None;

        let sc = StreamConfig::new(sample_rate, 1);
        let apm = AudioProcessing::builder()
            .config(cfg)
            .capture_config(sc)
            .render_config(sc)
            .build();

        Ok(Self {
            apm,
            sample_rate,
            enabled: true,
            frames: 0,
            e_near: 0.0,
            e_out: 0.0,
            t_us: 0,
            delay_ms: 0,
            render_out: [0.0; AEC_FRAME],
        })
    }

    pub fn sample_rate(&self) -> u32 {
        self.sample_rate
    }

    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// 告诉 AEC 播放设备到麦克风的固有延迟（毫秒）。
    /// 不设也能工作（AEC3 自带延迟估计，能容忍几十毫秒），设了收敛更快、更稳。
    pub fn set_delay_ms(&mut self, ms: i32) {
        self.delay_ms = ms.clamp(0, 500);
        let _ = self.apm.set_stream_delay_ms(self.delay_ms);
    }

    pub fn delay_ms(&self) -> i32 {
        self.delay_ms
    }

    /// 播放侧：把"即将送往扬声器的一帧"喂进来当参考信号。
    /// 必须在同一帧的 `capture()` **之前**调用（WebRTC APM 的标准顺序）。
    pub fn render(&mut self, far: &[f32]) -> Result<(), String> {
        if far.len() < AEC_FRAME {
            return Err("render 输入不足一帧".into());
        }
        // sonora 的多声道 API 是「每声道一个切片」的数组，且 src/dest 成对；
        // 我们是单声道，包一层就好。dest 用预分配缓冲，避免音频线程里分配。
        // 字段级拆分借用：apm 与 render_out 是两个字段，可以同时可变借用，零拷贝
        let Self { apm, render_out, .. } = self;
        apm.process_render_f32(&[&far[..AEC_FRAME]], &mut [&mut render_out[..]])
            .map_err(|e| format!("render 失败: {e:?}"))
    }

    /// 采集侧：吃麦克风的一帧，写出消掉回声的一帧。
    /// `enabled == false` 时纯直通（但仍然要让 APM 看到 render，否则下次开启会跳变）。
    pub fn capture(&mut self, near: &[f32], out: &mut [f32]) -> Result<(), String> {
        if near.len() < AEC_FRAME || out.len() < AEC_FRAME {
            return Err("capture 缓冲不足一帧".into());
        }
        if !self.enabled {
            out[..AEC_FRAME].copy_from_slice(&near[..AEC_FRAME]);
            return Ok(());
        }
        let t0 = std::time::Instant::now();
        self.apm
            .process_capture_f32(
                &[&near[..AEC_FRAME]],
                &mut [&mut out[..AEC_FRAME]],
            )
            .map_err(|e| format!("capture 失败: {e:?}"))?;
        let dt = t0.elapsed().as_micros() as u64;
        self.t_us += dt;
        self.frames += 1;

        for i in 0..AEC_FRAME {
            self.e_near += (near[i] as f64) * (near[i] as f64);
            self.e_out += (out[i] as f64) * (out[i] as f64);
        }
        Ok(())
    }

    /// 回调内联版本：跑满一帧 480 样本、写进 `out`，返回本帧耗时（微秒）。
    /// 供 native 的 `process_into` 这类"零分配"路径用。
    pub fn capture_into(&mut self, near: &[f32], out: &mut [f32]) -> Result<u64, String> {
        let t0 = std::time::Instant::now();
        self.capture(near, out)?;
        Ok(t0.elapsed().as_micros() as u64)
    }

    /// 回声抑制量（dB）：`10·log10(Σnear² / Σout²)`。
    /// 只在**单讲段**（只有远端在放、本地不说话）读才有意义 —— 双讲时它会把本地语音也算进去。
    pub fn erle_db(&self) -> f32 {
        if self.e_out <= 0.0 {
            return 0.0;
        }
        10.0 * (self.e_near / self.e_out).max(1e-12).log10() as f32
    }

    /// 实时因子：处理总耗时 / 已处理音频时长。越低越好（<0.05 表示单核占用 <5%）。
    pub fn rtf(&self) -> f32 {
        let audio_us = (self.frames as f64) * 10_000.0; // 每帧 10 ms
        if audio_us <= 0.0 {
            return 0.0;
        }
        (self.t_us as f64 / audio_us) as f32
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    pub fn reset(&mut self) {
        self.frames = 0;
        self.e_near = 0.0;
        self.e_out = 0.0;
        self.t_us = 0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 确定性伪噪声（不用 rand，测试要可复现）
    fn noise(i: usize) -> f32 {
        let x = (i as u32).wrapping_mul(1664525).wrapping_add(1013904223);
        ((x >> 8) as f32 / 8388608.0) - 1.0
    }

    /// 造一个"房间"：far 延迟 delay_samples 后衰减 gain，作为 near 里的回声分量
    struct Room {
        buf: Vec<f32>,
        pos: usize,
        delay: usize,
        gain: f32,
    }
    impl Room {
        fn new(delay: usize, gain: f32) -> Self {
            Self { buf: vec![0.0; delay + AEC_FRAME], pos: 0, delay, gain }
        }
        fn echo(&mut self, far: &[f32], echo: &mut [f32]) {
            let n = self.buf.len();
            for i in 0..AEC_FRAME {
                let read = (self.pos + n - self.delay) % n;
                echo[i] = self.buf[read] * self.gain;
                self.buf[self.pos] = far[i];
                self.pos = (self.pos + 1) % n;
            }
        }
    }

    /// 核心验收：单讲（只有远端在放）时，回声必须被压下去
    #[test]
    fn cancels_synthetic_echo() {
        let mut aec = Aec::new(48000).expect("建 AEC");
        // 15 ms 延迟（720 样本）、-6 dB 衰减的合成回声
        let mut room = Room::new(720, 0.5);
        let mut out = vec![0.0f32; AEC_FRAME];
        let mut echo = vec![0.0f32; AEC_FRAME];
        let mut far = vec![0.0f32; AEC_FRAME];

        for b in 0..600 {
            for i in 0..AEC_FRAME {
                far[i] = 0.3 * noise(b * AEC_FRAME + i);
            }
            room.echo(&far, &mut echo);
            aec.render(&far).expect("render");
            aec.capture(&echo, &mut out).expect("capture");
        }
        let erle = aec.erle_db();
        println!(
            "AEC: 单讲 ERLE = {:.1} dB   帧数 = {}   RTF = {:.4}",
            erle,
            aec.frames(),
            aec.rtf()
        );
        assert!(erle > 15.0, "回声抑制不足：{erle:.1} dB");
    }

    /// 双讲（远端在放 + 本地在说）：本地语音必须基本保留
    #[test]
    fn keeps_local_speech_during_double_talk() {
        let mut aec = Aec::new(48000).expect("建 AEC");
        let mut room = Room::new(480, 0.4);
        let mut out = vec![0.0f32; AEC_FRAME];
        let mut echo = vec![0.0f32; AEC_FRAME];
        let mut far = vec![0.0f32; AEC_FRAME];
        let mut near = vec![0.0f32; AEC_FRAME];

        // 先让 AEC 收敛
        for b in 0..400 {
            for i in 0..AEC_FRAME {
                far[i] = 0.3 * noise(b * AEC_FRAME + i);
            }
            room.echo(&far, &mut echo);
            aec.render(&far).expect("render");
            aec.capture(&echo, &mut out).expect("capture");
        }
        // 再开双讲：本地语音 = 220 Hz 正弦，能量与回声同量级
        aec.reset();
        let mut e_speech_in = 0.0f64;
        let mut e_speech_out = 0.0f64;
        for b in 0..300 {
            for i in 0..AEC_FRAME {
                far[i] = 0.3 * noise((b + 400) * AEC_FRAME + i);
                let t = ((b * AEC_FRAME + i) as f32) / 48000.0;
                near[i] = 0.3 * (2.0 * std::f32::consts::PI * 220.0 * t).sin();
            }
            room.echo(&far, &mut echo);
            for i in 0..AEC_FRAME {
                near[i] += echo[i];
            }
            aec.render(&far).expect("render");
            aec.capture(&near, &mut out).expect("capture");
            if b > 60 {
                for i in 0..AEC_FRAME {
                    e_speech_in += (near[i] as f64) * (near[i] as f64);
                    e_speech_out += (out[i] as f64) * (out[i] as f64);
                }
            }
        }
        // 双讲时输出里既有残留回声也有本地语音，所以这里只要求"不等量级地掉下去"
        let keep_db = 10.0 * (e_speech_out / e_speech_in.max(1e-20)).log10();
        println!("AEC: 双讲 输出/输入 能量比 = {:.2} dB（越高越说明没被过度抑制）", keep_db);
        assert!(keep_db > -6.0, "双讲时本地语音被吃掉太多：{keep_db:.2} dB");
    }

    /// 占用验收：RTF 必须很低（AEC3 是定点/FIR，比 GTCRN 便宜得多）
    #[test]
    fn rtf_is_low() {
        let mut aec = Aec::new(48000).expect("建 AEC");
        let mut out = vec![0.0f32; AEC_FRAME];
        let mut far = vec![0.0f32; AEC_FRAME];
        let mut near = vec![0.0f32; AEC_FRAME];
        for b in 0..2000 {
            for i in 0..AEC_FRAME {
                far[i] = 0.3 * noise(b * AEC_FRAME + i);
                near[i] = 0.1 * noise(b * AEC_FRAME + i + 7);
            }
            aec.render(&far).expect("render");
            aec.capture(&near, &mut out).expect("capture");
        }
        let rtf = aec.rtf();
        println!("AEC: RTF = {rtf:.4}（{} 帧）", aec.frames());
        assert!(rtf < 0.05, "AEC 太吃 CPU：RTF = {rtf:.4}");
    }

    /// 关掉时必须是纯直通（不改一个样本）
    #[test]
    fn disabled_is_bit_exact_passthrough() {
        let mut aec = Aec::new(48000).expect("建 AEC");
        aec.set_enabled(false);
        let far = vec![0.1f32; AEC_FRAME];
        let near: Vec<f32> = (0..AEC_FRAME).map(|i| 0.2 * noise(i)).collect();
        let mut out = vec![0.0f32; AEC_FRAME];
        aec.render(&far).expect("render");
        aec.capture(&near, &mut out).expect("capture");
        assert_eq!(&near[..], &out[..], "直通模式必须逐样本一致");
    }
}
