import time
from playwright.sync_api import sync_playwright
import os
URL=os.environ.get("FONG_URL","http://127.0.0.1:8080/")
with sync_playwright() as pw:
    b=pw.chromium.launch(args=["--use-fake-ui-for-media-stream","--use-fake-device-for-media-stream",
        "--use-file-for-fake-audio-capture=H:/fongmuisc/fong/server/web/fake_voice.wav",
        "--autoplay-policy=no-user-gesture-required","--no-sandbox"])
    ctx=b.new_context(permissions=["microphone"]); p=ctx.new_page()
    p.on("console", lambda m: print("[console]",m.type,m.text))
    p.on("pageerror", lambda e: print("[pageerror]", e))
    p.on("requestfailed", lambda r: print("[reqfail]", r.url, r.failure))
    p.on("response", lambda r: print("[resp]", r.status, r.url) if "/signal" in r.url or "/answer" in r.url else None)
    p.goto(URL); p.fill("#peer","DIAG"); p.fill("#room","autotest")
    print("--- click join ---")
    p.click("#join")
    time.sleep(6)
    print("--- stats ---", p.evaluate("window.__stats"))
    print("--- log ---"); print(p.inner_text("#log"))
    b.close()
