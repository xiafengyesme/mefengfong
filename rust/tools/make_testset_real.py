"""用本机真实录音构造 48 kHz 测试集

为什么放弃纯合成：
  合成的共振峰语音频谱形状对不上（0-400 vs 1-4k 的比值差 10 dB 以上），
  导致 GTCRN 误判为噪声。而本机 TS3 音效里的真人录音频谱完全符合语音特征。

素材：E:\\ts'\\sound\\default_male\\*.wav（44100 Hz，真人录音，频谱 0-400 比 1-4k 高 12 dB）
处理：44.1k → 48k 重采样（保留真实频谱形状），拼接成 8 秒
噪声：风扇（低频为主）+ 键盘瞬态（宽带短脉冲），铺满全程
"""
import glob
import os
import numpy as np
import soundfile as sf
import scipy.signal as ss

SR = 48000
SRC_DIR = r"E:\ts'\sound"
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "fong", "samples")
rng = np.random.default_rng(20261105)


def collect_speech(target_sec=8.0):
    """从 TS3 真人录音里拼一段连续语音"""
    segs = []
    total = 0
    want = int(target_sec * SR)
    for p in sorted(glob.glob(os.path.join(SRC_DIR, "**", "*.wav"), recursive=True)):
        try:
            x, sr = sf.read(p, dtype="float32")
            if x.ndim > 1:
                x = x.mean(1)
            if len(x) < SR // 2:
                continue
            if sr != SR:
                x = ss.resample_poly(x, SR, sr).astype(np.float32)
            # 去掉首尾静音
            env = np.abs(x)
            th = env.max() * 0.02
            idx = np.where(env > th)[0]
            if len(idx) < SR // 4:
                continue
            x = x[idx[0]:idx[-1] + 1]
            segs.append(x)
            total += len(x)
            if total >= want:
                break
        except Exception:
            continue
    if not segs:
        raise RuntimeError("没找到可用素材")
    y = np.concatenate(segs)[:want]
    # 加淡入淡出
    k = SR // 50
    y[:k] *= np.linspace(0, 1, k)
    y[-k:] *= np.linspace(1, 0, k)
    y /= (np.max(np.abs(y)) + 1e-9)
    return (y * 0.5).astype(np.float32)


def make_fan(dur):
    n = int(dur * SR)
    white = rng.standard_normal(n)
    pink = np.zeros(n)
    a = 0.995
    for i in range(1, n):
        pink[i] = a * pink[i - 1] + white[i] * (1 - a)
    pink /= (np.std(pink) + 1e-9)
    t = np.arange(n) / SR
    hum = 0.3 * np.sin(2 * np.pi * 100 * t) + 0.15 * np.sin(2 * np.pi * 200 * t)
    return (pink * 0.6 + white * 0.05 + hum).astype(np.float32)


def make_keyboard(dur, n_clicks=60):
    n = int(dur * SR)
    out = np.zeros(n, np.float32)
    for _ in range(n_clicks):
        pos = rng.integers(0, n - SR // 10)
        ln = int(rng.uniform(0.006, 0.02) * SR)
        click = rng.standard_normal(ln)
        click = np.diff(click, prepend=0)
        env = np.exp(-np.arange(ln) / (ln / 4))
        out[pos:pos + ln] += (click * env).astype(np.float32)
    out /= (np.max(np.abs(out)) + 1e-9)
    return out


def mix_at_snr(speech, noise, snr_db):
    ps = np.mean(speech ** 2)
    pn = np.mean(noise ** 2)
    g = np.sqrt(ps / (pn * 10 ** (snr_db / 10)))
    return (speech + noise * g).astype(np.float32)


if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)

    print("拼接真实语音 ...")
    clean = collect_speech(8.0)
    sf.write(f"{OUT_DIR}/clean48.wav", clean, SR, subtype="PCM_16")

    print("噪声 ...")
    fan = make_fan(len(clean) / SR)
    kb = make_keyboard(len(clean) / SR)

    sf.write(f"{OUT_DIR}/noisy48_10db.wav", mix_at_snr(clean, fan, 10), SR, subtype="PCM_16")
    sf.write(f"{OUT_DIR}/noisy48_5db.wav", mix_at_snr(clean, fan, 5), SR, subtype="PCM_16")
    sf.write(f"{OUT_DIR}/keyboard48.wav", mix_at_snr(clean, kb, 12), SR, subtype="PCM_16")
    sf.write(f"{OUT_DIR}/noise_fan48.wav", fan / (np.max(np.abs(fan)) + 1e-9) * 0.3, SR,
             subtype="PCM_16")

    # 验证
    from scipy.signal import welch

    print("\n=== 频谱验证（相对 1-4k）===")
    for name in ["clean48", "noisy48_10db", "keyboard48"]:
        x, _ = sf.read(f"{OUT_DIR}/{name}.wav", dtype="float32")
        f, P = welch(x, fs=SR, nperseg=4096)
        r = [10 * np.log10(np.sum(P[(f >= lo) & (f < hi)]) + 1e-20)
             for lo, hi in [(0, 400), (400, 1000), (1000, 4000), (4000, 8000), (8000, 16000)]]
        print(f"  {name:14s} " + " ".join(f"{v-r[2]:+6.1f}" for v in r))
    print("\n参考：官方 mix.wav = +12.2 +8.5 +0.0 -9.4")
