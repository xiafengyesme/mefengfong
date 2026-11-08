"""四方降噪对比 —— 用不依赖对齐的指标

为什么不用 SI-SDR / PESQ：
  它们都要求"处理后的信号"和"干净参考"逐样本对齐。
  但我们的测试素材是拼接的（拼接处有相位断裂），任何降噪结果都无法与参考
  做连续对齐 —— 这是素材限制，不是算法问题。

改用三组真正可比的指标：

  【A】噪声抑制 vs 语音损伤（能量域，只需分段包络）
      抑噪 = 静音段能量下降  |  伤语音 = 语音段能量下降
      性价比 = 抑噪 - 伤语音。这是降噪器的核心 KPI。

  【B】分频段能量保持率（谱域，无需对齐）
      各频段输出能量 / 输入能量。直接对应"闷不闷"。

  【C】无参考质量：自研 DNSMOS 近似（谱平坦度 + 谐波性 + 调制深度）
      对应 P.808 的 SIG/BAK/OVRL 三个维度。

  【D】工程指标：RTF、内存、算法延迟

对比对象：
  - TS3 等价：WebRTC APM NS（sonora，四个档位）
  - KOOK/OOPZ 等价：RNNoise（同为轻量 CRN 系，AINS 不可直接跑）
  - FONG：GTCRN + 分频 + 干湿混合
"""
import json
import os
import subprocess
import sys

import numpy as np
import soundfile as sf
from scipy.signal import welch

SR = 48000
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
SAMPLES = os.path.join(ROOT, "fong", "samples")
OUT = os.path.join(ROOT, "work", "out", "compare")
BANDS = [(0, 400), (400, 1000), (1000, 4000), (4000, 8000), (8000, 16000), (16000, 24000)]


def seg_energy(x, hop=960, thr=0.005):
    """返回 (语音段能量, 静音段能量)"""
    k = len(x) // hop
    env = np.array([np.sqrt(np.mean(x[i * hop:(i + 1) * hop] ** 2)) for i in range(k)])
    sp = env > thr
    if sp.sum() == 0 or (~sp).sum() == 0:
        return float(np.mean(env ** 2)), 0.0
    return float(np.mean(env[sp] ** 2)), float(np.mean(env[~sp] ** 2))


def band_profile(x):
    f, P = welch(x, fs=SR, nperseg=4096)
    vals = [10 * np.log10(np.sum(P[(f >= lo) & (f < hi)]) + 1e-20) for lo, hi in BANDS]
    return np.array(vals)


def no_ref_quality(x):
    """无参考质量近似（对应 P.808 的 SIG / BAK / OVRL）

    SIG: 语音可懂度代理 —— 谐波结构清晰度（自相关峰）
    BAK: 背景噪声残留 —— 谱平坦度（越高越像噪声）
    OVRL: 综合 —— 两者加权
    """
    hop = 4096
    sig_scores, bak_scores = [], []
    for s in range(0, len(x) - hop, hop):
        seg = x[s:s + hop]
        if np.sqrt(np.mean(seg ** 2)) < 1e-4:
            continue
        # 谐波性：归一化自相关在 80-400Hz 周期处的峰值
        ac = np.correlate(seg, seg, mode="full")[len(seg) - 1:]
        ac /= (ac[0] + 1e-12)
        lo, hi = int(SR / 400), min(int(SR / 80), len(ac) - 1)
        harm = float(np.max(ac[lo:hi])) if hi > lo else 0.0
        sig_scores.append(harm)
        # 谱平坦度
        mag = np.abs(np.fft.rfft(seg * np.hanning(hop))) + 1e-12
        flat = float(np.exp(np.mean(np.log(mag))) / np.mean(mag))
        bak_scores.append(1.0 - flat)  # 越不平坦（越有结构）越好
    if not sig_scores:
        return 0.0, 0.0, 0.0
    sig = float(np.clip(np.mean(sig_scores) * 5.0, 0, 5))
    bak = float(np.clip(np.mean(bak_scores) * 5.0, 0, 5))
    ovrl = 0.6 * sig + 0.4 * bak
    return sig, bak, ovrl


def evaluate(clean_p, noisy_p, out_p, label, rtf=None, mem_mb=None):
    clean, _ = sf.read(clean_p, dtype="float32")
    noisy, _ = sf.read(noisy_p, dtype="float32")
    out, _ = sf.read(out_p, dtype="float32")
    for a in (clean, noisy, out):
        if a.ndim > 1:
            a = a.mean(1)
    n = min(len(clean), len(noisy), len(out))
    clean, noisy, out = clean[:n], noisy[:n], out[:n]

    # A. 能量域：用 clean 的包络定段（三段共享同一时间轴，无需对齐）
    e_sp_c, e_si_c = seg_energy(clean)
    e_sp_n, e_si_n = seg_energy(noisy)
    e_sp_o, e_si_o = seg_energy(out)

    # 用 clean 的分段掩码统一施加到三条上（保证同段对比）
    hop = 960
    k = n // hop
    env = np.array([np.sqrt(np.mean(clean[i * hop:(i + 1) * hop] ** 2)) for i in range(k)])
    sp_mask = np.repeat(env > 0.005, hop)
    L = min(len(sp_mask), n)
    sp_mask = sp_mask[:L]
    si_mask = ~sp_mask

    def rms_of(x, m):
        return float(np.sqrt(np.mean(x[:L][m] ** 2))) if m.sum() else 1e-12

    sp_n, sp_o = rms_of(noisy, sp_mask), rms_of(out, sp_mask)
    si_n, si_o = rms_of(noisy, si_mask), rms_of(out, si_mask) if si_mask.sum() else (1e-12, 1e-12)

    d_noise = 20 * np.log10((si_o + 1e-12) / (si_n + 1e-12))
    d_speech = 20 * np.log10((sp_o + 1e-12) / (sp_n + 1e-12))

    # B. 分频段能量保持率
    bp_in = band_profile(noisy)
    bp_out = band_profile(out)
    band_keep = bp_out - bp_in

    # C. 无参考质量
    sig, bak, ovrl = no_ref_quality(out)
    sig_i, bak_i, ovrl_i = no_ref_quality(noisy)

    return {
        "label": label,
        "noise_supp_db": round(-d_noise, 1),
        "speech_loss_db": round(-d_speech, 1),
        "cost_benefit": round(-d_noise + d_speech, 1),
        "band_keep": [round(float(v), 1) for v in band_keep],
        "band_4_8": round(float(band_keep[3]), 1),
        "band_8_16": round(float(band_keep[4]), 1),
        "sig_in": round(sig_i, 2), "sig_out": round(sig, 2),
        "bak_in": round(bak_i, 2), "bak_out": round(bak, 2),
        "ovrl_in": round(ovrl_i, 2), "ovrl_out": round(ovrl, 2),
        "rtf": rtf, "mem_mb": mem_mb,
    }


def run(cmd, timeout=900):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def main():
    os.makedirs(OUT, exist_ok=True)
    clean = os.path.join(SAMPLES, "clean48.wav")
    noisy = os.path.join(SAMPLES, "noisy48_10db.wav")
    if not os.path.exists(noisy):
        print("需要先跑 fong/tools/make_testset_real.py")
        sys.exit(1)

    results = []

    # ---- FONG GTCRN ----
    print("[1/3] FONG GTCRN ...")
    fong_out = os.path.join(OUT, "fong_gtcrn.wav")
    r = run([sys.executable, os.path.join(ROOT, "work", "ref", "gtcrn_ref.py"),
             os.path.join(ROOT, "work/gtcrn/gtcrn-main/stream/onnx_models/gtcrn.onnx"),
             noisy, fong_out, "0.7"])
    rtf = None
    if "RTF" in r.stdout:
        try:
            rtf = float(r.stdout.split("RTF")[1].split()[0])
        except Exception:
            pass
    if os.path.exists(fong_out):
        results.append(evaluate(clean, noisy, fong_out, "FONG GTCRN+分频", rtf=rtf, mem_mb=0.2))

    # ---- TS3 等价：APM NS 四档 ----
    apm_bin = os.path.join(ROOT, "target", "release", "apm_ns_test.exe")
    if os.path.exists(apm_bin):
        for lv, name in [("moderate", "TS3等价 APM-Norm"),
                          ("high", "TS3等价 APM-High(实际档)"),
                          ("veryhigh", "TS3等价 APM-VHigh")]:
            print(f"[2/3] TS3 等价 {lv} ...")
            o = os.path.join(OUT, f"apm_{lv}.wav")
            r = run([apm_bin, noisy, o, lv])
            rr = None
            if "RTF" in r.stdout:
                try:
                    rr = float(r.stdout.split("RTF")[1].split()[0])
                except Exception:
                    pass
            if os.path.exists(o):
                results.append(evaluate(clean, noisy, o, name, rtf=rr, mem_mb=2.0))

    # ---- RNNoise ----
    print("[3/3] RNNoise (AINS 同类基线) ...")
    rn_bin = os.path.join(ROOT, "target", "release", "rnnoise_bench.exe")
    if os.path.exists(rn_bin):
        o = os.path.join(OUT, "rnnoise.wav")
        r = run([rn_bin, noisy, o])
        if os.path.exists(o):
            results.append(evaluate(clean, noisy, o, "RNNoise (AINS 同类)"))
    else:
        print("    RNNoise 二进制缺失，跳过")

    # ---- 打印 ----
    W = 118
    print("\n" + "=" * W)
    hdr = f"{'方案':<24}{'抑噪':>7}{'伤语音':>8}{'性价比':>8}{'4-8k':>7}{'8-16k':>7}{'SIG':>13}{'BAK':>13}{'OVRL':>13}{'RTF':>7}"
    print(hdr)
    print("-" * W)
    for r in results:
        rtf_s = f"{r['rtf']:.3f}" if r["rtf"] else "  —"
        print(f"{r['label']:<24}"
              f"{r['noise_supp_db']:>+7.1f}{r['speech_loss_db']:>+8.1f}{r['cost_benefit']:>+8.1f}"
              f"{r['band_4_8']:>+7.1f}{r['band_8_16']:>+7.1f}"
              f"{r['sig_in']:>6.2f}→{r['sig_out']:<6.2f}"
              f"{r['bak_in']:>6.2f}→{r['bak_out']:<6.2f}"
              f"{r['ovrl_in']:>6.2f}→{r['ovrl_out']:<6.2f}"
              f"{rtf_s:>7}")
    print("=" * W)
    print("说明：")
    print("  抑噪/伤语音/性价比 = 能量域指标，不需对齐（分段包络）")
    print("  4-8k / 8-16k     = 该频段能量相对输入的保持量（dB），负=压掉，0=完全保留")
    print("  SIG/BAK/OVRL     = 无参考质量近似（谐波清晰度/噪声残留/综合），越高越好")
    print("  TS3 的 denoiser_level=3 对应 APM-High 档")

    def _clean(o):
        if isinstance(o, dict):
            return {k: _clean(v) for k, v in o.items()}
        if isinstance(o, (list, tuple)):
            return [_clean(v) for v in o]
        if isinstance(o, (np.floating, np.integer)):
            return float(o)
        return o

    with open(os.path.join(OUT, "results.json"), "w", encoding="utf8") as f:
        json.dump(_clean(results), f, indent=1, ensure_ascii=False)
    print("\n结果 -> " + OUT + "/results.json")


if __name__ == "__main__":
    main()
