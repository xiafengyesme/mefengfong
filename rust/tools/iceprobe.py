"""探测公网 ICE：候选类型、连接路径、是否走 TURN"""
import json, os, time
from playwright.sync_api import sync_playwright
URL = os.environ.get("FONG_URL", "https://8.156.40.211:8443/")
with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--ignore-certificate-errors", "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--use-file-for-fake-audio-capture=H:/fongmuisc/fong/server/web/fake_voice.wav",
        "--autoplay-policy=no-user-gesture-required", "--no-sandbox"])
    ctx = b.new_context(permissions=["microphone"]); p = ctx.new_page()
    p.goto(URL); p.fill("#peer","ICE"); p.fill("#room","ice"); p.click("#join")
    time.sleep(6)
    info = p.evaluate("""async () => {
      const pc = window.__pc; if (!pc) return {err:'no pc'};
      const s = await pc.getStats(); const out = {local:[], remote:[], pair:null, transport:null};
      s.forEach(r => {
        if (r.type==='local-candidate') out.local.push(r.candidateType+':'+r.address+':'+r.port+'/'+r.protocol);
        if (r.type==='remote-candidate') out.remote.push(r.candidateType+':'+r.address+':'+r.port+'/'+r.protocol);
        if (r.type==='candidate-pair' && r.state==='succeeded' && r.nominated) {
          out.pair = {rtt:r.currentRoundTripTime, bytesSent:r.bytesSent, bytesRecv:r.bytesRecv,
                      localId:r.localCandidateId, remoteId:r.remoteCandidateId};
        }
      });
      return out;
    }""")
    print(json.dumps(info, indent=1, ensure_ascii=False))
    b.close()
