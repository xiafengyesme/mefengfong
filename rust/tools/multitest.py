"""N 人并发：验证 SFU 转发能力与带宽模型"""
import json, os, sys, time
from playwright.sync_api import sync_playwright

N = int(sys.argv[1]) if len(sys.argv) > 1 else 6
URL = os.environ.get("FONG_URL", "http://127.0.0.1:8080/")
WAV = "H:/fongmuisc/fong/server/web/fake_voice.wav"

def make(pw, name):
    b = pw.chromium.launch(args=[
        "--ignore-certificate-errors",
        "--allow-running-insecure-content",
        "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
        f"--use-file-for-fake-audio-capture={WAV}",
        "--autoplay-policy=no-user-gesture-required", "--no-sandbox",
    ])
    ctx = b.new_context(permissions=["microphone"])
    p = ctx.new_page()
    p.goto(URL); p.fill("#peer", name); p.fill("#room", "multi")
    return b, p

with sync_playwright() as pw:
    peers = []
    for i in range(N):
        b, p = make(pw, f"U{i+1}")
        p.click("#join")
        peers.append((f"U{i+1}", b, p))
        time.sleep(1.5)
    time.sleep(8)
    total_up = total_down = 0
    print(f"\n=== {N} 人房 ===")
    for tag, b, p in peers:
        st = p.evaluate("window.__stats")
        total_up += st.get("bytesSent", 0); total_down += st.get("bytesRecv", 0)
        print(f"{tag}: tracks={st['remoteTracks']} recv={st['bytesRecv']} sent={st['bytesSent']} "
              f"rms={st.get('remoteRms',0):.4f} kbps={st.get('txKbps',0)} lost={st['packetsLost']}")
    print(f"\n每端 上行 {total_up/N/1000:.0f} KB 下行 {total_down/N/1000:.0f} KB")
    print(f"SFU 总转发量 {(total_up+total_down)/1e6:.2f} MB")
    for tag, b, p in peers:
        b.close()
