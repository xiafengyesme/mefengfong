const $ = (id) => document.getElementById(id);
const log = (m) => { const el = $('log'); el.textContent += m + "\n"; el.scrollTop = el.scrollHeight; };
const CRLF = String.fromCharCode(13, 10);

const peerID = String(Math.floor(Math.random() * 9000) + 1000);
$('peer').value = peerID;

let pc, localStream, eventsAbort;
const remoteEls = [];   // 所有对端 <audio>，用于 Ducking

window.__stats = { joined: false, remoteTracks: 0, bytesRecv: 0, bytesSent: 0,
  packetsLost: 0, jitter: 0, rtt: 0, codec: '', txKbps: 0,
  micDb: -90, gateOpen: false, duckGain: 1 };

const QUALITY = {
  voice: { kbps: 48, label: 'voice 48k' },
  high:  { kbps: 96, label: 'high 96k' },
  ultra: { kbps: 128, label: 'ultra 128k' },
  music: { kbps: 256, label: 'music 256k' },
  max:   { kbps: 320, label: 'max 320k' },
};

// 只改 opus 的 fmtp 行，绝不动 rtpmap
function tuneOpusFmtp(sdp, kbps) {
  const extra = 'maxaveragebitrate=' + (kbps * 1000)
    + ';stereo=0;sprop-stereo=0;usedtx=0;useinbandfec=1';
  const lines = sdp.split(CRLF);
  let pt = null;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^a=rtpmap:(\d+) opus\/48000\/\d$/i);
    if (m) { pt = m[1]; break; }
  }
  if (pt === null) return sdp;
  const prefix = 'a=fmtp:' + pt + ' ';
  let patched = false;
  const out = lines.map((l) => {
    if (l.indexOf(prefix) !== 0) return l;
    patched = true;
    const kept = l.slice(prefix.length).split(';')
      .filter((kv) => kv && !/^maxaveragebitrate=/i.test(kv) && !/^stereo=/i.test(kv))
      .join(';');
    return prefix + kept + ';' + extra;
  });
  if (!patched) {
    const idx = out.findIndex((l) => l.indexOf('a=rtpmap:' + pt + ' ') === 0);
    out.splice(idx + 1, 0, prefix + extra);
  }
  return out.join(CRLF);
}

// ---------- 语音检测 + Ducking ----------
// Volume Gate：不说话就不发 RTP，键盘声传不出去
// Ducking（TS3 的「回声抑制[闪避]」）：自己一说话，对方音量降 N dB，切断声学回路
const Gate = {
  actx: null, src: null, an: null, buf: null, track: null, timer: null,
  thrDb: -42, enabled: true, open: false, holdMs: 0, holdMax: 220,
  duckEnabled: false, duckDb: -10, duckGain: 1, duckTarget: 1,

  init(track) {
    this.track = track;
    this.actx = new AudioContext({ sampleRate: 48000 });
    const clone = track.clone();
    this.src = this.actx.createMediaStreamSource(new MediaStream([clone]));
    this.an = this.actx.createAnalyser();
    this.an.fftSize = 1024;
    this.an.smoothingTimeConstant = 0.3;
    this.src.connect(this.an);   // 只连 analyser，不连 destination
    this.buf = new Float32Array(this.an.fftSize);
    this.tick();
  },

  levelDb(buf) {
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
    const rms = Math.sqrt(sum / buf.length);
    return 20 * Math.log10(rms + 1e-9);
  },

  applyDuck() {
    // 平滑过渡，避免"抽吸感"
    const diff = this.duckTarget - this.duckGain;
    if (Math.abs(diff) < 0.01) {
      this.duckGain = this.duckTarget;
    } else {
      this.duckGain += diff * 0.25;     // ~4 帧收敛
    }
    window.__stats.duckGain = Math.round(this.duckGain * 100) / 100;
    for (let i = 0; i < remoteEls.length; i++) {
      remoteEls[i].volume = Math.max(0, Math.min(1, this.duckGain));
    }
  },

  tick() {
    if (!this.an) return;
    this.an.getFloatTimeDomainData(this.buf);
    const d = this.levelDb(this.buf);
    window.__stats.micDb = Math.round(d * 10) / 10;

    if (this.enabled && d > this.thrDb) {
      this.holdMs = this.holdMax;
      this.open = true;
    } else if (this.holdMs > 0) {
      this.holdMs -= 20;
      this.open = true;
    } else {
      this.open = false;
    }
    if (this.track) this.track.enabled = this.enabled ? this.open : true;
    window.__stats.gateOpen = this.open;

    // Ducking 判定
    if (this.duckEnabled) {
      this.duckTarget = this.open ? Math.pow(10, this.duckDb / 20) : 1;
    } else {
      this.duckTarget = 1;
    }
    this.applyDuck();

    // UI
    const meter = $('meter');
    if (meter) meter.style.width = Math.max(0, Math.min(100, (d + 70) / 60 * 100)) + '%';
    const mark = $('thrMark');
    if (mark) mark.style.left = Math.max(0, Math.min(100, (this.thrDb + 70) / 60 * 100)) + '%';
    const gs = $('gateState');
    if (gs) {
      if (!this.enabled) { gs.textContent = '旁路'; gs.className = ''; }
      else if (this.open) { gs.textContent = '发声'; gs.className = 'open'; }
      else { gs.textContent = '静音'; gs.className = ''; }
    }
    this.timer = setTimeout(() => this.tick(), 20);
  },

  stop() {
    if (this.timer) clearTimeout(this.timer);
    if (this.actx) { try { this.actx.close(); } catch (e) {} }
    this.an = null; this.actx = null;
  }
};

async function join() {
  const room = $('room').value.trim() || 'test';
  const quality = QUALITY[$('quality').value] || QUALITY.high;

  const audioConstraints = {
    channelCount: 1,
    sampleRate: 48000,
    echoCancellation: $('aec').checked,
    noiseSuppression: $('ns').checked,
    autoGainControl: $('agc').checked,
  };
  localStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
  const track = localStream.getAudioTracks()[0];
  const st = track.getSettings();
  log('mic: EC=' + st.echoCancellation + ' NS=' + st.noiseSuppression
      + ' AGC=' + st.autoGainControl + ' ch=' + st.channelCount + ' sr=' + st.sampleRate);

  Gate.thrDb = parseInt($('thr').value, 10);
  Gate.enabled = $('gate').checked;
  Gate.duckEnabled = $('duck').checked;
  Gate.duckDb = parseInt($('duckDb').value, 10);
  Gate.init(track);

  pc = new RTCPeerConnection({ iceServers: window.ICE_SERVERS || [] });
  window.__pc = pc;
  pc.addTransceiver(track, { direction: 'sendrecv' });

  pc.ontrack = (ev) => {
    window.__stats.remoteTracks = pc.getReceivers().length;
    log('ontrack ' + ev.track.kind + ' total=' + window.__stats.remoteTracks);
    const ms = new MediaStream([ev.track]);
    const wrap = document.createElement('div');
    wrap.className = 'remote';
    wrap.dataset.track = ev.track.id;
    const a = document.createElement('audio');
    a.autoplay = true;
    a.controls = true;
    a.srcObject = ms;
    a.volume = Gate.duckGain;
    wrap.appendChild(a);
    remoteEls.push(a);            // 登记给 Ducking 用
    $('remotes').appendChild(wrap);
  };

  const offer = await pc.createOffer();
  await pc.setLocalDescription({ type: 'offer', sdp: tuneOpusFmtp(offer.sdp, quality.kbps) });

  const resp = await fetch('/signal', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ room: room, peer: peerID, type: 'offer', sdp: pc.localDescription.sdp })
  });
  const ans = await resp.json();
  if (!ans.sdp) throw new Error('no answer: ' + JSON.stringify(ans));
  await pc.setRemoteDescription({ type: 'answer', sdp: ans.sdp });

  await tuneSender(quality.kbps);
  listenEvents(room);
  startStats();
  window.__stats.joined = true;
  log('joined room=' + room + ' quality=' + quality.label
      + ' duck=' + (Gate.duckEnabled ? Gate.duckDb + 'dB' : 'off'));
  $('join').disabled = true;
  $('leave').disabled = false;
}

async function tuneSender(kbps) {
  kbps = kbps || 96000;
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
  if (!sender) return;
  const p = sender.getParameters();
  if (!p.encodings || !p.encodings.length) p.encodings = [{}];
  p.encodings[0].maxBitrate = kbps * 1000;
  p.encodings[0].dtx = 'disabled';
  p.encodings[0].priority = 'high';
  p.encodings[0].networkPriority = 'high';
  try {
    await sender.setParameters(p);
    log('sender: maxBitrate=' + kbps + 'k dtx=off fec=on');
  } catch (e) { log('setParameters: ' + e.message); }
}

let applying = Promise.resolve();
async function handleOffer(room, sdp) {
  applying = applying.then(async () => {
    if (pc.signalingState === 'have-remote-offer') return;
    await pc.setRemoteDescription({ type: 'offer', sdp: sdp });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription({ type: 'answer', sdp: answer.sdp });
    await fetch('/answer', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: room, peer: peerID, type: 'answer', sdp: pc.localDescription.sdp })
    });
    await tuneSender();
    log('renegotiated tracks=' + pc.getReceivers().length);
  }).catch((e) => log('offer ERR ' + e.message));
  return applying;
}

function listenEvents(room) {
  eventsAbort = new AbortController();
  fetch('/events?room=' + room + '&peer=' + peerID, { signal: eventsAbort.signal })
    .then(async (r) => {
      const reader = r.body.getReader();
      const dec = new TextDecoder();
      let acc = '';
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        acc += dec.decode(chunk.value, { stream: true });
        let i;
        while ((i = acc.indexOf('\n\n')) >= 0) {
          const part = acc.slice(0, i);
          acc = acc.slice(i + 2);
          if (part.indexOf('data: ') === 0) {
            const msg = JSON.parse(part.slice(6));
            if (msg.type === 'offer') await handleOffer(room, msg.sdp);
          }
        }
      }
    }).catch(() => {});
}

let lastBytes = 0, lastTs = 0;
function startStats() {
  setInterval(async () => {
    if (!pc) return;
    const now = performance.now();
    const s = await pc.getStats();
    s.forEach((r) => {
      if (r.type === 'inbound-rtp' && r.kind === 'audio') {
        window.__stats.bytesRecv = r.bytesReceived;
        window.__stats.packetsLost = r.packetsLost;
        window.__stats.jitter = r.jitter;
      }
      if (r.type === 'outbound-rtp' && r.kind === 'audio') {
        window.__stats.bytesSent = r.bytesSent;
        if (r.codecId) { const c = s.get(r.codecId); if (c) window.__stats.codec = c.mimeType; }
      }
      if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated) {
        window.__stats.rtt = Math.round((r.currentRoundTripTime || 0) * 1000);
      }
    });
    if (lastTs && window.__stats.bytesSent > lastBytes) {
      const dt = (now - lastTs) / 1000;
      window.__stats.txKbps = Math.round((window.__stats.bytesSent - lastBytes) * 8 / dt / 1000);
    }
    lastBytes = window.__stats.bytesSent;
    lastTs = now;
  }, 500);
}

function toggleSelfMute() {
  if (!pc) return;
  const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'audio');
  if (!sender || !sender.track) return;
  sender.track.enabled = !sender.track.enabled;
  log('self mute = ' + (!sender.track.enabled));
}

function leave() {
  if (eventsAbort) eventsAbort.abort();
  Gate.stop();
  remoteEls.length = 0;
  if (pc) { pc.close(); pc = null; }
  if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
  $('remotes').innerHTML = '';
  $('join').disabled = false;
  $('leave').disabled = true;
  log('left');
}

$('join').onclick = () => join().catch((e) => log('ERR ' + e.message));
$('leave').onclick = leave;
$('selfmute').onclick = toggleSelfMute;
$('thr').oninput = () => {
  Gate.thrDb = parseInt($('thr').value, 10);
  $('thrVal').textContent = Gate.thrDb + ' dB';
};
$('gate').onchange = () => { Gate.enabled = $('gate').checked; };
$('duck').onchange = () => { Gate.duckEnabled = $('duck').checked; };
$('duckDb').oninput = () => {
  Gate.duckDb = parseInt($('duckDb').value, 10);
  $('duckDbVal').textContent = Gate.duckDb + ' dB';
};
