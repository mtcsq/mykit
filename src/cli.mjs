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
import { pickPath, detectShape, capture, renderFrame, describeRuntime, planFrames } from './frame.mjs';
import { createEncoder, encodeSequence, probeMedia, summarize } from './encode.mjs';
import { renderShards } from './pool.mjs';
import { muxAudio, probeAudio } from './audio.mjs';
import { verifyPackage, SPEC_VERSION, PROFILES, DURATION_POLICIES } from './verify.mjs';
import { writeManifest, verifyManifest } from './integrity.mjs';
import { writeZip, collectDirectory, unpackZip, contentHash } from './zip.mjs';
import { checkStatelessness } from './conformance.mjs';
import { runAdapter, adapterCommand } from './adapter.mjs';

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
  '  mykit encode --frames-dir <dir> --out <file> [--template d]   把已有帧编码成片（跨机拼装用）',
  '  mykit pack   --package <dir> --out <file.zip>                打成单文件（可复现）',
  '  mykit unpack --package <file.zip> --out <dir>                解包（带边界校验）',
  '  mykit conformance --template <dir|zip> [--span 600]          无状态性检查（并发前提）',
  '  mykit verify --package <dir|zip>                             契约检查',
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

async function stillExternal(ctx) {
  const { templateDir, runtime, inputs, frames, options } = ctx;
  const dir = path.join(process.cwd(), '.tmp', 'still-ext-' + process.pid);
  fs.rmSync(dir, { recursive: true, force: true });

  const digest = contentHash(Buffer.from(JSON.stringify(inputs, null, 2)));
  const inputsFile = path.join(process.cwd(), '.tmp', 'inputs-' + digest + '.json');
  fs.mkdirSync(path.dirname(inputsFile), { recursive: true });
  fs.writeFileSync(inputsFile, JSON.stringify(inputs, null, 2));

  const shots = [];
  for (const frame of frames) {
    const spec = adapterCommand(runtime, { start: frame, end: frame + 1, framesDir: dir, inputsFile, templateDir });
    await runAdapter({ ...spec, start: frame, end: frame + 1, framesDir: dir, cwd: templateDir });
    const jpg = path.join(dir, 'f' + String(frame).padStart(5, '0') + '.jpg');
    const png = path.join(dir, 'f' + String(frame).padStart(5, '0') + '.png');
    const file = fs.existsSync(jpg) ? jpg : png;
    const bytes = fs.readFileSync(file);
    const outFile =
      frames.length > 1
        ? String(options.out).replace(/\.jpg$/, '') + '-f' + frame + path.extname(file)
        : String(options.out);
    fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
    fs.writeFileSync(outFile, bytes);
    shots.push({
      frame,
      seconds: Number(runtime.toSeconds(frame).toFixed(6)),
      out: path.resolve(outFile),
      bytes: bytes.length,
      sha256: sha256(bytes),
      path: 'adapter',
      fallback: false,
    });
  }

  console.log(
    JSON.stringify(
      {
        template: templateDir,
        profile: runtime.profile,
        shape: 'adapter',
        detectedShape: 'adapter',
        entry: String((runtime.adapter && runtime.adapter.command) || ''),
        readySignal: null,
        inputsSource: inputsFile,
        frames: shots,
        pageErrors: [],
        consoleErrors: [],
      },
      null,
      2,
    ),
  );
  return 0;
}

async function still(options) {
  if (!(options.template || options.package) || options.frame === undefined || !options.out) {
    console.error('still 需要 --template <dir|zip> --frame <N> --out <file>');
    return 2;
  }
  const resolved = resolvePackage(options.template || options.package);
  const templateDir = resolved.dir;
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

  if (runtime.profile === 'external/adapter') {
    return stillExternal({ templateDir, runtime, inputs, frames, options });
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
  if (!(options.template || options.package) || (!options.out && !options['no-encode'])) {
    console.error('render 需要 --template <dir|zip> --out <file>（--no-encode 只出帧时可省略 --out）');
    return 2;
  }
  const resolved = resolvePackage(options.template || options.package);
  const templateDir = resolved.dir;
  const motionFile = path.join(templateDir, 'motion.json');
  if (!fs.existsSync(motionFile)) {
    console.error('找不到 motion.json：' + motionFile);
    return 2;
  }

  const motion = readJson(motionFile);
  const runtime = describeRuntime(motion);
  const shape = pickPath(runtime.profile);

  // 动态时长：fit-voiceover 需要先量音频，才能算帧数（契约里声明了就必须真能做到）
  let audioSeconds = null;
  if (options.audio) {
    const audioPath = path.resolve(String(options.audio));
    if (!fs.existsSync(audioPath)) {
      console.error('音频不存在：' + audioPath);
      return 2;
    }
    audioSeconds = probeAudio(audioPath).duration;
  }
  const plan = planFrames(runtime, { audioSeconds, audioOffset: Number(options['audio-offset'] || 0) });
  const total = Number(options.frames || plan.frames || 0);
  if (!total) {
    if (runtime.durationPolicy === 'fit-voiceover') {
      console.error('本模板时长策略是 fit-voiceover：必须给 --audio（或 --frames）才能确定帧数');
    } else if (runtime.durationPolicy === 'fit-content') {
      console.error('本模板时长策略是 fit-content：本版还不支持，请用 --frames 显式指定');
    } else {
      console.error('无法确定帧数：motion.json 既没有 output.frames 也没有 duration.seconds');
    }
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
  // 分片渲染：--range a-b 只渲染这一段（配合 --no-encode 落盘，供多机分别跑）
  let rangeStart = 0;
  let rangeEnd = total;
  if (options.range) {
    const match = String(options.range).match(/^(\d+)-(\d+)$/);
    if (!match) {
      console.error('--range 格式应为 a-b（含 a，不含 b），如 0-254');
      return 2;
    }
    rangeStart = Number(match[1]);
    rangeEnd = Number(match[2]);
    if (rangeStart >= rangeEnd || rangeEnd > total) {
      console.error('--range 越界：需满足 0 <= a < b <= ' + total);
      return 2;
    }
  }
  const framesOnly = Boolean(options['no-encode']);

  let workers = Number(options.workers || (framesOnly ? 1 : autoWorkers));
  let workersFallback = null;
  if (workers > 1 && !(motion.runtime && motion.runtime.stateless === true)) {
    workersFallback = '模板未声明 runtime.stateless，已强制串行（用 mykit conformance 验证后再打开）';
    process.stderr.write('[mykit] ' + workersFallback + '\n');
    workers = 1;
  }

  if (runtime.profile === 'external/adapter') {
    return renderExternal({
      templateDir,
      motion,
      runtime,
      total,
      outFile,
      inputs,
      options,
      rangeStart,
      rangeEnd,
      framesOnly,
      workers,
      workersFallback,
    });
  }

  if (workers > 1 || options.range || framesOnly) {
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
      workersFallback,
      rangeStart,
      rangeEnd,
      framesOnly,
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
        framePlan: { ...plan, frames: total },
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
  const { templateDir, motion, runtime, shape, total, outFile, inputs, source, quality, workers, options, workersFallback, rangeStart, rangeEnd, framesOnly } = ctx;
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
  // 分片渲染默认续跑：多个进程/多台机器各写一段，谁都不该清空别人的成果
  const resume = Boolean(options.resume) || framesOnly || Boolean(options.range);
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
      start: rangeStart,
      end: rangeEnd,
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
    let encodeMs = 0;
    let muxed = null;
    let media = null;

    if (framesOnly) {
      // 只出帧：多机/多次调用各跑一段，最后用 mykit encode 拼装
      const reportOnly = {
        template: templateDir,
        profile: runtime.profile,
        shape,
        detectedShape: shards.workersInfo.length ? shards.workersInfo[0].shape : null,
        entry: String(options.page || runtime.entry),
        framesDir,
        range: [rangeStart, rangeEnd],
        frames: rangeEnd - rangeStart,
        workers,
        workersInfo: shards.workersInfo,
        skipped: shards.skipped,
        setupMs: shards.setupMs,
        renderMs,
        framesPerSecond: Number(((rangeEnd - rangeStart) / (renderMs / 1000)).toFixed(2)),
        framesOnly: true,
      };
      console.log(JSON.stringify(reportOnly, null, 2));
      return 0;
    }

    encodeSequence({
      dir: framesDir,
      fps: runtime.fps,
      frames: total,
      out: outFile,
      crf: options.crf ? Number(options.crf) : 18,
    });
    encodeMs = Date.now() - encodeStarted;
    muxed = maybeMuxAudio(options, outFile);
    media = summarize(probeMedia(outFile));
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
      workersFallback,
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
  const target = resolvePackage(dir);
  const report = verifyPackage(target.dir);
  console.log(JSON.stringify({ packageSource: target.source, packageHash: target.hash || null, ...report }, null, 2));
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

/**
 * 统一入口：目录或 .motion/.zip 都接受。ZIP 按内容哈希解到 .tmp/packages/<hash>，
 * 同一个包第二次用直接复用解包结果。
 */
function resolvePackage(input) {
  const abs = path.resolve(String(input));
  if (!fs.existsSync(abs)) throw new Error('包不存在：' + abs);
  const stat = fs.statSync(abs);
  if (stat.isDirectory()) return { dir: abs, source: 'directory', bytes: null };
  const buffer = fs.readFileSync(abs);
  const hash = contentHash(buffer);
  const dest = path.join(process.cwd(), '.tmp', 'packages', hash);
  if (!fs.existsSync(path.join(dest, 'motion.json'))) {
    const info = unpackZip(buffer, dest);
    return { dir: dest, source: 'zip', hash, bytes: buffer.length, entries: info.entries, unpackedBytes: info.totalBytes };
  }
  return { dir: dest, source: 'zip', hash, bytes: buffer.length, cached: true };
}

function packCmd(options) {
  const dir = options.package || options.template;
  const out = options.out;
  if (!dir || !out) {
    console.error('pack 需要 --package <目录> --out <文件.zip>');
    return 2;
  }
  const entries = collectDirectory(dir);
  const buffer = writeZip(entries);
  fs.mkdirSync(path.dirname(path.resolve(String(out))), { recursive: true });
  fs.writeFileSync(path.resolve(String(out)), buffer);
  console.log(
    JSON.stringify(
      {
        out: path.resolve(String(out)),
        entries: entries.length,
        sourceBytes: entries.reduce((n, e) => n + e.data.length, 0),
        packageBytes: buffer.length,
        sha256: sha256(buffer),
      },
      null,
      2,
    ),
  );
  return 0;
}

function unpackCmd(options) {
  const file = options.package || options.zip;
  const out = options.out;
  if (!file || !out) {
    console.error('unpack 需要 --package <文件.zip> --out <目录>');
    return 2;
  }
  const buffer = fs.readFileSync(path.resolve(String(file)));
  const info = unpackZip(buffer, out);
  console.log(JSON.stringify({ dir: info.dir, entries: info.entries, totalBytes: info.totalBytes }, null, 2));
  return 0;
}

async function conformanceCmd(options) {
  const resolved = resolvePackage(options.template || options.package);
  const templateDir = resolved.dir;
  const motion = readJson(path.join(templateDir, 'motion.json'));
  const runtime = describeRuntime(motion);
  const shape = pickPath(runtime.profile);
  const { inputs } = resolveInputs(templateDir, options, runtime);
  const total = Number(options.frames || runtime.frameCount || 0);
  if (!total) {
    console.error('conformance 需要能确定帧数（motion.json 的 duration.seconds 或 --frames）');
    return 2;
  }

  // 连续段上限：检查要跑 0..maxSample，5055 帧的片子会白跑五分钟，默认只查前 600 帧
  const span = Number(options.span || 600);
  const limit = Math.min(total - 1, span);
  const samples = options.samples
    ? String(options.samples)
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n) && n >= 0 && n <= limit)
    : [0, Math.floor(limit * 0.25), Math.floor(limit * 0.5), Math.floor(limit * 0.75), limit];

  const chrome = findBrowser();
  if (!chrome.available) {
    console.error('找不到浏览器，请设置 CHROME_PATH');
    return 2;
  }
  const server = await serve(templateDir);
  try {
    const report = await checkStatelessness({
      executable: chrome.executable,
      origin: server.origin,
      pagePath: String(options.page || runtime.entry),
      width: runtime.width,
      height: runtime.height,
      shape,
      inputs,
      quality: Number(options.quality || 0.93),
      workDir: path.join(process.cwd(), '.tmp'),
      minPsnr: options['min-psnr'] ? Number(options['min-psnr']) : 45,
      samples,
    });
    console.log(
      JSON.stringify(
        {
          template: templateDir,
          packageSource: resolved.source,
          declaredStateless: Boolean(motion.runtime && motion.runtime.stateless),
          ...report,
        },
        null,
        2,
      ),
    );
    return report.stateless ? 0 : 1;
  } finally {
    await server.close();
  }
}

function encodeCmd(options) {
  const dir = options['frames-dir'];
  const out = options.out;
  if (!dir || !out) {
    console.error('encode 需要 --frames-dir <目录> --out <文件>（fps/帧数可由 --template 推断）');
    return 2;
  }

  let fps = Number(options.fps || 0);
  let frames = Number(options.frames || 0);
  if (options.template) {
    const resolved = resolvePackage(options.template);
    const runtime = describeRuntime(readJson(path.join(resolved.dir, 'motion.json')));
    fps = fps || runtime.fps;
    frames = frames || runtime.frameCount || 0;
  }
  if (!fps || !frames) {
    console.error('缺 fps 或帧数：给 --fps/--frames，或用 --template 让内核自己读');
    return 2;
  }

  const outFile = path.resolve(String(out));
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  encodeSequence({ dir: path.resolve(String(dir)), fps, frames, out: outFile, crf: options.crf ? Number(options.crf) : 18 });
  const muxed = maybeMuxAudio(options, outFile);
  console.log(JSON.stringify({ out: outFile, frames, fps, audio: muxed, media: summarize(probeMedia(outFile)) }, null, 2));
  return 0;
}

async function renderExternal(ctx) {
  const { templateDir, motion, runtime, total, outFile, inputs, options, rangeStart, rangeEnd, framesOnly, workers } = ctx;
  const templateKey =
    (motion.template && motion.template.id ? motion.template.id : path.basename(templateDir)) +
    '-' +
    ((motion.template && motion.template.version) || '0');
  const framesDir = path.resolve(String(options['frames-dir'] || path.join(process.cwd(), '.tmp', 'frames-' + templateKey)));

  const inputsFile = path.join(
    process.cwd(),
    '.tmp',
    'inputs-' + contentHash(Buffer.from(JSON.stringify(inputs, null, 2))) + '.json',
  );
  fs.mkdirSync(path.dirname(inputsFile), { recursive: true });
  fs.writeFileSync(inputsFile, JSON.stringify(inputs, null, 2));

  const span = rangeEnd - rangeStart;
  const shards = Math.max(1, Math.min(workers, span));
  const per = Math.ceil(span / shards);
  const jobs = [];
  for (let i = 0; i < shards; i += 1) {
    const start = rangeStart + i * per;
    const end = Math.min(rangeEnd, start + per);
    if (start < end) jobs.push({ start, end });
  }

  const started = Date.now();
  const results = await Promise.all(
    jobs.map(async (job) => {
      const spec = adapterCommand(runtime, { start: job.start, end: job.end, framesDir, inputsFile, templateDir });
      const run = await runAdapter({
        ...spec,
        start: job.start,
        end: job.end,
        framesDir,
        cwd: templateDir,
        timeout: Number(options['adapter-timeout'] || 0),
        log: (line) => process.stderr.write(line + '\n'),
      });
      return { range: [job.start, job.end], frames: run.produced.length };
    }),
  );
  const renderMs = Date.now() - started;

  const base = {
    template: templateDir,
    profile: runtime.profile,
    entry: String((runtime.adapter && runtime.adapter.command) || ''),
    inputsSource: inputsFile,
    framesDir,
    range: [rangeStart, rangeEnd],
    shards: results,
    setupMs: 0,
    renderMs,
    framesPerSecond: Number((span / (renderMs / 1000)).toFixed(2)),
  };

  if (framesOnly) {
    console.log(JSON.stringify({ ...base, frames: span, framesOnly: true }, null, 2));
    return 0;
  }

  const outFile2 = path.resolve(String(options.out));
  fs.mkdirSync(path.dirname(outFile2), { recursive: true });
  const encodeStarted = Date.now();
  encodeSequence({ dir: framesDir, fps: runtime.fps, frames: total, out: outFile2, crf: options.crf ? Number(options.crf) : 18 });
  const encodeMs = Date.now() - encodeStarted;
  const muxed = maybeMuxAudio(options, outFile2);
  const media = summarize(probeMedia(outFile2));

  const mismatches = [];
  if (!media.video || media.video.frames !== total) mismatches.push('frames ' + (media.video && media.video.frames) + ' != ' + total);
  if (media.video && media.video.width !== runtime.width) mismatches.push('width ' + media.video.width);
  if (media.video && media.video.height !== runtime.height) mismatches.push('height ' + media.video.height);
  if (media.video && media.video.primaries !== 'bt709') mismatches.push('primaries ' + media.video.primaries);

  console.log(
    JSON.stringify(
      { ...base, out: outFile2, frames: total, encodeMs, audio: muxed, media, ok: mismatches.length === 0, mismatches },
      null,
      2,
    ),
  );
  return mismatches.length === 0 ? 0 : 1;
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
    case 'conformance':
      return conformanceCmd(options);
    case 'encode':
      return encodeCmd(options);
    case 'pack':
      return packCmd(options);
    case 'unpack':
      return unpackCmd(options);
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
