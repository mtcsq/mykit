import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { muxAudio, probeAudio } from '../../src/audio.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const available = spawnSync(ffmpeg, ['-version'], { windowsHide: true }).status === 0;

const work = path.resolve('.tmp/test-audio');

function makeVideo(file) {
  fs.mkdirSync(work, { recursive: true });
  fs.rmSync(file, { force: true });
  const r = spawnSync(
    ffmpeg,
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=24', '-frames:v', '24', '-pix_fmt', 'yuv420p', file],
    { windowsHide: true },
  );
  assert.equal(r.status, 0, '测试视频生成失败');
}

function makeAudio(file) {
  fs.rmSync(file, { force: true });
  const r = spawnSync(ffmpeg, ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', file], { windowsHide: true });
  assert.equal(r.status, 0, '测试音频生成失败');
}

test('加音轨后视频流不重编码，音频为 aac', { skip: available ? false : '没有 ffmpeg' }, () => {
  const video = path.join(work, 'v.mp4');
  const audio = path.join(work, 'a.wav');
  makeVideo(video);
  makeAudio(audio);

  const before = fs.statSync(video).size;
  const result = muxAudio({ video, audio, gain: 0.5 });

  assert.equal(result.codec, 'aac');
  assert.ok(fs.existsSync(video));
  assert.ok(fs.statSync(video).size > before, '加了音轨后体积应变大');

  const probe = probeAudio(video);
  assert.equal(probe.codec, 'aac');
  assert.ok(probe.duration >= 0.9 && probe.duration <= 1.2, '时长应约 1 秒，实际 ' + probe.duration);
});

test('音频文件不存在时报错而不是静默跳过', { skip: available ? false : '没有 ffmpeg' }, () => {
  const video = path.join(work, 'v2.mp4');
  makeVideo(video);
  assert.throws(() => muxAudio({ video, audio: path.join(work, 'nope.wav') }), /音频不存在/);
});
