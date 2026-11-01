# 用 Remotion 接入 external/adapter（参考写法，未在本仓库验证）

> 状态：**未验证**。本仓库不装 npm 依赖，所以这份只是一个可行的适配器骨架；
> 用之前请自己跑一遍 `--frames 0-24` 确认帧号与内容对得上。

Remotion 的工程本身就是"帧号 → 画面"的函数，所以适配器很薄：把区间翻译成 `renderFrames` 调用即可。

```js
// adapter.mjs（放在 Remotion 工程根目录）
import path from 'node:path';
import { bundle } from '@remotion/bundler';
import { renderFrames, selectComposition } from '@remotion/renderer';

const [start, end] = String(argValue('--frames')).split('-').map(Number);
const outDir = path.resolve(argValue('--out'));
const inputs = JSON.parse(fs.readFileSync(argValue('--inputs'), 'utf8'));

const serveUrl = await bundle({ entryPoint: path.resolve('src/index.ts') });
const composition = await selectComposition({ serveUrl, id: inputs.compositionId || 'Main' });

await renderFrames({
  serveUrl,
  composition,
  inputProps: inputs,
  outputDir: outDir,
  imageFormat: 'jpeg',
  jpegQuality: 90,
  frameRange: [start, end - 1],       // Remotion 的区间是闭区间，注意差一
  onStart: () => {},
  onFrameUpdate: () => {},
});
```

`motion.json` 里这样声明：

```json
{
  "runtime": {
    "profile": "external/adapter",
    "stateless": true,
    "adapter": {
      "command": "node",
      "args": ["adapter.mjs", "--frames", "{start}-{end}", "--out", "{out}", "--inputs", "{inputs}"]
    }
  }
}
```

## 三个必须注意的坑

1. **帧号区间差一**：Remotion 用闭区间 `[a, b]`，本协议用半开区间 `[start, end)`，转换时 `end - 1`。
2. **文件名格式**：Remotion 默认输出 `element-000.jpg` 之类，必须重命名成 `f00000.jpg`（本协议只认这个）。
3. **确定性**：Remotion 的 `<Random>`、`Date`、`Math.random` 都会破坏可复现性；装好后先跑
   `node ../../test/determinism.mjs --template <包> --frame N --prev N-1` 验一遍再上生产。

## 为什么不做成内置 profile

内置意味着内核要理解 Remotion 的打包产物、版本兼容和 `serveUrl` 生命周期——这正是"零依赖"要避免的。
适配器把这份复杂度留在包内，内核只要"切区间、等退出、编码"这三件事。
