"""构造真正的 48 kHz 宽频测试集（本机没有真实 48k 语音素材）

为什么要自己造：
  现有 tts_clean.wav 是从 22050 Hz 上采样的，8 kHz 以上能量在 -82 dB，
  用它测"发闷"完全无效（降噪器压掉的东西本来就不存在）。

做法：
  用源-滤波器模型合成语音：
    浊音 = 声门脉冲串(基频 80-220 Hz，带 jitter) → 共振峰滤波器(F1..F5)
    清音 = 白噪 → 高频带通（这是"齿音/擦音"，4-16 kHz 的主要能量来源）
  两者按音节交替，形成类似真实说话的频谱结构。

输出：
  clean48.wav   干净宽频语音（用于作参考）
  noisy48.wav   加噪版（风扇噪声 + 键盘瞬态）
  keyboard48.wav  只有键盘瞬态（用于测瞬态抑制）
"""
import numpy as np
import soundfile as sf

SR = 48000
rng = np.random.default_rng(20261105)


def formant_filter(x, formants, bws, sr=SR):
    """串联共振峰滤波器（二阶谐振器级联）"""
    y = x.astype(np.float64)
    for f0, bw in zip(formants, bws):
        r = np.exp(-np.pi * bw / sr)
        theta = 2 * np.pi * f0 / sr
        a1 = -2 * r * np.cos(theta)
        a2 = r * r
        b0 = 1 - r
        out = np.zeros_like(y)
        for i in range(len(y)):
            out[i] = b0 * y[i] - a1 * (out[i - 1] if i >= 1 else 0) - a2 * (out[i - 2] if i >= 2 else 0)
        y = out
    return y


def voiced(dur, f0_base, sr=SR):
    """浊音：声门脉冲串 + 抖动 + 共振峰
    频谱必须符合真实语音：0-400 Hz 最强，4-8k 衰减 9 dB 左右"""
    n = int(dur * sr)
    t = np.arange(n) / sr
    # 基频带自然抖动（真实语音一定不是完美周期）
    jitter = 1.0 + 0.02 * np.sin(2 * np.pi * 3.1 * t) + 0.01 * rng.standard_normal(n).cumsum() / np.sqrt(n)
    f0 = f0_base * jitter
    phase = np.cumsum(2 * np.pi * f0 / sr)
    # 声门脉冲（Rosenberg 近似：每个周期一个尖峰 + 缓慢衰减）
    pulses = np.zeros(n)
    idx = np.where(np.diff(np.floor(phase / (2 * np.pi))) > 0)[0]
    for i in idx:
        if i < n:
            pulses[i] = 1.0
    # 声门波形：单极点低通，模拟声带频谱 -12 dB/oct
    glottal = np.zeros(n)
    a = 0.97
    for i in range(1, n):
        glottal[i] = a * glottal[i - 1] + (1 - a) * pulses[i]

    # 元音共振峰（依次变化的 /a/ /e/ /i/ /o/）
    vowels = [
        ([800, 1200, 2500, 3500, 4500], [80, 90, 120, 150, 200]),
        ([500, 1800, 2500, 3300, 4200], [70, 100, 120, 150, 200]),
        ([300, 2200, 3000, 3700, 4500], [60, 100, 130, 160, 200]),
        ([500, 900, 2400, 3300, 4200], [70, 90, 120, 150, 200]),
    ]
    seg = n // len(vowels)
    out = np.zeros(n)
    for k, (fs, bws) in enumerate(vowels):
        st = k * seg
        en = n if k == len(vowels) - 1 else (k + 1) * seg
        chunk = glottal[st:en]
        ln = len(chunk)
        # 并联共振峰，但必须让 F1 主导（低频能量最强）
        acc = np.zeros(ln)
        for idx, (f0f, bw) in enumerate(zip(fs, bws)):
            r = np.exp(-np.pi * bw / SR)
            th = 2 * np.pi * f0f / SR
            a1, a2 = -2 * r * np.cos(th), r * r
            b0 = (1 - r)
            y = np.zeros(ln)
            for i in range(ln):
                y[i] = b0 * chunk[i] - a1 * (y[i - 1] if i >= 1 else 0) - a2 * (y[i - 2] if i >= 2 else 0)
            # 关键：按 -12 dB/oct 衰减高阶共振峰，F1 最强
            gain = 1.0 / (1.0 + (f0f / 500.0) ** 2)
            acc += y * gain * 6.0
        # 补回基频（声门脉冲的低频分量，真实语音里 100-300 Hz 最强）
        acc += chunk * 3.0
        out[st:en] = acc
    return out


def fricative(dur, center, bw, sr=SR):
    """清音/擦音：白噪过带通，这是 4-16 kHz 的真实来源"""
    n = int(dur * sr)
    x = rng.standard_normal(n)
    # 简单双二阶带通
    r = np.exp(-np.pi * bw / sr)
    th = 2 * np.pi * center / sr
    a1, a2 = -2 * r * np.cos(th), r * r
    b0 = (1 - r) * 1.5
    y = np.zeros(n)
    for i in range(n):
        y[i] = b0 * x[i] - a1 * (y[i - 1] if i >= 1 else 0) - a2 * (y[i - 2] if i >= 2 else 0)
    # 归一化到固定 RMS，避免擦音压过浊音（真实语音里擦音比浊音弱 10-15 dB）
    rms = np.sqrt(np.mean(y ** 2)) + 1e-12
    return (y / rms * 0.012).astype(np.float32)


def make_speech(total_sec=8.0):
    """合成一段"说话"：浊音音节 + 清音交替"""
    out = np.zeros(int(total_sec * SR))
    pos = 0
    i = 0
    while pos < len(out) - SR // 4:
        # 音节 150-280 ms
        dur_v = rng.uniform(0.15, 0.28)
        if rng.random() < 0.18:
            # 擦音 /s/ /sh/ /f/：4-16 kHz 主能量
            center = rng.choice([5500, 7000, 9000, 12000])
            seg = fricative(dur_v * 0.6, center, 1800)
            # 加一点低频"气声"让过渡自然
            q = len(seg)//8
            seg[:q] *= np.linspace(0, 1, q)
            seg[len(seg)-q:] *= np.linspace(1, 0, q)
        else:
            # 浊音，基频随"语调"变化
            f0 = rng.uniform(95, 210)
            seg = voiced(dur_v, f0)
            # 起止淡入淡出
            k = min(len(seg) // 6, 1200)
            seg[:k] *= np.linspace(0, 1, k)
            seg[len(seg)-k:] *= np.linspace(1, 0, k)
            # 浊音也带一点高频"气声"，真实语音都有
            br = fricative(len(seg) / SR, 8000, 4000)
            if len(br) < len(seg):
                br = np.pad(br, (0, len(seg) - len(br)))
            seg = seg + br[:len(seg)] * 0.08
        s = int(pos)
        e = min(s + len(seg), len(out))
        out[s:e] += seg[:e - s]
        # 音节间隔（含停顿，模拟自然语流）
        pos += len(seg) + int(rng.uniform(0.02, 0.18) * SR)
        i += 1
    # 归一化
    out /= (np.max(np.abs(out)) + 1e-9)
    out *= 0.5
    return out.astype(np.float32)


def make_fan_noise(dur, sr=SR):
    """风扇/空调：低频为主 + 宽带底"""
    n = int(dur * sr)
    white = rng.standard_normal(n)
    # 一阶低通累积 -> 粉噪倾向
    pink = np.zeros(n)
    a = 0.995
    for i in range(1, n):
        pink[i] = a * pink[i - 1] + white[i] * (1 - a)
    pink = pink / (np.std(pink) + 1e-9)
    # 100 Hz 附近的电机嗡嗡
    t = np.arange(n) / sr
    hum = 0.3 * np.sin(2 * np.pi * 100 * t) + 0.15 * np.sin(2 * np.pi * 200 * t)
    return (pink * 0.6 + white * 0.08 + hum).astype(np.float32)


def make_keyboard(n_clicks, dur, sr=SR):
    """键盘敲击：极短宽带瞬态 + 快速衰减尾音"""
    n = int(dur * sr)
    out = np.zeros(n, np.float32)
    for _ in range(n_clicks):
        pos = rng.integers(0, n - sr // 10)
        ln = int(rng.uniform(0.006, 0.02) * sr)     # 6-20 ms
        click = rng.standard_normal(ln)
        # 高频为主（机械键盘的特征）
        click = np.diff(click, prepend=0)            # 一阶差分 -> 提亮
        env = np.exp(-np.arange(ln) / (ln / 4))
        out[pos:pos + ln] += (click * env).astype(np.float32) * 0.9
    return out


def mix_at_snr(speech, noise, snr_db):
    ps = np.mean(speech ** 2)
    pn = np.mean(noise ** 2)
    g = np.sqrt(ps / (pn * 10 ** (snr_db / 10)))
    return (speech + noise * g).astype(np.float32)


if __name__ == "__main__":
    import os

    outdir = os.path.dirname(os.path.abspath(__file__)) + "/../../fong/samples"
    os.makedirs(outdir, exist_ok=True)

    print("合成干净宽频语音 ...")
    clean = make_speech(8.0)
    sf.write(f"{outdir}/clean48.wav", clean, SR, subtype="PCM_16")

    print("合成风扇噪声 ...")
    fan = make_fan_noise(len(clean) / SR)

    print("合成键盘瞬态 ...")
    kb = make_keyboard(60, len(clean) / SR)

    print("混合 ...")
    # 关键：噪声铺满全程。真实场景里"不说话"时麦克风仍然收着风扇声，
    # 之前只在语音段加噪是错的，那样测不出"静音段降噪能力"
    noisy10 = mix_at_snr(clean, fan, 10)
    noisy5 = mix_at_snr(clean, fan, 5)
    kb_mix = mix_at_snr(clean, kb + fan * 0.3, 15)

    sf.write(f"{outdir}/noisy48_10db.wav", noisy10, SR, subtype="PCM_16")
    sf.write(f"{outdir}/noisy48_5db.wav", noisy5, SR, subtype="PCM_16")
    sf.write(f"{outdir}/keyboard48.wav", kb_mix, SR, subtype="PCM_16")
    sf.write(f"{outdir}/noise_fan48.wav", fan / (np.max(np.abs(fan)) + 1e-9) * 0.3, SR, subtype="PCM_16")

    # 验证频谱
    import numpy as np
    from scipy.signal import welch

    print("\n=== 频谱验证 ===")
    for name in ["clean48", "noisy48_10db", "keyboard48"]:
        x, _ = sf.read(f"{outdir}/{name}.wav", dtype="float32")
        f, P = welch(x, fs=SR, nperseg=4096)
        bands = [(0, 400), (400, 1000), (1000, 4000), (4000, 8000), (8000, 16000), (16000, 24000)]
        line = f"{name:14s}"
        for lo, hi in bands:
            m = (f >= lo) & (f < hi)
            line += f" {lo//1000}-{hi//1000}k:{10*np.log10(np.sum(P[m])+1e-20):6.1f}"
        print(line)
