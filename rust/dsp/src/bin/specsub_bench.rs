//! 谱减 + 高通链的离线基准 / 参数扫描
//!
//! 与 gtcrn48_bench 的区别：这条链不依赖 ONNX / onnxruntime，
//! 纯 CPU 算术，所以扫描几百组参数也不慢。
//!
//! 用法：
//!   specsub_bench run  in.wav out.wav [alpha=1.6 beta=0.06 ...]
//!   specsub_bench grid in.wav outdir            # 内置网格，批量落盘
//!
//! 参数键与 SpecSubConfig 一一对应，未给的用 Default。

use fong_dsp::specsub::{SpecSubConfig, SpectralSubtractor, HOP};
use std::time::Instant;

fn read_wav(p: &str) -> Vec<f32> {
    let mut r = hound::WavReader::open(p).expect("open wav");
    match r.spec().sample_format {
        hound::SampleFormat::Int => r.samples::<i16>().map(|q| q.unwrap() as f32 / 32768.0).collect(),
        hound::SampleFormat::Float => r.samples::<f32>().map(|q| q.unwrap()).collect(),
    }
}

fn write_wav(p: &str, x: &[f32]) {
    let spec = hound::WavSpec {
        channels: 1,
        sample_rate: 48000,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut w = hound::WavWriter::create(p, spec).expect("create wav");
    for &v in x {
        w.write_sample((v.clamp(-1.0, 1.0) * 32767.0) as i16).unwrap();
    }
    w.finalize().unwrap();
}

fn parse_cfg(args: &[String]) -> SpecSubConfig {
    let mut c = SpecSubConfig::default();
    for a in args {
        let Some((k, v)) = a.split_once('=') else { continue };
        let Ok(f) = v.parse::<f32>() else { continue };
        match k {
            "alpha" => c.alpha = f,
            "beta" => c.beta = f,
            "dd" => c.dd = f,
            "nsmooth" => c.n_smooth = f,
            "nbias" => c.n_bias = f,
            "floor" => c.gain_floor_db = f,
            "maxatt" => c.max_att_db = f,
            "vaddb" => c.vad_db = f,
            "alphasil" => c.alpha_silence = f,
            "floorsil" => c.floor_silence_db = f,
            "vadhold" => c.vad_hold = v.parse().unwrap_or(c.vad_hold),
            "pnon" => c.protect_on_speech = v.parse::<f32>().unwrap_or(1.0) > 0.5,
            "lohz" => c.protect_lo_hz = f,
            "hihz" => c.protect_hi_hz = f,
            "hp" => c.hp_hz = f,
            "minwin" => c.min_window = v.parse().unwrap_or(c.min_window),
            _ => {}
        }
    }
    c
}

fn run(cfg: SpecSubConfig, x: &[f32], y: &mut [f32]) -> (f64, usize) {
    let mut s = SpectralSubtractor::new(cfg);
    let frames = x.len() / HOP;
    let t0 = Instant::now();
    for f in 0..frames {
        let o = f * HOP;
        s.process_frame(&x[o..o + HOP], &mut y[o..o + HOP]);
    }
    let dt = t0.elapsed().as_secs_f64();
    // 尾巴直通，保证长度一致
    let tail = frames * HOP;
    if tail < x.len() {
        y[tail..].copy_from_slice(&x[tail..]);
    }
    let rtf = dt / (x.len() as f64 / 48000.0);
    (rtf, frames)
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mode = a.get(1).map(|s| s.as_str()).unwrap_or("run");

    if mode == "grid" {
        let inp = a.get(2).expect("input");
        let outdir = a.get(3).expect("outdir");
        std::fs::create_dir_all(outdir).ok();
        let x = read_wav(inp);
        let mut y = vec![0.0f32; x.len()];
        // 网格：α × 保护带 × β
        for alpha in [1.0, 1.3, 1.6, 2.0, 2.5f32] {
            for maxatt in [6.0, 9.0, 12.0, 16.0f32] {
                for beta in [0.03, 0.06, 0.12f32] {
                    let mut c = SpecSubConfig::default();
                    c.alpha = alpha;
                    c.max_att_db = maxatt;
                    c.beta = beta;
                    let (rtf, _) = run(c.clone(), &x, &mut y);
                    let name = format!("{outdir}/a{}_p{}_b{}.wav", (alpha * 10.0) as i32,
                                       (maxatt * 10.0) as i32, (beta * 100.0) as i32);
                    write_wav(&name, &y);
                    println!("{name}  rtf={rtf:.5}");
                }
            }
        }
        return;
    }

    let inp = a.get(2).expect("input wav");
    let outp = a.get(3).expect("output wav");
    let rest: Vec<String> = a.iter().skip(4).cloned().collect();
    let cfg = parse_cfg(&rest);

    let x = read_wav(inp);
    let mut y = vec![0.0f32; x.len()];
    let (rtf, frames) = run(cfg.clone(), &x, &mut y);
    write_wav(outp, &y);
    println!(
        "frames {frames}  rtf {rtf:.5}  ({:.2}% of one core)  延迟 {:.1} ms",
        rtf * 100.0,
        HOP as f64 / 48.0 * (1024.0 / 960.0)
    );
    println!("cfg {cfg:?}");
}
