/**
 * 一致性检查：模板到底能不能"任意帧独立求值"？
 *
 * 背景（实测 2026-11-01）：892_ink-saga 的 canvas 模板在连续渲染 0→140 后得到的第 140 帧，
 * 与直接渲染第 140 帧相差 26.9 dB —— 它把墨迹画布当成累积状态，帧与帧之间有历史依赖。
 * 这类模板一旦并发分片，输出就和串行不同；而"逐字节一致"在短序列上又能通过，很难靠肉眼发现。
 *
 * 因此判定方法必须是：**同一次会话里连续跑 0..N 采样的结果** vs **新会话里孤立渲染同一帧**。
 * 两者一致才算 stateless，才允许并发。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { launch, waitForReady, awaitAssets, awaitSettle } from './cdp.mjs';
import { renderFrame, capture, detectShape } from './frame.mjs';

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function psnr(a, b) {
  const r = spawnSync(
    process.env.FFMPEG_PATH || 'ffmpeg',
    ['-v', 'info', '-i', a, '-i', b, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true },
  );
  const m = ((r.stderr || '') + (r.stdout || '')).match(/average:([0-9.]+)/);
  return m ? Number(m[1]) : null;
}

async function openSession(ctx) {
  const page = await launch({ executable: ctx.executable, width: ctx.width, height: ctx.height });
  await page.navigate(ctx.origin + '/' + ctx.pagePath);
  const ready = await waitForReady(page);
  await awaitAssets(page);
  const detected = await detectShape(page, ctx.shape);
  return { page, ready, shape: detected.shape };
}

async function shoot(page, shape, frame, ctx) {
  await renderFrame(page, frame, ctx.inputs);
  if (shape === 'dom') await awaitSettle(page);
  const shot = await capture(page, { path: shape, quality: ctx.quality });
  return shot.bytes;
}

/**
 * @returns {Promise<{stateless:boolean, shape:string, samples:Array, threshold:any}>}
 */
export async function checkStatelessness(ctx) {
  const dir = path.join(ctx.workDir, 'conformance');
  fs.mkdirSync(dir, { recursive: true });

  const samples = ctx.samples;
  const maxFrame = Math.max(...samples);

  // 会话 A：连续 0..maxFrame，采指定帧
  const a = await openSession(ctx);
  const serialStarted = Date.now();
  const serial = new Map();
  try {
    for (let frame = 0; frame <= maxFrame; frame += 1) {
      const bytes = await shoot(a.page, a.shape, frame, ctx);
      if (samples.includes(frame)) {
        const file = path.join(dir, 'serial-' + frame + '.jpg');
        fs.writeFileSync(file, bytes);
        serial.set(frame, { file, sha256: sha256(bytes), bytes: bytes.length });
      }
    }
  } finally {
    await a.page.close();
  }
  const serialMs = Date.now() - serialStarted;

  // 会话 B：同一个浏览器里逐帧"重载后孤立渲染"。
  // 早先是每帧新起一个浏览器（每个 ~2s 启动），5 帧就 10s 白费；重载页面同样能清空状态，成本低一个数量级。
  const isoStarted = Date.now();
  const results = [];
  const b = await openSession(ctx);
  try {
    for (const frame of samples) {
      if (results.length > 0) {
        await b.page.navigate(ctx.origin + '/' + ctx.pagePath);
        await waitForReady(b.page);
        await awaitAssets(b.page);
      }
      const bytes = await shoot(b.page, b.shape, frame, ctx);
      const file = path.join(dir, 'isolated-' + frame + '.jpg');
      fs.writeFileSync(file, bytes);
      const left = serial.get(frame);
      const same = left.sha256 === sha256(bytes);
      // 字节不同不一定是状态依赖：字形缓存/抗锯齿会带来 ~55–60 dB 的微差。
      // 真正的状态依赖（如 892 的累积墨迹）会掉到 45 dB 以下，两者可以分开。
      const value = same ? null : psnr(left.file, file);
      results.push({
        frame,
        sha256Serial: left.sha256.slice(0, 16),
        sha256Isolated: sha256(bytes).slice(0, 16),
        same,
        psnr: value === null ? null : Number(value.toFixed(2)),
      });
    }
  } finally {
    await b.page.close();
  }
  const isolatedMs = Date.now() - isoStarted;

  const minPsnr = ctx.minPsnr ?? 45;
  const threshold = 'PSNR >= ' + minPsnr + '（字节全等也算通过）';
  const stateless = results.every((r) => r.same || (r.psnr !== null && r.psnr >= minPsnr));

  const worst = results.reduce((min, r) => (r.psnr === null ? min : Math.min(min, r.psnr)), Infinity);
  return {
    stateless,
    shape: a.shape,
    threshold,
    minPsnr: worst === Infinity ? null : Number(worst.toFixed(2)),
    byteExact: results.every((r) => r.same),
    timing: { serialMs, isolatedMs, totalMs: serialMs + isolatedMs },
    samples: results,
  };
}
