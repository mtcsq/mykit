# profile 能力矩阵

## html/canvas

| 项 | 要求 |
|---|---|
| 导出 | `window.renderFrame(frame, inputs)`；`window.__MYKIT_READY = true`（或 `__MOTION_READY` / `ready` / `READY` / `__readyPromise` 任一） |
| 画面载体 | 页面上至少一个面积 > 0 的 `<canvas>` |
| 取帧方式 | `canvas.toDataURL('image/jpeg', q)`（内核取面积最大的 canvas） |
| 确定性 | 逐字节确定 |
| 并发 | 安全：多浏览器分片与串行结果 **sha256 完全相同**（892 实测） |
| 典型来源 | 869（K 线）、892（水墨）、869 式绘图指令重放 |

## html/dom

| 项 | 要求 |
|---|---|
| 导出 | 同上 |
| 画面载体 | DOM + CSS（可含 canvas 背景层） |
| 取帧方式 | `Page.captureScreenshot` |
| 确定性 | 重复跑一致；**换渲染顺序有微差**（PSNR ≈ 52 dB），因此验收用容差 |
| 并发 | 帧级等价，但不是逐字节等价；判据用 PSNR ≥ 48 dB |
| 典型来源 | 873（拼贴，声明 html-canvas 却零 canvas）、626 系 |

**注意**：`runtime.profile` 只是"作者意图"，内核在 ready 后会实测探测（`detectShape`），
声明 canvas 但页面没有 canvas 时自动降级为 dom 并在报告里标 `shapeReason`。

## 测试要求（新增 profile 时必须补）

1. 单帧：`mykit still` 两次，两张图存在且不同（排除黑屏/错位）
2. 确定性：`node test/determinism.mjs --template <dir> --frame <n> --prev <n-1>`
3. 整片：`mykit render` 的 `nb_frames / 分辨率 / fps / bt709` 与 motion.json 一致
4. 并发（仅 canvas）：`--workers 4` 与串行画面 MD5 相同
