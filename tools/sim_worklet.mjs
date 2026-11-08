// 离线仿真：真实 denoise-worklet.js + 按 denoise-worker.js step() 逻辑写的 JS worker（恒等处理）。
// 注入 CPU 抢占（worker 停顿），量：播放延迟随时间的变化、波形跳变（咔哒）次数、worker 丢块、far/near 错位。
// 用法：node sim_worklet.mjs <worklet.js> <MAXLAG> <mirrorFar 0|1> [分钟=10] [seed=1]
import fs from 'node:fs';
import vm from 'node:vm';

const [,, wpath, maxlagArg, mirrorArg, minArg, seedArg] = process.argv;
const MAXLAG = +maxlagArg, MIRROR = mirrorArg === '1';
const MIN = +(minArg || 10);
let seed = +(seedArg || 1);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

const SR = 48000, Q = 128, BLOCK = 480, IN_SLOTS = 16, OUT_SLOTS = 12, CTRL_N = 24;
const C_IN_W = 0, C_IN_R = 1, C_OUT_W = 2, C_OUT_R = 3, C_READY = 16;

let Proc = null;
const ctx = {
  AudioWorkletProcessor: class { constructor() { this.port = { postMessage() {}, onmessage: null }; } },
  registerProcessor: (n, c) => { Proc = c; },
  Atomics, Float32Array, Int32Array, Math, console,
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(wpath, 'utf8'), ctx);

const sab = new SharedArrayBuffer((IN_SLOTS + OUT_SLOTS) * BLOCK * 4 + CTRL_N * 4);
const ctrl = new Int32Array(sab, (IN_SLOTS + OUT_SLOTS) * BLOCK * 4, CTRL_N);
const inSlots = [...Array(IN_SLOTS)].map((_, i) => new Float32Array(sab, i * BLOCK * 4, BLOCK));
const outSlots = [...Array(OUT_SLOTS)].map((_, i) => new Float32Array(sab, (IN_SLOTS + i) * BLOCK * 4, BLOCK));
Atomics.store(ctrl, C_READY, 1);
const p = new Proc({ processorOptions: { sab } });

// 记录每个输入槽 / 输出槽对应的原始样本起点，用来算真实延迟
const inStart = new Float64Array(IN_SLOTS), outStart = new Float64Array(OUT_SLOTS);
let g = 0;  // 全局样本时钟
const origPush = p.pushInput.bind(p);
p.pushInput = function () {
  const w = this.inWrite;
  const okk = origPush();
  if (okk) inStart[w % IN_SLOTS] = g - BLOCK + 1;
  return okk;
};

// worker 模型
let inRead = 0, outWrite = 0, busyUntil = 0, wDrop = 0;
let farW = 0, farR = 0, farMis = 0, farJumps = 0;  // far 环：与 near 同速写入
const PROC_MS = 2.0;                 // 单块处理（低配机器 GTCRN 大约 2~8 ms）
const STALL_RATE = 1 / 8;            // 平均每 8 秒一次抢占
function workerRun(nowMs) {
  while (busyUntil <= nowMs) {
    const w = Atomics.load(ctrl, C_IN_W);
    if (w === inRead) return;
    // takeFar（原逻辑：>16 跳到 w-16；补丁：>6 跳到 w-2）
    if (farW > farR) {
      const lim = MIRROR ? 6 : 16, tgt = MIRROR ? 2 : 16;
      if (farW - farR > lim) { farR = farW - tgt; farJumps++; }
      farR++;
    }
    if (w - inRead > MAXLAG) {
      const skipped = (w - inRead) - 1;
      inRead = w - 1; wDrop += skipped;
      if (MIRROR) farR = Math.min(farW, farR + skipped);
    }
    if (outWrite - Atomics.load(ctrl, C_OUT_R) >= OUT_SLOTS) {
      const sk = w - inRead; wDrop += MIRROR ? sk : 1;
      if (MIRROR) farR = Math.min(farW, farR + sk - 1);
      inRead = w; Atomics.store(ctrl, C_IN_R, inRead);
      busyUntil = Math.max(busyUntil, nowMs - 1) + 0.05;
      continue;
    }
    outSlots[outWrite % OUT_SLOTS].set(inSlots[inRead % IN_SLOTS]);
    outStart[outWrite % OUT_SLOTS] = inStart[inRead % IN_SLOTS];
    inRead++; Atomics.store(ctrl, C_IN_R, inRead);
    outWrite++; Atomics.store(ctrl, C_OUT_W, outWrite);
    busyUntil = Math.max(busyUntil, nowMs - PROC_MS) + PROC_MS * (0.7 + 0.6 * rnd());
    // near/far 错位：near 消费的是第 inRead 块，far 消费到 farR；两者差的变化就是 AEC 看到的延迟变化
    farMis = (farW - farR) - (Atomics.load(ctrl, C_IN_W) - inRead);
  }
}

const total = MIN * 60 * SR;
const inCh = new Float32Array(Q), outCh = new Float32Array(Q);
let clicks = 0, prevOut = 0, latMax = 0, nextStall = (rnd() * 8 + 1) * 1000;
const latLog = []; let lastMis = null, farShifts = 0;
let latAcc = 0, latN = 0;
for (let q = 0; g < total; q++) {
  const nowMs = g / SR * 1000;
  if (nowMs >= nextStall) {           // 抢占：worker 停 20~150 ms
    busyUntil = Math.max(busyUntil, nowMs) + 20 + 130 * rnd();
    nextStall = nowMs + (-Math.log(1 - rnd()) / STALL_RATE) * 1000;
  }
  workerRun(nowMs);
  for (let i = 0; i < Q; i++) {
    const n = g + i;
    // SIG=speech：400 ms 有声 / 300 ms 静音交替（静音段留一点底噪），更接近通话
    const on = process.env.SIG !== 'speech' || (n % 33600) < 19200;
    inCh[i] = on ? 0.3 * Math.sin(2 * Math.PI * 220 * n / SR) : 0.0005 * Math.sin(2 * Math.PI * 1000 * n / SR);
  }
  const gq = g;
  // pushInput 在 process 内部发生，g 需要逐样本：用 getter 近似，pushInput 时 g = 当前样本
  const origAccLen = p.accLen;
  g = gq + (BLOCK - origAccLen) - 1;   // 本 quantum 内若攒满，攒满点的样本号（最多一次）
  p.process([[inCh]], [[outCh]]);
  g = gq + Q;
  // 跳变检测：220 Hz/0.3 正弦的最大样本差约 0.0086；> 0.05 计一次咔哒
  for (let i = 0; i < Q; i++) { if (Math.abs(outCh[i] - prevOut) > 0.05) clicks++; prevOut = outCh[i]; }
  // far 参考环与 near 同一个 AudioContext：每 480 样本写一块
  farW += Math.floor(g / BLOCK) - Math.floor((g - Q) / BLOCK);
  // 延迟：当前播放块的源样本起点 vs 现在
  if (p.gotFirst && p.outRead < Atomics.load(ctrl, C_OUT_W)) {
    const lat = (g - (outStart[p.outRead % OUT_SLOTS] + p.outCursorBlk)) / SR * 1000;
    latAcc += lat; latN++;
    if (lat > latMax) latMax = lat;
  }
  if (p.gotFirst) { if (lastMis !== null && farMis !== lastMis) farShifts++; lastMis = farMis; }
  if ((q + 1) % Math.round(60 * SR / Q) === 0) { latLog.push(+(latAcc / Math.max(1, latN)).toFixed(0)); latAcc = 0; latN = 0; }
}
console.log(JSON.stringify({
  worklet: wpath.split('/').slice(-3).join('/'), MAXLAG, mirrorFar: MIRROR, minutes: MIN,
  avgLatencyMsPerMinute: latLog, latMaxMs: +latMax.toFixed(0),
  clicks, workerDropped: wDrop, underrunSamples: p.underruns, govSkips: p.govSkips ?? null,
  farResyncs: farJumps,
}));
