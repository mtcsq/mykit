#!/usr/bin/env node
/**
 * external/adapter 的第二种实现：把"画什么"交给 FFmpeg 滤镜图，而不是自己写像素。
 *
 * 和 adapter.py 的区别：那个用标准库手写 PNG；这个用 drawbox 滤镜出图。
 * 同一个协议，两种完全不同的工具链——这就是 external/adapter 存在的意义。
 *
 * 为什么逐帧调用而不是一条滤镜图跑完整段：
 *   drawbox 的表达式里没有帧序号变量（只有 t，而分片时 t 会重置），
 *   与其跟转义和变量作用域较劲，不如在 JS 里算好坐标、每帧传确定数值——
 *   结果一样确定，分片也天然正确。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const W = 640;
const H = 360;
const FPS = 24;

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      out[argv[i].slice(2)] = argv[i + 1];
      i += 1;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (!args.frames || !args.out) {
  console.error('用法：node adapter.mjs --frames 0-48 --out <dir> [--inputs <json>]');
  process.exit(2);
}

const [start, end] = String(args.frames).split('-').map(Number);
if (!(end > start)) {
  console.error('帧区间不合法：' + args.frames);
  process.exit(2);
}

let params = {};
if (args.inputs && fs.existsSync(args.inputs)) params = JSON.parse(fs.readFileSync(args.inputs, 'utf8'));
const accent = String(params.accent || '#FF4A1C').replace('#', '0x');
const speed = Number(params.speed || 6);

const outDir = path.resolve(args.out);
fs.mkdirSync(outDir, { recursive: true });

const bin = process.env.FFMPEG_PATH || 'ffmpeg';

for (let frame = start; frame < end; frame += 1) {
  // 用绝对帧号算坐标：分片渲染与整段渲染得到同一帧的同一画面
  const phase = frame / FPS;
  const boxX = Math.round(((frame * speed) % (W - 90) + (W - 90)) % (W - 90));
  const boxY = Math.round(90 + 70 * Math.sin(phase * 6));
  const barW = Math.round(((frame * 4) % W + W) % W);

  const filter = [
    'drawbox=x=' + boxX + ':y=' + boxY + ':w=90:h=90:color=' + accent + '@1:t=fill',
    'drawbox=x=0:y=' + (H - 18) + ':w=' + barW + ':h=12:color=' + accent + '@1:t=fill',
  ].join(',');

  const r = spawnSync(
    bin,
    [
      '-y', '-v', 'error',
      '-f', 'lavfi',
      '-i', 'color=c=0x0B0C0E:s=' + W + 'x' + H + ':r=' + FPS,
      '-vf', filter,
      '-frames:v', '1',
      '-start_number', String(frame),
      path.join(outDir, 'f%05d.png'),
    ],
    { encoding: 'utf8', windowsHide: true },
  );

  if (r.error) {
    console.error('ffmpeg 启动失败：' + r.error.message);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('ffmpeg 失败（帧 ' + frame + '）：' + (r.stderr || '').trim());
    process.exit(1);
  }
}

console.log('adapter: ' + start + '-' + end + ' done');
