#!/usr/bin/env node
/**
 * mykit CLI —— Phase 0：只实现 doctor。
 *
 * 输出固定为 JSON，方便下面所有阶段用脚本断言（人看、机读都行）。
 * 零运行时依赖：只用 node: 内置模块。
 */
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { findBrowser, findAllBrowsers } from './browser.mjs';

const VERSION = '0.1.0';
const MIN_NODE_MAJOR = 22;

const USAGE = [
  'mykit ' + VERSION + ' — 零依赖视频模板渲染器',
  '',
  '用法：',
  '  mykit doctor      体检环境（node / 浏览器 / ffmpeg / WebSocket）',
  '  mykit help        显示本帮助',
  '',
  '环境变量：',
  '  CHROME_PATH / MYKIT_BROWSER   指定浏览器可执行文件',
  '  FFMPEG_PATH / FFPROBE_PATH    指定 ffmpeg / ffprobe',
  '',
].join('\n');

function parseArgs(argv) {
  const positional = [];
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        options[key] = next;
        i += 1;
      } else {
        options[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { command: positional[0], positional, options };
}

function probeVersion(bin) {
  const r = spawnSync(bin, ['-version'], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.error) {
    return { available: false, path: bin, version: null, error: r.error.code || String(r.error.message) };
  }
  if (r.status !== 0) {
    return { available: false, path: bin, version: null, error: 'exit ' + r.status };
  }
  const first = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/)[0].trim();
  const m = first.match(/version\s+(\S+)/i);
  return { available: true, path: bin, version: m ? m[1] : first, raw: first };
}

function doctor() {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const chrome = findBrowser();
  const browsers = findAllBrowsers();
  const ffmpeg = probeVersion(process.env.FFMPEG_PATH || 'ffmpeg');
  const ffprobe = probeVersion(process.env.FFPROBE_PATH || 'ffprobe');
  const webSocket = typeof WebSocket;

  const checks = {
    node: nodeMajor >= MIN_NODE_MAJOR,
    webSocket: webSocket === 'function',
    chrome: chrome.available === true,
    ffmpeg: ffmpeg.available === true,
    ffprobe: ffprobe.available === true,
  };
  const missing = Object.keys(checks).filter((k) => !checks[k]);

  const report = {
    mykit: VERSION,
    node: process.version,
    nodeMajor,
    nodeSupported: checks.node,
    platform: process.platform + '-' + process.arch,
    webSocket,
    chrome,
    browsers,
    ffmpeg,
    ffprobe,
    checks,
    ok: missing.length === 0,
    missing,
  };

  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

function main() {
  const { command } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'doctor':
      return doctor();
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(USAGE);
      return 0;
    default:
      console.error('未知命令：' + command + '\n');
      console.error(USAGE);
      return 2;
  }
}

process.exit(main());
