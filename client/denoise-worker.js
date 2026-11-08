/**
 * FONG 降噪 Worker
 *
 * ── 为什么必须是 Worker ──
 * 旧方案把处理放在 renderer 主线程，靠 worklet 的 postMessage('newblock') 通知。
 * 实测（droptest.js，三档负载）：
 *     空载  calls=4400  sent=880  dropped=293   underruns=141152
 *     轻载  calls=9000  sent=1800 dropped=599   underruns=288449
 *     重载  calls=13400 sent=2680 dropped=893   underruns=429152
 * 每 128 样本一次 process()，25% 的样本是补零 —— 那就是用户听到的爆音。
 * 丢的不是"块"，是时间轴：块周期 480 样本 = 10 ms，而 worklet→主线程的
 * postMessage 在主线程忙时排队远超 10 ms，于是输入块被丢、输出端饿死补零。
 *
 * ── 四条硬约束（每一条都是实测踩出来的）──
 * 1) **Worker 进程级常驻，绝不随 AudioContext 重建。**
 *    onnxruntime 的 Environment 一个进程只能建一个，第二次 new FongDenoise
 *    直接报 "env: only one environment is allowed per process"。
 *    Mic.start() 每次新建 AudioContext → 新 SAB，所以 SAB 用 attach 重绑。
 * 2) **输入必须走环形缓冲，不能"单块 + 互斥序号"。**
 *    单块互斥意味着 worklet 要等 Worker 处理完才能写下一块，
 *    Worker 慢一拍输入就被丢。实测 144 块丢 69 块（48%）。
 *    4 槽输入环让生产者永不等待消费者。
 * 3) **处理循环绝不 yield。**
 *    早先版本每 8 块 setTimeout(loop,0) 让出一次，好让 onmessage 能跑；
 *    结果每批之间留 4 ms 空洞，20 ms 的输出缓冲被吃穿 ——
 *    实测空载就有 150 ms 纯零段。所以控制面全部改走 SAB 原子命令槽，
 *    循环只做 Atomics.wait，一次都不让出。
 * 4) **输出侧必须垫启动余量（见 worklet 的 gotFirst）。**
 *    一块音频要攒 10 ms 才凑齐，处理再花 1.6 ms，天然迟到 11.6 ms。
 *
 * ── 内存布局（必须与 denoise-worklet.js / denoise-renderer.js 一致）──
 *   输入环   4 槽 × 480 float
 *   输出环   3 槽 × 480 float
 *   ctrl     Int32Array(16)
 *     [0] inWrite   worklet 写
 *     [1] inRead    Worker 写
 *     [2] outWrite  Worker 写
 *     [3] outRead   worklet 写
 *     [4] state     1=运行 0=退出
 *     [5] beats     心跳，证明循环还活着
 *     [6] cmdEnable -1 不变 / 0 关 / 1 开
 *     [7] cmdMode   -1 不变 / 0 关 / 1 轻量 / 2 质量
 *     [8] cmdHowl   -1 不变 / 0 关 / 1 开
 *     [9] cmdTrans  -1 不变 / 0 关 / 1 开
 *     [10] cmdReset 1 = 请复位，Worker 处理后清 0
 *     [11] statOk   已处理块数
 *     [12] statFail 失败块数
 *     [13] statDrop 环满丢弃块数
 *     [14] err
 *     [15] ready   1 = 模型已就绪，worklet 可以开始推输入
 */
const BLOCK = 480;
const IN_SLOTS = 16;
const OUT_SLOTS = 12;

const IN_OFF = 0;
const OUT_OFF = IN_SLOTS * BLOCK * 4;
const CTRL_OFF = OUT_OFF + OUT_SLOTS * BLOCK * 4;
const CTRL_N = 24;   // 【0.4.73】扩到 24：20 号槽是诊断用饥饿注入，index 0..23

const C_IN_W = 0, C_IN_R = 1, C_OUT_W = 2, C_OUT_R = 3, C_STATE = 4, C_BEAT = 5;
const C_CMD_ENABLE = 6, C_CMD_MODE = 7, C_CMD_HOWL = 8, C_CMD_TRANS = 9, C_CMD_RESET = 10;
const C_READY = 16;      // 1 = 模型已就绪，worklet 可推输入
const C_CMD_TILT = 17;   // 高频衰减（dB/oct × 10，整数传输）
const C_STAT_OK = 11, C_STAT_FAIL = 12, C_STAT_DROP = 13, C_ERR = 14;
// 【诊断】最后一块的输入/输出峰值（×10000 取整）。用来回答"native 到底吃进了什么、吐出了什么"，
// 只写不读，不影响数据通路。
// 【0.4.40】18 号槽改作「跳过降噪」命令位。原来的 DBG_IN_PEAK 只在早期调试用过，
// 现在有 denoiseDiag / aecDiag 两套结构化诊断，这个探针可以退役。
// 关键：旁路必须【只跳过 GTCRN】，AEC 的输出要留在链上 —— 否则回声消除白做（实测 ERLE 0.4 dB）。
const C_CMD_DEN_BYPASS = 18, C_DBG_OUT_PEAK = 19;

// ── AEC 的 far-end 参考环（独立 SAB，由 denoise-renderer 通过 'far' 消息传进来）──
// 布局与 aec-ref-worklet.js 严格对应：ctrl(8×i32) + FAR_SLOTS 个 BLOCK 长槽
const FAR_SLOTS = 16;
const FAR_CTRL_N = 8;
const C_FAR_WRITE = 0;
let farCtrl = null;
let farSlots = null;
let farRead = 0;
let aec = null;
let aecOn = false;
let aecDiagN = 0;
const FAR_SILENCE = new Float32Array(BLOCK);
const aecTmp = new Float32Array(BLOCK);
let lastMsg = null;

let den = null;
let ctrl = null;
let inSlots = null;
let outSlots = null;
let inRead = 0;
let outWrite = 0;
let ok = 0;
let fail = 0;
let dropped = 0;
let totalMs = 0;
let running = false;
let loopActive = false;
let prevSab = null;   // 【0.4.50】上一次绑定的降噪 SAB，用来判断是否需要停循环

/** 找 native：Worker 里没有 preload 的解析上下文，打包后在 resources/fong-native */
function loadNative(msg) {
  const tries = [];
  if (msg.nodePath) tries.push(msg.nodePath);
  if (msg.nativeDir) tries.push(msg.nativeDir);
  tries.push('fong-native');
  const errs = [];
  for (const p of tries) {
    try { return require(p); } catch (e) { errs.push(p + ': ' + e.message); }
  }
  throw new Error('Worker 加载 native 失败：' + errs.join(' | '));
}

/**
 * 只在第一次创建；之后 attach 都复用（ORT env 是进程级单例）。
 * 建完立刻预热：第一块真实音频若撞上模型冷启动（几百 ms），
 * 输入环 4 槽会被瞬间打满并开始丢块 —— 那正是启动时的一串爆音。
 * 预热用静音跑 4 块，把 ORT 的 session / 内存池先趟热。
 */
function ensureDen(msg) {
  lastMsg = msg;
  if (den) return;
  const { FongDenoise } = loadNative(msg);
  den = new FongDenoise(msg.onnx, msg.ort);
  try {
    const wIn = new Float32Array(BLOCK);
    const wOut = new Float32Array(BLOCK);
    for (let i = 0; i < 4; i++) den.processInto(wIn, wOut);
    den.reset();       // 清掉预热留下的 STFT/OLA 状态，避免带着旧相位进来
  } catch (_) { /* 预热失败不影响主功能，第一块慢一点而已 */ }
}

/** 绑定 far-end 参考环（AEC 用）。与降噪的 SAB 完全独立，互不影响。 */
function bindFarSab(sab) {
  farCtrl = new Int32Array(sab, 0, FAR_CTRL_N);
  farSlots = [];
  for (let i = 0; i < FAR_SLOTS; i++) {
    farSlots.push(new Float32Array(sab, FAR_CTRL_N * 4 + i * BLOCK * 4, BLOCK));
  }
  farRead = Atomics.load(farCtrl, C_FAR_WRITE);
}

/** 复用同一个 native 模块（require 同一路径返回同一实例，FongAec 与 FongDenoise 在一起）。 */
let aecErr = null;
function ensureAec() {
  if (aec) return true;
  try {
    const nat = loadNative(lastMsg || {});
    if (!nat || !nat.FongAec) { aecErr = 'native 模块里没有 FongAec 导出'; return false; }
    aec = new nat.FongAec(48000);
    aecErr = null;
    return true;
  } catch (e) {
    aec = null;
    aecErr = (e && e.message) || String(e);
    return false;
  }
}

/** 取一帧 far 参考；没有就返回静音块 —— 保证 render/capture 严格 1:1。 */
// 【0.4.40】far 诊断：峰值 + 过零率估频 —— 用来确认「参考环里是不是真的远端声音」
let farDiagPeak = 0, farDiagZero = 0, farDiagFrames = 0;
let prePeak = 0, preDb = -120;   // AEC 之前的近端电平（VAD 判语音用）
// 【独立审查 · 0.4.45】far 环的两个独立观测量：
//   farRate = 写指针推进速率（块/秒，正常 100）—— 它不动 = 参考链断了（与远端是否说话无关）
//   farPeakHold = 诊断窗口内的峰值保持 —— 只报「最后一块」会把「远端刚好停顿」误判成「参考环静音」
let farPeakHold = 0, farRateAt = 0, farRateW = 0, farRate = 0;
// 【0.4.75】far 积压控制。
// 原逻辑只在积压 > FAR_SLOTS(16) 时跳到 w-16 —— 跳完仍落后 160 ms，而且每次跳都是一个
// 不可预测的延迟台阶，AEC3 的延迟估计器要重新收敛（期间回声漏过去）。
// far 与 near 由同一个 AudioContext 驱动，速率完全相同，积压只来自"near 没被 1:1 消费"
// （worklet 预热/旁路期间不推 near、worker 丢块）。所以把积压钉在一个小的固定值即可。
const FAR_TARGET = 2;     // 正常积压（块）
const FAR_RESYNC = 6;     // 超过这个数才重同步（小抖动不动它，避免频繁改变延迟）
let farResyncs = 0;
/** near 被丢掉 n 块时，far 也丢 n 块，保持两条时间轴同步 */
function skipFar(n) {
  if (!farCtrl || n <= 0) return;
  const w = Atomics.load(farCtrl, C_FAR_WRITE);
  farRead = Math.min(w, farRead + n);
}
function takeFar() {
  if (!farCtrl) return FAR_SILENCE;
  const w = Atomics.load(farCtrl, C_FAR_WRITE);
  if (w <= farRead) return FAR_SILENCE;
  if (w - farRead > FAR_RESYNC) { farRead = w - FAR_TARGET; farResyncs++; }
  const slot = farSlots[farRead % FAR_SLOTS];
  farRead++;
  // 每帧统计（开销可忽略：一次 480 元素扫描）
  {
    let pk = 0, zc = 0, prev = 0;
    for (let i = 0; i < BLOCK; i++) {
      const v = slot[i];
      const a = v < 0 ? -v : v;
      if (a > pk) pk = a;
      if ((prev < 0) !== (v < 0)) zc++;
      prev = v;
    }
    farDiagPeak = pk;
    farDiagZero = zc;
    farDiagFrames++;
    if (pk > farPeakHold) farPeakHold = pk;
  }
  return slot;
}

function bindSab(sab) {
  ctrl = new Int32Array(sab, CTRL_OFF, CTRL_N);
  inSlots = [];
  for (let i = 0; i < IN_SLOTS; i++) {
    inSlots.push(new Float32Array(sab, IN_OFF + i * BLOCK * 4, BLOCK));
  }
  outSlots = [];
  for (let i = 0; i < OUT_SLOTS; i++) {
    outSlots.push(new Float32Array(sab, OUT_OFF + i * BLOCK * 4, BLOCK));
  }

  inRead = Atomics.load(ctrl, C_IN_R);
  outWrite = Atomics.load(ctrl, C_OUT_W);
  ok = 0; fail = 0; dropped = 0; totalMs = 0;
  // 注：0.4.27 曾在此处调 den.reset()，但因无法稳定复现收益、且该版本验证中出现
  // 「不发包」现象，已回滚。native 流式状态的清理仍只由 CMD_RESET 触发。

  // 【0.4.50】stopLoop 停过之后必须重新放行（本函数末尾还有一次 running=true，保持一致）
  loopActive = false;
  Atomics.store(ctrl, C_STATE, 1);
  Atomics.store(ctrl, C_BEAT, 0);
  Atomics.store(ctrl, C_STAT_OK, 0);
  Atomics.store(ctrl, C_STAT_FAIL, 0);
  Atomics.store(ctrl, C_STAT_DROP, 0);
  Atomics.store(ctrl, C_CMD_ENABLE, -1);
  Atomics.store(ctrl, C_CMD_MODE, -1);
  Atomics.store(ctrl, C_CMD_HOWL, -1);
  Atomics.store(ctrl, C_CMD_TRANS, -1);
  Atomics.store(ctrl, C_CMD_TILT, -1);
  Atomics.store(ctrl, C_CMD_RESET, 0);
  // 就绪标志：只在【首次】初始化时清零（native/ORT 冷启动期间，输入应被丢弃）。
  // 【0.4.65】原来每次都清 0，但 re-attach 时 ensureDen() 是 `if (den) return` 秒回的，
  // 根本没有"预热"要做 —— 清 0 只是人为制造一个 ctrl=false 的空窗：
  // 实测冷启动后连续切档，第 4~6 次仍出现 ctrl=false / underruns 6688~7232 / db=-35.3。
  // native 实例已就绪时直接放行，不制造空窗。
  if (!den) Atomics.store(ctrl, C_READY, 0);
  // 【不要】在这里写槽 15：renderer 可能已经写了 AEC 开关，而 attach 消息会比它晚被处理，
  // 归零会把用户刚打开的开关吃掉（实测踩到：ctrl15 恒为 0、worker 永远 aecOn=false）。
  running = true;
}

/** 控制面走 SAB：循环不必让出事件循环，也能收到开关/档位变更 */
let denBypass = false;
function applyCommands() {
  // 「跳过降噪」：守护判定降噪把语音改坏了 → 只关 GTCRN，AEC 继续跑
  denBypass = Atomics.load(ctrl, C_CMD_DEN_BYPASS) === 1;
  // AEC 开关：第 15 号槽是状态位（0/1），每帧读一次 —— 幂等，不怕重复。
  // 为什么不用消息：worker 主循环在通话中从不让出事件循环，消息永远轮不到。
  {
    const on = Atomics.load(ctrl, 15) === 1;
    if (on !== aecOn) {
      aecOn = on;
      if (aecOn && !aec) ensureAec();
    } else if (aecOn && !aec) {
      ensureAec();
    }
  }
  const en = Atomics.load(ctrl, C_CMD_ENABLE);
  if (en >= 0) { den.setEnabled(en === 1); Atomics.store(ctrl, C_CMD_ENABLE, -1); }

  const md = Atomics.load(ctrl, C_CMD_MODE);
  if (md >= 0) { den.setMode(md); Atomics.store(ctrl, C_CMD_MODE, -1); }

  const hw = Atomics.load(ctrl, C_CMD_HOWL);
  if (hw >= 0) {
    if (den.setHowlSuppression) den.setHowlSuppression(hw === 1);
    Atomics.store(ctrl, C_CMD_HOWL, -1);
  }
  const tr = Atomics.load(ctrl, C_CMD_TRANS);
  if (tr >= 0) {
    if (den.setTransientSuppression) den.setTransientSuppression(tr === 1);
    Atomics.store(ctrl, C_CMD_TRANS, -1);
  }
  const tl = Atomics.load(ctrl, C_CMD_TILT);
  if (tl >= 0) {
    if (den.setHfTilt) den.setHfTilt(tl / 10);
    Atomics.store(ctrl, C_CMD_TILT, -1);
  }
  if (Atomics.load(ctrl, C_CMD_RESET) === 1) {
    den.reset();
    inRead = Atomics.load(ctrl, C_IN_R);
    outWrite = Atomics.load(ctrl, C_OUT_W);
    ok = 0; fail = 0; dropped = 0; totalMs = 0;
    Atomics.store(ctrl, C_STAT_OK, 0);
    Atomics.store(ctrl, C_STAT_FAIL, 0);
    Atomics.store(ctrl, C_STAT_DROP, 0);
    Atomics.store(ctrl, C_CMD_RESET, 0);
  }
}

/** 等输入环有新块。返回 'data' / 'idle' / 'stop'。20 ms 超时只为让 state 变更被看到 */
function waitForInput() {
  if (!running || Atomics.load(ctrl, C_STATE) === 0) { running = false; return 'stop'; }
  const w = Atomics.load(ctrl, C_IN_W);
  if (w !== inRead) return 'data';
  Atomics.wait(ctrl, C_IN_W, w, 20);
  if (!running || Atomics.load(ctrl, C_STATE) === 0) { running = false; return 'stop'; }
  return (Atomics.load(ctrl, C_IN_W) !== inRead) ? 'data' : 'idle';
}

// 允许的最大积压块数。超过就跳到最新块 —— 丢时间轴，换回延迟。
// 为什么必须有：处理耗时随负载涨（游戏抢 CPU 时实测 25 ms/块，而块周期
// 只有 10 ms），积压会线性增长，用户听到的是"越来越滞后"的声音，
// 十几秒后彻底对不上嘴型。实测无追帧 25 ms/块 → 起音 515 ms。
// 【0.4.75】3 → 6。worklet 侧有了延迟调速器（在安静块上带交叉淡化地回收延迟），
// 这里不必再对 30 ms 级的抖动就硬跳输入（硬跳 = GTCRN 的 STFT 历史断裂 = 咔哒）。
// 仍保留上限：处理速度持续跟不上实时（RTF>1）时，积压不能无限增长。
const MAXLAG = 6;

function step() {
  const w = Atomics.load(ctrl, C_IN_W);
  if (w === inRead) return;          // 无 near 就无配对：此时不消费 far 是对的

  // 【0.4.73 · 独立审查 §1.2 修正】far 必须在【所有 return 之前】消费一次。
  //
  // 原来两条丢弃路径直接 return，不调 takeFar()：
  //   跳帧（MAXLAG）→ far 环积压 N 帧
  //   输出环满      → 又积压
  // 恢复后 takeFar 看到积压超过 FAR_SLOTS(16)，会一次跳到最新 —— 等于 render 信号
  // 在时间轴上瞬移 160 ms。AEC3 的 delay 估计器立刻失锁，
  // W 在错位的 far 上做梯度下降 = 随机游走，每帧往 near 里减一坨无关的 far。
  //
  // 戴耳机时 near 里没有 far 的成分，W 本该收敛到 0；不收敛就是"主动把远端的
  // 声音反相注入发送通路" —— 对端听到的是自己刚说的话。这是回音的直接机制。
  //
  // 修法：near 每消费一块，far 也恰好消费一块（1:1）。丢弃 near 时同样丢掉对应的 far，
  // 保证两条时间轴永远同步。
  const farNow = aecOn ? takeFar() : null;

  // 追帧：输出环没满、但输入积压超过 MAXLAG，就跳过中间的块。
  // 只跳输入、不动输出环，所以不会在播放侧造成空洞。
  if (w - inRead > MAXLAG) {
    const skipped = (w - inRead) - 1;
    inRead = w - 1;
    Atomics.store(ctrl, C_IN_R, inRead);
    dropped += skipped;
    Atomics.store(ctrl, C_STAT_DROP, dropped);
    // 【0.4.75】原注释说"far 对应块也已丢掉"，但代码只消费了 1 块 far，丢了 skipped 块 near。
    // 每次追帧 far 就相对 near 多落后 skipped×10 ms，直到积压破 16 再整体跳 —— AEC 失锁。
    skipFar(skipped);
  }

  // 输出环满：worklet 还没读走。丢输入块是错位，覆写正在播的槽是噪声 —— 取前者。
  if (outWrite - Atomics.load(ctrl, C_OUT_R) >= OUT_SLOTS) {
    dropped += (w - inRead);
    skipFar(w - inRead - 1);         // 【0.4.75】near 丢几块，far 就丢几块（顶部已消费 1 块）
    inRead = w;                      // 跳过积压，追到最新
    Atomics.store(ctrl, C_IN_R, inRead);
    Atomics.store(ctrl, C_STAT_DROP, dropped);
    return;                          // far 已消费，不产生积压
  }

  const src = inSlots[inRead % IN_SLOTS];
  const dst = outSlots[outWrite % OUT_SLOTS];
  const t0 = Date.now();

  // ── AEC3：先 render(far) 再 capture(near)，顺序不能反（WebRTC APM 的要求）──
  // far 是「我们正要送去扬声器的声音」；缺失时补静音，保证两路严格 1:1。
  // AEC 的输出再喂给 GTCRN —— 必须在降噪之前：降噪会先把回声改形，模型就会把回声当语音保下来。
  // 【0.4.46】AEC 之前先量一次近端电平，写进 18/19 之外的诊断槽（farPeak/farPeakHold 已占）。
  // 为什么需要：VAD 挂在 Denoise.node 输出上，那是 AEC + 降噪之后 ——
  // AEC 把回声消干净时（外放 + 对方大声，或两端同源音源），node 输出近零，
  // VAD 判「没人说话」→ 门控关门 → 说话也被掐掉（静默自锁）。
  // 用「AEC 之前的近端」判语音，语义才对：有没有人在对着麦克风讲话。
  {
    let pk = 0, ss = 0;
    for (let i = 0; i < BLOCK; i++) { const v = src[i]; const a = v < 0 ? -v : v; if (a > pk) pk = a; ss += v * v; }
    prePeak = pk;
    preDb = 10 * Math.log10(ss / BLOCK + 1e-12);
  }

  let denIn = src;
  if (aecOn) {
    if (!aec && !ensureAec()) { /* native 没有 AEC：直接跳过，保持旧行为 */ }
    if (aec) {
      try {
        aec.render(farNow);   // 【0.4.73】用 step() 开头已消费的那一帧（保证 1:1 且不重复取）
        if (typeof aec.captureInto === 'function') {
          // 【0.4.37】零分配路径：直接写进预置缓冲，省掉每 10 ms 一次 napi 分配 + 拷贝
          aec.captureInto(src, aecTmp);
          denIn = aecTmp;
        } else {
          const cleaned = aec.capture(src);   // 旧 .node 的回退路径
          aecTmp.set(cleaned);
          denIn = aecTmp;
        }
      } catch (_) {
        denIn = src;
      }
    }
  }

  let ip = 0;
  for (let i = 0; i < BLOCK; i++) { const a = src[i] < 0 ? -src[i] : src[i]; if (a > ip) ip = a; }
  try {
    if (denBypass || !den) {
      // 守护判定降噪有损，或用户干脆没开降噪（AEC-only）→ 这一级直通。
      // AEC 的结果保留（denIn 就是 AEC 的输出），绝不因为降噪缺席就整链失效。
      dst.set(denIn);
    } else {
      den.processInto(denIn, dst);
    }
    let op = 0;
    for (let i = 0; i < BLOCK; i++) { const a = dst[i] < 0 ? -dst[i] : dst[i]; if (a > op) op = a; }
    ok++;
    totalMs += Date.now() - t0;
  } catch (e) {
    fail++;
    Atomics.store(ctrl, C_ERR, fail);
    // 出错直通：把输入复制到这个输出槽。绝不静音，静音就是一声咔哒。
    dst.set(src);
  }
  Atomics.store(ctrl, C_STAT_OK, ok);
  Atomics.store(ctrl, C_STAT_FAIL, fail);

  inRead++;
  Atomics.store(ctrl, C_IN_R, inRead);

  // 【0.4.33】把 AEC 的运行状态定期带回主线程（每 200 帧 = 2 秒）
  if (aecOn && (++aecDiagN % 100 === 0)) {
    try {
      const nowMs = Date.now();
      if (farRateAt) farRate = (farRead - farRateW) * 1000 / (nowMs - farRateAt);
      farRateAt = nowMs; farRateW = farRead;
      postMessage({
        type: 'aecDiag', on: aecOn, ok: !!aec, err: aecErr || null,
        erle: aec ? aec.erleDb() : -1,
        rtf: aec ? aec.rtf() : -1,
        frames: aec ? aec.frames() : -1,
        far: farRead, farBound: !!farCtrl,
        farPeak: Number(farDiagPeak.toFixed(4)),
        preDb: Number(preDb.toFixed(1)),
        prePeak: Number(prePeak.toFixed(4)),
        farPeakHold: Number(farPeakHold.toFixed(4)),
        farRate: Math.round(farRate),
        farLag: farCtrl ? (Atomics.load(farCtrl, C_FAR_WRITE) - farRead) : -1,
        farResyncs,
        farHz: Math.round(farDiagZero / 2 * (48000 / BLOCK)),   // 过零率估频（正弦足够准）
        nativeHasFongAec: (() => { try { const n = loadNative(lastMsg || {}); return !!(n && n.FongAec); } catch (e) { return 'load-fail:' + ((e && e.message) || e); } })(),
      });
      farPeakHold = 0;   // 峰值保持按窗口清零
    } catch (_) { /* 诊断失败不影响主链 */ }
  }

  outWrite++;
  Atomics.store(ctrl, C_OUT_W, outWrite);
  Atomics.notify(ctrl, C_OUT_W);
}

/**
 * 主循环。
 *
 * 关键：**只在 idle 时让出事件循环**。
 *   - 有数据时连续处理，绝不让出（让出会在块之间留空洞，实测吃穿输出缓冲）
 *   - 没数据时才 setTimeout 让出，让 attach / stats / detach 等消息能被派发
 * 空闲让出是免费的：此刻本来就没有音频要处理，输出环里还有 30 ms 存量兜着。
 */
function loop() {
  loopActive = true;
  try {
    for (;;) {
      const r = waitForInput();
      if (r === 'stop') break;
      applyCommands();
      Atomics.store(ctrl, C_BEAT, (Atomics.load(ctrl, C_BEAT) + 1) | 0);
      if (r === 'data') {
        step();
        continue;       // 有活就接着干，不让出
      }
      // idle：让出一次，给消息派发机会
      loopActive = false;
      scheduleLoop();
      return;
    }
  } catch (err) {
    loopActive = false;
    postMessage({ type: 'fatal', reason: (err && err.stack) || String(err) });
    return;
  }
  loopActive = false;
  postMessage({ type: 'stopped' });
}

// 调度去重：idle 让出和 attach 重启可能同时发生，重复调度会让两个循环
// 同时跑同一个 ctrl，输出立刻错乱。
let scheduled = false;
function scheduleLoop() {
  if (scheduled) return;
  scheduled = true;
  setTimeout(() => { scheduled = false; loop(); }, 0);
}
function startLoop() {
  if (loopActive) return;
  scheduleLoop();
}

/**
 * 【0.4.50】停下旧循环。关键点：
 * 1) loopActive 置 false，让正在跑的 scheduleLoop 下一次自检时退出；
 * 2) 必须 notify 一次当前 ctrl 的写指针，否则循环正卡在 Atomics.wait 上，
 *    要等满 20 ms 超时才醒 —— 那样两次拉取之间会有空隙，重新 attach 后仍会掉帧。
 * 顺序必须是「先置标志、再唤醒」，否则唤醒后循环又判定 loopActive 继续跑。
 */
function stopLoop() {
  // 【0.4.50】循环体是 `for(;;)`，只在 waitForInput() 返回 'stop' 时 break；
  // 而 waitForInput 判停的唯一依据是 running=false 或 C_STATE===0。
  // 所以这里必须动 running，光改 loopActive 停不下来（我第一版就写错了，
  // 结果是旧循环继续对着旧 ctrl 跑，新 SAB 永远收不到数据）。
  running = false;
  try {
    if (ctrl) {
      Atomics.store(ctrl, C_STATE, 0);   // 双保险：waitForInput 里两个判据都满足
      Atomics.notify(ctrl, C_IN_W, 1);   // 把卡在 Atomics.wait 上的循环立刻叫醒
    }
  } catch (_) { /* 旧 ctrl 可能已失效，忽略 */ }
}

function statsMsg() {
  let frames = 0;
  let lat = 0;
  let aecInfo = null;
  try {
    if (aec) aecInfo = { on: aecOn, erleDb: aec.erleDb(), rtf: aec.rtf(), frames: aec.frames() };
  } catch (_) { aecInfo = null; }
  try { if (den) { frames = den.stats().frames; lat = den.latencyMs(); } } catch (_) { /* ignore */ }
  return {
    type: 'stats', ok, fail, dropped,
    inWrite: ctrl ? Atomics.load(ctrl, C_IN_W) : 0,
    inRead: ctrl ? Atomics.load(ctrl, C_IN_R) : 0,
    outWrite: ctrl ? Atomics.load(ctrl, C_OUT_W) : 0,
    beats: ctrl ? Atomics.load(ctrl, C_BEAT) : 0,
    latencyMs: lat,
    avgMs: ok ? totalMs / ok : 0,
    frames,
  };
}

self.onmessage = (e) => {
  const m = e.data;
  if (!m) return;
  try {
    if (m.type === 'init' || m.type === 'attach') {
      ensureDen(m);
      // 【0.4.50 · 严重修正】
      // 前提：renderer 侧的降噪 SAB 已经改成进程内唯一（_makeSab 缓存复用），
      // 所以重建前后 sab 是【同一块内存】，循环里闭包用的 ctrl 视图也指向同一块内存。
      // 因此：只需要让 bindSab 重读指针，【不需要】停循环再重启。
      //
      // 走了两个弯路，记在这里免得以后再犯：
      //  a) 不停循环只 startLoop() → 循环卡在旧指针上（0.4.49 的环形指针遗留脏值），
      //     表现为「切档后 sent 停在 300 多、输出 -73 dB、一卡一卡」。
      //  b) 先 stopLoop() 再 startLoop() → scheduled 去重标志与 setTimeout 竞态，
      //     新循环根本没起来，underruns 3 秒内暴涨到 5888。
      // 正确做法：sab 变了才停并等它真的退出；sab 没变就纯重绑指针。
      // 只有 sab 真的换了（不该发生，因为 renderer 已缓存）才需要停循环；
      // 这里保留判断是为了防御：万一将来又改成每次新建 SAB，也能正确重启而不是静默失效。
      if (prevSab !== m.sab && prevSab !== null) stopLoop();
      prevSab = m.sab;
      bindSab(m.sab);
      if (m.farSab) bindFarSab(m.farSab);
      Atomics.store(ctrl, C_READY, 1);   // 预热已完成，放行输入
      postMessage({ type: 'ready', latencyMs: den.latencyMs() });
      startLoop();
    } else if (m.type === 'detach') {
      running = false;
      if (ctrl) { Atomics.store(ctrl, C_STATE, 0); Atomics.notify(ctrl, C_IN_W, 1); }
      postMessage({ type: 'detached' });
    } else if (m.type === 'far') {
      bindFarSab(m.sab);
      postMessage({ type: 'farReady' });
    } else if (m.type === 'aec') {
      aecOn = !!m.value;
      if (aecOn) ensureAec();
      postMessage({ type: 'aecState', on: aecOn, ok: !!aec, err: aecErr, farBound: !!farCtrl });
    } else if (m.type === 'stats') {
      postMessage(statsMsg());
    } else if (m.type === 'stop') {
      running = false;
      if (ctrl) { Atomics.store(ctrl, C_STATE, 0); Atomics.notify(ctrl, C_IN_W, 1); }
    }
    // 开关 / 档位 / 啸叫 / 瞬态 / 复位一律走 SAB 命令槽（见 applyCommands）。
    // 不走消息：消息要事件循环，而事件循环被阻塞式等待占着。
  } catch (err) {
    postMessage({ type: 'error', reason: (err && err.message) || String(err) });
  }
};
