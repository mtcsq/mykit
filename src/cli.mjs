#!/usr/bin/env node
/**
 * mykit CLI。当前：doctor / probe / still（Phase 0–2）。
 * 所有命令输出 JSON，方便脚本断言。
 */
import process from 'node:process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { findBrowser, findAllBrowsers } from './browser.mjs';
import { serve } from './serve.mjs';
import { launch, waitForReady, awaitAssets, awaitSettle } from './cdp.mjs';
import { pickPath, detectShape, capture, renderFrame, describeRuntime } from './frame.mjs';
import { createEncoder, encodeSequence, probeMedia, summarize } from './encode.mjs';
import { renderShards } from './pool.mjs';
import { muxAudio, probeAudio } from './audio.mjs';
import { verifyPackage, SPEC_VERSION, PROFILES, DURATION_POLICIES } from './verify.mjs';
import { writeManifest, verifyManifest } from './integrity.mjs';

const VERSION = '0.1.0';
const MIN_NODE_MAJOR = 22;

const USAGE = [
  'mykit ' + VERSION + ' — 零依赖视频模板渲染器',
  '',
  '用法：',
  '  mykit doctor                                          体检环境',
  '  mykit probe  --root <dir> [--page <rel>]              打开页面，报告 ready 信号与 title',
  '  mykit still  --template <dir> --frame <N[,N2]> --out <file>   取静帧',
  '  mykit render --template <dir> --out <file> [--workers N]      整片渲染（可加 --audio <文件>）',
  '  mykit verify --package <dir>                                  契约检查',
  '  mykit integrity build|verify --package <dir>                 生成/校验 SHA-256 清单',
  '  mykit spec                                                    打印契约版本与枚举',
  '',
  '选项：--page <rel> 指定页面（默认读 motion.json 的 runtime.entry）',
  '      --inputs <rel> 指定参数 JSON（默认读 parameters.defaultPreset）',
  '      --timeout <ms> 页面就绪超时，默认 15000',
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
  if (r.error) return { available: false, path: bin, version: null, error: r.error.code || String(r.error.message) };
  if (r.status !== 0) return { available: false, path: bin, version: null, error: 'exit ' + r.status };
  const first = ((r.stdout || '') + (r.stderr || '')).split(/\r?\n/)[0].trim();
  const m = first.match(/version\s+(\S+)/i);
  return { available: true, path: bin, version: m ? m[1] : first, raw: first };
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
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

async function withPage(options, fn) {
  const chrome = findBrowser();
  if (!chrome.available) throw new Error('找不到浏览器，请设置 CHROME_PATH');
  const server = await serve(options.rootDir);
  let page = null;
  try {
    page = await launch({
      executable: chrome.executable,
      width: options.width,
      height: options.height,
      deviceScaleFactor: options.deviceScaleFactor ?? 1,
    });
    await page.navigate(server.origin + '/' + options.pagePath);
    const ready = await waitForReady(page, { timeout: options.timeout ?? 15000 });
    const assets = await awaitAssets(page);
    const out = await fn(page, ready, assets);
    return { ...out, browser: { name: chrome.name, version: chrome.version, executable: chrome.executable } };
  } finally {
    if (page) await page.close();
    await server.close();
  }
}

async function probe(options) {
  if (!options.root) {
    console.error('probe 需要 --root <目录>');
    return 2;
  }
  const report = await withPage(
    {
      rootDir: path.resolve(String(options.root)),
      pagePath: String(options.page || 'index.html'),
      width: 1280,
      height: 720,
      timeout: options.timeout ? Number(options.timeout) : 15000,
    },
    async (page, ready) => ({
      title: await page.evaluate('document.title'),
      ready,
      pageErrors: page.errors,
      consoleErrors: page.consoleErrors,
    }),
  );
  console.log(JSON.stringify(report, null, 2));
  return report.pageErrors.length ? 1 : 0;
}

function resolveInputs(templateDir, options, runtime) {
  const candidate = options.inputs || runtime.preset;
  if (!candidate) return { inputs: {}, source: null };
  const file = path.isAbsolute(String(candidate)) ? String(candidate) : path.join(templateDir, String(candidate));
  if (!fs.existsSync(file)) return { inputs: {}, source: null };
  return { inputs: readJson(file), source: file };
}

async function still(options) {
  if (!options.template || options.frame === undefined || !options.out) {
    console.error('still 需要 --template <dir> --frame <N> --out <file>');
    return 2;
  }
  const templateDir = path.resolve(String(options.template));
  const motionFile = path.join(templateDir, 'motion.json');
  if (!fs.existsSync(motionFile)) {
    console.error('找不到 motion.json：' + motionFile);
    return 2;
  }

  const motion = readJson(motionFile);
  const runtime = describeRuntime(motion);
  const shape = pickPath(runtime.profile);
  const { inputs, source } = resolveInputs(templateDir, options, runtime);
  const frames = String(options.frame)
    .split(',')
    .map((s) => Number(s.trim()));

  const report = await withPage(
    {
      rootDir: templateDir,
      pagePath: String(options.page || runtime.entry),
      width: runtime.width,
      height: runtime.height,
      timeout: options.timeout ? Number(options.timeout) : 15000,
    },
    async (page, ready) => {
      const detected = await detectShape(page, shape);
      const shots = [];
      for (const frame of frames) {
        await renderFrame(page, frame, inputs);
        if (detected.shape === 'dom') await awaitSettle(page);
        const shot = await capture(page, { path: detected.shape, quality: Number(options.quality || 0.93) });
        const outFile = frames.length > 1 ? options.out.replace(/\.jpg$/, '') + '-f' + frame + '.jpg' : String(options.out);
        fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
        fs.writeFileSync(outFile, shot.bytes);
        shots.push({
          frame,
          seconds: Number(runtime.toSeconds(frame).toFixed(6)),
          out: path.resolve(outFile),
          bytes: shot.bytes.length,
          sha256: sha256(shot.bytes),
          path: shot.path,
          fallback: shot.fallback,
          note: shot.note,
        });
      }
      return {
        template: templateDir,
        profile: runtime.profile,
        shape,
        detectedShape: detected.shape,
        shapeReason: detected.reason,
        entry: String(options.page || runtime.entry),
        readySignal: ready.signal,
        inputsSource: source,
        frames: shots,
        pageErrors: page.errors,
        consoleErrors: page.consoleErrors,
      };
    },
  );

  console.log(JSON.stringify(report, null, 2));
  return report.pageErrors.length ? 1 : 0;
}

async function renderVideo(options) {
  if (!options.template || !options.out) {
    console.error('render 需要 --template <dir> --out <file>');
    return 2;
  }
  const templateDir = path.resolve(String(options.template));
  const motionFile = path.join(templateDir, 'motion.json');
  if (!fs.existsSync(motionFile)) {
    console.error('找不到 motion.json：' + motionFile);
    return 2;
  }

  const motion = readJson(motionFile);
  const runtime = describeRuntime(motion);
  const shape = pickPath(runtime.profile);
  const total = Number(options.frames || runtime.frameCount || 0);
  if (!total) {
    console.error('无法确定帧数：motion.json 既没有 output.frames 也没有 durationSeconds');
    return 2;
  }
  const outFile = path.resolve(String(options.out));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const { inputs, source } = resolveInputs(templateDir, options, runtime);
  const quality = Number(options.quality || 0.93);
  // 并发只在长片上划算：每个 worker 的启动 + 字体加载约 5–6 秒（实测 4 worker ≈ 23 秒）。
  // 120 帧时串行 7 秒、并发墙钟 27 秒；断点约在 400–500 帧。短片一律走串行。
  const cores = os.cpus().length;
  const autoWorkers = total >= 400 ? Math.max(1, Math.min(8, Math.floor(cores / 4))) : 1;
  const workers = Number(options.workers || autoWorkers);

  if (workers > 1) {
    return renderParallel({
      templateDir,
      motion,
      runtime,
      shape,
      total,
      outFile,
      inputs,
      source,
      quality,
      workers,
      options,
    });
  }

  const report = await withPage(
    {
      rootDir: templateDir,
      pagePath: String(options.page || runtime.entry),
      width: runtime.width,
      height: runtime.height,
      timeout: options.timeout ? Number(options.timeout) : 15000,
    },
    async (page, ready) => {
      const encoder = createEncoder({
        fps: runtime.fps,
        frames: total,
        out: outFile,
        crf: options.crf ? Number(options.crf) : 18,
      });
      const detected = await detectShape(page, shape);
      const started = Date.now();
      let fallbacks = 0;
      let muxed = null;
      try {
        for (let frame = 0; frame < total; frame += 1) {
          await renderFrame(page, frame, inputs);
          if (detected.shape === 'dom') await awaitSettle(page);
          const shot = await capture(page, { path: detected.shape, quality });
          if (shot.fallback) fallbacks += 1;
          await encoder.write(shot.bytes);
          if (frame % 30 === 0 || frame === total - 1) {
            process.stderr.write('[' + (frame + 1) + '/' + total + '] ' + Math.round((Date.now() - started) / 1000) + 's\n');
          }
        }
        await encoder.finish();
        muxed = maybeMuxAudio(options, outFile);
      } catch (error) {
        encoder.kill();
        throw error;
      }
      const elapsedMs = Date.now() - started;
      const media = summarize(probeMedia(outFile));

      const expects = {
        frames: media.video && media.video.frames,
        width: media.video && media.video.width,
        height: media.video && media.video.height,
        fps: media.video && media.video.fps,
        primaries: media.video && media.video.primaries,
      };
      const mismatches = [];
      if (expects.frames !== total) mismatches.push('frames ' + expects.frames + ' != ' + total);
      if (expects.width !== runtime.width) mismatches.push('width ' + expects.width + ' != ' + runtime.width);
      if (expects.height !== runtime.height) mismatches.push('height ' + expects.height + ' != ' + runtime.height);
      if (expects.fps !== runtime.fps + '/' + runtime.den) mismatches.push('fps ' + expects.fps + ' != ' + runtime.fps + '/' + runtime.den);
      if (expects.primaries !== 'bt709') mismatches.push('primaries ' + expects.primaries);

      return {
        template: templateDir,
        profile: runtime.profile,
        shape,
        detectedShape: detected.shape,
        shapeReason: detected.reason,
        entry: String(options.page || runtime.entry),
        readySignal: ready.signal,
        inputsSource: source,
        out: outFile,
        frames: total,
        elapsedMs,
        framesPerSecond: Number((total / (elapsedMs / 1000)).toFixed(2)),
        fallbacks,
        audio: muxed,
        media,
        ok: mismatches.length === 0,
        mismatches,
        pageErrors: page.errors,
        consoleErrors: page.consoleErrors,
      };
    },
  );

  console.log(JSON.stringify(report, null, 2));
  return report.ok && report.pageErrors.length === 0 ? 0 : 1;
}

async function renderParallel(ctx) {
  const { templateDir, motion, runtime, shape, total, outFile, inputs, source, quality, workers, options } = ctx;
  const chrome = findBrowser();
  if (!chrome.available) {
    console.error('找不到浏览器，请设置 CHROME_PATH');
    return 2;
  }

  // 帧目录必须按模板 id+版本区分：所有包的内层都叫 _inner，用目录名会互相覆盖
  const templateKey =
    (motion.template && motion.template.id ? motion.template.id : path.basename(templateDir)) +
    '-' +
    ((motion.template && motion.template.version) || '0');
  const framesDir = path.resolve(String(options['frames-dir'] || path.join(process.cwd(), '.tmp', 'frames-' + templateKey)));
  const resume = Boolean(options.resume);
  if (!resume && fs.existsSync(framesDir)) fs.rmSync(framesDir, { recursive: true, force: true });

  const server = await serve(templateDir);
  const started = Date.now();
  try {
    const shards = await renderShards({
      executable: chrome.executable,
      origin: server.origin,
      pagePath: String(options.page || runtime.entry),
      width: runtime.width,
      height: runtime.height,
      total,
      workers,
      dir: framesDir,
      declaredShape: shape,
      inputs,
      quality,
      resume,
      log: (line) => process.stderr.write(line + '\n'),
    });

    const renderMs = shards.renderMs;
    const setupMs = shards.setupMs;
    const encodeStarted = Date.now();
    encodeSequence({
      dir: framesDir,
      fps: runtime.fps,
      frames: total,
      out: outFile,
      crf: options.crf ? Number(options.crf) : 18,
    });
    const encodeMs = Date.now() - encodeStarted;
    const muxed = maybeMuxAudio(options, outFile);

    const media = summarize(probeMedia(outFile));
    const mismatches = [];
    if (!media.video || media.video.frames !== total) mismatches.push('frames ' + (media.video && media.video.frames) + ' != ' + total);
    if (media.video && media.video.width !== runtime.width) mismatches.push('width ' + media.video.width);
    if (media.video && media.video.height !== runtime.height) mismatches.push('height ' + media.video.height);
    if (media.video && media.video.fps !== runtime.fps + '/' + runtime.den) mismatches.push('fps ' + media.video.fps);
    if (media.video && media.video.primaries !== 'bt709') mismatches.push('primaries ' + media.video.primaries);

    const report = {
      template: templateDir,
      profile: runtime.profile,
      shape,
      detectedShape: shards.workersInfo.length ? shards.workersInfo[0].shape : null,
      shapeReason: shards.workersInfo.length ? shards.workersInfo[0].reason : null,
      entry: String(options.page || runtime.entry),
      inputsSource: source,
      out: outFile,
      frames: total,
      workers,
      workersInfo: shards.workersInfo,
      skipped: shards.skipped,
      framesDir,
      setupMs,
      renderMs,
      encodeMs,
      audio: muxed,
      framesPerSecond: Number((total / (renderMs / 1000)).toFixed(2)),
      wallMs: Date.now() - started,
      media,
      ok: mismatches.length === 0,
      mismatches,
      browser: { name: chrome.name, version: chrome.version, executable: chrome.executable },
    };
    console.log(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  } finally {
    await server.close();
  }
}

function maybeMuxAudio(options, outFile) {
  if (!options.audio) return null;
  const audio = path.resolve(String(options.audio));
  const info = probeAudio(audio);
  const offset = Number(options['audio-offset'] || 0);
  const gain = Number(options['audio-gain'] || 1);
  const muxed = muxAudio({ video: outFile, audio, offset, gain });
  return { input: audio, source: { codec: info.codec, duration: info.duration }, ...muxed };
}

function verifyCmd(options) {
  const dir = options.package || options.template;
  if (!dir) {
    console.error('verify 需要 --package <目录>');
    return 2;
  }
  const report = verifyPackage(dir);
  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

function integrityCmd(options, sub) {
  const dir = options.package || options.template;
  if (!dir) {
    console.error('integrity 需要 --package <目录>');
    return 2;
  }
  if (options.build || sub === 'build') {
    const manifest = writeManifest(dir);
    console.log(JSON.stringify({ built: true, files: Object.keys(manifest.files).length, package: path.resolve(String(dir)) }, null, 2));
    return 0;
  }
  const report = verifyManifest(dir);
  console.log(JSON.stringify({ package: path.resolve(String(dir)), ...report }, null, 2));
  return report.ok ? 0 : 1;
}

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));
  switch (command) {
    case 'doctor':
      return doctor();
    case 'probe':
      return probe(options);
    case 'still':
      return still(options);
    case 'render':
      return renderVideo(options);
    case 'verify':
      return verifyCmd(options);
    case 'integrity':
      return integrityCmd(options, positional[1]);
    case 'spec':
      console.log(JSON.stringify({ specVersion: SPEC_VERSION, profiles: PROFILES, durationPolicies: DURATION_POLICIES }, null, 2));
      return 0;
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

process.exit(await main());
