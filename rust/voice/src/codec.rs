//! Opus 编解码（纯 Rust `opus1`，无 C 依赖）
//!
//! 参数对标 TS3 + 实测结论：
//!   - 应用模式 Voip
//!   - 96 kbps CBR
//!   - 10 ms 帧（480 samples @ 48 kHz）
//!   - FEC 开，DTX 关，单声道

use anyhow::{bail, Result};
use opus1::{Application, Bitrate, Channels, InbandFec, OpusDecoder, OpusEncoder, SampleRate};
use std::num::NonZeroU32;

use crate::{FRAME, OPUS_BITRATE, SR};

pub struct OpusCodec {
    enc: OpusEncoder,
    dec: OpusDecoder,
    enc_buf: Vec<u8>,
    frame_size: usize,
}

impl OpusCodec {
    pub fn new() -> Result<Self> {
        let rate = if SR == 48000 {
            SampleRate::Hz48000
        } else {
            bail!("只支持 48 kHz，收到 {SR}")
        };

        let mut enc = OpusEncoder::new(rate, Channels::Mono, Application::Voip)
            .map_err(|e| anyhow::anyhow!("opus encoder: {e:?}"))?;

        if let Some(bps) = NonZeroU32::new(OPUS_BITRATE as u32) {
            enc.set_bitrate(Bitrate::BitsPerSecond(bps));
        }
        enc.set_vbr(false);
        enc.set_inband_fec(InbandFec::On);
        enc.set_packet_loss_perc(10);
        enc.set_dtx(false);

        let dec = OpusDecoder::new(rate, Channels::Mono)
            .map_err(|e| anyhow::anyhow!("opus decoder: {e:?}"))?;

        Ok(Self {
            enc,
            dec,
            enc_buf: vec![0u8; 1500],
            frame_size: FRAME,
        })
    }

    /// 编码一帧 f32 单声道 → Opus 包
    pub fn encode(&mut self, pcm: &[f32]) -> Result<Vec<u8>> {
        if pcm.len() != self.frame_size {
            bail!("帧长必须是 {}，收到 {}", self.frame_size, pcm.len());
        }
        let n = self
            .enc
            .encode(pcm, self.frame_size, &mut self.enc_buf)
            .map_err(|e| anyhow::anyhow!("encode: {e:?}"))?;
        Ok(self.enc_buf[..n].to_vec())
    }

    /// 解码一个 Opus 包 → f32 单声道
    pub fn decode(&mut self, packet: &[u8]) -> Result<Vec<f32>> {
        let mut out = vec![0.0f32; FRAME];
        let n = self
            .dec
            .decode(packet, FRAME, &mut out)
            .map_err(|e| anyhow::anyhow!("decode: {e:?}"))?;
        out.truncate(n);
        Ok(out)
    }

    /// 丢包时生成 PLC，避免爆音
    pub fn decode_plc(&mut self) -> Vec<f32> {
        let mut out = vec![0.0f32; FRAME];
        let _ = self.dec.decode(&[], FRAME, &mut out);
        out
    }

    pub fn frame_size(&self) -> usize {
        self.frame_size
    }
}
