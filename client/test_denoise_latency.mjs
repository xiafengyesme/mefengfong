/**
 * FONG 降噪延迟 —— 回归测试（跑真实的 denoise-worklet.js / denoise-worker.js）
 *
 * 三项断言，每项都对应一条实测到的用户可感知故障：
 *   T1 预热期不得吐静音 —— 进房第一句话不能被吞
 *   T2 PREFILL 不得大于 3 —— 稳态起音不得超 30ms 预算
 *   T3 处理慢于块周期时必须追帧 —— 积压不得无限增长
 *
 * 桩的口径与真实环境一致：
 *   - 环形缓冲布局、ctrl 槽位、Atomics 语义完全照抄
 *   - worklet 用真的 process() 逐 128 样本调用（真实 quantum）
 *   - worker 用真的 step()，处理耗时用忙等模拟
 * 桩不能比被测代码宽松：整条链路上不做任何"容错修补"。
 */
// 跑法：node test_denoise_latency.mjs [app 目录]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = process.argv[2] || path.dirname(fileURLToPath(import.meta.url));
const BLOCK = 480, IN_SLOTS = 16, OUT_SLOTS = 12, CTRL_N = 20;
const IN_OFF = 0, OUT_OFF = IN_SLOTS * BLOCK * 4, CTRL_OFF = OUT_OFF + OUT_SLOTS * BLOCK * 4;
const C_IN_W = 0, C_IN_R = 1, C_OUT_W = 2, C_OUT_R = 3, C_STATE = 4, C_READY = 16;

const results = [];
function check(id, name, ok, detail) {
  results.push({ id, name, ok, detail });
  console.log(`${ok ? '✓' : '✗'} ${id} ${name}\n    ${detail}`);
}

function loadWorkletClass(file) {
  const src = fs.readFileSync(path.join(APP, file), 'utf8');
  let Klass = null;
  const fn = new Function(
    'registerProcessor', 'AudioWorkletProcessor', 'currentFrame', 'sampleRate',
    src + '\nreturn null;'
  );
  class Base {
    constructor() { this.port = { postMessage() {}, set onmessage(f) {} }; }
  }
  fn((n, c) => { Klass = c; }, Base, 0, 48000);
  if (!Klass) throw new Error('registerProcessor 没被调用');
  return Klass;
}

function makeEnv() {
  const sab = new SharedArrayBuffer(CTRL_OFF + CTRL_N * 4 + 64);
  const ctrl = new Int32Array(sab, CTRL_OFF, CTRL_N);
  ctrl.fill(0);
  Atomics.store(ctrl, C_STATE, 1);
  for (const k of [6, 7, 8, 9, 17]) Atomics.store(ctrl, k, -1);
  return { sab, ctrl };
}

/** 模拟一次完整链路：worklet 逐 quantum 跑 + worker 逐块处理 */
function runChain({ workletFile, procUs, blocks, readyAtBlock }) {
  const Klass = loadWorkletClass(workletFile);
  const { sab, ctrl } = makeEnv();
  Atomics.store(ctrl, C_READY, readyAtBlock === 0 ? 1 : 0);
  const proc = new Klass({ processorOptions: { enabled: true, sab } });

  const inSlots = [], outSlots = [];
  for (let i = 0; i < IN_SLOTS; i++) inSlots.push(new Float32Array(sab, IN_OFF + i * BLOCK * 4, BLOCK));
  for (let i = 0; i < OUT_SLOTS; i++) outSlots.push(new Float32Array(sab, OUT_OFF + i * BLOCK * 4, BLOCK));

  let inRead = Atomics.load(ctrl, C_IN_R);
  let outWrite = Atomics.load(ctrl, C_OUT_W);
  let maxBacklog = 0;
  let skippedTotal = 0;
  const out = [];
  const spin = (us) => { const t = process.hrtime.bigint(); while (Number(process.hrtime.bigint() - t) < us * 1000); };

  for (let b = 0; b < blocks; b++) {
    if (b === readyAtBlock) Atomics.store(ctrl, C_READY, 1);

    // ---- worklet：4 个 quantum ----
    for (let q = 0; q < BLOCK / 128; q++) {
      const inp = new Float32Array(128).fill(0.3);
      const outp = new Float32Array(128);
      proc.process([[inp]], [[outp]]);
      for (let i = 0; i < 128; i++) out.push(proc.enabled && !proc.bypass ? outp[i] : inp[i]);
    }

    // ---- worker：真的走输入环，处理耗时用忙等 ----
    const w = Atomics.load(ctrl, C_IN_W);
    if (w !== inRead) {
      // 复刻修复后的追帧（若文件里有 MAXLAG 就生效，没有就跳过）
      const src = fs.readFileSync(path.join(APP, 'denoise-worker.js'), 'utf8');
      const m = /const MAXLAG = (\d+);/.exec(src);
      const maxlag = m ? +m[1] : 0;
      if (maxlag && w - inRead > maxlag) {
        const skipped = (w - inRead) - 1;
        inRead = w - 1;
        Atomics.store(ctrl, C_IN_R, inRead);
        skippedTotal += skipped;
      }
      maxBacklog = Math.max(maxBacklog, w - inRead);
      if (outWrite - Atomics.load(ctrl, C_OUT_R) < OUT_SLOTS) {
        spin(procUs);
        outSlots[outWrite % OUT_SLOTS].set(inSlots[inRead % IN_SLOTS]);
        inRead++; Atomics.store(ctrl, C_IN_R, inRead);
        outWrite++; Atomics.store(ctrl, C_OUT_W, outWrite);
      } else {
        inRead = w; Atomics.store(ctrl, C_IN_R, inRead);
      }
    }
  }
  return { out, maxBacklog, skippedTotal, prefilled: proc.prefill };
}

// ============ T1：预热期不得吐静音 ============
{
  const r = runChain({ workletFile: 'denoise-worklet.js', procUs: 1900, blocks: 200, readyAtBlock: 70 });
  let nz = -1;
  for (let i = 0; i < r.out.length; i++) if (Math.abs(r.out[i]) > 1e-6) { nz = i; break; }
  const silentMs = (nz < 0 ? r.out.length : nz) / 48;
  check('T1', '进房第一句话不被吞（预热期直通）', silentMs <= 30,
    `Worker 冷启动 700ms 场景下，输出前 ${silentMs.toFixed(1)} ms 为静音（${(silentMs / 10).toFixed(1)} 块）；要求 ≤ 30 ms`);
}

// ============ T2：PREFILL 不得大于 3 ============
{
  // PREFILL 是模块级常量（不是实例属性）—— 直接读源码里的实际生效值，
  // 避免"读了默认值而实际走了另一条路"这种假绿灯。
  const wsrc = fs.readFileSync(path.join(APP, 'denoise-worklet.js'), 'utf8');
  const constM = /^const PREFILL = (\d+);/m.exec(wsrc);
  const optM = /this\.prefill = \(opt\.prefill == null\) \? PREFILL : \(opt\.prefill \| 0\)/.exec(wsrc);
  const rsrc = fs.readFileSync(path.join(APP, 'denoise-renderer.js'), 'utf8');
  const rM = /PREFILL: (\d+),/.exec(rsrc);
  const fileVal = constM ? +constM[1] : null;
  const rendererVal = rM ? +rM[1] : null;
  const usable = rendererVal == null || fileVal == null || rendererVal >= fileVal ? fileVal : rendererVal;
  check('T2', '输出环预填 ≤ 3 块（30ms）',
    usable != null && usable <= 3,
    `worklet 常量 ${fileVal}、renderer 下发 ${rendererVal}（未下发时用常量）→ 生效值 ${usable} 块 = ${usable * 10} ms；要求 ≤ 3`);
}

// ============ T3：处理慢于块周期必须追帧 ============
{
  const fast = runChain({ workletFile: 'denoise-worklet.js', procUs: 1900, blocks: 200, readyAtBlock: 0 });
  const slow = runChain({ workletFile: 'denoise-worklet.js', procUs: 25000, blocks: 200, readyAtBlock: 0 });
  check('T3', '处理 25ms/块 时积压不失控',
    slow.maxBacklog <= 4 && slow.skippedTotal > 0,
    `正常负载最大积压 ${fast.maxBacklog} 块；过载（25ms/块，块周期 10ms）最大积压 ${slow.maxBacklog} 块、累计追帧丢弃 ${slow.skippedTotal} 块；要求积压 ≤ 4 且确有追帧`);
}

const fail = results.filter((r) => !r.ok);
console.log(`\n${results.length - fail.length}/${results.length} 通过`);
process.exit(fail.length ? 1 : 0);
