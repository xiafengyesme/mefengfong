/**
 * FONG · AEC 参考信号采集 worklet
 *
 * 作用：把「远端混音」（= 即将从扬声器出来的声音）按 10 ms 帧写进一条 SAB 环，
 * 交给 denoise-worker 里的 AEC3 当 far-end 参考。
 *
 * ── 为什么要有这一条链 ──
 * 播放走 `<audio>` 元素（0.4.19 的修复），渲染器拿不到 PCM。所以在 Mic.actx 内
 * **并行**建一条：每条远端轨 → MediaStreamAudioSourceNode → 音量增益 → 这里的 worklet。
 * 它与播放链并行，不串在发送通路上 —— far 迟到只影响回声抑制质量，不影响通话延迟。
 *
 * ── 为什么输出要接零增益 ──
 * AudioWorkletNode 的输出若没有下游，Chromium 不会拉取它（同一个坑在本项目出现过三次：
 * analyser 不接 destination 时读数恒 0）。所以这里在 renderer 侧接 gain(0) → destination。
 *
 * 环布局（SAB）：
 *   [0, CTRL_N*4)              ctrl：Int32，槽 0 = 写索引（单调递增）
 *   [CTRL_N*4, ...)            FAR_SLOTS 个槽，每槽 BLOCK 个 f32
 */
const BLOCK = 480;        // 48 kHz / 10 ms，与 GTCRN 的 HOP、AEC3 的帧长一致
const FAR_SLOTS = 16;     // 160 ms 容量：足够吸收调度抖动，又不会积压出延迟
const CTRL_N = 8;
const C_WRITE = 0;

class AecRefProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opt = (options && options.processorOptions) || {};
    this.sab = opt.sab || null;
    this.ctrl = null;
    this.slots = null;
    if (this.sab) {
      try {
        this.ctrl = new Int32Array(this.sab, 0, CTRL_N);
        this.slots = [];
        for (let i = 0; i < FAR_SLOTS; i++) {
          this.slots.push(new Float32Array(this.sab, CTRL_N * 4 + i * BLOCK * 4, BLOCK));
        }
      } catch (_) {
        this.sab = null;
        this.ctrl = null;
        this.slots = null;
      }
    }
    this.acc = new Float32Array(BLOCK);
    this.accLen = 0;
    this.frames = 0;
    // 【0.4.45】多路远端轨求和会超过 ±1（独立审查实测：0.4 + 0.4 = 0.81，16 人房更甚）。
    // 注意：不能用 1/N 归一化 —— WebAudio 把多路源加成单声道，inp.length 恒为 1（那是声道数），
    // 而且**参考电平必须与扬声器实际出声一致**：播放侧同样是直接相加、不归一化，
    // 参考一归一化就会去相关，AEC 的预测反而全错。
    // 正确做法：按 DAC 的行为削顶（播放出来是什么样，参考就是什么样）。
  }

  process(inputs) {
    const inp = inputs[0];
    if (!this.sab || !inp || inp.length === 0) return true;
    const ch0 = inp[0];
    if (!ch0) return true;
    const n = ch0.length;
    const nch = inp.length;

    for (let i = 0; i < n; i++) {
      let v;
      if (nch === 1) {
        v = ch0[i];
      } else {
        v = 0;
        for (let c = 0; c < nch; c++) {
          const a = inp[c];
          if (a) v += a[i];
        }
        v /= nch;
      }
      // 与输出设备一致：超界就削（大部分时间不触发，只在多人大音量时生效）
      this.acc[this.accLen++] = v > 1 ? 1 : (v < -1 ? -1 : v);
      if (this.accLen >= BLOCK) {
        // 写索引只增不减；worker 侧用「落后太多就跳到最新」的方式追帧
        const w = Atomics.load(this.ctrl, C_WRITE);
        this.slots[w % FAR_SLOTS].set(this.acc);
        Atomics.store(this.ctrl, C_WRITE, w + 1);
        Atomics.notify(this.ctrl, C_WRITE);
        this.accLen = 0;
        this.frames++;
      }
    }
    return true;
  }
}

registerProcessor('aec-ref', AecRefProcessor);
