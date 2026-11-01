/**
 * 模板包静态检查（自有契约 mykit-template/0.1）。
 *
 * 只做"能不能安全地渲染"的检查，不做审美判断。全部错误都带路径，方便直接改。
 */
import fs from 'node:fs';
import path from 'node:path';
import { verifyManifest } from './integrity.mjs';

export const SPEC_VERSION = '0.1.0';
export const PROFILES = ['html/canvas', 'html/dom'];
export const DURATION_POLICIES = ['fixed', 'fit-voiceover', 'fit-content'];
export const LICENSES = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'CC0-1.0'];

const GUIDE_SECTIONS = ['fit', 'duration', 'materials', 'copy', 'conversation', 'hostWithoutTools'];

/** 包内相对路径必须是无逃逸的 / 路径，且指向包内真实文件。 */
function checkInside(packageDir, rel, errors, label, { mustExist = true } = {}) {
  if (typeof rel !== 'string' || !rel) {
    errors.push(label + '：必须是非空字符串');
    return null;
  }
  if (rel.includes('\\') || rel.startsWith('/') || rel.includes(':')) {
    errors.push(label + '：只允许 / 分隔的相对路径（' + rel + '）');
    return null;
  }
  if (rel.split('/').some((s) => s === '..' || s === '.' || s === '')) {
    errors.push(label + '：不允许 . / .. / 空段（' + rel + '）');
    return null;
  }
  const abs = path.resolve(packageDir, rel);
  if (abs !== packageDir && !abs.startsWith(packageDir + path.sep)) {
    errors.push(label + '：越出包目录（' + rel + '）');
    return null;
  }
  if (mustExist && !fs.existsSync(abs)) errors.push(label + '：文件不存在（' + rel + '）');
  return abs;
}

function readJson(abs, errors, label) {
  try {
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch (error) {
    errors.push(label + '：JSON 解析失败（' + error.message + '）');
    return null;
  }
}

function isPositiveInt(v) {
  return Number.isInteger(v) && v > 0;
}

export function verifyPackage(packageDir) {
  const dir = path.resolve(packageDir);
  const errors = [];
  const warnings = [];

  if (!fs.existsSync(dir)) return { ok: false, errors: ['包目录不存在：' + dir], warnings: [], info: {} };

  const motionFile = path.join(dir, 'motion.json');
  if (!fs.existsSync(motionFile)) return { ok: false, errors: ['缺少 motion.json'], warnings: [], info: {} };
  const motion = readJson(motionFile, errors, 'motion.json');
  if (!motion) return { ok: false, errors, warnings, info: {} };

  // —— 顶层标识 ——
  if (motion.format !== 'mykit-template') errors.push('format 必须是 "mykit-template"，实际 ' + JSON.stringify(motion.format));
  if (motion.specVersion !== SPEC_VERSION) errors.push('specVersion 必须是 ' + SPEC_VERSION + '，实际 ' + JSON.stringify(motion.specVersion));

  const tpl = motion.template || {};
  if (!tpl.id || !/^[a-z0-9][a-z0-9-]*$/.test(tpl.id)) errors.push('template.id 只能是小写字母数字与连字符');
  if (!tpl.version || !/^\d+\.\d+\.\d+/.test(tpl.version)) errors.push('template.version 必须是语义化版本');
  if (!LICENSES.includes(tpl.license)) errors.push('template.license 必须是 ' + LICENSES.join(' / ') + '，实际 ' + JSON.stringify(tpl.license));
  if (tpl.license === 'MIT' && !fs.existsSync(path.join(dir, 'LICENSE'))) errors.push('template.license 为 MIT 但包内没有 LICENSE 文件');

  // —— 运行时 ——
  const runtime = motion.runtime || {};
  if (!PROFILES.includes(runtime.profile)) errors.push('runtime.profile 必须是 ' + PROFILES.join(' / ') + '，实际 ' + JSON.stringify(runtime.profile));
  checkInside(dir, runtime.entry, errors, 'runtime.entry');
  if (runtime.stateless !== undefined && typeof runtime.stateless !== 'boolean') {
    errors.push('runtime.stateless 若出现必须是布尔值（声明后可并发，需先过 mykit conformance）');
  }

  // —— 输出规格 ——
  const output = motion.output || {};
  if (!isPositiveInt(output.width) || !isPositiveInt(output.height)) errors.push('output.width/height 必须是正整数');
  if (output.width % 2 || output.height % 2) errors.push('output.width/height 必须是偶数（h264 yuv420p 要求）');
  const fps = output.fps || {};
  if (!isPositiveInt(fps.num) || !isPositiveInt(fps.den)) errors.push('output.fps.num/den 必须是正整数');

  const duration = output.duration || {};
  if (!DURATION_POLICIES.includes(duration.policy)) {
    errors.push('output.duration.policy 必须是 ' + DURATION_POLICIES.join(' / '));
  } else if (duration.policy === 'fixed') {
    if (!(typeof duration.seconds === 'number' && duration.seconds > 0)) errors.push('固定时长必须给 output.duration.seconds > 0');
  } else if (!(typeof duration.maxSeconds === 'number' && duration.maxSeconds > 0)) {
    errors.push('动态时长（' + duration.policy + '）必须给 output.duration.maxSeconds');
  }

  const frames =
    duration.policy === 'fixed' && typeof duration.seconds === 'number' && fps.num
      ? Math.round((duration.seconds * fps.num) / (fps.den || 1))
      : null;

  // —— 参数 ——
  const params = motion.parameters || {};
  const schemaAbs = checkInside(dir, params.schema, errors, 'parameters.schema');
  let schema = null;
  if (schemaAbs) {
    schema = readJson(schemaAbs, errors, 'parameters.schema');
    if (schema && schema.type !== 'object') errors.push('parameters.schema 的 type 必须是 object');
  }
  const presetAbs = params.defaultPreset ? checkInside(dir, params.defaultPreset, errors, 'parameters.defaultPreset') : null;
  let preset = null;
  if (presetAbs) preset = readJson(presetAbs, errors, 'parameters.defaultPreset');

  // —— 指南（可选但强烈建议：给 AI 编排用） ——
  if (motion.guide) {
    const guideAbs = checkInside(dir, motion.guide, errors, 'guide');
    if (guideAbs) {
      const guide = readJson(guideAbs, errors, 'guide');
      if (guide) {
        const missing = GUIDE_SECTIONS.filter((k) => !(k in guide));
        if (missing.length) warnings.push('guide 缺少段落：' + missing.join(', '));
      }
    }
  } else {
    warnings.push('没有 guide 字段：AI 无法知道该问用户什么、该收哪些素材');
  }

  // —— 离线硬约束 ——
  const permissions = motion.permissions || {};
  if (permissions.network !== false) errors.push('permissions.network 必须是 false（本体系要求离线可渲染）');

  // —— 完整性 ——
  let integrity = null;
  if (motion.integrity) {
    integrity = verifyManifest(dir);
    if (!integrity.ok) {
      if (integrity.reason) errors.push('integrity：' + integrity.reason);
      if (integrity.missing && integrity.missing.length) errors.push('integrity 缺失文件：' + integrity.missing.slice(0, 5).join(', '));
      if (integrity.extra && integrity.extra.length) warnings.push('integrity 未覆盖的文件：' + integrity.extra.slice(0, 5).join(', '));
      if (integrity.mismatched && integrity.mismatched.length) errors.push('integrity 哈希不符：' + integrity.mismatched.slice(0, 5).join(', '));
    }
  } else {
    warnings.push('没有 integrity 字段：无法发现内容被改动');
  }

  // —— 预设必须符合参数 schema 的必填字段 ——
  if (schema && preset && Array.isArray(schema.required)) {
    const missing = schema.required.filter((k) => !(k in preset));
    if (missing.length) errors.push('defaultPreset 缺少必填参数：' + missing.join(', '));
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    info: {
      id: tpl.id,
      version: tpl.version,
      license: tpl.license,
      profile: runtime.profile,
      entry: runtime.entry,
      size: output.width + 'x' + output.height,
      fps: fps.num + '/' + fps.den,
      durationPolicy: duration.policy,
      frames,
      filesCovered: integrity && integrity.declaredCount,
    },
  };
}
