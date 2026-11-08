'use strict';
/**
 * FONG preload
 *
 * ── 降噪架构决策（实测驱动）──
 * 原方案：worklet → preload → main → native → main → preload → worklet
 *   跨进程 4 次，实测 CPU 21%（单核），比裸测的 13% 多 8 个百分点。
 * 实测发现：SharedArrayBuffer 在 Electron 里可以同进程共享（worklet ↔ 主线程），
 *   但跨进程（renderer ↔ main）被 Chromium 阻止（需要 cross-origin isolation）。
 * 新方案：native 直接跑在 renderer 进程的 preload 里，彻底消除跨进程 IPC。
 *   代价：阻塞 renderer 主线程约 1.2 ms/块（按 10 ms 一块 = 12% 主线程）。
 *   语音连麦的 UI 很轻，这个代价可以接受。
 *
 * 启动参数需要 --enable-features=SharedArrayBuffer（见 main.js）
 */
const { contextBridge, ipcRenderer } = require('electron');

// ============ 降噪（renderer 进程内） ============
let FongDenoise = null;
let den = null;
let initError = null;
let stats = { ok: 0, fail: 0, lastMs: 0, avgMs: 0, samples: 0 };

/** 找资源：打包后在 process.resourcesPath，开发时在 app/resources */
function resourceDirs() {
  const path = require('path');
  const dirs = [];
  if (process.resourcesPath) dirs.push(process.resourcesPath);
  dirs.push(path.join(__dirname, 'resources'), __dirname);
  dirs.push(path.join(__dirname, 'app.asar.unpacked', 'resources'));
  return dirs;
}

function resolveOrtDll() {
  const fs = require('fs');
  const path = require('path');
  const cands = [];
  for (const d of resourceDirs()) cands.push(path.join(d, 'onnxruntime.dll'));
  if (process.env.ORT_DYLIB_PATH) cands.push(process.env.ORT_DYLIB_PATH);
  if (process.env.APPDATA) {
    cands.push(path.join(process.env.APPDATA, 'Python', 'Python313', 'site-packages',
                         'onnxruntime', 'capi', 'onnxruntime.dll'));
  }
  for (const c of cands) {
    try {
      // 注意：C:\Windows\System32\onnxruntime.dll 是 2.8 KB 的存根，必须过滤
      if (fs.existsSync(c) && fs.statSync(c).size > 5e6) return c;
    } catch (_) { /* ignore */ }
  }
  return null;
}

function resolveModel() {
  const fs = require('fs');
  const path = require('path');
  for (const d of resourceDirs()) {
    for (const name of ['gtcrn_light48_stream.onnx', 'models/gtcrn_light48_stream.onnx']) {
      const p = path.join(d, name);
      try { if (fs.existsSync(p) && fs.statSync(p).size > 1e5) return p; } catch (_) { /* ignore */ }
    }
  }
  return null;
}


// native 模块加载器：打包后 .node 在 resources/ 下（不能 dlopen asar 里的），
// 开发时在 node_modules 下。两种情况都要能跑。
function loadNative(name) {
  const path = require('path');
  const tries = [];
  try { if (process.resourcesPath) tries.push(path.join(process.resourcesPath, name)); } catch (_) {}
  tries.push(path.join(__dirname, 'node_modules', name));
  tries.push(path.join(__dirname, '..', 'node_modules', name));
  tries.push(name);
  const errs = [];
  for (const p of tries) {
    try { return require(p); } catch (e) { errs.push(p + ': ' + e.message); }
  }
  const err = new Error('加载 ' + name + ' 失败：' + errs.join(' | '));
  err.tries = tries;
  throw err;
}

function ensureDenoiser() {
  if (den) return den;
  if (initError) throw new Error(initError);
  try {
    ({ FongDenoise } = loadNative('fong-native'));
  } catch (e) {
    initError = '原生降噪模块加载失败: ' + e.message;
    throw new Error(initError);
  }
  const onnx = resolveModel();
  if (!onnx) { initError = '找不到降噪模型 gtcrn_light48_stream.onnx'; throw new Error(initError); }
  const ort = resolveOrtDll();
  if (!ort) { initError = '找不到 onnxruntime.dll（System32 下同名文件是存根，不可用）'; throw new Error(initError); }
  try {
    den = new FongDenoise(onnx, ort);
    console.log('[denoise] renderer 进程内就绪，延迟', den.latencyMs().toFixed(2), 'ms');
    console.log('[denoise] ORT:', ort);
    console.log('[denoise] 模型:', onnx);
  } catch (e) {
    initError = '降噪初始化失败: ' + e.message;
    throw new Error(initError);
  }
  return den;
}

// ============ 桥对象 ============
// 同进程直连时（contextIsolation: false）不需要 contextBridge 克隆，
// 直接把函数挂到 window 上，音频块零克隆传递。
const bridge = {
  setHotkeys: (b) => ipcRenderer.invoke('hotkeys:set', b),
  captureKey: () => ipcRenderer.invoke('hotkeys:capture'),
  // 【0.4.71】DOM code → uiohook keycode 映射。录键时要靠它转换，
  // 否则存进去的 code 跟钩子上报的对不上，热键静默失效。
  keymap: () => ipcRenderer.invoke('hotkeys:keymap'),
  onHotkey: (fn) => ipcRenderer.on('hotkey', (_e, a) => fn(a)),
  onPTT: (fn) => ipcRenderer.on('ptt', (_e, down) => fn(down)),
  onDeepLink: (fn) => ipcRenderer.on('deep-link', (_e, url) => fn(url)),
  onPlaying: (fn) => ipcRenderer.on('playing', (_e, n) => fn(n)),
  setState: (s) => ipcRenderer.send('state', s),
  flash: () => ipcRenderer.send('flash'),
  setAutostart: (on) => ipcRenderer.send('autostart', on),
  info: () => ipcRenderer.invoke('app:info'),
  testResult: (r) => ipcRenderer.send('test:result', r),
  testLog: (m) => ipcRenderer.send('test:log', m),

  denoiseInit: () => {
    try {
      const d = ensureDenoiser();
      return { ok: true, latencyMs: d.latencyMs() };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  },
  denoiseProcess: (pcm) => {
    if (!den) return pcm;
    const t0 = performance.now();
    try {
      const out = den.process(pcm);
      stats.ok++;
      stats.lastMs = performance.now() - t0;
      stats.samples++;
      stats.avgMs = stats.avgMs + (stats.lastMs - stats.avgMs) / Math.min(stats.samples, 200);
      return out;
    } catch (e) {
      stats.fail++;
      return pcm;
    }
  },
  /** 零分配：直接写进调用方给的输出数组 */
  denoiseProcessTo: (input, output) => {
    if (!den) { output.set(input.subarray(0, output.length)); return true; }
    const t0 = performance.now();
    try {
      den.processInto(input, output);
      stats.ok++;
      stats.lastMs = performance.now() - t0;
      stats.samples++;
      stats.avgMs = stats.avgMs + (stats.lastMs - stats.avgMs) / Math.min(stats.samples, 200);
      return true;
    } catch (e) {
      stats.fail++;
      return false;
    }
  },
  /**
   * SAB 模式：直接在共享内存上读写，零拷贝。
   * renderer 和 worklet 同进程共享 SAB，native 读写同一块内存，无序列化。
   */
  denoiseProcessInto: (sab, inOffset, outOffset, len) => {
    if (!den) return false;
    const t0 = performance.now();
    try {
      const inView = new Float32Array(sab, inOffset, len);
      const outView = new Float32Array(sab, outOffset, len);
      den.processInto(inView, outView);
      stats.ok++;
      stats.lastMs = performance.now() - t0;
      stats.samples++;
      stats.avgMs = stats.avgMs + (stats.lastMs - stats.avgMs) / Math.min(stats.samples, 200);
      return true;
    } catch (e) {
      stats.fail++;
      return false;
    }
  },

  /**
   * 降噪档位（三档）
   *   0 = 关闭（直通，零开销）
   *   1 = 低占用（RNNoise，RTF ≈ 0.004）
   *   2 = 质量（GTCRN-Light-48k，RTF ≈ 0.15）
   */
  denoiseSetMode: (m) => { if (den) den.setMode(m | 0); },
  denoiseGetMode: () => (den ? den.getMode() : 2),

  denoiseSetEnabled: (on) => { if (den) den.setEnabled(!!on); },
  denoiseSetHowl: (on) => { if (den) den.setHowlSuppression(!!on); },
  denoiseSetTransient: (on) => { if (den) den.setTransientSuppression(!!on); },
  denoiseReset: () => { if (den) den.reset(); },
  denoiseLatencyMs: () => (den ? den.latencyMs() : 0),
  // Worker 需要自己 require native，这里把解析好的路径给它
  modelPath: () => resolveModel(),
  ortPath: () => resolveOrtDll(),
  nativeNodePath: () => {
    const path = require('path');
    const fs = require('fs');
    for (const d of resourceDirs()) {
      for (const p of [path.join(d, 'fong-native', 'fong_native.node'),
                       path.join(d, 'fong-native', 'index.js'),
                       path.join(d, 'fong_native.node')]) {
        try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
      }
    }
    // 开发/未打包：node_modules 里
    for (const d of [__dirname, path.join(__dirname, '..')]) {
      const p = path.join(d, 'node_modules', 'fong-native', 'index.js');
      try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
    }
    try { return require.resolve('fong-native'); } catch (_) { return null; }
  },
  nativeDirPath: () => {
    const path = require('path');
    const fs = require('fs');
    for (const d of resourceDirs()) {
      const p = path.join(d, 'fong-native');
      try { if (fs.existsSync(path.join(p, 'index.js'))) return p; } catch (_) { /* ignore */ }
    }
    const dev = path.join(__dirname, 'node_modules', 'fong-native');
    try { if (fs.existsSync(path.join(dev, 'index.js'))) return dev; } catch (_) { /* ignore */ }
    return null;
  },
  /** 高频衰减（dB/octave）。0 = 原行为，3 = 默认，6~8 更闷更干净 */
  denoiseSetHfTilt: (v) => { if (den && den.setHfTilt) den.setHfTilt(v); },
  denoiseGetHfTilt: () => (den && den.getHfTilt ? den.getHfTilt() : 0),
  denoiseStats: () => Object.assign({}, stats, (den ? den.stats() : {}), { error: initError }),
  // 自绘标题栏的窗口按钮（frame:false 后系统不再提供）
  winMin: () => ipcRenderer.send('win:min'),
  winMax: () => ipcRenderer.send('win:max'),
  winClose: () => ipcRenderer.send('win:close'),
  onWinState: (fn) => ipcRenderer.on('win:state', (_e, max) => fn(max)),
  // 自动更新（渲染层下载，主进程落盘/校验/安装）
  updateBegin: (name) => ipcRenderer.invoke('update:begin', name),
  updateChunk: (buf) => ipcRenderer.invoke('update:chunk', buf),
  updateEnd: () => ipcRenderer.invoke('update:end'),
  updateInstall: (opts) => ipcRenderer.invoke('update:install', opts),
  updateCleanup: (p) => ipcRenderer.invoke('update:cleanup', p),
  onUpdate: (fn) => ipcRenderer.on('update:state', (_e, st) => fn(st)),
};

// 两种暴露方式二选一：
//   contextIsolation: true  → contextBridge（有克隆，但隔离安全）
//   contextIsolation: false → 直接挂 window（零克隆，音频块不经序列化）
// 注意：contextIsolation 关闭时 contextBridge API 会抛错，必须先判断。
if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('native', bridge);
} else {
  window.fongBridge = bridge;
  // 兼容写法：renderer 里原本只查 window.native，
  // 关掉 contextIsolation 后桥挂在 fongBridge 上，导致 NATIVE 恒为 null
  // （托盘状态、快捷键、按键说话、深链接、版本号全部失效）。
  // 两个名字都挂上，避免再踩。
  window.native = bridge;
}
