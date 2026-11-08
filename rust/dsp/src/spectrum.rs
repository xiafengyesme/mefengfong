//! 共享的 FFT 频谱分析器
//!
//! 啸叫检测和瞬态检测都需要幅度谱。最初两者各自用朴素 DFT（O(N²)），
//! 实测每 10ms 块要 5.5ms —— 占满 81% 的 CPU，完全不可接受。
//! 改用 realfft（O(N log N)）后降到几十微秒。
//!
//! 设计：一个实例维护自己的窗和缓冲，可被复用；每个检测器各持一个。

use realfft::RealFftPlanner;
use std::sync::Arc;

pub struct SpectrumAnalyzer {
    nfft: usize,
    nbin: usize,
    fwd: Arc<dyn realfft::RealToComplex<f32>>,
    win: Vec<f32>,
    buf: Vec<f32>,
    out: Vec<realfft::num_complex::Complex32>,
    scratch: Vec<realfft::num_complex::Complex32>,
    /// 上帧幅度谱（供瞬态检测算谱通量）
    prev_mag: Vec<f32>,
}

impl SpectrumAnalyzer {
    pub fn new(nfft: usize) -> Self {
        let mut p = RealFftPlanner::<f32>::new();
        let fwd = p.plan_fft_forward(nfft);
        let win: Vec<f32> = (0..nfft)
            .map(|i| 0.5 - 0.5 * (2.0 * std::f32::consts::PI * i as f32 / nfft as f32).cos())
            .collect();
        let out = fwd.make_output_vec();
        let scratch = fwd.make_scratch_vec();
        Self {
            nfft,
            nbin: nfft / 2 + 1,
            fwd,
            win,
            buf: vec![0.0; nfft],
            out,
            scratch,
            prev_mag: vec![0.0; nfft / 2 + 1],
        }
    }

    pub fn nbin(&self) -> usize {
        self.nbin
    }

    pub fn bin_hz(&self, sr: f32) -> f32 {
        sr / self.nfft as f32
    }

    /// 对 `input` 做加窗 FFT，返回幅度谱（长度 = nbin）
    ///
    /// `input` 可短于 nfft，不足部分补零。
    pub fn magnitude(&mut self, input: &[f32]) -> &[f32] {
        let n = input.len().min(self.nfft);
        for i in 0..n {
            self.buf[i] = input[i] * self.win[i];
        }
        for i in n..self.nfft {
            self.buf[i] = 0.0;
        }
        // 幅度存入 prev_mag 复用（调用方用完即走，下一帧覆盖）
        if self
            .fwd
            .process_with_scratch(&mut self.buf, &mut self.out, &mut self.scratch)
            .is_ok()
        {
            for i in 0..self.nbin {
                let c = self.out[i];
                self.prev_mag[i] = (c.re * c.re + c.im * c.im).sqrt();
            }
        }
        &self.prev_mag
    }

    pub fn reset(&mut self) {
        self.prev_mag.iter_mut().for_each(|x| *x = 0.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peak_at_right_bin() {
        let sr = 48000.0f32;
        let nfft = 1024;
        let mut a = SpectrumAnalyzer::new(nfft);
        let freq = 3000.0;
        let sig: Vec<f32> = (0..nfft)
            .map(|i| (2.0 * std::f32::consts::PI * freq * i as f32 / sr).sin())
            .collect();
        let mag = a.magnitude(&sig);
        let mut best = 0;
        for i in 1..mag.len() - 1 {
            if mag[i] > mag[best] {
                best = i;
            }
        }
        let got = best as f32 * sr / nfft as f32;
        assert!((got - freq).abs() < sr / nfft as f32 * 1.5, "峰值 {got} Hz");
    }
}
