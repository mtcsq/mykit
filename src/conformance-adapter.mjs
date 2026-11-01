/**
 * 适配器模板的一致性检查。
 *
 * 适配器没有浏览器状态，"串行段 vs 孤立帧"那套不适用。能查的是更直接的一件事：
 * 同一帧跑两次独立进程，产出是否逐字节相同——这既是确定性，也是分片安全的前提。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runAdapter, adapterCommand } from './adapter.mjs';

const sha256 = (buffer) => crypto.createHash('sha256').update(buffer).digest('hex');

export async function checkAdapterDeterminism(ctx) {
  const dir = path.join(ctx.workDir, 'conformance-adapter');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const inputsFile = path.join(ctx.workDir, 'inputs-adapter.json');
  fs.writeFileSync(inputsFile, JSON.stringify(ctx.inputs || {}, null, 2));

  const started = Date.now();
  const samples = [];

  for (const frame of ctx.samples) {
    const outs = [];
    for (const tag of ['a', 'b']) {
      const outDir = path.join(dir, 'f' + frame + '-' + tag);
      const spec = adapterCommand(ctx.runtime, {
        start: frame,
        end: frame + 1,
        framesDir: outDir,
        inputsFile,
        templateDir: ctx.templateDir,
      });
      await runAdapter({ ...spec, start: frame, end: frame + 1, framesDir: outDir, cwd: ctx.templateDir });
      const jpg = path.join(outDir, 'f' + String(frame).padStart(5, '0') + '.jpg');
      const png = path.join(outDir, 'f' + String(frame).padStart(5, '0') + '.png');
      const file = fs.existsSync(jpg) ? jpg : png;
      outs.push({ file, sha256: sha256(fs.readFileSync(file)) });
    }
    samples.push({
      frame,
      sha256A: outs[0].sha256.slice(0, 16),
      sha256B: outs[1].sha256.slice(0, 16),
      same: outs[0].sha256 === outs[1].sha256,
    });
  }

  const allSame = samples.every((s) => s.same);
  return {
    stateless: allSame,
    shape: 'adapter',
    threshold: '同一帧两次独立进程产出的 sha256 全等',
    byteExact: allSame,
    minPsnr: null,
    samples,
    timing: { totalMs: Date.now() - started },
  };
}
