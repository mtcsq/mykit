# mykit

零依赖的视频模板渲染器：headless Chrome + DevTools 协议 + FFmpeg。

**状态**：已开源发布 [v0.1.0](https://github.com/mtcsq/mykit/releases/tag/v0.1.0) · MIT · 无任何 dependencies。

## 为什么做

现有模板生态的**格式是开放的，生态是封闭的**：57 个真实包里只有 28 个给了源码，另 28 个是加密核心；
官方称 72 个模板"开源"，真正包含源码的只有 1 个；升级、校验、渲染工具都由平台下发，脱离平台就跑不动。

把出片能力建在别人的包和别人的渲染器上，等于把交付能力抵押出去。所以自建，并且开源——
开源不只是姿态，它是唯一能证明"不受制于人"的方式：代码可读、可改、可脱离平台运行、可被别人接手。

## 定位约束（不满足就是走歪了）

1. **零运行时依赖、零外部服务**：不连 API、不要账号或 Key、断网可用
2. **MIT**：内核、契约、模板全部 MIT；字体用 OFL；不引入 GSAP 这类非 MIT 运行时
3. **契约独立但能读别人的包**：自有 `mykit-template/0.1` 更严，同时能只读跑 `motiongit-template` 的包做回归
4. **不复用一行业务代码**：只借鉴架构思路，参考处文件头注明出处

## 用法

```bash
node src/cli.mjs doctor                                  # 体检：node / 浏览器 / ffmpeg / 内置 WebSocket
node src/cli.mjs verify --package templates/ops-replay    # 契约检查
node src/cli.mjs conformance --template templates/ops-replay  # 无状态性检查（并发前提）
node src/cli.mjs still  --template templates/ops-replay --frame 120 --out f120.jpg
node src/cli.mjs render --template templates/ops-replay --out out.mp4
node src/cli.mjs render --template templates/ops-replay --out out.mp4 --audio bgm.mp3
node src/cli.mjs pack   --package templates/ops-replay --out ops-replay.mykit
node src/cli.mjs render --package ops-replay.mykit --out out.mp4   # 直接从单文件渲染
```

不需要 `npm install`——没有任何 dependencies。需要 Node 22+、Chrome/Edge、ffmpeg/ffprobe。

## 文档

- [spec/mykit-template.md](spec/mykit-template.md) —— 包契约（字段、确定性要求、ZIP 边界）
- [spec/profiles.md](spec/profiles.md) —— `html/canvas` 与 `html/dom` 的能力矩阵与测试要求
- [templates/ops-replay](templates/ops-replay) —— 第一个自有模板（绘图指令重放）

## 状态

- [x] Phase 0 骨架 + `doctor`
- [x] Phase 1 CDP 客户端 + 自适应 ready（5 种信号全命中）
- [x] Phase 2 单帧渲染（实测决定 canvas / dom，不看 profile 声明）
- [x] Phase 3 串行编码（873：254 帧 / 1080p / 30fps / bt709）
- [x] Phase 4 并发分片（canvas 靶子串行 vs 4 worker 画面 MD5 相同）
- [x] Phase 5 契约 + `verify` + `integrity`
- [x] Phase 6 自有模板 `ops-replay`（240 帧 / 34.6 帧每秒 / 逐字节确定）
- [x] 音轨挂载 `--audio`
- [x] ZIP 单文件分发（`pack` / `unpack` / 直接从 zip 渲染）
- [x] 开源发布 v0.1.0

## 已知的坑（实测）

- **profile 声明不可信**：873 写 `html-canvas/1`，页面 canvas 数为 0，必须实测探测
- **确定性分级**：canvas 路径逐字节一致；dom 路径换顺序跑有 PSNR ≈ 52 dB 微差，只能按容差判定
- **必须等字体**：`font-display:block` 的模板不等 `document.fonts.ready` 会缺字
- **并发有启动成本**：每 worker ≈ 5–6 秒，帧数 < 400 用串行更快
- **并发还有前置条件**：模板必须声明 `runtime.stateless: true` 并过 `mykit conformance`；否则内核强制串行
- **"字节一致"不是承诺**：字形缓存造成 55–60 dB 抖动；真实状态依赖会掉到 26–39 dB

## 许可

MIT，见 [LICENSE](LICENSE)。
