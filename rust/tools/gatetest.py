"""验证语音门：静音段 track.enabled 应为 false，发声段为 true"""
import os, time, json
from playwright.sync_api import sync_playwright
URL = os.environ.get("FONG_URL", "https://8.156.40.211:8443/")
with sync_playwright() as pw:
    b=pw.chromium.launch(args=["--ignore-certificate-errors","--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      "--use-file-for-fake-audio-capture=H:/fongmuisc/fong/server/web/fake_voice.wav",
      "--autoplay-policy=no-user-gesture-required","--no-sandbox","--mute-audio"])
    ctx=b.new_context(permissions=["microphone"]); p=ctx.new_page()
    p.on("pageerror", lambda e: print("[ERR]", e))
    p.on("console", lambda m: print("[console]",m.type,m.text) if m.type=="error" else None)
    p.goto(URL); p.fill("#peer","G"); p.fill("#room","gate"); p.click("#join")
    time.sleep(3)
    print("--- 采样门状态 ---")
    for i in range(6):
        st = p.evaluate("window.__stats")
        te = p.evaluate("() => { const s=window.__pc.getSenders().find(x=>x.track); return s? s.track.enabled : null }")
        print(f"  micDb={st['micDb']:7.1f}  gateOpen={st['gateOpen']}  trackEnabled={te}")
        time.sleep(1)
    print("--- UI ---")
    print("gateState:", p.inner_text("#gateState"))
    print("log:", p.inner_text("#log")[-300:])
    b.close()
