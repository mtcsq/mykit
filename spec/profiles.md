# profile 能力矩阵

## html/canvas

| 项 | 要求 |
|---|---|
| 导出 | `window.renderFrame(frame, inputs)`；`window.__MYKIT_READY = true`（或 `__MOTION_READY` / `ready` / `READY` / `__readyPromise` 任一） |
| 画面载体 | 页面上至少一个面积 > 0 的 `<canvas>` |
| 取帧方式 | `canvas.toDataURL('image/jpeg', q)`（内核取面积最大的 canvas） |
| 确定性 | 同一会话内重复渲染同帧：字节一致；**跨会话会有 ~55–60 dB 的字形抗锯齿轮动**（字节不同、肉眼无差） |
| 并发 | 仅在模板声明 `runtime.stateless: true` 且通过 `mykit conformance` 后允许 |
| 典型来源 | 869（K 线）、892（水墨）、869 式绘图指令重放 |

## html/dom

| 项 | 要求 |
|---|---|
| 导出 | 同上 |
| 画面载体 | DOM + CSS（可含 canvas 背景层） |
| 取帧方式 | `Page.captureScreenshot` |
| 确定性 | 重复跑一致；换渲染顺序有 ~52 dB 微差 |
| 并发 | 帧级等价但不是逐字节等价；判据 PSNR ≥ 45 dB |
| 典型来源 | 873（拼贴，声明 html-canvas 却零 canvas）、626 系 |

**注意 1**：`runtime.profile` 只是"作者意图"，内核在 ready 后会实测探测（`detectShape`），
声明 canvas 但页面没有 canvas 时自动降级为 dom 并在报告里标 `shapeReason`。

**注意 2（2026-11-01 实测修正）**：canvas 路径**不等于**"无状态"。892_ink-saga 把墨迹画在累积画布上，
连续渲染 0→140 得到的第 140 帧与孤立渲染差 26.9 dB，并发分片会与串行不一致。
因此并发不是默认能力，而是需要 `runtime.stateless: true` + `mykit conformance` 通过后才能打开。

## 判定尺度（由实测标定）

| 现象 | PSNR | 含义 |
|---|---|---|
| 同一会话重复渲染 | ∞（字节一致） | 预期行为 |
| 跨会话、字形缓存冷热差 | 55–60 dB | 可接受噪声，不是状态依赖 |
| 真实状态依赖（累积画布） | 26–39 dB | **必须拦住**，禁止并发 |

`mykit conformance` 默认阈值 45 dB，正好把后两者分开。

## 测试要求（新增 profile 时必须补）

1. 单帧：`mykit still` 两次，两张图存在且不同（排除黑屏/错位）
2. 确定性：`node test/determinism.mjs --template <dir> --frame <n> --prev <n-1>`
3. 整片：`mykit render` 的 `nb_frames / 分辨率 / fps / bt709` 与 motion.json 一致
4. 并发（仅 canvas）：`--workers 4` 与串行画面 MD5 相同

## external/adapter

给"用别的工具链渲染"用的 profile。内核不认任何具体工具，只认一个约定。

| 项 | 要求 |
|---|---|
| 声明 | `runtime.profile = "external/adapter"`，`runtime.adapter.command` 必填，`runtime.adapter.args` 可选 |
| 占位符 | `{start}` `{end}` `{out}` `{inputs}` `{template}` |
| 产出 | 在 `{out}` 目录写 `fNNNNN.jpg` 或 `fNNNNN.png`（5 位补零），覆盖 `[start, end)` |
| 约定 | 退出码 0 = 成功；缺帧会被内核判失败并列出缺哪几帧 |
| 工作目录 | 内核把 cwd 设为包目录，适配器可以用相对路径引用自己的脚本 |
| 确定性 | 适配器自己保证；内核用 `test/determinism.mjs` 验（实测示例包 byteExact=true） |

为什么这样设计：原生态的 `native-python-node/1`（3 个包）和 `remotion-project/1`（1 个包）如果逐个写死支持，
内核就要依赖 Python、懂 Remotion 的打包，违反零依赖。改成协议后，任何工具链都能接，内核一行不改。

参考实现（两套，工具链完全不同）：

- `templates/external-demo/adapter.py` —— Python 标准库手写 PNG，48 帧 640×360，确定性 byteExact=true
- `templates/ffmpeg-demo/adapter.mjs` —— FFmpeg 滤镜图出图，48 帧；**分片渲染 + 拼装与整跑 MD5 完全相同**

Remotion 类工程的接法见 `docs/adapter-remotion.md`（未验证，需 npm 依赖）。
