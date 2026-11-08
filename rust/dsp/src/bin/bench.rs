use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let onnx = args.get(1).map(|s| s.as_str())
        .unwrap_or(r"H:\fongmuisc\work\gtcrn\gtcrn-main\stream\onnx_models\gtcrn.onnx");
    let wav = args.get(2).map(|s| s.as_str())
        .unwrap_or(r"H:\fongmuisc\fong\samples\noisy48_10db.wav");
    let out_path = args.get(3).map(|s| s.as_str())
        .unwrap_or(r"H:\fongmuisc\work\out\rust_gtcrn.wav");
    let dylib = std::env::var("ORT_DYLIB_PATH").ok();

    let mut reader = hound::WavReader::open(wav).expect("open wav");
    let spec = reader.spec();
    assert_eq!(spec.sample_rate, 48000, "need 48k");
    let mut x: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => reader
            .samples::<i16>()
            .map(|s| s.unwrap() as f32 / 32768.0)
            .collect(),
        hound::SampleFormat::Float => reader.samples::<f32>().map(|s| s.unwrap()).collect(),
    };
    if spec.channels > 1 {
        x = x.chunks(spec.channels as usize).map(|c| c[0]).collect();
    }

    let mut d = fong_dsp::Denoiser::new(onnx, dylib.as_deref()).expect("init denoiser");
    d.wet = fong_dsp::DEFAULT_WET;

    let hop = fong_dsp::HOP48;
    let n = x.len() / hop * hop;
    let mut y = vec![0.0f32; n];
    let frames = n / hop;

    // 预热（ONNX session 首次推理有额外开销）
    for i in 0..20 {
        let s = i * hop;
        d.process_frame(&x[s..s + hop], &mut y[s..s + hop]).expect("warmup");
    }
    d.reset();

    let t0 = Instant::now();
    for i in 0..frames {
        let s = i * hop;
        d.process_frame(&x[s..s + hop], &mut y[s..s + hop]).expect("process");
    }
    let dt = t0.elapsed();
    let total_us = dt.as_secs_f64() * 1e6 / frames as f64;
    println!("  拆分: ONNX {:.0}us  FIR {:.0}us  FFT+其他 {:.0}us  (合计 {:.0}us)",
             d.last_onnx_us, d.last_fir_us, d.last_fft_us, total_us);

    // 比对差异（确认真的在处理）
    let mut diff = 0.0f64;
    let mut energy = 0.0f64;
    for i in 0..n {
        let e = (x[i] - y[i]) as f64;
        diff += e * e;
        energy += (x[i] as f64) * (x[i] as f64);
    }

    let wspec = hound::WavSpec { channels: 1, sample_rate: 48000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(out_path, wspec).expect("create wav");
    for &v in &y {
        w.write_sample((v.clamp(-1.0, 1.0) * 32767.0) as i16).unwrap();
    }
    w.finalize().unwrap();

    let dur = n as f32 / 48000.0;
    println!("frames {frames}  wall {:.1}ms  RTF {:.4}", dt.as_secs_f64() * 1000.0,
             dt.as_secs_f64() / dur as f64);
    println!("per-frame {:.1} us", dt.as_secs_f64() * 1e6 / frames as f64);
    println!("diff/in {:.3}", (diff / energy).sqrt());
    println!("-> {out_path}");
}
