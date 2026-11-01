import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { verifyPackage } from '../../src/verify.mjs';
import { writeManifest } from '../../src/integrity.mjs';

const SRC = path.resolve('templates/ops-replay');
const work = path.resolve('.tmp/test-verify');

/** 复制一份真模板再改坏它——比手写假包更能验证真实契约字段。 */
function makePkg(name, mutate, options = {}) {
  const dir = path.join(work, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(SRC, dir, { recursive: true });
  const motionFile = path.join(dir, 'motion.json');
  const motion = JSON.parse(fs.readFileSync(motionFile, 'utf8'));
  if (mutate) mutate(motion, dir);
  fs.writeFileSync(motionFile, JSON.stringify(motion, null, 2) + '\n');
  if (!options.keepIntegrity) writeManifest(dir);
  return dir;
}

test('真模板通过检查', () => {
  const report = verifyPackage(SRC);
  assert.equal(report.ok, true);
  assert.equal(report.info.frames, 240);
  assert.deepEqual(report.errors, []);
});

test('permissions.network=true 被拒（离线是硬约束）', () => {
  const dir = makePkg('net', (m) => {
    m.permissions.network = true;
  });
  const report = verifyPackage(dir);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes('permissions.network')));
});

test('奇数宽高被拒（yuv420p 要求偶数）', () => {
  const dir = makePkg('odd', (m) => {
    m.output.width = 1921;
  });
  assert.ok(verifyPackage(dir).errors.some((e) => e.includes('偶数')));
});

test('entry 路径穿越被拒', () => {
  const dir = makePkg('trav', (m) => {
    m.runtime.entry = '../../etc/passwd';
  });
  assert.ok(verifyPackage(dir).errors.some((e) => e.includes('不允许')));
});

test('MIT 但没有 LICENSE 文件被拒', () => {
  const dir = makePkg('nolic', (m, d) => {
    fs.rmSync(path.join(d, 'LICENSE'));
  });
  assert.ok(verifyPackage(dir).errors.some((e) => e.includes('LICENSE')));
});

test('内容被改过要报 integrity 不符', () => {
  const dir = makePkg('tamper', null);
  fs.appendFileSync(path.join(dir, 'src/index.html'), '<!-- tampered -->');
  const report = verifyPackage(dir);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((e) => e.includes('integrity')));
});

test('缺 guide 只是警告，不算错误', () => {
  const dir = makePkg('noguide', (m) => {
    delete m.guide;
  });
  const report = verifyPackage(dir);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.some((w) => w.includes('guide')));
});

test('profile 不在枚举里被拒', () => {
  const dir = makePkg('badprofile', (m) => {
    m.runtime.profile = 'html/flash';
  });
  assert.ok(verifyPackage(dir).errors.some((e) => e.includes('runtime.profile')));
});
