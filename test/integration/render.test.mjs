import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const CLI = path.resolve('src/cli.mjs');
const PKG = 'templates/ffmpeg-demo';

function run(args, options = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', windowsHide: true, timeout: options.timeout || 120000 });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function ffprobeFrames(file) {
  const r = spawnSync(
    process.env.FFPROBE_PATH || 'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames,width,height', '-of', 'json', file],
    { encoding: 'utf8', windowsHide: true },
  );
  return JSON.parse(r.stdout).streams[0];
}

const hasFfmpeg = spawnSync(process.env.FFMPEG_PATH || 'ffmpeg', ['-version'], { windowsHide: true }).status === 0;

test('整片渲染：帧数/尺寸与契约一致', { skip: hasFfmpeg ? false : '没有 ffmpeg' }, () => {
  const out = path.resolve('.tmp/it-full.mp4');
  fs.rmSync(out, { force: true });
  const r = run(['render', '--template', PKG, '--out', out]);
  assert.equal(r.status, 0, r.stderr.slice(-500));
  const stream = ffprobeFrames(out);
  assert.equal(Number(stream.nb_frames), 48);
  assert.equal(stream.width, 640);
  assert.equal(stream.height, 360);
});

test('分片 + 拼装：与整跑逐字节一致（无状态模板）', { skip: hasFfmpeg ? false : '没有 ffmpeg' }, () => {
  const dir = path.resolve('.tmp/it-shards');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.equal(run(['render', '--template', PKG, '--range', '0-24', '--no-encode', '--frames-dir', dir]).status, 0);
  assert.equal(run(['render', '--template', PKG, '--range', '24-48', '--no-encode', '--frames-dir', dir]).status, 0);
  assert.equal(fs.readdirSync(dir).length, 48);

  const shardOut = path.resolve('.tmp/it-shard.mp4');
  const fullOut = path.resolve('.tmp/it-full.mp4');
  assert.equal(run(['encode', '--frames-dir', dir, '--template', PKG, '--out', shardOut]).status, 0);

  const md5 = (file) => {
    const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'md5', '-'], { encoding: 'utf8', windowsHide: true });
    return r.stdout.trim();
  };
  assert.equal(md5(shardOut), md5(fullOut));
});
