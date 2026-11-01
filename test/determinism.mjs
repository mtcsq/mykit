#!/usr/bin/env node
/**
 * 确定性测试：同一模板、同一帧，两次跑到同一个哈希吗？
 *
 * 实测结论（2026-11-01）：
 *  - canvas 路径（892）：isolated / after-0 / after-119 三种情形逐字节一致
 *  - dom 路径（873）：重复跑一致，但"前一帧渲染成什么"会影响结果（PSNR ≈ 50 dB 的微差）
 * 因此本测试对两种路径用不同判据：canvas 要求 sha256 全等，dom 要求 PSNR 达标。
 *
 * 用法：node test/determinism.mjs --template <dir> --frame 120 [--prev 0] [--psnr 48]
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..', 'src', 'cli.mjs');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        out[key] = next;
        i += 1;
      } else out[key] = true;
    }
  }
  return out;
}

function still(template, frames, out) {
  const r = spawnSync(process.execPath, [CLI, 'still', '--template', template, '--frame', frames, '--out', out], {
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error('still 失败：' + (r.stdout || '') + (r.stderr || ''));
  return JSON.parse(r.stdout);
}

function psnr(a, b) {
  const r = spawnSync(
    (process.env.FFMPEG_PATH || 'ffmpeg'),
    ['-v', 'info', '-i', a, '-i', b, '-lavfi', '[0:v][1:v]psnr', '-f', 'null', '-'],
    { encoding: 'utf8', windowsHide: true },
  );
  const m = ((r.stderr || '') + (r.stdout || '')).match(/average:([0-9.]+)/);
  return m ? Number(m[1]) : null;
}

const args = parseArgs(process.argv.slice(2));
if (!args.template || args.frame === undefined) {
  console.error('用法：node test/determinism.mjs --template <dir> --frame 120 [--prev 0] [--psnr 48]');
  process.exit(2);
}

const template = path.resolve(String(args.template));
const frame = String(args.frame);
const prev = args.prev !== undefined ? String(args.prev) : null;
const minPsnr = Number(args.psnr || 48);
const tmp = path.join(process.cwd(), '.tmp', 'determinism');
fs.mkdirSync(tmp, { recursive: true });

const lastFrame = (report) => report.frames[report.frames.length - 1];

const runs = [];
runs.push({ label: 'isolated', shot: lastFrame(still(template, frame, path.join(tmp, 'a.jpg'))) });
runs.push({ label: 'repeat', shot: lastFrame(still(template, frame, path.join(tmp, 'b.jpg'))) });
if (prev !== null) {
  runs.push({ label: 'after-' + prev, shot: lastFrame(still(template, prev + ',' + frame, path.join(tmp, 'c.jpg'))) });
}

const hashes = runs.map((r) => r.shot.sha256);
const byteExact = hashes.every((h) => h === hashes[0]);
let minPair = Infinity;
for (let i = 1; i < runs.length; i += 1) {
  const value = psnr(runs[0].shot.out, runs[i].shot.out);
  if (value !== null && value < minPair) minPair = value;
}

const pathKind = runs[0].shot.path;
const ok = pathKind === 'canvas' ? byteExact : minPair >= minPsnr;

console.log(
  JSON.stringify(
    {
      template,
      frame: Number(frame),
      pathKind,
      runs: runs.map((r) => ({ label: r.label, sha256: r.shot.sha256, bytes: r.shot.bytes })),
      byteExact,
      minPsnr: minPair === Infinity ? null : Number(minPair.toFixed(2)),
      judgedBy: pathKind === 'canvas' ? 'sha256 全等' : 'PSNR >= ' + minPsnr,
      ok,
    },
    null,
    2,
  ),
);
process.exit(ok ? 0 : 1);
