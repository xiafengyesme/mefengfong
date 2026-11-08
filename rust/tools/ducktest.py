"""验证 Ducking：A 说话时，A 端收到的对端音量应降到 -10dB（0.316）"""
import os, time
from playwright.sync_api import sync_playwright
URL = os.environ.get("FONG_URL", "https://8.156.40.211:8443/")
WAV = "H:/fongmuisc/fong/server/web/fake_voice.wav"
def mk(pw,n):
    b=pw.chromium.launch(args=["--ignore-certificate-errors","--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",f"--use-file-for-fake-audio-capture={WAV}",
      "--autoplay-policy=no-user-gesture-required","--no-sandbox","--mute-audio"])
    c=b.new_context(permissions=["microphone"]); p=c.new_page()
    p.on("pageerror", lambda e: print("[ERR]",e))
    p.goto(URL); p.fill("#peer",n); p.fill("#room","duck"); return b,p
with sync_playwright() as pw:
    ba,pa=mk(pw,"DA"); pa.click("#join"); time.sleep(3)
    bb,pb=mk(pw,"DB"); pb.click("#join"); time.sleep(6)
    print("A duck 设置:", pa.evaluate("() => ({enabled: Gate.duckEnabled, db: Gate.duckDb})"))
    for i in range(8):
        st=pa.evaluate("window.__stats")
        vol=pa.evaluate("() => Array.from(document.querySelectorAll('audio')).map(a=>Math.round(a.volume*100)/100)")
        print(f"  micDb={st['micDb']:7.1f} open={st['gateOpen']} duckGain={st['duckGain']} audioVol={vol}")
        time.sleep(0.7)
    b_close = (ba.close(), bb.close())
