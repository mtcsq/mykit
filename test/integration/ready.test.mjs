import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { findBrowser } from '../../src/browser.mjs';
import { serve } from '../../src/serve.mjs';
import { launch, waitForReady } from '../../src/cdp.mjs';

const chrome = findBrowser();
const CASES = [
  ['ready-mykit.html', '__MYKIT_READY'],
  ['ready-motion.html', '__MOTION_READY'],
  ['ready-promise.html', 'ready'],
  ['ready-prPromise.html', '__readyPromise'],
  ['ready-upper.html', 'READY'],
];

test('五种 ready 信号都能识别（ADR-4）', { skip: chrome.available ? false : '没有可用浏览器' }, async () => {
  const server = await serve(path.resolve('test/fixtures'));
  const page = await launch({ executable: chrome.executable, width: 640, height: 480 });
  try {
    for (const [file, expected] of CASES) {
      await page.navigate(server.origin + '/' + file);
      const ready = await waitForReady(page, { timeout: 8000 });
      assert.equal(ready.signal, expected, file + ' 命中的信号不对');
    }
  } finally {
    await page.close();
    await server.close();
  }
});

test('__MYKIT_PENDING 会等到归零', { skip: chrome.available ? false : '没有可用浏览器' }, async () => {
  const server = await serve(path.resolve('test/fixtures'));
  const page = await launch({ executable: chrome.executable, width: 640, height: 480 });
  try {
    await page.navigate(server.origin + '/pending.html');
    const ready = await waitForReady(page, { timeout: 10000 });
    assert.equal(ready.signal, '__MYKIT_READY');
    assert.ok(ready.pendingWaitedMs >= 800, '应等待 2 个各 600ms 的资源，实际 ' + ready.pendingWaitedMs + 'ms');
  } finally {
    await page.close();
    await server.close();
  }
});
