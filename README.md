# mykit

零依赖的视频模板渲染器：headless Chrome + DevTools 协议 + FFmpeg。

## 为什么做

现有模板生态的**格式是开放的，生态是封闭的**：57 个包里只有 28 个给了源码，另 28 个是加密核心；
官方称 72 个模板"开源"，真正包含源码的只有 1 个；升级、校验、渲染工具都由平台下发，脱离平台就跑不动。

把出片能力建在别人的包和别人的渲染器上，等于把交付能力抵押出去。所以自建，并且开源——
开源不只是姿态，它是唯一能证明"不受制于人"的方式：代码可读、可改、可脱离平台运行、可被别人接手。

## 定位约束（不满足就说明走歪了）

1. **零运行时依赖、零外部服务**：不连 API、不要账号或 Key、断网可用
2. **MIT**：内核、契约、模板全部 MIT；字体用 OFL；不引入 GSAP 这类非 MIT 运行时
3. **契约独立但能读别人的包**：自有 `mykit-template/0.1` 更严，同时能只读跑 `motiongit-template` 的包做回归
4. **不复用一行业务代码**：只借鉴架构想法，参考处文件头注明出处

## 用法

```bash
node src/cli.mjs doctor    # 体检：node / 浏览器 / ffmpeg / 内置 WebSocket
```

不需要 `npm install`——没有任何 dependencies。

## 状态

- [x] Phase 0 骨架 + `doctor`
- [ ] Phase 1 CDP 客户端 + 自适应 ready
- [ ] Phase 2 单帧渲染（canvas / dom 两条路径）
- [ ] Phase 3 串行编码 + 音轨挂载
- [ ] Phase 4 并发分片（一 worker 一浏览器 / 轮转 / 断点续跑）
- [ ] Phase 5 自有契约 + 静态检查
- [ ] Phase 6 第一个自有模板 `ops-replay`

完整蓝图见仓库外层的 `10-自建渲染体系-实施方案.md`（v1.1）。

## 许可

MIT，见 [LICENSE](LICENSE)。
