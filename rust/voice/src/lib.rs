//! FONG 原生语音引擎
//!
//! 完整链路（不走浏览器）：
//!
//! ```text
//! WASAPI 采集 48k f32 单声道
//!     ↓
//! 环形缓冲（解耦设备时钟与处理时钟）
//!     ↓
//! 帧化 10 ms（480 samples）—— Opus 原生帧长
//!     ↓
//! 语音门（Volume Gate）—— 静音不发 RTP
//!     ↓
//! GTCRN 降噪（wet=0.7，内部 16k 支路，延迟 16 ms）
//!     ↓
//! Opus 编码（VoIP 模式，96 kbps CBR，FEC，无 DTX）
//!     ↓
//! WebRTC PeerConnection（webrtc-rs，纯 Rust）
//!     ↓
//! 远端帧 → Opus 解码 → 抖动缓冲 → WASAPI 播放
//! ```
//!
//! 与浏览器方案的区别：
//!   - 无 WebRTC APM 的黑盒 AEC（那个 RES 会制造"混响感"）
//!   - 无 44.1k↔48k 隐藏重采样（不是 48k 设备直接拒绝）
//!   - 延迟可控：Opus 10 ms 帧 + 16 ms 降噪 + 抖动缓冲可配

pub mod capture;
pub mod codec;
pub mod gate;
pub mod net;
pub mod player;
pub mod ring;

pub use gate::Gate;
pub use net::VoiceSession;

/// 采采率（全程 48 kHz）
pub const SR: u32 = 48_000;
/// 处理帧长（10 ms，Opus 原生帧）
pub const FRAME: usize = 480;
/// GTCRN 帧长（16 ms，768 samples）
pub const GTCRN_FRAME: usize = 768;
/// 帧长比例
pub const GTCRN_RATIO: usize = GTCRN_FRAME / FRAME; // 2

/// 默认 Opus 码率
pub const OPUS_BITRATE: i32 = 96_000;
/// 默认抖动缓冲深度（ms）
pub const JITTER_BUFFER_MS: u32 = 60;
