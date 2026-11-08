// FONG 0.3.0 接线层（classic script，不是 ESM）
// ---------------------------------------------------------------------------
// 作用：把 fong-basic.js（打包后的调音台）接到 0.3.0 的 renderer.js 上，
//       只接管「每人音量 + 调音台 + 输出设备路由」这一块。
//
// 加载顺序（index.html，必须在 renderer.js 之前）：
//   <script src="fong-basic.js"></script>
//   <script src="fong-wire.js"></script>
//   <script src="denoise-renderer.js"></script>
//   <script src="renderer.js"></script>
//
// 没加载 FongBasic 时 window.FongWire = null，renderer.js 全部退回原行为。
//
// 三条设计约束（对应接线图 §2 的陷阱）：
//   A. 播放用 AudioContext 由本模块自持，跨房间复用。
//      Room.teardown() 会 close 它自己的 actx，Mic.teardown() 同样 —— 都不能借用。
//      也绝不在每次进房时新建（Chromium 有并发 ctx 上限，累积会静默失效）。
//   B. 音量 key 是 uid（renderer 里 peer = uid + '.' + rhex(3)），不是 peerId。
//   C. 合成只有一处钳位：clamp(总输出 × 个人 × 闪避, 0, 2)，由调音台负责。

(function () {
  var B = window.FongBasic;
  if (!B) { window.FongWire = null; return; }

  // ---------- A. 模块自持的播放 AudioContext（只建一次） ----------
  var ctx = null;
  try {
    var AC = window.AudioContext || window.webkitAudioContext;
    ctx = AC ? new AC({ sampleRate: 48000, latencyHint: 'interactive' }) : null;
  } catch (_) { ctx = null; }

  // ---------- A2. 播放通道选择（0.4.19） ----------
  // 'element'（默认）：远端轨挂 <audio>.srcObject 播放，音量走 el.volume / el.muted。
  // 'webaudio'：模块自持 ctx 混音（createMediaStreamSource → gain → destination）。
  //
  // 实测定案（本机 Electron 45.2.2 / Chromium 156，2026-11-07，两个真客户端经线上 SFU 互听）：
  //   webaudio 通道下接收端 inPk≈50/s 在收包，但 inbound-rtp 的
  //   jitterBufferEmittedCount / totalSamplesDuration / totalAudioEnergy 恒为 0 —— NetEq 一个样本都不发射；
  //   同一条 receiver.track 挂到 <audio>.srcObject + play() 立刻 em=+145920 / sd=+3.03 / en=+0.47 / peak≈0.40。
  //   结论：这条 Chromium 上「WebAudio 拉远端 WebRTC 轨」不驱动音频管线，元素播放是唯一可用通道。
  //   发送侧不受影响（对端实测 recvPeak 0.40），所以现象是「能说、听不到」。
  // 需要临时回到旧行为：localStorage.setItem('fong.wire.mode','webaudio') 后重启客户端。
  var PLAY_MODE = (function () {
    try { return localStorage.getItem('fong.wire.mode') === 'webaudio' ? 'webaudio' : 'element'; }
    catch (_) { return 'element'; }
  })();
  var PLAY_CTX = (PLAY_MODE === 'webaudio') ? ctx : null;

  // 浏览器自动播放策略：未 running 时，首次交互恢复（只挂一次，不重复 resume）
  function resume() { if (ctx && ctx.state !== 'running' && ctx.state !== 'closed') ctx.resume().catch(function () {}); }
  // 0.3.1 接线补：播放 ctx 的看门狗。实测（Electron 45.2.2 / Chromium 156）连续两次 ctx.setSinkId()
  // 会让 ctx 停在 suspended 不再自己恢复 → 房间静音、远端说话态全灭，直到下一次点击/按键。
  // 本模块从不主动 suspend 播放 ctx，所以掉到 suspended/interrupted 一律稍等后拉回 running。
  if (ctx && typeof ctx.addEventListener === 'function') {
    ctx.addEventListener('statechange', function () {
      if (ctx.state === 'suspended' || ctx.state === 'interrupted') setTimeout(resume, 300);
    });
  }
  var sinkChain = (typeof Promise !== 'undefined') ? Promise.resolve() : null;
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (ev) {
    window.addEventListener(ev, resume, { passive: true });
  });

  var desk = null;
  var S = null, save = null, Room = null, Mic = null;
  var lastDuck = null, lastDeaf = null;
  var lastSink = null;

  // ---------- 说话态（只做分析，不碰播放） ----------
  // 时钟可注入，便于单测控制 hold 过期；默认 Date.now()
  var clock = function () { return Date.now(); };
  var talk = null;
  var followed = {};      // mid -> peer（说话检测按 peer 跟，卡片 data-peer 用的是 peer）
  var selfTimer = null;
  var tiles = {};         // peer -> {tile, base}（base = 变化的慢字段：badges/音量等）
  var stage = null, stageFrom = null;   // 麦克风输入级（100% 时不用，旁路）
  var mixer = null;                     // 调音台弹层
  var api = null;                       // renderer 的 api()，登录门要用
  var gate = null;                      // 登录门（验证码模式）
  var tileHooks = null;   // {doc, onMenu, onProfile}

  function sel(peer) { return '.member[data-peer="' + String(peer).replace(/"/g, '') + '"]'; }
  function cardOf(peer) { try { return document.querySelector(sel(peer)); } catch (_) { return null; } }

  if (B.createTalkWatch) {
    talk = B.createTalkWatch({
      audioContext: ctx,
      now: function () { return clock(); },
      onTalk: function (peer, talking) { applyTalk(peer, talking); },
      onLevel: function (peer, level) { applyLevel(peer, level); },
    });
  }

  /**
   * 说话态与电平：
   *   有 tile（② 成员卡）→ 走 tile.update()，由它统一写 class 与 --lvl
   *   没有 tile（旧 .member 卡）→ 退回直接改类名 / --lvl
   * 被屏蔽时同样要亮，这正是本次要修的行为。
   */
  function pushTile(peer, patch) {
    var rec = tiles[String(peer)];
    if (!rec) return false;
    var st = {};
    for (var k in rec.base) if (Object.prototype.hasOwnProperty.call(rec.base, k)) st[k] = rec.base[k];
    for (var k2 in patch) if (Object.prototype.hasOwnProperty.call(patch, k2)) st[k2] = patch[k2];
    // 说话态与电平默认现算（避免"改个音量把弧刷灭"：update() 见到 talking 为假就会清 --lvl），
    // 但 patch 里**显式**给了的就不覆盖 —— 否则 updateTile 传进来的状态会被自动值吃掉。
    var self = !!(Room && String(peer) === String(Room.peerId));
    var has = function (k) { return Object.prototype.hasOwnProperty.call(patch || {}, k) && patch[k] !== undefined; };
    if (!has('talking')) st.talking = self ? !!(Mic && Mic.speaking) : (talk ? !!talk.isTalking(peer) : false);
    if (!has('level')) st.level = self ? 0 : (talk ? talk.level(peer) : 0);
    if (!has('micLevel') && self) st.micLevel = st.level;
    try { rec.tile.update(st); } catch (_) {}
    return true;
  }
  /** 某个 uid 的音量/屏蔽变了 → 把登记过的卡片都刷一遍（tile 自己的滑块不会自刷胶囊） */
  function refreshTilesForUid(uid) {
    var u = String(uid);
    for (var peer in tiles) {
      if (!Object.prototype.hasOwnProperty.call(tiles, peer)) continue;
      if (String(peer).split('.')[0] !== u) continue;
      var slow = { volume: desk.volume(u), blocked: desk.isBlocked(u), ceiling: desk.ceiling() };
      // 0.3.1 接线补：慢字段必须写回 base。否则说话电平每 50 ms 一次的 pushTile 会用 renderTiles 时的旧 base
      // （volume=100）把卡片刷回去 —— 实测：对方说话时拖 TA 的音量，胶囊/滑块被弹回 100%。
      var rec0 = tiles[peer];
      if (rec0) for (var sk in slow) if (Object.prototype.hasOwnProperty.call(slow, sk)) rec0.base[sk] = slow[sk];
      pushTile(peer, slow);
    }
  }
  function applyTalk(peer, talking) {
    if (pushTile(peer, { talking: !!talking, level: talking ? (talk ? talk.level(peer) : 0) : 0 })) return;
    if (Room && typeof Room.setSpeaking === 'function') { try { Room.setSpeaking(peer, talking); } catch (_) {} return; }
    var c = cardOf(peer);                       // 单测/无 Room 时的兜底
    if (c) c.classList.toggle('speaking', !!talking);
  }
  /** 电平写进 --lvl，弧长由 CSS 读（tile 路径由 update() 内部写） */
  function applyLevel(peer, level) {
    if (pushTile(peer, { level: Math.max(0, Math.min(1, Number(level) || 0)) })) return;
    var c = cardOf(peer);
    if (!c) return;
    c.style.setProperty('--lvl', Math.max(0, Math.min(1, Number(level) || 0)).toFixed(3));
  }
  function unfollowTalk(peer) {
    if (!talk || !peer) return;
    applyTalk(peer, false);
    try { talk.unfollow(peer); } catch (_) {}
  }
  /** 自己那张卡的电平：直接读 0.3.0 已有的 Mic.db（它每 20 ms 更新一次） */
  var stageTick = 0;
  function tickSelf() {
    // 麦克风重启/换设备后 Mic.track 会变成新轨，这里让它自愈（非 100% 时才真的做事）
    if (++stageTick % 20 === 0 && stage) syncInputStage();
    if (!Mic || !Room || !Room.peerId) return;
    var muted = Mic.muted || Mic.deafened;
    var db = typeof Mic.db === 'number' ? Mic.db : -90;
    var lvl = muted ? 0 : Math.max(0, Math.min(100, (db + 70) / 60 * 100)) / 100;
    // tile 路径：把自己的电平喂给 update（它同时负责 --lvl 与输入电平条）
    if (pushTile(Room.peerId, {
      micLevel: lvl, level: lvl,
      talking: !muted && !!Mic.speaking,
      selfMuted: !!Mic.muted, deafened: !!Mic.deafened,
    })) return;
    applyLevel(Room.peerId, lvl);
  }

  var wire = {
    ready: false,
    get mode() { return desk ? desk.mode : 'element'; },
    get ctx() { return ctx; },
    get desk() { return desk; },

    /** renderer.js 末尾调用一次：把它的 S / save / Room / Mic 交进来 */
    init: function (opts) {
      if (wire.ready) return wire;
      opts = opts || {};
      if (!B.bindPrefs) throw new Error('FongBasic.bindPrefs 缺失，请检查打包入口是否导出了它');
      S = opts.S; save = opts.save; Room = opts.Room || null; Mic = opts.Mic || null;
      api = typeof opts.api === 'function' ? opts.api : null;
      if (typeof opts.talkNow === 'function') clock = opts.talkNow;
      desk = B.createVoiceDesk({
        prefs: B.bindPrefs(S, save),
        audioContext: PLAY_CTX,
        // 只刷已登记的卡片（走 tile.update，不重建节点），绝不回调 renderMembers
        onChange: function (kind, uid) {
          if (kind === 'all' || kind === 'person') refreshTilesForUid(kind === 'all' ? uid : uid);
        },
      });
      if (opts.spk) { lastSink = opts.spk; }
      // 启动时把已保存的扬声器也路由到播放 ctx（0.3.1 接线补）：
      // 接管后 <audio> 被静音、声音只从 ctx 出；不在这里切，重启后房间声音会走系统默认设备，
      // 直到用户在设置里再选一次扬声器（原 780 行只给 <audio> 切 sink，对 ctx 无效）。
      if (opts.spk && opts.spk !== 'default') {
        try { var rt = wire.routeTo(String(opts.spk)); if (rt && rt.catch) rt.catch(function () {}); } catch (_) {}
      }
      wire.ready = true;
      // 给根节点打标记：fong-arc.css 的所有规则都限定在 .fong-wire-on 下，
      // 这样接线层没起来时 0.3.0 原有的说话指示完全不受影响（不给降级路径留坑）
      try { document.documentElement.classList.add('fong-wire-on'); } catch (_) {}
      // 自己卡的电平：50 ms 一次（与远端检测同频）
      if (!selfTimer && talk && typeof setInterval === 'function') selfTimer = setInterval(tickSelf, 50);
      // 调音台入口 + 输入级：init 之后再挂，避免模块没起来就动 DOM
      // 挂载点都兜底：拿不到所需的 DOM 就安静跳过，不能让初始化失败
      try { wire.mountMixer(); } catch (e) { try { console.warn('[fong-wire] 调音台挂载失败', e); } catch (_) {} }
      try { wire.mountLoginGate(); } catch (e) { try { console.warn('[fong-wire] 登录门挂载失败', e); } catch (_) {} }
      syncInputStage();
      return wire;
    },

    /** 每个人的实际增益（给测试/调试面板用） */
    gainFor: function (uid) { return desk ? desk.gainFor(uid) : null; },
    laneList: function () { return desk ? desk.laneList() : []; },
    /** 当前路径下每人滑块的真实上限：200（WebAudio）或 100（降级） */
    ceiling: function () { return desk ? desk.ceiling() : 100; },
    volume: function (uid) { return desk ? desk.volume(uid) : 100; },
    /** @returns {number} 整理后的音量（可能被吸附到 100） */
    setVolume: function (uid, v, dragging) {
      if (!desk) return 100;
      return desk.setVolume(uid, v, { dragging: !!dragging });
    },
    nudge: function (uid, deltaY, fine) {
      if (!desk) return 100;
      return desk.nudge(uid, deltaY, { fine: !!fine });
    },
    /** 音量条的两段轨背景（0–100 原声段 / 100–200 增益段） */
    paint: function (value, ceiling) {
      return B.trackPaint ? B.trackPaint(value, ceiling) : '';
    },
    // ---------- 登录门：验证码模式 ----------
    /** 当前是不是验证码模式（renderer 的页签焦点逻辑要用） */
    loginGateIsCode: function () { return !!(gate && gate.mode === 'code'); },
    /** renderLoginGate() 末尾调用：按模式显示/隐藏验证码行与密码行 */
    loginGateMode: function (mode) { return loginGateMode(mode); },
    mountLoginGate: function () { return mountLoginGate(); },
    /** 剩余冷却秒数（测试/诊断用） */
    loginGateCooldown: function () { return gate ? gate.cd : 0; },
    /** 手动走一格倒计时（测试用，免得真等 60 秒） */
    loginGateTick: function () { return tickCd(); },
    /** 手动发码（等价于点 #lgSendBtn） */
    loginGateSend: function () { return sendCode(); },

    // ---------- 调音台（③） ----------
    /** 提示音增益 0–1，供 0.3.0 的 sfx() 缩放峰值（不新增第二套提示音） */
    cueGain: function () { return desk ? Math.max(0, Math.min(1, desk.cue() / 100)) : 1; },
    /** 当前麦克风走的是不是"输入级增益轨"（诊断/测试用） */
    inputStageOn: function () { return !!stage; },
    syncInputStage: syncInputStage,
    mountMixer: function () {
      if (mixer) return mixer;
      // 挂不上要留痕：静默失败是这一轮反复踩到的坑
      try { mixer = buildMixer(); } catch (e) { mixer = null; try { console.warn('[fong-wire] 调音台挂载失败', e); } catch (_) {} }
      return mixer;
    },
    get mixerEl() { return mixer ? mixer.panel : null; },

    // ---------- 成员卡（②） ----------
    get tilesReady() { return !!(B.buildTile && desk); },
    /** 接线层当前登记的卡片数（诊断用） */
    tileCount: function () { return Object.keys(tiles).length; },

    /**
     * 用 fong-tile 渲染整个成员网格（② 成员卡换代）。
     * @param {{box:HTMLElement, list:Array, me?:boolean, onMenu?:Function, onProfile?:Function, stateOf?:Function}} o
     *   stateOf(m, me) 返回该成员的慢字段（badges / 音量 / 闭听…），由 renderer 提供
     */
    renderTiles: function (o) {
      if (!wire.tilesReady || !o || !o.box) return false;
      var doc = o.doc || document;
      tiles = {};                                  // 每次重绘重建登记表，天然清掉离场的人
      o.box.innerHTML = '';
      o.box.classList.add('fong-tiles');
      var list = o.list || [];
      // 【0.4.10 · 审查 P1-1】var 在函数作用域里只有一个绑定，循环结束后所有
      // onMenu/onProfile 闭包共享最后一个 m —— 右键任何成员都会操作到列表末位的人。
      for (var i = 0; i < list.length; i++) {
        let m = list[i];
        var me = !!m.__me;
        var uid = String(m.id != null ? m.id : (m.peer || '').split('.')[0]);
        var who = {
          peer: String(m.peer || ''),
          uid: uid,
          name: m.name || '',
          avatar: m.avatar || '',
          role: m.role || 'member',
          me: me,
        };
        var built = null;
        try {
          built = B.buildTile(doc, who, desk, {
            onMenu: o.onMenu ? function (w, e) { o.onMenu(m, e); } : null,
            onProfile: o.onProfile ? function (w) { o.onProfile(m); } : null,
          });
        } catch (_) { built = null; }
        if (!built) continue;
        tiles[who.peer] = {
          tile: built,
          base: Object.assign({ volume: desk.volume(uid), ceiling: desk.ceiling(), blocked: desk.isBlocked(uid) },
                              o.stateOf ? (o.stateOf(m, me) || {}) : {}),
        };
        o.box.appendChild(built.root);
      }
      // 首帧：把当前说话态/电平也刷一遍，避免重绘后弧闪一下
      for (var p in tiles) if (Object.prototype.hasOwnProperty.call(tiles, p)) {
        pushTile(p, {});   // pushTile 内部会按"是不是自己"取正确的说话态
      }
      return true;
    },
    /** 只推某人的慢字段（音量/屏蔽/闭听变化时用），随后立刻重算快字段 */
    updateTile: function (peer, patch) {
      var rec = tiles[String(peer)];
      if (!rec) return false;
      patch = patch || {};
      for (var k in patch) if (Object.prototype.hasOwnProperty.call(patch, k)) rec.base[k] = patch[k];
      // 原样透传 patch：pushTile 只给"没显式给"的字段补自动值。
      // （早先在这里显式塞 talk 算出来的 talking/level，会把调用方给的状态顶掉）
      return pushTile(peer, patch);
    },
    clearTiles: function () { tiles = {}; },
    /** 音量/屏蔽变了之后手动刷（renderer 在菜单里改 S.localMute 之后调） */
    refreshTiles: function (uid) { if (desk) refreshTilesForUid(uid); },

    // ---------- 说话态 API ----------
    get talkReady() { return !!(talk && talk.supported); },
    talkIsTalking: function (peer) { return talk ? talk.isTalking(peer) : false; },
    talkLevel: function (peer) { return talk ? talk.level(peer) : 0; },
    talkList: function () { return talk ? talk.talkingList() : []; },
    /** 直接喂电平：测试、或外壳侧已算好电平时用 */
    talkFeed: function (peer, db, at) { if (talk) talk.feed(peer, db, at === undefined ? clock() : at); },
    talkNow: function () { return clock(); },
    tickSelf: tickSelf,
    talkStopAll: function () { wire.clearLanes(); },

    /** 闪避系数（0–1）。renderer 的 routeVolumes 走 sync()，这里给 UI/测试直接调。 */
    duckTo: function (g) {
      if (!desk) return;
      lastDuck = Number.isFinite(g) ? g : 1;
      desk.duckTo(lastDuck);
    },
    /** 闭听（总输出整路静音） */
    setDeaf: function (on) {
      if (!desk) return;
      lastDeaf = !!on;
      desk.setDeaf(lastDeaf);
    },
    notice: function () { return desk ? desk.notice() : null; },

    isBlocked: function (uid) { return desk ? desk.isBlocked(uid) : false; },
    toggleBlock: function (uid) { return desk ? desk.toggleBlock(uid) : false; },
    output: function () { return desk ? desk.output() : 100; },
    setOutput: function (v) { return desk ? desk.setOutput(v) : 100; },

    // ---------- 声道 ----------
    /** 远端 track 接入时调用。mid 是仝用的 lane key（audios 的 key），uid 可后补 */
    addLane: function (peer, el, stream, uid) {
      if (!desk) return null;
      resume();
      return desk.addLane({ peer: String(peer), el: el, stream: stream, uid: uid != null ? String(uid) : undefined });
    },
    removeLane: function (peer) { return desk ? desk.removeLane(String(peer)) : false; },
    /** 【0.4.12】对端重连后的新 track 流重绑（旧 lane 的 source 已哑） */
    rebindStream: function (peer, stream) { return desk ? desk.rebindStream(String(peer), stream) : false; },
    clearLanes: function () {
      tiles = {};
      if (desk) desk.clearLanes();
      Object.keys(followed).forEach(function (k) { unfollowTalk(followed[k]); });
      followed = {};
      if (talk) { try { talk.stopAll(); } catch (_) {} }
    },

    /**
     * 由 Room.applyVolumes() 调用：把 renderer 的状态同步进调音台。
     * 顺序要紧：先把 peer→uid 映射对齐，再推闪避/闭听（后两者会全量重算）。
     */
    sync: function (room, mic) {
      if (!desk || !room || !room.audios) return;
      var seen = {};
      room.audios.forEach(function (a, mid) {
        var key = String(mid);
        seen[key] = 1;
        var uid = a && a.peer ? String(a.peer).split('.')[0] : null;
        if (uid) desk.rebindLane(key, uid);
        else desk.removeLane(key);
        // 说话检测：按 peer 跟（卡片 data-peer 是 peer，不是 mid）
        if (talk && a && a.peer) {
          var want = String(a.peer);
          if (followed[key] !== want) {
            if (followed[key]) unfollowTalk(followed[key]);
            var st = a.audio && a.audio.srcObject;
            var tr = st && st.getAudioTracks ? st.getAudioTracks()[0] : null;
            try { talk.follow(want, tr); } catch (_) {}
            followed[key] = want;
          }
        } else if (followed[key]) {
          unfollowTalk(followed[key]); delete followed[key];
        }
      });
      // mid 已经不在了 → 停掉对应的检测
      Object.keys(followed).forEach(function (k) {
        if (!seen[k]) { unfollowTalk(followed[k]); delete followed[k]; }
      });
      // 清掉 renderer 里已经不存在的 lane（离房/换房）
      desk.laneList().forEach(function (l) {
        if (!seen[l.peer]) desk.removeLane(l.peer);
      });
      // 只在变化时推，避免 20 ms 节拍上反复全量重算
      var g = mic && Number.isFinite(mic.duckGain) ? mic.duckGain : 1;
      if (g !== lastDuck) { lastDuck = g; desk.duckTo(g); }
      var d = !!(mic && mic.deafened);
      if (d !== lastDeaf) { lastDeaf = d; desk.setDeaf(d); }
    },

    /**
     * 切输出设备。WebAudio 模式下声音从 ctx 出，必须切 ctx.setSinkId；
     * 同时给每个 lane 的 <audio> 也切一遍（降级路径与设备路由仍需要）。
     * @returns {Promise<boolean>} 是否是 WebAudio 路径
     */
    routeTo: function (id) {
      if (!desk) return Promise.resolve(true);
      lastSink = id || '';
      // 串行化：上一次切换没结束就不发下一次（并发 setSinkId 是 ctx 卡在 suspended 的诱因），每次切完都确认 running
      var target = id === 'default' ? '' : (id || '');
      sinkChain = sinkChain.then(function () { return desk.routeTo(target); })
        .then(function (r) { resume(); return r; }, function () { resume(); return false; });
      return sinkChain;
    },
    currentSink: function () { return lastSink; },
  };

  // ---------- 麦克风输入级 ----------
  // 100% 时完全不介入（不插节点、不动音轨），与 fong-input 的旁路约定一致。
  // 非 100% 时在**降噪之后**插一级增益（所以从 Mic.track 取源，而不是 rawTrack），
  // 并强制单声道，避免 MediaStreamDestination 默认双声道破坏"人声走单声道"的约定。
  function syncInputStage() {
    if (!desk || !B.createInputStage || !Mic || !Mic.track) return false;
    var pct = desk.input();
    if (pct === 100) {
      if (stage) {
        try { stage.close(); } catch (_) {}
        if (Mic.track === stage.track) {
          Mic.track = stageFrom;
          if (Mic.sender) Mic.sender.replaceTrack(stageFrom).catch(function () {});
        }
        stage = null; stageFrom = null;
      }
      return false;
    }
    if (stage && Mic.track === stage.track) { stage.setPct(pct); return true; }
    if (stage) { try { stage.close(); } catch (_) {} stage = null; }
    stageFrom = Mic.track;
    stage = B.createInputStage({ audioContext: ctx, track: stageFrom, pct: pct });
    if (stage.bypassed) { stage = null; stageFrom = null; return false; }
    Mic.track = stage.track;                       // 噪声门与发送都跟着走新轨
    if (Mic.sender) Mic.sender.replaceTrack(stage.track).catch(function () {});
    return true;
  }

  // ---------- 调音台 ----------
  // 入口：底栏 #spkCtl 里、#spkSel 前面插一个按钮（不改 index.html）。
  // 三条：总输出 / 麦克风输入 / 提示音。提示音走 0.3.0 现有的 sfx()（缩放峰值），
  // 不新增第二套提示音。
  function buildMixer() {
    if (!desk) return null;                       // 没 desk 就一个字节都别碰 DOM
    if (!hasDom()) return null;
    var bar = document.getElementById('spkCtl');
    if (!bar) return null;
    // 可重入：先把可能残留的旧按钮摘掉。
    //（踩过：早期版本先插按钮再抛异常，残留 #mixBtn 让后续挂载永远被拒）
    var stale = document.getElementById('mixBtn');
    if (stale && stale.parentNode && stale.parentNode.removeChild) stale.parentNode.removeChild(stale);
    var btn = document.createElement('button');
    btn.id = 'mixBtn';
    btn.className = 'icon-btn';
    btn.type = 'button';
    btn.setAttribute('aria-label', '调音台');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<svg aria-hidden="true"><use href="#i-volume"/></svg>';
    var sel = document.getElementById('spkSel');
    if (sel) bar.insertBefore(btn, sel); else bar.appendChild(btn);

    var panel = document.createElement('div');
    panel.className = 'fong-mixer';
    panel.hidden = true;
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', '调音台');
    var h = document.createElement('h4');
    h.textContent = '调音台';
    panel.appendChild(h);

    function row(label, key, max, get, set) {
      var r = document.createElement('div');
      r.className = 'fong-mix-row';
      var l = document.createElement('label');
      l.textContent = label;
      l.htmlFor = 'mix_' + key;
      var inp = document.createElement('input');
      inp.id = 'mix_' + key;
      inp.className = 'fong-range';
      inp.type = 'range'; inp.min = '0'; inp.max = String(max); inp.step = '1';
      inp.value = String(get());
      var out = document.createElement('output');
      out.textContent = get() + '%';
      inp.oninput = function () {
        var v = set(+inp.value);
        inp.value = String(v);
        out.textContent = v + '%';
      };
      r.appendChild(l); r.appendChild(inp); r.appendChild(out);
      panel.appendChild(r);
      return { inp: inp, out: out, get: get };
    }

    var rows = [
      row('总输出', 'out', 100, function () { return desk.output(); }, function (v) { return desk.setOutput(v); }),
      row('麦克风输入', 'in', 200, function () { return desk.input(); }, function (v) { var r = desk.setInput(v); syncInputStage(); return r; }),
      row('提示音', 'cue', 100, function () { return desk.cue(); }, function (v) { return desk.setCue(v); }),
    ];
    var hint = document.createElement('div');
    hint.className = 'fong-mix-hint';
    hint.textContent = '总输出影响所有人；麦克风输入 100% 时不经任何额外处理。';
    panel.appendChild(hint);
    document.body.appendChild(panel);

    function sync() {
      for (var i = 0; i < rows.length; i++) {
        var v = rows[i].get();
        rows[i].inp.value = String(v);
        rows[i].out.textContent = v + '%';
      }
    }
    function place() {
      var r = btn.getBoundingClientRect();
      panel.style.left = Math.round(Math.max(8, r.left)) + 'px';
      panel.style.bottom = Math.round(Math.max(8, window.innerHeight - r.top + 2)) + 'px';
    }
    function open(on) {
      panel.hidden = !on;
      btn.setAttribute('aria-expanded', on ? 'true' : 'false');
      if (on) { sync(); place(); }
    }
    btn.onclick = function (e) { e.stopPropagation(); open(panel.hidden); };
    document.addEventListener('click', function (e) { if (!panel.hidden && !panel.contains(e.target) && e.target !== btn) open(false); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) open(false); });
    window.addEventListener('resize', function () { if (!panel.hidden) place(); });

    return { open: open, sync: sync, panel: panel, btn: btn };
  }

  // ---------- 登录门：验证码模式 ----------
  // 只做三件事：加一个"验证码"页签对应的行、发码（带 60 s 冷却）、把模式相关的显隐管起来。
  // 提交仍然走 renderer 的 submitLoginGate()（补丁里加了一条 lgMode === 'code' 分支），
  // 所以"登录成功后换身份"那段完全复用，这里不重复实现。
  // 没有 DOM（Node 单测、或 index.html 补丁没上）时一律安静地不接管。
  // 踩过：init 里直接调 mountLoginGate() 没做防御，document 不存在就抛异常带崩整个初始化。
  function hasDom() {
    try { return typeof document !== 'undefined' && document && typeof document.getElementById === 'function'; }
    catch (_) { return false; }
  }
  function gel(id) { return hasDom() ? document.getElementById(id) : null; }

  function mountLoginGate() {
    if (gate) return gate;
    if (!hasDom()) return null;
    var tabs = gel('lgTabs'), code = gel('lgCode'), btn = gel('lgSendBtn');
    if (!tabs || !code || !btn) return null;   // index.html 补丁没上就不接管
    gate = { mode: '', cd: 0, timer: null, btn: btn, code: code };
    btn.onclick = sendCode;
    checkCodeAvailable();
    code.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); var s = gel('lgSubmit'); if (s) s.click(); }
    });
    return gate;
  }

  /** 服务端没配发信通道时，把「验证码」页签整个摘掉。 */
  var codeChecked = false;
  function checkCodeAvailable() {
    if (!api || codeChecked) return;
    codeChecked = true;
    try {
      var p = api('GET', '/api/auth/code/available');
      if (p && p.then) p.then(function (r) {
        if (r && r.available === false) hideCodeTab();
      }).catch(function () {});
    } catch (_) {}
  }

  function hideCodeTab() {
    var tabs = gel('lgTabs');
    if (!tabs || !tabs.querySelector) return;
    var b = tabs.querySelector('[data-lg="code"]');
    if (b && b.parentNode) b.parentNode.removeChild(b);
    if (gate && gate.mode === 'code') loginGateMode('login');
  }

  function loginGateMode(mode) {
    if (!gate) { try { mountLoginGate(); } catch (_) { gate = null; } }
    if (!gate) return false;
    checkCodeAvailable();   // 登录门每次渲染都确认一次（首次挂载时 api 可能还没就绪）
    gate.mode = mode || '';
    var isCode = gate.mode === 'code';
    var wrap = gel('lgCodeWrap');
    var pass = gel('lgPass');
    var passLabel = pass && pass.closest ? pass.closest('label') : null;
    if (wrap) wrap.classList.toggle('hidden', !isCode);
    if (gate.btn) gate.btn.classList.toggle('hidden', !isCode);
    if (passLabel) passLabel.classList.toggle('hidden', isCode);
    if (isCode) {
      var sub = gel('lgSub');
      if (sub) sub.textContent = '填邮箱，收 6 位验证码就能进，不用记密码。';
      tickCd();
    }
    return isCode;
  }

  function startCd(sec) {
    if (!gate) return;
    gate.cd = sec > 0 ? sec : 60;
    if (gate.timer) clearInterval(gate.timer);
    gate.btn.disabled = true;
    tickCd();
    gate.timer = setInterval(tickCd, 1000);
  }

  /** 走一秒；归零就解锁按钮。测试直接调它，免得真等。 */
  function tickCd() {
    if (!gate || !gate.btn) return gate ? gate.cd : 0;
    if (gate.cd > 0) {
      gate.btn.textContent = gate.cd + ' 秒后可重发';
      gate.btn.disabled = true;
      gate.cd--;
    } else {
      gate.btn.textContent = '获取验证码';
      gate.btn.disabled = false;
      if (gate.timer) { clearInterval(gate.timer); gate.timer = null; }
    }
    return gate.cd;
  }

  function gateMsg(text) { var m = gel('lgMsg'); if (m) m.textContent = text; }

  function sendCode() {
    if (!gate) mountLoginGate();
    var emailEl = gel('lgEmail');
    var email = emailEl ? String(emailEl.value || '').trim() : '';
    if (!email) { gateMsg('先填邮箱'); return false; }
    // 与 renderer 的 normEmailInput 同口径：不填 @ 就当 QQ 号
    if (email.indexOf('@') < 0) email = email + '@qq.com';
    if (!api) { gateMsg('发不了验证码：接线层没拿到 api()'); return false; }
    if (gate.btn) gate.btn.disabled = true;
    gateMsg('正在发送…');
    Promise.resolve()
      .then(function () { return api('POST', '/api/auth/code/send', { email: email }); })
      .then(function (r) {
        startCd(r && r.cooldown ? r.cooldown : 60);
        gateMsg('验证码已发出，10 分钟内有效');
        if (gate.code) gate.code.focus();
      })
      .catch(function (e) {
        // 429 会带 retryAfter：用它接着倒计时，别让用户白等
        var ra = e && e.retryAfter ? e.retryAfter : 0;
        if (ra > 0) { startCd(ra); gateMsg((e && e.message) || '发送太频繁，请稍后再试'); return; }
        if (gate.btn) gate.btn.disabled = false;
        gateMsg(reasonText(e) || (e && e.message) || '发送失败，稍后再试');
      });
    return true;
  }

  /** 401 的 reason → 文案；非 401 返回空串 */
  function reasonText(e) {
    if (!e || e.status !== 401) return '';
    if (e.reason === 'evicted') return '这台设备已被移出登录，请重新登录';
    if (e.reason === 'password') return '密码已修改，请重新登录';
    return '登录状态已失效，请重新登录';
  }
  wire.reasonText = reasonText;

  window.FongWire = wire;
})();
