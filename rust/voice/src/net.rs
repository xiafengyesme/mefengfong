//! WebRTC 会话（webrtc-rs，纯 Rust）
//!
//! 协议必须与服务端一致（见 docs/FONG产品需求文档.md 第 5 章）：
//!   1. 客户端先发 offer（带 sendrecv 音频 m-line）
//!   2. 服务端回 answer
//!   3. 后续重协商由服务端通过 SSE 推 offer，客户端回 answer

use anyhow::{bail, Context, Result};
use serde::Deserialize;
use std::sync::Arc;
use tokio::sync::mpsc;
use webrtc::api::interceptor_registry::register_default_interceptors;
use webrtc::api::media_engine::{MediaEngine, MIME_TYPE_OPUS};
use webrtc::api::APIBuilder;
use webrtc::ice_transport::ice_server::RTCIceServer;
use webrtc::interceptor::registry::Registry;
use webrtc::peer_connection::configuration::RTCConfiguration;
use webrtc::peer_connection::peer_connection_state::RTCPeerConnectionState;
use webrtc::peer_connection::sdp::session_description::RTCSessionDescription;
use webrtc::rtp_transceiver::rtp_codec::{
    RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType,
};
use webrtc::track::track_local::track_local_static_rtp::TrackLocalStaticRTP;
use webrtc::track::track_local::TrackLocal;

use crate::OPUS_BITRATE;

#[derive(Deserialize)]
struct Answer {
    #[serde(rename = "type")]
    typ: String,
    sdp: String,
}

#[derive(Deserialize)]
struct OfferMsg {
    #[serde(rename = "type")]
    typ: String,
    sdp: String,
}

pub struct VoiceSession {
    pub pc: Arc<webrtc::peer_connection::RTCPeerConnection>,
    pub audio_track: Arc<TrackLocalStaticRTP>,
    /// 收到的远端音频（解码后的 f32）
    pub remote_rx: mpsc::Receiver<Vec<f32>>,
    pub base_url: String,
    pub room: String,
    pub peer_id: String,
}

impl VoiceSession {
    pub async fn connect(base_url: &str, room: &str, peer_id: &str) -> Result<Self> {
        // 1) MediaEngine：只注册 Opus，48 kHz 单声道
        let mut m = MediaEngine::default();
        m.register_codec(
            RTCRtpCodecParameters {
                capability: RTCRtpCodecCapability {
                    mime_type: MIME_TYPE_OPUS.to_owned(),
                    clock_rate: 48000,
                    channels: 1,
                    sdp_fmtp_line: format!(
                        "minptime=10;useinbandfec=1;usedtx=0;stereo=0;sprop-stereo=0;maxaveragebitrate={OPUS_BITRATE}"
                    ),
                    rtcp_feedback: vec![],
                },
                payload_type: 111,
                ..Default::default()
            },
            RTPCodecType::Audio,
        )?;

        let mut registry = Registry::new();
        registry = register_default_interceptors(registry, &mut m)?;

        let api = APIBuilder::new()
            .with_media_engine(m)
            .with_interceptor_registry(registry)
            .build();

        let cfg = RTCConfiguration {
            ice_servers: vec![RTCIceServer {
                urls: vec!["stun:stun.l.google.com:19302".to_owned()],
                ..Default::default()
            }],
            ..Default::default()
        };

        let pc = Arc::new(api.new_peer_connection(cfg).await?);

        pc.on_peer_connection_state_change(Box::new(|s: RTCPeerConnectionState| {
            println!("[pc] state: {s}");
            Box::pin(async {})
        }));

        // 2) 创建本地音频 track
        let track = Arc::new(TrackLocalStaticRTP::new(
            RTCRtpCodecCapability {
                mime_type: MIME_TYPE_OPUS.to_owned(),
                clock_rate: 48000,
                channels: 1,
                sdp_fmtp_line: String::new(),
                rtcp_feedback: vec![],
            },
            "audio".to_owned(),
            peer_id.to_owned(),
        ));

        let rtp_sender = pc
            .add_track(track.clone() as Arc<dyn TrackLocal + Send + Sync>)
            .await?;

        // 读 RTCP（必须，否则不会发 report）
        tokio::spawn(async move {
            let mut buf = vec![0u8; 1500];
            while rtp_sender.read(&mut buf).await.is_ok() {}
        });

        // 3) 远端 track
        let (tx, rx) = mpsc::channel::<Vec<f32>>(64);
        let tx = Arc::new(tx);
        pc.on_track(Box::new(move |track, _receiver, _transceiver| {
            let tx = tx.clone();
            Box::pin(async move {
                tokio::spawn(async move {
                    let mut codec = match crate::codec::OpusCodec::new() {
                        Ok(c) => c,
                        Err(e) => {
                            eprintln!("[remote] codec init: {e}");
                            return;
                        }
                    };
                    let mut buf = vec![0u8; 1500];
                    while let Ok((packet, _)) = track.read_rtp().await {
                        match codec.decode(&packet.payload) {
                            Ok(pcm) => {
                                if tx.send(pcm).await.is_err() {
                                    break;
                                }
                            }
                            Err(e) => eprintln!("[remote] decode: {e}"),
                        }
                    }
                });
            })
        }));

        // 4) 发 offer
        let offer = pc.create_offer(None).await?;
        let mut gather = pc.gathering_complete_promise().await;
        pc.set_local_description(offer).await?;
        let _ = gather.recv().await;

        let local = pc.local_description().await.context("no local desc")?;

        // 5) POST /signal
        let client = reqwest::Client::new();
        let body = serde_json::json!({
            "room": room,
            "peer": peer_id,
            "type": "offer",
            "sdp": local.sdp,
        });
        let resp = client
            .post(format!("{base_url}/signal"))
            .json(&body)
            .send()
            .await
            .context("POST /signal")?;

        if !resp.status().is_success() {
            bail!("服务端拒绝: {} {}", resp.status(), resp.text().await?);
        }
        let ans: Answer = resp.json().await.context("解析 answer")?;
        if ans.typ != "answer" || ans.sdp.is_empty() {
            bail!("answer 无效: type={}", ans.typ);
        }

        pc.set_remote_description(RTCSessionDescription::answer(ans.sdp)?)
            .await?;

        Ok(Self {
            pc,
            audio_track: track,
            remote_rx: rx,
            base_url: base_url.to_owned(),
            room: room.to_owned(),
            peer_id: peer_id.to_owned(),
        })
    }

    /// 拆出一个可独立 spawn 的监听任务（只持有 pc + 房间信息）
    pub fn listen_task(&self) -> tokio::task::JoinHandle<Result<()>> {
        let pc = self.pc.clone();
        let base = self.base_url.clone();
        let room = self.room.clone();
        let peer = self.peer_id.clone();
        tokio::spawn(async move { listen_events_inner(pc, base, room, peer).await })
    }
}

/// SSE 监听：服务端推 offer → 客户端回 answer
async fn listen_events_inner(
    pc: Arc<webrtc::peer_connection::RTCPeerConnection>,
    base_url: String,
    room: String,
    peer_id: String,
) -> Result<()> {
    let url = format!(
        "{}/events?room={}&peer={}",
        base_url,
        urlencoding::encode(&room),
        urlencoding::encode(&peer_id)
    );
    let client = reqwest::Client::new();
    let mut resp = client.get(&url).send().await?;
    let mut buf = String::new();

    while let Some(chunk) = resp.chunk().await? {
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(idx) = buf.find("

") {
            let event = buf[..idx].to_string();
            buf = buf[idx + 2..].to_string();
            if let Some(data) = event.strip_prefix("data: ") {
                if let Ok(msg) = serde_json::from_str::<OfferMsg>(data) {
                    if msg.typ == "offer" {
                        handle_offer(&pc, &base_url, &room, &peer_id, msg.sdp).await?;
                    }
                }
            }
        }
    }
    Ok(())
}

async fn handle_offer(
    pc: &Arc<webrtc::peer_connection::RTCPeerConnection>,
    base_url: &str,
    room: &str,
    peer_id: &str,
    sdp: String,
) -> Result<()> {
    pc.set_remote_description(RTCSessionDescription::offer(sdp)?)
        .await?;
    let answer = pc.create_answer(None).await?;
    let mut gather = pc.gathering_complete_promise().await;
    pc.set_local_description(answer).await?;
    let _ = gather.recv().await;
    let local = pc.local_description().await.context("no local")?;

    let client = reqwest::Client::new();
    client
        .post(format!("{base_url}/answer"))
        .json(&serde_json::json!({
            "room": room,
            "peer": peer_id,
            "type": "answer",
            "sdp": local.sdp,
        }))
        .send()
        .await?;
    println!("[pc] renegotiated");
    Ok(())
}
