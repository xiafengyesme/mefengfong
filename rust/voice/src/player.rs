//! 播放（抖动缓冲 + WASAPI 输出）
//!
//! 抖动缓冲设计：
//!   - 目标深度 60 ms（可配）
//!   - 用固定容量环形缓冲，播放线程按设备时钟取
//!   - 缓冲空了就补静音（不断流，避免爆音）

use anyhow::{bail, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{SampleFormat, Stream, StreamConfig};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use crate::SR;

pub struct Player {
    _stream: Stream,
    pub device_name: String,
    pub underruns: Arc<AtomicU64>,
    pub running: Arc<AtomicBool>,
}

/// 列出输出设备
pub fn list_output_devices() -> Result<Vec<String>> {
    let host = cpal::default_host();
    let mut out = Vec::new();
    for d in host.output_devices().context("枚举输出设备")? {
        if let Ok(n) = d.name() {
            out.push(n);
        }
    }
    Ok(out)
}

/// 打开播放。`buf` 是抖动缓冲，由网络线程写入，播放线程读取。
pub fn open(
    device_name: Option<&str>,
    buf: Arc<Mutex<Vec<f32>>>,
    target_depth: usize,
) -> Result<Player> {
    let host = cpal::default_host();

    let device = match device_name {
        Some(want) => {
            let mut found = None;
            for d in host.output_devices()? {
                if let Ok(n) = d.name() {
                    if n == want {
                        found = Some(d);
                        break;
                    }
                }
            }
            found.with_context(|| format!("找不到输出设备: {want}"))?
        }
        None => host.default_output_device().context("没有默认输出设备")?,
    };
    let name = device.name().unwrap_or_else(|_| "unknown".into());

    let mut chosen: Option<cpal::SupportedStreamConfig> = None;
    for cfg in device.supported_output_configs()? {
        let r = cfg.min_sample_rate().0..=cfg.max_sample_rate().0;
        if r.contains(&SR) {
            chosen = Some(cfg.with_sample_rate(cpal::SampleRate(SR)));
            break;
        }
    }
    let cfg = match chosen {
        Some(c) => c,
        None => bail!("设备「{name}」不支持 48000 Hz 输出"),
    };

    let sample_format = cfg.sample_format();
    let ch = cfg.channels();
    let config: StreamConfig = cfg.into();

    let underruns = Arc::new(AtomicU64::new(0));
    let running = Arc::new(AtomicBool::new(true));
    let ur = underruns.clone();
    let run = running.clone();

    let err_fn = |e| eprintln!("[player] stream error: {e}");

    macro_rules! build {
        ($t:ty, $conv:expr) => {{
            let buf = buf.clone();
            let ur = ur.clone();
            let run = run.clone();
            let target = target_depth;
            device.build_output_stream(
                &config,
                move |data: &mut [$t], _: &cpal::OutputCallbackInfo| {
                    let conv: fn(f32) -> $t = $conv;
                    let mut b = buf.lock().unwrap();
                    let step = ch as usize;
                    for out in data.chunks_mut(step) {
                        let s = if b.len() >= target.min(1) {
                            b.remove(0)
                        } else {
                            ur.fetch_add(1, Ordering::Relaxed);
                            0.0
                        };
                        for o in out.iter_mut() {
                            *o = conv(s);
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
        SampleFormat::I16 => build!(i16, |x| (x.clamp(-1.0, 1.0) * 32767.0) as i16),
        SampleFormat::U16 => build!(u16, |x| ((x.clamp(-1.0, 1.0) * 32767.0) + 32768.0) as u16),
        SampleFormat::U8 => build!(u8, |x| ((x.clamp(-1.0, 1.0) * 127.0) + 128.0) as u8),
        other => bail!("不支持的输出格式: {other:?}"),
    };

    stream.play().context("启动播放流")?;

    Ok(Player {
        _stream: stream,
        device_name: name,
        underruns,
        running: run,
    })
}
