"""决定性测试：A 播 1kHz，B 播 4kHz。
若 B 听到 1kHz，说明 A 的音频被回送到 A（回声循环）。
同时统计 B 收到的每个 track 的主导频率，判断是否同一条轨被播放两遍。"""
import os, time, json
from playwright.sync_api import sync_playwright
URL = os.environ.get("FONG_URL", "https://8.156.40.211:8443/")
A = "H:/fongmuisc/fong/server/web/tone_a.wav"
B = "H:/fongmuisc/fong/server/web/tone_b.wav"

ANALYZE = """
async () => {
  const out = [];
  const audios = Array.from(document.querySelectorAll('audio'));
  for (const a of audios) {
    const actx = new AudioContext({sampleRate: 48000});
    const src = actx.createMediaStreamSource(a.srcObject);
    const an = actx.createAnalyser(); an.fftSize = 4096;
    src.connect(an);
    await new Promise(r => setTimeout(r, 600));
    const buf = new Float32Array(an.fftSize);
    an.getFloatTimeDomainData(buf);
    // 简易 Goertzel 检测 1k / 4k
    const sr = actx.sampleRate;
    const mag = (f) => {
      const w = 2*Math.PI*f/sr, c = 2*Math.cos(w);
      let s0=0,s1=0,s2=0;
      for (let i=0;i<buf.length;i++){ s0 = buf[i] + c*s1 - s2; s2=s1; s1=s0; }
      return Math.sqrt(s1*s1 + s2*s2 - c*s1*s2) / buf.length;
    };
    out.push({track: a.dataset.track, m1k: mag(1000), m4k: mag(4000), rms: Math.sqrt(buf.reduce((s,v)=>s+v*v,0)/buf.length)});
    actx.close();
  }
  return out;
}
"""

def mk(pw, name, wav):
    b = pw.chromium.launch(args=["--ignore-certificate-errors","--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={wav}",
        "--autoplay-policy=no-user-gesture-required","--no-sandbox","--mute-audio"])
    ctx=b.new_context(permissions=["microphone"]); p=ctx.new_page()
    p.goto(URL); p.fill("#peer",name); p.fill("#room","loop"); return b,p

with sync_playwright() as pw:
    ba,pa = mk(pw,"A1K",A); pa.click("#join"); time.sleep(3)
    bb,pb = mk(pw,"B4K",B); pb.click("#join"); time.sleep(7)
    print("=== A 端（发 1kHz）收到的 ===")
    print(json.dumps(pa.evaluate(ANALYZE), indent=1))
    print("=== B 端（发 4kHz）收到的 ===")
    print(json.dumps(pb.evaluate(ANALYZE), indent=1))
    ba.close(); bb.close()
