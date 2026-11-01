import test from 'node:test';
import assert from 'node:assert/strict';
import { planFrames } from '../../src/frame.mjs';

const base = { fps: 30, den: 1, frameCount: 240, durationPolicy: 'fixed' };

test('fixed：按 seconds 算出的帧数直接用', () => {
  const plan = planFrames(base, {});
  assert.equal(plan.frames, 240);
  assert.equal(plan.basis, 'declared');
});

test('fit-voiceover：按音频时长算帧数', () => {
  const plan = planFrames(
    { fps: 30, den: 1, frameCount: null, durationPolicy: 'fit-voiceover', maxSeconds: 60 },
    { audioSeconds: 8.466667 },
  );
  assert.equal(plan.frames, 254);
  assert.equal(plan.basis, 'audio');
  assert.equal(plan.clamped, false);
});

test('fit-voiceover：超过 maxSeconds 要夹紧', () => {
  const plan = planFrames(
    { fps: 30, den: 1, frameCount: null, durationPolicy: 'fit-voiceover', maxSeconds: 3 },
    { audioSeconds: 8.466667 },
  );
  assert.equal(plan.frames, 90);
  assert.equal(plan.clamped, true);
});

test('fit-voiceover：扣掉音频偏移', () => {
  const plan = planFrames(
    { fps: 30, den: 1, frameCount: null, durationPolicy: 'fit-voiceover', maxSeconds: 60 },
    { audioSeconds: 10, audioOffset: 2 },
  );
  assert.equal(plan.frames, 240);
});

test('fit-content：缺信息不猜，返回 null', () => {
  const plan = planFrames({ fps: 30, den: 1, frameCount: null, durationPolicy: 'fit-content', maxSeconds: 60 }, {});
  assert.equal(plan.frames, null);
  assert.equal(plan.basis, 'unknown');
});

test('非整数帧率：29.97 用 den 参与计算', () => {
  const plan = planFrames(
    { fps: 30000, den: 1001, frameCount: null, durationPolicy: 'fit-voiceover', maxSeconds: 60 },
    { audioSeconds: 10 },
  );
  assert.equal(plan.frames, Math.round((10 * 30000) / 1001));
});
