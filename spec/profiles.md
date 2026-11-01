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
