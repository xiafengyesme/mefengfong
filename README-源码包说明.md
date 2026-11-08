# FONG 0.4.74 源码包 · 说明

生成时间：2026-11-08 23:35
用途：给外部审查者定位音频/降噪问题。**已剔除** node_modules、dist 构建产物、编译好的 exe/dll、渲染器备份文件。

---

## 目录

```
client/                  Electron 客户端（正在跑的版本，源码最新）
  renderer.js            主渲染进程，4300+ 行；Mic / Room / 采集链都在这里
  denoise-worklet.js     AudioWorklet：攒块 → SAB 输入环 → 消费输出环
  denoise-worker.js      Web Worker：阻塞在 Atomics.wait，调 native 推理
  denoise-renderer.js    Worker 的管理层（创建/重绑/命令下发）
  aec-ref-worklet.js     AEC far-end 参考环采集
  vad-gate-worklet.js    VAD 门控
  main.js / preload.js   主进程与桥
  resources/gtcrn_light48_stream.onnx   GTCRN 模型（48k 单声道）
  native/fong-native/    .node 编译产物（Rust 绑定，源码在 rust/）

server/                  Go 服务端（api.go 单文件为主）

rust/                    DSP 与语音的 Rust 源码（真正干活的地方）
  dsp/src/aec.rs         AEC
  dsp/src/gtcrn48.rs     GTCRN 48k 降噪
  dsp/src/light.rs       RNNoise 轻量档
  dsp/src/specsub.rs     谱减
  dsp/src/transient.rs   瞬态处理
  dsp/src/howl.rs        啸叫抑制
  dsp/src/lowlatency.rs  低延迟路径
  voice/                 语音链路
```

---

## 正在排查的问题（用户实际反馈）

```
1. 用一会儿之后开始爆音 / 卡麦 / 电音，重启应用可恢复
2. 切换降噪档位时卡一下
3. 低配机器上更严重
```

## 已知的架构参数（怀疑点）

```js
// denoise-worklet.js
const BLOCK = 480;        // 48k 下 10ms。注意：不是 Chromium 回调 128 的整数倍
const OUT_SLOTS = 12;     // 输出环 = 120ms
const IN_SLOTS  = ?;      // 见文件头
```

数据流：

```
麦克风 → worklet 攒 BLOCK 样本 → 写 SAB 输入环 → Atomics 通知
      → Worker 阻塞唤醒 → native 推理 → 写 SAB 输出环 → outWrite++
      → worklet 每 BLOCK 样本从输出环取一块输出
```

**怀疑点（尚未验证）**

- 正常路径没有“积压追平”：输出环一旦被顶到 12 块（120ms），worker 会开始丢输入（`dropped++`），但没有任何机制把它拉回实时
- 旁路路径有追平（`outRead = outWrite`），正常路径没有
- 饥饿时输出 `this.last`（整块恒定值）→ DC 台阶，可能是咔哒声来源
- `BLOCK=480` 与回调 128 不同步，攒块相位每次都漂

**已有的观测量**（在 native stats 里）

```
sent / dropped / underruns / calls
```

建议先看这三个数的增速，再决定改哪里。

---

## 对照参考：KOOK 0.112 的做法（已实测挖出）

```
传输   声网 Agora（agora_rtc_sdk.dll 32MB）
降噪   声网 ai_denoiser_module.wasm 2.8MB，端侧 AudioWorklet 内联跑
采样率 16kHz 单声道（input_16000hz_1ch / ns_out / agc_out）
帧长   128 样本
饥饿   直通原始输入（不循环、不补零）
切档   AINS Hotrestart（清历史帧），不重建链路
看门狗 处理落后 > 预期 2 倍即 reset，> 5% 迟滞即上报事件
```

关键差异：**KOOK 跑 16k，本项目跑 48k（同等工作量差 3 倍）**。

---

## 跑起来

```
client:  npm i && npm start        （需要 node_modules，本包未含）
server:  go build -o fong-sfu .    （-data 指定数据文件）
rust:    cargo build --release     （在 rust/dsp 下）
```

无外部私有依赖，标准 Electron + Go + Rust。
