# ops-replay · 绘图指令重放

mykit 第一个自有模板。画面是一条向量曲线被逐笔画出，圆环收束，标题以"描边转填充"的方式落位。

- profile：`html/canvas`
- 规格：1920×1080 / 30 fps / 8 秒 / 240 帧 / 固定时长
- 依赖：无（字体用系统字体栈）
- 许可：MIT

可替换参数：`title`、`subtitle`、`accent`、`ink`、`paper`（见 `params.schema.json`）。

```bash
node ../../src/cli.mjs verify --package .
node ../../src/cli.mjs still --template . --frame 120 --out ../../.tmp/ops-120.jpg
node ../../src/cli.mjs render --template . --out ../../.tmp/ops.mp4
```
