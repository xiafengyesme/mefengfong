import json, os, time
from playwright.sync_api import sync_playwright
URL = os.environ.get("FONG_URL", "https://8.156.40.211:8443/")
js = open(os.path.join(os.path.dirname(__file__), "sdpprobe.js"), encoding="utf8").read()
with sync_playwright() as pw:
    b = pw.chromium.launch(args=["--ignore-certificate-errors","--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--use-file-for-fake-audio-capture=H:/fongmuisc/fong/server/web/fake_voice.wav",
        "--autoplay-policy=no-user-gesture-required","--no-sandbox"])
    ctx=b.new_context(permissions=["microphone"]); p=ctx.new_page()
    p.goto(URL); p.fill("#peer","SDP"); p.fill("#room","sdp"); p.click("#join")
    time.sleep(6)
    print(json.dumps(p.evaluate(js), indent=1, ensure_ascii=False))
    b.close()
