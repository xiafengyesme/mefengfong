"""降噪效果评估：在"噪声段"和"语音段"分别量化

关键：不能只看整体指标。降噪要满足两个条件：
  1. 噪声段被压下去（这是降噪的目的）
  2. 语音段不被损伤（这是不发闷/不失真的保证）

我们的测试集 clean48.wav 是合成的，静音段精确为 0，
所以可以直接用 |clean| > 阈值 判定语音段 / 噪声段。
"""
import sys
import numpy as np
import soundfile as sf


def align(ref, sig, sr=48000, max_ms=50):
    n = min(len(ref), len(sig))
    a = ref[:n] - ref[:n].mean()
    b = sig[:n] - sig[:n].mean()
    ml = int(sr * max_ms / 1000)
    best, bl = -1e18, 0
    for lag in range(-ml, ml + 1, 2):
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
        return ref[:n - bl], sig[bl:n], bl
    return ref[-bl:n], sig[:n + bl], bl


def seg_rms(x, mask):
    if mask.sum() == 0:
        return 1e-12
    return float(np.sqrt(np.mean(x[mask] ** 2)))


def main():
    clean_p, noisy_p, out_p = sys.argv[1], sys.argv[2], sys.argv[3]
    label = sys.argv[4] if len(sys.argv) > 4 else ""

    clean, _ = sf.read(clean_p, dtype="float32")
    noisy, _ = sf.read(noisy_p, dtype="float32")
    out, _ = sf.read(out_p, dtype="float32")
    if clean.ndim > 1: clean = clean.mean(1)
    if noisy.ndim > 1: noisy = noisy.mean(1)
    if out.ndim > 1: out = out.mean(1)

    # 以 clean 为基准对齐 noisy 和 out（注意 align 返回长度可能不同）
    clean, noisy, _ = align(clean, noisy)
    clean, out, lag = align(clean, out)

    n = min(len(clean), len(noisy), len(out))
    clean, noisy, out = clean[:n], noisy[:n], out[:n]

    # 语音段 / 噪声段掩码（基于 clean 的包络，20ms 平滑）
    hop = 960
    nf = n // hop
    env = np.array([np.sqrt(np.mean(clean[i*hop:(i+1)*hop]**2)) for i in range(nf)])
    speech_f = env > 0.005          # 有声
    silence_f = env <= 0.005        # 静音（只有噪声）
    speech = np.repeat(speech_f, hop)
    silence = np.repeat(silence_f, hop)
    # 对齐到实际可用长度（拼接素材可能有 1 个 hop 的偏差）
    L = min(len(speech), len(clean), len(noisy), len(out))
    speech, silence = speech[:L], silence[:L]
    clean, noisy, out = clean[:L], noisy[:L], out[:L]
    n = L

    print(f"\n=== {label} ===")
    print(f"对齐 lag {lag:+d} samples   语音段 {100*speech_f.mean():.0f}%  "
          f"静音段 {100*silence_f.mean():.0f}%")

    def db(a, b):
        return 20 * np.log10((a + 1e-12) / (b + 1e-12))

    rows = []
    for name, m in [("语音段", speech), ("噪声段", silence)]:
        r_n = seg_rms(noisy, m)
        r_o = seg_rms(out, m)
        r_c = seg_rms(clean, m)
        rows.append((name, r_c, r_n, r_o, db(r_o, r_n)))

    print(f"\n{'段':>8} {'clean dB':>10} {'noisy dB':>10} {'输出 dB':>10} {'降噪量':>10}")
    print("-" * 56)
    for name, rc, rn, ro, chg in rows:
        print(f"{name:>8} {20*np.log10(rc+1e-12):>10.1f} "
              f"{20*np.log10(rn+1e-12):>10.1f} "
              f"{20*np.log10(ro+1e-12):>10.1f} {chg:>+9.1f}dB")

    # 关键指标：噪声段抑制量 vs 语音段损伤量
    ns_supp = -rows[1][4]          # 噪声降了多少（正数=降了）
    sp_loss = -rows[0][4]          # 语音损失了多少（正数=损失）
    print(f"\n噪声抑制 {ns_supp:+.1f} dB   语音损伤 {sp_loss:+.1f} dB   "
          f"性价比 {ns_supp - sp_loss:+.1f} dB")

    # SI-SDR（对齐后）
    def sisdr(est, ref):
        est = est - est.mean(); ref = ref - ref.mean()
        a = float(np.dot(est, ref) / (np.dot(ref, ref) + 1e-12))
        t = a * ref
        return 10 * np.log10((np.sum(t**2) + 1e-12) / (np.sum((est - t)**2) + 1e-12))
    print(f"SI-SDR  输入 {sisdr(noisy, clean):+.2f} dB  输出 {sisdr(out, clean):+.2f} dB")


if __name__ == "__main__":
    main()
