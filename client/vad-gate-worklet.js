// VAD 语音门 · AudioWorklet 版
//
// 为什么必须搬到这里：
//   原来的门控跑在主线程的 setTimeout(tick, 20) 自循环里。
//   setTimeout 只保证"最早 20 ms"，主线程被游戏渲染/物理/解码占满时整体顺延。
//   实测（latdiag/tick_drift.html，真 Chromium）：
//       主线程每 tick 被占 0 ms   -> tick 间隔 21 ms
//       被占 40 ms               -> 61 ms
//       被占 80 ms               -> 101 ms
//       被占 150 ms              -> 171 ms
//   规律是 tick 间隔 = 主线程占用 + 20 ms，直接等于"开口到门控开启"的延迟。
//
//   AudioWorkletProcessor 的 process() 由音频线程按 128 样本硬实时驱动
//   （48 kHz 下 2.67 ms/次），音频线程在 Chromium 里是 real-time priority，
//   游戏抢不走。OOPZ 靠 Agora 原生 SDK 的音频线程天然获得这个性质，这里复刻。
//
// 输出：每 ~10 ms 通过 port 报一次 {open, db, hold}，主线程只负责同步 sender。
// 状态机（阈值 / 保持）与原来的 Mic.tick 语义完全一致，只是换了线程。

class VadGateProcessor extends AudioWorkletProcessor {
  constructor(opt) {
    super();
    const o = (opt && opt.processorOptions) || {};
    this.thrDb = o.thrDb == null ? -42 : +o.thrDb;      // 触发阈值 dBFS
    this.holdMs = o.holdMs == null ? 240 : +o.holdMs;   // 句尾保持
    this.hopMs = o.hopMs == null ? 10 : +o.hopMs;       // 上报周期
    this.bypass = !!o.bypass;                          // 按键说话时恒开

    // 以样本为单位累计，不依赖任何 wall clock —— 音频线程的样本计数是最稳的时基
    this.hopSamples = Math.round(sampleRate * this.hopMs / 1000);
    this.holdSamples = Math.round(sampleRate * this.holdMs / 1000);
    this.acc = 0;
    this.sumSq = 0;
    this.n = 0;
    this.holdLeft = 0;
    this.open = false;
    this.peakDb = -100;
    this.lastPost = 0;

    this.port.onmessage = (e) => {
      const m = e.data || {};
      if (m.type === 'cfg') {
        if (m.thrDb != null) this.thrDb = +m.thrDb;
        if (m.holdMs != null) this.holdMs = +m.holdMs;
        if (m.bypass != null) this.bypass = !!m.bypass;
        this.holdSamples = Math.round(sampleRate * this.holdMs / 1000);
      } else if (m.type === 'reset') {
        this.holdLeft = 0; this.open = false; this.acc = 0; this.sumSq = 0; this.n = 0;
      }
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return true;

    // 累加本块的平方和（音频线程里算，主线程零负担）
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      this.sumSq += s * s;
    }
    this.n += ch.length;
    this.acc += ch.length;

    // 每 hop（默认 10 ms）评估一次
    while (this.acc >= this.hopSamples) {
      const take = this.hopSamples;
      this.acc -= take;

      // 本 hop 的 RMS → dBFS
      const rms = Math.sqrt(this.sumSq / Math.max(1, this.n));
      const db = 20 * Math.log10(rms + 1e-9);
      this.sumSq = 0;
      this.n = 0;

      if (this.bypass) {
        this.open = true;
        this.holdLeft = this.holdSamples;
      } else if (db > this.thrDb) {
        this.open = true;
        this.holdLeft = this.holdSamples;
      } else if (this.holdLeft > 0) {
        this.holdLeft -= take;         // 按样本扣，不受任何调度影响
        this.open = true;
      } else {
        this.open = false;
      }

      if (db > this.peakDb) this.peakDb = db;

      // 只在状态翻转或斜率明显时上报，省 postMessage
      if (this.open !== this.lastPost) {
        this.lastPost = this.open;
        this.port.postMessage({ type: 'gate', open: this.open, db, hold: this.holdLeft });
      }
    }
    // 定期报一次电平给 UI（音频线程→主线程，1 Hz 足够）
    if (!this._tick) this._tick = 0;
    if (++this._tick % 100 === 0) {
      this.port.postMessage({ type: 'level', db: this.peakDb });
      this.peakDb = -100;
    }

    return true;   // 常驻，不停
  }
}

registerProcessor('vad-gate', VadGateProcessor);
