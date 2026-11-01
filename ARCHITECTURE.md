# mykit 架构设计与技术选型

> 本文件记录"为什么这样搭"，以及**被实测否掉的方案**。决策都会回写到 `spec/` 与代码注释。

## 1. 问题拆解

把"模板 → 视频"拆成五个互相独立的决策点，任何一层选错都会在别处返工：

| 决策点 | 选项空间 | 我们的选择 |
|---|---|---|
| 时间模型 | 实时播放 / 帧号求值 / 生成器协程 | **帧号求值**：`renderFrame(frame, inputs)`，`t = frame × den / num` |
| 画面载体 | Canvas / DOM+CSS / 自绘合成 / SVG | **两者都收**：`html/canvas`、`html/dom` |
| 取帧 | `toDataURL` / `captureScreenshot` / screencast / 手工重建 | **按实测分流**前两者，screencast 与重建被否 |
| 编码 | FFmpeg CLI / 库绑定 / 浏览器 WebCodecs | **FFmpeg CLI 管道** |
| 调度 | 串行 / 多实例分片 / 分布式 | **多实例分片**，短片自动串行 |

## 2. 同类项目横向（研究结论）

| 项目 | 架构 | 值得借鉴 | 不适合我们的地方 |
|---|---|---|---|
| **Remotion**（服务端渲染） | React 组件即时间函数；headless Chromium 逐帧截图；`delayRender()/continueRender()` 显式等待异步资源；并发 = 多 tab 分帧 | ①"组件是 `frame` 的纯函数"这条契约 ②延迟渲染计数器（比"猜什么时候好了"可靠） ③并发按帧区间切分 | 绑 React 与浏览器打包链；新版本引入 Rust compositor 与自有编码器，依赖面比我们允许的大 |
| **Remotion**（客户端渲染） | 不截图：遍历 DOM、算出每个元素位置、把可捕获元素画进 canvas | 说明"不靠浏览器截图"是可选路线 | 只支持 CSS 子集，必须逐个复刻布局与文字排印；我们的模板已是浏览器原生页面，重建等于自找偏差 |
| **Motion Canvas** | 生成器函数 `yield*` 描述时间；Vite 实时预览；**场景可在任意时刻求值** | ①"时间可任意求值"是确定性渲染的前提 ②预览与渲染共用同一场景图 | TS + 构建链；面向手工编舞，不适合"参数化模板 + AI 编排" |
| **Revideo** | Motion Canvas 的服务端渲染分支 | 同上的时间可求值 | 同上 |
| **Editly** | 声明式 JSON → FFmpeg filter graph，无浏览器 | 无浏览器路径最稳、最快 | 表达力停在"剪辑层"：做不了自定义动效 |
| **Satori** | JSX/HTML → SVG，无浏览器 | 纯函数式布局，输出可缓存 | CSS 子集限制，动态效果要另找方案 |
| **原 MotionGit 生态** | `renderFrame(frame, inputs)` + Playwright + FFmpeg | 帧接口签名（57 个包的事实标准） | Playwright 依赖；工具链随包下发、脱离平台不可用 |

**结论**：帧号求值 + 浏览器原生渲染 + FFmpeg 是这批项目里唯一同时满足"表达力上限高"和"依赖面为零"的组合；
Remotion 的"延迟渲染计数器"与 Motion Canvas 的"时间可任意求值"是我们应当补上的两条契约细节。

## 3. 决策记录

### ADR-1 时间模型：帧号求值，不读墙钟
理由：并发分片要求任意帧可独立求值；实测 873/869/892/895 四个真实模板都是纯 `t` 求值（895 只是用 rAF 推进预览）。
代价：模板作者不能写"每帧 +1px"这种增量逻辑。已写进 `spec/mykit-template.md` 第 6 节。

### ADR-2 取帧：实测探测，不信 `profile` 声明
反例：873 声明 `html-canvas/1`、页面 canvas 数为 0。若按声明走，每帧白跑一次 `toDataURL` 再回落。
实现：`detectShape()` 在 ready 后探测最大 canvas 面积，只在声明与实测都为 canvas 时走 `toDataURL`。

### ADR-3 零依赖：只允许 Node 内置 + 系统 Chrome/FFmpeg
代价：不能直接用 Playwright/Puppeteer 的成熟封装（需自己写 CDP 客户端，约 200 行）。
收益：`git clone` 后无需安装即可运行；不会被某个 npm 包的安全公告或大版本升级拖住。

### ADR-4 就绪信号自适应
四个真实包四种写法（`__MYKIT_READY` / `__MOTION_READY` / `__readyPromise` / `ready` / `READY`）。
另加两条兜底：`document.fonts.ready`（873 用 `font-display:block`，不等就缺字）与图片 `complete`。
**下一步**：补 Remotion 式 `__MYKIT_PENDING` 计数器，让模板能声明"还有 N 个异步资源"。

### ADR-5 确定性分级（v2，2026-11-01 修正）
原先的判断（"canvas 路径逐字节确定"）**只在短序列上成立**，已推翻。实测：

| 现象 | PSNR | 结论 |
|---|---|---|
| 同一会话重复渲染同一帧 | ∞（字节一致） | 预期 |
| 跨会话渲染同一帧（字形缓存冷热不同） | 55–60 dB | 不可消除的抖动，字节不同、肉眼无差 |
| 连续渲染 0→140 后取第 140 帧 vs 孤立渲染 | 26.9 dB | 真实状态依赖（892 的累积墨迹） |

因此：**不对任何 profile 承诺字节等价**。判据统一为 PSNR，阈值 45 dB——正好把"抖动"和"状态依赖"分开。

### ADR-9 并发是有前置条件的
并发分片只在模板 `runtime.stateless === true` 且通过 `mykit conformance` 后打开；
否则 CLI 强制串行并在报告里写 `workersFallback` 原因。
理由：状态依赖模板并发后画面会错，而错误只在特定帧区间显现（892 是第 133 帧之后），肉眼与短样例都发现不了。

### ADR-6 并发：短片串行，长片分片，且必须过一致性检查
每 worker 固定成本 ≈ 5–6 s（启动 + 导航 + 字体）。实测 120 帧：串行 7.2 s，4 worker 墙钟 27.4 s（更慢）；
长片 4 worker 吞吐 ≈ 43 帧/秒 vs 串行 ≈ 17 帧/秒。阈值取 400 帧。
调度已从静态轮转改为**共享任务队列**（work stealing），消除帧成本不均时的空转。

### ADR-7 编码：FFmpeg CLI + 显式色彩链
`crf 18 / preset veryfast / yuv420p / bt709(tv) / faststart`，并在 `-frames:v` 上钉死帧数，防止管道读多写多。
色彩链（sRGB → BT.709 限幅）直接沿用 626 的实测参数，不做二次发明。

### ADR-8 分发：单个 ZIP，可复现构建
条目排序 + 固定时间戳（1980-01-01）→ 同一目录打两次字节相同（实测 sha256 一致）。
读取侧四道边界（条目 5000 / 单文件 150 MiB / 总量 600 MiB / 压缩比 200）+ 条目名禁令，防 zip bomb 与路径穿越。

### ADR-10 外部工具链用协议接入，不写死支持
原生态的 `native-python-node/1`、`remotion-project/1` 如果写死，内核就得依赖 Python 与 Remotion 打包链。
改成 `external/adapter`：包自己提供适配器，内核只负责切帧区间、等退出、编码。
实测 `templates/external-demo`（Python 标准库写 PNG）：48 帧 / 640×360 / 两次渲染 MD5 相同 / 确定性 byteExact=true。

### ADR-11 跨机不造调度器，改为"可分片 + 可拼装"
`--range a-b --no-encode` 让任意进程/机器只渲染一段并落盘；`mykit encode --frames-dir` 负责拼装。
实测：自有模板分两段各跑一次（36.9 / 29.7 帧/秒），拼装得到 240 帧 1080p，与整跑 PSNR 51.17 dB（差异来自 ADR-5 的跨会话抖动）。
这样分布式渲染不需要中心调度器，也不需要内核知道有"集群"这回事。

## 4. 被否掉的方案（附实测）

| 方案 | 否定理由 | 证据 |
|---|---|---|
| **CDP 批量取帧**（一趟 evaluate 连出 K 帧的 dataURL） | 往返不是瓶颈，瓶颈是页面绘制本身 | 892 前 120 帧：batch=1 → 15.37 帧/秒，batch=8 → 15.23 帧/秒（无收益）；自有模板 29.76 → 31.12（+4.6%，不值复杂度）。两版成片 MD5 相同，说明只影响速度不影响像素 |
| **`Page.startScreencast`** | 帧率由浏览器合成器决定，页面不变就不发帧，拿不到"每帧恰好一张" | 社区实录：6 秒只拿到 60 帧，且丢帧不可控 |
| **DOM → Canvas 手工重建**（Remotion 客户端渲染路线） | 需复刻布局与文字排印，CSS 子集限制；我们本来就跑浏览器原生渲染 | 架构对比表 |
| **Playwright / Puppeteer** | 违背零依赖（626 就因此不可直接复用） | 626 的 `render.mjs` 第 1 行 `require('playwright-core')` |
| **GSAP 做动效** | 非 MIT，违反定位约束 2 | 873 只是把 GSAP 放进包里，我们不用 |
| **内置音频合成器** | 需要 numpy/scipy 那一套，跨平台成本高；40/57 模板只需要"挂一条音轨" | v1 只做 `--audio` 挂载，实测 h264+aac 输出正常 |

## 5. 已消化 / 仍缺

已解决（本轮）：

1. ✅ **动态时长落地**：`fit-voiceover` 由音频时长算帧数并按 `maxSeconds` 夹紧；缺音频时给出可执行报错
2. ✅ **调度改为共享队列**：静态轮转 → work stealing
3. ✅ **状态依赖可检出**：`mykit conformance`（串行段 vs 孤立帧，PSNR 判据），并发前强制

仍缺（按优先级）：

1. ~~资源计数契约~~ 已实现 `__MYKIT_PENDING`（数字或 Promise），fixture 实测等待 1194 ms
2. ~~两条 profile~~ 改为 `external/adapter` 协议（ADR-10），Python 适配器已验证
3. ~~跨机分布式~~ 改为分片 + 拼装（ADR-11），两段渲染 + `encode` 已验证
4. **conformance 成本偏高**：601 帧片段约 2 分 52 秒
5. **适配器生态为零**：只有示例包，真实第三方适配器还没人写
