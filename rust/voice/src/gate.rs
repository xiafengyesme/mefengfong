//! 语音门（Volume Gate）—— 对标 TS3 的「语音检测 / Volume Gate」
//!
//! 原理：不说话时完全不发送 RTP。这比"抑制键盘声"这类后处理彻底得多：
//! 没有上行数据，对方就不可能听到。
//!
//! 参数参考 TS3 实测配置：`voiceactivation_level = -20 dB`，我们默认 -42 dB（更保守）。

/// 门状态
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum GateState {
    /// 静音（不发送）
    Mute,
    /// 发声
    Talk,
    /// 旁路（始终发送）
    Bypass,
}

pub struct Gate {
    /// 触发阈值（dBFS）
    pub threshold_db: f32,
    /// 开启后保持时间（ms），防止字间停顿被切断
    pub hold_ms: u32,
    /// 是否启用
    pub enabled: bool,
    /// 当前状态
    state: GateState,
    /// 剩余保持帧数
    hold_frames: u32,
    /// 每帧毫秒数
    frame_ms: u32,
}

impl Default for Gate {
    fn default() -> Self {
        Self {
            threshold_db: -42.0,
            hold_ms: 220,
            enabled: true,
            state: GateState::Mute,
            hold_frames: 0,
            frame_ms: 10,
        }
    }
}

impl Gate {
    pub fn new(threshold_db: f32, hold_ms: u32) -> Self {
        Self {
            threshold_db,
            hold_ms,
            ..Default::default()
        }
    }

    /// 计算一帧的 RMS（dBFS）
    pub fn frame_db(frame: &[f32]) -> f32 {
        if frame.is_empty() {
            return -100.0;
        }
        let mut sum = 0.0f64;
        for &s in frame {
            sum += (s as f64) * (s as f64);
        }
        let rms = (sum / frame.len() as f64).sqrt() as f32;
        20.0 * (rms + 1e-9).log10()
    }

    /// 每帧调用，返回本帧是否应该发送
    pub fn update(&mut self, frame: &[f32]) -> bool {
        if !self.enabled {
            self.state = GateState::Bypass;
            return true;
        }
        let db = Self::frame_db(frame);
        let hold_max = (self.hold_ms / self.frame_ms).max(1);

        if db > self.threshold_db {
            self.hold_frames = hold_max;
            self.state = GateState::Talk;
            true
        } else if self.hold_frames > 0 {
            self.hold_frames -= 1;
            self.state = GateState::Talk;
            true
        } else {
            self.state = GateState::Mute;
            false
        }
    }

    pub fn state(&self) -> GateState {
        self.state
    }

    /// 当前帧电平（用于 UI 电平表）
    pub fn level_db(frame: &[f32]) -> f32 {
        Self::frame_db(frame)
    }
}
