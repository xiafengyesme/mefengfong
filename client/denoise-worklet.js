/**
 * FONG 降噪 AudioWorklet
 *
 * ── worker 模式（默认，正常路径）──
 *   攒满 480 样本 → 写入输入环（若还有空位）→ 原子递增 inWrite → notify(0)
 *   Worker 阻塞在 inWrite 上 → native 处理 → 写输出环 → 递增 outWrite
 *   本类在音频线程里只做无锁读写，阻塞、不发消息、不分配。
 *
 * ── 为什么必须用环形缓冲（实测教训）──
 * 早先版本是「单块输入 + 序号互斥」：worklet 要等 Worker 处理完才能写下一块。
 * 只要 Worker 慢一拍，输入块就被丢（实测 144 块丢 69 块 = 48%），
 * 丢掉的是时间轴，输出端随即饿死 —— 那就是爆音。
 * 换成 4 槽输入环 + 3 槽输出环后，生产者不再等待消费者，抖动被环吸收。
 *
 * ── 为什么必须垫启动余量（prime）──
 * 一块音频要攒 10 ms 才凑齐，处理再花 1.6 ms，天然迟到 11.6 ms。
 * 播放若立刻从第 0 个样本开始，前 11.6 ms 无数据可放。
 * 所以输出侧先吐静音，等到第一个处理块就绪再开始播 ——
 * 只付一次 11.6 ms 的启动静音，换取全程不断流。
 *
 * ── 安全闸 ──
 * Worker 若死了（模型缺失、ORT 冲突），输出会永久饿死 → 一片爆音。
 * 连续饿 120 ms 就永久直通：未降噪的原始音频，永远好过爆音。
 */
const BLOCK = 480;
const QUANTUM = 128;

// 环容量：输入 16 槽（160 ms）、输出 12 槽（120 ms）。
// 容量只决定"最多能积压多少"，实际延迟由下面的 PREFILL 决定。
const IN_SLOTS = 16;
const OUT_SLOTS = 12;

// 播放起始预填：等输出环里攒够 6 块（60 ms）才开始播。
// 这就是抗抖动余量 —— 实测重载下 Worker 会被 CPU 争抢停顿约 20 ms，
// 4 块足够吸收，且把总延迟锁死在确定值（不是"最多 120 ms"）。
// 代价是一次性的 40 ms 启动静音；换来全程零断流。
const PREFILL = 3;
// 直通→处理后的交叉淡化长度（样本）。480 样本 = 10 ms 的一半块。
const XFADE = 240;

const IN_OFF = 0;                                  // 字节
const OUT_OFF = IN_SLOTS * BLOCK * 4;              // 字节
const CTRL_OFF = OUT_OFF + OUT_SLOTS * BLOCK * 4;  // 字节
const CTRL_N = 24;   // 【0.4.73】扩到 24：20 号槽是诊断用饥饿注入，index 0..23

// ctrl 槽位（与 denoise-worker.js 严格对应）
const C_IN_W = 0, C_IN_R = 1, C_OUT_W = 2, C_OUT_R = 3, C_STATE = 4, C_READY = 16;
// 【0.4.61】19 号槽 = reset 请求位。原来复位只靠 port.postMessage，
// 而重建时新 worklet 的 onmessage 还没挂上就发了消息 → 丢失 → 计数器不归零
// （实测连切 7 次后 underruns 累积到 24384）。改成 SAB 状态位，worklet 每帧自检，不依赖消息时序。
const C_REQ_RESET = 19;
// 【诊断】20 号槽 = 饥饿注入开关（1 = 强制走饥饿分支）。
// 只用于验证"饥饿时的输出行为"——没有它就无法确认电流声修复是否真的生效
// （实测用 CPU 抢占/改 SAB 指针都饿不到，因为 worker 会立刻覆盖写指针）。
const C_DIAG_STARVE = 20;

const STALL_LIMIT = Math.round(48000 * 0.12);   // 120 ms
// 【0.4.55】旁路后多久尝试恢复（500 ms）。太短会在真卡顿时反复横跳，
// 太长则用户明显感觉「降噪没了」。500 ms 是主观测试里"察觉不到但足够脱离瞬时卡顿"的点。
const RECOVER_SAMPLES = Math.round(48000 * 0.5);

class FongDenoiseProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const opt = (options && options.processorOptions) || {};
    this.enabled = opt.enabled !== false;
    // renderer 可以下发 prefill 覆盖常量（调参/未来 A/B 用）。
    // 缺省走文件常量，保证"只放 worklet 也能对"。
    this.prefill = (opt.prefill == null) ? PREFILL : (opt.prefill | 0);
    this.diag = !!opt.diag;
    this.external = !!opt.external;
    this.mode = 'postmessage';

    // postmessage 兜底
    this.outQueue = [];
    this.outCursor = 0;
    this.inflight = 0;
    this.maxInflight = 3;

    this.acc = new Float32Array(BLOCK);
    // 【0.4.73】饥饿时循环播放的"最近一块真实输出"。
    // 用循环而不是衰减到零：衰减会产生 10ms 周期增益调制（= 用户听到的电流抖动声）。
    this.holdBuf = new Float32Array(BLOCK);   // 正在填的一块
    this.playBuf = new Float32Array(BLOCK);   // 已确认完整的上一块（饥饿时循环它）
    this.holdPos = 0;
    this.holdFill = 0;
    this.hasPlayBuf = false;
    this.accLen = 0;
    this.totalBlocks = 0;
    this.dropped = 0;
    this.underruns = 0;

    // 欠载软着陆
    this.last = 0;
    this.fade = 0;
    // 预热期直通 → 处理后的交叉淡化状态
    this.pre = 0;
    this.xf = 0;

    // 安全闸
    this.stall = 0;
    this.bypass = false;
    this.bypassReason = null;
    this.gotFirst = false;
    // 启动等待上限：预填 4 块 + 模型冷启动，正常 300~700 ms 完成。
    // 超过 2 s 还没开始播，说明 Worker 根本没起来（模型缺失、ORT 冲突），
    // 此时永久直通 —— 否则用户面对的是一片死寂而不是语音。
    this.waitSamples = 0;
    // 【0.4.25】20 秒：packaged 版实测 worker 的 native/ORT 冷启动可以超过 2 秒，
    // 2 秒就永久 bypass 会让降噪一次都不生效（有声音、没降噪，用户看不出来）。
    this.WAIT_LIMIT = 48000 * 60;   // 60 s：worker 由应用启动阶段预热，这里只做兜底

    // SAB 视图
    this.sab = opt.sab || null;
    this.ctrl = null;
    this.inSlots = null;
    this.outSlots = null;
    this.outRead = 0;
    this.outCursorBlk = 0;
    this.inWrite = 0;

    if (this.sab) {
      try {
        this.ctrl = new Int32Array(this.sab, CTRL_OFF, CTRL_N);
        this.inSlots = [];
        for (let i = 0; i < IN_SLOTS; i++) {
          this.inSlots.push(new Float32Array(this.sab, IN_OFF + i * BLOCK * 4, BLOCK));
        }
        this.outSlots = [];
        for (let i = 0; i < OUT_SLOTS; i++) {
          this.outSlots.push(new Float32Array(this.sab, OUT_OFF + i * BLOCK * 4, BLOCK));
        }
        this.outRead = Atomics.load(this.ctrl, C_OUT_R);
        this.inWrite = Atomics.load(this.ctrl, C_IN_W);
        this.mode = 'sab';
      } catch (e) {
        this.mode = 'postmessage';
        this.sab = null;
        this.ctrl = null;
      }
    }

    this.port.onmessage = (e) => {
      const m = e.data;
      if (!m) return;
      if (m.type === 'block') {
        this.outQueue.push(m.pcm);
        if (this.inflight > 0) this.inflight--;
      } else if (m.type === 'enabled') {
        this.setEnabled(!!m.value);
      } else if (m.type === 'external') {
        this.external = !!m.value;
      } else if (m.type === 'reset') {
        this.resetState();
      }
    };
  }

  resetState() {
    this.outQueue.length = 0; this.outCursor = 0;
    this.accLen = 0; this.inflight = 0;
    this.last = 0; this.fade = 0; this.stall = 0;
    this.pre = 0; this.xf = 0;
    this.gotFirst = false;
    this.outCursorBlk = 0;
    if (this.ctrl) {
      this.outRead = Atomics.load(this.ctrl, C_OUT_R);
      this.inWrite = Atomics.load(this.ctrl, C_IN_W);
    }
  }

  /**
   * 【0.4.62】只清统计，不动播放状态。
   * 上一版我把统计清零塞进 resetState()，而 resetState 会清 gotFirst/inflight ——
   * 在播放中途调用等于人为制造欠载：实测 underruns 反而涨到 24896、db 掉到 -55.6。
   * 「清计数」和「清播放状态」是两件事，必须分开。
   */
  resetStats() {
    this.underruns = 0;
    this.dropped = 0;
    this.totalBlocks = 0;
    this.bypassAge = 0;
  }

  setEnabled(on) {
    this.enabled = on;
    this.outQueue.length = 0; this.outCursor = 0;
    this.accLen = 0; this.inflight = 0;
    this.last = 0; this.fade = 0; this.stall = 0;
    this.pre = 0; this.xf = 0;
    this.bypass = false;
    this.gotFirst = false;
    this.outCursorBlk = 0;
    if (this.ctrl) {
      this.outRead = Atomics.load(this.ctrl, C_OUT_R);
      this.inWrite = Atomics.load(this.ctrl, C_IN_W);
    }
  }

  diagIfDue() {
    this.callCount = (this.callCount || 0) + 1;
    if (this.diag && this.callCount % 200 === 0) {
      this.port.postMessage({
        type: 'diag', mode: this.mode, external: this.external,
        calls: this.callCount, sent: this.totalBlocks,
        dropped: this.dropped, underruns: this.underruns,
        bypass: this.bypass, qlen: this.outQueue.length,
      });
    }
  }

  /** 把一块输入推进输入环。环满就丢（宁可错位，不可覆写正在处理的块）。 */
  pushInput() {
    // 模型还没就绪：这段音频根本不会播（gotFirst 之前输出是静音），
    // 直接丢，不计入 dropped —— 否则启动瞬间会误报一次时间轴跳变。
    if (!this.gotFirst && !Atomics.load(this.ctrl, C_READY)) return false;
    const w = this.inWrite;
    const r = Atomics.load(this.ctrl, C_IN_R);
    if (w - r >= IN_SLOTS) {
      this.dropped++;
      return false;
    }
    this.inSlots[w % IN_SLOTS].set(this.acc);
    this.inWrite = w + 1;
    Atomics.store(this.ctrl, C_IN_W, this.inWrite);
    Atomics.notify(this.ctrl, C_IN_W);
    this.totalBlocks++;
    return true;
  }

  process(inputs, outputs) {
    this.diagIfDue();

    // SAB 复位请求：不看消息，只看槽位，重建后也一定能收到
    if (this.ctrl && Atomics.load(this.ctrl, C_REQ_RESET) === 1) {
      Atomics.store(this.ctrl, C_REQ_RESET, 0);
      this.resetStats();          // 只清计数，不动播放状态
    }

    // 【0.4.25】可恢复的旁路：原来是「等不到 worker 就永久直通」，
    // 于是 worker 冷启动慢一点，整场通话就再没有降噪（实测 sent:0 / bypass:true /
    // ctrl READY=1 同时在，就是这个状态）。现在 worker 一旦就绪就解除 no-worker 旁路、
    // 重新走一次预热。stall 旁的（真饿死）不动，由 stall 闸自己管。
    if (this.bypass && this.bypassReason === 'no-worker' && this.ctrl && Atomics.load(this.ctrl, C_READY) === 1) {
      this.bypass = false;
      this.bypassReason = null;
      this.gotFirst = false;
      this.waitSamples = 0;
      this.stall = 0;
      this.outCursorBlk = 0;
      this.outRead = Atomics.load(this.ctrl, C_OUT_R);
      this.inWrite = Atomics.load(this.ctrl, C_IN_W);
      this.outQueue.length = 0; this.outCursor = 0;
      try { this.port.postMessage({ type: 'bypass', reason: 'resumed' }); } catch (_) { /* ignore */ }
    }

    const output = outputs[0];
    const input = inputs[0];
    if (!output || output.length === 0) return true;
    const outCh = output[0];
    const n = outCh.length;
    const inCh = input && input[0] ? input[0] : null;

    // 关闭档 / 安全闸跳闸：直通，不攒块，零延迟零空洞
    if (!this.enabled || this.bypass) {
      if (inCh) outCh.set(inCh.subarray(0, n));
      else outCh.fill(0);
      this.accLen = 0;
      this.last = 0;
      this.fade = 0;
      this.stall = 0;
      this.acc.fill(0);
      this.pre = 0; this.xf = 0;
      // 【0.4.56】旁路期间保持 gotFirst：否则解除旁路后要重新预填 3 块（30 ms），
      // 那 30 ms 全是欠载 —— 实测切档瞬间 underruns 冲到 12704，主观就是"卡一下"。
      // 只要输出环里还有存量，就让它继续当预填余量。
      if (this.mode === 'sab' && this.ctrl) {
        try {
          const ow2 = Atomics.load(this.ctrl, C_OUT_W);
          if (ow2 - this.outRead >= this.prefill) {
            this.gotFirst = true;
            this.outCursorBlk = 0;
          }
        } catch (_) {}
      }
      // 【0.4.55 · 死锁修复】旁路期间必须把 outRead 追到 outWrite（丢弃积压）。
      // 否则：旁路 → 不读输出 → 环里积压越来越多 → worker 的
      //   `if (outWrite - C_OUT_R >= OUT_SLOTS) { 丢输入; return; }`
      // 永久成立 → worker 再也不产出 → outWrite 冻死 → 即使解除旁路也救不回来。
      // 实测死锁现场：[inW=500, inR=500, outW=940(冻), outR=499]，underruns 6784、
      // bypass 恒 true，这就是用户说的「切档后彻底没声」「低占用好像没启用」。
      if (this.mode === 'sab' && this.ctrl) {
        try {
          const ow = Atomics.load(this.ctrl, C_OUT_W);
          if (ow !== this.outRead) {
            this.outRead = ow;
            Atomics.store(this.ctrl, C_OUT_R, ow);
            Atomics.notify(this.ctrl, C_OUT_R);
          }
        } catch (_) { /* 环不可用时忽略 */ }
      }
      // 旁路可恢复：环境恢复正常后重新尝试进入降噪。
      // 原来只有 no-worker 一种能自愈，stall 旁路一旦触发就是永久直通 ——
      // 用户看到的「降噪没启用」就是这么来的。
      this.bypassAge = (this.bypassAge || 0) + n;
      if (this.bypassAge > RECOVER_SAMPLES && this.ctrl && Atomics.load(this.ctrl, C_READY) === 1) {
        this.bypass = false;
        this.bypassReason = null;
        this.bypassAge = 0;
        this.gotFirst = false;
        this.waitSamples = 0;
        this.stall = 0;
        this.outCursorBlk = 0;
        this.outRead = Atomics.load(this.ctrl, C_OUT_R);
        this.inWrite = Atomics.load(this.ctrl, C_IN_W);
        try { this.port.postMessage({ type: 'bypass', reason: 'recovered' }); } catch (_) {}
      }
      return true;
    }
    this.bypassAge = 0;

    const useSab = this.mode === 'sab';
    const outWriteNow = useSab ? Atomics.load(this.ctrl, C_OUT_W) : 0;
    const inReadNow = useSab ? Atomics.load(this.ctrl, C_IN_R) : 0;

    for (let i = 0; i < n; i++) {
      // ---------- 1) 取输出 ----------
      if (useSab) {
        // 起始预填：输出环攒够 PREFILL 块才切到"处理后的信号"。
        // 这一段同时是抗抖动余量（环里有存量，Worker 停顿一下不会饿死）。
        if (!this.gotFirst) {
          if (outWriteNow - this.outRead >= this.prefill) {
            this.gotFirst = true; this.outCursorBlk = 0;
            this.xf = XFADE;            // 直通 → 处理后，做一次短交叉淡化
          }
        }
        if (!this.gotFirst) {
          // 预热期直通，不吐静音。
          // 实测：Worker 冷启动 700 ms 时，吐静音会让进房第一句话整段消失
          // （输出静音 821 ms）；直通后同一场景 20 ms 就出声。
          // 代价只是这几十毫秒没降噪 —— 远好过"说话别人听不见"。
          outCh[i] = inCh ? inCh[i] : 0;
          this.pre = outCh[i];
          if (++this.waitSamples > this.WAIT_LIMIT) {
            this.bypass = true;
            this.bypassReason = 'no-worker';
            try { this.port.postMessage({ type: 'bypass', reason: 'no-worker' }); } catch (_) { /* ignore */ }
          }
        } else {
          if (this.outCursorBlk >= BLOCK) {
            this.outCursorBlk = 0;
            this.outRead++;
            Atomics.store(this.ctrl, C_OUT_R, this.outRead);
          }
          const forceStarve = this.ctrl && Atomics.load(this.ctrl, C_DIAG_STARVE) === 1;
          if (!forceStarve && this.outRead < outWriteNow) {
            const v = this.outSlots[this.outRead % OUT_SLOTS][this.outCursorBlk++];
            // 直通 → 处理后的一次交叉淡化：两段信号的相位/延迟不同，
            // 硬切会有可闻的"咔"（0.5 块 ~ 交叉淡化实测无咔哒）。
            if (this.xf > 0) {
              const w2 = this.xf / XFADE;
              outCh[i] = v * (1 - w2) + this.pre * w2;
              this.pre = outCh[i];
              this.xf--;
            } else {
              outCh[i] = v;
            }
            this.last = outCh[i];
            // 【0.4.74】恢复正常输出时把循环相位归零。
            // 否则下次饥饿会从上次中断的随机位置继续播 playBuf，
            // 波形在块边界处跳变 —— 累积成"开久了偶尔咔一下"。
            if (this.stall > 0) this.holdPos = 0;
            this.stall = 0;
            this.fade = 0;
            // 【0.4.73】把这一块的真实输出存起来，饥饿时循环它（见上面的说明）
            if (this.holdFill < BLOCK) {
              this.holdBuf[this.holdFill] = outCh[i];
              this.holdFill++;
              // 一块填满 → 转成可循环播放的完整块（双缓冲，避免读到正在覆盖的数据）
              if (this.holdFill === BLOCK) { this.playBuf.set(this.holdBuf); this.hasPlayBuf = true; this.holdFill = 0; }
            }
          } else {
            // 【0.4.73 · "电流抖动麦"的根因修复】
            // 原来：饿住时 this.last *= 0.7071 每样本执行，且 fade 只在进入时设一次 32。
            //   32 样本后幅度 = 0.7071^32 ≈ 1.5e-5（基本归零），但乘法继续跑。
            //   饥饿每块都可能重新触发 → fade 重置 → 形成 10ms 周期的增益调制。
            //   听感就是"电流抖动 / 颤音"，而且 CPU 越紧越频繁。
            //
            // 现在：从"衰减到零"改成"保持最近一块的真实波形循环播放"。
            //   · 保持幅度和频谱（不产生调制，不会有电流声）
            //   · 保持时长有上限（HOLD_MAX），超过就转旁路，不会永久糊住
            this.underruns++;
            this.stall++;
            // 用上一块真实输出的最后一个 BLOCK 循环填充：幅度/波形连续，无调制
            if (this.hasPlayBuf) {
              outCh[i] = this.playBuf[this.holdPos];
              this.holdPos = (this.holdPos + 1) % BLOCK;
            } else {
              outCh[i] = this.last;   // 还没攒够一整块：保持恒定值（不是归零）
            }
            if (this.stall > STALL_LIMIT) {
              this.bypass = true;
              this.bypassReason = 'stall';
              try { this.port.postMessage({ type: 'bypass', reason: 'stall' }); } catch (_) { /* ignore */ }
            }
          }
        }
      } else if (this.outQueue.length && this.outCursor < this.outQueue[0].length) {
        outCh[i] = this.outQueue[0][this.outCursor++];
        if (this.outCursor >= this.outQueue[0].length) {
          this.outQueue.shift();
          this.outCursor = 0;
        }
      } else {
        // 【0.4.73】第二处饥饿分支：同样改为循环最近一块真实波形。
        // 原来这里也是 this.last *= 0.7071（衰减到零）→ 10ms 周期调制 → 电流声。
        this.underruns++;
        if (this.hasPlayBuf) {
          outCh[i] = this.playBuf[this.holdPos];
          this.holdPos = (this.holdPos + 1) % BLOCK;
        } else {
          outCh[i] = this.last;
        }
        // 【0.4.74】标记"这一轮呼吸道过饥饿"，供下面复位 holdPos
        this._starved = true;
      }

      if (this.bypass) outCh[i] = inCh ? inCh[i] : 0;

      // ---------- 2) 攒输入 ----------
      this.acc[this.accLen++] = inCh ? inCh[i] : 0;
      if (this.accLen >= BLOCK) {
        this.accLen = 0;
        // 【0.4.74】一块结束：如果这轮饿过，把循环相位归零，下轮从波形起点开始
        if (this._starved) { this.holdPos = 0; this._starved = false; }
        if (useSab) {
          this.pushInput();
        } else if (this.inflight < this.maxInflight) {
          this.inflight++;
          this.totalBlocks++;
          const block = this.acc;
          this.acc = new Float32Array(BLOCK);
          this.port.postMessage({ type: 'block', pcm: block }, [block.buffer]);
        } else {
          this.dropped++;
        }
      }
    }

    // inRead 在本 quantum 里没变过，可直接复用（避免每样本一次原子读）
    if (useSab && inReadNow !== Atomics.load(this.ctrl, C_IN_R)) {
      // 环的读游标一般只在 Worker 侧前进；这里保留一致性检查，不做额外动作
    }

    return true;
  }
}

registerProcessor('fong-denoise', FongDenoiseProcessor);
