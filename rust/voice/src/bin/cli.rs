//! FONG 原生语音 CLI —— 用来验证整条链路能不能跑通
//!
//! 用法：
//!   fong-voice-cli list                 # 列出设备
//!   fong-voice-cli loopback [秒数]       # 本地回环：采集→降噪→播放（不开网络）
//!   fong-voice-cli join <url> <room>    # 加入房间

use anyhow::{Context, Result};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

fn main() -> Result<()> {
    env_logger::init();
    let args: Vec<String> = std::env::args().collect();
    let cmd = args.get(1).map(|s| s.as_str()).unwrap_or("list");

    match cmd {
        "list" => list_devices(),
        "loopback" => {
            let secs: u64 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(10);
            loopback(secs)
        }
        "join" => {
            let url = args.get(2).context("需要服务端地址")?;
            let room = args.get(3).map(|s| s.as_str()).unwrap_or("test");
            tokio::runtime::Runtime::new()?.block_on(join(url, room))
        }
        other => anyhow::bail!("未知命令: {other}"),
    }
}

fn list_devices() -> Result<()> {
    println!("=== 输入设备 ===");
    for d in fong_voice::capture::list_input_devices()? {
        println!("  {d}");
    }
    println!("=== 输出设备 ===");
    for d in fong_voice::player::list_output_devices()? {
        println!("  {d}");
    }
    Ok(())
}

/// 本地回环：采集 → 降噪 → 播放。不开网络，用来验证音频链路和延迟。
fn loopback(secs: u64) -> Result<()> {
    println!("=== FONG 本地回环测试（{secs} 秒）===");

    let onnx = std::env::var("FONG_GTCRN_ONNX").unwrap_or_else(|_| {
        r"H:\fongmuisc\work\gtcrn\gtcrn-main\stream\onnx_models\gtcrn.onnx".to_string()
    });
    let ort = std::env::var("ORT_DYLIB_PATH").ok();

    println!("加载降噪模型: {onnx}");
    let mut den = fong_dsp::Denoiser::new(&onnx, ort.as_deref())
        .map_err(|e| anyhow::anyhow!("降噪初始化失败: {e}"))?;
    den.wet = fong_dsp::DEFAULT_WET;
    println!("  降噪就绪 wet={} 延迟={}ms", den.wet, fong_dsp::FRAME_DELAY * 1000 / 48000);

    let cap_ring = Arc::new(Mutex::new(fong_voice::ring::Ring::new(48000))); // 1 秒
    let play_buf = Arc::new(Mutex::new(Vec::<f32>::new()));

    let cap = fong_voice::capture::open(None, cap_ring.clone(), fong_voice::FRAME)?;
    println!("采集: {}  {} Hz {} ch", cap.device_name, cap.sample_rate, cap.channels);

    // 预热：先攒够 60 ms 再启动播放流，避免开头连续欠载
    println!("预热抖动缓冲 ...");
    let warm_target = 480 * 6; // 60 ms
    {
        // 复用同一个 den 实例（ORT 一个进程只能有一个 Environment）
        let d = &mut den;
        let mut f = vec![0.0f32; fong_voice::FRAME];
        let mut q: std::collections::VecDeque<f32> = std::collections::VecDeque::new();
        while play_buf.lock().unwrap().len() < warm_target {
            if cap_ring.lock().unwrap().pop_frame(&mut f) {
                q.extend(f.iter().copied());
                while q.len() >= fong_voice::GTCRN_FRAME {
                    let mut b = [0.0f32; fong_voice::GTCRN_FRAME];
                    for s in b.iter_mut() { *s = q.pop_front().unwrap(); }
                    let mut o = vec![0.0f32; fong_voice::GTCRN_FRAME];
                    let _ = d.process_frame(&b, &mut o);
                    play_buf.lock().unwrap().extend_from_slice(&o);
                }
            } else {
                std::thread::sleep(Duration::from_millis(2));
            }
        }
    }
    let play = fong_voice::player::open(None, play_buf.clone(), 480 * 6)?;
    println!("播放: {}", play.device_name);

    let mut gate = fong_voice::Gate::new(-45.0, 220);
    let mut frame = vec![0.0f32; fong_voice::FRAME];
    // 帧长解耦：Opus 480（10ms） vs GTCRN 768（16ms），768/480=1.6 不是整数倍，
    // 必须用队列攒，不能直接按索引填
    let mut gtcrn_acc: std::collections::VecDeque<f32> = std::collections::VecDeque::with_capacity(2048);

    let start = Instant::now();
    let mut frames = 0u64;
    let mut sent = 0u64;
    let mut last_report = Instant::now();

    while start.elapsed() < Duration::from_secs(secs) {
        // 从环形缓冲取一帧
        let got = { cap_ring.lock().unwrap().pop_frame(&mut frame) };
        if !got {
            std::thread::sleep(Duration::from_millis(2));
            continue;
        }
        frames += 1;

        // 语音门
        let pass = gate.update(&frame);
        if pass {
            sent += 1;
        }

        // 攒进队列；够 768 就处理一次，剩余留在队列里
        gtcrn_acc.extend(frame.iter().copied());
        while gtcrn_acc.len() >= fong_voice::GTCRN_FRAME {
            let mut batch = [0.0f32; fong_voice::GTCRN_FRAME];
            for slot in batch.iter_mut() {
                *slot = gtcrn_acc.pop_front().unwrap();
            }
            let mut out = vec![0.0f32; fong_voice::GTCRN_FRAME];
            let _ = den.process_frame(&batch, &mut out);
            play_buf.lock().unwrap().extend_from_slice(&out);
        }

        if last_report.elapsed() > Duration::from_secs(1) {
            let db = fong_voice::Gate::level_db(&frame);
            let ov = cap.overruns.load(Ordering::Relaxed);
            let ur = play.underruns.load(Ordering::Relaxed);
            let depth = play_buf.lock().unwrap().len();
            println!(
                "  {:.1}s  电平 {:6.1} dB  门={:?}  帧 {} 送出 {}  缓冲 {}  溢出 {}  欠载 {}",
                start.elapsed().as_secs_f64(),
                db,
                gate.state(),
                frames,
                sent,
                depth,
                ov,
                ur
            );
            last_report = Instant::now();
        }
    }

    println!("=== 完成：{} 帧，{} 送出 ===", frames, sent);
    Ok(())
}

fn rand_ssrc() -> u32 {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.subsec_nanos()).unwrap_or(0);
    n ^ 0x464F_4E47 // "FONG"
}

async fn join(url: &str, room: &str) -> Result<()> {
    let peer_id = format!("cli{}", std::process::id() % 10000);
    println!("=== 加入房间 {room} @ {url}  as {peer_id} ===");

    let sess = fong_voice::VoiceSession::connect(url, room, &peer_id).await?;
    println!("WebRTC 已连接");

    // SSE 监听放后台（需要独立持有连接参数）
    let listen_handle = sess.listen_task();
    tokio::spawn(async move {
        if let Err(e) = listen_handle.await {
            eprintln!("events: {e}");
        }
    });

    // 采集 → 编码 → 发送
    let track = sess.audio_track.clone();
    let cap_ring = Arc::new(Mutex::new(fong_voice::ring::Ring::new(48000)));
    let _cap = fong_voice::capture::open(None, cap_ring.clone(), fong_voice::FRAME)?;
    let mut codec = fong_voice::codec::OpusCodec::new()?;
    let mut frame = vec![0.0f32; fong_voice::FRAME];
    let mut seq: u16 = 0;
    let mut ts: u32 = 0;
    let ssrc: u32 = rand_ssrc();

    println!("按 Ctrl+C 退出");
    loop {
        let got = { cap_ring.lock().unwrap().pop_frame(&mut frame) };
        if !got {
            tokio::time::sleep(Duration::from_millis(2)).await;
            continue;
        }
        let payload = codec.encode(&frame)?;

        // 构造 RTP 包（10 ms 一帧 → 时间戳 +480）
        let pkt = webrtc::rtp::packet::Packet {
            header: webrtc::rtp::header::Header {
                version: 2,
                payload_type: 111,
                sequence_number: seq,
                timestamp: ts,
                ssrc,
                marker: false,
                ..Default::default()
            },
            payload: payload.into(),
        };
        seq = seq.wrapping_add(1);
        ts = ts.wrapping_add(fong_voice::FRAME as u32);

        if let Err(e) = webrtc::track::track_local::TrackLocalWriter::write_rtp(&*track, &pkt).await {
            eprintln!("[send] {e}");
        }
    }
    #[allow(unreachable_code)]
    { Ok(()) }
}
