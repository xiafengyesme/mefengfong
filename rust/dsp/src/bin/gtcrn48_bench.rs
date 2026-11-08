//! GTCRN-Light-48k 原生基准：验证正确性 + 测 RTF/内存
use fong_dsp::gtcrn48::{GtcrnLight48, HOP};
use std::time::Instant;

fn read_wav(p: &str) -> Vec<f32> {
    let mut r = hound::WavReader::open(p).unwrap();
    let s = r.spec();
    match s.sample_format {
        hound::SampleFormat::Int => r.samples::<i16>().map(|q| q.unwrap() as f32 / 32768.0).collect(),
        hound::SampleFormat::Float => r.samples::<f32>().map(|q| q.unwrap()).collect(),
    }
}
fn write_wav(p: &str, x: &[f32]) {
    let spec = hound::WavSpec { channels: 1, sample_rate: 48000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(p, spec).unwrap();
    for &v in x { w.write_sample((v.clamp(-1.0,1.0)*32767.0) as i16).unwrap(); }
    w.finalize().unwrap();
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let onnx = &a[1];
    let inp = &a[2];
    let outp = &a[3];
    let dylib = std::env::var("ORT_DYLIB_PATH").ok();

    let x = read_wav(inp);
    let mut d = GtcrnLight48::new(onnx, dylib.as_deref()).expect("init");

    // 预热
    let mut warm = vec![0.0f32; HOP];
    let mut wo = vec![0.0f32; HOP];
    for _ in 0..10 { let _ = d.process_frame(&warm, &mut wo); }
    d.reset();

    let n = x.len() / HOP * HOP;
    let mut y = vec![0.0f32; n];
    let frames = n / HOP;
    let t0 = Instant::now();
    for f in 0..frames {
        let s = f * HOP;
        let _ = d.process_frame(&x[s..s+HOP], &mut y[s..s+HOP]);
    }
    let dt = t0.elapsed();
    write_wav(outp, &y);

    let dur = n as f64 / 48000.0;
    println!("frames {frames}  wall {:.1}ms  RTF {:.4}", dt.as_secs_f64()*1000.0, dt.as_secs_f64()/dur);
    println!("per-frame {:.1} us   算法延迟 {:.1} ms", dt.as_secs_f64()*1e6/frames as f64,
             d.latency_samples() as f64/48.0);
    let mut diff=0.0f64; let mut en=0.0f64;
    for i in 0..n { let e=(x[i]-y[i]) as f64; diff+=e*e; en+=(x[i] as f64).powi(2); }
    println!("diff/in {:.3}", (diff/en).sqrt());
}
