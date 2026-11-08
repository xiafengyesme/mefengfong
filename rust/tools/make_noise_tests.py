"""生成验证用测试信号：啸叫 + 键盘 + 人声，用于检验降噪/啸叫抑制/瞬态抑制

为什么需要专门的测试信号：
  - 真实啸叫很难录制（需要音箱和麦克风形成反馈回路，而且很响）
  - 键盘声需要精确控制时间位置才能量化抑制效果
  - 人声必须同时存在，才能验证"抑制噪声的同时不损伤人声"
"""
import numpy as np
import soundfile as sf
import os

SR = 48000
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "fong", "samples")
rng = np.random.default_rng(20261105)


def howl(dur, freq, sr=SR):
    """啸叫：单频正弦 + 缓慢增长 + 轻微频率漂移（真实啸叫会跟房间共振走）"""
    n = int(dur * sr)
    t = np.arange(n) / sr
    # 频率缓慢上漂（反馈回路的特征）
    f = freq * (1.0 + 0.002 * t / dur)
    phase = np.cumsum(2 * np.pi * f / sr)
    env = np.minimum(np.linspace(0, 1, n) ** 2, 1.0)  # 指数增长后饱和
    return (0.4 * env * np.sin(phase)).astype(np.float32)


def keyboard(dur, n_clicks, sr=SR):
    """键盘：极短宽频瞬态，谐波结构弱（这是与语音的本质区别）"""
    n = int(dur * sr)
    out = np.zeros(n, np.float32)
    for _ in range(n_clicks):
        pos = rng.integers(0, n - sr // 5)
        ln = int(rng.uniform(0.005, 0.018) * sr)
        # 白噪 + 一阶差分（提亮）→ 高频为主
        click = rng.standard_normal(ln)
        click = np.diff(click, prepend=0)
        env = np.exp(-np.arange(ln) / (ln / 5))
        out[pos:pos + ln] += (click * env * 2.5).astype(np.float32)
    return out


def speech_like(dur, sr=SR):
    """从 real 素材取一段真实语音"""
    src = os.path.join(OUT, "clean48.wav")
    if os.path.exists(src):
        x, _ = sf.read(src, dtype="float32")
        if x.ndim > 1:
            x = x.mean(1)
        n = int(dur * sr)
        if len(x) < n:
            x = np.tile(x, int(np.ceil(n / len(x))))
        return x[:n].copy()
    raise FileNotFoundError("需要先跑 make_testset_real.py")


def mix(*sigs, gains=None):
    n = max(len(s) for s in sigs)
    out = np.zeros(n, np.float32)
    for i, s in enumerate(sigs):
        g = gains[i] if gains else 1.0
        out[:len(s)] += s * g
    return out


def main():
    os.makedirs(OUT, exist_ok=True)
    DUR = 6.0

    print("生成啸叫测试信号 ...")
    sp = speech_like(DUR)
    # 啸叫在 1.2 kHz（常见反馈频点）+ 3.8 kHz（谐波）
    h1 = howl(DUR, 1200)
    h2 = howl(DUR, 3800) * 0.6
    howl_only = mix(h1, h2)
    sf.write(f"{OUT}/howl_only.wav", howl_only / max(1e-9, np.abs(howl_only).max()) * 0.6,
             SR, subtype="PCM_16")
    sf.write(f"{OUT}/speech_plus_howl.wav",
             mix(sp, h1, h2, gains=[0.7, 0.25, 0.15]), SR, subtype="PCM_16")
    # 参考：同样语音但无啸叫（用于验证抑制后是否恢复）
    sf.write(f"{OUT}/speech_only_ref.wav", sp * 0.7, SR, subtype="PCM_16")

    print("生成键盘测试信号 ...")
    kb = keyboard(DUR, int(DUR * 8))  # 每秒 8 次，接近快速打字
    sf.write(f"{OUT}/keyboard_only.wav", kb / max(1e-9, np.abs(kb).max()) * 0.5,
             SR, subtype="PCM_16")
    sf.write(f"{OUT}/speech_plus_keyboard.wav",
             mix(sp, kb, gains=[0.6, 0.5]), SR, subtype="PCM_16")

    print("生成三合一（啸叫 + 键盘 + 语音）...")
    sf.write(f"{OUT}/speech_plus_all.wav",
             mix(sp, h1, kb, gains=[0.6, 0.2, 0.35]), SR, subtype="PCM_16")

    print("\n=== 频谱检查 ===")
    from scipy.signal import welch
    for name in ["howl_only", "keyboard_only", "speech_plus_howl", "speech_plus_keyboard"]:
        x, _ = sf.read(f"{OUT}/{name}.wav", dtype="float32")
        f, P = welch(x, fs=SR, nperseg=4096)
        # 找峰值
        pk = f[np.argmax(P)]
        print(f"  {name:22s} 主峰 {pk:7.0f} Hz  rms {20*np.log10(np.sqrt(np.mean(x**2))+1e-12):6.1f} dBFS")


if __name__ == "__main__":
    main()
