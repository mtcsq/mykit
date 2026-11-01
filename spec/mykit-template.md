# mykit-template/0.1 · 包契约

> 比 `motiongit-template` 更严的一条自有契约。目标是：一个包丢给内核，内核就能判断"能不能安全渲染"，
> 不需要读源码，也不需要联网。

## 1. 包结构

```
<package>/
├─ motion.json          必需：主清单
├─ params.schema.json   必需（可在 motion.json 里改名）
├─ presets/             必需：至少一个可直接渲染的预设
├─ guide.json           强烈建议：给 AI 的六段式说明书
├─ LICENSE              必需：与 template.license 一致
├─ integrity.json       必需：SHA-256 闭包
└─ src/                 实现（入口由 runtime.entry 指定）
```

## 2. motion.json

```json
{
  "format": "mykit-template",
  "specVersion": "0.1.0",
  "template": { "id": "ops-replay", "version": "1.0.0", "name": "绘图指令重放", "license": "MIT" },
  "runtime":  { "profile": "html/canvas", "entry": "src/index.html" },
  "output":   {
    "width": 1920,
    "height": 1080,
    "fps": { "num": 30, "den": 1 },
    "duration": { "policy": "fixed", "seconds": 8, "maxSeconds": 60 }
  },
  "parameters": { "schema": "params.schema.json", "defaultPreset": "presets/demo.json" },
  "guide": "guide.json",
  "permissions": { "network": false },
  "integrity": "integrity.json"
}
```

| 字段 | 约束 | 为什么 |
|---|---|---|
| `format` | 必须 `mykit-template` | 与 `motiongit-template` 区分，避免误认 |
| `specVersion` | 必须 `0.1.0` | 内核按版本决定校验强度 |
| `template.id` | 小写字母数字与连字符 | 用于实例目录、缓存键 |
| `template.version` | 语义化版本 | 用于缓存与升级判断 |
| `template.license` | `MIT` / `Apache-2.0` / `BSD-3-Clause` / `ISC` / `CC0-1.0` | 开源体系只接受这几种；MIT 必须带 LICENSE 文件 |
| `runtime.profile` | `html/canvas` 或 `html/dom` | 只承诺这两条路径（见 profiles.md） |
| `runtime.entry` | 包内 `/` 相对路径 | 允许 `src/index.html` 之外的布局（原生态有 3 种入口形态） |
| `output.width/height` | 正整数且为偶数 | h264 + yuv420p 要求 |
| `output.fps` | `{num, den}` 正整数 | 支持 29.97 这类非整数帧率 |
| `output.duration.policy` | `fixed` / `fit-voiceover` / `fit-content` | 原生态 57 个包里有 18 个是动态时长，固定帧数表达不了 |
| `output.duration.seconds` | policy=fixed 时必填 | 帧数由内核算：`round(seconds × num / den)` |
| `output.duration.maxSeconds` | 动态时长必填 | 防止配音缺失时无限长 |
| `permissions.network` | **必须 false** | 离线可渲染是这套体系的硬约束 |
| `integrity` | 指向清单文件 | 内容被改动能被发现 |

## 3. 参数与预设

- `params.schema.json`：JSON Schema（draft 2020-12），`type: "object"`，用 `required` 声明必填
- `presets/*.json`：必须满足 schema 的 `required`；`defaultPreset` 是"不指定输入就能出片"的那份
- 参数只允许"文案 / 颜色 / 简单开关"这类可被非设计者安全替换的值；不要把布局参数暴露给用户

## 4. guide.json（六段式）

原生态 57 个包的事实标准，删掉它就等于让 AI 无法替你问用户。六段：

```json
{
  "fit":       { "summary": "一句话说明", "genres": [], "goodFor": [], "notFor": [], "placement": "opening" },
  "duration":  { "policy": "fixed", "min": 8, "max": 8, "default": 8 },
  "materials": [{ "role": "audio.music", "required": false, "use": "", "prepare": "", "ifMissing": "", "ask": "" }],
  "copy":      [{ "param": "title", "label": "标题", "from": ["conversation"], "rule": "长度 1–18" }],
  "conversation": ["先说明这是什么，再收集文案"],
  "hostWithoutTools": ["不能执行渲染时：交付 inputs 与源码，本机用 Node + Chromium + FFmpeg 渲染"]
}
```

## 5. integrity.json

```json
{ "algorithm": "sha256", "files": { "src/index.html": "…64 hex…" } }
```

- 覆盖包内除 `integrity.json` 自身以外的全部文件
- 路径用 `/` 分隔、键排序，同样内容在任何机器上产出一致
- 生成：`mykit integrity build --package <dir>`；校验：`mykit integrity verify --package <dir>`

## 6. 确定性要求（写进契约，不是建议）

模板必须满足：**同一 `frame` + 同一 `inputs` ⇒ 同一画面**。

- 不许读墙钟（`Date.now / performance.now`）、不许 `Math.random`
- 需要随机感时用 `hash(n) = frac(sin(n×127.1+311.7)×43758.5453)` 这类值噪声
- 字体必须在 `window.__MYKIT_READY` 之前加载完（内核也会额外等 `document.fonts.ready` 兜底）

分路径的保证强度（实测，2026-11-01）：

| profile | 保证 | 判定方式 |
|---|---|---|
| `html/canvas` | 逐字节确定（隔离跑 / 重复跑 / 换顺序跑，sha256 相同） | 可直接比 sha256 |
| `html/dom` | 重复跑一致；换顺序跑有 PSNR ≈ 52 dB 的微差 | 用 PSNR ≥ 48 dB 判定 |

## 7. 单文件分发（ZIP）

`mykit pack --package <dir> --out x.mykit` 打成单文件，`mykit render --package x.mykit` 直接渲染
（`verify` / `still` 同样接受 zip）。

- 只支持 store / deflate，不加密、不签名
- 时间戳固定为 1980-01-01，条目排序 → **同样内容打出来的包字节一致**（可复现构建）
- 解包按内容哈希落到 `.tmp/packages/<sha256前12位>`，同包复用

读取边界（防御 zip bomb）：

| 限制 | 值 |
|---|---|
| 条目数 | ≤ 5000 |
| 单文件解压后 | ≤ 150 MiB |
| 解压总量 | ≤ 600 MiB |
| 压缩比（>10 MiB 的文件） | ≤ 200 |
| 条目名 | 禁止 `..` / 绝对路径 / 盘符 / 反斜杠 |

## 8. 未实现（诚实标注）

- **签名 / 加密**：不做，也不打算做（开源体系不需要）
- **多 profile**：只 `html/canvas`、`html/dom`；`native-python-node`、`remotion-project` 不承诺
- **外层信封**：只解一层 ZIP；原生态的"外层信封 + 内层 release.bin"嵌套结构不处理
