//! 两种延迟模式的音质对比
use fong_dsp::lowlatency::{LatencyMode, LowLatencyDenoiser};
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
    let dylib = std::env::var("ORT_DYLIB_PATH").ok();
    let x = read_wav(inp);

    let which = a.get(3).map(|s| s.as_str()).unwrap_or("standard");
    let mode = if which == "lowlatency" { LatencyMode::LowLatency } else { LatencyMode::Standard };
    let mut d = LowLatencyDenoiser::new(onnx, dylib.as_deref(), mode).unwrap();
    d.set_wet(0.7);
    let t = Instant::now();
    let y = d.process(&x);
    let dt = t.elapsed();
    let outp = format!("H:/fongmuisc/work/out/compare/mode_{}.wav", which);
    write_wav(&outp, &y);
    println!("{:12} 延迟 {:>5.1}ms  RTF {:.4}  帧 {}  输出 {}",
             which, d.latency_ms(), dt.as_secs_f64()/(x.len() as f64/48000.0),
             d.frames_processed(), y.len());
}
