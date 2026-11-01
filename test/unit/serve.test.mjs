import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { safeResolve } from '../../src/serve.mjs';

const root = path.resolve('.tmp/test-serve');
fs.mkdirSync(root, { recursive: true });
fs.writeFileSync(path.join(root, 'ok.txt'), 'ok');
const real = fs.realpathSync(root);

test('普通路径解析正常', () => {
  assert.equal(safeResolve(real, 'ok.txt'), path.join(real, 'ok.txt'));
});

test('拒绝 .. 穿越', () => {
  assert.throws(() => safeResolve(real, '../etc/passwd'), /不允许/);
});

test('拒绝前导斜杠', () => {
  assert.throws(() => safeResolve(real, '/etc/passwd'), /不允许/);
});

test('拒绝反斜杠', () => {
  assert.throws(() => safeResolve(real, 'a\\b.txt'), /不允许/);
});

test('拒绝盘符/冒号', () => {
  assert.throws(() => safeResolve(real, 'C:/windows'), /不允许/);
});

test('拒绝空段', () => {
  assert.throws(() => safeResolve(real, 'a//b.txt'), /不允许/);
});
