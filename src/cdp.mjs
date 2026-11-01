/**
 * 最小 CDP 客户端：DevToolsActivePort -> WebSocket -> Runtime.evaluate / Page.navigate。
 *
 * 思路参考 891 的 adapter.mjs（零依赖、读 DevToolsActivePort、Runtime.evaluate 逐帧驱动）。
 * 增量：ready 信号自适应探测（4 个真实包 4 种写法，见方案 v1.1 Phase 1）。代码为全新实现。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 浏览器会派生一堆子进程（renderer/gpu/utility），child.kill() 只杀父进程，
// 子进程会留下来占 CPU 与内存——实测残留过 6 个 headless 进程，还把后续测试拖慢 3 倍。
// 因此统一走"杀进程树"，并登记活跃进程，进程退出时兜底清理。
const ACTIVE = new Set();

function killTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 已经没了 */
    }
  }
}

function registerChild(child) {
  ACTIVE.add(child);
  child.once('exit', () => ACTIVE.delete(child));
}

let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  const cleanup = () => {
    for (const child of ACTIVE) killTree(child);
  };
  process.once('exit', cleanup);
  process.once('SIGINT', () => {
    cleanup();
    process.exit(130);
  });
  process.once('SIGTERM', () => {
    cleanup();
    process.exit(143);
  });
}


/** 一次 evaluate 拿到所有候选状态，避免多次往返。 */
const PROBE_EXPR =
  '(function(){return {' +
  'mykit:window.__MYKIT_READY===true,' +
  'motion:window.__MOTION_READY===true,' +
  'promise:!!window.__readyPromise,' +
  'ready:!!(window.ready&&typeof window.ready.then==="function"),' +
  'READY:window.READY===true,' +
  'pending:(typeof window.__MYKIT_PENDING==="number")?window.__MYKIT_PENDING:((window.__MYKIT_PENDING&&typeof window.__MYKIT_PENDING.then==="function")?"promise":0),' +
  'state:document.readyState,' +
  'title:document.title,' +
  'error:(window.__lastError&&String(window.__lastError.message||window.__lastError))||null' +
  '};})()';

export class ReadyTimeoutError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ReadyTimeoutError';
    this.detail = detail;
  }
}

export class CdpError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'CdpError';
    this.detail = detail;
  }
}

async function readDevToolsPort(profileDir, child, timeoutMs) {
  const file = path.join(profileDir, 'DevToolsActivePort');
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) {
      throw new CdpError('浏览器启动即退出（exit ' + child.exitCode + '）', { profileDir });
    }
    if (fs.existsSync(file)) {
      const [port] = fs.readFileSync(file, 'utf8').split('\n');
      if (port && Number(port) > 0) return Number(port);
    }
    await sleep(50);
  }
  throw new CdpError('等待 DevToolsActivePort 超时', { profileDir, timeoutMs });
}

/**
 * 启动 headless 浏览器并连接第一个 page target。
 */
export async function launch(options = {}) {
  const executable = options.executable;
  if (!executable) throw new CdpError('缺少 executable');

  const width = options.width ?? 1920;
  const height = options.height ?? 1080;
  const profileDir = options.profileDir || fs.mkdtempSync(path.join(os.tmpdir(), 'mykit-chrome-'));
  fs.mkdirSync(profileDir, { recursive: true });

  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--user-data-dir=' + profileDir,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-features=Translate,MediaRouter',
    '--hide-scrollbars',
    '--mute-audio',
    '--force-color-profile=srgb',
    '--window-size=' + width + ',' + height,
    ...(process.env.MYKIT_CHROME_ARGS ? process.env.MYKIT_CHROME_ARGS.split(',').filter(Boolean) : []),
    ...(options.args || []),
    'about:blank',
  ];

  hookExit();
  const child = spawn(executable, args, {
    windowsHide: true,
    stdio: 'ignore',
    detached: process.platform !== 'win32', // 独立进程组，便于整组结束
  });
  registerChild(child);
  const startupTimeout = options.startupTimeout ?? 25000;

  let socket;
  let nextId = 0;
  const pending = new Map();
  const errors = [];
  const consoleErrors = [];

  const send = (method, params = {}, timeoutMs = 30000) =>
    new Promise((resolve, reject) => {
      const id = (nextId += 1);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new CdpError('CDP 超时：' + method, { method }));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.send(JSON.stringify({ id, method, params }));
    });

  try {
    const port = await readDevToolsPort(profileDir, child, startupTimeout);
    const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
    const target = list.find((t) => t.type === 'page');
    if (!target) throw new CdpError('没有 page target', { targets: list.length });

    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new CdpError('WebSocket 握手超时')), 15000);
      socket.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
      socket.addEventListener('error', (event) => {
        clearTimeout(timer);
        reject(new CdpError('WebSocket 错误', { event: String(event && event.type) }));
      }, { once: true });
    });

    socket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id) {
        const entry = pending.get(msg.id);
        if (!entry) return;
        clearTimeout(entry.timer);
        pending.delete(msg.id);
        if (msg.error) entry.reject(new CdpError('CDP 失败：' + JSON.stringify(msg.error), msg.error));
        else entry.resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params && msg.params.exceptionDetails;
        errors.push((d && (d.text || (d.exception && d.exception.description))) || 'exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params && msg.params.type === 'error') {
        consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' '));
      }
    });

    await send('Runtime.enable');
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: options.deviceScaleFactor ?? 1,
      mobile: false,
    });

    const page = {
      port,
      profileDir,
      errors,
      consoleErrors,
      send,
      async evaluate(expression, evalOptions = {}) {
        const result = await send('Runtime.evaluate', {
          expression,
          awaitPromise: evalOptions.awaitPromise !== false,
          returnByValue: true,
          userGesture: true,
        });
        if (result.exceptionDetails) {
          const d = result.exceptionDetails;
          throw new CdpError(
            '页面求值抛错：' + (d.exception ? d.exception.description || d.exception.value : d.text),
            { expression: expression.slice(0, 200) },
          );
        }
        return result.result ? result.result.value : undefined;
      },
      async navigate(url) {
        // 不用 Page.loadEventFired：实测这个事件在部分页面根本收不到，等它会白等 20 秒，
        // 还会把后面的 pending / ready 等待全部推后。改为轮询 readyState 收口。
        await send('Page.navigate', { url });
        const started = Date.now();
        const limit = options.navigateTimeout ?? 5000;
        while (Date.now() - started < limit) {
          let state = 'loading';
          try {
            state = await this.evaluate('document.readyState', { awaitPromise: false });
          } catch {
            /* 页面切换过程中求值可能失败，重试即可 */
          }
          if (state === 'complete') return { state, waitedMs: Date.now() - started };
          await sleep(20);
        }
        return { state: 'timeout', waitedMs: Date.now() - started };
      },
      async close() {
        // 顺序很重要：任何一步抛错都不能跳过后面的清理，否则主浏览器进程会留成孤儿
        try {
          await send('Browser.close', {}, 5000);
        } catch {
          /* 忽略：下面杀树兜底 */
        }
        try {
          socket.close();
        } catch {
          /* 忽略 */
        }
        killTree(child);
        await sleep(120);
        killTree(child); // 二次兜底：Chrome 退出前可能又派生了子进程
      },
    };

    return page;
  } catch (error) {
    if (socket) socket.close();
    killTree(child);
    throw error;
  }
}

/**
 * 让这一帧真正落到画面上再截图。
 *
 * 原因（实测）：GSAP 默认 lazy 渲染，seek 之后样式要在下一帧才写完。先渲 119 再渲 120，
 * 立即截图会拍到 119 的残留；先渲 0 再渲 120 就不会。等两个 rAF 再补一次强制布局即可消除。
 */
export async function awaitSettle(page, frames = 2) {
  const expression =
    '(async function(){' +
    'for(var i=0;i<' + frames + ';i++){' +
    'await new Promise(function(r){requestAnimationFrame(function(){r();});});' +
    '}' +
    'void document.body.offsetHeight;' +
    'return true;' +
    '})()';
  await page.evaluate(expression);
}

/**
 * 等字体与图片真正就绪。
 *
 * 为什么必须有这一步：873 用的是 font-display:block 的 webfont，且自己的 __MOTION_READY 在字体加载前就置位。
 * 不等 fonts.ready 就截图，先渲染的帧会缺字或字形不同——同一帧在不同时间截会得到不同像素
 * （实测：先渲 119 再渲 120，与先渲 0 再渲 120，120 的哈希不同）。
 */
export async function awaitAssets(page) {
  const expression =
    '(async function(){' +
    'try{if(document.fonts&&document.fonts.ready)await document.fonts.ready;}catch(e){}' +
    'await Promise.all(Array.prototype.map.call(document.images,function(img){' +
    'if(img.complete)return null;' +
    'return new Promise(function(r){img.addEventListener("load",r,{once:true});img.addEventListener("error",r,{once:true});});' +
    '}).filter(Boolean));' +
    'return {fontFaces:(document.fonts&&document.fonts.size)||0,images:document.images.length};' +
    '})()';
  return page.evaluate(expression);
}

/**
 * 自适应 ready：顺序探测 4 种真实信号，再到 document.readyState 兜底。
 * 返回 { signal, waitedMs, probe }。
 */
export async function waitForReady(page, options = {}) {
  const timeout = options.timeout ?? 15000;
  const interval = options.interval ?? 100;
  const readyStateGrace = options.readyStateGrace ?? 2000;
  const started = Date.now();
  let probe = null;
  let signal = null;

  // 先拿到 ready 信号，再等 __MYKIT_PENDING 归零（Remotion 的 delayRender/continueRender 思路）。
  // 只认数不清的资源会让首帧缺东西——873 的字体就是这么踩的，模板自己声明更可靠。

  while (Date.now() - started < timeout) {
    probe = await page.evaluate(PROBE_EXPR, { awaitPromise: false });

    if (probe.mykit) { signal = '__MYKIT_READY'; break; }
    if (probe.motion) { signal = '__MOTION_READY'; break; }
    if (probe.promise) {
      await page.evaluate('window.__readyPromise');
      signal = '__readyPromise';
      break;
    }
    if (probe.ready) {
      await page.evaluate('window.ready');
      signal = 'ready';
      break;
    }
    if (probe.READY) {
      signal = 'READY';
      break;
    }

    const elapsed = Date.now() - started;
    if (elapsed >= readyStateGrace && probe.state === 'complete') {
      signal = 'document.readyState';
      break;
    }
    await sleep(interval);
  }

  if (!signal) {
    throw new ReadyTimeoutError('等待页面 ready 超时（' + timeout + 'ms）', {
      lastProbe: probe,
      pageErrors: page.errors,
    });
  }

  const pendingStarted = Date.now();
  let pendingWaitedMs = 0;
  while (Date.now() - pendingStarted < timeout) {
    const state = await page.evaluate(PROBE_EXPR, { awaitPromise: false });
    if (state.pending === 'promise') {
      await page.evaluate('window.__MYKIT_PENDING');
      pendingWaitedMs = Date.now() - pendingStarted;
      break;
    }
    if (!state.pending) break;
    await sleep(interval);
    pendingWaitedMs = Date.now() - pendingStarted;
  }

  return { signal, waitedMs: Date.now() - started, pendingWaitedMs, probe };
}
