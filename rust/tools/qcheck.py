import os, time, json
from playwright.sync_api import sync_playwright
URL = os.environ.get("FONG_URL","https://8.156.40.211:8443/")
with sync_playwright() as pw:
    b=pw.chromium.launch(args=["--ignore-certificate-errors","--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream","--use-file-for-fake-audio-capture=H:/fongmuisc/fong/server/web/fake_voice.wav",
      "--autoplay-policy=no-user-gesture-required","--no-sandbox"])
    ctx=b.new_context(permissions=["microphone"]); p=ctx.new_page()
    p.on("pageerror", lambda e: print("[pageerror]", e))
    p.on("console", lambda m: print("[console]", m.type, m.text))
    p.goto(URL); p.fill("#peer","Q"); p.fill("#room","q"); p.click("#join")
    time.sleep(6)
    print("--- log ---"); print(p.inner_text("#log"))
    print("--- stats ---", json.dumps(p.evaluate("window.__stats")))
    b.close()
