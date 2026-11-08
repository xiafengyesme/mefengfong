"""端到端音质测量：A 播 tts_clean.wav -> 服务端转发 -> B 录制 -> 与原文件比 PESQ。
这是唯一可信的「我们的链路到底损伤多少」的测量。"""
import base64, os, time, json
from playwright.sync_api import sync_playwright

URL = os.environ.get("FONG_URL", "https://8.156.40.211:8443/")
WAV = "H:/fongmuisc/fong/server/web/fake_voice.wav"
OUT = "H:/fongmuisc/work/out/e2e_recv.webm"

REC_JS = """
async () => {
  const pc = window.__pc;
  if (!pc) return {err: 'no pc'};
  const recv = pc.getReceivers().find(r => r.track && r.track.kind === 'audio');
  if (!recv) return {err: 'no receiver'};
  const ms = new MediaStream([recv.track]);
  const rec = new MediaRecorder(ms, {mimeType: 'audio/webm;codecs=opus', audioBitsPerSecond: 256000});
  window.__chunks = [];
  rec.ondataavailable = e => { if (e.data.size) window.__chunks.push(e.data); };
  rec.start(200);
  window.__rec = rec;
  return {ok: true};
}
"""

STOP_JS = """
async () => {
  if (!window.__rec) return {err: 'not recording'};
  const rec = window.__rec;
  await new Promise(r => { rec.onstop = r; rec.stop(); });
  const blob = new Blob(window.__chunks, {type: 'audio/webm'});
  const buf = await blob.arrayBuffer();
  let bin = ''; const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return {b64: btoa(bin), size: bytes.length};
}
"""

def mk(pw, name, room):
    b = pw.chromium.launch(args=["--ignore-certificate-errors","--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream", f"--use-file-for-fake-audio-capture={WAV}",
        "--autoplay-policy=no-user-gesture-required","--no-sandbox", "--mute-audio"])
    ctx = b.new_context(permissions=["microphone"]); p = ctx.new_page()
    p.goto(URL); p.fill("#peer", name); p.fill("#room", room)
    return b, p

with sync_playwright() as pw:
    ba, pa = mk(pw, "QA", "qual"); pa.click("#join"); time.sleep(3)
    bb, pb = mk(pw, "QB", "qual"); pb.click("#join"); time.sleep(6)
    print("A stats:", json.dumps(pa.evaluate("window.__stats")))
    print("B stats:", json.dumps(pb.evaluate("window.__stats")))
    print("B rec:", json.dumps(pb.evaluate(REC_JS)))
    time.sleep(6)
    res = pb.evaluate(STOP_JS)
    if "b64" in res:
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        open(OUT, "wb").write(base64.b64decode(res["b64"]))
        print("saved", OUT, res["size"], "bytes")
    else:
        print("record failed:", res)
    ba.close(); bb.close()
