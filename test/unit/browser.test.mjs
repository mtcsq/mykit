import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { candidatePaths, detectVersion, findBrowser, findAllBrowsers } from '../../src/browser.mjs';

test('候选路径清单非空，且都是绝对路径', () => {
  const paths = candidatePaths();
  assert.ok(paths.length > 0);
  for (const p of paths) assert.ok(path.isAbsolute(p), p + ' 不是绝对路径');
});

test('findBrowser 一定返回结构化结果（找不到也不抛）', () => {
  const found = findBrowser({ env: {} });
  assert.equal(typeof found.available, 'boolean');
  assert.ok(Array.isArray(found.tried));
});

test('显式指定的路径不存在时，会记录到 tried 并继续回落', () => {
  const found = findBrowser({ env: { CHROME_PATH: 'C:/definitely/not/here/chrome.exe' } });
  assert.ok(found.tried.some((t) => t.source === 'env' && t.found === false));
});

test('不存在的可执行文件探测版本返回 unknown，不抛错', () => {
  assert.equal(detectVersion(path.resolve('.tmp/no-such-browser.exe')), 'unknown');
});

test('findAllBrowsers 去重后返回数组', () => {
  const all = findAllBrowsers({ env: {} });
  assert.ok(Array.isArray(all));
  const names = all.map((b) => b.executable.toLowerCase());
  assert.equal(new Set(names).size, names.length);
});
