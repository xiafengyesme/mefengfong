'use strict';

// native 模块加载器：打包后 .node 在 resources/ 下（不能 dlopen asar 里的），
// 开发时在 node_modules 下。两种情况都要能跑。
/**
 * 加载原生模块。
 *
 * 打包后的坑：uiohook-napi 内部写的是 require('node-gyp-build') —— 裸模块名，
 * 而 node-gyp-build 被打到 resources/node-gyp-build（不在 node_modules 里），
 * Node 的解析链从 resources/uiohook-napi/dist 往上找，永远找不到。
 * 结果就是全局快捷键静默失效（只打一行 stderr，用户看不出）。
 *
 * 修法：把 resources 目录注入 module.paths，让裸名 require 能找到它。
 */
function loadNative(name) {
  const path = require('path');
  const Module = require('module');
  // 让裸模块名也能解析到 resources 下
  try {
    if (process.resourcesPath && !Module.globalPaths.includes(process.resourcesPath)) {
      Module.globalPaths.push(process.resourcesPath);
    }
  } catch (_) { /* ignore */ }
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
const { app, BrowserWindow, session, Menu, Tray, nativeImage, ipcMain, shell, globalShortcut, Notification, protocol, net , screen } = require('electron');
// 更新走自建下载器（见 wireUpdater），不再依赖 electron-updater
const { pathToFileURL } = require('url');
const path = require('path');

app.setAppUserModelId('com.fong.voice.desktop');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
// 降噪用 SharedArrayBuffer 在 worklet 和主线程之间零拷贝传音频块。
// Chromium 默认因 Spectre 缓解而禁用 SAB，这个开关可以启用它。
// ---------- app:// 协议 ----------
// 降噪的 Worker 必须能在独立线程里跑（主线程一忙，postMessage 就会排队，
// 导致输入块被丢、输出补零 —— 实测丢 25%）。而 Chromium 在 file:// 下
// 直接禁掉 Worker，所以把页面挂到自定义协议上。
// 必须在 app ready 之前注册。
protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
}]);

// ---------- 自签证书放行 ----------
// 默认服务器用自签证书（没有域名就签不了正式证书，Let's Encrypt 不给 IP 签）。
// Chromium 默认拒绝，表现就是界面上「连不上服务器，检查地址或网络」——
// 而用 curl -k 测又是通的，很容易误判成网络问题。
//
// 只放行「自签」和「域名/IP 不匹配」两类；证书过期、被吊销仍然拦。
const CERT_ALLOWED = new Set([
  'net::ERR_CERT_AUTHORITY_INVALID',   // 自签根证书
  'net::ERR_CERT_COMMON_NAME_INVALID', // IP/域名不在证书 SAN 里
]);

// 证书固定（pin）：只放行「我们这台服务器的那张证书」。
// 之前是「只要错误类型在白名单里就放行」，等于任何自签证书都能冒充服务器；
// 现在额外比对公钥指纹（SPKI SHA-256），指纹不对一律拒绝。
// 换证书（续期）时要更新这里 —— 见 docs/证书固定.md
const CERT_PINS = new Set([
  'sha256/udP9HcUzWVIL0UEmgXJDiZlPGKbhrK3ELZ7Jm6pfUjw=',
]);
const CERT_HOSTS = new Set(['8.156.40.211', 'fongget.xyz', 'www.fongget.xyz']);

function certHost(url) {
  try { return new URL(url).hostname; } catch (_) { return ''; }
}
function certPinOk(certificate) {
  try {
    if (!certificate || !certificate.data) return false;
    const x = new crypto.X509Certificate(certificate.data);
    const der = x.publicKey.export({ type: 'spki', format: 'der' });
    const pin = 'sha256/' + crypto.createHash('sha256').update(der).digest('base64');
    return CERT_PINS.has(pin);
  } catch (e) {
    console.error('[cert] 计算公钥指纹失败:', e.message);
    return false;
  }
}

app.on('certificate-error', (event, webContents, url, error, certificate, callback) => {
  const host = certHost(url);
  if (CERT_ALLOWED.has(error) && CERT_HOSTS.has(host) && certPinOk(certificate)) {
    console.warn('[cert] 放行已固定证书:', url, error);
    event.preventDefault();
    callback(true);
    return;
  }
  // 类型不对 / 不是我们的域名 / 指纹不匹配 —— 一律拒绝
  console.error('[cert] 拒绝证书:', url, error, 'host=' + host);
  callback(false);
});

app.commandLine.appendSwitch('enable-features', 'SharedArrayBuffer');

// 单实例：双开会抢麦克风、两个身份同进一个房间
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

let win = null, tray = null, quitting = false, trayHinted = false;

// ---------- 自动更新（自建下载器） ----------
// 为什么不用 electron-updater：它走 Electron 的 net 模块做证书校验，而我们是
// 「IP 直连 + 域名证书」（net::ERR_CERT_COMMON_NAME_INVALID）。渲染进程的 fetch 有
// certificate-error 放行，net 没有 —— 所以更新包由渲染层下载，主进程只负责落盘/校验/安装。
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

let updFile = null;      // 正在写入的临时文件
let updHash = null;      // 边写边算 sha256
let updPath = null;

function updateSend(state, extra) {
  try { if (win && !win.isDestroyed()) win.webContents.send('update:state', Object.assign({ state }, extra || {})); } catch (_) {}
}

function wireUpdater() {
  ipcMain.handle('update:begin', (_e, name) => {
    try {
      updPath = path.join(os.tmpdir(), 'FONG-update-' + Date.now() + '.exe');
      updFile = fs.createWriteStream(updPath);
      updHash = crypto.createHash('sha256');
      return { ok: true, path: updPath };
    } catch (e) { return { ok: false, message: String(e.message || e) }; }
  });

  ipcMain.handle('update:chunk', (_e, buf) => {
    return new Promise((resolve) => {
      if (!updFile) return resolve({ ok: false });
      const b = Buffer.from(buf);
      updHash.update(b);
      updFile.write(b, () => resolve({ ok: true }));
    });
  });

  ipcMain.handle('update:end', () => {
    return new Promise((resolve) => {
      if (!updFile) return resolve({ ok: false });
      const f = updFile; updFile = null;
      f.end(() => resolve({ ok: true, sha256: updHash ? updHash.digest('hex') : '', path: updPath }));
    });
  });

  ipcMain.handle('update:install', (_e, opts) => {
    const p = (opts && opts.path) || updPath;
    if (!p || !fs.existsSync(p)) return { ok: false, message: '安装包不存在' };
    try {
      // NSIS 静默安装；装完自己退出，让安装器接管
      // /S 静默装；--force-run 让 NSIS 装完把新版本拉起来（assisted installer 只有在
      // Silent + isForceRun 两个条件同时成立时才启动 app，见 installSection.nsh）
      const child = spawn(p, ['/S', '--force-run'], { detached: true, stdio: 'ignore' });
      child.unref();
      quitting = true;
      setTimeout(() => { try { app.quit(); } catch (_) {} }, 800);
      return { ok: true };
    } catch (e) { return { ok: false, message: String(e.message || e) }; }
  });

  ipcMain.handle('update:cleanup', (_e, p) => {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) {}
    return { ok: true };
  });
}

// ---------- 自绘标题栏：窗口按钮 ----------
// frame:false 之后系统不再画最小化/最大化/关闭，这里接渲染层的三个按钮。
// 注册一次即可（win 可能被重建，所以每次都取当前的 win）。
ipcMain.on('win:min', () => { if (win) win.minimize(); });
ipcMain.on('win:max', () => {
  if (!win) return;
  if (win.isMaximized()) win.unmaximize(); else win.maximize();
});
ipcMain.on('win:close', () => { if (win) win.close(); });
let state = { joined: false, muted: false, deafened: false };
// 窗口/任务栏图标用 PNG：nativeImage 对 PNG 的支持最稳，ICO 在 asar 里偶尔读不出来，
// 读不出来时 Windows 会退回 Electron 默认的原子图标（任务栏那个蓝紫色圆标）。
const ICON = path.join(__dirname, 'assets', 'icon-256.png');
const TRAY_PNG = path.join(__dirname, 'assets', 'tray.png');

// fong://join/<空间ID> 邀请链接
if (process.defaultApp) app.setAsDefaultProtocolClient('fong', process.execPath, [path.resolve(process.argv[1] || '.')]);
else app.setAsDefaultProtocolClient('fong');
const findLink = (argv) => (argv || []).find((a) => /^fong:\/\//i.test(a));
let pendingLink = findLink(process.argv);

function show() { if (!win) return; if (win.isMinimized()) win.restore(); win.show(); win.focus(); }

function createWindow() {
  // 【0.4.50】窗口位置与大小记忆。原来每次启动都回到 1180x760 居中，
  // 多显示器/习惯性摆放的用户每次都要重摆（OOPZ 会落盘 app_window，KOOK 也记）。
  const ws = loadWindowState();
// 【0.4.50】窗口状态落盘到 %APPDATA%/FONG/window.json
function winStatePath() {
  try { return path.join(app.getPath('userData'), 'window.json'); } catch (_) { return null; }
}
function loadWindowState() {
  const def = { width: 1180, height: 760, x: undefined, y: undefined, maximized: false };
  try {
    const p = winStatePath();
    if (!p || !fs.existsSync(p)) return def;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    const out = Object.assign({}, def, j);
    // 边界保护：解析出来的位置必须落在某个显示器的可视区域里，否则丢弃（换显示器/拔外接屏的常见坑）
    if (Number.isFinite(out.x) && Number.isFinite(out.y)) {
      const ok = screen.getAllDisplays().some((d) => {
        const b = d.workArea;
        return out.x < b.x + b.width - 80 && out.x + out.width > b.x + 80
            && out.y < b.y + b.height - 60 && out.y + out.height > b.y + 40;
      });
      if (!ok) { out.x = undefined; out.y = undefined; }
    }
    out.width = Math.max(360, Math.min(8000, Number(out.width) || def.width));
    out.height = Math.max(560, Math.min(8000, Number(out.height) || def.height));
    return out;
  } catch (_) { return def; }
}
let winStateTimer = null;
function saveWindowStateSoon() {
  clearTimeout(winStateTimer);
  winStateTimer = setTimeout(() => {
    try {
      if (!win || win.isDestroyed()) return;
      const p = winStatePath();
      if (!p) return;
      const b = win.isMaximized() ? win.getNormalBounds() : win.getBounds();
      fs.writeFileSync(p, JSON.stringify({
        width: b.width, height: b.height, x: b.x, y: b.y, maximized: win.isMaximized(),
      }));
    } catch (_) { /* 记不住位置不影响使用 */ }
  }, 400);
}

  win = new BrowserWindow({
    width: ws.width, height: ws.height, x: ws.x, y: ws.y,
    minWidth: 360, minHeight: 560, show: false,
    backgroundColor: '#0B0C0E', title: 'FONG', icon: ICON, autoHideMenuBar: true,
    // 自绘标题栏：整窗无边框，标题栏由渲染层画（和 UI 同色），
    // 窗口按钮自己实现（最小化 / 最大化 / 关闭），hover 态也能自己控。
    // thickFrame 保持默认 true —— Windows 上仍保留贴边缩放和 Aero Snap。
    frame: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false, sandbox: false, backgroundThrottling: false, spellcheck: false,
      nodeIntegration: false,
      // 降噪 Worker 必须能 require('fong-native')。
      // 纯 JS 线程默认没有 Node 集成，Worker 里 require 直接 undefined。
      nodeIntegrationInWorker: true,
    },
  });
  Menu.setApplicationMenu(null);

  // 【F12-DEV】Electron 本身不内置 F12 —— 它只是 Chromium 的默认快捷键，
  // 而 Electron 把菜单删掉之后（上一行 setApplicationMenu(null)），
  // 连菜单里那条「切换开发者工具」也没了，于是按 F12 完全没反应。
  // 这里自己拦：F12 开/关，Ctrl+Shift+I 同效。
  // 生产版也保留 —— 语音类客户端没有 DevTools 就没法自查延迟。
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const f12 = input.key === 'F12';
    const ctrlShiftI = (input.control || input.meta) && input.shift && (input.key || '').toLowerCase() === 'i';
    if (!f12 && !ctrlShiftI) return;
    e.preventDefault();
    if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
    else win.webContents.openDevTools({ mode: 'bottom' });
  });
  // 启动参数 --devtools 时自动开，便于「双击图标直接进调试」
  if (process.argv.includes('--devtools')) {
    win.webContents.once('did-finish-load', () => {
      try { win.webContents.openDevTools({ mode: 'bottom' }); } catch (_) {}
    });
  }
  // 显式把图标压到窗口上（WM_SETICON），不依赖 Chromium 自己挑图。
  try {
    const img = nativeImage.createFromPath(ICON);
    if (!img.isEmpty()) win.setIcon(img);
  } catch (_) { /* ignore */ }
  win.loadURL('app://fong/index.html');
  win.once('ready-to-show', () => win.show());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  wireUpdater();
  // 最大化状态同步给渲染层，切换按钮图标
  win.on('maximize', () => { try { win.webContents.send('win:state', true); } catch (_) {} saveWindowStateSoon(); });
  win.on('unmaximize', () => { try { win.webContents.send('win:state', false); } catch (_) {} saveWindowStateSoon(); });
  // 【0.4.50】窗口位置/大小记忆：拖动与缩放都防抖落盘
  win.on('resize', saveWindowStateSoon);
  win.on('move', saveWindowStateSoon);
  // 启动时若上次是最大化，恢复最大化
  if (loadWindowState().maximized) { try { win.maximize(); } catch (_) {} }
  // 关窗口 = 最小化到托盘，语音不断
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!trayHinted && Notification.isSupported()) {
      trayHinted = true;
      new Notification({ title: 'FONG 还在后台', body: '语音不会断。右键托盘图标可以退出。', icon: ICON, silent: true }).show();
    }
  });
  win.webContents.on('did-finish-load', () => { if (pendingLink) { win.webContents.send('deep-link', pendingLink); pendingLink = null; } });
}

function buildTray() {
  const img = nativeImage.createFromPath(TRAY_PNG);
  tray = new Tray(img.isEmpty() ? nativeImage.createFromPath(ICON) : img);
  tray.setToolTip('FONG');
  tray.on('click', show);
  refreshTray();
}
function refreshTray() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 FONG', click: show },
    { type: 'separator' },
    { label: state.muted ? '取消静音' : '静音麦克风', enabled: state.joined, click: () => win && win.webContents.send('hotkey', 'mute') },
    { label: state.deafened ? '取消闭听' : '闭听（不听也不说）', enabled: state.joined, click: () => win && win.webContents.send('hotkey', 'deafen') },
    { label: '挂断', enabled: state.joined, click: () => win && win.webContents.send('hotkey', 'hangup') },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.setToolTip(state.joined ? `FONG · ${state.muted ? '已静音' : '通话中'}` : 'FONG');
}

// ---------------- 全局热键（游戏全屏时也能用） ----------------
// uiohook 能拿到按下/松开，按键说话必须用它；拿不到时退回 globalShortcut（只支持切换类热键）。
let hook = null, binds = { mute: null, deafen: null, ptt: null }, held = new Set();
function initHook() {
  try {
    const { uIOhook } = loadNative('uiohook-napi');
    hook = uIOhook;
    const combo = (e) => [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', 'k' + e.keycode].filter(Boolean).join('+');
    const mouse = (e) => 'm' + e.button;
    const fire = (code, down) => {
      for (const [action, b] of Object.entries(binds)) {
        if (!b || b.code == null) continue;
        const base = (c) => c.split('+').pop();
        const hit = action === 'ptt' ? base(code) === base(b.code) : code === b.code;
        if (!hit) continue;
        if (action === 'ptt') { if (down && !held.has('ptt')) { held.add('ptt'); send('ptt', true); } else if (!down && held.has('ptt')) { held.delete('ptt'); send('ptt', false); } }
        else if (down) send('hotkey', action);
      }
    };
    hook.on('keydown', (e) => { if (capture) return finishCapture(combo(e), keyName(e)); fire(combo(e), true); });
    hook.on('keyup', (e) => fire(combo(e), false));
    hook.on('mousedown', (e) => { if (e.button > 2) { if (capture) return finishCapture(mouse(e), '鼠标侧键' + (e.button - 3 + 1)); fire(mouse(e), true); } });
    hook.on('mouseup', (e) => { if (e.button > 2) fire(mouse(e), false); });
    // 注意：这里【不】调用 hook.start()，由 startHook() 按需启动。
    return true;
  } catch (err) { console.error('uiohook 不可用', err); hook = null; return false; }
}

// 【0.4.71】全局钩子按需启停。
//
// 背景：用户反馈「改按键直接闪退」。Windows 事件日志确认：
//   APPCRASH / FONG.exe / 0.4.69.0 / 故障模块 MSCTF.dll / c0000005
// MSCTF 是 Windows 输入法框架 —— uIOhook 的全局键盘钩子与输入法冲突。
//
// 原实现 initHook() 在应用启动时无条件 hook.start()，钩子全程常驻；
// 用户去设置页改键时正好在输入法活跃状态，撞上就崩。
//
// 现在：平时不启动钩子，只有「确实配了全局热键」时才开。
// 用户在设置页录键时【停掉钩子】，改用窗口内 keydown 采集 —— 那时应用在前台，
// 不需要全局钩子，也就不会跟输入法打架。
let hookRunning = false;
function startHook() {
  if (!hook || hookRunning) return;
  try { hook.start(); hookRunning = true; } catch (err) { console.error('hook.start 失败', err); hookRunning = false; }
}
function stopHook() {
  if (!hook || !hookRunning) return;
  try { hook.stop(); } catch (err) { /* ignore */ }
  hookRunning = false;
}
// 是否需要常驻钩子：配了任意一个热键（ptt/mute/deafen）才需要
function needHook() {
  return !!(binds && (binds.ptt || binds.mute || binds.deafen));
}
// 【0.4.71】DOM KeyboardEvent.code → uiohook keycode 映射。
// 必须做这层转换：两套编码完全不同（DOM 里 M=77，uiohook 里 M=50）。
// 直接把 DOM keyCode 存进 binds，钩子上报的 code 永远对不上 —— 热键静默失效。
let CODE2UIO = null;
function buildCodeMap() {
  if (CODE2UIO) return CODE2UIO;
  // 【0.4.71】必须用 loadNative：打包后原生模块在 resources/ 解包目录，直接 require 找不到
  const { UiohookKey } = loadNative('uiohook-napi');
  const m = {};
  // ⚠️ UiohookKey 是【双向表】（名称→编码 + 编码→名称，共 124 条），
  // 且名称是单字母 `M` / `D`，【不是】`KeyM` / `KeyD`。
  // 第一次写错成 UiohookKey['KeyM'] → undefined → 整个映射 0 条（探测时才发现）。
  // 字母：DOM 'KeyM' → uiohook 'M'
  for (let i = 0; i < 26; i++) {
    const L = String.fromCharCode(65 + i);
    if (typeof UiohookKey[L] === 'number') m['Key' + L] = UiohookKey[L];
  }
  // 数字：DOM 'Digit1' → uiohook '1'
  for (let i = 0; i <= 9; i++) {
    const D = String(i);
    if (typeof UiohookKey[D] === 'number') m['Digit' + D] = UiohookKey[D];
  }
  // 功能键：DOM 'F1' → uiohook 'F1'（同名）
  for (let i = 1; i <= 24; i++) {
    if (typeof UiohookKey['F' + i] === 'number') m['F' + i] = UiohookKey['F' + i];
  }
  // 符号与其他：DOM code 与 uiohook 名称大多同名，逐个试
  const sameName = [
    'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight',
    'Semicolon', 'Quote', 'Comma', 'Period', 'Slash', 'Backslash',
    'Space', 'Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Insert',
    'Home', 'End', 'PageUp', 'PageDown',
    'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
    'CapsLock', 'NumLock', 'ScrollLock', 'PrintScreen', 'Pause',
  ];
  for (const n of sameName) if (typeof UiohookKey[n] === 'number') m[n] = UiohookKey[n];
  // 小键盘：DOM 'Numpad1' → uiohook 'Numpad1'（若有）
  for (let i = 0; i <= 9; i++) {
    const n = 'Numpad' + i;
    if (typeof UiohookKey[n] === 'number') m[n] = UiohookKey[n];
  }
  CODE2UIO = m;
  return m;
}
const NL = String.fromCharCode(10);
ipcMain.handle('hotkeys:keymap', () => {
  try {
    const m = buildCodeMap();
    const n = Object.keys(m).length;
    // 写文件而不是 console.error —— 打包版没有 stderr 可看
    try {
      require('fs').writeFileSync(
        require('path').join(require('os').tmpdir(), 'fong-keymap.log'),
        new Date().toISOString() + ' count=' + n + ' sample=' + JSON.stringify(Object.entries(m).slice(0, 3)) + NL,
        { flag: 'a' }
      );
    } catch (_) {}
    return m;
  } catch (err) {
    try {
      require('fs').writeFileSync(
        require('path').join(require('os').tmpdir(), 'fong-keymap.log'),
        new Date().toISOString() + ' ERROR ' + (err && err.message) + NL,
        { flag: 'a' }
      );
    } catch (_) {}
    return {};
  }
});

function keyName(e) {
  // 【0.4.71】必须用 loadNative：打包后原生模块在 resources/ 解包目录，直接 require 找不到
  const { UiohookKey } = loadNative('uiohook-napi');
  const name = Object.keys(UiohookKey).find((k) => UiohookKey[k] === e.keycode) || ('Key' + e.keycode);
  return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', name].filter(Boolean).join(' + ');
}
let capture = null;
function finishCapture(code, label) {
  const c = capture;
  capture = null;
  // 【0.4.71】判空：超时后 capture 已被清成 null，此时按键会走到这里。
  // 原来直接 c({...}) → TypeError: c is not a function（主进程抛错）。
  if (typeof c !== 'function') return;
  try { c({ code, label }); } catch (err) { console.error('finishCapture failed', err); }
}
function send(ch, v) { if (win && !win.isDestroyed()) win.webContents.send(ch, v); }

ipcMain.handle('hotkeys:set', (_e, b) => {
  binds = b || binds;
  // 【0.4.71】配置变化后同步钩子状态：配了键就开，全清了就关
  if (needHook()) startHook(); else stopHook();
  if (!hook) {
    globalShortcut.unregisterAll();
    for (const [action, v] of Object.entries(binds)) if (v && v.accel && action !== 'ptt') { try { globalShortcut.register(v.accel, () => send('hotkey', action)); } catch (e) {} }
  }
  return { native: !!hook };
});
// 【0.4.71】capture 的三处加固（防崩溃 / 防状态残留）：
//  a) 已有 capture 在等 → 先 resolve 掉旧的，避免两个 Promise 抢同一个 capture
//  b) 超时清理用统一的清空函数，不留悬挂引用
//  c) finishCapture 里判空，避免「超时后按键」导致 c is not a function
// 背景：用户反馈「改按键直接闪退」，Windows 事件日志确认是
// APPCRASH / MSFTF.dll / c0000005 —— 全局键盘钩子与输入法框架冲突。
// 这条只是加固，真正的修法是 initHook 改成按需启动（见下）。
ipcMain.handle('hotkeys:capture', () => new Promise((resolve) => {
  // 【0.4.71】录键时停掉全局钩子 —— 那一刻应用在前台，用不到全局钩子，
  // 而它就是跟输入法冲突（MSCTF.dll / c0000005）的那个东西。
  // 采集改由渲染进程用窗口内 keydown 完成（见 renderer.js 的 captureKeyViaWindow）。
  if (!hook) return resolve(null);
  stopHook();
  // 有旧的 capture 在等：先放掉，避免两个 resolve 抢同一状态
  if (capture) { const old = capture; capture = null; try { old(null); } catch (_) {} }
  let done = false;
  const finish = (v) => {
    if (done) return; done = true;
    if (capture === finish) capture = null;
    // 录完恢复钩子（只在确实配了热键时）
    if (needHook()) startHook();
    try { resolve(v); } catch (_) {}
  };
  capture = finish;
  setTimeout(() => finish(null), 8000);
}));
ipcMain.on('state', (_e, s) => {
  const wasJoined = state.joined;
  state = Object.assign(state, s);
  refreshTray();
  // 「正在玩」只在通话中有意义：进房起常驻 watcher，离房立刻收掉
  if (state.joined && !wasJoined) startForegroundWatch();
  else if (!state.joined && wasJoined) stopForegroundWatch();
});
ipcMain.on('flash', () => { if (win && !win.isFocused()) win.flashFrame(true); });
// 不要用 app.getVersion()：未打包（直接 electron .）时它返回 Electron 自己的版本
// （实测拿到 45.2.2），只有打包后才读 package.json。直接读文件，两种环境都对。
let pkgVersion = '';
try { pkgVersion = require('./package.json').version || ''; } catch (_) { /* ignore */ }
ipcMain.handle('app:info', () => ({ version: pkgVersion, platform: process.platform }));

// 降噪现在完全跑在 renderer 进程（见 preload.js / denoise-renderer.js）。
// 这两个旧的 IPC 入口保留空实现，避免老版本代码调用时报错。
ipcMain.on('denoise:attach', (e) => {
  const port = e.ports && e.ports[0];
  if (port) port.postMessage({ type: 'unavailable', reason: '降噪已迁移到 renderer 进程' });
});
ipcMain.handle('denoise:stats', () => ({ error: '已迁移到 renderer 进程' }));
ipcMain.on('denoise:enabled', () => {});
ipcMain.on('autostart', (_e, on) => app.setLoginItemSettings({ openAtLogin: !!on, args: ['--hidden'] }));

app.on('second-instance', (_e, argv) => { show(); const l = findLink(argv); if (l) send('deep-link', l); });
app.on('open-url', (e, url) => { e.preventDefault(); if (win) send('deep-link', url); else pendingLink = url; });

// ---------- 正在玩（KOOK/OOPZ 式） ----------
// 进房时每 5 秒查一次「真正的」前台程序（GetForegroundWindow P/Invoke，不是猜 CPU 最高的），
// 名字变了才推给渲染层 → presence 上报 → 房间成员右栏显示「正在玩 XXX」。
let lastPlaying = '';
const PS_FOREGROUND = [
  "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class FG { [DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); [DllImport(\"user32.dll\")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid); }';",
  'while ($true) {',
  '  $h = [FG]::GetForegroundWindow(); $procId = 0; [FG]::GetWindowThreadProcessId($h, [ref]$procId) | Out-Null;',
  "  if ($procId -gt 0) { (Get-Process -Id $procId -ErrorAction SilentlyContinue).ProcessName } else { '' };",
  '  Start-Sleep -Seconds 3',
  '}',
].join(' ');
let fgProc = null;
function startForegroundWatch() {
  if (fgProc || !win || win.isDestroyed()) return;
  try {
    fgProc = spawn('powershell', ['-NoProfile', '-Command', PS_FOREGROUND], { windowsHide: true });
    let buf = '';
    fgProc.stdout.on('data', (d) => {
      buf += String(d);
      let i;
      while ((i = buf.indexOf(String.fromCharCode(10))) >= 0) {
        const name = buf.slice(0, i).trim().toLowerCase();
        buf = buf.slice(i + 1);
        if (!name) continue;
        if (name !== lastPlaying) { lastPlaying = name; send('playing', name); }
      }
    });
    fgProc.on('error', () => { fgProc = null; });
    fgProc.on('close', () => { fgProc = null; });
  } catch (_) { fgProc = null; }
}
function stopForegroundWatch() {
  if (fgProc) { try { fgProc.kill(); } catch (_) {} fgProc = null; }
  if (lastPlaying) { lastPlaying = ''; send('playing', ''); }
}
// 兜底：即使渲染层没推 state 变化，也别让 watcher 悄悄跑着
app.on('before-quit', () => { stopForegroundWatch(); });

// app://fong/<相对路径> → 应用目录下的文件
function serveApp(req) {
  try {
    const u = new URL(req.url);
    let rel = decodeURIComponent(u.pathname || '/');
    if (rel === '/' || rel === '') rel = '/index.html';
    const file = path.normalize(path.join(__dirname, rel));
    // 只允许应用目录内的文件，挡掉 ../ 穿越
    if (!file.startsWith(path.normalize(__dirname + path.sep))) {
      return new Response('forbidden', { status: 403 });
    }
    return net.fetch(pathToFileURL(file).toString());
  } catch (e) {
    return new Response('bad request', { status: 400 });
  }
}

app.whenReady().then(() => {
  protocol.handle('app', serveApp);
  session.defaultSession.setPermissionRequestHandler((_wc, perm, cb) => cb(['media', 'speaker-selection', 'clipboard-sanitized-write', 'notifications'].includes(perm)));
  session.defaultSession.setPermissionCheckHandler((_wc, perm) => ['media', 'speaker-selection', 'clipboard-sanitized-write', 'notifications'].includes(perm));
  createWindow();
  buildTray();
  initHook();
  // 【0.4.71】不无条件启动：只有已经配过热键才常驻钩子。
  // 全新安装（还没配键）时钩子完全不启动 —— 那是崩溃的唯一来源。
  if (needHook()) startHook();
  if (process.argv.includes('--hidden')) win.once('ready-to-show', () => win.hide());
});
app.on('before-quit', () => { quitting = true; try { hook && hook.stop(); } catch (e) {} });
app.on('window-all-closed', () => {});
