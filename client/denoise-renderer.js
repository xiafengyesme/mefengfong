'use strict';
/**
 * FONG 降噪接入层（renderer 侧）
 *
 * ── 数据流（worker 模式，默认）──
 *   worklet 攒块 → 写入输入环 → Atomics 递增 inWrite + notify
 *     → Worker（独立线程）阻塞醒来 → native 处理 → 写输出环 → 递增 outWrite
 *     → worklet 读输出环
 *   主线程完全不参与音频路径：只负责建图、投递开关（走 SAB 命令槽）。
 *
 * ── 实测为什么必须这样 ──
 *   旧架构里 worklet 用 postMessage('newblock') 喊主线程来取块。
 *   主线程一忙（渲染、布局、长轮询回包），消息排队超过块周期 10 ms → 块被丢，
 *   输出端随即饿死补零。droptest 三档负载实测丢 25%、补零 25% —— 那就是爆音。
 *
 * ── 三条不可回退的约束 ──
 *   1. Worker 进程级常驻：ORT 的 Environment 一进程只能建一个，
 *      重建 Worker 会让第二次 new FongDenoise 直接失败。
 *      AudioContext 换了就用 attach 重绑 SAB。
 *   2. 控制面走 SAB 原子槽：Worker 的循环阻塞在 Atomics.wait 上，
 *      它的事件循环基本不转，postMessage 投过去的开关根本执行不到。
 *   3. 环容量与布局必须和 Worker 完全一致（IN_SLOTS / OUT_SLOTS / 偏移）。
 */
const Denoise = {
  // ---- 状态 ----
  ready: false,
  failed: null,
  latencyMs: 0,
  enabled: true,
  debug: false,
  stats: null,
  mode: null,        // 'worker' | 'sab' | 'postmessage'
  useSab: true,
  useWorker: true,
  worker: null,
  workerReady: false,
  workerFailed: null,
  workerDead: false,
  bypassed: null,
  pendingWorker: [],
  workerStats: null,
  pendingMode: null,

  // ---- 与 AudioContext 绑定 ----
  ctx: null,
  node: null,
  dest: null,
  src: null,
  sab: null,
  ctrl: null,

  BLOCK: 480,
  IN_SLOTS: 16,
  OUT_SLOTS: 12,
  CTRL_N: 24,   // 【0.4.73】20 号槽 = 诊断饥饿注入
  // 输出环起始预填块数。6 块 = 60 ms，3 块 = 30 ms。
  // 实测（真实 worklet）：6/3/2/1 → 起音 74/49/34/23 ms。
  // 取 3：30 ms 足够吸收 Worker 抖动，再往上就是纯延迟。
  PREFILL: 3,

  // 与 denoise-worker.js 严格一致的 ctrl 槽位
  C_IN_W: 0, C_IN_R: 1, C_OUT_W: 2, C_OUT_R: 3, C_STATE: 4, C_BEAT: 5,
  C_CMD_ENABLE: 6, C_CMD_MODE: 7, C_CMD_HOWL: 8, C_CMD_TRANS: 9, C_CMD_RESET: 10,
  C_STAT_OK: 11, C_STAT_FAIL: 12, C_STAT_DROP: 13, C_READY: 16, C_CMD_TILT: 17, C_REQ_RESET: 19,

  _b() { return window.fongBridge || window.native; },

  _dbg(m) { if (this.debug) console.log('[denoise]', m); },

  /** SAB 总字节数：输入环 + 输出环 + ctrl(16 int32) */
  _sabBytes() {
    return this.IN_SLOTS * this.BLOCK * 4 + this.OUT_SLOTS * this.BLOCK * 4 + this.CTRL_N * 4;
  },

  _ctrlOffset() {
    return this.IN_SLOTS * this.BLOCK * 4 + this.OUT_SLOTS * this.BLOCK * 4;
  },

  /**
   * 启动 Worker（进程内只启一次，长驻）。
   * 它自己 require('fong-native')，需要 nodeIntegrationInWorker；
   * 页面必须挂在 app:// 上（file:// 下 Chromium 直接禁 Worker）。
   */
  _startWorker(sab) {
    if (this.worker) {
      this._rebindWorker(sab);
      return true;
    }
    try {
      const w = new Worker(new URL('denoise-worker.js', location.href).href);
      this.worker = w;
      this.pendingWorker = [];
      this.workerReady = false;
      this.workerFailed = null;
      this.workerDead = false;

      w.onmessage = (e) => {
        const m = e.data;
        if (!m) return;
        if (m.type === 'aecState' || m.type === 'farReady') {
          try { window.__aecState = m; } catch (_) {}
        } else if (m.type === 'aecDiag') {
          try { window.__aecDiag = m; } catch (_) {}
        } else if (m.type === 'ready') {
          this.workerReady = true;
          this.latencyMs = m.latencyMs || this.latencyMs;
          this._dbg('Worker 就绪，延迟 ' + this.latencyMs.toFixed(2) + ' ms');
          if (this.pendingMode != null) {
            this.setMode(this.pendingMode);
            this.pendingMode = null;
          }
          for (const q of this.pendingWorker) w.postMessage(q);
          this.pendingWorker = [];
        } else if (m.type === 'error') {
          this.workerFailed = m.reason;
          this._dbg('Worker 失败: ' + m.reason);
        } else if (m.type === 'fatal') {
          // 处理循环死掉必须立刻暴露，否则表现只是"音质变差"，从日志里查不出来
          this.workerFailed = m.reason;
          this.workerDead = true;
          this._dbg('Worker 循环崩溃: ' + m.reason);
          try { console.error('[denoise] Worker 循环崩溃', m.reason); } catch (_) { /* ignore */ }
        } else if (m.type === 'aecState' || m.type === 'farReady') {
          try { window.__aecState = m; } catch (_) {}
        } else if (m.type === 'aecDiag') {
          try { window.__aecDiag = m; } catch (_) {}
        } else if (m.type === 'stats') {
          this.workerStats = m;
        }
      };
      w.onerror = (e) => {
        this.workerFailed = (e && e.message) || 'worker error';
        this._dbg('Worker onerror: ' + this.workerFailed);
      };

      const b = this._b();
      w.postMessage({
        type: 'init',
        sab,
        farSab: this.farSab || null,
        onnx: b.modelPath ? b.modelPath() : null,
        ort: b.ortPath ? b.ortPath() : null,
        nodePath: b.nativeNodePath ? b.nativeNodePath() : null,
        nativeDir: b.nativeDirPath ? b.nativeDirPath() : null,
      });
      this._watchWorker();
      return true;
    } catch (e) {
      this.workerFailed = e.message;
      this.worker = null;
      return false;
    }
  },

  /** AudioContext 重建：只换 SAB，不动 Worker 和 native 实例 */
  _rebindWorker(sab) {
    const b = this._b();
    this.workerReady = false;
    this._watchWorker();
    this.worker.postMessage({
      type: 'attach',
      sab,
      farSab: this.farSab || null,
      onnx: b.modelPath ? b.modelPath() : null,
      ort: b.ortPath ? b.ortPath() : null,
      nodePath: b.nativeNodePath ? b.nativeNodePath() : null,
      nativeDir: b.nativeDirPath ? b.nativeDirPath() : null,
    });
  },

  /**
   * 【0.4.24】Worker 掉线自愈。
   * 实测：共享 ctx 改造后出现过「worker 对象在、但从未回 ready、ctrl 恒全 0」——
   * 表现是 worklet 一直走预热直通（有声音、没降噪），用户看不出来。
   * init/attach 发出 3 秒还没 ready，就 terminate 掉重建一个。
   */
  _watchWorker() {
    clearTimeout(this._wdTimer);
    this._wdTimer = setTimeout(() => {
      if (this.workerReady || !this.worker) return;
      // 只记录，不重建：ORT 的 Environment 是**进程级单例**，
      // terminate 后再 new FongDenoise 必报
      //   "env: only one environment is allowed per process"（实测踩到）
      // 重建 worker 这条路走不通，只能等或用直通兜底。
      console.warn('[denoise] Worker 3 秒未就绪（不重建：ORT env 进程级单例）');
    }, 3000);
  },

  /**
   * 【0.4.26】启动预热：应用一起来就把 worker 建好并加载 native/ORT。
   * 实测 packaged 版 worker 的 native 冷启动可以拖到 20 秒以上（时长不稳定），
   * 而 worklet 在等不到 worker 时会走"直通"—— 结果就是「有声、没降噪」。
   * 把加载挪到启动阶段，用户进房（通常 >5 s）时基本已就绪。
   */
  warmup() {
    try {
      if (this.worker || this.mode === 'postmessage' || typeof Worker === 'undefined') return false;
      if (typeof SharedArrayBuffer === 'undefined' || !this.useSab) return false;
      const { sab } = this._makeSab();
      const ok = this._startWorker(sab);
      if (!ok) return false;
      this.sab = sab;                     // init 时 _buildGraph 会换新 SAB 并 rebind，这里只用于预热
      this._dbg('预热 worker 已启动');
      return true;
    } catch (_) { return false; }
  },

  /**
   * 【0.4.33】AEC 开关。far-end 参考环与开关都通过 worker 消息下发（不影响降噪的 SAB 布局）。
   */
  /** 【0.4.40】只跳过 GTCRN，AEC 继续跑（否则回声消除白做）。走 SAB 18 号槽，理由同 setAec。 */
  setDenBypass(on) {
    this.denBypassed = !!on;
    if (this.ctrl) { try { Atomics.store(this.ctrl, 18, on ? 1 : 0); } catch (_) {} }
  },
  get bypassed() { return !!this.denBypassed || !!this._bypassReason; },
  setAec(on) {
    this.aecWanted = !!on;
    // 【关键】不能走 postMessage：worker 的主循环在「有数据」时连续处理、从不让出事件循环，
    // 消息要等 JS 栈空才会被派发 —— 通话中它永远不会空。所以 AEC 开关走 SAB 第 15 号槽（状态位）。
    if (this.ctrl) {
      try { Atomics.store(this.ctrl, 15, this.aecWanted ? 1 : 0); } catch (_) {}
    } else {
      this.pendingAec = this.aecWanted;
    }
  },

  /** 传入 far-end 参考 SAB（来自 aec-ref-worklet）。与降噪完全独立的一条环。 */
  /**
   * 【0.4.35 · 独立审查修正】只登记 far SAB，**不重发消息**。
   * 它必须由调用方在 `init()` 之前设置好，随 init 消息一起下发 —— 见 renderer.js 里 Mic.start 的注释。
   * （原来这里 `_rebindWorker()` 重发 'attach'：通话中 worker 不让出事件循环，消息永远轮不到，
   *   实测 farBound 恒为 false、AEC 拿静音当参考、ERLE 0.46 dB；还会把 workerReady 永久置 false。）
   */
  setFarSab(sab) {
    if (!sab) return false;
    this.farSab = sab;
    return true;
  },

  _postWorker(msg) {
    if (!this.worker) return;
    if (this.workerReady) this.worker.postMessage(msg);
    else this.pendingWorker.push(msg);
  },

  /**
   * 建 SAB：输入环 + 输出环 + ctrl。
   * 【0.4.45 · 独立审查】进程内唯一，按字节数缓存复用。
   * 原来每次 _makeSab 都新建，而 worker 侧的 ctrl 只在 init/attach 时绑定一次 ——
   * 通话中重建时新 SAB 传不到 worker，于是 workerReady/ctrlReady 假性变 false 且不再恢复，
   * 而降噪守护拿 ctrlReady 当判据（renderer.js 的 _denoiseGuardTick）→ 会静默跳过守护。
   * 与 far 环（AEC_FAR_SAB）同一个病，用同一个药：环地址固定，重建只换 worklet 侧。
   */
  _makeSab() {
    const total = this._sabBytes() + 64;
    if (Denoise._sabCache && Denoise._sabCache.total === total) {
      const cached = Denoise._sabCache.sab;
      const ctrl = new Int32Array(cached, this._ctrlOffset(), this.CTRL_N);
      // 【0.4.50 · 严重修正】复用时必须把【环形缓冲指针】一起归零。
      // 0.4.49 那版只重置了命令槽，忘了 C_IN_W/C_IN_R/C_OUT_W/C_OUT_R ——
      // 新 worklet 构造时读 C_OUT_R、C_IN_W 当起点，worker 重绑时读 C_IN_R、C_OUT_W，
      // 两边都拿到上一轮遗留的旧值 → 环内读写错位 → 实测「质量档一卡一卡、切模式后完全没声」。
      // 原来每次 new SharedArrayBuffer 天然全零，所以这个 bug 只在缓存复用后出现。
      // 现在只保留 AEC 开关（槽 15，用户刚设的，不能被覆盖），其余全部复位。
      const aecKeep = Atomics.load(ctrl, 15);
      ctrl.fill(0);                       // 指针 + 状态 + 命令 + 计数，一次清干净
      // 【务必用 this.XXX】这些槽位常量挂在 Denoise 对象上（C_STATE: 4 ...），
      // 不是模块级变量。0.4.49 这版写成裸 `C_STATE` → 第二次初始化时抛
      // ReferenceError: C_STATE is not defined → init() 整个失败并把 this.failed 永久置位
      // → 之后每次 init 都直接 abort。真机表现就是「切一次降噪档后彻底没声、卡顿」。
      Atomics.store(ctrl, this.C_STATE, 1);
      Atomics.store(ctrl, this.C_CMD_ENABLE, -1);
      Atomics.store(ctrl, this.C_CMD_MODE, -1);
      Atomics.store(ctrl, this.C_CMD_HOWL, -1);
      Atomics.store(ctrl, this.C_CMD_TRANS, -1);
      Atomics.store(ctrl, this.C_CMD_TILT, -1);
      Atomics.store(ctrl, this.C_CMD_RESET, 0);
      Atomics.store(ctrl, this.C_READY, 0);    // 等 worker 预热完再放行，与全新建一致
      Atomics.store(ctrl, 15, aecKeep);        // AEC 开关是用户态，保留
      return { sab: cached, ctrl };
    }
    const sab = new SharedArrayBuffer(total);
    Denoise._sabCache = { total, sab };
    const ctrl = new Int32Array(sab, this._ctrlOffset(), this.CTRL_N);
    ctrl.fill(0);
    Atomics.store(ctrl, this.C_STATE, 1);
    Atomics.store(ctrl, this.C_CMD_ENABLE, -1);
    Atomics.store(ctrl, this.C_CMD_MODE, -1);
    Atomics.store(ctrl, this.C_CMD_HOWL, -1);
    Atomics.store(ctrl, this.C_CMD_TRANS, -1);
    return { sab, ctrl };
  },

  _buildGraph(ctx) {
    const useSab = !!this.useSab && typeof SharedArrayBuffer !== 'undefined';

    const opt = { enabled: this.enabled, diag: true, prefill: this.PREFILL };
    if (useSab) {
      const { sab, ctrl } = this._makeSab();
      this.sab = sab; this.ctrl = ctrl;
      if (this.pendingAec != null || this.aecWanted != null) {
        try { Atomics.store(ctrl, 15, (this.aecWanted ? 1 : 0)); this.pendingAec = null; } catch (_) {}
      }
      opt.sab = sab;
      this.mode = 'sab';
    } else {
      this.mode = 'postmessage';
    }

    if (this.useWorker && this.sab) {
      if (this._startWorker(this.sab)) {
        this.mode = 'worker';
        opt.external = true;
      } else {
        this._dbg('Worker 起不来，退回 postmessage（会丢块）');
        this.mode = 'postmessage';
      }
    }

    this.node = new AudioWorkletNode(ctx, 'fong-denoise', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: opt,
    });

    this.node.port.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.type === 'diag') {
        try { window.__denoiseDiag = d; } catch (_) { /* ignore */ }
        if (this.debug) console.log('[worklet] ' + JSON.stringify(d));
        return;
      }
      if (d.type === 'bypass') {
        // 上游死了，worklet 已直通。必须让上层知道降噪其实关着 ——
        // 这种静默失效看起来"正常"，只是效果差，最难查。
        // 【独立审查 · 0.4.45】bypassed 是**只读访问器**（get bypassed），原写法必抛 TypeError：
        //   Cannot set property bypassed of #<Object> which has only a getter
        // 后果：worklet 的安全闸跳闸通知（降噪静默直通）永远传不到上层，onmessage 直接中断，
        // 而且每来一条就抛一次（切降噪档后实测日志被刷满）。降噪其实关着、上层却当它正常。
        // 【0.4.59 · 独立审查】worklet 发 recovered/resumed 是【解除】通知，
      // 原来也写进 _bypassReason → get bypassed() 恒 true → 守护永久失能。
      if (d.reason === 'recovered' || d.reason === 'resumed') {
        this._bypassReason = null;
        this.denBypassed = false;
        this._dbg('降噪恢复: ' + d.reason);
        return;
      }
      this._bypassReason = d.reason || 'stall';
        this._dbg('降噪安全闸跳闸，已直通: ' + this.bypassed);
        return;
      }
      if (d.type === 'block') this._handleBlockPcm(d.pcm);
    };

    // 【0.4.21 · 实测定案】输出侧插一级 gate：
    // 发送门控不能再依赖 track.enabled —— 这条 dest 轨一旦被 disable，Chromium 停止渲染
    // 整张 ctx 图（无消费者），worklet 直通也不再产出 → Mic.db 恒 -51 → VAD 判无声 →
    // 门控永久关闭（自锁）。实测（打包版 0.4.20，两个真客户端）：B 端 sendEnabled=false、
    // peakSend=0.0000、对端 totalAudioEnergy=0，就是用户说的「说话没声音」。
    this.gate = ctx.createGain();
    this.gate.gain.value = 1;
    // 门控前的独立输出：VAD / 电平表必须看这一条。
    // 实测（打包版 0.4.20，两个真客户端）：VAD 若挂在门控之后的 dest 轨上会自锁 ——
    // 门控关 → VAD 源静音 → open=false → 门控永远保持关闭 → 对端 totalAudioEnergy=0。
    this.pre = ctx.createMediaStreamDestination();
    this.dest = ctx.createMediaStreamDestination();
    this.node.connect(this.pre);
    this.node.connect(this.gate);
    this.gate.connect(this.dest);
    this.ctx = ctx;
    this.ready = true;
  },

  _handleBlockPcm(pcm) {
    const b = this._b();
    if (!this.node) return;
    const out = new Float32Array(pcm.length);
    if (b.denoiseProcessTo) b.denoiseProcessTo(pcm, out);
    else out.set(pcm);
    this.node.port.postMessage({ type: 'block', pcm: out }, [out.buffer]);
  },

  _killWorker(full) {
    const w = this.worker;
    if (!w) return;
    try { w.postMessage({ type: full ? 'stop' : 'detach' }); } catch (_) { /* ignore */ }
    if (full) {
      // 只有退出应用才真销毁。平时销毁会让 ORT 的进程级 Environment 失效，
      // 下次 new FongDenoise 必报 "only one environment is allowed per process"。
      try { w.terminate(); } catch (_) { /* ignore */ }
      this.worker = null;
      this.workerReady = false;
    }
  },

  _dropGraph() {
    try { if (this.src) this.src.disconnect(); } catch (_) { /* ignore */ }
    try { if (this.node) this.node.disconnect(); } catch (_) { /* ignore */ }
    this._killWorker(false);   // 只停循环，保留 Worker 与 native 实例
    try { if (this.gate) this.gate.disconnect(); } catch (_) { /* ignore */ }
    try { if (this.pre) this.pre.disconnect(); } catch (_) { /* ignore */ }
    this.src = null; this.node = null; this.gate = null; this.pre = null; this.dest = null;
    this.sab = null; this.ctrl = null;
    this.ctx = null; this.ready = false;
    // 【0.4.52】拆完之后任何一次 init() 都必须重新 attach。
    // 原来 _dropGraph 发了异步 'detach' 却把 ready 置 false，紧接着 init() 见 ctx 相同
    // 会走「已就绪」快路径直接 return —— worker 永远停在 detached 状态：
    // 实测 ctrlReady=false、sent 冻结、underruns 3 秒涨到 5888，即用户说的「切档后没声 / 一卡一卡」。
    this._needAttach = true;
    // 【0.4.59】换链时清旁路状态，否则 JS 侧标志与 worker 侧槽 18 分裂：
    // 实测 ctrl.fill(0) 把槽18清了(0)，但 denBypassed 仍是 true。
    this.denBypassed = false;
    this._bypassReason = null;
  },

  async init(ctx) {
    this._initTrace = [];
    const T = (m) => { try { this._initTrace.push(m); window.__denoiseInitTrace = this._initTrace; } catch (_) {} };
    T('enter ready=' + this.ready + ' sameCtx=' + (this.ctx === ctx) + ' failed=' + this.failed);
    if (this.failed) {
      // 【0.4.52】failed 只该拦「模型不可用」这类永久错误。
      // 原来任何异常都写 failed 并永久否决整条链 —— 一次瞬时 ReferenceError 就让降噪
      // 到重启为止再也不启动（实测踩到）。这里给瞬时错误一个重试机会：清掉再试一次。
      T('retry: 清掉旧 failed=' + this.failed);
      this.failed = null;
    }
    if (this.ready && this.ctx === ctx) { T('abort: 已就绪同 ctx'); return true; }
    if (this.ready && this.ctx !== ctx) {
      this._dbg('AudioContext 已更换，重建 audio graph');
      this._dropGraph();
    }

    try {
      const b = this._b();
      if (!b) throw new Error('preload 桥未注入');

      const url = new URL('denoise-worklet.js', location.href).href;
      T('addModule ' + url);
      await ctx.audioWorklet.addModule(url);
      T('addModule ok');

      this._buildGraph(ctx);

      if (this.mode !== 'worker') {
        // 兜底路径才需要 preload 内的 native 实例
        if (!b.denoiseInit) throw new Error('preload 未暴露 denoiseInit');
        const r = b.denoiseInit();
        if (!r || !r.ok) throw new Error(r ? r.reason : '初始化返回空');
        this.latencyMs = r.latencyMs || 0;
      }

      this.ready = true;
      this._dbg('就绪（' + this.mode + '），延迟 ' + this.latencyMs.toFixed(2) + ' ms');
      return true;
    } catch (e) {
      this.failed = e.message || String(e);
      this._dbg('不可用，回退到浏览器降噪: ' + this.failed);
      return false;
    }
  },

  attach(ctx, rawTrack) {
    if (!this.ready || !this.node || !this.dest) {
      this._dbg('attach 前置失败 ready=' + this.ready);
      return null;
    }
    try {
      if (this.src) { try { this.src.disconnect(); } catch (_) { /* ignore */ } }
      this.src = ctx.createMediaStreamSource(new MediaStream([rawTrack]));
      this.src.connect(this.node);
      const t = this.dest.stream.getAudioTracks()[0];
      if (!t) { this._dbg('dest 无音频轨道'); return null; }
      return t;
    } catch (e) {
      this._dbg('attach 异常: ' + e.message);
      // 【0.4.10 · 审查 P2-2】attach 的瞬时异常（ctx 已关、track 无效等）不能写
      // this.failed —— init() 见 failed 直接否决整条降噪链，一次抖动毒死到重启。
      // failed 只留给 init() 的「模型不可用」永久错误；这里记瞬态标志供诊断。
      this._attachErr = e.message;
      return null;
    }
  },

  /** worker 是否已就绪（SAB 控制块的 C_READY 槽 = 16）。守护判据必须等它，否则会误杀正常链。 */
  get ctrlReady() {
    try { return !!this.ctrl && Atomics.load(this.ctrl, 16) === 1; } catch (_) { return false; }
  },

  /** 门控前的输出轨（VAD / 电平表用，不受 setGate 影响）。 */
  preTrack() {
    try { return this.pre && this.pre.stream ? this.pre.stream.getAudioTracks()[0] || null : null; } catch (_) { return null; }
  },

  /** 发送门控：0 = 静音但持续发帧（与 P0-G 的持续发包一致），1 = 正常。 */
  setGate(v) {
    if (!this.gate) return false;
    const on = v ? 1 : 0;
    try {
      if (typeof this.gate.gain.setTargetAtTime === 'function' && this.ctx) {
        this.gate.gain.setTargetAtTime(on, this.ctx.currentTime || 0, 0.01);
      } else {
        this.gate.gain.value = on;
      }
      return true;
    } catch (_) { return false; }
  },

  tap(target) {
    if (!this.node) return false;
    try { this.node.connect(target); return true; } catch (e) {
      this._dbg('tap 失败: ' + e.message);
      return false;
    }
  },

  detach() {
    try { if (this.src) { this.src.disconnect(); this.src = null; } } catch (_) { /* ignore */ }
  },

  teardown() { this._dropGraph(); },

  // ---- 控制面：全部写 SAB 原子槽，Worker 每块读一次 ----
  setMode(m) {
    const v = m | 0;
    if (!this.ctrl) { this.pendingMode = v; return; }
    Atomics.store(this.ctrl, this.C_CMD_MODE, v);
    this.pendingMode = null;
  },

  setEnabled(on) {
    this.enabled = !!on;
    if (this.ctrl) Atomics.store(this.ctrl, this.C_CMD_ENABLE, this.enabled ? 1 : 0);
    // 【0.4.73】原来自赋值 `this.pendingMode = this.pendingMode`（死代码，等于什么都不做）。
    // 建图前改开关是无效的 —— 链没建就该由调用方走重建路径，这里明确记一下状态。
    else this.enabledPending = this.enabled;
    if (this.node) this.node.port.postMessage({ type: 'enabled', value: this.enabled });
  },

  /** 高频衰减（dB/octave）。0 = 原行为（毛刺多），3 = 默认，6~8 更闷更干净 */
  setHfTilt(v) {
    const tenth = Math.round((v || 0) * 10);
    if (this.ctrl) Atomics.store(this.ctrl, this.C_CMD_TILT, tenth);
    this.pendingTilt = v;
    const b = this._b();
    if (b && b.denoiseSetHfTilt) b.denoiseSetHfTilt(v);
  },

  setHowl(on) {
    if (this.ctrl) Atomics.store(this.ctrl, this.C_CMD_HOWL, on ? 1 : 0);
  },

  setTransient(on) {
    if (this.ctrl) Atomics.store(this.ctrl, this.C_CMD_TRANS, on ? 1 : 0);
  },

  reset() {
    // native 侧复位（worker 每块读）
    if (this.ctrl) Atomics.store(this.ctrl, this.C_CMD_RESET, 1);
    // worklet 侧复位：走 SAB 槽 19（C_REQ_RESET）→ worklet 每帧自检 → 只清统计
    if (this.ctrl) Atomics.store(this.ctrl, this.C_REQ_RESET, 1);
    // 【0.4.73 · 独立审查 §2.2 修正】删掉原来那条 postMessage({type:'reset'})。
    //
    // 它落到 denoise-worklet.js 的 resetState()，里面有 gotFirst = false、accLen = 0：
    //   · gotFirst=false → process() 回到预热直通分支 → 要重新等 prefill(3 块) 才切回
    //     处理后的信号 → 这 30ms 是【直通原声】，主观就是"卡一下 / 突然变闷"
    //   · accLen=0 → 丢掉正在累积的半块
    // 而 0.4.62 自己已经踩过这个坑（worklet 注释：'清计数'和'清播放状态'是两件事），
    // 改走 SAB 槽 19 → resetStats()。但这条 postMessage 没删，把那次修复又抵消了。
    // 现在只留 SAB 那一路。
  },

  async refreshStats() {
    if (this.mode === 'worker' && this.worker) {
      this._postWorker({ type: 'stats' });
      await new Promise((r) => setTimeout(r, 150));
      return this.workerStats || { ok: 0, fail: 0, dropped: 0 };
    }
    const b = this._b();
    if (!b || !b.denoiseStats) return null;
    try {
      this.stats = b.denoiseStats();
      return this.stats;
    } catch (_) {
      return null;
    }
  },

  /** 诊断快照：不依赖 Worker 回包，直接读共享内存，任何线程状态下都能取 */
  snapshot() {
    if (!this.ctrl) return null;
    const c = this.ctrl;
    return {
      inWrite: Atomics.load(c, this.C_IN_W),
      inRead: Atomics.load(c, this.C_IN_R),
      outWrite: Atomics.load(c, this.C_OUT_W),
      outRead: Atomics.load(c, this.C_OUT_R),
      beats: Atomics.load(c, this.C_BEAT),
      ok: Atomics.load(c, this.C_STAT_OK),
      fail: Atomics.load(c, this.C_STAT_FAIL),
      drop: Atomics.load(c, this.C_STAT_DROP),
      backlogIn: Atomics.load(c, this.C_IN_W) - Atomics.load(c, this.C_IN_R),
      backlogOut: Atomics.load(c, this.C_OUT_W) - Atomics.load(c, this.C_OUT_R),
    };
  },
};

window.Denoise = Denoise;
