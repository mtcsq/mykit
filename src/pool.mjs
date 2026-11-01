/**
 * 并发分片渲染。
 *
 * 结论来自 895 的实测：一个浏览器里的多个页面共用 GPU 进程，WebGL 会排队，
 * 所以必须「一个 worker 一个浏览器进程」；帧分配用轮转（j = w; j += workers），比连续区间更均衡。
 * 帧落盘后由 ffmpeg 从序列编码，天然支持断点续跑。
 *
 * 计时分两段：setupMs（启动 + 导航 + 等字体图片）与 renderMs（纯出帧）。混在一起会把
 * 启动开销算进渲染速度——第一次实测就是这么被误导的。
 */
import fs from 'node:fs';
import path from 'node:path';
import { launch, waitForReady, awaitAssets, awaitSettle } from './cdp.mjs';
import { renderFrame, capture, detectShape } from './frame.mjs';

export function frameFile(dir, frame) {
  return path.join(dir, 'f' + String(frame).padStart(5, '0') + '.jpg');
}

export async function renderShards(options) {
  const {
    executable,
    origin,
    pagePath,
    width,
    height,
    total,
    workers,
    dir,
    declaredShape,
    inputs,
    quality = 0.93,
    resume = true,
    log = () => {},
  } = options;

  fs.mkdirSync(dir, { recursive: true });

  const todo = [];
  let skipped = 0;
  for (let frame = 0; frame < total; frame += 1) {
    if (resume && fs.existsSync(frameFile(dir, frame))) skipped += 1;
    else todo.push(frame);
  }

  const empty = { frames: total, workersInfo: [], skipped, setupMs: 0, renderMs: 0 };
  if (!todo.length) return empty;

  const pageCount = Math.min(workers, todo.length);
  const setupStarted = Date.now();
  const pages = [];
  const workersInfo = [];

  for (let i = 0; i < pageCount; i += 1) pages.push(await launch({ executable, width, height }));

  try {
    await Promise.all(
      pages.map(async (page, w) => {
        await page.navigate(origin + '/' + pagePath);
        const ready = await waitForReady(page);
        await awaitAssets(page);
        const detected = await detectShape(page, declaredShape);
        workersInfo.push({ worker: w, ready: ready.signal, shape: detected.shape, reason: detected.reason });
        page.__shape = detected.shape;
      }),
    );

    const setupMs = Date.now() - setupStarted;
    const renderStarted = Date.now();
    let done = 0;

    await Promise.all(
      pages.map(async (page, w) => {
        for (let j = w; j < todo.length; j += pages.length) {
          const frame = todo[j];
          await renderFrame(page, frame, inputs);
          if (page.__shape === 'dom') await awaitSettle(page);
          const shot = await capture(page, { path: page.__shape, quality });
          fs.writeFileSync(frameFile(dir, frame), shot.bytes);
          done += 1;
          if (done % 30 === 0) {
            const elapsed = (Date.now() - renderStarted) / 1000;
            log('  ' + done + '/' + todo.length + ' 帧，' + (done / elapsed).toFixed(1) + ' 帧/秒');
          }
        }
      }),
    );

    return { frames: total, workersInfo, skipped, setupMs, renderMs: Date.now() - renderStarted };
  } finally {
    for (const page of pages) await page.close();
  }
}
