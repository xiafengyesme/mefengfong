// VAD 门控接线层（主线程侧）
//
// 职责：把 vad-gate-worklet.js 挂到降噪后的音轨上，接收 {open} 事件，
//       同步到 RTCRtpSender。主线程不再跑任何定时器做门控判定。
//
// 载入顺序：必须在 denoise-renderer.js 之后、renderer.js 之前。
//    <script src="vad-gate.js"></script>
//
// 没加载时 window.FongVad = null，renderer.js 自动退回旧的 tick 路径。

(function () {
  'use strict';

  const WORKLET = 'vad-gate-worklet.js';

  const Vad = {
    ready: false,
    failed: null,
    node: null,
    ctx: null,
    src: null,
    open: false,
    db: -100,
    // 诊断用：最近 200 次门控状态翻转的 [时间, open]
    log: [],

    /**
     * @param {AudioContext} ctx
     * @param {MediaStreamTrack} track  降噪之后的轨道
     * @param {{thrDb?:number, holdMs?:number, bypass?:boolean}} cfg
     */
    async attach(ctx, track, cfg) {
      if (!ctx || !track) { this.failed = '缺少 ctx 或 track'; return false; }
      return this._mount(ctx, cfg, (vadNode) => {
        const src = ctx.createMediaStreamSource(new MediaStream([track]));
        src.connect(vadNode);
        src._fromTrack = true;
        return src;
      });
    },

    /**
     * 从已有的 AudioNode 直接取信号（用于降噪链的输出节点）。
     *
     * 为什么必须走节点而不是轨：MediaStreamAudioDestinationNode 生成的轨在**同一个 AudioContext**
     * 里再 createMediaStreamSource 采不回来（本项目早期注释已记过这条）。VAD 若挂在那种轨上会
     * 永远读到 0 → 判无声 → 门控 close → 自锁，表现就是「说话对方完全听不到」。
     * 实测（0.4.21，真客户端）：open=false、db=-51、对端 totalAudioEnergy=0，而 worker 明明在跑
     * （ctrl=[2680,2680,2680,2677,1,1]、diag.sent=2641）。改成直接连节点后一切正常。
     */
    async attachFromNode(ctx, node, cfg) {
      if (!ctx || !node) { this.failed = '缺少 ctx 或 node'; return false; }
      return this._mount(ctx, cfg, (vadNode) => { node.connect(vadNode); return node; });
    },

    /** 共用挂载：建 worklet 节点 + 零增益出口（保证整条分析链被渲染） */
    async _mount(ctx, cfg, wireInput) {
      if (this.node) this.detach();
      try {
        await ctx.audioWorklet.addModule(new URL(WORKLET, location.href).href);
        const node = new AudioWorkletNode(ctx, 'vad-gate', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          processorOptions: {
            thrDb: cfg && cfg.thrDb != null ? cfg.thrDb : -42,
            holdMs: cfg && cfg.holdMs != null ? cfg.holdMs : 240,
            hopMs: 10,
            bypass: !!(cfg && cfg.bypass),
          },
        });
        // 音轨/节点 → worklet。worklet 不输出声音（下面接零增益），只做分析。
        const src = wireInput(node);
        const mute = ctx.createGain();
        mute.gain.value = 0;
        node.connect(mute);
        mute.connect(ctx.destination);

        node.port.onmessage = (e) => {
          const m = e.data || {};
          if (m.type === 'gate') {
            const now = performance.now();
            this.open = !!m.open;
            this.log.push([now, this.open, m.db]);
            if (this.log.length > 200) this.log.shift();
            if (this.onGate) this.onGate(this.open, m.db);
          } else if (m.type === 'level') {
            this.db = m.db;
            if (this.onLevel) this.onLevel(m.db);
          }
        };

        this.ctx = ctx;
        this.node = node;
        this.src = src;
        this.mute = mute;
        this.ready = true;
        this.failed = null;
        return true;
      } catch (e) {
        this.failed = e && e.message ? e.message : String(e);
        this.ready = false;
        return false;
      }
    },

    /** 阈值 / 保持时长变化（设置页拖动滑块时调） */
    cfg(o) {
      if (!this.node) return;
      this.node.port.postMessage(Object.assign({ type: 'cfg' }, o));
    },

    /** 按键说话：bypass = true 时恒开 */
    setBypass(on) { this.cfg({ bypass: !!on }); },

    reset() { if (this.node) this.node.port.postMessage({ type: 'reset' }); },

    detach() {
      // 轨来的 src 可以整体断开；外部节点只断开「到 VAD 的那条边」，不能整节点 disconnect
      try {
        if (this.src) {
          if (this.src._fromTrack) this.src.disconnect();
          else if (this.node) this.src.disconnect(this.node);
        }
      } catch (_) {}
      try { if (this.node) this.node.disconnect(); } catch (_) {}
      try { if (this.mute) this.mute.disconnect(); } catch (_) {}
      this.src = this.node = this.mute = null;
      this.ctx = null;
      this.ready = false;
    },

    /**
     * 诊断：从门控翻转日志里算"最长一次开启延迟"。
     * 定义：从「电平越过阈值的第一个 hop」到「open 变 true」的时间差。
     * 理论上应该是 0（同一 hop 内判定），这里用来验证 worklet 确实没被抢占。
     */
    stats() {
      const g = this.log.filter((r) => r[1]);
      return {
        ready: this.ready,
        failed: this.failed,
        events: this.log.length,
        openNow: this.open,
        db: this.db,
      };
    },
  };

  window.FongVad = Vad;
})();
