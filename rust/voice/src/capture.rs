//! 音频采集（WASAPI / CoreAudio / ALSA，由 cpal 抽象）
//!
//! 关键约束：
//!   - 必须是 48 kHz。不是 48k 的设备直接报错，不做隐藏重采样
//!     （浏览器那条 44.1k→48k 的重采样是音质损失的一个来源）
//!   - 单声道优先；设备只支持立体声时取左声道（人声是单声道源）

use anyhow::{bail, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;

use crate::ring::Ring;
use crate::SR;

pub struct Capture {
    _stream: Stream,
    pub device_name: String,
    pub sample_rate: u32,
    pub channels: u16,
    /// 溢出计数（设备时钟快于处理时钟时会增长）
    pub overruns: Arc<AtomicU64>,
    pub running: Arc<AtomicBool>,
}

/// 列出所有输入设备
pub fn list_input_devices() -> Result<Vec<String>> {
    let host = cpal::default_host();
    let mut out = Vec::new();
    for d in host.input_devices().context("枚举输入设备")? {
        if let Ok(name) = d.name() {
            out.push(name);
        }
    }
    Ok(out)
}

/// 打开采集。`ring` 由调用方持有，采集线程直接写入。
pub fn open(
    device_name: Option<&str>,
    ring: Arc<std::sync::Mutex<Ring>>,
    frame_samples: usize,
) -> Result<Capture> {
    let host = cpal::default_host();

    let device = match device_name {
        Some(want) => {
            let mut found = None;
            for d in host.input_devices()? {
                if let Ok(n) = d.name() {
                    if n == want {
                        found = Some(d);
                        break;
                    }
                }
            }
            found.with_context(|| format!("找不到输入设备: {want}"))?
        }
        None => host.default_input_device().context("没有默认输入设备")?,
    };

    let name = device.name().unwrap_or_else(|_| "unknown".into());

    // 强制 48 kHz 单声道
    let mut chosen: Option<cpal::SupportedStreamConfig> = None;
    for cfg in device.supported_input_configs()? {
        let r = cfg.min_sample_rate().0..=cfg.max_sample_rate().0;
        if r.contains(&SR) && cfg.channels() >= 1 {
            chosen = Some(cfg.with_sample_rate(cpal::SampleRate(SR)));
            break;
        }
    }
    let cfg = match chosen {
        Some(c) => c,
        None => bail!(
            "设备「{name}」不支持 48000 Hz 采集。FONG 要求原生 48 kHz，\
             不做隐藏重采样（那会损失音质）。请在系统设置里把设备采样率改成 48000。"
        ),
    };

    let sample_format = cfg.sample_format();
    let channels = cfg.channels();
    let config: StreamConfig = cfg.into();

    let overruns = Arc::new(AtomicU64::new(0));
    let running = Arc::new(AtomicBool::new(true));
    let ov = overruns.clone();
    let run = running.clone();

    // 帧缓冲：设备回调给的是任意长度，先攒够 frame_samples 再入环形缓冲
    let mut acc: Vec<f32> = Vec::with_capacity(frame_samples * 2);

    let err_fn = |e| eprintln!("[capture] stream error: {e}");

    macro_rules! build {
        ($t:ty, $conv:expr) => {{
            let ring = ring.clone();
            let ov = ov.clone();
            let run = run.clone();
            let mut acc = std::mem::take(&mut acc);
            device.build_input_stream(
                &config,
                move |data: &[$t], _: &cpal::InputCallbackInfo| {
                    if !run.load(Ordering::Relaxed) {
                        return;
                    }
                    let f: fn($t) -> f32 = $conv;
                    // 多声道取第一声道
                    let step = channels as usize;
                    let mut i = 0;
                    while i < data.len() {
                        acc.push(f(data[i]));
                        i += step;
                    }
                    // 攒够一帧就推
                    let mut guard = ring.lock().unwrap();
                    while acc.len() >= frame_samples {
                        let frame: Vec<f32> = acc.drain(..frame_samples).collect();
                        let wrote = guard.push(&frame);
                        if wrote < frame_samples {
                            ov.fetch_add(1, Ordering::Relaxed);
                        }
                    }
                },
                err_fn,
                None,
            )?
        }};
    }

    let stream = match sample_format {
        SampleFormat::F32 => build!(f32, |x| x),
        SampleFormat::I16 => build!(i16, |x| x as f32 / 32768.0),
        SampleFormat::U16 => build!(u16, |x| (x as f32 - 32768.0) / 32768.0),
        SampleFormat::I32 => build!(i32, |x| x as f32 / 2147483648.0),
        SampleFormat::U8 => build!(u8, |x| (x as f32 - 128.0) / 128.0),
        other => bail!("不支持的采样格式: {other:?}"),
    };

    stream.play().context("启动采集流")?;

    Ok(Capture {
        _stream: stream,
        device_name: name,
        sample_rate: SR,
        channels,
        overruns,
        running,
    })
}
