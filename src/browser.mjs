/**
 * 浏览器定位与版本探测。
 *
 * 思路参考：891_corporate-multiscreen-charts_0.1.1-candidate/_inner/src/adapter.mjs
 * （CHROME_PATH 覆盖 -> 标准安装路径清单 -> PATH 兜底 -> 找不到明确报错）。代码为全新实现。
 *
 * 设计要点：
 *  1. Windows 上 chrome.exe --version 不打印版本，必须优先走「安装目录里的版本号子目录」，
 *     其次才回落到 PowerShell 的 VersionInfo，最后才是 unknown。
 *  2. 只读探测，不启动浏览器。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const WIN_CANDIDATES = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Google/Chrome Beta/Application/chrome.exe',
  'C:/Program Files/Google/Chrome Dev/Application/chrome.exe',
  'C:/Program Files/Google/Chrome SxS/Application/chrome.exe',
  'C:/Program Files/Chromium/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];

const MAC_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

const NIX_CANDIDATES = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/snap/bin/chromium',
  '/opt/google/chrome/chrome',
  '/usr/bin/microsoft-edge',
];

export function candidatePaths() {
  if (process.platform === 'win32') return WIN_CANDIDATES;
  if (process.platform === 'darwin') return MAC_CANDIDATES;
  return NIX_CANDIDATES;
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function compareVersion(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d;
  }
  return 0;
}

/** 安装目录里形如 156.0.8078.76 的子目录就是版本号（Chrome / Edge 都这样布局）。 */
function versionFromInstallDir(executable) {
  const dir = path.dirname(executable);
  const pattern = /^\d+\.\d+\.\d+(\.\d+)?$/;
  let names;
  try {
    names = fs.readdirSync(dir).filter((n) => pattern.test(n));
  } catch {
    return null;
  }
  if (!names.length) return null;
  names.sort(compareVersion);
  return names[names.length - 1];
}

function versionFromPeHeader(executable) {
  if (process.platform !== 'win32') return null;
  const r = spawnSync(
    'powershell',
    ['-NoProfile', '-NonInteractive', '-Command', "(Get-Item -LiteralPath '" + executable.replace(/'/g, "''") + "').VersionInfo.ProductVersion"],
    { encoding: 'utf8', timeout: 15000, windowsHide: true },
  );
  const out = (r.stdout || '').trim();
  return /^\d+\.\d+/.test(out) ? out : null;
}

function versionFromCli(executable) {
  // 只有非 Windows 的 chrome/chromium 支持 --version 直接打印；Windows 上会开窗口，不试。
  if (process.platform === 'win32') return null;
  const r = spawnSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  const out = ((r.stdout || '') + (r.stderr || '')).trim();
  const m = out.match(/(\d+\.\d+\.\d+(\.\d+)?)/);
  return m ? m[1] : null;
}

export function detectVersion(executable) {
  return versionFromCli(executable) || versionFromInstallDir(executable) || versionFromPeHeader(executable) || 'unknown';
}

function nameOf(executable) {
  const base = path.basename(executable).toLowerCase();
  return base.includes('edge') ? 'edge' : base.includes('chromium') ? 'chromium' : 'chrome';
}

function describe(executable, source) {
  return {
    available: true,
    name: nameOf(executable),
    executable,
    version: detectVersion(executable),
    source,
  };
}

/** PATH 里的 chrome/msedge（Windows 的 where，其他平台 which）。 */
function viaPathLookup() {
  const bins = process.platform === 'win32' ? ['chrome', 'msedge'] : ['google-chrome', 'chromium', 'chrome'];
  for (const bin of bins) {
    const r = spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    const first = (r.stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter(Boolean)[0];
    if (first && isFile(first)) return first;
  }
  return null;
}

/**
 * 找浏览器：CHROME_PATH -> 标准路径 -> PATH。
 * 返回 { available, name, executable, version, source, tried }；找不到时 available=false 且带 tried。
 */
export function findBrowser(options = {}) {
  const env = options.env || process.env;
  const explicit = options.executable || env.MYKIT_BROWSER || env.CHROME_PATH;
  const tried = [];

  if (explicit) {
    tried.push({ path: explicit, source: 'env', found: isFile(explicit) });
    if (isFile(explicit)) return { ...describe(explicit, 'env'), tried };
  }

  for (const c of candidatePaths()) {
    const found = isFile(c);
    tried.push({ path: c, source: 'candidate', found });
    if (found) return { ...describe(c, 'candidate'), tried };
  }

  const viaPath = viaPathLookup();
  if (viaPath) {
    tried.push({ path: viaPath, source: 'path', found: true });
    return { ...describe(viaPath, 'path'), tried };
  }

  return { available: false, name: null, executable: null, version: null, source: null, tried };
}

/** 报告所有能用的浏览器（第一个是主用，其余是兜底）。 */
export function findAllBrowsers(options = {}) {
  const env = options.env || process.env;
  const seen = new Set();
  const all = [];
  const push = (info) => {
    if (!info.available) return;
    const key = path.resolve(info.executable).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    all.push({ name: info.name, executable: info.executable, version: info.version, source: info.source });
  };

  const explicit = options.executable || env.MYKIT_BROWSER || env.CHROME_PATH;
  if (explicit && isFile(explicit)) push(describe(explicit, 'env'));
  for (const c of candidatePaths()) if (isFile(c)) push(describe(c, 'candidate'));
  const viaPath = viaPathLookup();
  if (viaPath) push(describe(viaPath, 'path'));

  return all;
}
