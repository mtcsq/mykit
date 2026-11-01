import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildManifest, writeManifest, verifyManifest } from '../../src/integrity.mjs';

const work = path.resolve('.tmp/test-integrity');

function fresh(name) {
  const dir = path.join(work, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a');
  fs.writeFileSync(path.join(dir, 'src', 'b.txt'), 'b');
  return dir;
}

test('清单不包含自身，路径用 / 且排序', () => {
  const dir = fresh('basic');
  writeManifest(dir);
  const manifest = buildManifest(dir);
  assert.deepEqual(Object.keys(manifest.files), ['a.txt', 'src/b.txt']);
  assert.equal(manifest.algorithm, 'sha256');
});

test('内容不变时校验通过', () => {
  const dir = fresh('ok');
  writeManifest(dir);
  assert.equal(verifyManifest(dir).ok, true);
});

test('文件被改 → 报 mismatched', () => {
  const dir = fresh('tamper');
  writeManifest(dir);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'changed');
  const report = verifyManifest(dir);
  assert.equal(report.ok, false);
  assert.deepEqual(report.mismatched, ['a.txt']);
});

test('多出未被清单覆盖的文件 → 报 extra', () => {
  const dir = fresh('extra');
  writeManifest(dir);
  fs.writeFileSync(path.join(dir, 'new.txt'), 'n');
  const report = verifyManifest(dir);
  assert.equal(report.ok, false);
  assert.deepEqual(report.extra, ['new.txt']);
});

test('文件被删 → 报 missing', () => {
  const dir = fresh('missing');
  writeManifest(dir);
  fs.rmSync(path.join(dir, 'a.txt'));
  const report = verifyManifest(dir);
  assert.equal(report.ok, false);
  assert.deepEqual(report.missing, ['a.txt']);
});

test('没有 integrity.json → 直接判失败并说明原因', () => {
  const dir = fresh('none');
  const report = verifyManifest(dir);
  assert.equal(report.ok, false);
  assert.match(report.reason, /integrity/);
});
