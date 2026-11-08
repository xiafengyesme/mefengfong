"""双无头浏览器互连：假麦克风 + 真实 WebRTC，测通人数/码率/丢包/延迟"""
import json, sys, time
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8080/"

def make(pw, name):
    b = pw.chromium.launch(args=[
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture=H:/fongmuisc/fong/server/web/fake_voice.wav",
        "--autoplay-policy=no-user-gesture-required",
        "--no-sandbox",
    ])
    ctx = b.new_context(permissions=["microphone"])
    page = ctx.new_page()
    page.on("console", lambda m: print(f"[{name}] {m.text}"))
    page.goto(URL)
    page.fill("#peer", name)
    page.fill("#room", "autotest")
    return b, page

def main():
    with sync_playwright() as pw:
        b1, p1 = make(pw, "P1")
        b2, p2 = make(pw, "P2")
        p1.click("#join"); time.sleep(2)
        p2.click("#join"); time.sleep(4)
        for i in range(3):
            time.sleep(2)
            for tag, p in (("P1", p1), ("P2", p2)):
                st = p.evaluate("window.__stats")
                print(f"{tag} {json.dumps(st)}")
        for tag, p in (("P1", p1), ("P2", p2)):
            print(f"--- {tag} log ---")
            print(p.inner_text("#log")[-800:])
        b1.close(); b2.close()

main()
