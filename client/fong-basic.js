var FongBasic = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index-src.js
  var index_src_exports = {};
  __export(index_src_exports, {
    DESK: () => DESK,
    bindPrefs: () => bindPrefs,
    buildTile: () => buildTile,
    chipFor: () => chipFor,
    createInputStage: () => createInputStage,
    createPrefs: () => createPrefs,
    createTalkWatch: () => createTalkWatch,
    createVoiceDesk: () => createVoiceDesk,
    mixGain: () => mixGain,
    playCue: () => playCue,
    pullHome: () => pullHome,
    tidyPct: () => tidyPct,
    trackPaint: () => trackPaint
  });

  // src/fong-prefs.js
  var DEFAULT_KEY = "fong2";
  function createPrefs({ storage = safeLocalStorage(), key = DEFAULT_KEY } = {}) {
    let mem = {};
    let healthy = !!storage;
    try {
      const raw = storage ? storage.getItem(key) : null;
      if (raw) mem = JSON.parse(raw) || {};
      if (typeof mem !== "object" || Array.isArray(mem)) mem = {};
    } catch (_) {
      healthy = false;
      mem = {};
    }
    const persist = () => {
      if (!storage) return false;
      try {
        let base = {};
        try {
          base = JSON.parse(storage.getItem(key) || "{}") || {};
        } catch (_) {
          base = {};
        }
        storage.setItem(key, JSON.stringify(Object.assign(base, mem)));
        healthy = true;
        return true;
      } catch (_) {
        healthy = false;
        return false;
      }
    };
    return {
      read(field, fallback) {
        return field in mem ? mem[field] : fallback;
      },
      write(field, value) {
        mem[field] = value;
        return persist();
      },
      get healthy() {
        return healthy;
      }
    };
  }
  function bindPrefs(obj, save) {
    return {
      read(field, fallback) {
        return obj[field] === void 0 ? fallback : obj[field];
      },
      write(field, value) {
        obj[field] = value;
        try {
          save && save();
          return true;
        } catch (_) {
          return false;
        }
      },
      get healthy() {
        return true;
      }
    };
  }
  function safeLocalStorage() {
    try {
      return typeof localStorage !== "undefined" ? localStorage : null;
    } catch (_) {
      return null;
    }
  }

  // src/fong-desk.js
  var DESK = Object.freeze({
    personMax: 200,
    // 每人上限 %
    personDefault: 100,
    outputMax: 100,
    // 总输出上限 %
    outputDefault: 100,
    inputMax: 200,
    // 麦克风输入 %
    inputDefault: 100,
    // FONG 默认开 AGC，输入不预加增益
    cueMax: 100,
    // 提示音 %
    cueDefault: 30,
    gainCeiling: 2,
    homeValue: 100,
    // “原声”刻度
    homeRadius: 3,
    // 拖动时距 100 在 ±3 以内吸到 100（闭区间）
    wheelStep: 5,
    wheelFine: 1,
    smoothSec: 0.015
    // setTargetAtTime 时间常数（≈1.5 个 10 ms 帧）
  });
  var toInt = (v) => {
    const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? Math.round(n) : null;
  };
  var between = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function tidyPct(v, max) {
    const n = toInt(v);
    return n === null ? null : between(n, 0, max);
  }
  function pullHome(v, dragging, max = DESK.personMax) {
    const n = tidyPct(v, max);
    if (n === null) return null;
    if (dragging && max >= DESK.homeValue && Math.abs(n - DESK.homeValue) <= DESK.homeRadius) return DESK.homeValue;
    return n;
  }
  function mixGain(outputPct, personPct, duck, silent) {
    if (silent) return 0;
    const g = outputPct / 100 * (personPct / 100) * (Number.isFinite(duck) ? duck : 1);
    return between(Number.isFinite(g) ? g : 0, 0, DESK.gainCeiling);
  }
  function createVoiceDesk({ prefs, audioContext = null, onChange = null } = {}) {
    if (!prefs) throw new Error("createVoiceDesk \u9700\u8981 prefs");
    const ctx = audioContext;
    const lanes = /* @__PURE__ */ new Map();
    let duck = 1;
    let deaf = false;
    let sinkId = "";
    const personMap = () => Object.assign({}, prefs.read("memberVol", {}));
    const blockMap = () => Object.assign({}, prefs.read("localMute", {}));
    const desk = {
      get mode() {
        return ctx ? "webaudio" : "element";
      },
      /** 当前路径下每人滑块的真实上限 */
      ceiling() {
        return ctx ? DESK.personMax : 100;
      },
      // ---------- 每人 ----------
      volume(uid) {
        const v = personMap()[key(uid)];
        const n = tidyPct(v, DESK.personMax);
        return n === null ? DESK.personDefault : n;
      },
      setVolume(uid, v, { dragging = false } = {}) {
        const next = pullHome(v, dragging, desk.ceiling());
        if (next === null) return desk.volume(uid);
        const m = personMap();
        if (next === DESK.personDefault) delete m[key(uid)];
        else m[key(uid)] = next;
        prefs.write("memberVol", m);
        if (desk.isBlocked(uid)) desk.block(uid, false, true);
        refresh(uid);
        return next;
      },
      nudge(uid, deltaY, { fine = false } = {}) {
        if (!deltaY) return desk.volume(uid);
        const step = fine ? DESK.wheelFine : DESK.wheelStep;
        return desk.setVolume(uid, desk.volume(uid) + (deltaY < 0 ? step : -step));
      },
      resetVolume(uid) {
        return desk.setVolume(uid, DESK.personDefault);
      },
      isBlocked(uid) {
        return !!blockMap()[key(uid)];
      },
      block(uid, on, quiet) {
        const m = blockMap();
        if (on) m[key(uid)] = true;
        else delete m[key(uid)];
        prefs.write("localMute", m);
        if (!quiet) refresh(uid);
        return !!on;
      },
      /** 喇叭按钮：屏蔽 ↔ 恢复；若没屏蔽但音量被拖到 0，则直接恢复到 100。 */
      toggleBlock(uid) {
        if (desk.isBlocked(uid)) return desk.block(uid, false);
        if (desk.volume(uid) === 0) {
          desk.setVolume(uid, DESK.personDefault);
          return false;
        }
        return desk.block(uid, true);
      },
      // ---------- 全局 ----------
      output() {
        const n = tidyPct(prefs.read("outVol", DESK.outputDefault), DESK.outputMax);
        return n === null ? DESK.outputDefault : n;
      },
      setOutput(v) {
        const n = tidyPct(v, DESK.outputMax);
        if (n !== null) {
          prefs.write("outVol", n);
          refreshAll();
        }
        return desk.output();
      },
      input() {
        const n = tidyPct(prefs.read("inVol", DESK.inputDefault), DESK.inputMax);
        return n === null ? DESK.inputDefault : n;
      },
      setInput(v) {
        const n = tidyPct(v, DESK.inputMax);
        if (n !== null) {
          prefs.write("inVol", n);
          emit("input", null);
        }
        return desk.input();
      },
      cue() {
        const n = tidyPct(prefs.read("cueVol", DESK.cueDefault), DESK.cueMax);
        return n === null ? DESK.cueDefault : n;
      },
      setCue(v) {
        const n = tidyPct(v, DESK.cueMax);
        if (n !== null) {
          prefs.write("cueVol", n);
          emit("cue", null);
        }
        return desk.cue();
      },
      duckTo(g) {
        const n = Number(g);
        duck = Number.isFinite(n) ? between(n, 0, 1) : 1;
        refreshAll();
      },
      setDeaf(on) {
        deaf = !!on;
        refreshAll();
      },
      /** 全局提示（只在房间头部出一条，不在每张卡上重复） */
      notice() {
        if (deaf) return { tone: "off", text: "\u5DF2\u95ED\u542C" };
        if (desk.output() === 0) return { tone: "warn", text: "\u603B\u8F93\u51FA 0%" };
        return null;
      },
      /** 某人当前实际增益（给测试、调试面板用） */
      gainFor(uid) {
        return mixGain(desk.output(), desk.volume(uid), duck, deaf || desk.isBlocked(uid));
      },
      // ---------- 声道 ----------
      /**
       * @param {{peer:string, uid?:string, el?:HTMLMediaElement, track?:MediaStreamTrack, stream?:MediaStream}} p
       */
      addLane(p) {
        const peer = String(p.peer);
        if (lanes.has(peer)) desk.removeLane(peer);
        const lane = { peer, uid: p.uid != null ? String(p.uid) : peer, el: p.el || null, node: null, src: null, broken: false };
        const stream = p.stream || (p.track && typeof MediaStream !== "undefined" ? new MediaStream([p.track]) : null);
        if (ctx && stream) {
          try {
            lane.src = ctx.createMediaStreamSource(stream);
            lane.node = ctx.createGain();
            lane.node.gain.value = 0;
            lane.src.connect(lane.node);
            lane.node.connect(ctx.destination);
            if (lane.el) {
              lane.el.muted = true;
            }
          } catch (_) {
            lane.src = lane.node = null;
          }
        }
        if (lane.el && sinkId && !ctx && lane.el.setSinkId) lane.el.setSinkId(sinkId).catch(() => {
        });
        lanes.set(peer, lane);
        apply(lane);
        return lane;
      },
      rebindLane(peer, uid) {
        const l = lanes.get(String(peer));
        if (l) {
          l.uid = String(uid);
          apply(l);
        }
      },
      // 【0.4.12】对端重连后 msid 变，Chromium 会生成新的 track 对象，旧 MediaStreamSource 已哑。
      // 只换 uid 的 rebindLane 救不了，必须拿新流重建 source → gain 这一段。
      rebindStream(peer, stream) {
        const l = lanes.get(String(peer));
        if (!l || !ctx || !stream) return false;
        try { l.src && l.src.disconnect(); } catch (_) {}
        try {
          l.src = ctx.createMediaStreamSource(stream);
          l.src.connect(l.node);
          l.broken = false;
        } catch (_) {
          l.src = null;
          l.broken = true;
          return false;
        }
        return true;
      },
      removeLane(peer) {
        const l = lanes.get(String(peer));
        if (!l) return false;
        try {
          l.src && l.src.disconnect();
        } catch (_) {
        }
        try {
          l.node && l.node.disconnect();
        } catch (_) {
        }
        lanes.delete(String(peer));
        return true;
      },
      clearLanes() {
        for (const p of [...lanes.keys()]) desk.removeLane(p);
      },
      laneList() {
        return [...lanes.values()].map((l) => ({
          peer: l.peer,
          uid: l.uid,
          volume: desk.volume(l.uid),
          blocked: desk.isBlocked(l.uid),
          gain: desk.gainFor(l.uid),
          path: l.node ? "gain" : "element",
          broken: l.broken
        }));
      },
      /** 切输出设备。WebAudio 模式下声音从 AudioContext 出，要切的是 context 的 sink。 */
      async routeTo(id) {
        sinkId = id || "";
        const jobs = [];
        if (ctx && typeof ctx.setSinkId === "function") jobs.push(ctx.setSinkId(sinkId).catch(() => false));
        for (const l of lanes.values()) if (l.el && l.el.setSinkId) jobs.push(l.el.setSinkId(sinkId).catch(() => false));
        await Promise.all(jobs);
        return ctx ? typeof ctx.setSinkId === "function" : true;
      }
    };
    function key(uid) {
      return String(uid);
    }
    function apply(lane) {
      const g = desk.gainFor(lane.uid);
      try {
        if (lane.node) {
          const param = lane.node.gain;
          if (ctx && typeof param.setTargetAtTime === "function") param.setTargetAtTime(g, ctx.currentTime || 0, DESK.smoothSec);
          else param.value = g;
        } else if (lane.el) {
          lane.el.volume = between(g, 0, 1);
          lane.el.muted = g === 0;
        }
        lane.broken = false;
      } catch (_) {
        lane.broken = true;
      }
    }
    function refresh(uid) {
      for (const l of lanes.values()) if (l.uid === key(uid)) apply(l);
      emit("person", key(uid));
    }
    function refreshAll() {
      for (const l of lanes.values()) apply(l);
      emit("all", null);
    }
    function emit(kind, uid) {
      if (onChange) {
        try {
          onChange(kind, uid);
        } catch (_) {
        }
      }
    }
    return desk;
  }

  // src/fong-face.js
  var FACE_TONES = Object.freeze([
    { bg: "#1E2127", fg: "#E8EAED" },
    // 石墨（FONG 默认的 bg-hover）
    { bg: "#262F14", fg: "#D7FF3A" },
    // 荧光绿暗调（品牌色）
    { bg: "#16282E", fg: "#8FD3E6" },
    // 冷青
    { bg: "#2A1F31", fg: "#D6B4EA" },
    // 雾紫（只作头像底色，不做渐变）
    { bg: "#30251A", fg: "#EBC48E" },
    // 琥珀
    { bg: "#182A22", fg: "#93DDB8" }
    // 松绿
  ]);
  var FACE_RULES = Object.freeze({
    types: ["image/png", "image/jpeg", "image/webp", "image/gif"],
    maxSourceBytes: 12 * 1024 * 1024,
    // 原图上限沿用 0.3.0：本地会重绘压缩，原图大一点无妨
    minSide: 64,
    // 成员卡头像 88 px，低于 64 放大后发糊
    outSide: 256,
    // 重绘输出边长
    maxOutBytes: 32 * 1024
    // 0.3.0 现有 /api/me/avatar 的单张上限
  });
  function toneIndex(uid) {
    const s = String(uid == null ? "" : uid);
    let h = 7;
    for (let i = 0; i < s.length; i++) h = Math.imul(h, 31) + s.charCodeAt(i) | 0;
    return Math.abs(h) % FACE_TONES.length;
  }
  function initialOf(name, uid) {
    const s = String(name || uid || "").trim();
    if (!s) return "?";
    const ch = Array.from(s)[0];
    return /[a-z]/.test(ch) ? ch.toUpperCase() : ch;
  }
  var esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function faceDataUri(uid, name) {
    const t = FACE_TONES[toneIndex(uid)];
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><circle cx="48" cy="48" r="48" fill="${t.bg}"/><text x="48" y="50" dominant-baseline="central" text-anchor="middle" font-size="40" font-weight="700" font-family="Segoe UI,Microsoft YaHei UI,PingFang SC,Noto Sans SC,sans-serif" fill="${t.fg}">${esc(initialOf(name, uid))}</text></svg>`;
    return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  }
  function setFace(img, { uid, name, url }) {
    const safe = typeof url === "string" && /^(https:|data:image\/(png|jpeg|webp|gif);)/i.test(url);
    img.dataset.fallen = "";
    img.onerror = () => {
      if (img.dataset.fallen === "1") {
        img.onerror = null;
        return;
      }
      img.dataset.fallen = "1";
      img.src = faceDataUri(uid, name);
    };
    img.src = safe ? url : faceDataUri(uid, name);
    return safe;
  }

  // src/fong-tile.js
  var SVG_NS = "http://www.w3.org/2000/svg";
  var ICONS = {
    vol: "M11 5 6 9H3v6h3l5 4V5z M15.5 8.5a5 5 0 0 1 0 7 M18.5 6a8.5 8.5 0 0 1 0 12",
    volX: "M11 5 6 9H3v6h3l5 4V5z M22 9l-6 6 M16 9l6 6",
    mic: "M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z M19 10v2a7 7 0 0 1-14 0v-2 M12 19v3",
    micOff: "M2 2l20 20 M18.9 13.6A7 7 0 0 0 19 12v-2 M5 10v2a7 7 0 0 0 12 5 M15 9.3V5a3 3 0 0 0-5.7-1.3 M9 9v3a3 3 0 0 0 5.1 2.1 M12 19v3",
    headOff: "M2 2l20 20 M21 15v-3a9 9 0 0 0-14.2-7.3 M3 12v6a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3 M21 18a2 2 0 0 1-2 2h-1",
    shield: "M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z",
    crown: "M2 7l5 5 5-8 5 8 5-5-2 12H4L2 7z"
  };
  function icon(doc, name) {
    const s = doc.createElementNS ? doc.createElementNS(SVG_NS, "svg") : doc.createElement("svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.setAttribute("aria-hidden", "true");
    const p = doc.createElementNS ? doc.createElementNS(SVG_NS, "path") : doc.createElement("path");
    p.setAttribute("d", ICONS[name]);
    s.appendChild(p);
    return s;
  }
  function node(doc, tag, cls, text) {
    const e = doc.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }
  function trackPaint(value, ceiling) {
    const pos = value / ceiling * 100;
    const knee = Math.min(100, 100 / ceiling * 100);
    const a = Math.min(pos, knee).toFixed(2);
    if (pos <= knee) return `linear-gradient(to right, var(--text-primary,#E8EAED) 0 ${a}%, var(--bg-hover,#1E2127) ${a}% 100%)`;
    return `linear-gradient(to right, var(--text-primary,#E8EAED) 0 ${knee.toFixed(2)}%, var(--accent,#D7FF3A) ${knee.toFixed(2)}% ${pos.toFixed(2)}%, var(--bg-hover,#1E2127) ${pos.toFixed(2)}% 100%)`;
  }
  function chipFor({ volume, blocked }) {
    if (blocked) return { text: "\u5DF2\u5C4F\u853D", tone: "off" };
    if (volume > 100) return { text: volume + "%", tone: "boost" };
    if (volume < 100) return { text: volume + "%", tone: "cut" };
    return { text: "100%", tone: "home" };
  }
  function buildTile(doc, who, desk, hooks = {}) {
    const root = node(doc, "div", "fong-tile" + (who.me ? " me" : ""));
    root.setAttribute("role", "listitem");
    root.dataset.peer = who.peer;
    root.dataset.uid = who.uid;
    const face = node(doc, "div", "fong-face");
    const arc = node(doc, "i", "fong-arc");
    const img = doc.createElement("img");
    img.alt = "";
    img.className = "fong-av";
    setFace(img, { uid: who.uid, name: who.name, url: who.avatar });
    const badges = node(doc, "div", "fong-badges");
    face.appendChild(arc);
    face.appendChild(img);
    face.appendChild(badges);
    face.tabIndex = 0;
    face.setAttribute("aria-label", (who.name || "\u6210\u5458") + " \u7684\u8D44\u6599");
    face.onclick = () => {
      // 自己的头像点一下就能换（设置里那个入口太深，很多人找不到）
      if (who.me && typeof window.openAvatarDialog === "function") { window.openAvatarDialog(); return; }
      hooks.onProfile && hooks.onProfile(who);
    };
    face.title = who.me ? "点击换头像" : (who.name || "");
    root.appendChild(face);
    const nameRow = node(doc, "div", "fong-name");
    if (who.role === "owner") {
      const c = icon(doc, "crown");
      c.setAttribute("class", "fong-crown");
      nameRow.appendChild(c);
    }
    const nm = node(doc, "span", "fong-nm", who.name || "\u2026");
    nm.title = who.name || "";
    nameRow.appendChild(nm);
    const bars = node(doc, "span", "fong-bars");
    bars.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) bars.appendChild(node(doc, "b"));
    nameRow.appendChild(bars);
    if (who.me) nameRow.appendChild(node(doc, "span", "fong-you", "\u6211"));
    root.appendChild(nameRow);
    const note = node(doc, "div", "fong-note");
    note.setAttribute("aria-live", "polite");
    root.appendChild(note);
    let range = null, chip = null, mute = null, row = null, selfBar = null, selfIcon = null;
    if (who.me) {
      row = node(doc, "div", "fong-vol self");
      row.title = "\u6211\u7684\u9EA6\u514B\u98CE\u7535\u5E73";
      selfIcon = node(doc, "span", "fong-self-ic");
      const meter = node(doc, "div", "fong-self-meter");
      selfBar = node(doc, "i");
      meter.appendChild(selfBar);
      row.appendChild(selfIcon);
      row.appendChild(meter);
      // 【UI-2】原来 append 的是写死「输入」两个字的 chip：
      //     node(doc, "span", "fong-chip home", "\u8F93\u5165")
      // 想表达"输入电平 100%"，但没数值没单位；.fong-chip 有 min-width:44px
      // 加圆角背景，看起来就像一个空输入框 —— 用户箭头指的就是它。
      // 电平条已经表达了信息，这里改成"原声"（默认 100% 不加增益）。
      const selfChip = node(doc, "span", "fong-chip home", "\u539F\u58F0");
      selfChip.title = "\u9EA6\u514B\u98CE\u8F93\u5165\u7535\u5E73\uFF1A\u539F\u58F0\uFF08\u4E0D\u9884\u52A0\u589E\u76CA\uFF09";
      row.appendChild(selfChip);
      root.appendChild(row);
    }
    if (!who.me && desk) {
      row = node(doc, "div", "fong-vol");
      mute = node(doc, "button", "fong-mute");
      mute.type = "button";
      mute.onclick = () => {
        desk.toggleBlock(who.uid);
      };
      range = doc.createElement("input");
      range.type = "range";
      range.min = "0";
      range.step = "1";
      range.className = "fong-range";
      range.setAttribute("aria-label", (who.name || "\u6210\u5458") + " \u7684\u97F3\u91CF");
      range.oninput = () => desk.setVolume(who.uid, range.value, { dragging: true });
      range.onchange = () => desk.setVolume(who.uid, range.value, { dragging: false });
      range.ondblclick = () => desk.resetVolume(who.uid);
      range.onwheel = (e) => {
        e.preventDefault && e.preventDefault();
        desk.nudge(who.uid, e.deltaY, { fine: !!e.shiftKey });
      };
      range.onkeydown = (e) => {
        if (e.key === "PageUp" || e.key === "PageDown") {
          e.preventDefault && e.preventDefault();
          desk.setVolume(who.uid, desk.volume(who.uid) + (e.key === "PageUp" ? 10 : -10));
        }
        if (e.key === "Home" && e.altKey) desk.resetVolume(who.uid);
      };
      chip = node(doc, "span", "fong-chip");
      row.appendChild(mute);
      row.appendChild(range);
      row.appendChild(chip);
      root.appendChild(row);
      root.oncontextmenu = (e) => {
        if (hooks.onMenu) {
          e.preventDefault && e.preventDefault();
          hooks.onMenu(who, e);
        }
      };
    }
    function update(st = {}) {
      const blocked = !!st.blocked;
      const talking = !!st.talking;
      root.classList.toggle("talking", talking);
      root.classList.toggle("blocked", blocked);
      root.classList.toggle("silenced", !!(st.selfMuted || st.serverMuted));
      root.style.setProperty("--lvl", String(talking ? Math.max(0, Math.min(1, st.level || 0)) : 0));
      badges.textContent = "";
      const addBadge = (name, cls, title) => {
        const b = node(doc, "span", cls);
        b.title = title;
        b.appendChild(icon(doc, name));
        badges.appendChild(b);
      };
      if (st.serverMuted) addBadge("shield", "srv", "\u88AB\u7BA1\u7406\u5458\u9759\u97F3");
      if (st.selfMuted) addBadge("micOff", "", "\u5DF2\u9759\u97F3");
      if (st.deafened) addBadge("headOff", "", "\u5DF2\u95ED\u542C");
      let text = "";
      if (talking && blocked) text = "\u5728\u8BF4\u8BDD \xB7 \u4F60\u5DF2\u5C4F\u853D";
      else if (st.serverMuted) text = "\u88AB\u7BA1\u7406\u5458\u9759\u97F3";
      note.textContent = text;
      note.className = "fong-note" + (text ? " on" : "");
      if (selfBar) {
        const off = !!(st.selfMuted || st.deafened);
        selfBar.style.width = (off ? 0 : Math.round((st.micLevel != null ? st.micLevel : talking ? st.level || 0 : 0) * 100)) + "%";
        selfBar.className = talking && !off ? "over" : "";
        selfIcon.textContent = "";
        selfIcon.appendChild(icon(doc, off ? "micOff" : "mic"));
        selfIcon.classList.toggle("off", off);
      }
      if (range) {
        const ceiling = st.ceiling || DESK.personMax;
        const v = Math.min(st.volume == null ? 100 : st.volume, ceiling);
        range.max = String(ceiling);
        range.value = String(v);
        range.style.background = trackPaint(v, ceiling);
        row.style.setProperty("--knee-ratio", (100 / ceiling).toFixed(4));
        row.classList.toggle("flat", ceiling <= 100);
        range.setAttribute("aria-valuetext", blocked ? "\u5DF2\u5C4F\u853D" : v + "%");
        const c = chipFor({ volume: v, blocked });
        chip.textContent = c.text;
        chip.className = "fong-chip " + c.tone;
        mute.textContent = "";
        mute.appendChild(icon(doc, blocked ? "volX" : "vol"));
        mute.setAttribute("aria-label", blocked ? `\u6062\u590D ${who.name} \u7684\u58F0\u97F3` : `\u5C4F\u853D ${who.name}\uFF08\u53EA\u5BF9\u6211\uFF09`);
        mute.setAttribute("aria-pressed", blocked ? "true" : "false");
        row.title = ceiling === 100 ? "\u5F53\u524D\u73AF\u5883\u4E0D\u652F\u6301\u8D85\u8FC7 100%" : "\u62D6\u52A8\u8C03\u8282 \xB7 \u6EDA\u8F6E \xB15 \xB7 Shift+\u6EDA\u8F6E \xB11 \xB7 \u53CC\u51FB\u56DE\u5230 100%";
      }
    }
    return { root, update, img };
  }

  // src/fong-talk.js
  var TALK = Object.freeze({
    floorDb: -50,
    // 远端门限：发送端已经过噪声门，静音段本来就不发包，所以比本地门限（-42）放宽 8 dB
    topDb: -6,
    // 电平映射到声线环满圈的上沿（正常说话约落在 6–8 成弧长，留出强弱差）
    holdMs: 240,
    // 与 FONG 本地噪声门的保持时长同一口径，句尾不掉环
    everyMs: 50,
    // 刷新周期；加上 hold 起点即刻生效，感知延迟 ≈ 50 ms + 分析窗
    fftSize: 1024,
    smoothing: 0.3
  });
  function rmsDb(buf) {
    if (!buf || !buf.length) return -120;
    let s = 0;
    for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
    return 20 * Math.log10(Math.sqrt(s / buf.length) + 1e-9);
  }
  function talkStep(prev, db, now, cfg = TALK) {
    const until = db > cfg.floorDb ? now + cfg.holdMs : prev ? prev.until : 0;
    const talking = now < until;
    const raw = (db - cfg.floorDb) / (cfg.topDb - cfg.floorDb);
    const level = talking ? Math.min(1, Math.max(0.18, raw)) : 0;
    return { until, talking, level, db };
  }
  function createTalkWatch({ audioContext = null, onTalk = null, onLevel = null, now = () => Date.now(), cfg = TALK } = {}) {
    const ctx = audioContext;
    const supported = !!(ctx && typeof ctx.createAnalyser === "function");
    const peers = /* @__PURE__ */ new Map();
    let handle = null;
    const watch = {
      get supported() {
        return supported;
      },
      follow(peer, track) {
        peer = String(peer);
        watch.unfollow(peer);
        const entry = { an: null, buf: null, src: null, track: null, state: { until: 0, talking: false, level: 0, db: -120 } };
        if (supported && track && track.kind === "audio" && typeof MediaStream !== "undefined") {
          try {
            entry.track = typeof track.clone === "function" ? track.clone() : track;
            entry.src = ctx.createMediaStreamSource(new MediaStream([entry.track]));
            entry.an = ctx.createAnalyser();
            entry.an.fftSize = cfg.fftSize;
            entry.an.smoothingTimeConstant = cfg.smoothing;
            entry.src.connect(entry.an);
            entry.buf = new Float32Array(entry.an.fftSize);
          } catch (_) {
            entry.an = null;
          }
        }
        peers.set(peer, entry);
        if (entry.an && !handle) start();
        return !!entry.an;
      },
      unfollow(peer) {
        const e = peers.get(String(peer));
        if (!e) return;
        try {
          e.src && e.src.disconnect();
        } catch (_) {
        }
        try {
          e.track && e.track !== null && e.track.stop && e.track.stop();
        } catch (_) {
        }
        peers.delete(String(peer));
        if (![...peers.values()].some((x) => x.an)) stop();
      },
      /** 直接喂电平（测试、演示页、或外壳侧已算好电平时用） */
      feed(peer, db, at = now()) {
        peer = String(peer);
        if (!peers.has(peer)) peers.set(peer, { an: null, state: { until: 0, talking: false, level: 0, db: -120 } });
        update(peer, peers.get(peer), db, at);
      },
      isTalking(peer) {
        const e = peers.get(String(peer));
        return !!(e && e.state.talking);
      },
      level(peer) {
        const e = peers.get(String(peer));
        return e ? e.state.level : 0;
      },
      talkingList() {
        return [...peers.entries()].filter(([, e]) => e.state.talking).map(([p]) => p);
      },
      stopAll() {
        for (const p of [...peers.keys()]) watch.unfollow(p);
        stop();
      }
    };
    function update(peer, e, db, at) {
      const was = e.state.talking;
      e.state = talkStep(e.state, db, at, cfg);
      if (onLevel) {
        try {
          onLevel(peer, e.state.level);
        } catch (_) {
        }
      }
      if (was !== e.state.talking && onTalk) {
        try {
          onTalk(peer, e.state.talking);
        } catch (_) {
        }
      }
    }
    function tick() {
      const at = now();
      for (const [peer, e] of peers) {
        if (!e.an) continue;
        try {
          e.an.getFloatTimeDomainData(e.buf);
          update(peer, e, rmsDb(e.buf), at);
        } catch (_) {
        }
      }
    }
    function start() {
      if (typeof setInterval === "function") handle = setInterval(tick, cfg.everyMs);
    }
    function stop() {
      if (handle) {
        clearInterval(handle);
        handle = null;
      }
    }
    if (ctx && ctx.state === "suspended" && typeof document !== "undefined") {
      const wake = () => {
        ctx.resume && ctx.resume().catch(() => {
        });
      };
      document.addEventListener("pointerdown", wake, { once: true });
    }
    return watch;
  }

  // src/fong-input.js
  function createInputStage({ audioContext, track, pct = 100 }) {
    const ctx = audioContext;
    const bypass = { track, bypassed: true, setPct() {
      return false;
    }, close() {
    } };
    if (!ctx || !track || pct === 100) return bypass;
    try {
      const src = ctx.createMediaStreamSource(new MediaStream([track]));
      const gain = ctx.createGain();
      const dst = ctx.createMediaStreamDestination();
      for (const n of [gain, dst]) {
        n.channelCount = 1;
        n.channelCountMode = "explicit";
        n.channelInterpretation = "speakers";
      }
      gain.gain.value = Math.max(0, Math.min(2, pct / 100));
      src.connect(gain);
      gain.connect(dst);
      const out = dst.stream.getAudioTracks()[0];
      return {
        track: out,
        bypassed: false,
        setPct(p) {
          gain.gain.setTargetAtTime(Math.max(0, Math.min(2, p / 100)), ctx.currentTime || 0, 0.015);
          return true;
        },
        close() {
          try {
            src.disconnect();
            gain.disconnect();
          } catch (_) {
          }
          try {
            out.stop();
          } catch (_) {
          }
        }
      };
    } catch (_) {
      return bypass;
    }
  }
  var CUES = {
    join: [[660, 0], [880, 0.08]],
    leave: [[880, 0], [587, 0.08]],
    mute: [[440, 0]],
    unmute: [[660, 0]]
  };
  function playCue(audioContext, kind, pct) {
    const ctx = audioContext;
    const notes = CUES[kind];
    if (!ctx || !notes || !(pct > 0)) return false;
    try {
      const t0 = ctx.currentTime || 0;
      const peak = 0.25 * Math.min(1, pct / 100);
      for (const [hz, at] of notes) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = "sine";
        o.frequency.value = hz;
        g.gain.setValueAtTime(0, t0 + at);
        g.gain.linearRampToValueAtTime(peak, t0 + at + 0.01);
        g.gain.exponentialRampToValueAtTime(1e-4, t0 + at + 0.12);
        o.connect(g);
        g.connect(ctx.destination);
        o.start(t0 + at);
        o.stop(t0 + at + 0.14);
      }
      return true;
    } catch (_) {
      return false;
    }
  }
  return __toCommonJS(index_src_exports);
})();
