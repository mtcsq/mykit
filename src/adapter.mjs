/**
 * external/adapter 协议：把"用别的工具链渲染"变成一种契约，而不是把别人的工具链塞进内核。
 *
 * 为什么这么设计（ADR-10）：
 *  - 原生态里有 native-python-node/1（3 个包）和 remotion-project/1（1 个包）。直接支持意味着
 *    内核要依赖 Python、要懂 Remotion 的打包，违反"零依赖"。
 *  - 把渲染交给包自己的适配器，内核只管三件事：切帧区间、等它退出、把帧编码成片。
 *  - 代价：模板作者要写一个适配器（通常 20–50 行）；收益：任何工具链都能接，内核不变。
 *
 * 适配器约定：收到帧区间 [start,end)，把 fNNNNN.jpg（或 .png）写进 --out 目录，序号 5 位补零，
 * 退出码 0 表示成功。别的什么都不用管。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function adapterCommand(runtime, ctx) {
  const spec = (runtime && runtime.adapter) || {};
  if (!spec.command) throw new Error('external/adapter profile 必须在 runtime.adapter.command 声明可执行程序');
  const args = (spec.args || []).map((arg) =>
    String(arg)
      .replace(/\{start\}/g, String(ctx.start))
      .replace(/\{end\}/g, String(ctx.end))
      .replace(/\{out\}/g, ctx.framesDir)
      .replace(/\{inputs\}/g, ctx.inputsFile || '')
      .replace(/\{template\}/g, ctx.templateDir),
  );
  return { command: spec.command, args };
}

export function frameFile(dir, frame) {
  return path.join(dir, 'f' + String(frame).padStart(5, '0') + '.jpg');
}

/**
 * 跑一次适配器。返回 { code, stdout, stderr, produced:number[], missing:number[] }。
 */
export async function runAdapter(options) {
  const { command, args, start, end, framesDir, timeout = 0, log = () => {} } = options;
  fs.mkdirSync(framesDir, { recursive: true });

  // 适配器通常用相对路径引用自己的脚本，cwd 必须是包目录
  const child = spawn(command, args, { windowsHide: true, cwd: options.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (stdout.length > 200000) stdout = stdout.slice(-200000);
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
    if (stderr.length > 200000) stderr = stderr.slice(-200000);
    log(String(chunk).trimEnd());
  });

  let timer = null;
  if (timeout > 0) {
    timer = setTimeout(() => {
      stderr += '\n[mykit] 适配器超时，已终止';
      child.kill();
    }, timeout);
  }

  const code = await new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error('适配器启动失败（' + command + '）：' + error.message)));
    child.once('close', (value) => resolve(value));
  });
  if (timer) clearTimeout(timer);

  const produced = [];
  const missing = [];
  for (let frame = start; frame < end; frame += 1) {
    const jpg = frameFile(framesDir, frame);
    const png = path.join(framesDir, 'f' + String(frame).padStart(5, '0') + '.png');
    if (fs.existsSync(jpg)) produced.push(frame);
    else if (fs.existsSync(png)) produced.push(frame);
    else missing.push(frame);
  }

  if (code !== 0) throw new Error('适配器退出码 ' + code + '\n' + stderr.trim());
  if (missing.length) {
    throw new Error('适配器没有产出这些帧：' + missing.slice(0, 5).join(', ') + (missing.length > 5 ? ' …' : ''));
  }

  return { code, stdout, stderr, produced, missing };
}
