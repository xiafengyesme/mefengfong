//! 低延迟 GTCRN 封装
//!
//! 核心问题：GTCRN 内部是 16 ms 帧（nfft=512, hop=256 @16kHz），
//! 且 ONNX 导出固定 S=1，无法一次喂多帧（已实测验证）。
//!
//! 两种延迟模式：
//!
//! 【Standard】总计 32 ms
//!   每 768 samples 处理一次，输出"上一块"的结果。
//!   优点：输出时间轴严格对齐，无边缘伪影
//!
//! 【LowLatency】总计 16 ms
//!   每 768 samples 处理一次，立即输出本块。
//!   代价：STFT 窗口末尾一帧信息不完整，有轻微边缘伪影
//!
//! 为什么不能更短：GTCRN 的 257 bins 绑定 nfft=512，
//! 缩短帧长必须重训（ERB 滤波器组与 GRU 状态尺寸都绑在 257 上）。

use crate::Denoiser;

#[derive(Clone, Copy, Debug, PartialEq)]
pub enum LatencyMode {
    /// 输出延迟 1 帧（32 ms 总计）—— 无边缘伪影
    Standard,
    /// 输出延迟 0（16 ms 总计）—— 有轻微边缘伪影
    LowLatency,
}

impl LatencyMode {
    /// 额外算法延迟（样本 @48k）
    pub fn extra_latency_samples(self) -> usize {
        match self {
            LatencyMode::Standard => crate::HOP48,
            LatencyMode::LowLatency => 0,
        }
    }
}

pub struct LowLatencyDenoiser {
    inner: Denoiser,
    mode: LatencyMode,
    enabled: bool,
    buf: [f32; crate::HOP48],
    pos: usize,
    prev_out: [f32; crate::HOP48],
    frames: u64,
}

impl LowLatencyDenoiser {
    pub fn new(onnx: &str, ort_dylib: Option<&str>, mode: LatencyMode) -> Result<Self, String> {
        Ok(Self {
            inner: Denoiser::new(onnx, ort_dylib)?,
            mode,
            enabled: true,
            buf: [0.0; crate::HOP48],
            pos: 0,
            prev_out: [0.0; crate::HOP48],
            frames: 0,
        })
    }

    pub fn set_wet(&mut self, wet: f32) {
        self.inner.wet = wet.clamp(0.0, 1.0);
    }

    /// 旁路：关闭时直接直通，零 CPU 开销
    pub fn set_enabled(&mut self, on: bool) {
        self.enabled = on;
        if !on {
            self.pos = 0;
            self.prev_out = [0.0; crate::HOP48];
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled
    }

    /// 算法延迟（样本 @48k），供上层时间戳补偿
    pub fn latency_samples(&self) -> usize {
        self.mode.extra_latency_samples()
    }

    pub fn latency_ms(&self) -> f32 {
        self.latency_samples() as f32 / 48.0
    }

    pub fn reset(&mut self) {
        self.inner.reset();
        self.buf = [0.0; crate::HOP48];
        self.pos = 0;
        self.prev_out = [0.0; crate::HOP48];
    }

    pub fn frames_processed(&self) -> u64 {
        self.frames
    }

    /// 流式处理：输入任意长度，输出等长
    pub fn process(&mut self, input: &[f32]) -> Vec<f32> {
        if !self.enabled {
            return input.to_vec();
        }
        let mut out = Vec::with_capacity(input.len() + crate::HOP48);
        for &s in input {
            self.buf[self.pos] = s;
            self.pos += 1;
            if self.pos >= crate::HOP48 {
                self.pos = 0;
                let mut processed = [0.0f32; crate::HOP48];
                if self.inner.process_frame(&self.buf, &mut processed).is_err() {
                    // 出错时直通，绝不静音（静音比噪声更糟）
                    processed = self.buf;
                }
                match self.mode {
                    LatencyMode::Standard => {
                        out.extend_from_slice(&self.prev_out);
                        self.prev_out.copy_from_slice(&processed);
                    }
                    LatencyMode::LowLatency => {
                        out.extend_from_slice(&processed);
                    }
                }
                self.frames += 1;
            }
        }
        // 不足一块的部分原样送出（保持长度一致，上层不用处理)
        let remain = self.pos;
        if remain > 0 {
            let start = out.len().saturating_sub(remain);
            if start < out.len() {
                out.truncate(start);
            }
            out.extend_from_slice(&self.buf[..remain]);
        }
        out
    }

    /// 处理固定长度的一块（768），用于 native 模块的 C ABI
    pub fn process_block(&mut self, block: &mut [f32]) -> bool {
        if block.len() != crate::HOP48 {
            return false;
        }
        if !self.enabled {
            return true;
        }
        let mut processed = [0.0f32; crate::HOP48];
        if self.inner.process_frame(block, &mut processed).is_err() {
            return false;
        }
        match self.mode {
            LatencyMode::Standard => {
                let old = self.prev_out;
                self.prev_out = processed;
                block.copy_from_slice(&old);
            }
            LatencyMode::LowLatency => {
                block.copy_from_slice(&processed);
            }
        }
        self.frames += 1;
        true
    }
}
