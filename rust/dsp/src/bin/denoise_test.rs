//! 降噪 + 啸叫抑制 + 瞬态抑制 端到端测试
use std::time::Instant;

fn read_wav(p: &str) -> (Vec<f32>, u32) {
    let mut r = hound::WavReader::open(p).expect("open");
    let spec = r.spec();
    let x: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => r.samples::<i16>().map(|s| s.unwrap() as f32 / 32768.0).collect(),
        hound::SampleFormat::Float => r.samples::<f32>().map(|s| s.unwrap()).collect(),
    };
    (x, spec.sample_rate)
}

fn write_wav(p: &str, x: &[f32]) {
    let spec = hound::WavSpec { channels: 1, sample_rate: 48000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
    let mut w = hound::WavWriter::create(p, spec).unwrap();
    for &v in x { w.write_sample((v.clamp(-1.0, 1.0) * 32767.0) as i16).unwrap(); }
    w.finalize().unwrap();
}

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let mode = a.get(1).map(|s| s.as_str()).unwrap_or("all");
    let inp = a.get(2).expect("input wav");
    let outp = a.get(3).expect("output wav");

    let (x, sr) = read_wav(inp);
    assert_eq!(sr, 48000);
    let n = x.len();

    // ---- 啸叫抑制：需要频谱，用 1024 点 STFT ----
    const NFFT: usize = 1024;
    const HOP: usize = 480; // 10ms
    let nbin = NFFT / 2 + 1;
    let bin_hz = 48000.0 / NFFT as f32;

    let mut howl = fong_dsp::howl::HowlSuppressor::new(nbin, 48000.0);
    let mut trans = fong_dsp::transient::TransientSuppressor::new(
        nbin, fong_dsp::transient::TransientConfig::default());

    // 简易 STFT/ISTFT（仅供测试，生产用 realfft）
    let win: Vec<f32> = (0..NFFT).map(|i| {
        0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / NFFT as f32).cos()
    }).collect();

    let want_howl = mode == "howl" || mode == "all";
    let want_trans = mode == "trans" || mode == "all";
    howl.set_enabled(want_howl);
    trans.enabled = want_trans;

    let mut out = x.clone();
    let mut ana_mem = vec![0.0f32; NFFT - HOP]; // 544 = 1024-480
    let mut syn_mem = vec![0.0f32; NFFT - HOP];
    let mut gains: Vec<f32> = Vec::new();
    let mut howl_hits = 0usize;

    let t0 = Instant::now();
    let frames = (n.saturating_sub(HOP)) / HOP;
    for f in 0..frames {
        let s = f * HOP;
        let seg: Vec<f32> = if s + HOP <= n { x[s..s + HOP].to_vec() } else { break };

        // 分析
        let mut buf = vec![0.0f32; NFFT];
        buf[..NFFT - HOP].copy_from_slice(&ana_mem);
        buf[NFFT - HOP..].copy_from_slice(&seg);
        for i in 0..NFFT { buf[i] *= win[i]; }
        // 滑动窗口：保留最后 (NFFT-HOP) 个样本
        let keep = NFFT - HOP;
        let mut newmem = Vec::with_capacity(keep);
        newmem.extend_from_slice(&ana_mem[HOP.min(keep)..]);
        let need = keep - newmem.len();
        newmem.extend_from_slice(&seg[seg.len().saturating_sub(need)..]);
        while newmem.len() < keep { newmem.insert(0, 0.0); }
        ana_mem.copy_from_slice(&newmem);

        // 朴素 DFT（测试用，慢但正确）
        let mut mag = vec![0.0f32; nbin];
        {
            let mut re = vec![0.0f32; NFFT];
            let mut im = vec![0.0f32; NFFT];
            dft(&buf, &mut re, &mut im);
            for i in 0..nbin {
                mag[i] = (re[i] * re[i] + im[i] * im[i]).sqrt();
            }
        }

        // 检测
        let hits = howl.detect(&mag);
        if !hits.is_empty() { howl_hits += 1; }
        let g = trans.process(&mag, false, bin_hz);
        gains.push(g);

        // 合成：只做增益 + 陷波（不动频谱结构）
        let mut y = seg.clone();
        for v in y.iter_mut() { *v *= g; }
        howl.apply(&mut y);

        for i in 0..HOP {
            out[s + i] = y[i];
        }
    }
    let dt = t0.elapsed();

    write_wav(outp, &out);

    let dt_frames = gains.len();
    println!("=== {} ===", mode);
    println!("  帧数 {dt_frames}  墙钟 {:.1}ms  RTF {:.4}  (含朴素 DFT，仅测试用)",
             dt.as_secs_f64() * 1000.0,
             dt.as_secs_f64() / (dt_frames as f64 * HOP as f64 / 48000.0));
    if want_howl {
        println!("  啸叫: 检测事件 {} 次, 当前生效陷波 {} 个, 频点 {:?}",
                 howl.howl_events, howl.active_count(),
                 howl.detected_hz.iter().map(|f| format!("{f:.0}")).collect::<Vec<_>>());
    }
    if want_trans {
        println!("  瞬态: 抑制 {}/{} 帧 ({:.1}%)",
                 trans.suppressed_frames, trans.total_frames,
                 100.0 * trans.suppressed_frames as f64 / trans.total_frames.max(1) as f64);
    }
    println!("  -> {outp}");
}

fn dft(x: &[f32], re: &mut [f32], im: &mut [f32]) {
    let n = x.len();
    for k in 0..n {
        let mut sr = 0.0f64;
        let mut si = 0.0f64;
        let w = -2.0 * std::f64::consts::PI * k as f64 / n as f64;
        for i in 0..n {
            let a = w * i as f64;
            sr += x[i] as f64 * a.cos();
            si += x[i] as f64 * a.sin();
        }
        re[k] = sr as f32;
        im[k] = si as f32;
    }
}
