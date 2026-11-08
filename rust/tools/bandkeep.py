"""分频段能量保持率 —— 量化"发闷"的唯一可信指标（PESQ 看不出来）

用法:
  python bandkeep.py <参考干净> <处理后> [标签]
输出:
  4-8 kHz / 8-16 kHz / 16-24 kHz 三段，输出能量 / 输入能量 (dB)
  以及各频段的相关系数（判断是"整体变暗"还是"局部被抹掉"）
"""
import sys
import numpy as np
import soundfile as sf
import scipy.signal as ss

BANDS = [(0, 400), (400, 1000), (1000, 4000), (4000, 8000),
         (8000, 16000), (16000, 24000)]


def align_by_xcorr(ref, sig, max_ms=50, sr=48000):
    """互相关找 lag，只在 ±max_ms 内搜索。找不到说明模型有帧抖动，先修那个。"""
    n = min(len(ref), len(sig))
    a = ref[:n] - ref[:n].mean()
    b = sig[:n] - sig[:n].mean()
    maxlag = int(sr * max_ms / 1000)
    best, bl = -1e18, 0
    for lag in range(-maxlag, maxlag + 1, 4):
        if lag >= 0:
            x, y = a[lag:], b[:n - lag]
        else:
            x, y = a[:n + lag], b[-lag:]
        if len(x) < sr // 2:
            continue
        d = np.linalg.norm(x) * np.linalg.norm(y)
        if d < 1e-12:
            continue
        c = float(np.dot(x, y) / d)
        if c > best:
            best, bl = c, lag
    # 精细到采样点
    for lag in range(bl - 4, bl + 5):
        if lag >= 0:
            x, y = a[lag:], b[:n - lag]
        else:
            x, y = a[:n + lag], b[-lag:]
        if len(x) < sr // 2:
            continue
        d = np.linalg.norm(x) * np.linalg.norm(y)
        if d < 1e-12:
            continue
        c = float(np.dot(x, y) / d)
        if c > best:
            best, bl = c, lag
    if bl >= 0:
        return ref[:n - bl], sig[bl:n], best, bl
    else:
        return ref[-bl:n], sig[:n + bl], best, bl


def band_energy(x, lo, hi, sr=48000, nfft=2048):
    f, P = ss.welch(x, fs=sr, nperseg=nfft)
    m = (f >= lo) & (f < hi)
    return float(np.sum(P[m])) if m.any() else 0.0


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return
    ref_p, out_p = sys.argv[1], sys.argv[2]
    label = sys.argv[3] if len(sys.argv) > 3 else out_p.split("/")[-1]

    ref, sr = sf.read(ref_p, dtype="float32")
    out, sr2 = sf.read(out_p, dtype="float32")
    assert sr == sr2 == 48000, (sr, sr2)
    if ref.ndim > 1:
        ref = ref.mean(1)
    if out.ndim > 1:
        out = out.mean(1)

    r, d, corr, lag = align_by_xcorr(ref, out)
    n = min(len(r), len(d))
    r, d = r[:n], d[:n]

    print(f"\n=== {label} ===")
    print(f"对齐: lag {lag:+d} samples ({lag/48:+.2f} ms)  相关 {corr:.4f}")

    print(f"\n{'频段':>12} {'输入dB':>9} {'输出dB':>9} {'保持率':>9} {'相关':>8}")
    print("-" * 54)
    for lo, hi in BANDS:
        ei = band_energy(r, lo, hi)
        eo = band_energy(d, lo, hi)
        ratio = 10 * np.log10((eo + 1e-20) / (ei + 1e-20))
        # 该频段的时域相关
        bi = ss.sosfiltfilt(ss.butter(4, [lo, min(hi, 23999)], btype="band",
                                      fs=sr, output="sos"), r) if lo > 0 else r
        bo = ss.sosfiltfilt(ss.butter(4, [lo, min(hi, 23999)], btype="band",
                                      fs=sr, output="sos"), d) if lo > 0 else d
        dd = np.linalg.norm(bi) * np.linalg.norm(bo)
        c = float(np.dot(bi, bo) / dd) if dd > 1e-12 else 0.0
        flag = ""
        if hi > 4000 and ratio < -10:
            flag = "  <== 明显压掉"
        print(f"{lo:>5}-{hi:<6} {10*np.log10(ei+1e-20):>9.1f} "
              f"{10*np.log10(eo+1e-20):>9.1f} {ratio:>+8.1f}dB {c:>+8.3f}{flag}")

    # 汇总：高频/中频能量比（越接近参考越"不闷"）
    def air(x):
        mid = band_energy(x, 300, 3000)
        high = band_energy(x, 4000, 16000)
        return 10 * np.log10((high + 1e-20) / (mid + 1e-20))
    print(f"\n4k-16k / 300-3k 能量比:  参考 {air(r):+.2f} dB   "
          f"输出 {air(d):+.2f} dB   差 {air(d)-air(r):+.2f} dB")


if __name__ == "__main__":
    main()
