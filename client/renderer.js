'use strict';
// FONG 客户端渲染进程。
// 媒体信令严格按 PRD 5.1：/signal /events /answer /healthz（不改）；空间/房间/成员/权限走新增的 /api/*。
const $ = (id) => document.getElementById(id);
const CRLF = '\r\n';
// Opus 单声道码率档位。文档 docs/音质规格与码率上限.md 的实测：
//   96k   PESQ 4.442  STOI 0.9978   ← 人声已透明
//   256k  PESQ 4.544  STOI 0.9996   ← libopus 单声道硬上限
// 默认给最高的 256，用户可往下调省带宽。
const OPUS_TIERS = [96, 128, 192, 256];
// 【P0-D】接收端抖动缓冲目标（ms）。
// 不设的话 Chrome 默认 NetEq 目标 100–200 ms 起步，网络一抖就往上爬到 400 ms+
// 且不主动回落；游戏抢 CPU 时音频渲染线程被饿死，NetEq 还会再加保护缓冲。
// 语音场景 60 ms 是感知与抗抖的平衡点：40 ms 以下在 4G/WiFi 抖动下开始掉字，
// 80 ms 以上对方"回声感"明显。
// 对照 OOPZ 的 Agora 引擎：che.audio.max_target_delay = 200（它有上限，我们原来没有）。
// 可用 localStorage 的 fong2.jitterMs 覆盖，便于线上 A/B。
const JITTER_TARGET_MS = (() => {
  try {
    const v = +JSON.parse(localStorage.getItem('fong2') || '{}').jitterMs;
    if (Number.isFinite(v) && v >= 20 && v <= 200) return v;
  } catch (_) {}
  return 60;
})();
const OPUS_MAX = 256;
function opusKbps() {
  const v = +S.opusKbps;
  return OPUS_TIERS.includes(v) ? v : OPUS_MAX;
}
// 两个名字都要查：contextIsolation 开时用 window.native，关时用 fongBridge
// 【0.4.24 · 实测定案】AudioContext 的新建时机决定了 native 降噪还活着没有。
// 实测（真客户端，两种顺序对照）：
//   先建好 3 个 AudioContext，再 Mic.start()  → native 输出 0.1988（正常）
//   降噪运行中新建第 4 个 AudioContext        → native 输出 0.0255（掉 87%）
//   关掉那个 ctx 之后                          → native 输出 0.0027（归零，且不可逆）
// worker 侧输入一直是 0.2746、ok 计数在涨、不报错 —— 是 native 推理输出被永久打坏。
// 所以全应用统一复用一个「加载期」创建好的 ctx，运行期绝不再新建。
const SHARED_CTX = (() => {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    const c = new AC({ sampleRate: 48000, latencyHint: 'interactive' });
    try { c.resume().catch(() => {}); } catch (_) {}
    return c;
  } catch (_) { return null; }
})();
const ctxShared = () => {
  if (SHARED_CTX && SHARED_CTX.state !== 'closed') return SHARED_CTX;
  return new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
};

// 【0.4.26】启动即预热降噪 worker（native/ORT 冷启动慢，别等到用户开口）
setTimeout(() => { try { if (window.Denoise && Denoise.warmup) Denoise.warmup(); } catch (_) {} }, 1200);

// 【0.4.33】AEC 参考信号链（far-end）。
// 播放走 <audio> 元素拿不到 PCM，所以这里在 Mic.actx 内**并行**建一条：
//   每条远端轨 → MediaStreamAudioSourceNode → aec-ref worklet → SAB → worker 里的 AEC3
// 它与播放链并行，不串在发送通路上 —— far 迟到只影响回声抑制质量，不影响通话延迟。
// 【独立审查 · 0.4.45】AEC 的 far-end 参考环 SAB：**进程内唯一，跨 Mic.start(force) 复用**。
// 为什么不能每次重建都新建：worker 侧的 farCtrl 只在 'init' / 'attach' 两条消息里绑定，
// 而 (a) Denoise.init() 在 ready 且 ctx 未变时直接 return —— 不再发 init；
//     (b) 'attach' 消息在通话中永远不会被派发 —— worker 主循环有数据时不让出事件循环（本项目自己的硬约束）。
// 于是「新建 SAB」= worklet 写新环、worker 永远读旧环 → far 帧数永久冻结、AEC 全程拿静音做参考。
// 实测（本机 dev 客户端 + 线上 SFU，通话中勾一次「回声消除」）：
//   diag far=2060 冻结 24 秒不动，frames 2800→4900，farPeak 停在旧环最后一块 0.4008。
const AEC_FAR_SAB = (() => { try { return new SharedArrayBuffer(8 * 4 + 16 * 480 * 4); } catch (_) { return null; } })();

// 【0.4.71】每条远端轨「实际播放音量」。AEC 参考要按它缩放，
// 否则 <audio>.volume 调低时参考仍满幅 → 过消 → 残差成回声。
const FAR_GAIN = new Map();

const AecRef = {
  ctx: null, node: null, sink: null, sab: null, srcs: new Map(), started: false,
  async start(ctx, sabIn) {
    if (this.started && this.ctx === ctx && this.sab === sabIn) return true;
    this.stop();
    if (!ctx || typeof SharedArrayBuffer === 'undefined') return false;
    this.ctx = ctx;
    const sab = sabIn || new SharedArrayBuffer(8 * 4 + 16 * 480 * 4);
    try {
      await ctx.audioWorklet.addModule(new URL('aec-ref-worklet.js', location.href).href);
      const node = new AudioWorkletNode(ctx, 'aec-ref', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1],
        processorOptions: { sab },
      });
      // 必须接下游：AudioWorkletNode 没有输出连接时 Chromium 不会拉取它（本项目踩过三次）
      const sink = ctx.createGain(); sink.gain.value = 0;
      node.connect(sink); sink.connect(ctx.destination);
      this.node = node; this.sink = sink; this.sab = sab; this.started = true;
      console.log('[audio-diag] AEC 参考链已启动（far-end 采集）');
      return true;
    } catch (e) {
      console.warn('[audio-diag] AEC 参考链启动失败：' + (e && e.message));
      this.stop();
      return false;
    }
  },
  // 【0.4.71】音量变化时同步参考增益（不改就是 AEC 过消/欠消）
  updateGains() {
    for (const [id, rec] of this.srcs) {
      if (!rec.gain) continue;
      const g = FAR_GAIN.has(id) ? FAR_GAIN.get(id) : 1;
      try { if (Math.abs(rec.gain.gain.value - g) > 0.01) rec.gain.gain.value = g; } catch (_) {}
    }
  },
  // 【0.4.73 · 独立审查 §1.1 修正】用 <audio>.captureStream() 取【实际播放出去的 PCM】。
  //
  // 原来的做法：clone(receiver.track) → 直接进 aec-ref worklet。
  // 问题：receiver.track 是【解码后、进 NetEq 之前】的轨，clone 出来没有任何抖动缓冲、
  // 没有 media pipeline 起播延迟；而实际播放走 <audio> 元素，要过：
  //   · jitterBufferTarget = 60ms（JITTER_TARGET_MS）
  //   · 元素自身的 demux/decode 缓冲
  //   · audio.play() 到真正出声的调度延迟
  // → 参考比实际播放【早 60~200ms】。AEC3 的 render/capture 是严格 FIFO 配对，
  //   render 早到太多就找不到相关性峰，W 在无关输入上梯度下降 = 随机游走，
  //   永不收敛。戴耳机时 near 里没有 far 成分，W 本该收敛到 0，
  //   不收敛就等于每帧往 near 里减一坨远端音频 —— 对端听到自己刚才说的话。
  //
  // captureStream 拿到的就是元素正在播的信号，延迟天然对齐（实测可用，峰值 1.0）。
  attachStream(mid, stream) {
    if (!this.started || !this.ctx || !this.node) return false;
    if (!stream) return false;
    const id = 'cap:' + mid;
    if (this.srcs.has(id)) return true;
    try {
      const src = this.ctx.createMediaStreamSource(stream);
      const gain = this.ctx.createGain();
      gain.gain.value = FAR_GAIN.has(id) ? FAR_GAIN.get(id) : 1;
      src.connect(gain); gain.connect(this.node);
      this.srcs.set(id, { src, gain, use: null, capture: true });
      console.log('[audio-diag] AEC 参考改接 <audio>.captureStream（与播放同源）mid=' + mid);
      return true;
    } catch (e) {
      console.warn('[audio-diag] captureStream 接参考失败：' + (e && e.message));
      return false;
    }
  },
  // 断开某个 mid 的 captureStream 参考
  detachStream(mid) {
    const id = 'cap:' + mid;
    const rec = this.srcs.get(id);
    if (!rec) return;
    try { rec.src.disconnect(); } catch (_) {}
    try { if (rec.gain) rec.gain.disconnect(); } catch (_) {}
    this.srcs.delete(id);
  },
  sync(tracks) {
    if (!this.started || !this.ctx) return;
    const alive = new Set();
    for (const t of tracks) {
      if (!t) continue;
      const id = t.id; alive.add(id);
      if (this.srcs.has(id)) continue;
      try {
        // 【0.4.44】必须 clone 一份：同一条接收轨已经被播放链（<audio> 元素或 FongWire lane）
        // 独占消费了，再对它挂 createMediaStreamSource 是拿不到数据的 —— 实测表现就是
        // 「用户能清楚听到对方说话，但 far 环里恒为静音、峰值 0.001」，AEC 于是没有参考可对。
        // clone() 出来的轨与原始轨共享数据源但独立消费，不跟播放抢。
        const use = (t.readyState === 'live' && typeof t.clone === 'function') ? t.clone() : t;
        const src = this.ctx.createMediaStreamSource(new MediaStream([use]));
        // 【0.4.71 · 带耳机仍有回音的核心修复】
        // 播放走 <audio> 元素，实际音量 = el.volume（memberVol × duckGain）再乘以系统音量；
        // 而这里 clone 出来的是【未经任何音量处理】的原始轨。
        // 不补这个 gain 的后果：把某人音量调到 30% 时，AEC 参考仍是满幅
        //   → AEC3 自适应滤波器按满幅学 → 过消 → 残差就是对方听到的"回声"。
        // 用户戴耳机（无物理回声）仍听到回音，正是这一条。
        const gain = this.ctx.createGain();
        gain.gain.value = FAR_GAIN.has(id) ? FAR_GAIN.get(id) : 1;
        src.connect(gain); gain.connect(this.node);
        this.srcs.set(id, { src, use, gain });
        console.log('[audio-diag] AEC 参考接入远端轨 ' + id.slice(0, 8) + '（readyState=' + t.readyState + ', cloned=' + (use !== t) + ', gain=' + gain.gain.value + '）');
      } catch (e) { /* 单条轨接不上不影响其它 */ console.warn('[audio-diag] AEC 参考接入失败：' + (e && e.message)); }
    }
    // 【0.4.74 · 我自己引入的严重 bug 修复】
    // 清理循环原来的判据是 `alive.has(id)`，而 alive 里装的是 track.id。
    // 但我新加的 attachStream 存的是 'cap:<mid>' 前缀 key —— 永远不在 alive 里。
    // 后果：每次 sync()（2.5s 守护 + ontrack + 成员变化 …）都会把 captureStream 参考
    //      【断开再重连】。断开的瞬间 far 环没有数据，AEC 拿到静音参考；
    //      重连又引入新的 pipeline 相位。周期性断连累积 → 「开时间长了就有电流」。
    // 修法：captureStream 的条目单独判断（用 mid 是否还在当前轨道集合里）。
    const aliveMids = new Set();
    for (const t of tracks) {
      if (!t) continue;
      // mid 从 track 上拿不到，用 'cap:' 条目的存在性由调用方 syncCapStreams 管
    }
    for (const [id, rec] of Array.from(this.srcs)) {
      if (rec.capture) continue;          // captureStream 条目由 syncCapStreams 单独管，这里不碰
      if (!alive.has(id)) {
        try { rec.src.disconnect(); } catch (_) {}
        try { if (rec.gain) rec.gain.disconnect(); } catch (_) {}
        try { if (rec.use && rec.use.stop) rec.use.stop(); } catch (_) {}   // clone 要显式停，否则泄漏
        this.srcs.delete(id);
        console.log('[audio-diag] AEC 参考断开远端轨 ' + id.slice(0, 8));
      }
    }
  },

  // 【0.4.74】captureStream 参考的独立管理：按「当前房间里还有哪些 mid」增删，
  // 不参与 sync() 的 track.id 判据（两者 key 空间不同）。
  syncCapStreams(midToAudio) {
    if (!this.started || !this.ctx || !this.node) return;
    const want = new Set();
    for (const [mid, au] of midToAudio) {
      if (!au || !au.audio || typeof au.audio.captureStream !== 'function') continue;
      const key = 'cap:' + mid;
      want.add(key);
      if (this.srcs.has(key)) continue;      // 已在，不动它（避免周期性断连）
      try {
        const st = au.audio.captureStream();
        if (!st || !st.getAudioTracks().length) continue;
        const src = this.ctx.createMediaStreamSource(st);
        const gain = this.ctx.createGain();
        gain.gain.value = FAR_GAIN.has(key) ? FAR_GAIN.get(key) : 1;
        src.connect(gain); gain.connect(this.node);
        this.srcs.set(key, { src, gain, use: null, capture: true });
        console.log('[audio-diag] AEC 参考接 captureStream mid=' + mid);
      } catch (e) { console.warn('[audio-diag] captureStream 接入失败：' + (e && e.message)); }
    }
    // 只移除「已经不该存在」的 captureStream 条目
    for (const [id, rec] of Array.from(this.srcs)) {
      if (!rec.capture) continue;
      if (!want.has(id)) {
        try { rec.src.disconnect(); } catch (_) {}
        try { if (rec.gain) rec.gain.disconnect(); } catch (_) {}
        this.srcs.delete(id);
        console.log('[audio-diag] AEC 参考断开 captureStream ' + id);
      }
    }
  },
  // 【独立审查 · 0.4.45】按当前 pc 现场重算 far 轨并挂上。
  // AecRef.start() 内部会 stop()（srcs 全清），而 syncAudio() 只在自己被别的模块调用时
  // 才顺手挂一次 —— 于是 Mic.start(force)（勾 AEC / 切降噪档 / 换麦 / 拔麦重试）之后，
  // far 链可以一直空着，直到某次完全无关的事件（成员列表变化 / onunmute）才恢复。
  // 实测：勾 AEC 后 +3s srcs=0（无挂载），+6s 才由一次 syncAudio 补上。
  resync() {
    if (!this.started || !this.ctx || !this.node) return -1;
    try {
      const pc = Room && Room.pc;
      if (!pc) return -2;
      const owners = pc.remoteDescription ? midOwners(pc.remoteDescription.sdp) : {};
      const tracks = [];
      for (const t of pc.getTransceivers()) {
        if (t.mid == null || !t.receiver || !t.receiver.track) continue;
        const owner = owners[t.mid];
        const peer = owner && owner !== '-' && owner !== Room.peerId ? owner : null;
        if (!peer && t.sender === Mic.sender) continue;
        const tr = t.receiver.track;
        if (t.direction === 'sendonly' || tr.kind !== 'audio' || tr.readyState === 'ended') continue;
        if ((Mic.rawTrack && tr.id === Mic.rawTrack.id) || (Mic.track && tr.id === Mic.track.id)
            || (Mic.sendTrack && tr.id === Mic.sendTrack.id)) continue;
        tracks.push(tr);
      }
      const before = this.srcs.size;
      this.sync(tracks);
      if (this.srcs.size !== before) console.log('[audio-diag] AEC 参考重挂：' + before + ' → ' + this.srcs.size + ' 条（现场远端轨 ' + tracks.length + '）');
      return this.srcs.size;
    } catch (e) { console.warn('[audio-diag] AEC 参考重挂失败：' + (e && e.message)); return -3; }
  },

  // 【独立审查 · 0.4.45】far 环看门狗：写指针 2 秒不动 = far 参考链断了。
  // 只认「写指针」这一个事实：它不动说明 worklet 没被拉 / 输入没挂上；
  // 而「远端静音」是另一回事 —— 写指针照常 100 块/秒、内容全 0（实测 24 秒远端停发：
  // w 持续 +2400，far 同步 +2330，farPeak=0）。两者在旧 UI 里长得一模一样，这是误诊的来源。
  watch() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (!this.started || !this.sab || !this.node) return;
      let w = 0;
      try { w = Atomics.load(new Int32Array(this.sab, 0, 8), 0); } catch (_) { return; }
      if (w !== this._lastW) { this._lastW = w; this._stall = 0; return; }
      // 【0.4.74】far 环停滞不一定故障：没人说话 + 对端静音时，<audio> 输出的是
      // 数字静音，captureStream 仍会产生帧（w 会涨）。真正停滞意味着「参考链断了」。
      // 但如果房间里根本没人发布音频（只有自己在说话），w=0 是正常的 —— 不该自愈。
      const anyRemote = Room && Room.pc
        ? Room.pc.getTransceivers().some((t) => t.receiver && t.receiver.track
            && t.receiver.track.kind === 'audio' && t.receiver.track.readyState === 'live'
            && t.direction !== 'sendonly' && t.mid != null)
        : false;
      if (!anyRemote) { this._stall = 0; return; }   // 没有远端轨：参考空着是对的
      this._stall = (this._stall || 0) + 1;
      if (this._stall < 3) return;   // 3 秒不动才认定（原 2 秒太敏感）
      this._stall = 0;
      if (!(typeof Room !== 'undefined' && Room && Room.pc)) return;   // 还没进房：等 Mic.start / syncAudio 负责，别空转重建
      const n = this.resync();
      if (n <= 0) { console.warn('[audio-diag] far 环写指针停滞（w=' + w + '），但当前没有可挂的远端轨，等 syncAudio'); return; }
      this._heals = (this._heals || 0) + 1;
      console.warn('[audio-diag] far 环写指针停滞（w=' + w + '，重挂 ' + n + ' 条），第 ' + this._heals + ' 次自愈');
      // 【0.4.74 · "开久了有电流"的核心修复】
      //
      // 原来 _heals > 1 就 this.stop() + this.start() 重建【整条 worklet 链】。
      // 实测（6 分钟长跑，每 15s 采样）：
      //   1.3m  underruns +14880  jitter 0.1466   ← 爆发
      //   1.5m  +12960           jitter 0.0365
      //   1.8~2.5m +0            jitter 回落到 0.006
      //   5.3m  +4800  / 5.8m +2464 / 6.1m +1184  ← 又爆发
      // 这是【周期性】的，正是用户说的"开久了突然有电流"。
      //
      // 机制：stop() 清空所有 srcs + 断开 node → far 环在这段时间没有数据
      //       → AEC 拿静音做参考 → 恢复时 takeFar 看到积压，一次跳 160ms
      //       → delay 估计失锁 → W 在错位参考上乱走 → 输出异常。
      // 自愈本身在制造故障。
      //
      // 现在：只重挂参考（resync），绝不动 worklet 链。
      // 只有连续多次仍救不回来（_heals >= 4，约 4 秒）才重建，且重建前先把 AEC 关掉，
      // 避免用静音参考做自适应。
      if (this._heals >= 4) {
        console.warn('[audio-diag] far 参考连续 4 次自愈失败，重建 worklet 链（重建期间 AEC 静音参考会被跳过）');
        const ctx = this.ctx, sab = this.sab;
        this.stop();
        Promise.resolve(this.start(ctx, sab)).then(() => { this._heals = 0; this._lastW = -1; this.resync(); this.watch(); }).catch(() => {});
      }
    }, 1000);
  },

  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this._lastW = -1; this._stall = 0;
    for (const [, rec] of this.srcs) {
      try { rec.src.disconnect(); } catch (_) {}
      try { if (rec.use && rec.use.stop) rec.use.stop(); } catch (_) {}
    }
    this.srcs.clear();
    try { if (this.node) this.node.disconnect(); } catch (_) {}
    try { if (this.sink) this.sink.disconnect(); } catch (_) {}
    this.node = this.sink = null; this.sab = null; this.started = false;
  },
  trackCount() { return this.srcs.size; },
};

// 【0.4.19】是否走 WebAudio 播放通道。见 syncAudio()：webaudio 通道在本机 Chromium 上
// 不驱动 NetEq（收包正常但零发射、完全无声），此时必须回落 <audio> 元素播放。
const wireWebAudio = () => !!(window.FongWire && FongWire.ready && FongWire.mode === 'webaudio');
const NATIVE = window.native || window.fongBridge || null;

// ============ 持久化 ============
const rhex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, '0')).join('');
const DEFAULT_KEYS = {
  ptt: { code: 'k41', label: '`', accel: null },
  mute: { code: 'Ctrl+Shift+k50', label: 'Ctrl + Shift + M', accel: 'Ctrl+Shift+M' },
  deafen: { code: 'Ctrl+Shift+k32', label: 'Ctrl + Shift + D', accel: 'Ctrl+Shift+D' },
};
// 出厂服务器地址。目标是用户完全不用关心服务器 —— 装了就能用。
// 要换自建服务器，在「设置 → 常规 → 服务器」里改，或设 FONG_SERVER 环境变量。
// 为什么不用域名：fongget.xyz 已能解析、证书也签好了，但大陆出口对
// 「未备案域名」做 SNI 阻断 —— 实测 SNI=fongget.xyz 时 TLS 握手成功、
// 之后 HTTP 请求 100% 被 reset；同一台服务器改用已备案域名或直接连 IP 都是 200。
// 所以出厂地址先用 IP + 8443，等备案通过再切域名（改这一行 + 重新打包即可）。
const DEFAULT_SERVER = 'https://8.156.40.211:8443';

// 域名可用时改成：'https://fongget.xyz'，并把下面这行设为 true。
const USE_DOMAIN = false;
const DOMAIN_SERVER = 'https://fongget.xyz';

// 0.2.3 曾把出厂地址写成域名，那批用户本地可能存着不通的域名地址。
// 这里做一次迁移：若存的是域名且域名当前不可用，退回 IP。
const MIGRATE_FLAG = 'srvMigrated024';

const defaults = () => ({
  uid: rhex(16), key: rhex(32), nick: '', avatar: '', server: DEFAULT_SERVER, ice: '', onboarded: false, device: '',
  email: '',   // 绑定了邮箱账号就记在这里，设置页显示
  mic: 'default', spk: 'default', mode: 'vad', thr: -42, duck: true, duckDb: -10, ns: true, agc: true, aec: false, denoiseMode: 2, hfTilt: 3, opusKbps: OPUS_MAX, opusTierAuto: false,
  sounds: true, autostart: false, keys: DEFAULT_KEYS, memberVol: {}, localMute: {},
  // 【0.4.50】通知分级（KOOK server_nodisturb / OOPZ「域已开启免打扰」）
  dnd: false, notifyLevel: 'mention', notifyOnJoin: true, notifyOnMsg: true, toneVol: 100,
  // 【0.4.64】发送键偏好：'enter' = Enter 发送 / Shift+Enter 换行；'ctrl' = Ctrl+Enter 发送 / Enter 换行
  sendKey: 'enter',
  spaceIds: [], curSpace: null, lastRoom: {},
});
let S = Object.assign(defaults(), JSON.parse(localStorage.getItem('fong2') || '{}'));
// 老版本把 server 存成空串，会盖掉新的出厂默认值 —— 这里补回来。
// （老用户升级上来就是这个场景，不补的话会一直提示「还没填服务器地址」）
if (!S.server || !String(S.server).trim()) S.server = DEFAULT_SERVER;
if (!S.device || !/^[0-9a-f]{32}$/.test(S.device)) { S.device = rhex(16); localStorage.setItem('fong2', JSON.stringify(S)); }
// 地址迁移（只做一次）：把不可用的域名地址退回 IP
if (!localStorage.getItem(MIGRATE_FLAG)) {
  const cur = String(S.server || '').trim().replace(/\/+$/, '');
  if (cur === DOMAIN_SERVER || cur === DEFAULT_SERVER) S.server = DEFAULT_SERVER;
  localStorage.setItem(MIGRATE_FLAG, '1');
}
S.keys = Object.assign({}, DEFAULT_KEYS, S.keys || {});
// save() 加兜底：localStorage 满时（老用户头像很大、或别的 key 占满了）
// setItem 会抛 QuotaExceededError，以前没人接 —— 结果是用户的设置从此全部存不上，
// 而且毫无提示。现在：先试着把头像正文剥掉再存一次（它在 IndexedDB 里本来就有），
// 还失败就提示用户，绝不再静默。
let saveWarned = false;
function safeSave() {
  const write = (obj) => localStorage.setItem('fong2', JSON.stringify(obj));
  try { write(S); return true; } catch (e) {
    // 第一层：把 avatar 正文剥掉（正常情况它已经是 'idb' 占位，这里兜旧数据）
    try {
      const slim = Object.assign({}, S);
      if (typeof slim.avatar === 'string' && slim.avatar.indexOf('data:') === 0) slim.avatar = 'idb';
      write(slim);
      return true;
    } catch (_) { /* 继续降级 */ }
    // 第二层：只保留关键字段，别让整个设置丢失
    try {
      write({
        uid: S.uid, key: S.key, nick: S.nick, avatar: S.avatar, server: S.server,
        email: S.email, accountId: S.accountId, device: S.device, onboarded: S.onboarded,
        memberVol: S.memberVol, localMute: S.localMute, thr: S.thr,
      });
      if (!saveWarned) { saveWarned = true; try { toast('本机存储空间紧张，部分设置可能没保存'); } catch (_) {} }
      return true;
    } catch (_) {
      if (!saveWarned) { saveWarned = true; try { toast('本机存储空间已满，设置无法保存'); } catch (_) {} }
      return false;
    }
  }
}
const save = () => safeSave();
save();
const serverURL = () => (S.server || '').trim().replace(/\/+$/, '');
function iceServers() {
  return (S.ice || '').split(/\s+/).filter(Boolean).map((u) => {
    const m = u.match(/^(turns?):([^:@]+):([^@]+)@(.+)$/);
    return m ? { urls: m[1] + ':' + m[4], username: m[2], credential: m[3] } : { urls: u };
  });
}

// ============ 小工具 ============
const el = (tag, cls, txt) => { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; };
const icon = (id) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const u = document.createElementNS('http://www.w3.org/2000/svg', 'use'); u.setAttribute('href', '#' + id); s.appendChild(u); return s; };
const setIcon = (svg, id) => svg.firstElementChild.setAttribute('href', '#' + id);
const initial = (name) => (Array.from((name || '?').trim())[0] || '?').toUpperCase();
const dbOf = (buf) => { let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]; return 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9); };
const pct = (db) => Math.max(0, Math.min(100, (db + 70) / 60 * 100));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * 头像。有头像就用图片，没有就退回首字母。
 * 图片走 <img loading=lazy> —— 大厅 12 人 × 64px，一次性全解码会卡；
 * lazy 让可视区外的先不加载。onerror 兜底回首字母，防止坏数据把头像框留空。
 */
const SAFE_IMG = /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/;
function avatar(name, cls, url) {
  const a = el('span', 'av' + (cls ? ' ' + cls : ''));
  a.setAttribute('aria-hidden', 'true');
  if (url && SAFE_IMG.test(url)) {
    const img = document.createElement('img');
    img.src = url;
    img.alt = '';
    img.loading = 'lazy';
    img.decoding = 'async';
    img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%';
    img.onerror = () => { img.remove(); a.textContent = initial(name); };
    a.appendChild(img);
  } else {
    a.textContent = initial(name);
  }
  return a;
}

function toast(text) {
  const t = el('div', 'toast', text); $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 2600);
}
let bannerAction = null;
function banner(text, actLabel, act, info) {
  $('bannerText').textContent = text;
  $('banner').classList.toggle('info', !!info);
  $('bannerAct').classList.toggle('hidden', !actLabel);
  $('bannerAct').textContent = actLabel || '';
  $('bannerAct').className = 'btn sm ' + (info ? 'ghost' : 'danger');
  bannerAction = act || null;
  $('banner').classList.remove('hidden');
}
function hideBanner() { $('banner').classList.add('hidden'); bannerAction = null; }
$('bannerAct').onclick = () => { const a = bannerAction; hideBanner(); a && a(); };
$('bannerClose').onclick = hideBanner;

// ---- 对话框 ----
function dialog({ title, text, input, value, placeholder, ok = '确定', danger, extra, noCancel }) {
  return new Promise((resolve) => {
    $('dlgTitle').textContent = title;
    $('dlgCancel').classList.toggle('hidden', !!noCancel);
    const body = $('dlgBody'); body.innerHTML = '';
    if (text) body.appendChild(el('p', null, text));
    let inp = null;
    if (input) { inp = el('input'); inp.value = value || ''; inp.placeholder = placeholder || ''; inp.maxLength = input; body.appendChild(inp); }
    if (extra) body.appendChild(extra);
    $('dlgOk').textContent = ok;
    $('dlgOk').className = 'btn sm' + (danger ? ' danger' : '');
    $('dialog').classList.remove('hidden');
    (inp || $('dlgOk')).focus(); if (inp) inp.select();
    const done = (v) => { $('dialog').classList.add('hidden'); $('dlgOk').onclick = $('dlgCancel').onclick = null; document.removeEventListener('keydown', key, true); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } if (e.key === 'Enter' && document.activeElement !== $('dlgCancel')) { e.preventDefault(); $('dlgOk').click(); } };
    document.addEventListener('keydown', key, true);
    $('dlgCancel').onclick = () => done(null);
    $('dlgOk').onclick = () => { if (inp) { const v = inp.value.trim(); if (!v) { inp.focus(); return; } done(v); } else done(true); };
  });
}


// ============ 头像 ============

const AVATAR_PX = 128;          // 服务端 32KB 上限下，128px WebP 约 6~12KB，余量充足
const AVATAR_MAX_SRC = 12 << 20; // 12MB 以上直接拒绝，读进内存会卡

/**
 * 把任意图片压成 128×128 的 data URI。
 * 为什么要自己压：用户随手选的截图可能 4000×3000、8MB，
 * 直接 base64 传输会超过服务端 32KB 限制，而且每帧渲染都要解码大图。
 *
 * 用 WebP（质量 0.82）：同样观感比 JPEG 小约 30%，Chromium 全支持。
 * 不支持 WebP 时自动回落 PNG。
 */
async function compressAvatar(file) {
  if (file.size > AVATAR_MAX_SRC) throw new Error('图片太大（请选 12MB 以内）');
  const bmp = await createImageBitmap(file).catch(() => { throw new Error('这个文件不是有效图片'); });
  try {
    // 居中裁成正方形，避免头像被拉扁
    const side = Math.min(bmp.width, bmp.height);
    const sx = (bmp.width - side) / 2;
    const sy = (bmp.height - side) / 2;
    const cv = document.createElement('canvas');
    cv.width = cv.height = AVATAR_PX;
    const cx = cv.getContext('2d');
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(bmp, sx, sy, side, side, 0, 0, AVATAR_PX, AVATAR_PX);
    let url = cv.toDataURL('image/webp', 0.82);
    if (!url.startsWith('data:image/webp')) url = cv.toDataURL('image/png');
    if (url.length > 32 * 1024) {
      // 极少数情况下还是超了，降质量再试一次
      url = cv.toDataURL('image/webp', 0.6);
      if (url.length > 32 * 1024) throw new Error('图片压缩后仍太大，换一张试试');
    }
    return url;
  } finally {
    if (bmp.close) bmp.close();
  }
}

// ============ 头像存储（IndexedDB） ============
// 头像正文不放进 localStorage：那里只有 5MB，且 save() 会整串重写。
// 这里用 IndexedDB 存正文，内存里留一份缓存让 avatar() 保持同步。
const AV_DB = 'fong';
const AV_STORE = 'avatars';
const AV_CACHE = Object.create(null);   // uid -> dataURL（内存缓存，同步读）
let avDbPromise = null;

function avDb() {
  if (avDbPromise) return avDbPromise;
  avDbPromise = new Promise((resolve, reject) => {
    let req;
    try { req = indexedDB.open(AV_DB, 1); } catch (e) { reject(e); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(AV_STORE)) db.createObjectStore(AV_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return avDbPromise;
}

/** 读某个 uid 的头像（同步读缓存；没缓存时返回空串，异步再补） */
function avatarOf(uid) {
  return AV_CACHE[uid] || '';
}

/** 启动时把当前账号的头像从 IndexedDB 灌进缓存 */
async function loadAvatarCache(uid) {
  if (!uid) return '';
  try {
    const db = await avDb();
    const v = await new Promise((resolve, reject) => {
      const tx = db.transaction(AV_STORE, 'readonly');
      const rq = tx.objectStore(AV_STORE).get(uid);
      rq.onsuccess = () => resolve(rq.result || '');
      rq.onerror = () => reject(rq.error);
    });
    if (v) AV_CACHE[uid] = v;
    return v;
  } catch (e) { return ''; }
}

/** 写/删头像正文。空串 = 删除。 */
async function putAvatar(uid, dataUrl) {
  if (!uid) return;
  try {
    const db = await avDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(AV_STORE, 'readwrite');
      const st = tx.objectStore(AV_STORE);
      if (dataUrl) st.put(dataUrl, uid); else st.delete(uid);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    if (dataUrl) AV_CACHE[uid] = dataUrl; else delete AV_CACHE[uid];
  } catch (e) {
    // IndexedDB 不可用时退回内存缓存：本次运行内照常显示，只是重启后丢
    if (dataUrl) AV_CACHE[uid] = dataUrl; else delete AV_CACHE[uid];
  }
}

/**
 * 把 localStorage 里已有的旧头像迁到 IndexedDB，然后从 fong2 里删掉正文。
 * 幂等：迁过之后再跑不会重复搬运。
 */
async function migrateAvatarOutOfLocalStorage() {
  const legacy = S && typeof S.avatar === 'string' ? S.avatar : '';
  if (!legacy || legacy === 'idb' || legacy.indexOf('data:') !== 0) return false;
  await putAvatar(S.uid, legacy);
  S.avatar = 'idb';          // 只留"有头像"这个语义
  const copy = Object.assign({}, S);
  delete copy.avatar;        // 再存一次时不再带正文
  try {
    localStorage.setItem('fong2', JSON.stringify(copy));
    S.avatar = 'idb';
  } catch (_) { /* 配额问题交给 save 的兜底 */ }
  return true;
}

/** 上传并保存头像。传空字符串表示恢复默认（首字母） */
async function saveAvatar(dataUrl) {
  await api('PATCH', '/api/me/avatar', { avatar: dataUrl });
  await putAvatar(S.uid, dataUrl);
  S.avatar = dataUrl ? 'idb' : '';   // localStorage 里只放占位，不放大图
  save();
  renderAll();
}

/** 打开头像设置：点方块选图，或清空 */
function openAvatarDialog() {
  const box = el('div', 'avbox');
  box.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:14px;padding:6px 0 2px';
  let cur = avatar(S.nick || '我', 'big', avatarOf(S.uid));
  cur.style.cssText += 'width:96px;height:96px;font-size:36px;cursor:pointer';
  const tip = el('div', 'hint', avatarOf(S.uid) ? '点头像换一张，或点下面「恢复默认」' : '点头像选一张图片');
  tip.style.cssText = 'font-size:12px';
  const fi = el('input');
  fi.type = 'file';
  fi.accept = 'image/png,image/jpeg,image/webp,image/gif';
  fi.style.display = 'none';

  const reset = el('button', 'btn ghost sm', '恢复默认');
  reset.onclick = async () => {
    try { await saveAvatar(''); tip.textContent = '已恢复默认'; reset.style.display = 'none'; }
    catch (e) { toast('保存失败：' + (e.message || e)); }
  };
  if (!avatarOf(S.uid)) reset.style.display = 'none';

  cur.onclick = () => fi.click();
  fi.onchange = async () => {
    const f = fi.files && fi.files[0];
    if (!f) return;
    tip.textContent = '处理中…';
    try {
      const url = await compressAvatar(f);
      await saveAvatar(url);
      // 重画预览
      const nw = avatar(S.nick || '我', 'big', avatarOf(S.uid));
      nw.style.cssText = cur.style.cssText;
      cur.replaceWith(nw);
      cur = nw;
      cur.onclick = () => fi.click();
      reset.style.display = '';
      tip.textContent = '已保存';
    } catch (e) {
      tip.textContent = '';
      toast(e.message || '上传失败');
    }
    fi.value = '';
  };

  box.append(cur, fi, reset, tip);
  return dialog({ title: '我的头像', ok: '完成', extra: box });
}

// ---- 右键/更多菜单 ----
function openMenu(x, y, items) {
  const m = $('menu'); m.innerHTML = '';
  // 【0.4.67】容忍 null / false —— 条件菜单项（如频道密码，没密码时只有"设置"没有"修改"）
  // 用三元表达式返回 null 比先 push 再 splice 干净，但不能让 null 崩进渲染循环。
  for (const it of items) {
    if (!it) continue;
    if (it === '-') { m.appendChild(el('hr')); continue; }
    if (it.label && !it.run) { m.appendChild(el('div', 'menu-label', it.label)); if (it.node) { const w = el('div', 'menu-range'); w.appendChild(it.node); m.appendChild(w); } continue; }
    const b = el('button', it.danger ? 'danger' : ''); b.setAttribute('role', 'menuitem');
    if (it.icon) b.appendChild(icon(it.icon));
    b.appendChild(el('span', null, it.text));
    b.onclick = () => { closeMenu(); it.run(); };
    m.appendChild(b);
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 8) + 'px';
  m.style.top = Math.min(y, innerHeight - r.height - 8) + 'px';
  const f = m.querySelector('button'); if (f) f.focus();
}
function closeMenu() { $('menu').classList.add('hidden'); }
document.addEventListener('mousedown', (e) => { if (!$('menu').contains(e.target)) closeMenu(); const hc = $('hoverCard'); if (hc && !hc.contains(e.target)) hideHoverCard(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeMenu(); hideHoverCard(); document.querySelectorAll('.modal:not(.hidden)').forEach((m) => { if (m.id !== 'onboard' && m.id !== 'dialog') m.classList.add('hidden'); }); $('shell').classList.remove('drawer'); }
});
const menuAt = (btn) => { const r = btn.getBoundingClientRect(); return [r.left, r.bottom + 4]; };

// ---- 提示音（合成，不需要音频文件） ----
let sfxCtx = null;
// 【0.4.50】系统通知统一出口。原来只有 @提及 那里裸调 new Notification，
// 没有级别、没有免打扰、也不受提示音音量控制。
function canNotify(kind) {
  if (S.dnd) return false;                       // 免打扰：一律不弹
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission !== 'granted') return false;
  const lv = S.notifyLevel || 'mention';
  if (lv === 'none') return false;
  if (lv === 'mention' && kind !== 'mention') return false;
  if (kind === 'mention') return true;
  if (kind === 'msg') return S.notifyOnMsg !== false;
  if (kind === 'join') return S.notifyOnJoin !== false;
  return true;
}
function notify(title, opts, kind) {
  if (!canNotify(kind || 'msg')) return false;
  try {
    const o = Object.assign({ silent: false }, opts || {});
    // 用提示音音量控制系统通知的响度（0 = 静音但仍显示）
    o.silent = (Number(S.toneVol) || 0) <= 0;
    const n = new Notification(title, o);
    n.onclick = () => { try { show(); } catch (_) {} try { n.close(); } catch (_) {} };
    return true;
  } catch (_) { return false; }
}

function sfx(kind) {
  if (!S.sounds || S.dnd) return;    // 【0.4.50】免打扰时也不放提示音
  // 调音台的「提示音」音量：缩放下面那个峰值，0 时直接不发声（不新增第二套提示音）
  const toneVol = Math.max(0, Math.min(100, Number(S.toneVol == null ? 100 : S.toneVol))) / 100;
  if (!(toneVol > 0)) return;
  const cueVol = ((window.FongWire && FongWire.ready) ? FongWire.cueGain() : 1) * toneVol;
  if (!(cueVol > 0)) return;
  sfxCtx = sfxCtx || ctxShared();
  const notes = { join: [523, 784], leave: [784, 523], selfjoin: [659, 988], mute: [440], unmute: [660], kicked: [300, 220] }[kind] || [600];
  const t0 = sfxCtx.currentTime;
  notes.forEach((f, i) => {
    const o = sfxCtx.createOscillator(); const g = sfxCtx.createGain();
    o.type = 'sine'; o.frequency.value = f;
    const t = t0 + i * 0.09;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(0.08 * cueVol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
    o.connect(g).connect(sfxCtx.destination); o.start(t); o.stop(t + 0.18);
  });
}

// ============ 控制面 API ============
// 【0.4.49】与 api() 同源的认证头。原生字节上传（文件）不能用 api()，
// 但认证方式必须一致，否则服务端 withSpace 直接 401。
function authHeaders() {
  return { 'X-Fong-Uid': S.uid, 'X-Fong-Key': S.key, 'X-Fong-Device': S.device || '' };
}

async function api(method, path, body, opts = {}) {
  if (!serverURL()) throw new Error('还没填服务器地址');
  let r;
  try {
    r = await fetch(serverURL() + path, {
      method, signal: opts.signal,
      headers: Object.assign(authHeaders(), body ? { 'content-type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { if (e.name === 'AbortError') throw e; const err = new Error('连不上服务器'); err.net = true; throw err; }
  if (r.status === 204) return null;
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(j.error || ('服务器错误 ' + r.status)); err.status = r.status; if (j.retryAfter) err.retryAfter = j.retryAfter; if (j.reason) err.reason = j.reason;
    // 【auth 联调】带 reason 的 401 = 新后端明确告诉我们"这台设备的登录已失效"（被顶掉 / 被移出 / 改密）。
    // 不带 reason 的 401（老服务端）维持原有处理，不在这里拦。登录类接口自己的 401（密码不对）也不拦。
    if (r.status === 401 && j.reason && !/^\/api\/auth\/(login|register|bind|code\/)/.test(path)) onSignedOut(err);
    // 【0.4.66】被封禁：403 + reason==='BANNED'
    // 两个关键点：
    //  a) silent=true —— 封禁期间几乎每个接口都返回它，act() 的 toast 会弹一串。
    //  b) 一次性 guard —— api() 是全局入口，封禁期每次轮询都会命中，
    //     没有 guard 会反复重绘遮罩 + 反复 renderAll，严重时卡死。
    // 作用域限定在 /api/spaces/ —— 与紧邻的 401 分支同理，但方向相反：
    // 401 是排除登录类接口，403 是【只认】空间类接口。
    // 否则将来任何其他接口返回 reason:'BANNED'（比如给登录加设备封禁），
    // 都会把用户直接踢到封禁页 —— 整个应用不可用。低概率，但触发即灾难。
    if (r.status === 403 && j.reason === 'BANNED' && /^\/api\/spaces\//.test(path)) {
      err.silent = true;
      err.banned = true;
      if (!window.__bannedShown) { window.__bannedShown = true; showBannedPage(); }
    }
    throw err;
  }
  return j;
}

// ============ 401 → 回登录门（按 reason 给文案） ============
let signingOut = false;
function onSignedOut(e, textOverride) {
  if (signingOut) return;
  signingOut = true;
  const text = textOverride || (window.FongWire && FongWire.reasonText && FongWire.reasonText(e)) || '登录状态已失效，请重新登录';
  try { if (pollAbort) pollAbort.abort(); } catch (_) {}
  pollAbort = null; pollSid = null;
  try { if (Room.joined) Room.leave(true); } catch (_) {}
  registered = false;
  // 已失效的 key 留着也没用；uid / 邮箱保留，重新登录回同一个账号时空间列表不丢
  S.key = ''; save();
  try { $('settings').classList.add('hidden'); } catch (_) {}
  showLoginGate();
  const m = $('lgMsg'); if (m) m.textContent = text;
  toast(text);
}
let registered = false;
async function register() {
  await api('POST', '/api/register', { id: S.uid, key: S.key, name: S.nick || '玩家' });
  registered = true;
  // 头像存在服务端（换设备、重装都还在），本地只是缓存。
  // 拉失败不影响启动 —— 拿不到就先用首字母。
  try {
    const me = await api('GET', '/api/auth/me');
    if (me && typeof me.avatar === 'string' && me.avatar && me.avatar !== avatarOf(S.uid)) {
      await putAvatar(S.uid, me.avatar);
      S.avatar = 'idb';
      save();
    }
  } catch (_) { /* ignore */ }
}

/**
 * 服务端数据被清过（换库、重装、清理测试数据）时，本地 uid 在服务端不存在。
 * /api/register 对未知 uid 是「新建」，所以用同一个 uid+key 重发一次就能原地恢复：
 *   - 服务端有别的 key → 说明是真冲突，才需要换身份
 *   - 服务端没这个 uid → 直接建回来，用户无感
 * 旧版这里只弹了个 banner，等于把用户永久卡死。
 */
async function recoverIdentity() {
  try {
    await api('POST', '/api/register', { id: S.uid, key: S.key, name: S.nick || '玩家' });
    registered = true;
    return true;
  } catch (e) {
    return false;
  }
}

// ============ 空间状态（长轮询） ============
const Spaces = new Map(); // id -> view
let pollAbort = null, pollSid = null;
const cur = () => Spaces.get(S.curSpace) || null;
const canManage = (v) => v && (v.myRole === 'owner' || v.myRole === 'admin');

async function loadSpace(sid) {
  try { const v = await api('GET', '/api/spaces/' + sid); Spaces.set(sid, v); return v; }
  catch (e) { if (e.status === 403 || e.status === 404) dropSpace(sid, e.message); throw e; }
}
function dropSpace(sid, why) {
  const name = Spaces.get(sid) ? Spaces.get(sid).name : '房间';
  Spaces.delete(sid);
  S.spaceIds = S.spaceIds.filter((x) => x !== sid);
  if (S.curSpace === sid) S.curSpace = S.spaceIds[0] || null;
  save();
  if (Room.joined && Room.sid === sid) Room.leave(true);
  if (why) toast(`「${name}」：${why}`);
  renderAll(); startPoll();
}
function startPoll() {
  if (pollSid === S.curSpace && pollAbort) return;
  if (pollAbort) pollAbort.abort();
  pollSid = S.curSpace; pollAbort = null;
  if (!pollSid || !registered) return;
  const ctl = new AbortController(); pollAbort = ctl;
  (async () => {
    let fails = 0;
    while (!ctl.signal.aborted && pollSid) {
      const v0 = Spaces.get(pollSid);
      try {
        const v = await api('GET', '/api/spaces/' + pollSid + (v0 ? '?since=' + v0.version : ''), null, { signal: ctl.signal });
        fails = 0;
        onSpaceUpdate(pollSid, v0, v);
      } catch (e) {
        if (ctl.signal.aborted) return;
        if (e.status === 403 || e.status === 404) { dropSpace(pollSid, e.message); return; }
        fails++; await sleep(Math.min(15000, 1000 * 2 ** Math.min(fails, 4)));
      }
    }
  })();
}
function onSpaceUpdate(sid, before, v) {
  // 【0.4.66】我被封禁了：跳封禁页，别让主界面继续渲染一个空空间
  if (v && v.banned === true) {
    Spaces.set(sid, v);
    showBannedPage(v.name);
    return;
  }
  // 恢复正常（管理员解封后）：把封禁页收掉
  if (window.__bannedShown) hideBannedPage();
  Spaces.set(sid, v);
  // 进出提示音 + 被踢/被静音处理
  if (Room.joined && Room.sid === sid) {
    const rv = v.rooms.find((r) => r.id === Room.rid);
    if (!rv) { Room.leave(true); banner('这个频道被删除了'); return; }
    const now = new Set(rv.members.map((m) => m.peer));
    const prev = Room.lastPeers;
    if (prev) {
      for (const p of now) if (!prev.has(p) && p !== Room.peerId) {
        sfx('join'); NATIVE && NATIVE.flash();
        // 【0.4.50】有人进频道 → 走统一通知出口（受通知级别/免打扰约束）
        if (document.hidden) notify('有人进入频道', { body: Room.peerId ? '' : '' }, 'join');
      }
      for (const p of prev) if (!now.has(p) && p !== Room.peerId) sfx('leave');
    }
    Room.lastPeers = now;
    const me = v.members.find((m) => m.id === S.uid);
    const wasMuted = Mic.serverMuted;
    Mic.serverMuted = !!(me && me.muted);
    if (Mic.serverMuted && !wasMuted) { banner('你被管理员静音了，别人暂时听不到你', null, null, true); sfx('mute'); }
    if (!Mic.serverMuted && wasMuted) { hideBanner(); toast('管理员已取消你的静音'); }
    Room.syncAudio();
  }
  // 文字频道：长轮询被唤醒说明空间有变化，拉一把增量消息。
  // 主路径是这个；下面那个定时器只是长轮询断线时的兜底。
  if (chatKey && chatKey.indexOf(sid + ':') === 0) pollText();
  refreshUnread().catch(() => {});   // 空间有变化顺手对一遍未读
  renderAll();
}

// ============ SDP：PRD 第 4 章 Opus 参数 ============
// 注：rtpmap 必须写 opus/48000/2（RFC 7587 规定 Opus 永远标 2 声道），真正决定单声道的是 fmtp 的 stereo=0。
function tuneOpus(sdp, isRemote) {
  const lines = sdp.split(CRLF);
  let pt = null;
  for (const l of lines) { const m = l.match(/^a=rtpmap:(\d+) opus\/48000\/\d$/i); if (m) { pt = m[1]; break; } }
  if (pt === null) return sdp;
  const want = { minptime: '10', useinbandfec: '1', usedtx: '0', stereo: '0', 'sprop-stereo': '0', maxaveragebitrate: String(opusKbps() * 1000), cbr: '1' };
  const prefix = 'a=fmtp:' + pt + ' ';
  const out = []; let inAudio = false, hasPtime = false, hasFmtp = false;
  const closeSection = () => { if (inAudio && isRemote && !hasPtime) out.push('a=ptime:10'); };
  for (const l of lines) {
    if (l.startsWith('m=')) { closeSection(); inAudio = l.startsWith('m=audio'); hasPtime = false; }
    if (inAudio && l.startsWith('a=ptime:')) { if (isRemote) { out.push('a=ptime:10'); hasPtime = true; } continue; }
    if (l.startsWith(prefix)) {
      hasFmtp = true;
      const kv = {};
      l.slice(prefix.length).split(';').forEach((p) => { const [k, v] = p.split('='); if (k) kv[k.trim()] = (v || '').trim(); });
      Object.assign(kv, want);
      out.push(prefix + Object.entries(kv).map(([k, v]) => k + '=' + v).join(';'));
      continue;
    }
    out.push(l);
  }
  let tail = []; while (out.length && out[out.length - 1] === '') tail.push(out.pop());
  closeSection(); out.push(...tail);
  if (!hasFmtp) {
    const i = out.findIndex((l) => l.startsWith('a=rtpmap:' + pt + ' '));
    out.splice(i + 1, 0, prefix + Object.entries(want).map(([k, v]) => k + '=' + v).join(';'));
  }
  return out.join(CRLF);
}
// 远端 SDP 里每个 m-line 的 mid -> 发送者（msid 的 stream id = 服务端 peerID）
function midOwners(sdp) {
  const map = {}; let mid = null;
  for (const l of sdp.split(CRLF)) {
    if (l.startsWith('m=')) mid = null;
    const a = l.match(/^a=mid:(.+)$/); if (a) mid = a[1];
    const b = l.match(/^a=msid:(\S+)/); if (b && mid != null) map[mid] = b[1];
  }
  return map;
}

// ============ 设备 ============
let devices = { in: [], out: [] };
// 「Default - 麦克风 (3- USB PnP Sound Device) (0d8c:0014)」→「USB PnP Sound Device（系统默认）」
const cleanLabel = (l) => {
  let s = (l || '').replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '');
  let tag = '';
  const m0 = s.match(/^(Default|Communications|默认|通讯) - /);
  if (m0) { tag = /^(Default|默认)/.test(m0[1]) ? '（默认）' : '（通讯）'; s = s.slice(m0[0].length); }
  const m1 = s.match(/^[^()]{1,12}\((.+)\)$/); // 「麦克风 (xxx)」「扬声器 (xxx)」「耳机 (xxx)」
  if (m1) s = m1[1];
  s = s.replace(/^\d+-\s*/, '').trim();
  return s ? s + tag : '';
};
const fullLabel = (l) => (l || '').replace(/^(Default|Communications) - /, (m, a) => (a === 'Default' ? '系统默认 - ' : '通讯默认 - ')).replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)$/i, '');
function syncSelTitle(sel) { const o = sel.options[sel.selectedIndex]; sel.title = o ? (o.dataset.full || o.textContent) : ''; }
async function listDevices() {
  const all = await navigator.mediaDevices.enumerateDevices();
  devices.in = all.filter((d) => d.kind === 'audioinput');
  devices.out = all.filter((d) => d.kind === 'audiooutput');
  for (const [ids, list, key, fallback] of [[['micSel', 'obMic', 'setMic'], devices.in, 'mic', '麦克风'], [['spkSel', 'obSpk', 'setSpk'], devices.out, 'spk', '扬声器']]) {
    for (const id of ids) {
      const sel = $(id); sel.innerHTML = '';
      if (!list.length) { const o = el('option', null, '没有找到' + fallback); o.value = ''; sel.appendChild(o); sel.disabled = true; continue; }
      sel.disabled = false;
      list.forEach((d, i) => { const o = el('option', null, cleanLabel(d.label) || fallback + ' ' + (i + 1)); o.value = d.deviceId; o.dataset.full = fullLabel(d.label) || o.textContent; sel.appendChild(o); });
      sel.value = list.some((d) => d.deviceId === S[key]) ? S[key] : list[0].deviceId;
      // 【0.4.17】输出/输入设备失效自愈：S 里存的设备已不在列表 → 回系统默认并提示
      if (S[key] && S[key] !== 'default' && !list.some((d) => d.deviceId === S[key])) {
        toast((key === 'mic' ? '麦克风' : '扬声器') + '设备已失效，已切回系统默认');
        S[key] = 'default'; save();
      }
      syncSelTitle(sel);
    }
  }
}
navigator.mediaDevices.addEventListener('devicechange', async () => {
  const had = new Set(devices.in.map((d) => d.deviceId));
  await listDevices();
  // 正在用的麦被拔了：自动切回默认
  if (S.mic !== 'default' && !devices.in.some((d) => d.deviceId === S.mic) && had.has(S.mic)) { toast('麦克风断开了，已切回默认'); S.mic = 'default'; save(); Mic.start(true).catch(micError); }
});
function audioConstraints() {
  return {
    deviceId: S.mic && S.mic !== 'default' ? { exact: S.mic } : undefined,
    channelCount: 1, sampleRate: 48000, sampleSize: 16,
    // 【0.4.42】AEC 开启时强制关掉浏览器 AGC：AGC 在通话中动态改增益，
    // 会破坏 AEC 赖以工作的"线性回声路径"假设，实测能吃掉 5~10 dB 的抑制量。
    // （Chrome 把这两个开关分开给是有道理的：要 AEC 就别要浏览器 AGC。）
    // 【0.4.73 · 独立审查 §1.5 修正】两层 AEC 串联必须先关掉浏览器那层。
    //
    // 原来 S.aec=true 时这里请求 Chromium 自带 AEC3（echoCancellation:true），
    // 而 native（sonora AEC3）又拿 far 参考做第二层。Chromium 的 NLP/残余抑制
    // 是【非线性】的 —— 第二层看到的 near 已被第一层改形，线性自适应滤波的假设失效，
    // W 无法收敛。两层串联不如只用一层。
    // 现在：native AEC 负责消回声（它拿得到 far 参考），浏览器那层关掉。
    echoCancellation: false, noiseSuppression: S.ns, autoGainControl: S.aec ? false : S.agc,
  };
}
function micError(e) {
  const msg = e && e.name === 'NotAllowedError' ? '麦克风权限被拒绝。到 Windows 设置 → 隐私 → 麦克风里允许 FONG。'
    : e && e.name === 'NotFoundError' ? '没找到麦克风，插上后再试。'
    : e && e.name === 'NotReadableError' ? '麦克风被别的程序独占了，关掉它再试。'
    : '麦克风打不开：' + (e && e.message);
  banner(msg, '重试', () => Mic.start(true).then(listDevices).catch(micError));
}

// ============ 本地采集：电平 / 语音门 / 按键说话 / 闪避 ============
const Mic = {
  stream: null, track: null, sendTrack: null, rawTrack: null, actx: null, an: null, buf: null, timer: null,
  denoiseOn: false,
  db: -90, open: false, hold: 0, muted: false, deafened: false, serverMuted: false, ptt: false,
  sender: null, sending: null, duckGain: 1, speaking: false,
  async start(force) {
    // 【0.4.29】幂等：链路完好就复用，**绝不重建** Denoise 链与 worker 绑定。
    // 实测（native_trace 60 s 时间序列，打包版）：
    //   t=0~3   ctrl=[260,260,260,260,1,1,260,...]  → 有绑定
    //   t=4 第二次 Mic.start() 之后 ctrl 恒定全 0、workerReady 永远 false ——
    //   worker 与新 SAB 的绑定从此失效，降噪整场不再启动（只剩直通/守护旁路）。
    // 需要真正重建的场景（换设备、麦克风报错、拔麦）显式传 force=true。
    if (!force && this.stream && this.rawTrack && this.rawTrack.readyState === 'live' &&
        this.actx && this.actx.state !== 'closed' && this.track && this.timer) {
      return this.track;
    }
    // 开了 AI 降噪就关掉浏览器降噪，避免两层降噪叠加
    // 【0.4.32】档位 3（自然档）的 native 实现已修好（fong_dsp::light 的门限估计）
    // 与 1（低占用）一起恢复原语义：
    //   1 = 低占用（RNNoise）　2 = 质量（GTCRN）　3 = 自然（高通 + 自适应噪声门）
    const dnMode = (S.denoiseMode == null) ? 2 : (S.denoiseMode | 0);
    const wantDenoise = dnMode > 0;
    const c = audioConstraints();
    if (wantDenoise) { c.noiseSuppression = false; }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: c });
    this.stop(true);
    this.stream = stream;
    this.rawTrack = stream.getAudioTracks()[0];
    this.track = this.rawTrack;
    // 拔麦检测挂在原始轨道上（处理后的轨道不会 ended）
    this.rawTrack.onended = () => { if (this.rawTrack && this.rawTrack.readyState === 'ended') micError({ name: 'NotReadableError' }); };

    this.actx = ctxShared();   // 【0.4.24】不再每次新建：运行期新建会打死 native 降噪

    // ---- 降噪链路 ----
    this.denoiseOn = false;
    // 无论哪一档都要写入，否则关掉降噪后 native 还停在上一次的档位。
    // Worker 模式下 native 实例在 Worker 线程里，必须走 Denoise.setMode 投递过去；
    // 只有兜底路径（主线程处理）才需要直接调 preload 桥。
    if (window.Denoise && window.Denoise.setHfTilt) {
      window.Denoise.setHfTilt(S.hfTilt == null ? 3 : Number(S.hfTilt));
    }
    if (window.Denoise && window.Denoise.setMode) {
      window.Denoise.setMode(dnMode);
    } else if (window.Denoise && window.Denoise._b) {
      const b0 = window.Denoise._b();
      if (b0 && b0.denoiseSetMode) b0.denoiseSetMode(dnMode);
    }
    // 【0.4.43】条件从 `wantDenoise` 放宽成 `wantDenoise || S.aec`。
    // AEC 跑在降噪 worker 里，但它是独立的一级 —— 用户把降噪关掉（或守护旁路）时，
    // AEC 必须照常工作。原来降噪一关整块被跳过，AEC 连 SAB 都没建，
    // 界面就卡在「回声消除已开启 · 等待通话数据…」（实测踩到）。
    if ((wantDenoise || S.aec) && window.Denoise) {
      // 【0.4.35 · 独立审查修正】far-end 参考 SAB 必须在这里就建好，并随 init 消息交给 worker。
      // 原来的做法是 setFarSab() 事后重发 'attach' —— 但 worker 主循环在通话中从不让出事件循环，
      // 那条消息永远轮不到（实测 farBound=false、far=0、ERLE 0.46 dB，纯白付 CPU）。
      // init 消息在音频开始流动前必然被派发，是唯一可靠的时机。
      // 【独立审查 · 0.4.45】复用进程内唯一的 far 环，绝不新建 —— 见 AEC_FAR_SAB 的说明。
      const farSab = (S.aec && typeof SharedArrayBuffer !== 'undefined') ? AEC_FAR_SAB : null;
      if (farSab && window.Denoise && Denoise.setFarSab) Denoise.setFarSab(farSab);
      else if (window.Denoise && Denoise.setAec) Denoise.setAec(false);

      const ok = await Denoise.init(this.actx);
      if (farSab) {
        const farOk = await AecRef.start(this.actx, farSab);
        if (farOk) {
          Denoise.setAec(true);
          AecRef.resync();   // 【独立审查 · 0.4.45】start() 里 stop() 清了 srcs，这里立刻按现场挂回去
          AecRef.watch();    // 【独立审查 · 0.4.45】far 环写指针看门狗（停滞 2 秒自愈）
          console.log('[audio-diag] AEC 已启用（far 参考随 init 下发，现场挂载 ' + AecRef.trackCount() + ' 条）');
        }
        else { Denoise.setAec(false); console.warn('[audio-diag] AEC 参考链启动失败，已关闭 AEC'); }
      }
      if (ok) {
        const processed = Denoise.attach(this.actx, this.rawTrack);
        if (processed) {
          this.track = processed;   // 发送链路改用处理后的轨道
          this.denoiseOn = true;
          const tag = dnMode === 3 ? '自然' : (dnMode === 1 ? '低占用' : '质量');
          banner((dnMode === 3 ? '降噪已开启 · ' : 'AI 降噪已开启 · ') + tag + '（处理 ' + Denoise.latencyMs.toFixed(0) + ' ms ＋ 缓冲 40 ms）', null);
        }
      }
      if (!this.denoiseOn && Denoise.failed) {
        banner('降噪不可用，已回退浏览器降噪：' + Denoise.failed, null);
      }
    }

    // 【P0-A】把 VAD 挂到降噪后的轨道上（音频线程跑，主线程不再定时判定）。
    // 挂不上就保持旧的 tick 路径，不阻塞进房。
    if (window.FongVad) {
      // 【0.4.21 · 实测定案】VAD 必须挂在门控之前的信号上，否则自锁：
      // 门控关 → VAD 源（=门控后的 dest 轨）静音 → open 永远 false → 门控保持关闭。
      // 实测（打包版 0.4.20，两个真客户端）：B 端 open=false/db=-51，对端 totalAudioEnergy=0。
      // 【0.4.22】降噪开启时必须**按节点**挂 VAD（Denoise.node 的输出 = 门控前）。
      // 不能给它一条 MediaStreamAudioDestinationNode 生成的轨 —— 同 ctx 采不回来，
      // VAD 永远读到 0 → 判无声 → 门控永关（自锁），这就是「说话对方完全听不到」的真根因。
      const vadCfg = { thrDb: S.thr, holdMs: 240, bypass: S.mode === 'ptt' };
      const vadOk = (this.denoiseOn && window.Denoise && Denoise.node && FongVad.attachFromNode)
        ? await FongVad.attachFromNode(this.actx, Denoise.node, vadCfg)
        : await FongVad.attach(this.actx, this.track, vadCfg);
      if (vadOk) {
        FongVad.onGate = (open) => { Mic.open = open; };
        FongVad.onLevel = (db) => { Mic.db = db; };
        // 【0.4.46】worklet 只在状态【翻转】时 postMessage；如果它在 onGate 赋值之前
        // 就已经翻成 open=true，之后一直保持不变，回调永远不会再来 —— Mic.open 就卡在 false，
        // 门控关门、对方静音。这里把「当前已知状态」立刻回灌一次，消除这个时序空洞。
        try {
          if (typeof FongVad.open === 'boolean') Mic.open = FongVad.open;
          if (typeof FongVad.db === 'number') Mic.db = FongVad.db;
        } catch (_) {}
      } else {
        console.warn('[vad] worklet 挂载失败，回退主线程 tick：' + FongVad.failed);
      }
    }

    // 电平分析器：分析降噪后的信号（语音门看处理后的电平）
    // 【0.4.46】重建前必须先拆掉上一条分析链：Denoise.node.connect(this.an) 这个边没人负责断，
    // 每次 Mic.start 都会在旧 node 上留一条通往已废弃 analyser 的连接。
    // 实测表现：通话中切 AEC/降噪 → Mic.db 恒 -95、VAD 永远判无声 → 门控关门 → 对方静音。
    // （srcPeak 同时是 0.4，说明源是好的，坏的是这条分析链。）
    try { if (this.an) { this.an.disconnect(); } } catch (_) {}
    try { if (this.srcNode) { this.srcNode.disconnect(); this.srcNode = null; } } catch (_) {}
    this.an = this.actx.createAnalyser(); this.an.fftSize = 1024; this.an.smoothingTimeConstant = 0.3;
    this.srcNode = null;
    if (this.denoiseOn) {
      // 注意：不能对 dest.stream 再 createMediaStreamSource 采回来（同 context 读不到）
      Denoise.tap(this.an);
    } else {
      this.srcNode = this.actx.createMediaStreamSource(new MediaStream([this.track.clone()]));
      this.srcNode.connect(this.an);
    }
    // 【0.4.22】analyser 没有下游时 Chromium 不会拉取上游 → 电平恒 0（Mic.db 一直是 -51 的原因）。
    // 给分析链接一个零增益 destination，只为了让它被渲染，不出声。
    try {
      if (!this.anSink) this.anSink = this.actx.createGain();
      this.anSink.gain.value = 0;
      this.an.connect(this.anSink);
      this.anSink.connect(this.actx.destination);
    } catch (_) {}
    this.buf = new Float32Array(this.an.fftSize);
    // 【0.4.11】P0-G 的 track.enabled 静音会连累所有消费者——耳返 Loop 播的就是这条轨。
    // 发送门控改用独立克隆轨：Mic.track 永远 enabled（耳返/电平表正常），sender 只喂 sendTrack。
    if (this.sendTrack) { try { this.sendTrack.stop(); } catch (_) {} }
    // 【0.4.21 · 实测定案】降噪开启时 Mic.track 是 MediaStreamAudioDestinationNode 的输出轨。
    // 对这种轨做 clone()，再用 track.enabled 做门控，会触发自锁：
    //   enabled=false → 该轨没有消费者 → Chromium 停止渲染整条 ctx 图 →
    //   worklet 直通也不再产出 → Mic.an 读到 -51 dB → VAD 判无声 → 门控永久关闭。
    // 实测（打包版 0.4.20，两个真客户端经线上 SFU）：B 端 open=false、sendEnabled=false、
    // peakSendTrack=0.0000、peakMicTrack=0.004、对端 totalAudioEnergy=0 —— 就是「说话没声音」。
    // 修法：降噪开启时发送轨直接用 dest 本体（常驻 enabled），门控走 Denoise.setGate()。
    if (this.denoiseOn && window.Denoise && Denoise.setGate) {
      this.sendTrack = this.track;
      if (Denoise.setGate) Denoise.setGate(1);
      this.gateMode = true;
    } else {
      this.sendTrack = this.track.clone();
      this.gateMode = false;
    }
    this.sendTrack.enabled = true;
    // 【0.4.17】发送轨自检表：说话时克隆轨静默 = 发送链断（可自动重建）
    // 【0.4.73 · 独立审查 §2.5】旧 sendAn 与其 source 从不 disconnect，每次 Mic.start 泄漏一对。
    try { if (this._sendSrc) { this._sendSrc.disconnect(); this._sendSrc = null; } } catch (_) {}
    try { if (this.sendAn) this.sendAn.disconnect(); } catch (_) {}
    this.sendAn = this.actx.createAnalyser(); this.sendAn.fftSize = 512;
    this._sendSrc = this.actx.createMediaStreamSource(new MediaStream([this.sendTrack]));
    this._sendSrc.connect(this.sendAn);
    // 【0.4.30】必须给这条分析链接一个零增益 destination：analyser 没有下游时 Chromium
    // 不拉取上游，读数恒在 -60 dB 以下 —— 于是 tick 里的「发送轨静默」自检每 20 ms 触发一次，
    // 疯狂重建克隆轨（实测日志刷满、track 不断泄漏）。这是同一个坑第三次出现。
    try {
      const z = this.actx.createGain(); z.gain.value = 0;
      this.sendAn.connect(z); z.connect(this.actx.destination);
    } catch (_) {}
    this.sendBuf = new Float32Array(this.sendAn.fftSize);
    this.sending = null; // 强制下一帧重新同步发送状态
    // 【0.4.21 · 降噪电平守护】降噪链挂上后 1.5 秒量一次实际输出。
    // 实测（打包版 0.4.20 + native ORT，真实麦克风等价条件）：rawTrack 峰值 0.40、
    // 降噪链输出 0.004（-40 dB）、VAD 判无声 → 门控永久关闭 → 对端 totalAudioEnergy=0。
    // 用户上一轮自己的实测也是同型：降噪开 0.0022 / 降噪关 0.0560。
    // 这里一旦测到异常就自动旁路回原始麦 —— 宁可没降噪，也不能没声音。
    clearInterval(this._dnTimer);
    if (this.denoiseOn) {
      this._dnBad = 0;
      setTimeout(() => this._startDenoiseGuard(), 1000);
    }
    if (Loop.on) Loop.attach();
    this.tick();
    return this.track;
  },
  stop(keepLoop) {
    clearTimeout(this.timer);
    clearInterval(this._dnTimer);
    // actx 马上要被关掉，所以 worklet 节点必须一起拆（AudioNode 不能跨 context）
    if (window.Denoise) { Denoise.teardown(); }
    // VAD worklet 也挂在同一个 actx 上，一起拆；ready 复位让下次 start 重新 attach
    if (window.FongVad) { FongVad.detach(); FongVad.ready = false; }
    this.denoiseOn = false;
    if (this.stream) this.stream.getTracks().forEach((t) => t.stop());
    if (this.sendTrack) { try { this.sendTrack.stop(); } catch (_) {} this.sendTrack = null; }
    if (this.rawTrack && this.rawTrack !== this.track) { try { this.rawTrack.stop(); } catch (_) {} }
    // 【0.4.24】共享 ctx 不关闭：关了之后所有模块的图都失效，而且新建 ctx 会打死降噪
    this.track = this.rawTrack = null;
    this.stream = this.track = this.actx = this.an = null;
    /* 【0.4.59】耳返与采集生命周期解耦，不再随 stop 关掉 */
  },
  wantSend() {
    if (this.muted || this.deafened || this.serverMuted) return false;
    return S.mode === 'ptt' ? this.ptt : this.open;
  },

  // 【0.4.23 · 静默省流，不碰音质】
  // 产品定位是「256 kbps 顶配音质」，所以说话时必须给满档；但静默期的 256 kbps CBR
  // 全是静音帧，一点音质也不贡献（实测静默与说话同为 281.6 kbps，一小时 124 MB/人）。
  // 这里用 RTCRtpSender.setParameters 动态改 maxBitrate：说话 320 kbps 上限（256k 音频 + 开销），
  // 静默 24 kbps。包照发、时间轴连续 —— P0-G 那条「不停发」的原则不受影响，延迟不变。
  setSendBitrate(loud) {
    const s = this.sender;
    if (!s || typeof s.setParameters !== 'function') return;
    try {
      const p = s.getParameters();
      if (!p.encodings || !p.encodings.length) return;
      const want = loud ? 320000 : 24000;
      const enc = p.encodings[0];
      if (enc.maxBitrate === want) return;
      enc.maxBitrate = want;
      p.encodings = [enc];
      s.setParameters(p).catch(() => {});
      if (!this._brLogged || this._brLogged !== want) {
        this._brLogged = want;
        console.log('[audio-diag] 上行码率上限 → ' + (want / 1000) + ' kbps（' + (loud ? '说话档' : '静默档') + '）');
      }
    } catch (_) { /* setParameters 失败不影响通话 */ }
  },

  // 量一条轨的峰值：analyser 必须接一个零增益 destination，否则分析链不被渲染、读数恒 0
  async _peak(track, ms) {
    if (!track) return -1;
    // 【0.4.73 · 独立审查 §2.5 修正】绝不能用 ctxShared() + close()。
    // 原代码 finally 里 ctx.close() —— 一旦 _peak 被调用就会把【全应用的共享 AudioContext】关掉，
    // 所有 AudioWorkletNode 立即失效，与文件头注释记录的"关掉 ctx 后 native 输出归零且不可逆"一致。
    // 目前全仓无调用点（哑弹），但任何人加了调用就是"必须重启应用"级别的故障。
    // 现在自建临时 ctx，用完关自己。
    let ctx = null;
    let src = null;
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
      await ctx.resume();
      const an = ctx.createAnalyser(); an.fftSize = 1024;
      const g = ctx.createGain(); g.gain.value = 0;
      src = ctx.createMediaStreamSource(new MediaStream([track]));
      src.connect(an);
      an.connect(g); g.connect(ctx.destination);
      const buf = new Float32Array(1024);
      const t0 = performance.now();
      let peak = 0;
      while (performance.now() - t0 < (ms || 1000)) {
        await new Promise((r) => setTimeout(r, 40));
        an.getFloatTimeDomainData(buf);
        for (const v of buf) peak = Math.max(peak, Math.abs(v));
      }
      return peak;
    } catch (_) {
      return -1;
    } finally {
      try { if (src) src.disconnect(); } catch (_) {}
      try { if (ctx) ctx.close(); } catch (_) {}
    }
  },

  // 【0.4.22 · 降噪链守护（同 ctx 电平判据 + 周期复检）】
  //
  // 实测事实（真客户端，`work/e2e/e2e_desk.mjs` 的进房前后对照）：
  //   进房前：raw 0.4000 / 降噪输出 0.2025 / Mic.db −23.6 / VAD open=true
  //   进房后：raw 0.4000 / 降噪输出 0.0040 / Mic.db −50.9 / VAD open=false → 门控永关、对端 totalAudioEnergy=0
  //   而 worker 一直在消费输入（ctrl 的 IN_W/IN_R 持续增长、diag.sent 上千、bypass=false）——
  //   即 native 推理的输出在进房后变成全零。属于 AI 降噪链路本身的问题（待专项），
  //   但绝不能让它把「说话」一起带走，所以这里做周期性电平复检 + 自动旁路。
  //
  // 判据必须满足两条，否则会误杀：
  //   1) 只能在 Mic.actx **内部**测量（跨 AudioContext 采 WebAudio 生成的轨读不到真实数据）；
  //   2) analyser 要接一个零增益 destination，否则上游不被渲染、读数恒 0（就是 Mic.db=-51 的老坑）。
  _meterCtx(connectFn, ms) {
    const ctx = this.actx;
    if (!ctx || ctx.state === 'closed') return Promise.resolve(-1);
    const an = ctx.createAnalyser(); an.fftSize = 1024; an.smoothingTimeConstant = 0;
    const g = ctx.createGain(); g.gain.value = 0;
    let hooked = null;
    try { hooked = connectFn(an); an.connect(g); g.connect(ctx.destination); } catch (_) { return Promise.resolve(-1); }
    const buf = new Float32Array(1024);
    const t0 = performance.now();
    let peak = 0;
    return new Promise((res) => {
      const id = setInterval(() => {
        try { an.getFloatTimeDomainData(buf); for (const v of buf) { const a = Math.abs(v); if (a > peak) peak = a; } } catch (_) {}
        if (performance.now() - t0 >= (ms || 800)) {
          clearInterval(id);
          try { an.disconnect(); g.disconnect(); } catch (_) {}
          // 【0.4.73 · 独立审查 §2.5】原来的 hooked.disconnect(an) 只断「source → analyser」这条边，
          // source 节点本身仍持有对 rawTrack 的引用，不会释放。
          // 守护每 3 秒跑一次，一小时累计 ~1200 个 MediaStreamAudioSourceNode。
          // 无参 disconnect() 会断开该节点的【所有】出边，配合把引用置空才能真正释放。
          try { if (hooked && hooked.disconnect) hooked.disconnect(); } catch (_) {}
          hooked = null;
          res(peak);
        }
      }, 40);
    });
  },

  _startDenoiseGuard() {
    // 【唯一复位入口】只有两个调用点：
    //   · Mic.start() 里 setTimeout(..., 1000)  —— 链重建后重启守护
    //   · 旁路恢复路径（4 秒后）
    // 【依赖】切档必须走 Mic.start() 重建链（changeMic:3567 与档位按钮都走它）。
    // 如果哪天有人优化成"切档只给 worker 发 setMode、不重建主线程链"，
    // 这里的基线复位就不会发生 —— 0.4.66 修的偶发旁路会【无声复活】
    // （不报错，只是偶尔旁路一下，测试要连跑 6 次才碰得到一次）。
    // 改切档路径前先看这段。
    clearInterval(this._dnTimer);
    this._dnBad = 0;
    // 【0.4.66】重建后必须重置 sent 基线。
    // 切档会重建 worker，sent 从 300+ 掉回 0；如果沿用旧基线，
    // 下一轮 tick 会看到 sent=0 且 ratio 极小而直接进 _dnBad++。
    // 实测：连切 7 档时第 6 次偶发触发旁路（6 跑 2 次）。
    this._lastSentV = null;
    this._lastSentStall = 0;
    // 重建后的静默窗口：worker 冷启动 + worklet 预热期间 sent=0 是正常的，
    // 这段时间不判故障（与 _dnBad 的两轮确认叠加，总共给约 10 秒余量）。
    this._dnWarmUntil = Date.now() + 6000;
    // 周期复检：链路可能一开始正常、进房后（或运行一段时间后）才坏。
    // 3 秒一轮、首检 4 秒 —— 降噪一旦输出异常（实测会掉到原始的 1%~7%），
    // 对端在 6~9 秒内就恢复有声，而不是等十几秒。
    this._dnTimer = setInterval(() => this._denoiseGuardTick(), 3000);
    setTimeout(() => this._denoiseGuardTick(), 4000);
  },

  async _denoiseGuardTick() {
    try {
      const D = window.Denoise;
      if (!this.denoiseOn || !D || !D.node || !this.rawTrack || this.track === this.rawTrack) return;
      // 【0.4.45】判据从 ctrlReady 换成「实际观测量」。
      // ctrlReady 是 worker 写进 SAB 16 号槽的握手位，重建后可能假性停在 0（独立审查实测），
      // 拿它当唯一判据会让守护在最需要它的时候静默跳过。真正该问的是：
      // 「worker 还在不在消费输入」—— 看 sent 计数有没有涨。
      if (D.bypassed) return;
      const dg = window.__denoiseDiag || (typeof D.diag === 'function' ? D.diag() : null);
      const sent = dg && typeof dg.sent === 'number' ? dg.sent : null;
      if (sent != null) {
        if (this._lastSentV == null) { this._lastSentV = sent; return; }   // 首次只记基线
        if (sent === this._lastSentV && !D.ctrlReady) {
          // worker 确实不消费了 —— 这才该判（且下面会走「跳过降噪」而不是「丢弃 AEC」）
          this._lastSentStall = (this._lastSentStall || 0) + 1;
          if (this._lastSentStall < 3) return;      // 连续 3 个周期（9 秒）不动才认定
        } else { this._lastSentV = sent; this._lastSentStall = 0; }
      } else if (!D.ctrlReady) {
        return;                                      // 拿不到 diag 又没握手位：保守不动
      }
      const raw = await this._meterCtx((an) => this.actx.createMediaStreamSource(new MediaStream([this.rawTrack])).connect(an), 800);
      // 【0.4.61 · 实测修复】_meterCtx 失败时返回 -1（ctx 已关 / connect 抛错），
      // 原来这个 -1 直接参与后面的 ratio 计算：-1 / 0.2993 = -3.34，永远小于任何 floor
      // → 被判成「输出全零异常」→ 触发旁路 → 降噪整条链静默失效。
      // 实测日志：`降噪链输出异常第 1 次：raw=0.2993 out=-1.0000`，随后 bypass=true、ctrlReady=false。
      // 测量失败 ≠ 链路故障：测不到就跳过这一轮，不能据此下结论。
      if (!(raw > 0)) return;                          // -1 或 0：测量失败/没在说话，不动
      if (raw <= 0.01) return;                         // 没在说话，不动
      const out = await this._meterCtx((an) => D.node.connect(an), 800);
      if (!(out >= 0)) {                               // -1 = 测量失败，本轮不判
        return;
      }
      const ratio = out / raw;
      // 【0.4.40】AEC 开着时输出本来就该变小 —— 那是它在消回声，不是链路坏了。
      // 拿统一的 0.2 当异常线会在外放场景下把「AEC 正常工作」误判成故障，进而把整条链丢掉。
      // 【0.4.59 · 独立审查】判据方向原来错了：ratio = 输出RMS/输入RMS，
      // 而降噪正常工作时这个比值本来就小（实测质量档稳态 raw=0.03406 out=0.00006 ratio=0.002）。
      // 于是"降噪越好越被判成输出全零异常" → 永久旁路 → 用户以为降噪没启用。
      // 【0.4.66】重建后的静默窗口内不判故障：这段时间 sent=0 是正常的
      if (this._dnWarmUntil && Date.now() < this._dnWarmUntil) return;
      const outSilent = out < 1e-5;
      const alive = !outSilent && (sent == null || sent > 0);
      if (alive || ratio >= 0.2) {
        if (this._dnBad) console.log('[audio-diag] 降噪链恢复正常（raw=' + raw.toFixed(4) + ' out=' + out.toFixed(4) + '）');
        this._dnBad = 0;
        return;
      }
      this._dnBad++;
      console.warn('[audio-diag] 降噪链输出异常第 ' + this._dnBad + ' 次：raw=' + raw.toFixed(4) + ' out=' + out.toFixed(4) + '（worker 活跃但输出全零）');
      if (this._dnBad < 2) return;
      this._dnBad = 0;
      clearInterval(this._dnTimer);
      // 【0.4.40】关键修正：旁路【只跳过降噪】，AEC 结果必须留在链上。
      // 原来这里直接把发送轨换成原始麦克风 —— 等于把 AEC 消完的回声又放回去，
      // 实测表现就是「回声消除开着、ERLE 0.4 dB」（红字提示还在，但 AEC 已经不在链路里了）。
      if (D.setDenBypass) {
        D.setDenBypass(true);
        console.warn('[audio-diag] 已跳过降噪（回声消除保留在链上）');
        // 【0.4.59 · 独立审查】旁路必须能恢复。原来 setDenBypass(true) 之后
        // clearInterval(this._dnTimer)，没有任何路径回到 false ——
        // 实测 t=8s 触发后 12 秒以上恒 true，用户永远觉得"降噪没启用"。
        clearTimeout(this._dnRetry);
        this._dnRetry = setTimeout(() => {
          try {
            if (!this.denoiseOn) return;
            if (D.setDenBypass) D.setDenBypass(false);
            console.log('[audio-diag] 旁路已解除，恢复降噪');
            this._dnBad = 0;
            this._startDenoiseGuard();
          } catch (_) {}
        }, 4000);
      } else {
        this.track = this.rawTrack;
        this.denoiseOn = false;
        this.gateMode = false;
        try { if (D.setGate) D.setGate(1); } catch (_) {}
        if (this.sendTrack && this.sendTrack !== this.rawTrack) { try { this.sendTrack.stop(); } catch (_) {} }
        this.sendTrack = this.rawTrack.clone();
        this.sendTrack.enabled = true;
        this.sending = null;
        if (this.sender) { try { await this.sender.replaceTrack(this.sendTrack); } catch (_) {} }
      }
      if (false && window.FongVad && FongVad.attach) {
        try { await FongVad.attach(this.actx, this.rawTrack, { thrDb: S.thr, holdMs: 240, bypass: S.mode === 'ptt' }); } catch (_) {}
      }
      // 电平表也接回原始麦（原来挂在降噪节点上，旁路后界面电平会一直显示 -51）
      try {
        if (this.srcNode) { try { this.srcNode.disconnect(); } catch (_) {} }
        this.srcNode = this.actx.createMediaStreamSource(new MediaStream([this.rawTrack]));
        this.srcNode.connect(this.an);
      } catch (_) {}
      banner('AI 降噪输出异常，已自动切回原始麦克风（声音优先）', null, null, true);
    } catch (_) { /* 守护失败不影响主链 */ }
  },

  tick() {
    if (!this.an) return;
    this.an.getFloatTimeDomainData(this.buf);
    this.db = dbOf(this.buf);
    // 【P0-B】hold 必须按真实经过时间扣减。
    // setTimeout(20) 在游戏抢主线程时会拖到 170 ms+，硬编码 -20 等于把
    // 240 ms 的句尾保持拉成 2 秒，表现是「说完还占着麦 / 对方听到拖音」。
    const _nowHold = performance.now();
    const _dtHold = Math.min(400, _nowHold - (this.lastHoldTick || (_nowHold - 20)));
    this.lastHoldTick = _nowHold;
    // 【0.4.10 · 审查 P0-2】门控只能有一个事实源。
    // worklet 在跑时这里绝不能再写 this.open —— 旧状态机（21ms 窗口）和 worklet
    // （10ms hop）在边界信号上结论不同，每 20ms 互相覆盖一次，等效门控取严、句尾被掐。
    if (window.FongVad && FongVad.ready) {
      // open 由 FongVad.onGate 回写；这里只负责电平表/duck/speaking
    } else if (this.db > S.thr) { this.hold = 240; this.open = true; }
    else if (this.hold > 0) { this.hold -= _dtHold; this.open = true; }
    else this.open = false;
    // 【0.4.46】AEC 自锁兜底：VAD 挂在 Denoise.node 输出（AEC 之后）。当 AEC 把信号消到近零
    // （外放时对方声音很大、或测试用两端同源音源），VAD 会判「没人说话」而关门 ——
    // 于是自己的声音也被掐掉。这里用 worker 报的「AEC 之前近端电平」做二次确认：
    // 近端明明有语音而 VAD 说没有，就以近端为准。
    if (S.aec && window.__aecDiag) {
      const pd = Number(window.__aecDiag.preDb);
      if (isFinite(pd) && pd > S.thr && !this.open) {
        this.hold = 240;
        this.open = true;
      }
    }
    const send = this.wantSend();
    // 【0.4.17 · 发送侧自检】在说话（电平过阈）但发送克隆轨静默 → 发送链断，自动重建克隆轨
    if (send && this.sendAn && this.db > S.thr) {
      this.sendAn.getFloatTimeDomainData(this.sendBuf);
      if (dbOf(this.sendBuf) < -60) this._sendDead = (this._sendDead || 0) + 1; else this._sendDead = 0;
      const nowSend = performance.now();
      if (this._sendDead >= 3 && this.sender && nowSend - (this._sendFixAt || 0) > 3000) {
        this._sendFixAt = nowSend;
        this._sendDead = 0;
        console.warn('[audio-diag] 发送轨静默（电平正常但克隆轨无声），重建克隆轨');
        try { this.sendTrack = this.track.clone(); this.sendTrack.enabled = true; this.sender.replaceTrack(this.sendTrack); } catch (_) {}
      }
    }
    // 【P0-A】门控判定已搬进 AudioWorklet（音频线程），this.open 由 FongVad.onGate 回写。
    // 没加载 vad-gate.js 时保持原 tick 行为。
    //
    // 【P0-G · 已升为最高优先级】静默时必须用 track.enabled，不能用 replaceTrack(null)。
    //
    // 实测证据（2026-11-07，用户机器上的 FONG 0.4.8，真实房间）：
    //   jitterBufferTargetDelay / jitterBufferEmittedCount = 1358.7 ms
    //   jitterBufferDelay      / jitterBufferEmittedCount =  645.9 ms
    //   concealedSamples / totalSamplesReceived            = 89.6%
    //   而当时 jitter = 1 ms、packetsLost = 0（网络良好）
    //
    // 强制持续发包后（同一会话，6 秒内）：
    //   目标延迟 1359 ms → 43 ms
    //   抖动缓冲  646 ms → 10 ms
    //
    // 机制：replaceTrack(null) 让 RTP 完全停发，静默结束后的第一个包在 NetEq 眼里
    // 是一个"巨大到达间隔"，按 RFC 3550 算出的 jitter 瞬间爆到秒级 → NetEq 把目标
    // 延迟推到 1.3 秒"保护"你，而且因为每句话之间都有静默，它永远降不回来。
    // 这就是用户说的「不开游戏也慢半秒」。
    //
    // 改后：Opus 持续编静音帧（~6 kbps），时间戳连续，NetEq 保持收敛。
    // 等价于 Agora 的 muteLocalAudioStream（OOPZ 用它，app.so 里 4 处引用）。
    // 代价：静默期上行 0 → ~6 kbps（一小时 2.7 MB）。
    if (this.sender && send !== this.sending) {
      this.sending = send;
      // 【0.4.21】降噪链的发送门控走 gate gain（gain=0 仍持续发帧，符合 P0-G）；
      // 只有 getUserMedia 的普通轨才用 track.enabled。
      if (this.gateMode && window.Denoise && Denoise.setGate) {
        Denoise.setGate(send ? 1 : 0);
      } else {
        // 【0.4.11】只门控克隆轨；Mic.track 保持 enabled，耳返不受 VAD 影响
        const t = this.sendTrack || this.track || this.sender.track;
        if (t) { try { t.enabled = send; } catch (_) {} }
      }
      // 【0.4.23】跟着门控切码率：说话满档（256k 顶配），静默压到 24k 只发静音帧
      this.setSendBitrate(!!send);
    }
    const speaking = send && this.db > S.thr - 6;
    if (speaking !== this.speaking) { this.speaking = speaking; Room.setSpeaking(Room.peerId, speaking); Room.pushPresence(); }
    const target = S.duck && speaking ? Math.pow(10, S.duckDb / 20) : 1;
    // 释放/压低都按真实经过的时间做指数收敛（τ=60ms，dt 上限 250ms）；
    // 原来「每 tick 乘 25%」与时间无关，CS2 抢主线程把 tick 拖长时尾巴会被拖到 ~1 秒
    const nowMs = performance.now();
    const dt = Math.min(250, nowMs - (this.lastTick || (nowMs - 20)));
    this.lastTick = nowMs;
    this.duckGain = target + (this.duckGain - target) * Math.exp(-dt / 60);
    Room.applyVolumes();
    const p = (this.muted || this.deafened) ? 0 : pct(this.db);
    $('miniMeter').style.width = p + '%'; $('setMeter').style.width = p + '%'; $('obMeter').style.width = pct(this.db) + '%';
    const sl = document.getElementById('selfLvl'); if (sl) { sl.style.width = p + '%'; sl.classList.toggle('over', this.db > S.thr && p > 0); }
    $('setMeter').classList.toggle('over', this.db > S.thr && p > 0);
    $('thrMark').style.left = pct(S.thr) + '%';
    this.timer = setTimeout(() => this.tick(), 20);
  },
};

function setMuted(m, quiet) {
  if (Mic.deafened && !m) { setDeafened(false); return; }
  Mic.muted = m;
  if (!quiet) sfx(m ? 'mute' : 'unmute');
  renderBar(); Room.renderMembers(); Room.pushPresence();
}
function setDeafened(d) {
  Mic.deafened = d;
  sfx(d ? 'mute' : 'unmute');
  Room.applyVolumes(); renderBar(); Room.renderMembers(); Room.pushPresence();
}

// ---- 监听自己 ----
const Loop = {
  on: false, audio: null, _trackId: null,
  // 【0.4.59 · 独立审查根因】耳返必须取【门控之前】的信号。
  // 原来取 Mic.track，而降噪档下 Mic.track === Denoise.dest 的输出轨，
  // dest 上游是发送门控 gate：VAD 判无声 → setGate(0) → dest 归零 → 耳返跟着哑。
  // 实测（同 ctx analyser）：gate=1 时 Mic.track=0.0859，gate=0 时 Mic.track=0
  // 而 Denoise.node（门控前）仍是 0.0561 —— 完全正常。
  _src() {
    const D = window.Denoise;
    if (Mic.denoiseOn && D && D.pre) {
      try { const t = D.pre.stream.getAudioTracks()[0]; if (t) return t; } catch (_) {}
    }
    return Mic.track || null;
  },
  attach() {
    if (!this.audio) {
      this.audio = new Audio();
      this.audio.addEventListener('ended', () => { if (this.on) this.resync(true); });
    }
    const t = this._src();
    this.audio.srcObject = t ? new MediaStream([t]) : (Mic.stream || null);
    this._trackId = t ? t.id : null;
    if (S.spk && S.spk !== 'default' && this.audio.setSinkId) this.audio.setSinkId(S.spk).catch(() => {});
    this.audio.play().catch(() => {});
  },
  resync(force) {
    if (!this.on) return;
    if (!this.audio) { this.attach(); return; }
    const t = this._src();
    const id = t ? t.id : null;
    const cur = this.audio.srcObject && this.audio.srcObject.getAudioTracks()[0];
    if (!force && cur && id && cur.id === id && cur.readyState === 'live' && !this.audio.paused) return;
    this.attach();
  },
  toggle() { this.on = !this.on; if (this.on) this.attach(); else this.off(); const bb = $('loopBtn'); if (bb) bb.querySelector('span').textContent = this.on ? '停止监听' : '听听自己的声音'; },
  off() { this.on = false; if (this.audio) { this.audio.pause(); this.audio.srcObject = null; } this._trackId = null; const s2 = $('loopBtn') && $('loopBtn').querySelector('span'); if (s2) s2.textContent = '听听自己的声音'; },
};
try { window.Loop = Loop; } catch (_) {}

// ---- 网络状态胶囊（0.4.13：丢包改滑动窗口口径，累计值放 tooltip） ----
function renderNet({ rtt, loss, kbps, jitter, q, lossCum }) {
  const box = $('netInfo'); box.innerHTML = '';
  const lvl = q || 'good';
  box.className = 'net small ' + lvl;
  box.appendChild(el('i', 'dot'));
  box.appendChild(el('span', 'net-v', rtt + ' ms'));
  box.appendChild(el('span', 'net-sep', '·'));
  box.appendChild(el('span', 'net-v', '丢包 ' + loss.toFixed(1) + '%'));
  // 0.4.11 起静默也持续发静音帧，上行常显
  box.appendChild(el('span', 'net-sep', '·'));
  box.appendChild(el('span', 'net-v up', '↑' + kbps + ' kbps'));
  const word = { good: '良好', mid: '一般', bad: '较差' }[lvl];
  box.title = `网络${word}\n延迟 ${rtt} ms · 抖动 ${jitter.toFixed(0)} ms\n丢包 当前 ${loss.toFixed(2)}% · 累计 ${(lossCum == null ? loss : lossCum).toFixed(2)}%\n上行 ${kbps} kbps（含静音帧与重传）`;
  box.setAttribute('aria-label', `网络${word}，延迟 ${rtt} 毫秒，丢包 ${loss.toFixed(1)}%`);
}

// ============ 房间 / 媒体连接 ============
// 【0.4.67】频道密码的会话级缓存（key = "sid:rid"）。不写 localStorage。
const askRoomPassword = async (roomName, isWrong) => {
  const raw = await dialog({
    title: isWrong ? '密码不对' : `「${roomName}」需要密码`,
    text: isWrong ? '这个频道的密码不对，再试一次。' : '这个频道设了密码，输入后加入。',
    input: 32,
    value: '',
    ok: '加入',
  });
  return raw == null ? null : String(raw);
};

const Room = {
  roomPw: Object.create(null),
  pc: null, sid: null, rid: null, key: null, peerId: null, abort: null, statsTimer: null, chain: Promise.resolve(),
  actx: null, audios: new Map(), // mid -> {audio, an, buf, track, peer}
  lastPeers: null, wantRoom: null, retry: 0, retryTimer: null, presenceTimer: null, connectedAt: 0,
  get joined() { return !!this.pc; },

  async join(sid, rid, isRetry) {
    if (!serverURL()) { openSettings('t-general'); banner('先在设置里填服务器地址', '去设置', () => openSettings('t-general')); return; }
    const v = Spaces.get(sid); const rv = v && v.rooms.find((r) => r.id === rid);
    if (!rv) return;
    if (!isRetry && rv.members.length >= rv.maxUsers && !rv.members.some((m) => m.id === S.uid)) { toast(`「${rv.name}」满了（${rv.members.length}/${rv.maxUsers}）`); return; }
    closeText();
    if (this.joined) await this.leave(true, true);
    clearTimeout(this.retryTimer);
    if (!isRetry) { this.retry = 0; hideBanner(); }
    this.wantRoom = { sid, rid };
    this.sid = sid; this.rid = rid; this.key = sid + ':' + rid;
    // 【多开修复】peerId 后缀原来是 rhex(3) 每次进房都变，
    // 导致同一账号第二次进房被服务端当成新 peer，房间里出现两个同名成员。
    // 改成用固定的设备号派生（S.device 是持久化的 32 hex），
    // 同一台机器反复进出房间会复用同一个 peerId，服务端能识别为同一人。
    // 多台设备/多个窗口仍会有不同后缀（各自的 S.device 不同），这是期望行为。
    const peerSuffix = (S.device && S.device.length >= 6) ? S.device.slice(0, 6) : rhex(3);
    this.peerId = S.uid + '.' + peerSuffix;
    S.lastRoom[sid] = rid; save();
    showRoom(true); $('shell').classList.remove('drawer');
    $('skeleton').classList.remove('hidden'); $('members').classList.add('hidden');
    openRoomChat(sid, rid, true);
    renderAll();
    try {
      if (!Mic.track) await Mic.start();
      const track = Mic.sendTrack || Mic.track;   // 【0.4.11】sender 用克隆轨，Mic.track 留给耳返
      const pc = new RTCPeerConnection({ iceServers: iceServers(), bundlePolicy: 'max-bundle' });
      this.pc = pc;
      const tr = pc.addTransceiver(track, { direction: 'sendrecv', streams: [new MediaStream([track])] });
      Mic.sender = tr.sender; Mic.sending = null;
      pc.ontrack = () => { this.syncAudio(); setTimeout(() => this.syncAudio(), 300); };
      pc.onconnectionstatechange = () => {
        if (this.pc !== pc) return;
        const st = pc.connectionState;
        if (st === 'connected') { this.retry = 0; hideBanner(); this.syncAudio(); this.startSyncWatchdog(); }
        if (st === 'failed') this.reconnect('网络断开');
        if (st === 'disconnected') setTimeout(() => { if (this.pc === pc && pc.connectionState === 'disconnected') this.reconnect('网络不稳定'); }, 4000);
      };
      const offer = await pc.createOffer();
      await pc.setLocalDescription({ type: 'offer', sdp: tuneOpus(offer.sdp, false) });
      // 【0.4.67】频道密码：本次会话内记住（不写 localStorage —— 共享机器上会泄露）。
    // 与 KOOK 一致：40310 → 弹框 → 带密码重试。
    const pw = this.roomPw[this.key] || '';
    const sigUrl = serverURL() + '/signal' + (pw ? '?pw=' + encodeURIComponent(pw) : '');
    const r = await fetch(sigUrl, {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Fong-Uid': S.uid, 'X-Fong-Key': S.key },
        body: JSON.stringify({ room: this.key, peer: this.peerId, type: 'offer', sdp: pc.localDescription.sdp }),
      }).catch(() => { throw Object.assign(new Error('连不上服务器'), { net: true }); });
      const ans = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = Object.assign(new Error(ans.error || '服务器拒绝了'), { status: r.status, reason: ans.reason });
        // 【密码】服务端 403 + ROOM_PASSWORD → 弹框，输入后带密码重进
        if (ans.reason === 'ROOM_PASSWORD') {
          delete this.roomPw[this.key];
          const input = await askRoomPassword(rv.name, false);
          if (input != null) { this.roomPw[this.key] = input; return this.join(sid, rid, true); }
        } else if (ans.reason === 'ROOM_PASSWORD_WRONG') {
          delete this.roomPw[this.key];
          const input = await askRoomPassword(rv.name, true);
          if (input != null) { this.roomPw[this.key] = input; return this.join(sid, rid, true); }
        }
        throw e;
      }
      if (this.pc !== pc) return;
      await pc.setRemoteDescription({ type: 'answer', sdp: tuneOpus(ans.sdp, true) });
      await this.tuneSender();
      this.listen(pc);
      this.syncAudio();   // 首帧就可能已经有远端音轨，不等 ontrack
      this.startStats();
      this.lastPeers = null;
      this.connectedAt = Date.now();
      this.noMedia = 0;
      this.rxRescue = 0;         // 重进房后 RTP 停滞自愈重新计数
      Mic.setSendBitrate(!!Mic.wantSend());   // 新 sender：先按当前门控状态定档位上限
      this._mLeakFixed = false;  // m-line 累积自愈重新武装
      this._outWarned = false;   // 重进房后输出停滞告警重新武装
      $('skeleton').classList.add('hidden'); $('members').classList.remove('hidden');
      // 进房音效：上行两音（659→988），和「有人加入」的下行音区分开
      if (!isRetry) sfx('selfjoin'); else toast('已重新连上');
      this.pushPresence(true);
      loadSpace(sid).then((nv) => onSpaceUpdate(sid, null, nv)).catch(() => {});
      renderAll();
    } catch (e) {
      console.error(e);
      if (e.net || (!e.status && isRetry)) return this.reconnect('连不上服务器');
      await this.leave(true);
      banner('进不去频道：' + (e.message || e), e.status === 409 || e.status === 403 ? null : '重试', () => this.join(sid, rid));
    }
  },

  // 断线自动重连：1 2 4 8 15 15… 秒退避，一直试到成功或用户挂断
  reconnect(why) {
    if (!this.wantRoom) return;
    const { sid, rid } = this.wantRoom;
    this.teardown();
    this.retry++;
    const wait = Math.min(15, 2 ** (this.retry - 1));
    banner(`${why}，${wait} 秒后第 ${this.retry} 次重连…`, '立即重连', () => { clearTimeout(this.retryTimer); this.join(sid, rid, true); });
    renderAll();
    this.retryTimer = setTimeout(() => { if (this.wantRoom) this.join(sid, rid, true); }, wait * 1000);
  },

  async tuneSender() {
    const s = Mic.sender; if (!s) return;
    const p = s.getParameters();
    if (!p.encodings || !p.encodings.length) p.encodings = [{}];
    // 传输层上限要略高于编码目标，给 RTP/UDP 头留余量
    p.encodings[0].maxBitrate = opusKbps() * 1100;
    p.encodings[0].priority = 'high';
    p.encodings[0].networkPriority = 'high';
    try { await s.setParameters(p); } catch (e) { console.warn('setParameters', e); }
  },

  listen(pc) {
    const ctl = new AbortController(); this.abort = ctl;
    const url = serverURL() + '/events?room=' + encodeURIComponent(this.key) + '&peer=' + encodeURIComponent(this.peerId);
    fetch(url, { signal: ctl.signal }).then(async (r) => {
      if (!r.ok) throw new Error('events ' + r.status);
      const reader = r.body.getReader(); const dec = new TextDecoder(); let acc = '';
      for (;;) {
        const c = await reader.read(); if (c.done) break;
        acc += dec.decode(c.value, { stream: true });
        let i;
        while ((i = acc.indexOf('\n\n')) >= 0) {
          const part = acc.slice(0, i); acc = acc.slice(i + 2);
          const line = part.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;
          const msg = JSON.parse(line.slice(6));
          if (msg.type === 'offer') this.onOffer(pc, msg.sdp);
          if (msg.type === 'bye') return this.onBye(msg.reason);
        }
      }
      if (this.pc === pc) this.reconnect('与服务器的连接断了');
    }).catch((e) => { if (this.pc === pc && e.name !== 'AbortError') this.reconnect('与服务器的连接断了'); });
  },

  onBye(reason) {
    const v = Spaces.get(this.sid);
    this.leave(true);
    if (reason === 'kicked') { sfx('kicked'); banner(`你被移出了「${v ? v.name : '房间'}」`); dropSpace(v ? v.id : this.sid); }
  },

  onOffer(pc, sdp) {
    this.chain = this.chain.then(async () => {
      if (this.pc !== pc) return;
      await pc.setRemoteDescription({ type: 'offer', sdp: tuneOpus(sdp, true) });
      const a = await pc.createAnswer();
      await pc.setLocalDescription({ type: 'answer', sdp: tuneOpus(a.sdp, false) });
      await fetch(serverURL() + '/answer', {
        method: 'POST', headers: { 'content-type': 'application/json', 'X-Fong-Uid': S.uid, 'X-Fong-Key': S.key },
        body: JSON.stringify({ room: this.key, peer: this.peerId, type: 'answer', sdp: pc.localDescription.sdp }),
      });
      await this.tuneSender();
      this.syncAudio();
    }).catch((e) => console.warn('reneg', e));
  },

  // 对账看门狗：竞态、m-line 复用、补协商都可能让某一路音轨漏接。
  // 每 2.5 秒比一次「远端有几路 live 音轨 vs 我们建了几个播放元素」，少了就补。
  // 远端到底有几路活着的音轨（按 SDP 的 msid 认人，自己那一路不算）
  remoteTracks() {
    const out = [];
    if (!this.pc) return out;
    const owners = this.pc.remoteDescription ? midOwners(this.pc.remoteDescription.sdp) : {};
    for (const t of this.pc.getTransceivers()) {
      if (t.mid == null || !t.receiver || !t.receiver.track) continue;
      if (t.receiver.track.readyState !== 'live') continue;
      const owner = owners[t.mid];
      const peer = owner && owner !== '-' && owner !== this.peerId ? owner : null;
      if (!peer) continue;
      out.push(String(t.mid));
    }
    return out;
  },

  startSyncWatchdog() {
    if (this.syncTimer) return;
    let lastPk = null, stallTick = 0;
    this.syncTimer = setInterval(async () => {
      if (!this.joined || !this.pc || this.pc.connectionState === 'closed') return;
      const pcNow = this.pc;
      const live = this.remoteTracks().length;
      if (live > this.audios.size) {
        console.warn('[audio] 播放元素缺失，补接：live=' + live + ' audios=' + this.audios.size);
        this.syncAudio();
      }
      // 房间里有别人、却一路音轨都没收到 —— 说明补协商没成功（表现就是「得挂断重进才有声」）。
      // 连续 3 次（约 7.5s）都这样，自动重连一次，省得用户自己挂断。
      const others = Array.isArray(this.lastPeers) ? this.lastPeers.length : 0;
      if (live === 0 && others > 0) {
        this.noMedia = (this.noMedia || 0) + 1;
        if (this.noMedia === 3) {
          console.warn('[audio] 有 ' + others + ' 人但没收到任何音轨，自动重连');
          this.noMedia = 0;
          this.reconnect('没收到对方的声音');
          return;
        }
      } else {
        this.noMedia = 0;
      }
      // 【0.4.20 · 实测定案】「远端轨在、连接 connected，但 inbound 包完全不涨」。
      // 6 轮进出房压力测试（2026-11-07）：第 1/2/6 轮 inPk≈340/3s 正常，
      // 第 4/5 轮 inPk 增量恒为 0、recvPeak=0，而 txR(track 对象) 与 SSRC 全程不变、
      // signalingState 稳定在 stable —— 就是用户说的「进频道有时听不到，退出重进才好」。
      // 旧看门狗只认 live===0（压根没轨），这种「轨在、包不来」它漏掉了。
      // 判据改成 3 秒窗口的 packetsReceived 增量：连续 2 个窗口为 0（≈5s）自动重进房。
      if (live > 0 && others > 0 && this.pc === pcNow) {
        let pk = 0;
        try { (await pcNow.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') pk += r.packetsReceived || 0; }); } catch (_) { pk = lastPk == null ? 0 : lastPk; }
        if (this.pc !== pcNow) return;   // 期间被重连换掉了，丢弃这次采样
        if (lastPk != null && pk - lastPk === 0) {
          if (++stallTick >= 2) {
            stallTick = 0; lastPk = null;
            this.rxRescue = (this.rxRescue || 0) + 1;
            if (this.rxRescue <= 2) {
              console.warn('[audio] 远端轨在但 RTP 停滞（3s 零包）→ 自动重进房第 ' + this.rxRescue + ' 次');
              this.reconnect('对方的声音没送过来');
              return;
            }
            console.warn('[audio] RTP 停滞已重连 2 次仍未恢复，停止自动重连（避免循环）');
          }
        } else {
          stallTick = 0;
        }
        lastPk = pk;
      } else {
        lastPk = null; stallTick = 0;
      }
      // 【0.4.20】服务端为每次订阅新开 m-line（不再复用旧 sender，见 peer.go 的实测定案），
      // 常驻端会随别人反复进出累积空 m-line。超过 8 条自动重进房清一次（SDP 不膨胀）。
      if (this.audios.size > 8 && !this._mLeakFixed) {
        this._mLeakFixed = true;
        console.warn('[audio] 已累积 ' + this.audios.size + ' 条接收 m-line，自动重进房清理');
        this.reconnect('播放通道重建');
      }
    }, 2500);
  },

  // 每个接收 m-line 一个 <audio>，按 SDP 的 msid 认人（服务端会复用空出来的 m-line 给新来的人）
  syncAudio() {
    // 【0.4.19】播放通道判据：只有 FongWire 真的在用 WebAudio 混音时才放弃 <audio> 播放。
    // 实测（Electron 45.2.2 / Chromium 156）：webaudio 通道下 NetEq 零发射、完全无声，
    // 所以此时必须挂 srcObject 让元素播放；fong-wire.js 已默认切到 element 通道。
    if (!this.pc) return;
    // 注意：这里**不能**因为 remoteDescription 还没就绪就整体返回。
    // ontrack 可能在 setRemoteDescription 完成前就触发，一返回就再没人补这一刀，
    // 表现就是「对方在说话、音量 100%，但一点声音都没有」（实测踩到）。
    const owners = this.pc.remoteDescription ? midOwners(this.pc.remoteDescription.sdp) : {};
    if (!this.actx) this.actx = ctxShared();   // 【0.4.24】复用共享 ctx
    const farTracks = [];          // 【0.4.33】AEC 的 far-end 参考（只收远端，排除自己发布那一路）
    for (const t of this.pc.getTransceivers()) {
      if (t.mid == null || !t.receiver || !t.receiver.track) continue;   // 原表达式里的 && false 恒假，去掉
      const owner = owners[t.mid];
      const peer = owner && owner !== '-' && owner !== this.peerId ? owner : null;
      // 自己发布用的那一路（sendrecv 的本地 transceiver）也有 receiver.track，
      // 但它永远不会出声音，建了只会让「远端有几路」和「建了几个」永远对不上。
      if (!peer && t.sender === Mic.sender) continue;
      let a = this.audios.get(t.mid);
      if (!a) {
        const audio = new Audio(); audio.autoplay = true;
        // 【P1-F】接了 FongWire 时声音从它自持的 AudioContext 出，元素只是占位。
        // 但 muted 的元素**仍在解码**：同一 track 被两套解码器各拉一次，
        // 两套时钟各攒各的缓冲，谁慢谁说话 —— 体感就是「声音偶尔慢半拍」。
        if (!wireWebAudio()) {
          audio.srcObject = new MediaStream([t.receiver.track]);
          audio.play().catch(() => {});
          if (S.spk && S.spk !== 'default' && audio.setSinkId) audio.setSinkId(S.spk).catch(() => {});
        }
        const an = this.actx.createAnalyser(); an.fftSize = 512; an.smoothingTimeConstant = 0.2;
        this.actx.createMediaStreamSource(new MediaStream([t.receiver.track])).connect(an);
        try { t.receiver.track.onunmute = () => this.syncAudio(); } catch (_) {}
        a = { audio, an, buf: new Float32Array(512), peer: null, lvl: -90, trackRef: t.receiver.track };
        this.audios.set(t.mid, a);
        if (wireWebAudio()) {
          // 【致命修复】原来第三参传的是 audio.srcObject，但上面 P1-F 在 FongWire
          // 就绪时故意不挂 srcObject（避免双解码），于是这里传进去是 null。
          // fong-basic.js 的 addLane 里有 `if (ctx && stream)`，stream 为 null
          // 就跳过 createMediaStreamSource → 整条 lane 没有音频节点 → 对端永远听不到。
          // 这正是"手机能听到电脑、电脑听不到手机"的根因。
          // 改为直接用 receiver.track 构造 MediaStream，不依赖 audio 元素。
          const laneStream = new MediaStream([t.receiver.track]);
          FongWire.addLane(String(t.mid), audio, laneStream, peer ? String(peer).split('.')[0] : undefined);
        }
      } else if (a.trackRef !== t.receiver.track) {
        // 【0.4.12 · 审查补刀】对端重连后 msid 变，Chromium 会生成一个**新的** track
        // 对象，旧引用永久哑掉——而 RTP 统计照常增长，极具迷惑性。实测：手机每重进
        // 一次，电脑端这个 mid 就静音一次，直到自己重进房。元素/lane/分析器全部重接。
        a.trackRef = t.receiver.track;
        const ms = new MediaStream([t.receiver.track]);
        if (wireWebAudio() && FongWire.rebindStream) FongWire.rebindStream(String(t.mid), ms);
        else { a.audio.srcObject = ms; a.audio.play().catch(() => {}); }
        try { this.actx.createMediaStreamSource(ms).connect(a.an); } catch (_) {}
        try { t.receiver.track.onunmute = () => this.syncAudio(); } catch (_) {}
      }
      a.peer = peer;
      // 【0.4.40】far 参考必须只收「真正的远端」。原来无条件 push t.receiver.track，
      // 结果把发送方向的轨（本机麦克风）也收进了参考环 —— 实测 far 环估频 450 Hz、
      // 峰值 0.4034，与本机麦完全相同，AEC 于是把自己当成回声整段消掉（对端直接静音）。
      if (S.aec) {
        const dir = t.direction || '';
        const tr = t.receiver && t.receiver.track;
        const mine = (Mic && Mic.rawTrack && tr && tr.id === Mic.rawTrack.id)
          || (Mic && Mic.track && tr && tr.id === Mic.track.id);
        if (dir !== 'sendonly' && tr && tr.kind === 'audio' && tr.readyState !== 'ended' && !mine) {
          // 【0.4.73 · 独立审查 §1.1 修正】参考信号必须与【实际播放】同源。
          //
          // 上一版（0.4.71）只补了 FAR_GAIN，但审查指出那是"放大器"不是"起因"：
          //   FAR_GAIN 的 key 用错（写 uid、读 track id）→ 永远读不到
          //   首次 sync 在 applyVolumes 之前 → 记下来的 volume 还是初值 1
          //   gain.gain.value 只在首次接入时赋一次 → duckGain 每 20ms 变，gain 不动
          //   updateGains() 全仓零调用 → 死代码
          // 就算这些都修好，clone 与 <audio> 之间那 60~200ms 的 pipeline 延迟差
          // 仍会让 AEC3 的 delay 估计失锁。所以改用 captureStream 拿播放侧真实信号。
          // 【0.4.74】这里只收集 clone 轨作为【回落】。
          // captureStream 参考由 AecRef.syncCapStreams(this.audios) 统一管理 ——
          // 两处都接会在 sync 周期里互相覆盖，导致参考反复断连（就是"开久了有电流"）。
          const au = this.audios.get(t.mid);
          const canCap = !!(au && au.audio && typeof au.audio.captureStream === 'function');
          if (!canCap) {
            farTracks.push(tr);   // 只有 captureStream 不可用时才用 clone 兜底
            try { if (au && au.audio) FAR_GAIN.set(tr.id, Math.max(0, Math.min(1, au.audio.volume))); } catch (_) {}
            console.log('[audio-diag] far 参考回落 clone（captureStream 不可用）mid=' + t.mid);
          }
        } else if (tr) {
          console.log('[audio-diag] far 参考跳过一条轨：dir=' + dir + ' kind=' + tr.kind + ' readyState=' + tr.readyState + ' 是本机麦=' + !!mine);
        }
      }
      // 【P0-D】钉住每一路接收端的抖动缓冲目标。
      // 这是「网络一抖就慢半秒」的直接原因：NetEq 自己往上爬且不回落。
      try {
        if ('jitterBufferTarget' in t.receiver) t.receiver.jitterBufferTarget = JITTER_TARGET_MS;
        if ('playoutDelayHint' in t.receiver) t.receiver.playoutDelayHint = JITTER_TARGET_MS / 1000;
      } catch (_) {}
    }
    // 【0.4.35】把远端轨交给 AEC 的 far 参考链。漏了这一步的话 far 环永远没有帧，
    // AEC 拿静音当参考（farBound=true 但 far=0），照付 CPU 却一点回声都消不掉。
    if (S.aec) {
      try { AecRef.sync(farTracks); } catch (_) {}
      // 【0.4.74】captureStream 参考单独管理（key 空间是 cap:<mid>，不参与 farTracks 的 track.id 判据）
      try { AecRef.syncCapStreams(this.audios); } catch (_) {}
    }
    this.applyVolumes();
    this.renderMembers();
  },

  teardown() {
    clearInterval(this.statsTimer);
    clearInterval(this.syncTimer);
    this.syncTimer = null;
    if (this.abort) this.abort.abort();
    for (const a of this.audios.values()) { a.audio.pause(); a.audio.srcObject = null; }
    this.audios.clear();
    if (window.FongWire && FongWire.ready) FongWire.clearLanes();
    if (this.pc) { try { this.pc.close(); } catch (e) {} }
    this.pc = null; Mic.sender = null; Mic.sending = null;
    // 【0.4.24】同上：共享 ctx 只断开节点，不 close
  },

  async leave(silent, switching) {
    const key = this.key, peer = this.peerId;
    clearTimeout(this.retryTimer);
    if (!switching) this.wantRoom = null;
    this.teardown();
    if (key && peer) api('POST', '/api/leave', { room: key, peer }).catch(() => {});
    if (!switching) { this.sid = this.rid = this.key = null; this.lastPeers = null; if (!silent) sfx('leave'); }
    $('netInfo').innerHTML = '';
    if (!switching) { stopChat(); showRoom(false); hideBanner(); }
    renderAll();
  },

  applyVolumes() {
    // 【0.4.73】下面逐轨设完 volume 后，把同一组值同步到 AEC 参考通路的 gain ——
    // 原来 updateGains() 全仓零调用（死代码），导致 duckGain 每 20ms 变、参考 gain 不动。
    // 这里用一个 finally 保证不管中途 return 都能同步。
    // 【0.4.20 · 审查回归修复】判据从「FongWire 是否接管」收紧为「是否真在用 webaudio 播放」。
    // element 通道下 renderer 不再 addLane → desk 的 lanes 是空的 → 没有人会去写 el.volume。
    // 若这里仍照旧早退，闭听（deafened）、屏蔽（localMute）、每人音量、闪避（duckGain）
    // 会全部静默失效（0.4.19 实测：laneList=[] 而 applyVolumes 只调了 sync）。
    if (window.FongWire && FongWire.ready) {
      FongWire.sync(this, Mic);        // uid↔mid 映射与远端说话态始终要同步
      if (wireWebAudio()) return;      // webaudio：音量/闪避由 desk 的 lane gain 负责
    }
    for (const a of this.audios.values()) {
      const uid = a.peer ? a.peer.split('.')[0] : null;
      const v = uid ? (S.memberVol[uid] ?? 100) / 100 : 1;
      const muted = Mic.deafened || (uid && S.localMute[uid]);
      a.audio.muted = !!muted;
      a.audio.volume = Math.max(0, Math.min(1, v * Mic.duckGain));
      // 【0.4.73 · 独立审查 §1.4 修正】key 必须和 AecRef.sync 读取时一致。
      // 上一版这里写 uid，而 sync/attachStream 读的是 track id / 'cap:<mid>' ——
      // 三方 key 全对不上，FAR_GAIN 等于没用。
      try {
        if (a.trackRef) FAR_GAIN.set(a.trackRef.id, a.audio.volume);
        if (a.mid != null) FAR_GAIN.set('cap:' + a.mid, a.audio.volume);
      } catch (_) {}
    }
    // 【0.4.73】把音量同步到 AEC 参考通路的 gain（原来 updateGains 是死代码）
    try { if (window.AecRef && AecRef.updateGains) AecRef.updateGains(); } catch (_) {}
  },

  pushPresence(force) {
    if (!this.joined) return;
    clearTimeout(this.presenceTimer);
    const send = () => api('POST', '/api/presence', { room: this.key, peer: this.peerId, selfMuted: Mic.muted, deafened: Mic.deafened, speaking: Mic.speaking, playing: S.playing || '' }).catch(() => {});
    if (force) send(); else this.presenceTimer = setTimeout(send, 120);
  },

  // 【0.4.18】输出探针：包在流但 NetEq 零发射 = 播放输出停滞
  async _probeEmission() {
    if (!this.pc) return false;
    const g = async () => { let p = 0, e = 0; (await this.pc.getStats()).forEach((r) => { if (r.type === 'inbound-rtp' && r.kind === 'audio') { p += r.packetsReceived || 0; e += r.jitterBufferEmittedCount || 0; } }); return { p, e }; };
    const a = await g.call(this);
    await new Promise((r) => setTimeout(r, 2500));
    const b = await g.call(this);
    return (b.p - a.p) >= 20 && (b.e - a.e) === 0;
  },

  startStats() {
    clearInterval(this.statsTimer);
    let lastSent = 0, lastT = 0, n = 0, prevCnt = null, winLoss = null, prevEm = null, emitDead = 0;
    this.statsTimer = setInterval(async () => {
      if (!this.pc) return;
      // 接了接线层：说话态由 FongWire 的检测器驱动
      //（50 ms 刷新 / −50 dBFS / 240 ms 保持，且与「播放侧是否静音」解耦）
      if (!(window.FongWire && FongWire.ready && FongWire.talkReady)) {
        for (const a of this.audios.values()) {
          if (!a.peer) continue;
          a.an.getFloatTimeDomainData(a.buf);
          this.setSpeaking(a.peer, !a.audio.muted && dbOf(a.buf) > -50);
        }
      }
      if (++n % 10) return;
      const st = await this.pc.getStats(); let rtt = 0, lost = 0, recv = 0, sent = 0, jitter = 0, em = 0;
      st.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded') rtt = Math.round((r.currentRoundTripTime || 0) * 1000);
        if (r.type === 'inbound-rtp' && r.kind === 'audio') { lost += r.packetsLost || 0; recv += r.packetsReceived || 0; jitter = Math.max(jitter, (r.jitter || 0) * 1000); em += r.jitterBufferEmittedCount || 0; }
        if (r.type === 'outbound-rtp' && r.kind === 'audio') sent = r.bytesSent;
      });
      const now = performance.now();
      const kbps = lastSent && sent >= lastSent ? Math.round((sent - lastSent) * 8 / ((now - lastT) / 1000) / 1000) : 0;
      lastSent = sent; lastT = now;
      // 【0.4.13】丢包改滑动窗口：packetsLost 是连接级累计值，重连历史会虚高（今天 1.7% 就是这么来的）。
      // 1 秒窗口增量 + EMA 平滑；窗口内包太少时沿用上一次显示，避免 0/0 抖动。
      if (prevCnt) {
        const dp = recv - prevCnt.p, dl = Math.max(0, lost - prevCnt.l);
        if (dp + dl >= 10) {
          const w = dl / (dp + dl) * 100;
          winLoss = winLoss == null ? w : winLoss * 0.6 + w * 0.4;
        }
      }
      prevCnt = { p: recv, l: lost };
      const lossCum = recv + lost ? lost / (recv + lost) * 100 : 0;
      const loss = winLoss != null ? winLoss : lossCum;
      const q = rtt > 250 || loss > 5 ? 'bad' : rtt > 120 || loss > 1.5 ? 'mid' : '';
      renderNet({ rtt, loss, kbps, jitter, q, lossCum });
      window.__fongStats = { rtt, loss, kbps, jitter, peers: [...this.audios.values()].filter((a) => a.peer).length };
      // 【0.4.17 · 接收侧自检】包在收（≥30/秒）但 NetEq 零发射连续 5 秒 = 播放输出通道没拉音频。
      // 解码器、服务器、传输都无辜 —— 提示用户一键重置输出链（重选扬声器 + 重进房）。
      if (prevCnt) {
        const pkD = recv - prevCnt.p, emD = prevEm == null ? -1 : em - prevEm;
        if (pkD >= 30 && emD === 0) emitDead++; else emitDead = 0;
        // 【0.4.19 · 自愈】包在收但 NetEq 零发射 = 播放通道没拉音频（实测：WebAudio 通道
        // 在这套 Chromium 上就是这种状态）。第一步不再只提示，直接把每一路远端轨
        // 挂回 <audio>.srcObject 并 play() —— 实测 em/sd/en 立刻从 0 起跳、peak≈0.40。
        // 提示保留在「自动回落也救不回来」的分支里，避免用户看到无意义的弹窗。
        if (emitDead >= 3) {
          emitDead = 0;
          let rescued = 0;
          for (const t of this.pc.getTransceivers()) {
            if (t.mid == null || !t.receiver || !t.receiver.track) continue;
            const a = this.audios.get(t.mid);
            if (!a || !a.audio) continue;
            try {
              a.audio.srcObject = new MediaStream([t.receiver.track]);
              a.audio.play().catch(() => {});
              a.trackRef = t.receiver.track;
              rescued++;
            } catch (_) {}
          }
          if (rescued) {
            console.warn('[audio-diag] 收包正常但 NetEq 零发射 → 已自动回落元素播放（' + rescued + ' 路）');
            if (!this._outWarned) { this._outWarned = true; banner('检测到播放通道未出声，已自动切回元素播放', null, null, true); }
          } else if (!this._outWarned) {
            this._outWarned = true;
            console.warn('[audio-diag] 包在收（+' + pkD + '/秒）但 NetEq 零发射，且没有可回落的元素');
            banner('检测到对方声音已到达但播放停滞（输出通道未工作）', '重置声音', () => audioRepair(), true);
          }
        }
      }
      prevEm = em;
    }, 100);
  },

  // ---- 房间内成员 ----
  renderMembers() {
    const box = $('members');
    const v = Spaces.get(this.sid); const rv = v && v.rooms.find((r) => r.id === this.rid);
    if (!this.joined && !this.wantRoom) { box.innerHTML = ''; return; }
    if (!chatOnly) $('roomTitle').textContent = rv ? rv.name : '';   // 仅聊天模式（旧文字频道）时标题归聊天控制器管
    const list = rv ? rv.members.slice() : [];
    if (!list.some((m) => m.peer === this.peerId) && this.joined) list.unshift({ id: S.uid, name: S.nick || '我', peer: this.peerId, role: v ? v.myRole : 'member' });
    list.sort((a, b) => (a.peer === this.peerId ? -1 : b.peer === this.peerId ? 1 : 0));
    $('roomSub').textContent = `${v ? v.name : ''} · ${list.length}/${rv ? rv.maxUsers : '-'} 人`;
    // 【UI-3】房间里只有自己时不渲染那张放大的成员卡。
    // 它和左侧成员列表是同一份信息放大一倍，单人时占满中间却什么也没说。
    // [LAYOUT] 单人房：收起整个中间成员区，聊天占满（右侧 presence 已是成员栏）
    const splitEl = document.querySelector('.room-split');
    // [LAYOUT] #members 已隐藏，不再往里面写任何内容（写了也看不到）。
    // 单人提示由聊天区的空态（"还没有人说话，打个招呼吧"）承担。
    if (this.joined && list.length <= 1) {
      box.classList.remove('fong-tiles');
      box.innerHTML = '';
      return;
    }
    box.classList.remove('members-solo');
    if (splitEl) splitEl.classList.remove('solo');
    // ② 成员卡换成 fong-tile（声线环 + 三格声柱 + 两段轨音量条 + 数值胶囊）
    if (window.FongWire && FongWire.tilesReady) {
      FongWire.renderTiles({
        box,
        list: list.map((m) => Object.assign({ __me: m.peer === this.peerId }, m)),
        onMenu: (m, e) => memberMenu(m, e.clientX, e.clientY),
        stateOf: (m, isMe) => ({
          blocked: !isMe && !!S.localMute[m.id],
          selfMuted: isMe ? Mic.muted : !!m.selfMuted,
          serverMuted: !!m.muted || (isMe && Mic.serverMuted),
          deafened: isMe ? Mic.deafened : !!m.deafened,
        }),
      });
      return;
    }
    box.innerHTML = '';
    for (const m of list) {
      const me = m.peer === this.peerId;
      const card = el('div', 'member' + (me ? ' me' : '')); card.dataset.peer = m.peer; card.setAttribute('role', 'listitem');
      const avw = el('div', 'av-wrap'); avw.appendChild(avatar(m.name, null, m.avatar)); card.appendChild(avw);
      const nm = el('div', 'name');
      if (m.role === 'owner') { const c = icon('i-crown'); c.setAttribute('aria-label', '所有者'); nm.appendChild(c); }
      nm.appendChild(el('span', 'nm-t', m.name || '…'));
      if (me) nm.appendChild(el('span', 'you', '我'));
      card.appendChild(nm);
      const badges = el('div', 'badges');
      const selfMuted = me ? Mic.muted : m.selfMuted, deaf = me ? Mic.deafened : m.deafened;
      if (m.muted || (me && Mic.serverMuted)) { const s = el('span', 'srv'); s.title = '被管理员静音'; s.appendChild(icon('i-shield')); badges.appendChild(s); }
      if (selfMuted) { const s = el('span'); s.title = '已静音'; s.appendChild(icon('i-mic-off')); badges.appendChild(s); }
      if (deaf) { const s = el('span'); s.title = '已闭听'; s.appendChild(icon('i-headphones-off')); badges.appendChild(s); }
      if (!me && S.localMute[m.id]) { const s = el('span'); s.title = '你屏蔽了 TA'; s.appendChild(icon('i-volume-x')); badges.appendChild(s); }
      avw.appendChild(badges);
      card.classList.toggle('muted', !!(selfMuted || m.muted || (me && Mic.serverMuted)));
      card.classList.toggle('blocked', !me && !!S.localMute[m.id]);
      if (me) {
        // 自己这张卡和别人的同一结构：底部一行是「我的输入电平」，对应别人卡上的音量滑块
        const vol = el('div', 'vol self'); vol.title = '我的麦克风电平';
        vol.appendChild(icon(selfMuted || deaf ? 'i-mic-off' : 'i-mic'));
        const mm = el('div', 'mini-meter self-meter'); const bar = el('i'); bar.id = 'selfLvl'; mm.appendChild(bar); vol.appendChild(mm);
        card.appendChild(vol);
      } else {
        const vol = el('div', 'vol'); vol.appendChild(icon('i-volume'));
        const Wr = (window.FongWire && FongWire.ready) ? FongWire : null;
        const ceil = Wr ? Wr.ceiling() : 100;
        const r = el('input'); r.type = 'range'; r.min = 0; r.max = ceil; r.value = Wr ? Wr.volume(m.id) : (S.memberVol[m.id] ?? 100); r.setAttribute('aria-label', m.name + ' 的音量'); r.title = '拖动调节；滚轮 ±5，Shift+滚轮 ±1';
        const paintVol = () => { if (Wr) r.style.background = Wr.paint(+r.value, ceil); };
        paintVol();
        r.oninput = () => {
          if (Wr) r.value = Wr.setVolume(m.id, +r.value, true);   // 拖动中吸 100
          else { S.memberVol[m.id] = +r.value; save(); }
          paintVol(); this.applyVolumes();
        };
        r.onchange = () => { if (Wr) { r.value = Wr.setVolume(m.id, +r.value, false); paintVol(); } };
        r.onwheel = (e) => { if (!Wr) return; e.preventDefault(); r.value = Wr.nudge(m.id, e.deltaY, e.shiftKey); paintVol(); this.applyVolumes(); };
        // 被我屏蔽的人：滑块禁用并说明，避免"拖了没声音"的困惑（屏蔽优先于音量）
        if (S.localMute[m.id]) { r.disabled = true; r.title = '你已屏蔽 TA，先取消屏蔽才能调音量'; }
        vol.appendChild(r); card.appendChild(vol);
        const opt = el('button', 'icon-btn opts'); opt.setAttribute('aria-label', m.name + ' 的选项'); opt.appendChild(icon('i-more'));
        opt.onclick = (e) => { e.stopPropagation(); const [x, y] = menuAt(opt); memberMenu(m, x, y); };
        card.appendChild(opt);
        card.oncontextmenu = (e) => { e.preventDefault(); memberMenu(m, e.clientX, e.clientY); };
      }
      box.appendChild(card);
      if (me && Mic.speaking) card.classList.add('speaking');
    }
  },
  setSpeaking(peer, on) {
    const q = CSS.escape(peer || '');
    const c = document.querySelector(`.member[data-peer="${q}"], .fong-tile[data-peer="${q}"]`);
    if (c) c.classList.toggle('speaking', !!on);
  },
};

// ============ 菜单：成员 / 房间 / 空间 ============
// 当前所在频道（语音/文字的 rid）；菜单里判断"在哪个频道静音"要用它
function curRoom() {
  const v = cur();
  if (!v) return null;
  const rid = (Room && Room.rid) || (chatKey ? chatKey.split(':')[1] : null);
  return rid ? (v.rooms.find((r) => r.id === rid) || null) : null;
}

function memberMenu(m, x, y) {
  const v = cur(); const items = [];
  items.push({ text: S.localMute[m.id] ? '取消屏蔽（只对我）' : '屏蔽 TA（只对我）', icon: 'i-volume-x', run: () => { if (S.localMute[m.id]) delete S.localMute[m.id]; else S.localMute[m.id] = true; save(); Room.applyVolumes(); Room.renderMembers(); } });
  const me = v && v.myRole, tr = m.role;
  const canMod = (me === 'owner' && tr !== 'owner') || (me === 'admin' && tr === 'member');
  if (canMod) {
    items.push('-');
    // 静音是频道级的：把 m.muted 的含义收窄成"在当前这个频道里被静音"
    items.push({
      text: m.muted ? `解除本频道静音` : `在本频道静音`,
      icon: 'i-shield',
      run: () => {
        const rid = (curRoom() && curRoom().id) || '';
        if (!rid) { toast('先进入一个频道'); return; }
        return act(api('PATCH', `/api/spaces/${v.id}/members/${m.id}`, { muted: !m.muted, room: rid }),
                   m.muted ? `已解除 ${m.name} 在本频道的静音` : `已在本频道静音 ${m.name}`);
      },
    });
    // 【0.4.66】封禁 / 解封
    // 移出房间在封禁状态下隐藏：服务端会 409，前端别让他点了才报错。
    if (m.banned) {
      items.push({
        text: '解除封禁', icon: 'i-check',
        run: () => act(api('DELETE', `/api/spaces/${v.id}/members/${m.id}/ban`), `已解除 ${m.name} 的封禁`),
      });
    } else {
      items.push({
        text: '封禁（禁止进入）', icon: 'i-x', danger: true,
        run: async () => {
          if (await dialog({
            title: `封禁 ${m.name}？`,
            text: 'TA 会被立刻断开连接，且无法再进入这个空间，直到你解除封禁。\n封禁期间 TA 仍会出现在成员列表里。',
            ok: '封禁', danger: true,
          })) act(api('POST', `/api/spaces/${v.id}/members/${m.id}/ban`, {}), `已封禁 ${m.name}`);
        },
      });
      items.push({ text: '移出房间', icon: 'i-x', danger: true, run: async () => { if (await dialog({ title: `踢出 ${m.name}？`, text: 'TA 会被断开语音并移出这个房间，需要重新邀请才能回来。', ok: '踢出', danger: true })) act(api('DELETE', `/api/spaces/${v.id}/members/${m.id}`), `已踢出 ${m.name}`); } });
    }
  }
  if (me === 'owner' && tr !== 'owner') {
    items.push({ text: tr === 'admin' ? '取消管理员' : '设为管理员', icon: 'i-shield', run: () => act(api('PATCH', `/api/spaces/${v.id}/members/${m.id}`, { role: tr === 'admin' ? 'member' : 'admin' }), '身份已更新') });
    items.push({ text: '转让所有权', icon: 'i-crown', danger: true, run: async () => { if (await dialog({ title: `把房间转让给 ${m.name}？`, text: '转让后你会变成管理员，无法撤回。', ok: '转让', danger: true })) act(api('PATCH', `/api/spaces/${v.id}/members/${m.id}`, { role: 'owner' }), '所有权已转让'); } });
  }
  openMenu(x, y, items);
}
// 【0.4.66】封禁提示页。
// 判据必须是 spaceView.banned === true，【不能用"members 为空"】——
// 空成员列表也可能是网络异常或刚建的空间，混在一起会误报"你被封了"。
function showBannedPage(spaceName) {
  const g = $('bannedGate');
  if (!g) return;
  const sub = $('bgSub');
  if (sub && spaceName) sub.textContent = '你已被管理员封禁，暂时无法进入「' + spaceName + '」。';
  const room = $('bgRoom');
  if (room) {
    const others = (S.spaceIds || []).filter((id) => Spaces.get(id));
    room.textContent = others.length > 1 ? '你还有 ' + others.length + ' 个空间可以切换。' : '';
  }
  g.classList.remove('hidden');
  // 【出口】没有出口的话，被封者只能强杀进程 —— 复用时最容易漏的一条
  const bo = $('bgOther');
  if (bo) {
    // 没有独立的"空间选择器"页面，就切到第一个不是当前的空间（只有一个空间时禁用）
    const others = (S.spaceIds || []).filter((id) => id !== S.curSpace && Spaces.get(id));
    if (others.length) {
      bo.disabled = false;
      bo.onclick = () => {
        g.classList.add('hidden');
        window.__bannedShown = false;
        const sid = others[0];
        S.curSpace = sid; save(); renderAll(); startPoll();
        if (!Spaces.get(sid)) loadSpace(sid).then(renderAll).catch(() => {});
      };
    } else {
      bo.disabled = true;
      bo.title = '没有其他空间可切换';
    }
  }
  const bl = $('bgLogout');
  if (bl) bl.onclick = async () => {
    g.classList.add('hidden');
    window.__bannedShown = false;
    try { if (Room && Room.leave) await Room.leave(true); } catch (_) {}
    onSignedOut(new Error('已退出登录'));
  };
}
function hideBannedPage() {
  const g = $('bannedGate');
  if (g) g.classList.add('hidden');
  window.__bannedShown = false;
}

async function act(p, okText) {
  try { const v = await p; if (v && v.id) onSpaceUpdate(v.id, null, v); if (okText) toast(okText); return v; }
  // 【0.4.66】e.silent 的不弹 toast（封禁期每个请求都会 403，弹一串没意义）
  catch (e) { if (!e.silent) toast(e.message); throw e; }
}
function roomMenu(rv, x, y) {
  const v = cur(); if (!canManage(v)) return;
  openMenu(x, y, [
    { text: '重命名', icon: 'i-settings', run: async () => { const n = await dialog({ title: '重命名频道', input: 24, value: rv.name }); if (n && n !== rv.name) act(api('PATCH', `/api/spaces/${v.id}/rooms/${rv.id}`, { name: n })); } },
    { text: rv.pinned ? '取消置顶' : '置顶到「常驻」', icon: 'i-pin', run: () => act(api('PATCH', `/api/spaces/${v.id}/rooms/${rv.id}`, { pinned: !rv.pinned })) },
    { text: `人数上限（现在 ${rv.maxUsers}）`, icon: 'i-volume', run: async () => {
      const sel = maxSelect(rv.maxUsers);
      if (await dialog({ title: '人数上限', extra: sel })) act(api('PATCH', `/api/spaces/${v.id}/rooms/${rv.id}`, { maxUsers: +sel.value }));
    } },
    // 【0.4.67】频道密码 —— 按 KOOK 的「修改 / 关闭频道密码」两项，不是开关。
    // 关闭是独立动作（会清空密码并提示），改密码是另一个动作。
    rv.hasPassword
      ? { text: '关闭频道密码', icon: 'i-x', danger: true, run: async () => {
          if (await dialog({ title: '关闭频道密码？', text: '关闭后当前密码会被清空，任何人都能直接进入这个频道。', ok: '关闭', danger: true }))
            act(api('PATCH', `/api/spaces/${v.id}/rooms/${rv.id}/password`, { password: '' }), '已关闭频道密码');
        } }
      : { text: '设置频道密码', icon: 'i-lock', run: async () => {
          const pw = await dialog({ title: '设置频道密码', text: '设了密码后，非管理员进入这个频道需要先输入密码。', input: 32, placeholder: '4-32 个字符', ok: '设置' });
          if (pw) act(api('PATCH', `/api/spaces/${v.id}/rooms/${rv.id}/password`, { password: pw }), '已设置频道密码');
        } },
    rv.hasPassword
      ? { text: '修改频道密码', icon: 'i-lock', run: async () => {
          const pw = await dialog({ title: '修改频道密码', text: '改完以后，所有非管理员下次进入时要重新输入。', input: 32, placeholder: '新密码（4-32 个字符）', ok: '修改' });
          if (pw) act(api('PATCH', `/api/spaces/${v.id}/rooms/${rv.id}/password`, { password: pw }), '已修改频道密码');
        } }
      : null,
    '-',
    // 频道创建者/管理员的"全频道静音"：一键让房间里所有人静音（他们仍能听）。
    // 这是服务端静音（PATCH members/{uid} muted），不是本地屏蔽 —— 所有人都听不到他们。
    { text: speakingCount(rv) ? `全频道静音（${speakingCount(rv)} 人在说话）` : '全频道静音',
      icon: 'i-shield',
      run: async () => {
        const who = rv.members.filter((m) => m.id !== S.uid && !m.muted);
        if (!who.length) { toast('这个频道里没有可静音的人'); return; }
        const ok = await dialog({
          title: `把「${rv.name}」里 ${who.length} 个人全部静音？`,
          text: '他们会被服务端静音，所有人都听不到他们说话，但他们仍然能听到别人。\n可以随时解除。',
          ok: '全部静音',
        });
        if (!ok) return;
        // 走一次批量接口：服务端单事务处理，避免循环 PATCH 中途失败留下"半静音"
        try {
          const r = await api('POST', `/api/spaces/${v.id}/mute-all`, { room: rv.id, muted: true });
          toast(`已静音 ${(r && r.count) || 0} 人`);
          if (r && r.space) onSpaceUpdate(v.id, null, r.space); else loadSpace(v.id).then(renderAll).catch(() => {});
        } catch (e) { toast(e.message || '静音失败'); }
      } },
    { text: '解除全频道静音', icon: 'i-shield', run: async () => {
        const who = rv.members.filter((m) => m.muted);
        if (!who.length) { toast('当前没有被静音的人'); return; }
        try {
          const r = await api('POST', `/api/spaces/${v.id}/mute-all`, { room: rv.id, muted: false });
          toast(`已解除 ${(r && r.count) || 0} 人`);
          if (r && r.space) onSpaceUpdate(v.id, null, r.space); else loadSpace(v.id).then(renderAll).catch(() => {});
        } catch (e) { toast(e.message || '解除失败'); }
      } },
    '-',
    { text: '删除频道', icon: 'i-x', danger: true, run: async () => {
      const busy = rv.members.length ? `里面的 ${rv.members.length} 个人会被断开。` : '';
      if (await dialog({ title: `删除「${rv.name}」？`, text: busy + '删除后无法恢复。', ok: '删除', danger: true })) act(api('DELETE', `/api/spaces/${v.id}/rooms/${rv.id}`), '频道已删除');
    } },
  ]);
}
// 频道里正在说话的人数（用于"全频道静音"的菜单文案）
function speakingCount(rv) {
  if (!rv || !rv.members) return 0;
  return rv.members.filter((m) => m.peer === Room.peerId ? false : (m.speaking || false)).length;
}
function maxSelect(val) { const s = el('select'); for (let i = 2; i <= 12; i++) { const o = el('option', null, i + ' 人'); o.value = i; s.appendChild(o); } s.value = val; return s; }
const inviteOf = (v) => `fong://join/${v.id}`;
function spaceMenu(x, y) {
  const v = cur(); if (!v) return;
  const items = [
    { text: '邀请朋友', icon: 'i-plus', run: () => copyInvite(v) },
    { text: '房间设置', icon: 'i-settings', run: () => openSpaceSettings() },
  ];
  if (canManage(v)) items.push({ text: '新建频道', icon: 'i-volume', run: createRoom });
  items.push('-');
  if (v.myRole === 'owner') items.push({ text: '解散房间', icon: 'i-x', danger: true, run: () => deleteSpace(v) });
  else items.push({ text: '退出房间', icon: 'i-x', danger: true, run: () => leaveSpace(v) });
  openMenu(x, y, items);
}
async function copyInvite(v) {
  const code = v.joinCode ? formatCode(v.joinCode) : '';
  const txt = `来 FONG 一起开黑：${v.name}\n`
    + (code ? `房间号：${code}\n` : '')
    + `邀请码：FONG-${v.id}\n链接：${inviteOf(v)}`;
  try { await navigator.clipboard.writeText(txt); toast(code ? `邀请已复制，房间号 ${code}` : '邀请已复制，发给朋友就行'); }
  catch (e) { toast('复制失败，房间号：' + (code || '见房间设置')); }
}
async function leaveSpace(v) {
  if (!await dialog({ title: `退出「${v.name}」？`, text: '退出后需要别人再邀请你。', ok: '退出', danger: true })) return;
  try { await api('POST', `/api/spaces/${v.id}/leave`); dropSpace(v.id); toast('已退出'); } catch (e) { toast(e.message); }
}
async function deleteSpace(v) {
  const n = await dialog({ title: `解散「${v.name}」？`, text: '所有成员和设置都会被清空，无法恢复。输入房间名确认：', input: 24, ok: '解散', danger: true });
  if (n == null) return;
  if (n !== v.name) { toast('名字不对，没有解散'); return; }
  try { await api('DELETE', `/api/spaces/${v.id}`); dropSpace(v.id); toast('房间已解散'); } catch (e) { toast(e.message); }
}

// ============ 创建 / 加入 ============
// 6 位房间号显示成 XXX-XXX，念起来清楚
const formatCode = (c) => (c && c.length === 6) ? (c.slice(0, 3) + '-' + c.slice(3)) : (c || '');

function parseInvite(s) {
  s = (s || '').trim();
  const m = s.match(/fong:\/\/join\/([0-9a-f]{12})/i) || s.match(/FONG-([0-9a-f]{12})/i) || s.match(/^([0-9a-f]{12})$/i);
  return m ? m[1].toLowerCase() : null;
}

// 6 位房间号：和邀请码同一套字母表（去掉容易看错的 0O1Il）
const ROOM_CODE_RE = /^([2-9ABCDEFGHJKMNPQRSTUVWXYZ]{3})-?([2-9ABCDEFGHJKMNPQRSTUVWXYZ]{3})$/i;

function parseRoomCode(s) {
  const m = (s || '').trim().match(ROOM_CODE_RE);
  return m ? (m[1] + m[2]).toUpperCase() : null;
}

// 一个输入框同时吃三种东西：fong:// 链接、FONG- 邀请码、6 位房间号
async function joinByInput(val) {
  const sid = parseInvite(val);
  if (sid) { await joinSpace(sid); return true; }
  const code = parseRoomCode(val);
  if (!code) return false;
  try {
    const r = await api('GET', '/api/find/' + code);
    if (!r || !r.spaceId) { toast('没找到这个房间号'); return true; }
    await joinSpace(r.spaceId);
    return true;
  } catch (e) {
    toast(e.status === 404 ? '没有这个房间号' : e.message);
    return true;
  }
}
async function joinSpace(sid) {
  if (!await ensureReady()) return;
  try {
    const v = await api('POST', `/api/spaces/${sid}/join`);
    Spaces.set(v.id, v);
    if (!S.spaceIds.includes(v.id)) S.spaceIds.push(v.id);
    S.curSpace = v.id; save(); renderAll(); startPoll();
    toast(`已加入「${v.name}」`);
  } catch (e) { toast(e.status === 404 ? '邀请无效：房间不存在或已解散' : e.message); }
}
async function addSpaceFlow(initial) {
  if (!await ensureReady()) return;
  const wrap = el('div', 'dlg-body');
  const seg = el('div', 'seg');
  const b1 = el('button', 'on', '创建房间');
  const b2 = el('button', null, '输房间号');
  const b3 = el('button', null, '邀请码');
  seg.append(b1, b2, b3);
  wrap.appendChild(seg);
  const inp = el('input'); inp.maxLength = 120; inp.placeholder = '房间名，例如：周末开黑';
  wrap.appendChild(inp);
  const tip = el('p', 'hint');
  wrap.appendChild(tip);
  let mode = 'new';
  const setMode = (m) => {
    mode = m;
    b1.className = m === 'new' ? 'on' : '';
    b2.className = m === 'code' ? 'on' : '';
    b3.className = m === 'invite' ? 'on' : '';
    if (m === 'new') { inp.placeholder = '房间名，例如：周末开黑'; inp.maxLength = 24; tip.textContent = '建好之后会生成一个 6 位房间号，发给朋友就能进。'; }
    else if (m === 'code') { inp.placeholder = '6 位房间号，例如 ABC-DEF'; inp.maxLength = 12; tip.textContent = '把朋友发你的房间号填进来。大小写、横杠都可以。'; }
    else { inp.placeholder = '粘贴 FONG-xxxx 或 fong://join/…'; inp.maxLength = 200; tip.textContent = '邀请码是旧格式，效果一样。'; }
    inp.focus();
  };
  b1.onclick = () => setMode('new');
  b2.onclick = () => setMode('code');
  b3.onclick = () => setMode('invite');
  // 剪贴板里如果有房间号/邀请码，自动切到对应页并填上
  // 原来这里识别完剪贴板又无条件 setMode('new')，会把房间号当成新房间名
  let detected = false;
  try {
    const clip = await navigator.clipboard.readText();
    if (parseRoomCode(clip)) { setMode('code'); inp.value = clip.trim(); detected = true; }
    else if (parseInvite(clip)) { setMode('invite'); inp.value = clip.trim(); detected = true; }
  } catch (e) {}
  if (!detected) setMode(initial === 'code' ? 'code' : 'new');
  setTimeout(() => inp.focus(), 0);
  const ok = await dialog({ title: '创建 / 加入房间', extra: wrap, ok: '完成' });
  const val = inp.value.trim();
  if (!ok || !val) return;
  if (mode !== 'new') {
    if (!await joinByInput(val)) toast('房间号或邀请码格式不对');
    return;
  }
  try {
    const v = await api('POST', '/api/spaces', { name: val });
    Spaces.set(v.id, v); S.spaceIds.push(v.id); S.curSpace = v.id; save(); renderAll(); startPoll();
    // 建好就直接进第一个房间，不用用户再点一次
    const first = (v.rooms && v.rooms[0]) || null;
    if (first) { try { await Room.join(v.id, first.id); } catch (e) { /* 进不去也不影响建房 */ } }
    const code = v.joinCode ? formatCode(v.joinCode) : '';
    if (code) {
      // 房间号是朋友进房的唯一凭证，得让用户一眼看到、顺手能复制
      const ok = await dialog({
        title: '房间建好了',
        text: '房间号 ' + code + '。把这个发给朋友，他们点「+」→「输房间号」就能进来。',
        ok: '复制房间号',
      });
      if (ok) {
        try { await navigator.clipboard.writeText(code); toast('房间号已复制：' + code); }
        catch (e) { toast('房间号：' + code); }
      }
    } else {
      toast('房间建好了');
    }
  } catch (e) { toast(e.message); }
}
async function createRoom() {
  const v = cur(); if (!v) return;
  const wrap = el('div', 'dlg-body');
  const inp = el('input');
  inp.maxLength = 24;
  inp.placeholder = '频道名，例如：开黑一队';
  const tip = el('p', 'hint', '点进频道就能语音，右边还能直接发文字和截图。');
  wrap.append(inp, tip);
  setTimeout(() => inp.focus(), 0);
  const ok = await dialog({ title: '新建频道', extra: wrap, ok: '创建' });
  const n = (inp.value || '').trim();
  if (!ok || !n) return;
  // 要 await，否则失败会变成 unhandled rejection 静默掉，用户只看到界面没反应
  await act(api('POST', '/api/spaces/' + v.id + '/rooms', { name: n, kind: 'voice' }));
}
async function ensureReady() {
  if (!serverURL()) { openSettings('t-general'); toast('先填服务器地址'); return false; }
  if (!registered) { try { await register(); } catch (e) { toast(e.message); return false; } }
  return true;
}

// ============ 空间设置 ============
function openSpaceSettings() {
  const v = cur(); if (!v) return;
  const admin = canManage(v);
  drawSpaceIcon($('ssIcon'), v);
  $('ssName').value = v.name; $('ssName').disabled = !admin;
  const ms = $('ssMax'); ms.innerHTML = ''; for (let i = 2; i <= 12; i++) { const o = el('option', null, i + ' 人'); o.value = i; ms.appendChild(o); }
  ms.value = v.maxUsers; ms.disabled = !admin;
  $('ssIconBtn').classList.toggle('hidden', !admin); $('ssIconClear').classList.toggle('hidden', !admin);
  $('ssInvite').value = 'FONG-' + v.id;
  const codeEl = $('ssCode');
  if (codeEl) codeEl.textContent = v.joinCode ? formatCode(v.joinCode) : '（服务端未返回）';
  const ccBtn = $('ssCopyCode');
  if (ccBtn) ccBtn.onclick = async () => {
    if (!v.joinCode) { toast('这个房间还没有房间号，服务器版本较旧'); return; }
    const s = formatCode(v.joinCode);
    try { await navigator.clipboard.writeText(s); toast('房间号已复制：' + s); }
    catch (e) { toast('房间号：' + s); }
  };
  $('ssRoleHint').textContent = { owner: '你是所有者', admin: '你是管理员', member: '你是成员（只有所有者和管理员能改设置）' }[v.myRole] || '';
  $('ssDanger').textContent = v.myRole === 'owner' ? '解散房间' : '退出房间';
  $('ssDanger').onclick = () => { $('spaceSet').classList.add('hidden'); v.myRole === 'owner' ? deleteSpace(v) : leaveSpace(v); };
  drawMembers(v);
  switchTab2('s-info');
  $('spaceSet').classList.remove('hidden');
}
function drawSpaceIcon(node, v) {
  node.innerHTML = '';
  if (v.icon && v.icon.startsWith('data:image/')) { const i = el('img'); i.src = v.icon; i.alt = ''; node.appendChild(i); }
  else node.textContent = initial(v.name);
}
function drawMembers(v) {
  const box = $('ssMembers'); box.innerHTML = '';
  for (const m of v.members) {
    const row = el('div', 'mrow'); row.appendChild(avatar(m.name, null, m.avatar));
    row.appendChild(el('span', 'nm', m.name + (m.id === S.uid ? '（我）' : '')));
    row.appendChild(el('span', 'role ' + m.role, { owner: '所有者', admin: '管理员', member: '成员' }[m.role]));
    if (m.id !== S.uid && canManage(v)) {
      const b = el('button', 'icon-btn'); b.appendChild(icon('i-more')); b.setAttribute('aria-label', m.name + ' 的选项');
      b.onclick = (e) => { const [x, y] = menuAt(b); memberMenu(m, x, y); };
      row.appendChild(b);
    }
    box.appendChild(row);
  }
}
$('ssName').onchange = () => { const v = cur(); const n = $('ssName').value.trim(); if (n && n !== v.name) act(api('PATCH', `/api/spaces/${v.id}`, { name: n }), '已改名'); };
$('ssMax').onchange = () => { const v = cur(); act(api('PATCH', `/api/spaces/${v.id}`, { maxUsers: +$('ssMax').value }), '新频道默认上限已更新'); };
$('ssCopy').onclick = () => copyInvite(cur());
$('ssIconBtn').onclick = () => $('ssIconFile').click();
$('ssIconClear').onclick = () => { const v = cur(); act(api('PATCH', `/api/spaces/${v.id}`, { icon: '' })).then((nv) => nv && drawSpaceIcon($('ssIcon'), nv)); };
$('ssIconFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  try {
    const bmp = await createImageBitmap(f);
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const s = Math.min(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, 128, 128);
    const url = c.toDataURL('image/webp', 0.85);
    const v = cur(); const nv = await act(api('PATCH', `/api/spaces/${v.id}`, { icon: url }), '图标已更新');
    if (nv) drawSpaceIcon($('ssIcon'), nv);
  } catch (err) { toast('这张图读不了，换一张试试'); }
};
function switchTab2(id) { document.querySelectorAll('[data-tab2]').forEach((t) => t.classList.toggle('on', t.dataset.tab2 === id)); document.querySelectorAll('.tabpane2').forEach((p) => p.classList.toggle('hidden', p.id !== id)); }
document.querySelectorAll('[data-tab2]').forEach((t) => (t.onclick = () => switchTab2(t.dataset.tab2)));

// ============ 渲染：左侧 ============
function renderSpaces() {
  const box = $('spaceList'); box.innerHTML = '';
  for (const sid of S.spaceIds) {
    const v = Spaces.get(sid);
    const b = el('button', 'space-tile' + (sid === S.curSpace ? ' on' : '') + (Room.joined && Room.sid === sid ? ' live' : ''));
    b.setAttribute('role', 'listitem'); b.title = v ? v.name : '加载中…'; b.setAttribute('aria-label', b.title);
    if (v) drawSpaceIcon(b, v); else b.textContent = '·';
    b.onclick = () => { if (S.curSpace === sid) return; S.curSpace = sid; save(); $('roomSearch').value = ''; renderAll(); startPoll(); if (!Spaces.get(sid)) loadSpace(sid).then(renderAll).catch(() => {}); };
    b.oncontextmenu = (e) => { e.preventDefault(); if (S.curSpace !== sid) b.onclick(); setTimeout(() => spaceMenu(e.clientX, e.clientY), 0); };
    box.appendChild(b);
  }
}
function roomRow(v, rv) {
  const here = Room.wantRoom && Room.sid === v.id && Room.rid === rv.id;
  const textHere = chatKey === (v.id + ':' + rv.id) && chatOnly;
  const busy = rv.members.length > 0;
  const r = el('div', 'room' + ((here || textHere) ? ' on' : '') + (busy ? ' busy' : ''));
  r.tabIndex = 0; r.setAttribute('role', 'listitem'); r.setAttribute('aria-label', `${rv.name}，${rv.members.length}/${rv.maxUsers} 人`);
  const isText = rv.kind === 'text';
  const row = el('div', 'room-row'); row.appendChild(icon(isText ? 'i-hash' : 'i-volume'));
  row.appendChild(el('span', 'room-name', rv.name));
  // 【0.4.67】频道密码锁标记 —— 和 KOOK 一致：有密码的频道在列表里显示锁，
  // 不用点进去才被 403 告知。管理员看到的是开锁（他们免密），成员看到的是上锁。
  if (rv.hasPassword) {
    const lk = el('span', 'room-lock'); lk.title = canManage(v) ? '这个频道有密码（管理员免密）' : '这个频道需要密码';
    lk.appendChild(icon(canManage(v) ? 'i-unlock' : 'i-lock'));
    row.appendChild(lk);
  }
  // 人数 ≤ 6 时下面已经列出了每个人，这里再叠一组头像是重复信息
  if (busy && !here && rv.members.length > 6) { const st = el('span', 'stack'); rv.members.slice(0, 3).forEach((m) => st.appendChild(avatar(m.name, null, m.avatar))); row.appendChild(st); }
  if (!isText) row.appendChild(el('span', 'count' + (rv.members.length >= rv.maxUsers ? ' full' : ''), `${rv.members.length}/${rv.maxUsers}`));
  // 未读红点：这个频道的聊天有我没看过的新消息
  const uk = v.id + ':' + rv.id;
  if (!here && textUnread[uk]) row.appendChild(el('span', 'unread', textUnread[uk] > 99 ? '99+' : String(textUnread[uk])));
  if (canManage(v)) {
    const more = el('button', 'icon-btn more'); more.setAttribute('aria-label', rv.name + ' 的选项'); more.appendChild(icon('i-more'));
    more.onclick = (e) => { e.stopPropagation(); const [x, y] = menuAt(more); roomMenu(rv, x, y); };
    row.appendChild(more);
    r.oncontextmenu = (e) => { e.preventDefault(); roomMenu(rv, e.clientX, e.clientY); };
  }
  r.appendChild(row);
  if (busy && (here || rv.members.length <= 6)) {
    const ppl = el('div', 'room-people');
    for (const m of rv.members) {
      const p = el('div', 'rp' + (m.speaking ? ' sp' : '')); p.appendChild(avatar(m.name, null, m.avatar)); p.appendChild(el('span', null, m.name));
      if (m.muted || m.selfMuted) p.appendChild(icon('i-mic-off'));
      if (m.deafened) p.appendChild(icon('i-headphones-off'));
      attachHoverCard(p, m);   // 悬停出成员小卡（音量/静音），KOOK 式
      ppl.appendChild(p);
    }
    r.appendChild(ppl);
  }
  const go = () => { if (isText) openRoomChat(v.id, rv.id, false); else if (!here) Room.join(v.id, rv.id); };
  r.onclick = go; r.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
  return r;
}
function renderRooms() {
  const v = cur();
  const has = S.spaceIds.length > 0;
  $('noSpace').classList.toggle('hidden', has);
  $('spaceHead').classList.toggle('hidden', !has);
  $('roomList').classList.toggle('hidden', !has);
  const box = $('roomList'); box.innerHTML = '';
  $('emptyTitle').textContent = has ? (v ? '选一个语音频道，直接开说' : '加载中…') : '还没有房间';
  $('emptyText').textContent = has ? (v ? '左边点任意频道就能进，不用拨号。' : '') : '创建一个房间，把 6 位房间号发给朋友；或者输入朋友给你的房间号。';
  $('emptyCta').classList.toggle('hidden', has);
  if (!v) { $('spaceName').textContent = has ? '加载中…' : ''; $('addRoom').classList.add('hidden'); $('roomSearchWrap').classList.add('hidden'); return; }
  $('spaceName').textContent = v.name;
  $('addRoom').classList.toggle('hidden', !canManage(v));
  $('roomSearchWrap').classList.toggle('hidden', v.rooms.length <= 15);
  const q = $('roomSearch').value.trim().toLowerCase();
  const rooms = v.rooms.filter((r) => !q || r.name.toLowerCase().includes(q));
  const pinned = rooms.filter((r) => r.pinned), normal = rooms.filter((r) => !r.pinned);
  if (pinned.length) { const l = el('div', 'section-label'); l.appendChild(icon('i-pin')); l.appendChild(el('span', null, '常驻')); box.appendChild(l); pinned.forEach((r) => box.appendChild(roomRow(v, r))); }
  if (pinned.length && normal.length) box.appendChild(el('div', 'section-label', '频道'));
  normal.forEach((r) => box.appendChild(roomRow(v, r)));
  if (!rooms.length) box.appendChild(el('p', 'hint', q ? '没有匹配的频道' : '还没有频道，点下面新建一个'));
}
$('roomSearch').oninput = renderRooms;

// ============ 渲染：底栏 ============
function renderBar() {
  const off = Mic.muted || Mic.deafened || Mic.serverMuted;
  $('micCtl').classList.toggle('off', off);
  setIcon($('micIcon'), off ? 'i-mic-off' : 'i-mic');
  $('muteBtn').setAttribute('aria-pressed', String(Mic.muted));
  $('muteBtn').setAttribute('aria-label', Mic.muted ? '取消静音' : '静音麦克风');
  $('muteBtn').title = (Mic.muted ? '取消静音' : '静音') + keyHint('mute');
  $('muteLbl').textContent = Mic.serverMuted ? '被静音' : (Mic.muted ? '已静音' : '静音');
  $('deafLbl').textContent = Mic.deafened ? '已闭听' : '闭听';
  $('spkCtl').classList.toggle('off', Mic.deafened);
  setIcon($('deafIcon'), Mic.deafened ? 'i-headphones-off' : 'i-headphones');
  $('deafBtn').setAttribute('aria-pressed', String(Mic.deafened));
  $('deafBtn').title = (Mic.deafened ? '取消闭听' : '闭听（不听也不说）') + keyHint('deafen');
  const cb = $('callBtn'); const inCall = !!Room.wantRoom;
  cb.classList.toggle('hang', inCall);
  cb.querySelector('span').textContent = inCall ? '挂断' : '加入语音';
  cb.disabled = !inCall && !(cur() && cur().rooms.length);
  // 【0.4.18】右栏常驻控制条与底栏状态同步
  const pm = $('pMute'), pd = $('pDeaf'), ph = $('pHangup');
  if (pm) setIcon(pm, off ? 'i-mic-off' : 'i-mic');
  if (pd) setIcon(pd, Mic.deafened ? 'i-headphones-off' : 'i-headphones');
  if (ph) { ph.disabled = !inCall; ph.style.opacity = inCall ? '' : '.45'; }
  const tag = $('modeTag');
  if (S.mode === 'ptt') { tag.textContent = `按住 ${S.keys.ptt ? keyText(S.keys.ptt.label) : '?'} 说话`; tag.classList.toggle('live', Mic.ptt && !off); }
  else { tag.textContent = ''; tag.classList.remove('live'); }
  if (NATIVE) NATIVE.setState({ joined: inCall, muted: Mic.muted, deafened: Mic.deafened });
}
// 「`」这种符号键单独显示几乎看不见，补上中文名
const KEY_NAMES = { '`': '` 反引号', ' ': '空格', '\\': '\\ 反斜杠', ';': '; 分号', "'": "' 引号", ',': ', 逗号', '.': '. 句号', '/': '/ 斜杠', '-': '- 减号', '=': '= 等号', '[': '[ 左方括号', ']': '] 右方括号' };
const keyText = (l) => (l == null ? '' : (KEY_NAMES[l] || l));
const keyHint = (a) => (S.keys[a] ? `（${keyText(S.keys[a].label)}）` : '');
// ============ 频道内置聊天（OOPZ/KOOK 式：进语音房就能发文字/截图） ============
// 每个频道一条消息流，seq 自增做增量拉取游标。不用时间戳：同一毫秒来几条会漏。
let chatKey = null;        // 正在看聊天流的房间 "sid:rid"
let chatOnly = false;      // true = 不在语音、只看这个频道的聊天（旧文字频道）
let textSeq = 0;
let textTimer = null;
let textSendLock = false;
let pendingImg = null;     // 待发送的截图 Blob
const textUnread = Object.create(null);   // "sid:rid" -> 未读条数（内存态）

function timeStr(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// 【UI-FIX 0.4.36】剪贴板：先走 async API，失败退到 textarea + execCommand
// （Electron 里 navigator.clipboard 需要窗口有焦点，托盘/失焦场景会 reject）
async function copyText(t) {
  const v = String(t == null ? '' : t);
  if (!v) { toast('没有可复制的内容'); return; }
  try {
    await navigator.clipboard.writeText(v);
    toast('已复制');
    return;
  } catch (_) { /* 继续走兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = v;
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    toast(ok ? '已复制' : '复制失败');
  } catch (e) { toast('复制失败：' + (e.message || e)); }
}

// 【UI-FIX 0.4.36】引用回复：状态 + 输入框上方的引用条
let replyTo = null;
function setReplyTo(m) {
  replyTo = m ? { seq: m.seq, name: m.name || '某人', text: String(m.text || '').slice(0, 100) } : null;
  const bar = $('replyBar');
  if (!bar) return;
  if (!replyTo) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.innerHTML = '';
  bar.appendChild(el('span', 'reply-who', '回复 ' + replyTo.name));
  bar.appendChild(el('span', 'reply-text muted', replyTo.text || (m && m.img ? '[图片]' : '')));
  const x = el('button', 'icon-btn sm');
  x.innerHTML = '<svg><use href="#i-x"/></svg>';
  x.setAttribute('aria-label', '取消引用');
  x.onclick = () => setReplyTo(null);
  bar.appendChild(x);
  bar.classList.remove('hidden');
}

// 【0.4.38】日期分隔（KOOK/OOPZ 都有，FONG 之前只有样式 .msg-day 从未渲染）
function dayLabel(ts) {
  const d = new Date(ts), t = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, t)) return '今天';
  if (same(d, new Date(t.getTime() - 86400000))) return '昨天';
  const y = new Date(t.getTime() - 172800000);
  if (same(d, y)) return '前天';
  return d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + ' 月 ' + d.getDate() + ' 日';
}

function appendMsgs(list) {
  const box = $('msgList');
  const ph = box.querySelector('.msg-empty');
  if (ph) ph.remove();
  const v = chatKey ? Spaces.get(chatKey.split(':')[0]) : cur();
  const memberNames = v ? v.members.map((m) => m.name).filter(Boolean) : [];
  for (const m of list) {
    const d = el('div', 'msg' + (m.uid === S.uid ? ' mine' : ''));
    d.dataset.seq = m.seq;   // 【0.4.38】编辑后就地替换这一条
    d.appendChild(avatar(m.name, null, m.avatar));
    const body = el('div', 'msg-body');
    const head = el('div', 'msg-head');
    head.appendChild(el('b', null, m.name));
    head.appendChild(el('span', 'msg-time', timeStr(m.sentAt) + (m.edited ? ' · 已编辑' : '')));
    // 日期分隔：跨天时插一条
    const dl = dayLabel(m.sentAt);
    if (box.dataset.lastDay !== dl) {
      box.appendChild(el('div', 'day-sep', dl));
      box.dataset.lastDay = dl;
    }
    body.appendChild(head);
    if (m.deleted) {
      body.appendChild(el('div', 'msg-text muted', '消息已撤回'));
    } else {
      if (m.text) {
        // @提及高亮：@我的整条描边；被 @ 且窗口在后台 → 系统通知
        const mentionedMe = m.uid !== S.uid && m.text.indexOf('@' + (S.nick || '\u0000')) >= 0;
        if (mentionedMe) d.classList.add('mention-me');
        const tw = el('div', 'msg-text');
        splitMentions(m.text, memberNames).forEach((s) => tw.appendChild(s.mention ? el('b', 'mention', s.text) : document.createTextNode(s.text)));
        body.appendChild(tw);
        if (mentionedMe && document.hidden) notify(m.name + ' 在频道提到了你', { body: String(m.text).slice(0, 80) }, 'mention');
      }
      if (m.file) renderFileInto(body, m);
      if (m.img) {
        const im = el('img', 'msg-img');
        im.src = serverURL() + m.img;
        im.loading = 'lazy';
        im.alt = '截图';
        im.onclick = () => { if (im.classList.contains('img-fail')) { im.classList.remove('img-fail'); im.src = im.src.split('?')[0] + '?r=' + Date.now(); } else showLightbox(im.src); };
        im.onerror = () => { im.classList.add('img-fail'); im.title = '图片加载失败，点击重试'; console.warn('[img] 加载失败', im.src); };
        body.appendChild(im);
      }
    }
    d.appendChild(body);
    if (m.reaction) renderReacts(d, m);   // 已有回应
    // 撤回：右键自己的消息（管理员可撤任何人的）
    d.oncontextmenu = (e) => {
      // 【UI-FIX 0.4.36】原来这里只有"撤回"，而且非自己/非管理员直接 return ——
      // 于是右键要么没菜单、要么只能撤回，"复制"根本不存在。现在所有消息都给完整菜单。
      e.preventDefault();
      const mkCopy = () => ({ text: '复制文本', run: () => copyText(m.text || '') });
      const items = [mkCopy(), { text: '复制「昵称：内容」', run: () => copyText((m.name || '') + '：' + (m.text || '')) }];
      if (m.img) items.push({ text: '复制图片链接', run: () => copyText(serverURL() + m.img) });
      items.push({ text: '引用回复', run: () => { setReplyTo(m); $('msgInput').focus(); } });
      items.push({ text: '添加表情回应', run: () => openEmojiPanel($('msgInput'), (e) => toggleReaction(m, e)) });
      // 【0.4.38】编辑自己的消息（KOOK message_reeditbtn / OOPZ 同名功能）
      if (m.uid === S.uid && !m.deleted && m.text) items.push({ text: '编辑消息', run: () => startEdit(m) });
      if (m.text) items.push({ text: '在新窗口搜索', run: () => { try { window.open('https://www.bing.com/search?q=' + encodeURIComponent(m.text.slice(0, 120)), '_blank'); } catch (_) {} } });
      if (m.deleted || !chatKey) { openMenu(e.clientX, e.clientY, items); return; }
      const can = m.uid === S.uid || canManage(cur());
      if (!can) { openMenu(e.clientX, e.clientY, items); return; }
      const parts = chatKey.split(':');
      items.push({ text: m.uid === S.uid ? '撤回这条消息' : `替 ${m.name} 撤回`, icon: 'i-x', danger: true, run: async () => {
        try {
          const nm = await api('DELETE', `/api/spaces/${parts[0]}/rooms/${parts[1]}/messages/${m.seq}`);
          m.deleted = true; m.text = ''; m.img = '';
          const body2 = d.querySelector('.msg-body');
          body2.querySelector('.msg-text') && body2.querySelector('.msg-text').remove();
          body2.querySelector('.msg-img') && body2.querySelector('.msg-img').remove();
          body2.appendChild(el('div', 'msg-text muted', '消息已撤回'));
        } catch (err) { toast(err.message || '撤回失败'); }
      } });
      openMenu(e.clientX, e.clientY, items);
    };
    box.appendChild(d);
  }
  // 只在用户已经贴着底部时才自动滚，翻历史时不打断
  const near = box.scrollHeight - box.scrollTop - box.clientHeight < 120;
  if (near) box.scrollTop = box.scrollHeight;
}

// 把文本按 @成员名 切段（长名优先，避免 @小明 抢了 @小明的爸爸）
function splitMentions(text, names) {
  const out = [{ mention: false, text }];
  for (const n of [...new Set(names)].filter(Boolean).sort((a, b) => b.length - a.length)) {
    for (let i = out.length - 1; i >= 0; i--) {
      if (out[i].mention) continue;
      const parts = out[i].text.split('@' + n);
      if (parts.length > 1) {
        const repl = [];
        parts.forEach((p, idx) => { if (idx) repl.push({ mention: true, text: '@' + n }); if (p) repl.push({ mention: false, text: p }); });
        out.splice(i, 1, ...repl);
      }
    }
  }
  return out;
}

// ---- 图片灯箱：点缩略图 → 全屏原图 + 保存 ----
function showLightbox(src) {
  const lb = $('lightbox');
  if (!lb) return;
  lb.innerHTML = '';
  const im = el('img', 'lb-img');
  im.src = src;
  im.onclick = (e) => e.stopPropagation();
  const bar = el('div', 'lb-bar');
  const save = el('a', 'btn sm ghost', '保存图片');
  save.href = src;
  save.setAttribute('download', '');
  const close = el('button', 'btn sm', '关闭');
  close.onclick = () => lb.classList.add('hidden');
  bar.append(save, close);
  lb.append(im, bar);
  lb.classList.remove('hidden');
}

function stopTextPoll() {
  if (textTimer) { clearInterval(textTimer); textTimer = null; }
}

async function pollText() {
  if (!chatKey) return;
  const parts = chatKey.split(':');
  try {
    const r = await api('GET', '/api/spaces/' + parts[0] + '/rooms/' + parts[1] + '/messages?after=' + textSeq);
    const list = (r && r.messages) || [];
    if (list.length) {
      appendMsgs(list);
      textSeq = list[list.length - 1].seq;
      S.textSeen = S.textSeen || {}; S.textSeen[chatKey] = textSeq; save();
      // 【0.4.50】别人发的新消息 → 走统一通知出口（受级别/免打扰/音量约束）。
      // 窗口在前台且正看这个频道时不打扰；只有后台才弹。
      const fromOthers = list.filter((x) => x && x.uid !== S.uid && !x.deleted);
      if (fromOthers.length && document.hidden) {
        const last = fromOthers[fromOthers.length - 1];
        const mentme = fromOthers.some((x) => x.text && String(x.text).indexOf('@' + (S.nick || ' ')) >= 0);
        const v = cur();
        const rn = v ? ((v.rooms.find((x) => x.id === parts[1]) || {}).name || '') : '';
        notify((last.name || '有人') + (rn ? ' 在 ' + rn : '') + (fromOthers.length > 1 ? ' 等 ' + fromOthers.length + ' 条新消息' : ' 发来消息'),
               { body: String(last.text || (last.img ? '[图片]' : last.file ? '[文件]' : '')).slice(0, 80) },
               mentme ? 'mention' : 'msg');
      }
    } else if (!textSeq) {
      // 【UI-1】原来判断的是 `!box.querySelector('.msg')`（有没有消息）。
      // 但空态元素的 class 是 `msg-empty`，CSS 里 `.msg` 与 `.msg-empty` 是两个
      // 独立类，`querySelector('.msg')` 匹配不到它 → 每次轮询都判定"没有消息"
      // → 再 append 一个 → 长轮询 1.5 秒一次，无限堆积。
      // 修法：按「空态元素在不在」判断。
      const box = $('msgList');
      if (!box.querySelector('.msg-empty') && !box.querySelector('.msg')) {
        box.appendChild(el('p', 'msg-empty', '还没有人说话，打个招呼吧'));
      }
    }
  } catch (e) {
    // 轮询失败不打扰用户，下一轮自然重试
  }
}

// 打开一个频道的聊天流。inVoice=true 挂在语音房视图右侧；false 是旧文字频道的只读聊天。
function openRoomChat(sid, rid, inVoice) {
  const v = Spaces.get(sid);
  const rv = v && v.rooms.find((r) => r.id === rid);
  if (!rv) return;
  const key = sid + ':' + rid;
  const fresh = chatKey !== key;
  chatKey = key;
  chatOnly = !inVoice;
  $('roomTitle').textContent = inVoice ? rv.name : '#' + rv.name;
  $('roomSub').textContent = inVoice ? `${v ? v.name : ''} · ${rv.members.length}/${rv.maxUsers} 人` : '频道聊天 · 只保留最近 200 条';
  $('members').classList.toggle('hidden', chatOnly);
  $('skeleton').classList.add('hidden');
  if (fresh) {
    textSeq = 0;
    $('msgList').innerHTML = '';
    delete $('msgList').dataset.lastDay;   // 日期分隔游标也要重置
    textUnread[key] = 0;
    S.textSeen = S.textSeen || {}; S.textSeen[key] = 0;   // pollText 首包后写真实值
  }
  clearPendingImg();
  showRoom(true);
  $('shell').classList.remove('drawer');
  renderRooms();
  // 新消息靠服务端 bump 唤醒长轮询来收，这里确保长轮询在跑；定时器只防长轮询断线
  startPoll();
  if (fresh) {
    stopTextPoll();
    pollText().finally(() => { if (chatKey === key && !textTimer) textTimer = setInterval(pollText, 15000); });
  }
}

function stopChat() {
  chatKey = null; chatOnly = false; textSeq = 0;
  stopTextPoll();
  clearPendingImg();
}

// 只有「仅聊天模式」可以关掉；语音房聊天跟房走，不单独关
function closeText() {
  if (!chatKey || !chatOnly) return;
  stopChat();
  showRoom(false);
  renderRooms();
}

// ---- 【0.4.17】声音输出一键重置：重选扬声器刷新全部 setSinkId + 重进房重建接收链 ----
// 【0.4.18】重进房后再探一次发射：仍停滞 → 自动降级到元素直连播放（停用调音台引擎，老路必响）
async function audioRepair() {
  try {
    const wasStalled = !!Room._outWarned;   // 重进房会清标志，先记下这次是带着停滞来的
    await changeSpk(S.spk || 'default');
    const wr = Room.wantRoom;
    if (wr) { await Room.leave(true, true); await Room.join(wr.sid, wr.rid, true); }
    if (wasStalled) {
      await new Promise((r) => setTimeout(r, 3000));
      const stalled = await Room._probeEmission();
      if (stalled) {
        if (window.FongWire && FongWire.ready) { FongWire.ready = false; Room.syncAudio(); Room.applyVolumes(); }
        Room._outWarned = false;
        toast('已切换到备用播放通道，再让对方说一句试试');
        return;
      }
    }
    Room._outWarned = false;
    toast('声音输出已重置，让对方再说一句试试');
  } catch (e) { toast('重置失败：' + (e.message || e)); }
}

// ---- 未读红点：非当前频道的聊天有新消息 → 侧栏频道行角标 ----
// 首次见到的频道把 seen 跳到最新（历史不算未读）；长轮询唤醒 + 60 秒兜底各对一遍。
async function refreshUnread() {
  if (!registered || !S.curSpace) return;
  const v = Spaces.get(S.curSpace);
  if (!v) return;
  S.textSeen = S.textSeen || {};
  let changed = false;
  for (const rv of v.rooms) {
    const key = S.curSpace + ':' + rv.id;
    if (key === chatKey) continue;
    if (!(key in S.textSeen)) {
      try {
        const r = await api('GET', '/api/spaces/' + S.curSpace + '/rooms/' + rv.id + '/messages?after=0&limit=1');
        const ms = (r && r.messages) || [];
        S.textSeen[key] = ms.length ? ms[ms.length - 1].seq : 0;
      } catch (_) { S.textSeen[key] = 0; }
      changed = true;
      continue;
    }
    try {
      const r = await api('GET', '/api/spaces/' + S.curSpace + '/rooms/' + rv.id + '/messages?after=' + S.textSeen[key] + '&limit=200');
      const n = ((r && r.messages) || []).filter((m) => !m.deleted).length;
      if (n !== (textUnread[key] || 0)) { textUnread[key] = n; changed = true; }
    } catch (_) { /* 下一轮再说 */ }
  }
  if (changed) { save(); renderRooms(); }
}
setInterval(() => refreshUnread().catch(() => {}), 60000);

// ---- 截图：最长边压到 1280 / JPEG q0.85，先传 /images 再带图发消息 ----
// 【0.4.14】改用 createImageBitmap（与头像压缩同一条已验证路径，支持更多格式与 EXIF 方向），
// 失败时把真实原因透出到提示，不再只给一句「读不了」。
async function compressImage(file) {
  let bmp;
  try {
    bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch (e) {
    throw new Error('这张图读不了：' + ((e && e.message) || e.name || file.type || '格式不支持'));
  }
  try {
    const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * scale));
    c.height = Math.max(1, Math.round(bmp.height * scale));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return await new Promise((resolve, reject) => {
      c.toBlob((b) => b ? resolve(b) : reject(new Error('这张图压不动（浏览器编码失败）')), 'image/jpeg', 0.85);
    });
  } finally {
    if (bmp.close) bmp.close();
  }
}

function setPendingImg(blob) {
  clearPendingImg();
  pendingImg = blob;
  $('imgPreviewEl').src = URL.createObjectURL(blob);
  $('imgPreview').classList.remove('hidden');
}
function clearPendingImg() {
  if (pendingImg) {
    pendingImg = null;
    $('imgPreview').classList.add('hidden');
    $('imgPreviewEl').src = '';
  }
}

async function uploadImg(blob) {
  const parts = chatKey.split(':');
  const r = await fetch(serverURL() + '/api/spaces/' + parts[0] + '/rooms/' + parts[1] + '/images', {
    method: 'POST',
    headers: { 'X-Fong-Uid': S.uid, 'X-Fong-Key': S.key, 'X-Fong-Device': S.device || '', 'Content-Type': blob.type || 'image/jpeg' },
    body: blob,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || '截图上传失败 ' + r.status);
  return j.url;
}

// ===== 【0.4.49】表情面板 + 表情回应（KOOK emoji_* / OOPZ emoji_json 同级）=====
// 分三组常用表情，够日常用；后续可以换成图片集（结构不用动）。
const EMOJI_GROUPS = [
  ['常用', ['👍', '👎', '😀', '😂', '🤣', '😊', '😍', '🤔', '😅', '😭', '😡', '😱', '🙄', '😴', '🥳', '🤝', '👏', '🙏', '💪', '✌️', '👌', '🫡', '🤗', '😎']],
  ['反应', ['❤️', '💔', '🔥', '✨', '🎉', '💯', '⭐', '✅', '❌', '⚠️', '❓', '❗', '👀', '🧠', '🚀', '💤']],
  ['物件', ['🎮', '🎵', '🎧', '🍜', '🍺', '☕', '🌙', '☀️', '🌧️', '🐱', '🐶', '🌊', '🍂', '🏆', '💻', '📎']],
];
function buildEmojiPanel(target) {
  const p = $('emojiPanel');
  if (!p) return;
  if (!p.dataset.built) {
    for (const [cat, list] of EMOJI_GROUPS) {
      p.appendChild(el('div', 'emoji-cat', cat));
      const g = el('div', 'emoji-grid');
      for (const e of list) {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = e;
        b.title = e;
        b.onclick = () => { target(e); p.classList.add('hidden'); };
        g.appendChild(b);
      }
      p.appendChild(g);
    }
    p.dataset.built = '1';
  }
}
function openEmojiPanel(anchorEl, target) {
  const p = $('emojiPanel');
  if (!p) return;
  buildEmojiPanel(target);
  const r = anchorEl.getBoundingClientRect();
  p.classList.remove('hidden');
  const pw = 296, ph = Math.min(320, p.scrollHeight || 320);
  let left = r.left;
  if (left + pw > window.innerWidth - 12) left = window.innerWidth - pw - 12;
  let top = r.top - ph - 8;
  if (top < 50) top = r.bottom + 8;
  p.style.left = Math.max(8, left) + 'px';
  p.style.top = top + 'px';
  const off = (ev) => {
    if (p.contains(ev.target)) return;
    p.classList.add('hidden');
    document.removeEventListener('mousedown', off, true);
  };
  setTimeout(() => document.addEventListener('mousedown', off, true), 0);
}

// 表情回应：同一个人点同一个 emoji = 取消（服务端 toggle）
async function toggleReaction(m, emoji) {
  if (!chatKey || !m || !m.seq) return;
  const parts = chatKey.split(':');
  try {
    const upd = await api('POST', '/api/spaces/' + parts[0] + '/rooms/' + parts[1] + '/messages/' + m.seq + '/reactions', { emoji });
    m.reaction = upd && upd.reaction ? upd.reaction : null;
    const row = $('msgList').querySelector('[data-seq="' + m.seq + '"]');
    if (row) renderReacts(row, m);
  } catch (e) { toast(e.message || '表情没点上'); }
}

function renderReacts(row, m) {
  let box = row.querySelector('.msg-reacts');
  const r = m.reaction || {};
  const keys = Object.keys(r);
  if (!keys.length) { if (box) box.remove(); return; }
  if (!box) { box = el('div', 'msg-reacts'); row.querySelector('.msg-body').appendChild(box); }
  box.innerHTML = '';
  for (const e of keys) {
    const uids = r[e] || [];
    const chip = el('button', 'react-chip' + (uids.indexOf(S.uid) >= 0 ? ' mine' : ''));
    chip.type = 'button';
    chip.appendChild(el('span', 'rc-e', e));
    chip.appendChild(el('span', 'rc-n', String(uids.length)));
    chip.title = uids.length + ' 人回应 · 点击' + (uids.indexOf(S.uid) >= 0 ? '取消' : '加上你');
    chip.onclick = (ev) => { ev.stopPropagation(); toggleReaction(m, e); };
    box.appendChild(chip);
  }
}

function fmtSize(n) {
  const b = Number(n) || 0;
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
}

// 文件消息渲染
function renderFileInto(body, m) {
  const f = m.file;
  const box = el('div', 'msg-file');
  const ico = el('div', 'mf-ico');
  ico.innerHTML = '<svg><use href="#i-file"/></svg>';
  const b2 = el('div', 'mf-body');
  b2.appendChild(el('div', 'mf-name', f.name || '未命名文件'));
  b2.appendChild(el('div', 'mf-meta', fmtSize(f.size) + (f.mime ? ' · ' + String(f.mime).split('/').pop() : '')));
  const dl = el('a', 'icon-btn mf-dl');
  dl.href = serverURL() + f.url + '?n=' + encodeURIComponent(f.name || 'file');
  dl.setAttribute('download', f.name || 'file');
  dl.title = '下载';
  dl.innerHTML = '<svg><use href="#i-download"/></svg>';
  box.appendChild(ico); box.appendChild(b2); box.appendChild(dl);
  body.appendChild(box);
}

// 【0.4.38】本空间消息搜索（服务端 GET /api/spaces/{sid}/search?q= 已就绪）
function roomNameOf(rid) {
  const v = cur();
  const r = v && v.rooms.find((x) => x.id === rid);
  return r ? r.name : rid;
}
// ===== 【0.4.58】消息搜索：真实内嵌面板（原来的实现用了 window.prompt，
// Electron 渲染进程里 Chromium 不弹 prompt 直接返回 null —— 所以"点了没反应"。
// 而且那段绑定代码在写入时被 heredoc 吃掉，压根没进文件。两处都修。）
function openSearch() {
  const panel = $('searchPanel');
  if (!panel) return;
  if (!chatKey) { toast('先进一个频道'); return; }
  panel.classList.remove('hidden');
  const inp = $('searchInput');
  if (inp) { inp.value = ''; inp.focus(); }
  const list = $('searchList');
  if (list) list.innerHTML = '<div class="sp-hint">输入关键词后回车搜索本空间的所有频道</div>';
}
function closeSearch() {
  const panel = $('searchPanel');
  if (panel) panel.classList.add('hidden');
}
async function runSearch(q) {
  const list = $('searchList');
  if (!list) return;
  if (!q) { list.innerHTML = '<div class="sp-hint">输入关键词后回车搜索</div>'; return; }
  list.innerHTML = '<div class="sp-hint">搜索中…</div>';
  try {
    const sid = chatKey.split(':')[0];
    const hits = await api('GET', '/api/spaces/' + sid + '/search?q=' + encodeURIComponent(q));
    const arr = Array.isArray(hits) ? hits : [];
    list.innerHTML = '';
    if (!arr.length) {
      list.innerHTML = '<div class="sp-hint">「' + q + '」没有找到匹配的消息</div>';
      return;
    }
    const head = el('div', 'sp-count', '「' + q + '」找到 ' + arr.length + ' 条');
    list.appendChild(head);
    for (const h of arr) {
      const row = el('div', 'sp-row');
      const v = cur();
      const rm = v ? v.rooms.find(function (x) { return x.id === h.rid; }) : null;
      row.appendChild(el('div', 'sp-meta', (rm ? rm.name : h.rid) + ' · ' + (h.name || '') + ' · ' + timeStr(h.sentAt) + (h.edited ? ' · 已编辑' : '')));
      row.appendChild(el('div', 'sp-text', h.text || (h.img ? '[图片]' : (h.file ? '[文件] ' + h.file.name : ''))));
      row.onclick = function () { closeSearch(); jumpToMsg(h.rid, h.seq); };
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = '';
    list.appendChild(el('div', 'sp-hint', '搜索失败：' + (e.message || e)));
  }
}
async function jumpToMsg(rid, seq) {
  try {
    const v = cur();
    if (v && (!chatKey || chatKey.split(':')[1] !== rid)) openRoomChat(v.id, rid, false);
    setTimeout(function () {
      const row = $('msgList').querySelector('[data-seq="' + seq + '"]');
      if (!row) { toast('这条消息不在当前加载范围里（只保留最近 200 条）'); return; }
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('msg-flash');
      setTimeout(function () { row.classList.remove('msg-flash'); }, 1600);
    }, 450);
  } catch (e) { toast('跳转失败：' + (e.message || e)); }
}
// 入口绑定（幂等：重复执行不会叠加监听）
(function bindSearchUI() {
  const btn = $('msgSearchBtn');
  if (btn && !btn.dataset.bound) {
    btn.dataset.bound = '1';
    btn.addEventListener('click', openSearch);
  }
  const closeBtn = $('searchClose');
  if (closeBtn && !closeBtn.dataset.bound) {
    closeBtn.dataset.bound = '1';
    closeBtn.addEventListener('click', closeSearch);
  }
  const inp = $('searchInput');
  if (inp && !inp.dataset.bound) {
    inp.dataset.bound = '1';
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); runSearch(inp.value.trim()); }
      else if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
      e.stopPropagation();
    });
  }
})();
// Ctrl+F / Cmd+F 打开搜索
document.addEventListener('keydown', function (e) {
  if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
    if (!chatKey) return;
    e.preventDefault();
    openSearch();
  }
}, true);
function showSearchResults(q, hits) {
  const old = document.getElementById('searchPanel');
  if (old) old.remove();
  const p = document.createElement('div');
  p.id = 'searchPanel';
  p.className = 'search-panel';
  const head = el('div', 'search-head', '「' + q + '」找到 ' + hits.length + ' 条');
  const x = el('button', 'icon-btn sm');
  x.innerHTML = '<svg><use href="#i-x"/></svg>';
  x.setAttribute('aria-label', '关闭搜索');
  x.onclick = () => p.remove();
  head.appendChild(x);
  p.appendChild(head);
  const list = el('div', 'search-list');
  if (!hits.length) list.appendChild(el('div', 'search-row muted', '这个空间里没有匹配的消息'));
  for (const h of hits) {
    const row = el('div', 'search-row');
    row.appendChild(el('div', 'sr-meta', roomNameOf(h.rid) + ' · ' + (h.name || '') + ' · ' + timeStr(h.sentAt) + (h.edited ? ' · 已编辑' : '')));
    row.appendChild(el('div', 'sr-text', h.text || (h.img ? '[图片]' : '')));
    row.onclick = () => { p.remove(); highlightMsg(h.rid, h.seq); };
    list.appendChild(row);
  }
  p.appendChild(list);
  document.body.appendChild(p);
  const esc = (e) => { if (e.key === 'Escape') { p.remove(); document.removeEventListener('keydown', esc, true); } };
  document.addEventListener('keydown', esc, true);
}
// 跳到命中的那条消息：切到它所在频道并闪一下
async function highlightMsg(rid, seq) {
  try {
    const v = cur();
    // 搜到别的频道 → 先切过去（真实函数是 openRoomChat，别写成不存在的 openChat）
    if (v && (!chatKey || chatKey.split(':')[1] !== rid)) openRoomChat(v.id, rid, false);
    setTimeout(() => {
      const row = $('msgList').querySelector('[data-seq="' + seq + '"]');
      if (!row) { toast('这条消息不在当前加载范围里（只保留最近 200 条）'); return; }
      row.scrollIntoView({ block: 'center', behavior: 'smooth' });
      row.classList.add('msg-flash');
      setTimeout(() => row.classList.remove('msg-flash'), 1600);
    }, 450);
  } catch (e) { toast('跳转失败：' + (e.message || e)); }
}

// 【0.4.38】消息编辑：把原文放回输入框，发送时改走 PATCH，成功后就地更新 DOM
let editing = null;
function startEdit(m) {
  if (!chatKey || !m) return;
  editing = { seq: m.seq, orig: m.text };
  const ta = $('msgInput');
  ta.value = m.text || '';
  ta.style.height = 'auto';
  ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  ta.focus();
  ta.selectionStart = ta.selectionEnd = ta.value.length;
  showEditBar();
}
function showEditBar() {
  const bar = $('replyBar');
  if (!bar || !editing) return;
  bar.innerHTML = '';
  bar.appendChild(el('span', 'reply-who', '编辑中'));
  bar.appendChild(el('span', 'reply-text muted', String(editing.orig || '').slice(0, 80)));
  const x = el('button', 'icon-btn sm');
  x.innerHTML = '<svg><use href="#i-x"/></svg>';
  x.setAttribute('aria-label', '取消编辑');
  x.onclick = () => cancelEdit();
  bar.appendChild(x);
  bar.classList.remove('hidden');
}
function cancelEdit() {
  editing = null;
  const bar = $('replyBar');
  if (bar) { bar.classList.add('hidden'); bar.innerHTML = ''; }
  const ta = $('msgInput');
  if (ta) { ta.value = ''; ta.style.height = 'auto'; }
}

async function sendMsg() {
  if (textSendLock || !chatKey) return;
  const ta = $('msgInput');
  const t = (ta.value || '').trim();
  if (!t && !pendingImg && !pendingFile) return;
  const parts = chatKey.split(':');
  // 【0.4.38】编辑模式：同一个输入框，改成 PATCH
  if (editing) {
    const seq = editing.seq;
    textSendLock = true;
    try {
      const m2 = await api('PATCH', '/api/spaces/' + parts[0] + '/rooms/' + parts[1] + '/messages/' + seq, { text: t });
      const row = $('msgList').querySelector('[data-seq="' + seq + '"]');
      if (row) {
        const tw = row.querySelector('.msg-text');
        if (tw) { tw.textContent = t; }
        const tm = row.querySelector('.msg-time');
        if (tm) tm.textContent = timeStr(m2.sentAt || Date.now()) + ' · 已编辑';
      }
      cancelEdit();
    } catch (e) {
      toast(e.message || '编辑失败');
      ta.value = t;
    } finally {
      textSendLock = false;
    }
    return;
  }
  textSendLock = true;
  // 【UI-FIX 0.4.36】引用回复：服务端协议不变，引用以纯文本前缀带上（KOOK/OOPZ 也是这个做法）
  const rq = replyTo;
  const payload = rq ? ('> 回复 ' + rq.name + '：' + (rq.text || '') + String.fromCharCode(10) + t) : t;
  ta.value = '';
  ta.style.height = 'auto';
  try {
    const img = pendingImg ? await uploadImg(pendingImg) : '';
    const file = pendingFile || undefined;
    const m = await api('POST', '/api/spaces/' + parts[0] + '/rooms/' + parts[1] + '/messages', { text: payload, img, file });
    if (rq) setReplyTo(null);
    if (file) setPendingFile(null);
    if (m && m.seq) { appendMsgs([m]); textSeq = m.seq; }
    clearPendingImg();
  } catch (e) {
    ta.value = t;   // 发失败把内容还给用户（图/文件留着，直接重发即可）
    if (rq) setReplyTo(rq);
    toast(e.status === 429 ? '发得太快了，缓一下' : (e.message || '发送失败'));
  } finally {
    textSendLock = false;
  }
}

$('msgSend').onclick = () => sendMsg();
// 【UI-FIX 0.4.36】输入框右键菜单（Electron 无原生菜单，main.js 也禁了应用菜单，
// 所以这里必须自绘，否则剪切/复制/粘贴/全选全都不可达）
(function bindInputMenu() {
  const ta = $('msgInput');
  if (!ta) return;
  ta.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    const sel = (ta.value || '').slice(ta.selectionStart || 0, ta.selectionEnd || 0);
    const items = [];
    items.push({ text: '剪切', run: () => { try { document.execCommand('cut'); } catch (_) {} } });
    items.push({ text: '复制', run: () => copyText(sel || ta.value || '') });
    items.push({ text: '粘贴', run: async () => {
      try {
        const t = await navigator.clipboard.readText();
        const p0 = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
        ta.value = ta.value.slice(0, p0) + t + ta.value.slice(ta.selectionEnd == null ? p0 : ta.selectionEnd);
        ta.selectionStart = ta.selectionEnd = p0 + t.length;
        ta.dispatchEvent(new Event('input', { bubbles: true }));
      } catch (err) { toast('读剪贴板失败，用 Ctrl+V 试试'); }
    } });
    items.push({ text: '全选', run: () => { ta.select(); } });
    items.push({ text: '清空', run: () => { ta.value = ''; ta.style.height = 'auto'; } });
    openMenu(e.clientX, e.clientY, items);
  });
})();
// 【UI-FIX 0.4.36】Esc 取消引用（有引用时才吃掉这个键，不影响其它 Esc 行为）
$('msgInput').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && (replyTo || editing)) { e.stopPropagation(); if (editing) cancelEdit(); else setReplyTo(null); }
}, true);
$('msgInput').addEventListener('keydown', (e) => {
  // 【0.4.64】输入法选词中：回车是「确认候选」，不是「发送」。
  // 这是 Chromium 的确定行为（isComposing=true，部分输入法还带 keyCode 229），
  // 不是猜测——中文用户每打一次词都可能触发。
  if (e.isComposing || e.keyCode === 229) return;
  // 【0.4.64】发送键偏好：ctrl 模式下 Ctrl+Enter 发送、单独 Enter 走默认换行
  const ctrlSend = (S.sendKey || 'enter') === 'ctrl';
  const hit = ctrlSend
    ? (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.shiftKey)
    : (e.key === 'Enter' && !e.shiftKey);
  if (hit) { e.preventDefault(); sendMsg(); }
  if (e.key === 'Escape') closeText();
});
$('msgInput').addEventListener('input', (e) => {
  const ta = e.target;
  ta.style.height = 'auto';
  ta.style.height = Math.min(120, ta.scrollHeight) + 'px';
  // 【UI-FIX 0.4.36】接近上限时给计数提示（原来打满 2000 字后静默不能输入）
  const cnt = $('msgCount');
  if (cnt) {
    const n = (ta.value || '').length, max = ta.maxLength > 0 ? ta.maxLength : 2000;
    const nearMax = n >= max * 0.8;
    cnt.textContent = nearMax ? n + ' / ' + max : '';
    cnt.classList.toggle('hidden', !nearMax);
    cnt.classList.toggle('over', n >= max);
  }
});
// @提及：敲下 @ 弹成员选择，选完插入 @名字（KOOK/OOPZ 式）
$('msgInput').addEventListener('keyup', (e) => {
  if (e.key !== '@' || !cur()) return;
  const items = cur().members.filter((m) => m.id !== S.uid).map((m) => ({ text: m.name, run: () => {
    const ta = $('msgInput');
    const pos = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
    ta.value = ta.value.slice(0, pos) + m.name + ' ' + ta.value.slice(pos);
    ta.selectionStart = ta.selectionEnd = pos + m.name.length + 1;
    ta.focus();
  } }));
  if (items.length) { const [x, y] = menuAt($('msgInput')); openMenu(x, y, items); }
});
// ===== 【0.4.50】通知 tab 绑定 =====
(function bindNotifyTab() {
  const lv = $('notifyLevel'), dnd = $('dnd'), vol = $('toneVol'), volLbl = $('toneVolLbl');
  const onJoin = $('notifyOnJoin'), onMsg = $('notifyOnMsg'), permBtn = $('notifyPermBtn'), permState = $('notifyPermState');
  if (!lv) return;
  const paintPerm = () => {
    if (!permState) return;
    const st = (typeof Notification !== 'undefined') ? Notification.permission : 'unsupported';
    permState.textContent = st === 'granted' ? '系统通知已授权' : (st === 'denied' ? '已被系统拒绝（要在系统设置里放开）' : '还没授权');
  };
  lv.onchange = () => { S.notifyLevel = lv.value; save(); };
  if (dnd) dnd.onchange = () => {
    S.dnd = dnd.checked; save();
    toast(S.dnd ? '免打扰已开：通知与提示音都停了，通话照常' : '免打扰已关');
  };
  if (vol) vol.oninput = () => {
    S.toneVol = Math.max(0, Math.min(100, +vol.value || 0)); save();
    if (volLbl) volLbl.textContent = S.toneVol + '%';
  };
  if (onJoin) onJoin.onchange = () => { S.notifyOnJoin = onJoin.checked; save(); };
  if (onMsg) onMsg.onchange = () => { S.notifyOnMsg = onMsg.checked; save(); };
  if (permBtn) permBtn.onclick = async () => {
    try { await Notification.requestPermission(); } catch (_) {}
    paintPerm();
  };
  // 每次打开设置时同步一次 UI（设置面板是常驻 DOM，不重建）
  window.__paintNotify = () => {
    lv.value = S.notifyLevel || 'mention';
    if (dnd) dnd.checked = !!S.dnd;
    if (vol) vol.value = String(S.toneVol == null ? 100 : S.toneVol);
    if (volLbl) volLbl.textContent = (S.toneVol == null ? 100 : S.toneVol) + '%';
    if (onJoin) onJoin.checked = S.notifyOnJoin !== false;
    if (onMsg) onMsg.checked = S.notifyOnMsg !== false;
    paintPerm();
  };
  window.__paintNotify();
})();

// ===== 【0.4.64】发送键偏好（Enter / Ctrl+Enter）=====
// 提示文案必须跟着模式走：原来不管哪种模式，placeholder 都写「回车发送」，
// 切成 Ctrl 模式后那句提示就是错的，会直接误导用户。
function paintSendHint() {
  const ta = $('msgInput');
  const ctrl = (S.sendKey || 'enter') === 'ctrl';
  if (ta) {
    ta.placeholder = ctrl
      ? '说点什么…（Ctrl+回车发送，回车换行）'
      : '说点什么…（回车发送，Shift+回车换行）';
  }
  const hint = $('sendKeyHint');
  if (hint) hint.textContent = ctrl ? 'Ctrl+Enter 发送，Enter 换行' : 'Enter 发送，Shift+Enter 换行';
}
(function bindSendKey() {
  const sel = $('sendKey');
  if (!sel) return;
  sel.onchange = () => {
    S.sendKey = sel.value === 'ctrl' ? 'ctrl' : 'enter';
    save();
    paintSendHint();
    toast(S.sendKey === 'ctrl' ? '已切换：Ctrl+回车发送' : '已切换：回车发送');
  };
  // 设置面板是常驻 DOM、不重建，所以每次打开时同步一次
  window.__paintSendKey = () => {
    sel.value = S.sendKey === 'ctrl' ? 'ctrl' : 'enter';
    paintSendHint();
  };
})();
paintSendHint();   // 启动即按当前偏好设置占位文案

$('shotBtn').onclick = () => $('shotFile').click();
// 【0.4.49】任意文件：选完立刻上传（与截图同一条思路，先传后发，发送时才带引用）
let pendingFile = null;
function setPendingFile(f) {
  pendingFile = f || null;
  const bar = $('filePreview');
  if (!bar) return;
  if (!f) { bar.classList.add('hidden'); bar.innerHTML = ''; return; }
  bar.innerHTML = '';
  bar.appendChild(el('span', 'fp-name', f.name));
  bar.appendChild(el('span', 'muted', fmtSize(f.size)));
  const x = el('button', 'icon-btn sm');
  x.innerHTML = '<svg><use href="#i-x"/></svg>';
  x.setAttribute('aria-label', '移除文件');
  x.onclick = () => setPendingFile(null);
  bar.appendChild(x);
  bar.classList.remove('hidden');
}
$('fileBtn').onclick = () => $('anyFile').click();
$('anyFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  if (f.size > 25 * 1024 * 1024) { toast('文件太大（上限 25MB）'); return; }
  if (!chatKey) { toast('先进一个频道'); return; }
  const parts = chatKey.split(':');
  try {
    toast('正在上传 ' + f.name + '…');
    const resp = await fetch(serverURL() + '/api/spaces/' + parts[0] + '/rooms/' + parts[1] + '/files', {
      method: 'POST',
      headers: Object.assign({}, authHeaders(), {
        'Content-Type': f.type || 'application/octet-stream',
        'X-Fong-Filename': encodeURIComponent(f.name),
      }),
      body: f,
    });
    if (!resp.ok) { const j = await resp.json().catch(() => ({})); throw new Error(j.error || ('上传失败 ' + resp.status)); }
    const ref = await resp.json();
    setPendingFile(ref);
  } catch (err) { toast(err.message || '上传失败'); }
};
// 表情按钮
$('emojiBtn').onclick = () => openEmojiPanel($('emojiBtn'), (e) => {
  const ta = $('msgInput');
  const p0 = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
  ta.value = ta.value.slice(0, p0) + e + ta.value.slice(ta.selectionEnd == null ? p0 : ta.selectionEnd);
  ta.selectionStart = ta.selectionEnd = p0 + e.length;
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  ta.focus();
});
$('shotFile').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try { setPendingImg(await compressImage(f)); } catch (err) { toast(err.message || '这张图读不了'); }
};
// 截图最顺手的入口：Ctrl+V 直接贴
document.addEventListener('paste', (e) => {
  if (!chatKey) return;
  const f = [...(e.clipboardData ? e.clipboardData.files : [])].find((x) => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); compressImage(f).then(setPendingImg).catch((err) => toast(err.message || '这张图读不了')); }
});
$('imgPreviewX').onclick = clearPendingImg;

function showRoom(on) {
  $('roomView').classList.toggle('hidden', !on);
  $('empty').classList.toggle('hidden', on || !!chatKey);
}

// ---- 右栏：空间成员在线/离线（在线 = 软件开着；在哪个语音房看归属） ----
// 【0.4.14】控件不再平铺在列表里（用户反馈：看不到名字、不合 KOOK/OOPZ 习惯）——
// 悬停头像/名字弹悬浮成员卡（音量/静音），右键仍是完整菜单。
function renderPresence() {
  const box = $('presence');
  if (!box) return;
  const v = cur();
  if (!v) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const on = [], off = [];
  const where = {};
  for (const rv of v.rooms) for (const m of rv.members) where[m.id] = rv.name;
  for (const m of v.members) ((m.online || m.id === S.uid) ? on : off).push(m);
  $('presenceTitle').textContent = '成员 · ' + on.length + '/' + v.members.length;
  const draw = (list, elId, label) => {
    const g = $(elId); g.innerHTML = '';
    g.appendChild(el('div', 'presence-label', label + ' - ' + list.length));
    for (const m of list) {
      const row = el('div', 'presence-row');
      row.appendChild(avatar(m.name, null, m.avatar));
      const nm = el('div', 'presence-name');
      // 名字 + 封禁标记放在同一个 flex row 里（presence-name 本身是 column，
      // 直接 append 会让标签独占一行并撑满整行 —— 截图验证过）
      const nameRow = el('div', 'presence-namerow');
      nameRow.appendChild(el('span', 'presence-nm', m.name + (m.id === S.uid ? '（我）' : '')));
      // 【0.4.66】封禁标记必须显式：被封者的 online 必然是 false、peer 为空，
      // 只靠离线灰显的话，管理员看到的就是"一个普通离线成员"，不会想到去点菜单解封。
      if (m.banned) nameRow.appendChild(el('span', 'presence-banned', '已封禁'));
      nm.appendChild(nameRow);
      if (m.playing) nm.appendChild(el('span', 'presence-room', '正在玩 ' + m.playing));
      if (where[m.id]) nm.appendChild(el('span', 'presence-room', '语音 · ' + where[m.id]));
      row.appendChild(nm);
      attachHoverCard(row, m);
      row.oncontextmenu = (e) => { e.preventDefault(); memberMenu(m, e.clientX, e.clientY); };
      g.appendChild(row);
    }
  };
  draw(on, 'presenceOnline', '在线');
  draw(off, 'presenceOffline', '离线');
}

// ---- 悬浮成员卡（KOOK/OOPZ 式）：悬停头像/名字 → 音量滑块 + 静音该用户（只对我） ----
let hoverTimer = null, hoverHideTimer = null;
function hideHoverCard(soon) {
  if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = null; }
  if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
  if (soon) hoverHideTimer = setTimeout(() => { $('hoverCard').classList.add('hidden'); hoverHideTimer = null; }, 180);
  else $('hoverCard').classList.add('hidden');
}
function showHoverCard(anchor, m) {
  const card = $('hoverCard');
  if (!card) return;
  if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; }
  const isMe = m.id === S.uid;
  card.innerHTML = '';
  const head = el('div', 'hc-head');
  head.appendChild(avatar(m.name, null, m.avatar));
  const hw = el('div', 'hc-who');
  hw.appendChild(el('div', 'hc-name', m.name + (isMe ? '（我）' : '')));
  hw.appendChild(el('div', 'hc-role', { owner: '所有者', admin: '管理员', member: '成员' }[m.role] || ''));
  if (m.playing) hw.appendChild(el('div', 'hc-role', '正在玩 ' + m.playing));
  head.appendChild(hw);
  card.appendChild(head);
  if (!isMe) {
    const vol = el('div', 'hc-vol');
    vol.appendChild(el('span', 'hc-lab', '音量'));
    const Wr = (window.FongWire && FongWire.ready) ? FongWire : null;
    const ceil = Wr ? Wr.ceiling() : 100;
    const r = el('input', 'hc-range');
    r.type = 'range'; r.min = 0; r.max = ceil;
    r.value = Wr ? Wr.volume(m.id) : (S.memberVol[m.id] ?? 100);
    // 【0.4.14】KOOK/OOPZ 口径：数值实时跟手，不然用户不知道拉到多少
    const val = el('span', 'hc-val', r.value + '%');
    const paintVol = () => { if (Wr) r.style.background = Wr.paint(+r.value, ceil); val.textContent = r.value + '%'; };
    paintVol();
    r.oninput = () => { if (Wr) r.value = Wr.setVolume(m.id, +r.value, true); else { S.memberVol[m.id] = +r.value; save(); } paintVol(); Room.applyVolumes(); };
    r.onchange = () => { if (Wr) { r.value = Wr.setVolume(m.id, +r.value, false); paintVol(); } };
    r.onwheel = (e) => { if (!Wr) return; e.preventDefault(); r.value = Wr.nudge(m.id, e.deltaY, e.shiftKey); paintVol(); Room.applyVolumes(); };
    vol.appendChild(r);
    vol.appendChild(val);
    card.appendChild(vol);
    const mb = el('button', 'btn sm ' + (S.localMute[m.id] ? '' : 'ghost'), S.localMute[m.id] ? '取消屏蔽（只对我）' : '静音该用户（只对我）');
    mb.onclick = () => {
      if (S.localMute[m.id]) delete S.localMute[m.id]; else S.localMute[m.id] = true;
      save(); Room.applyVolumes();
      mb.textContent = S.localMute[m.id] ? '取消屏蔽（只对我）' : '静音该用户（只对我）';
      mb.className = 'btn sm ' + (S.localMute[m.id] ? '' : 'ghost');
    };
    card.appendChild(mb);
  }
  card.classList.remove('hidden');
  const rr = anchor.getBoundingClientRect();
  const cw = card.offsetWidth, ch = card.offsetHeight;
  let x = rr.right + 8, y = rr.top - 4;
  if (x + cw > innerWidth - 8) x = rr.left - cw - 8;
  x = Math.max(8, Math.min(x, innerWidth - cw - 8));
  y = Math.max(8, Math.min(y, innerHeight - ch - 8));
  card.style.left = x + 'px'; card.style.top = y + 'px';
  card.onmouseenter = () => { if (hoverHideTimer) { clearTimeout(hoverHideTimer); hoverHideTimer = null; } };
  card.onmouseleave = () => hideHoverCard(true);
}
function attachHoverCard(row, m) {
  row.onmouseenter = () => { if (hoverTimer) clearTimeout(hoverTimer); hoverTimer = setTimeout(() => { hoverTimer = null; showHoverCard(row, m); }, 300); };
  row.onmouseleave = () => hideHoverCard(true);
}

function renderAll() { renderSpaces(); renderRooms(); renderBar(); Room.renderMembers(); renderMe(); renderPresence(); }

// ============ 我的资料（侧栏底部头像） ============
function renderMe() {
  const b = $('meBtn');
  if (!b) return;
  b.textContent = '';
  const a = avatar(S.nick || '我', 'big', avatarOf(S.uid));
  a.style.cssText = 'width:36px;height:36px;font-size:14px';
  b.appendChild(a);
  b.classList.toggle('anon', !S.accountId);
  b.title = S.nick ? (S.nick + ' · 我的资料') : '我的资料';
}

function openProfileCard() {
  const box = el('div', 'profile-card');
  const head = el('div', 'profile-head');
  const big = avatar(S.nick || '我', 'big', avatarOf(S.uid));
  big.style.cssText = 'width:72px;height:72px;font-size:26px';
  const who = el('div', 'profile-who');
  const nm = el('div', 'profile-name', S.nick || '未命名');
  const em = el('div', 'profile-mail', S.email || '未登录');
  who.append(nm, em);
  head.append(big, who);

  const row = el('div', 'profile-actions');
  const bAv = el('button', 'btn ghost sm', '换头像');
  bAv.onclick = () => { $('dlgCancel').click(); setTimeout(() => openAvatarDialog(), 0); };
  const bAcc = el('button', 'btn ghost sm', '账号与设备');
  bAcc.onclick = () => { $('dlgCancel').click(); setTimeout(() => openSettings('t-account'), 0); };
  row.append(bAv, bAcc);
  box.append(head, row);
  return dialog({ title: '我的资料', ok: '完成', extra: box });
}

$('meBtn').onclick = () => openProfileCard();

$('callBtn').onclick = () => {
  if (Room.wantRoom) return Room.leave();
  const v = cur(); if (!v || !v.rooms.length) return;
  const rid = v.rooms.some((r) => r.id === S.lastRoom[v.id]) ? S.lastRoom[v.id] : v.rooms[0].id;
  Room.join(v.id, rid);
};
$('muteBtn').onclick = () => setMuted(!Mic.muted);
$('deafBtn').onclick = () => setDeafened(!Mic.deafened);
// 【0.4.18】右栏常驻控制条（进频道后底栏被布局吞掉时的保底入口）
$('pMute').onclick = () => setMuted(!Mic.muted);
$('pDeaf').onclick = () => setDeafened(!Mic.deafened);
$('pSettings').onclick = () => openSettings();
$('pHangup').onclick = () => { if (Room.wantRoom) Room.leave(); };
$('addSpace').onclick = addSpaceFlow;
$('noSpaceCreate').onclick = addSpaceFlow;
$('noSpaceJoin').onclick = () => addSpaceFlow('code');
$('emptyCreate').onclick = () => addSpaceFlow();
$('emptyJoin').onclick = () => addSpaceFlow('code');
$('addRoom').onclick = createRoom;
$('spaceHead').onclick = () => { const [x, y] = menuAt($('spaceHead')); spaceMenu(x, y); };
$('drawerBtn').onclick = () => $('shell').classList.add('drawer');
$('scrim').onclick = () => $('shell').classList.remove('drawer');

async function changeMic(id) { S.mic = id; save(); for (const s of ['micSel', 'obMic', 'setMic']) $(s).value = id; try {
  const t = await Mic.start(true);   // 换设备必须真重建
  // 【0.4.10 · 审查 P0-1】旧条件 `Mic.sender && Mic.sending` 恒假 —— Mic.start() 内部
  // 已把 sending 置 null，而旧轨道已被 stop。结果：换麦/切降噪档后 sender 还挂着
  // ended 的旧轨道，对方听到死麦直到重进房。只要在语音中就无条件换新轨道。
  // 【0.4.11】replaceTrack 用克隆轨（Mic.track 留给耳返）。
  if (Mic.sender && Room.joined) {
    try { const st = Mic.sendTrack || t; st.enabled = Mic.wantSend(); await Mic.sender.replaceTrack(st); } catch (_) {}
  }
  // 【0.4.55】链路重建 → 监听（耳返）必须重挂到新轨，否则永久哑掉
  try { if (window.Loop && Loop.resync) Loop.resync(); } catch (_) {}
  // 【独立审查 · 0.4.45】Mic.start(true) 会重建 AecRef 链并清空 far 挂载点；这里立刻补一刀，
  // 否则 far 环空转，直到某次无关的 syncAudio（成员变化 / onunmute）才恢复。
  try { AecRef.resync(); if (AecRef.started) AecRef.watch(); } catch (_) {}
} catch (e) { micError(e); } }
async function changeSpk(id) {
  S.spk = id; save(); for (const s of ['spkSel', 'obSpk', 'setSpk']) $(s).value = id;
  if (window.FongWire && FongWire.ready) {
    await FongWire.routeTo(id);          // WebAudio 路径：切 ctx.setSinkId（也顺带切各 lane 的 <audio>）
  }
  // 【0.4.20】element 通道下没有 lane，desk.routeTo 无从下手 —— 这里直接切每个播放元素的 sink。
  if (!wireWebAudio()) {
    for (const a of Room.audios.values()) if (a.audio.setSinkId) a.audio.setSinkId(id).catch(() => {});
  }
  if (Loop.audio && Loop.audio.setSinkId) Loop.audio.setSinkId(id).catch(() => {});
}
for (const s of ['micSel', 'obMic', 'setMic']) $(s).onchange = (e) => changeMic(e.target.value);
for (const s of ['spkSel', 'obSpk', 'setSpk']) $(s).onchange = (e) => changeSpk(e.target.value);

// ============ 设置 ============
function openSettings(tab) {
  try { if (window.__paintNotify) window.__paintNotify(); } catch (_) {}
  try { if (window.__paintSendKey) window.__paintSendKey(); } catch (_) {}
  $('nick').value = S.nick; $('ice').value = S.ice;
  const avb = $('avatarBtn'); if (avb) avb.onclick = () => openAvatarDialog();
  for (const k of ['duck', 'ns', 'agc', 'aec', 'sounds', 'autostart']) $(k).checked = S[k];
  renderDnModes();
  renderDuck();
  renderHfModes();
  renderOpusTiers();
  renderAccount();
  $('thr').value = S.thr; $('duckDb').value = S.duckDb; syncVals(); renderKeys(); renderMode();
  $('selfId').textContent = S.uid.slice(0, 8);
  switchTab(tab || 't-audio');
  $('settings').classList.remove('hidden');
}
// ============ 登录门 ============
// 进软件必须有邮箱账号。三条路径：
//   register  新用户注册
//   login     已有账号登录（换设备）
//   bind      老用户升级 —— 本机已有匿名身份和空间，只把邮箱挂上去，不动 uid/key
let lgMode = 'login';
let lgNeedBind = false;

const loggedIn = () => !!(S.accountId && S.email && S.key);

// 更新检查只看"本机是否已经有过身份"，不看是否绑了邮箱。
// 与 loggedIn() 的区别：loggedIn 是登录门的门闩（必须绑邮箱才算登录），
// 这里是"这个安装已经投入使用了吗"——匿名起步的老用户也算。
// 更新装完要重启，所以只有后台检查用它；手动检查不受限制。
const hasIdentity = () => !!(S.uid && S.key);

function renderLoginGate() {
  const isReg = lgMode === 'register';
  document.querySelectorAll('#lgTabs [data-lg]').forEach((b) => {
    b.classList.toggle('on', b.dataset.lg === lgMode);
  });
  $('lgPass2Wrap').classList.toggle('hidden', !isReg);
  $('lgAgreeWrap').classList.toggle('hidden', !isReg);
  $('lgPass').placeholder = isReg ? '至少 8 位，建议字母加数字' : '请输入密码';
  $('lgNickWrap').classList.toggle('hidden', !isReg);
  $('lgSubmit').textContent = isReg ? (lgNeedBind ? '绑定并继续' : '注册并进入') : '登录';
  $('lgPass').setAttribute('autocomplete', isReg ? 'new-password' : 'current-password');
  $('lgSub').textContent = isReg
    ? (lgNeedBind
        ? '本机已经有房间了。把邮箱绑上去，换设备也能接着用，房间不会丢。'
        : '填个邮箱，换设备也能接着用。')
    : '用一个邮箱账号，换设备也能接着用。';
  const msg = $('lgMsg');
  if (msg) msg.textContent = '';
  // 验证码模式：接线层负责露出验证码行与发码按钮、收起密码行
  if (window.FongWire && FongWire.loginGateMode) FongWire.loginGateMode(lgMode);
}

function showLoginGate() {
  // 本机已有空间但没绑邮箱 —— 这是老用户升级的场景，默认走绑定
  lgNeedBind = !S.accountId && !S.email && !!(S.spaceIds && S.spaceIds.length);
  lgMode = lgNeedBind ? 'register' : 'login';
  const em = $('lgEmail');
  if (em) em.value = S.email || '';
  const nk = $('lgNick');
  if (nk) nk.value = S.nick || '';
  $('loginGate').classList.remove('hidden');
  $('onboard').classList.add('hidden');
  renderLoginGate();
  setTimeout(() => (em || $('lgSubmit')).focus(), 60);
}

function hideLoginGate() {
  $('loginGate').classList.add('hidden');
}

// 国内用户多数用 QQ 邮箱，只输 QQ 号就自动补全，省一次输入法切换
function normEmailInput(v) {
  v = (v || '').trim();
  if (!v) return '';
  if (v.indexOf('@') >= 0) return v;
  return v + '@qq.com';
}

async function submitLoginGate() {
  const msg = $('lgMsg');
  const email = normEmailInput($('lgEmail').value);
  const pass = $('lgPass').value || '';
  const pass2 = $('lgPass2').value || '';
  const nick = ($('lgNick').value || '').trim() || '玩家';
  const isReg = lgMode === 'register';
  const isCode = lgMode === 'code';
  const codeEl = $('lgCode');
  const code = codeEl ? String(codeEl.value || '').trim() : '';

  if (!email || (!isCode && !pass)) { msg.textContent = isCode ? '邮箱要填' : '邮箱和密码都要填'; return; }
  if (isCode && !/^[0-9]{6}$/.test(code)) { msg.textContent = '验证码是 6 位数字'; return; }
  if (!isCode) {
  // 老账号可能是 6 位密码，登录仍放行；新注册要求 8 位（服务端也应同步校验）
  const minLen = isReg ? 8 : 6;
  if (pass.length < minLen) { msg.textContent = '密码至少 ' + minLen + ' 位'; return; }
  }
  if (isReg && pass !== pass2) { msg.textContent = '两次密码不一样'; return; }
  if (isReg && !$('lgAgree').checked) {
    msg.textContent = '请先阅读并勾选同意《用户协议》和《隐私政策》';
    const w = $('lgAgreeWrap'); w.classList.remove('shake'); void w.offsetWidth; w.classList.add('shake'); $('lgAgree').focus();
    return;
  }
  if (isReg && !nick) { msg.textContent = '填个昵称'; return; }

  msg.textContent = '处理中…';
  $('lgSubmit').disabled = true;
  try {
    let r;
    if (isReg && lgNeedBind) {
      // 老用户：保留本机 uid/key，只绑邮箱
      if (!registered) await register();
      r = await api('POST', '/api/auth/bind', { email, pass });
      if (r && r.ok) {
        S.email = r.email || email;
        S.accountId = S.uid;
        if (nick) S.nick = nick;
      }
    } else if (isReg) {
      r = await api('POST', '/api/auth/register', { email, pass, name: nick });
    } else if (isCode) {
      r = await api('POST', '/api/auth/code/login', { email, code });
    } else {
      r = await api('POST', '/api/auth/login', { email, pass });
    }

    if (r && r.id && r.key) {
      // 新身份：换掉本机 uid/key，空间列表重新拉
      const changed = r.id !== S.uid;
      S.uid = r.id; S.key = r.key;
      S.email = r.email || email;
      S.accountId = r.id;
      if (r.name) S.nick = r.name;
      if (changed) { S.spaceIds = []; S.curSpace = null; Spaces.clear(); }
      save();
    } else if (!S.accountId) {
      msg.textContent = '服务器返回异常，再试一次';
      $('lgSubmit').disabled = false;
      return;
    }

    hideLoginGate();
    signingOut = false;
    toast(isReg ? '欢迎加入 FONG' : '欢迎回来');
    await continueBoot();
  } catch (e) {
    const m = e && e.message ? e.message : '失败';
    msg.textContent = e && e.status === 401
      ? ((window.FongWire && FongWire.reasonText && FongWire.reasonText(e)) || '邮箱或密码不对')
      : m;
    toast(m);
  } finally {
    const b = $('lgSubmit');
    if (b) b.disabled = false;
  }
}

// ============ 账号（邮箱注册 / 登录） ============
function renderAccount() {
  const bound = loggedIn();
  const g = $('accGuest'), b = $('accBound');
  if (!g || !b) return;
  // 现在必须先登录才能进来，所以游客表单永远隐藏；这里只显示账号信息
  g.classList.add('hidden');
  b.classList.toggle('hidden', !bound);
  if (bound) {
    const av = $('accAvatar');
    if (av) {
      av.textContent = '';
      const node = avatar(S.nick || '我', 'big', avatarOf(S.uid));
      node.style.cssText = 'width:44px;height:44px;font-size:16px';
      av.appendChild(node);
    }
    $('accShownEmail').value = S.email;
    const nkEl = $('accShownNick');
    if (nkEl) nkEl.value = S.nick || '';
    loadDevices();
  }
}

// ============ 登录的设备（接口约定 04 §2） ============
function agoText(sec) {
  if (!sec || sec <= 0) return '时间未知';
  const d = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (d < 60) return '刚刚活跃';
  if (d < 3600) return Math.floor(d / 60) + ' 分钟前活跃';
  if (d < 86400) return Math.floor(d / 3600) + ' 小时前活跃';
  return Math.floor(d / 86400) + ' 天前活跃';
}
async function loadDevices() {
  const box = $('accDevices'), msg = $('accDevMsg');
  if (!box) return;
  if (msg) msg.textContent = '正在读取…';
  let r;
  try { r = await api('GET', '/api/auth/devices'); }
  catch (e) {
    box.innerHTML = '';
    if (msg) msg.textContent = e.status === 404 ? '服务器暂不支持设备管理' : (e.status === 401 ? '' : ('读取失败：' + (e.message || e)));
    return;
  }
  const list = (r && Array.isArray(r.devices)) ? r.devices : [];
  box.innerHTML = '';
  for (const d of list) {
    const row = el('div', 'acc-dev' + (d.current ? ' cur' : ''));
    row.dataset.id = d.id;
    const info = el('div', 'acc-dev-info');
    const name = el('div', 'acc-dev-name', d.name || '未知设备');
    if (d.current) name.appendChild(el('span', 'acc-dev-pill', '当前设备'));
    info.append(name, el('div', 'acc-dev-meta', [d.app, agoText(d.lastActive)].filter(Boolean).join(' · ')));
    const b = el('button', 'btn sm ' + (d.current ? 'danger-ghost' : 'ghost'), d.current ? '退出这台' : '移出');
    b.onclick = () => removeDevice(d);
    row.append(info, b);
    box.appendChild(row);
  }
  if (msg) msg.textContent = list.length ? ('共 ' + list.length + ' 台，最多 5 台；第 6 台登录时最早登录的那台会被移出。') : '没有登录中的设备';
}
async function removeDevice(d) {
  const ok = await dialog({
    title: d.current ? '退出这台设备？' : '移出这台设备？',
    text: d.current ? '这台设备会立即退出登录，需要重新登录才能继续使用。' : ('「' + (d.name || '未知设备') + '」会立即退出登录，下次使用时需要重新登录。'),
    ok: d.current ? '退出登录' : '移出', danger: true,
  });
  if (!ok) return;
  try {
    await api('POST', '/api/auth/devices/remove', { id: d.id });
  } catch (e) {
    if (e.status !== 401) toast(e.message || '移出失败');
    return;
  }
  if (d.current) { onSignedOut(null, '已退出这台设备的登录'); return; }
  toast('已移出');
  await loadDevices();
}

async function accountSubmit(kind) {
  const msg = $('accMsg');
  const email = ($('accEmail') || {}).value ? $('accEmail').value.trim() : '';
  const pass = ($('accPass') || {}).value ? $('accPass').value : '';
  const pass2 = ($('accPass2') || {}).value ? $('accPass2').value : '';
  if (!email || !pass) { if (msg) msg.textContent = '邮箱和密码都要填'; return; }
  if (pass.length < 6) { if (msg) msg.textContent = '密码至少 6 位'; return; }
  if (kind === 'register' && pass !== pass2) { if (msg) msg.textContent = '两次密码不一样'; return; }
  if (msg) msg.textContent = '处理中…';
  const btns = [$('accRegister'), $('accLogin')];
  btns.forEach((x) => x && (x.disabled = true));
  try {
    // bind 需要服务端先认得这个 uid，所以先确保匿名身份已注册
    if (!registered) {
      try { await register(); } catch (e) { if (msg) msg.textContent = e.message; return; }
    }
    let r;
    if (kind === 'register') {
      r = await api('POST', '/api/auth/bind', { email, pass });
      if (r && r.ok) {
        // bind 成功：本机 uid/key 不变，只记住邮箱
        S.email = r.email || email;
        S.accountId = S.uid;
        save(); renderAccount();
        if (msg) msg.textContent = '绑定成功，其他设备也能登了';
        toast('已绑定 ' + S.email);
        return;
      }
    } else {
      r = await api('POST', '/api/auth/login', { email, pass });
    }
    // 切换身份：换掉本机 uid/key，重新加载空间列表
    if (r && r.id && r.key) {
      S.uid = r.id; S.key = r.key; S.email = email; S.accountId = r.id;
      S.spaceIds = []; S.curSpace = null; Spaces.clear(); save();
      if (msg) msg.textContent = '登录成功，正在加载…';
      toast('已登录 ' + email);
      await boot2().catch(() => {});
      renderAll();
      renderAccount();
    } else if (msg) {
      msg.textContent = '服务器返回异常';
    }
  } catch (e) {
    if (msg) msg.textContent = e.message || '失败';
    toast(e.message || '失败');
  } finally {
    btns.forEach((x) => x && (x.disabled = false));
  }
}

// ============ 检查更新 ============
// 从 /api/releases 拿版本清单，比对本地版本。
// 不做静默自动安装 —— Windows 没有代码签名时 electron-updater 会装失败，
// 让用户自己点下载、手动装一遍更可靠。
let appVersion = '';

function cmpVer(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// 版本号是异步从主进程拿的；拿不到就不能比版本 —— 否则空串会被当成 0.0.0，
// 任何版本都被判成「有新版本」，用户一开设置就弹窗。
async function ensureVersion() {
  if (appVersion) return appVersion;
  try {
    const i = await NATIVE.info();
    if (i && i.version) appVersion = i.version;
  } catch (e) { /* ignore */ }
  return appVersion;
}

// ============ 自动更新 ============
// 静默检查发现新版本时，只在标题栏出一个角标（不弹模态框、不打断语音）。
// 角标本身就是一个按钮：点了就等于"手动检查更新"，走完整流程。
function showUpdateBadge(version, required) {
  let b = document.getElementById('updBadge');
  if (!b) {
    // 标题栏的 class 是 .titlebar（不是 .tb）；插在窗口按钮之前，靠右
    const bar = document.querySelector('.titlebar') || document.body;
    const anchor = bar.classList && bar.classList.contains('titlebar') ? bar.querySelector('.tb-ctl') : null;
    b = document.createElement('button');
    b.id = 'updBadge';
    b.type = 'button';
    b.className = 'upd-badge';
    b.addEventListener('click', () => { b.classList.add('hidden'); checkUpdate(false).catch(() => {}); });
    if (anchor) bar.insertBefore(b, anchor); else bar.appendChild(b);
  }
  b.textContent = required ? ('必须更新 v' + version) : ('有新版 v' + version);
  b.title = required
    ? '这个版本必须更新才能继续正常使用，点这里更新'
    : '发现新版本，点这里查看并更新';
  b.classList.toggle('urgent', !!required);
  b.classList.remove('hidden');
}
// 主进程不联网下载（它走 net，证书过不去），这里用渲染层的 fetch 下，
// 边下边算进度，分块交给主进程落盘，最后比对 sha256 再让主进程拉起安装器。
function updBar(percent) {
  const bar = $('updBar'), fill = $('updFill'), txt = $('updText');
  if (!bar) return;
  if (percent == null) { bar.classList.add('hidden'); return; }
  bar.classList.remove('hidden');
  if (fill) fill.style.width = Math.max(0, Math.min(100, percent)) + '%';
  if (txt) txt.textContent = '正在下载更新 ' + Math.round(percent) + '%';
}

async function downloadAndInstall(info) {
  const url = serverURL().replace(/\/$/, '') + (info.url || ('/dl/' + info.file));
  if (!NATIVE || !NATIVE.updateBegin) { window.open(url, '_blank'); return; }
  const begin = await NATIVE.updateBegin(info.file || 'FONG-update.exe');
  if (!begin || !begin.ok) { toast('更新失败：' + (begin && begin.message || '无法创建临时文件')); return; }
  try {
    const resp = await fetch(url, { cache: 'no-store' });
    if (!resp.ok || !resp.body) throw new Error('下载失败 HTTP ' + resp.status);
    const total = +(resp.headers.get('content-length') || info.size || 0);
    const reader = resp.body.getReader();
    let got = 0, lastTick = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const r = await NATIVE.updateChunk(value);
      if (!r || !r.ok) throw new Error('写入失败');
      got += value.byteLength;
      if (total) {
        const pct = got * 100 / total;
        if (pct - lastTick > 1 || pct >= 100) { lastTick = pct; updBar(pct); }
      }
    }
    const end = await NATIVE.updateEnd();
    updBar(null);
    if (!end || !end.ok) throw new Error('保存失败');
    // 主进程边写边算的 sha256，和 releases.json 里的比对（不重复下载）
    if (info.sha256 && end.sha256 && end.sha256.toLowerCase() !== String(info.sha256).toLowerCase()) {
      throw new Error('校验失败（文件不完整），请重试');
    }
    const ok = await dialog({
      title: '更新已下载',
      text: 'v' + info.version + ' 已就绪，重启后生效（语音会断开一下）。',
      ok: '立即重启',
      noCancel: !!info.required,
    });
    if (ok) await NATIVE.updateInstall({ path: end.path });
    else if (info.required) { toast('这个版本必须更新，请重启后生效'); }
    else { toast('退出 FONG 后手动运行安装包即可：' + end.path); }
  } catch (e) {
    updBar(null);
    toast('更新失败：' + (e.message || e));
  }
}

async function checkUpdate(silent) {
  const msg = $('updMsg');
  if (!silent) { const b = document.getElementById('updBadge'); if (b) b.classList.add('hidden'); }
  if (msg) msg.textContent = silent ? '' : '检查中…';
  try {
    const cur = await ensureVersion();
    if (!cur) { if (msg) msg.textContent = '拿不到本地版本号'; return; }
    const r = await api('GET', '/api/releases');
    const latest = r && r.latest;
    if (!latest) { if (msg) msg.textContent = '服务器没有发布版本信息'; return; }
    if (cmpVer(latest, cur) <= 0) {
      const b = document.getElementById('updBadge');
      if (b) b.classList.add('hidden');
      if (msg) msg.textContent = '已是最新版（v' + cur + '）';
      if (!silent) toast('已是最新版 v' + cur);
      return;
    }
    const info = (r.releases || []).find((x) => x.version === latest) || {};
    info.version = latest;

    // required（minProtocol 超版）必须更新：不给"以后再说"，但也不在语音中途弹窗——
    // 先出角标，用户回到设置页或点角标时再走强制流程。
    const required = !!info.required;

    if (silent) {
      // 静默：只亮角标，绝不弹模态框（用户在语音里，弹窗等于打断）
      showUpdateBadge(latest, required);
      if (msg) msg.textContent = '有新版 v' + latest + ' 可用';
      return;
    }

    const mb = info.size ? '\n\n安装包 ' + (info.size / 1048576).toFixed(1) + ' MB' : '';
    const ok = await dialog({
      title: '发现新版本 v' + latest,
      text: (info.notes || '') + mb + '\n\n下载完成后会提示重启。',
      ok: '立即更新',
      noCancel: required,          // required 时不给取消
    });
    if (!ok) { if (msg) msg.textContent = '有新版 v' + latest + ' 可用'; return; }
    if (msg) msg.textContent = '正在下载 v' + latest + '…';
    await downloadAndInstall(info);
  } catch (e) {
    if (msg) msg.textContent = silent ? '' : ('检查失败：' + (e.message || ''));
  }
}

// 启动 10 秒后静默检查一次；之后每 6 小时一次
// 后台检查的守卫用 hasIdentity（见上）。另外两个细节：
//   1) 只在登录门没挡着的时候检查 —— 用户停在登录页时弹"发现新版本"很怪；
//   2) document.visibilityState 为 hidden 时跳过，等回到前台再查，避免占用用户带宽。
function autoCheckUpdate() {
  if (!hasIdentity()) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  const gate = document.getElementById('loginGate');
  if (gate && !gate.classList.contains('hidden')) return;
  checkUpdate(true).catch(() => {});
}

setTimeout(autoCheckUpdate, 10000);
setInterval(autoCheckUpdate, 6 * 3600 * 1000);
// 从后台回来时补查一次（最多每 30 分钟一次，避免切窗口就查）
let lastAutoCheck = 0;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    const now = Date.now();
    if (now - lastAutoCheck < 30 * 60 * 1000) return;
    lastAutoCheck = now;
    autoCheckUpdate();
  });
}

function renderDnModes() {
  const cur = (S.denoiseMode == null) ? 3 : (S.denoiseMode | 0);
  document.querySelectorAll('#dnModes [data-dn]').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.dn) === cur);
  });
  const hint = $('dnHint');
  if (hint) {
    const rt = {
      0: '完全不处理。音质最原始，但噪声全留。',
      3: '推荐。只压静音段的噪声，语音波形一个样本都不改。保真 48 dB、算法延迟 0 ms、几乎不吃 CPU。',
      1: 'RNNoise · CPU 约 0.4% · 降噪约 9 dB。比自然档降噪多，但音色会略变。',
      2: 'GTCRN 48k · CPU 约 15% · 降噪力度三档里最大，但会改写语音频谱（听感偏闷、不自然）。只在很吵的环境用。',
    };
    hint.textContent = rt[cur] || '';
    // 高频处理只作用于 GTCRN（质量档）。自然/低占用/关闭都不经过它，
    // 显示出来只会让人误以为有效。
    renderNs();
    const hf = document.getElementById('hfField');
    if (hf) hf.style.display = (cur === 2) ? '' : 'none';
  }
}
// 降噪档位 > 0 时 Mic.start() 会强制关掉浏览器降噪（audioConstraints 里 noiseSuppression=false），
// 复选框得照实显示，不能一直勾着。只改显示，不动 S.ns。
function renderNs() {
  const dn = (S.denoiseMode == null) ? 3 : (S.denoiseMode | 0);
  const ns = $('ns'); if (!ns) return;
  if (dn > 0) { ns.checked = false; ns.disabled = true; $('nsNote').textContent = '已由上方「降噪强度」接管'; }
  else { ns.disabled = false; ns.checked = !!S.ns; $('nsNote').textContent = ''; }
  $('nsWrap').classList.toggle('dis', dn > 0);
}
function renderDuck() {
  $('duckDb').disabled = !S.duck;
  $('duckField').classList.toggle('dis', !S.duck);
  $('duckHint').textContent = !S.duck ? '已关闭：别人说话音量保持不变。'
    : (S.duckDb >= 0 ? '当前 0 dB = 不压低，开了等于没开。建议 -10 ~ -15 dB。' : '你说话时，别人的声音压低 ' + (-S.duckDb) + ' dB。');
}
function renderHfModes() {
  const cur = (S.hfTilt == null) ? 3 : Number(S.hfTilt);
  document.querySelectorAll('#hfModes [data-hf]').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.hf) === cur);
  });
  const hint = $('hfHint');
  if (hint) {
    const t = {
      0: '不处理高频。声音最亮，但高频毛刺明显，长时间听容易累。',
      2: '轻度处理，听感偏亮，保留更多高频细节。',
      3: '推荐。高频毛刺基本消失，人声清晰度不受影响。',
      6: '更强的衰减，最安静但人声会偏闷。',
    };
    hint.textContent = t[cur] || '';
  }
}
document.querySelectorAll('#hfModes [data-hf]').forEach((b) => (b.onclick = async () => {
  S.hfTilt = Number(b.dataset.hf); save(); renderHfModes();
  if (window.Denoise && Denoise.setHfTilt) Denoise.setHfTilt(S.hfTilt);
  toast(S.hfTilt === 0 ? '高频已放开' : '高频处理已调整为 ' + S.hfTilt + ' dB/oct');
}));

document.querySelectorAll('#dnModes [data-dn]').forEach((b) => (b.onclick = async () => {
  // 【0.4.59 · 独立审查】档位切换不再走 changeMic 全量重建。
  // C_CMD_MODE（SAB 7 号槽）本来就是运行时切换通道：
  //   Atomics.store(ctrl,7,v) → worker applyCommands() 每块读 → den.setMode(v)
  // 实测纯 setMode 路径 underruns 增量 0、无 bypass、sent 正常累加。
  // 而 changeMic 那条路要拆链/清环/重握手，实测 ur 飙到 5888~17632、环指针清零断音。
  const prev = (S.denoiseMode == null) ? 2 : (S.denoiseMode | 0);
  const next = Number(b.dataset.dn);
  S.denoiseMode = next; save(); renderDnModes();
  if (next === 0 || prev === 0) {
    // 【0.4.71 · 切档卡顿的核心修复】
    // 原来是 `if (next === 0 || prev === 0) await changeMic(S.mic)` —— 只要经过 0 就全量重建。
    // 而 prev===0（从"关闭"切到任意模型）是【用户最常见的操作】，
    // 一走重建就是 ur 5888~17632、环指针清零、声音卡住，必须退应用重进才恢复。
    //
    // 现在区分两个方向：
    //   · 非0 → 0（关闭）：确实要拆链，走 changeMic 没问题 —— 但它是"关掉"，用户预期声音变化
    //   · 0 → 非0（开启）：链一直在（worklet/worker 都在跑，只是 bypass 着），
    //                      用 SAB 命令平滑接管即可，不需要拆链
    if (next === 0) {
      await changeMic(S.mic);            // 关闭：允许重建
    } else {
      // 【0.4.73 · 独立审查修正】必须用「能力检查」判断链路在不在，不能靠 catch 兜。
      //
      // 错法（上一版）：直接调 setDenBypass/setEnabled/setMode/reset，指望出错时 catch 回落重建。
      // 实际这些方法在 ctrl/node 为 null 时【静默返回、不抛异常】：
      //   setDenBypass → `if (this.ctrl)` 为 null，什么都不做
      //   setEnabled   → `else this.pendingMode = this.pendingMode`（自赋值，死代码）
      //   setMode      → ctrl null → 只存 pendingMode，没人消费
      //   reset        → 两处都判 ctrl/node，全 null
      // → 全程不抛异常 → catch 永远够不到 → UI 显示"已切换到质量"，链路根本没建，
      //   而且再也建不起来（唯一建链路径是 Mic.start(force)）。
      //   症状和"必须退应用重进"一模一样，只是从"卡顿"变成"完全不生效"。
      //
      // 为什么 mode===0 时链真的不在：Mic.start 里 `if ((wantDenoise || S.aec) && Denoise)`
      // 才建链，而 wantDenoise = (S.denoiseMode !== 0)、S.aec 默认 false
      // → 0 档时这一整块被跳过，Denoise.init() 从没跑过。
      const chainLive = !!(window.Denoise && Denoise.ready && Denoise.ctrl && Denoise.node && Mic.denoiseOn);
      if (!chainLive) {
        // 链路不在 → 必须重建（这是唯一能建链的路径）
        console.log('[audio-diag] 降噪链不在位（ready=' +
          !!(window.Denoise && Denoise.ready) + ' ctrl=' + !!(window.Denoise && Denoise.ctrl) +
          ' node=' + !!(window.Denoise && Denoise.node) + ' on=' + Mic.denoiseOn + '），重建');
        await changeMic(S.mic);
      } else {
        // 链路在位 → 走 SAB 平滑切换，不重建
        if (Denoise.setDenBypass) Denoise.setDenBypass(false);
        if (Denoise.setEnabled) Denoise.setEnabled(true);
        if (Denoise.setMode) Denoise.setMode(next);
        if (Denoise.reset) Denoise.reset();
        try { if (window.Loop && Loop.resync) Loop.resync(); } catch (_) {}
        console.log('[audio-diag] 降噪 ' + prev + ' → ' + next + '（链在位，走 SAB）');
      }
    }
  } else {
    if (window.Denoise && Denoise.setDenBypass) Denoise.setDenBypass(false);
    if (window.Denoise && Denoise.setMode) Denoise.setMode(next);
    if (window.Denoise && Denoise.reset) Denoise.reset();
    try { if (window.Loop && Loop.resync) Loop.resync(); } catch (_) {}
  }
  const nm = { 0: '降噪已关闭', 3: '已切换到自然（保真最高）', 1: '已切换到低占用', 2: '已切换到质量模式' };
  toast(nm[S.denoiseMode] || '已切换');
}));

function renderOpusTiers() {
  const cur = opusKbps();
  document.querySelectorAll('#opusTiers [data-kbps]').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.kbps) === cur);
  });
  const hint = $('opusHint');
  if (hint) {
    const better = cur >= 256 ? '，这是单声道 Opus 的编码上限'
      : (cur >= 192 ? '，人声已经无可测损失' : (cur >= 128 ? '，比 96 再多一点余量' : '，最省带宽'));
    hint.textContent = '当前 ' + cur + ' kbps' + better + '。'
      + (cur >= 192 ? '带宽占用较高，人多或网络差时降一档。' : '');
  }
  const sp = $('specKbps');
  if (sp) sp.textContent = String(cur);
}
document.querySelectorAll('#opusTiers [data-kbps]').forEach((b) => (b.onclick = async () => {
  const k = Number(b.dataset.kbps);
  S.opusKbps = k; save(); renderOpusTiers();
  // 改码率要重新协商，否则 sender 还是旧参数
  if (Room.wantRoom) await Room.join(Room.wantRoom.sid, Room.wantRoom.rid);
  toast('音质已切到 ' + k + ' kbps');
}));

function switchTab(id) {
  // 【0.4.47】补 aria：role="tab" 却没有 aria-selected / aria-controls，
  // 读屏与键盘用户拿不到"当前在哪个 tab"。独立 UI 审查列为一致性问题。
  document.querySelectorAll('[data-tab]').forEach((t) => {
    const on = t.dataset.tab === id;
    t.classList.toggle('on', on);
    t.setAttribute('aria-selected', on ? 'true' : 'false');
    t.setAttribute('tabindex', on ? '0' : '-1');
    if (t.dataset.tab) t.setAttribute('aria-controls', t.dataset.tab);
  });
  document.querySelectorAll('.tabpane').forEach((p) => p.classList.toggle('hidden', p.id !== id));
}
document.querySelectorAll('[data-tab]').forEach((t) => (t.onclick = () => switchTab(t.dataset.tab)));
// 【0.4.70】初始也要补一次 aria。
// 原来只在 switchTab 里补，而 switchTab 只在【点击时】触发 ——
// 用户打开设置页、还没点任何 tab 的这段时间里，读屏软件读不到"当前在哪个 tab"。
// 实测：静态检查 0/6 有 aria-selected。（独立 UI 复评抓到）
switchTab('t-audio');
document.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => { b.closest('.modal').classList.add('hidden');  }));
function syncVals() { $('thrVal').textContent = S.thr + ' dB'; $('duckVal').textContent = S.duckDb + ' dB'; }
function renderMode() {
  document.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('on', b.dataset.mode === S.mode));
  $('vadBox').classList.toggle('hidden', S.mode === 'ptt'); $('pttBox').classList.toggle('hidden', S.mode !== 'ptt');
  $('pttLabel2').textContent = S.keys.ptt ? keyText(S.keys.ptt.label) : '（未设置）';
}
document.querySelectorAll('[data-mode]').forEach((b) => (b.onclick = () => { S.mode = b.dataset.mode; save(); renderMode(); renderBar(); if (window.FongVad && FongVad.ready) FongVad.setBypass(S.mode === 'ptt'); if (S.mode === 'ptt' && !S.keys.ptt) { switchTab('t-keys'); toast('先设一个按键说话的键'); } }));
$('nick').onchange = async (e) => {
  const n = e.target.value.trim().slice(0, 16);
  if (!n) { e.target.value = S.nick; return; }
  S.nick = n; save();
  try { await register(); toast('昵称已更新'); if (cur()) loadSpace(S.curSpace).then(renderAll).catch(() => {}); } catch (err) { toast(err.message); }
};
$('ice').onchange = (e) => { S.ice = e.target.value; save(); toast('下次进房生效'); };
$('thr').oninput = (e) => { S.thr = +e.target.value; save(); syncVals(); if (window.FongVad && FongVad.ready) FongVad.cfg({ thrDb: S.thr }); };
$('duckDb').oninput = (e) => { S.duckDb = +e.target.value; save(); syncVals(); renderDuck(); };
$('duck').onchange = (e) => { S.duck = e.target.checked; save(); renderDuck(); };
$('sounds').onchange = (e) => { S.sounds = e.target.checked; save(); };
$('autostart').onchange = (e) => { S.autostart = e.target.checked; save(); NATIVE && NATIVE.setAutostart(S.autostart); };
for (const k of ['ns', 'agc', 'aec']) $(k).onchange = async (e) => { S[k] = e.target.checked; save(); await changeMic(S.mic); };

// 【0.4.39】AEC 实时诊断：把 worker 报上来的 ERLE / 处理帧数 / CPU 直接显示在设置里，
// 这样"外放时回声到底消掉没有"不用猜、不用让我远程读数。
(function aecStatLoop() {
  const tick = () => {
    const el = $('aecStat'), tip = $('aecTip');
    if (!el) return;
    const d = window.__aecDiag;
    if (!S.aec) {
      el.textContent = '回声消除未开启';
      if (tip) tip.textContent = '外放（不戴耳机）时打开，能消掉对方从你音箱里听到的自己。';
      return;
    }
    if (!d) {
      el.textContent = '回声消除已开启 · 等待通话数据…';
      if (tip) tip.textContent = '进一个语音频道后这里会出现实时数据。';
      return;
    }
    const farRate = Number(d.farRate == null ? -1 : d.farRate);   // 块/秒，正常 100
    const farPeakHold = Number(d.farPeakHold == null ? d.farPeak : d.farPeakHold);
    const far = d.farBound && farRate >= 50;
    const erle = Number(d.erle || 0);
    const fp = Number(d.farPeak || 0), fhz = Number(d.farHz || 0);
    el.textContent = 'ERLE ' + erle.toFixed(1) + ' dB · 参考帧 ' + (d.far || 0)
      + ' · 参考波形 峰值 ' + fp.toFixed(3) + ' / 约 ' + fhz + ' Hz'
      + ' · 参考速率 ' + (farRate < 0 ? '?' : farRate) + ' 块/秒 · 2 秒峰值 ' + farPeakHold.toFixed(3)
      + ' · 参考轨 ' + (AecRef.trackCount ? AecRef.trackCount() : '?')
      + ' · 处理 ' + (d.frames || 0) + ' 帧 · CPU ' + ((Number(d.rtf) || 0) * 100).toFixed(1) + '%';
    if (!tip) return;
    if (!d.ok) { tip.textContent = '初始化失败：' + (d.err || '未知'); return; }
    if (!d.farBound) { tip.textContent = '参考环没绑定到 worker（far SAB 没随 init 下发）。'; return; }
    if (farRate < 50) {
      tip.textContent = '⚠ 参考环写指针停滞（' + (farRate < 0 ? '?' : farRate) + ' 块/秒，正常 100）—— far 参考链断了'
        + '（worklet 没挂上 / 被 Mic 重建打断 / worker 绑到了旧环），AEC 全程没有参考可对。'
        + ' 注意此时下面那个峰值是**上一帧的陈旧值**，不代表此刻的远端音频。';
      return;
    }
    if (farPeakHold < 0.005) {
      tip.textContent = '⚠ 参考有帧但 2 秒内全零（峰值 ' + farPeakHold.toFixed(3) + '）—— 远端没在发流，'
        + '或播放链没在拉这条接收轨，AEC 等于拿静音做参考。';
      return;
    }
    if (erle < 1) {
      tip.textContent = '参考有信号（峰值 ' + fp.toFixed(3) + '，约 ' + fhz + ' Hz），但麦克风里几乎消不出东西。'
        + '最常见的原因是【你戴着耳机】——那样扬声器的声音根本没进麦克风，也就没有回声可消，这是正常结果不是故障。'
        + '要真的验证：切成扬声器外放、音量开大、麦克风离音箱近一点，再回来看这个数。';
      return;
    }
    else if (erle < 10) tip.textContent = '有轻微抑制。想要更明显的效果：把扬声器音量开大、麦克风离音箱近一点。';
    else tip.textContent = '回声抑制正常（>10 dB 已明显；达标线 20 dB）。';
  };
  setInterval(tick, 1000);
  tick();
})();

document.querySelectorAll('#lgTabs [data-lg]').forEach((b) => (b.onclick = () => {
  lgMode = b.dataset.lg; renderLoginGate();
  setTimeout(() => {
    if (!$('lgEmail').value) { $('lgEmail').focus(); return; }
    const inCode = !!(window.FongWire && FongWire.loginGateIsCode && FongWire.loginGateIsCode());
    const t = inCode ? $('lgCode') : $('lgPass');
    if (t) t.focus();
  }, 30);
}));
$('lgSubmit').onclick = () => submitLoginGate();
// 失焦时把补全结果写回去，别让用户以为填错了
$('lgEmail').addEventListener('blur', () => {
  const v = $('lgEmail').value;
  if (v && v.indexOf('@') < 0) $('lgEmail').value = v + '@qq.com';
});
['lgEmail', 'lgPass', 'lgPass2', 'lgNick'].forEach((id) => {
  const elx = $(id); if (!elx) return;
  elx.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitLoginGate(); } });
});

$('accSaveNick').onclick = async () => {
  const n = ($('accShownNick').value || '').trim();
  if (!n) { toast('昵称不能空'); return; }
  S.nick = n; save();
  try { await api('POST', '/api/register', { id: S.uid, key: S.key, name: n }); toast('昵称已更新'); }
  catch (e) { toast('已保存在本机，服务器同步失败'); }
  renderAll();
};
$('chkUpdate').onclick = () => checkUpdate(false);
// 开源许可（需法务按实际打包版本核对，完整许可文本应随安装包附带）
const OSS = [
  ['Electron', 'MIT', 'https://github.com/electron/electron'],
  ['Chromium', 'BSD-3-Clause 等，详见安装目录 LICENSES.chromium.html', 'https://www.chromium.org/'],
  ['Node.js', 'MIT', 'https://github.com/nodejs/node'],
  ['Opus（经 Chromium WebRTC）', 'BSD-3-Clause', 'https://opus-codec.org/'],
  ['RNNoise', 'BSD-3-Clause', 'https://github.com/xiph/rnnoise'],
  ['ONNX Runtime', 'MIT', 'https://github.com/microsoft/onnxruntime'],
  ['GTCRN', 'MIT', 'https://github.com/Xiaobin-Rong/gtcrn'],
  ['uiohook-napi', 'MIT', 'https://github.com/SnosMe/uiohook-napi'],
  ['libuiohook', 'LGPL-3.0', 'https://github.com/kwhat/libuiohook'],
  ['node-gyp-build', 'MIT', 'https://github.com/prebuild/node-gyp-build'],
  ['Lucide 图标', 'ISC', 'https://lucide.dev/'],
];
$('ossBtn').onclick = () => {
  const box = el('div', 'oss');
  for (const [n, l, u] of OSS) {
    const r = el('div', 'oss-row');
    const a = el('a', 'link', n); a.href = u; a.target = '_blank'; a.rel = 'noopener';
    r.append(a, el('span', 'oss-lic', l));
    box.appendChild(r);
  }
  box.appendChild(el('p', 'hint', 'FONG 使用了以上开源软件，感谢各项目作者。各组件的版权声明与许可全文随安装包提供。'));
  dialog({ title: '开源许可', extra: box, ok: '关闭', noCancel: true });
};
$('accRegister').onclick = () => accountSubmit('register');
$('accLogin').onclick = () => accountSubmit('login');
$('accLogout').onclick = () => {
  // 【auth 联调】顺手让服务端作废这台设备的 key（老服务端没有这个接口时忽略）
  if (S.key && S.device) api('POST', '/api/auth/devices/remove', { id: S.device }).catch(() => {});
  S.email = ''; S.accountId = '';
  S.uid = rhex(16); S.key = rhex(32);
  S.spaceIds = []; S.curSpace = null; Spaces.clear(); save();
  renderAll(); renderAccount();
  $('settings').classList.add('hidden');
  showLoginGate();
  toast('已退出登录');
};
{ const adr = $('accDevRefresh'); if (adr) adr.onclick = () => loadDevices();
  const avb2 = $('accAvatarBtn'); if (avb2) avb2.onclick = () => openAvatarDialog(); }
$('loopBtn').onclick = () => Loop.toggle();
$('settingsBtn').onclick = () => openSettings();

// ---- 快捷键 ----
function renderKeys() {
  document.querySelectorAll('[data-bind]').forEach((b) => { const k = S.keys[b.dataset.bind]; b.textContent = k ? keyText(k.label) : '未设置'; b.classList.toggle('unset', !k); b.classList.remove('rec'); });
}
// 【0.4.71】窗口内录键。
// 主进程在 capture 期间会停掉全局钩子（那是跟输入法冲突、导致 MSCTF.dll 崩溃的东西），
// 所以按键改由这里用 keydown 采集 —— 录键时应用一定在前台，不需要全局钩子。
// 【0.4.71】DOM code → uiohook keycode 映射，启动时从主进程取一次。
// 两套编码完全不同（DOM M=77 / uiohook M=50），不转换的话存进去的 code
// 永远对不上钩子上报的 code —— 热键静默失效（能录入、但按了没反应）。
let KEYMAP = null;
async function ensureKeymap() {
  if (KEYMAP) return KEYMAP;
  try { KEYMAP = (NATIVE && NATIVE.keymap) ? await NATIVE.keymap() : {}; } catch (_) { KEYMAP = {}; }
  return KEYMAP;
}

function captureKeyViaWindow() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return; done = true;
      window.removeEventListener('keydown', onKey, true);
      window.removeEventListener('mousedown', onMouse, true);
      clearTimeout(timer);
      resolve(v);
    };
    // 鼠标侧键（button 3 / 4）也支持，与主进程的 mouse(e) 口径一致
    const onMouse = (e) => {
      if (e.button > 2) { e.preventDefault(); e.stopPropagation(); finish({ code: 'm' + e.button, label: '鼠标侧键' + (e.button - 2) }); }
    };
    const KEYNAMES = { Backquote: '反引号', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Space: '空格', Enter: '回车', Tab: 'Tab', Escape: 'Esc', Backspace: '退格', Delete: 'Delete', Insert: 'Insert', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→' };
    const onKey = (e) => {
      // 只按下、不重复；Esc 取消
      if (e.repeat) return;
      if (e.code === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); return; }
      e.preventDefault(); e.stopPropagation();
      const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean);
      // 只按修饰键不结束（等真正的键）
      if (/^(Control|Alt|Shift|Meta)(Left|Right)?$/.test(e.code)) return;
      let base = KEYNAMES[e.code];
      if (!base) {
        if (/^Key[A-Z]$/.test(e.code)) base = e.code.slice(3);
        else if (/^Digit[0-9]$/.test(e.code)) base = e.code.slice(5);
        else if (/^F[0-9]{1,2}$/.test(e.code)) base = e.code;
        else base = e.code;
      }
      // code 用 k + uiohook keycode 形式，与主进程 combo() 的 'k'+keycode 口径一致
      const uio = KEYMAP && KEYMAP[e.code];
      if (uio === undefined) {
        // 没有映射的键（罕见）：报错而不是存一个永远匹配不上的 code
        finish({ error: '这个键暂不支持，换一个试试' });
        return;
      }
      finish({ code: (mods.length ? mods.join('+') + '+' : '') + 'k' + uio, label: mods.concat(base).join(' + ') });
    };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onMouse, true);
    const timer = setTimeout(() => finish(null), 8000);
  });
}

document.querySelectorAll('[data-bind]').forEach((b) => (b.onclick = async () => {
  if (!NATIVE) { toast('只有桌面客户端支持全局快捷键'); return; }
  b.textContent = '请按键…'; b.classList.add('rec');
  // 【0.4.71】先让主进程停钩子，然后在窗口内采集。
  // 原来直接 await NATIVE.captureKey() —— 钩子全程常驻，录键时撞输入法崩溃。
  await ensureKeymap();                       // 确保映射就绪（否则按了也匹配不上）
  try { await NATIVE.captureKey(); } catch (_) { /* 主进程停钩子失败不影响下面 */ }
  const res = await captureKeyViaWindow();
  if (res && res.error) { toast(res.error); renderKeys(); return; }
  if (res && res.code) {
    const action = b.dataset.bind;
    for (const [a, k] of Object.entries(S.keys)) if (a !== action && k && k.code === res.code) S.keys[a] = null; // 冲突的旧绑定清掉
    S.keys[action] = { code: res.code, label: res.label, accel: null };
    save(); applyKeys(); toast(`已设为 ${res.label}`);
  }
  renderKeys(); renderMode(); renderBar();
}));
document.querySelectorAll('[data-clear]').forEach((b) => (b.onclick = () => { S.keys[b.dataset.clear] = null; save(); applyKeys(); renderKeys(); renderMode(); renderBar(); }));
async function applyKeys() {
  if (!NATIVE) return;
  const r = await NATIVE.setHotkeys(S.keys);
  if (r && !r.native) $('keysNote').textContent = '当前系统拿不到全局键盘钩子：静音/闭听快捷键仍全局可用，按键说话只在窗口激活时生效。';
}
if (NATIVE) {
  NATIVE.onHotkey((a) => { if (a === 'mute') setMuted(!Mic.muted); if (a === 'deafen') setDeafened(!Mic.deafened); if (a === 'hangup' && Room.wantRoom) Room.leave(); });
  NATIVE.onPTT((down) => { Mic.ptt = down; if (S.mode === 'ptt') renderBar(); });
  NATIVE.onDeepLink((url) => { joinByInput(url).catch(() => {}); });
  // 【0.4.15】正在玩：主进程 5 秒报一次前台程序名，变了就随 presence 推给房间
  // 【0.4.16】按 KOOK 逆向证据区分 game/application（KOOK 源码：case "game" → 正在玩游戏，"application" → 正在使用），
  // 否则浏览器会被显示成「正在玩 浏览器」
  NATIVE.onPlaying((n) => {
    const map = { cs2: 'CS2', csgo: 'CS:GO', chrome: '浏览器', msedge: '浏览器', firefox: '浏览器', code: 'VS Code', explorer: '资源管理器', spotify: 'Spotify', cloudmusic: '网易云音乐', qq: 'QQ', wechat: '微信', discord: 'Discord' };
    const games = new Set(['cs2', 'csgo', 'cs2.exe', 'javaw', 'valorant', 'valorant-win64', 'dota2', 'apex', 'apex_legends', 'overwatch', 'gta5', 'gta5_enhanced', 'pubg', 'rust', 'minecraft', 'wutheringwaves', 'yuanshen', 'genshin', 'deltaforce', 'cf', 'crossfire', 'dnf', 'wow', 'wowclassic', 'territoryofstrategyok', 'thespikes', 'marvelrivals']);
    const nice = map[n] || (n ? n.charAt(0).toUpperCase() + n.slice(1) : '');
    const display = nice ? (games.has(n) ? '正在玩 ' : '正在使用 ') + nice : '';
    if ((S.playing || '') !== display) { S.playing = display; if (Room.joined) Room.pushPresence(); renderPresence(); }
  });
}
// 窗口内的按键说话（钩子不可用时的兜底）
window.addEventListener('keydown', (e) => { if (S.keys.ptt && e.code === 'Backquote' && S.keys.ptt.code === 'k41' && !e.repeat && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { Mic.ptt = true; renderBar(); } });
window.addEventListener('keyup', (e) => { if (e.code === 'Backquote' && S.keys.ptt && S.keys.ptt.code === 'k41') { Mic.ptt = false; renderBar(); } });
window.addEventListener('online', () => { if (Room.wantRoom && !Room.joined) { clearTimeout(Room.retryTimer); Room.join(Room.wantRoom.sid, Room.wantRoom.rid, true); } });

// ============ 首次引导（3 屏，可跳过） ============
let obStep = 1;
function obShow(n) {
  obStep = n;
  document.querySelectorAll('.ob').forEach((o) => o.classList.toggle('hidden', +o.dataset.step !== n));
  document.querySelectorAll('.steps i').forEach((d, i) => d.classList.toggle('on', i < n));
  $('obNext').textContent = n === 3 ? '开始使用' : '下一步';
  if (n === 3) {
    const dn = (S.denoiseMode == null) ? 3 : (S.denoiseMode | 0);
    $('obSummary').textContent = '48 kHz · Opus ' + opusKbps() + ' kbps · 降噪「' + ({ 0: '关闭', 3: '自然', 1: '低占用', 2: '质量' }[dn] || '自然') + '」';
  }
}
async function obDone() {
  const nick = $('obNick').value.trim().slice(0, 16); if (nick) S.nick = nick;
  if (!S.nick) S.nick = '玩家' + S.uid.slice(0, 4);
  S.onboarded = true; save(); $('onboard').classList.add('hidden');
  await boot2();
}
$('obNext').onclick = () => (obStep < 3 ? obShow(obStep + 1) : obDone());
$('obSkip').onclick = obDone;
// 麦克风耳返：让用户当场听到自己说话的效果。
// 走 Audio → setSinkId，跟扬声器测试同一条路，保证听到的是所选设备的实际效果。
let obLoop = null;
async function obLoopStop() {
  if (!obLoop) return;
  try { obLoop.st.getTracks().forEach((t) => t.stop()); } catch (_) { /* ignore */ }
  try { await obLoop.ctx.close(); } catch (_) { /* ignore */ }
  obLoop = null;
  const b = $('obLoop');
  if (b) { b.textContent = '听听自己的声音'; b.classList.remove('danger-ghost'); b.classList.add('ghost'); }
}
$('obLoop').onclick = async () => {
  if (obLoop) { await obLoopStop(); return; }
  const btn = $('obLoop');
  try {
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false };
    if (S.mic && S.mic !== 'default') audio.deviceId = { exact: S.mic };
    const st = await navigator.mediaDevices.getUserMedia({ audio });
    const ctx = ctxShared();
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(st).connect(dest);
    const a = new Audio();
    a.srcObject = dest.stream;
    if (S.spk && S.spk !== 'default' && a.setSinkId) await a.setSinkId(S.spk).catch(() => {});
    await a.play();
    obLoop = { ctx, st, a };
    btn.textContent = '停止';
  } catch (e) {
    await obLoopStop();
    toast('打不开麦克风：' + (e.message || e));
  }
};
// 离开这一步或走完向导都要收掉，否则麦克风一直占着
$('obNext').addEventListener('click', () => { if (obStep >= 2) obLoopStop(); });
$('obSkip').addEventListener('click', () => { obLoopStop(); });

$('obTone').onclick = async () => {
  const ctx = ctxShared();
  const dest = ctx.createMediaStreamDestination(); const o = ctx.createOscillator(); const g = ctx.createGain();
  o.frequency.value = 660; g.gain.setValueAtTime(0, ctx.currentTime);
  g.gain.linearRampToValueAtTime(0.2, ctx.currentTime + 0.03); g.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.6);
  o.connect(g).connect(dest); o.start(); o.stop(ctx.currentTime + 0.65);
  const a = new Audio(); a.srcObject = dest.stream;
  if (S.spk && S.spk !== 'default' && a.setSinkId) await a.setSinkId(S.spk).catch(() => {});
  a.play(); setTimeout(() => ctx.close(), 900);
};

// ============ 启动 ============
async function boot2() {
  if (!serverURL()) { banner('还没填服务器地址', '去设置', () => openSettings('t-general'), true); renderAll(); return; }
  try {
    await register(); hideBanner();
    await Promise.all(S.spaceIds.map((sid) => loadSpace(sid).catch(() => {})));
    if (!S.curSpace || !S.spaceIds.includes(S.curSpace)) S.curSpace = S.spaceIds[0] || null;
    save(); renderAll(); startPoll();
    if (pendingInvite) { const sid = pendingInvite; pendingInvite = null; joinSpace(sid); }
  } catch (e) {
    // 【auth 联调】带 reason 的 401 已由 api() → onSignedOut() 回了登录门并给了文案，这里不再重复处理
    if (e.status === 401 && e.reason) { renderAll(); return; }
    if (e.status === 401) {
      // 401 有两种情况，处理方式完全不同：
      //   A. 本地 uid 在服务端不存在（换过库/清过数据）→ 用同一个 uid+key 重新登记就能恢复
      //   B. 本地 uid 存在但 key 不对（改过密码、换设备）→ 撞多少次都没用，只能重新登录
      //
      // 先试 A。A 失败说明是 B —— 直接回登录门，别让用户对着"身份校验失败"干瞪眼。
      if (await recoverIdentity()) {
        try {
          await Promise.all(S.spaceIds.map((sid) => loadSpace(sid).catch(() => {})));
          if (!S.curSpace || !S.spaceIds.includes(S.curSpace)) S.curSpace = S.spaceIds[0] || null;
          save(); renderAll(); startPoll(); hideBanner();
          return;
        } catch (_) { /* 落到下面 */ }
      }
      // 走到这里 = 身份对不上，回登录门让用户重新登录。
      // 不弹 banner：这个场景用户只需要"重新登录"，不需要知道什么叫身份校验。
      if (loggedIn()) {
        showLoginGate();
        const lg = $('lgEmail');
        if (lg) { lg.value = S.email || ''; setTimeout(() => lg.focus(), 80); }
        toast(S.email ? '登录已过期，请重新登录' : '请用邮箱登录');
      } else {
        showLoginGate();
      }
      renderAll();
      return;
    }
    banner('连不上服务器，请检查网络后重试', '重试', boot2);
    renderAll();
  }
}
let pendingInvite = null;
// 登录成功后的后半段启动流程
async function continueBoot() {
  // 头像正文在 IndexedDB 里（localStorage 只留占位）。
  // 启动时先把旧数据迁出来，再把缓存灌好 —— 必须早于 renderAll 的头像渲染，
  // 但这两个函数本身不阻塞启动（失败就退回首字母头像）。
  try { await migrateAvatarOutOfLocalStorage(); } catch (_) {}
  try { await loadAvatarCache(S.uid); } catch (_) {}
  // 登录门拿到的 uid/key 还没在服务端登记过。registered 是长轮询的开关 ——
  // 不在这里登记的话，startPoll() 会一直直接 return，成员列表和频道变化永远不刷新。
  try { await register(); } catch (e) { /* 失败留给 boot2 重试 */ }
  try { await Mic.start(); } catch (e) { micError(e); }
  await listDevices().catch(() => {});
  if (!S.onboarded) {
    $('obNick').value = S.nick || '';
    $('onboard').classList.remove('hidden');
    obShow(1);
  } else {
    boot2();
  }
}

(async function boot() {
  renderAll();
  if (NATIVE) { NATIVE.info().then((i) => { appVersion = i.version; $('ver').textContent = i.version; }); applyKeys(); NATIVE.setAutostart(S.autostart); }
  // 没登录就卡在登录门：不启麦克风、不拉空间
  if (!loggedIn()) { showLoginGate(); return; }
  await continueBoot();
})();
// ============ 自绘标题栏按钮 ============
(function wireWindowControls() {
  const min = document.getElementById('winMin');
  const max = document.getElementById('winMax');
  const cls = document.getElementById('winClose');
  if (!min || !max || !cls) return;
  if (!NATIVE || !NATIVE.winMin) { document.querySelector('.tb-ctl').style.display = 'none'; return; }
  min.onclick = () => NATIVE.winMin();
  max.onclick = () => NATIVE.winMax();
  cls.onclick = () => NATIVE.winClose();
  const setMaxIcon = (isMax) => {
    const use = max.querySelector('use');
    if (use) use.setAttribute('href', isMax ? '#i-restore' : '#i-max');
    max.title = isMax ? '还原' : '最大化';
    max.setAttribute('aria-label', max.title);
  };
  if (NATIVE.onWinState) NATIVE.onWinState(setMaxIcon);
})();

// ==== FONG 基础功能接线：音量与调音台、说话态（未加载 fong-wire.js 时全部退回原行为） ====
if (window.FongWire) {
  try {
    FongWire.init({ S, save, Room, Mic, spk: S.spk, api });
    console.log('[fong-wire] 已接管：音量 mode=' + FongWire.mode + ' 每人上限=' + FongWire.ceiling() + '%'
      + '；说话态=' + (FongWire.talkReady ? 'on' : 'off'));
  } catch (e) { console.warn('[fong-wire] 初始化失败，退回原有逻辑', e); }
}

window.FONG = { Room, Mic, Spaces, tuneOpus, api, joinSpace, get state() { return S; } };
