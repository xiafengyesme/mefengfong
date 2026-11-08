//! 无锁环形缓冲，解耦音频设备时钟与处理时钟

use ringbuf::traits::{Consumer, Observer, Producer, Split};
use ringbuf::{HeapCons, HeapProd, HeapRb};

pub struct Ring {
    prod: HeapProd<f32>,
    cons: HeapCons<f32>,
}

impl Ring {
    pub fn new(capacity: usize) -> Self {
        let rb = HeapRb::<f32>::new(capacity);
        let (prod, cons) = rb.split();
        Self { prod, cons }
    }

    /// 采集回调里调用：写入样本，满了就丢（宁可丢也不阻塞音频线程）
    pub fn push(&mut self, data: &[f32]) -> usize {
        self.prod.push_slice(data)
    }

    /// 处理线程调用：取一帧，不够返回 false
    pub fn pop_frame(&mut self, out: &mut [f32]) -> bool {
        if self.cons.occupied_len() < out.len() {
            return false;
        }
        self.cons.pop_slice(out) == out.len()
    }

    pub fn len(&self) -> usize {
        self.cons.occupied_len()
    }

    pub fn is_empty(&self) -> bool {
        self.cons.occupied_len() == 0
    }

    /// 可用空间（用于监测溢出）
    pub fn free(&self) -> usize {
        self.prod.vacant_len()
    }
}
