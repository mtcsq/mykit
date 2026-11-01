#!/usr/bin/env node
/**
 * 帧数规划单测：fixed / fit-voiceover / 上限夹紧 / 缺信息。
 * 运行：node test/plan-frames.mjs
 */
import { planFrames } from '../src/frame.mjs';

const cases = [
  {
    label: 'fixed 由 seconds 算',
    runtime: { fps: 30, den: 1, frameCount: 240, durationPolicy: 'fixed' },
    options: {},
    expect: 240,
  },
  {
    label: 'fit-voiceover 用音频时长',
    runtime: { fps: 30, den: 1, frameCount: null, durationPolicy: 'fit-voiceover', maxSeconds: 60 },
    options: { audioSeconds: 8.466667 },
    expect: 254,
  },
  {
    label: 'fit-voiceover 受 maxSeconds 夹紧',
    runtime: { fps: 30, den: 1, frameCount: null, durationPolicy: 'fit-voiceover', maxSeconds: 3 },
    options: { audioSeconds: 8.466667 },
    expect: 90,
  },
  {
    label: 'fit-voiceover 扣掉 offset',
    runtime: { fps: 30, den: 1, frameCount: null, durationPolicy: 'fit-voiceover', maxSeconds: 60 },
    options: { audioSeconds: 10, audioOffset: 2 },
    expect: 240,
  },
  {
    label: 'fit-content 缺信息不猜',
    runtime: { fps: 30, den: 1, frameCount: null, durationPolicy: 'fit-content', maxSeconds: 60 },
    options: {},
    expect: null,
  },
];

const results = cases.map((c) => {
  const plan = planFrames(c.runtime, c.options);
  return { label: c.label, got: plan.frames, expect: c.expect, pass: plan.frames === c.expect, basis: plan.basis };
});
const ok = results.every((r) => r.pass);
console.log(JSON.stringify({ ok, results }, null, 2));
process.exit(ok ? 0 : 1);
