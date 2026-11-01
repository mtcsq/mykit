/**
 * SHA-256 闭包：给一个模板包生成/校验 integrity.json。
 *
 * 设计取舍：只覆盖包内文件，integrity.json 自身不入清单（自指无法收敛）；
 * 路径统一用 / 分隔并排序，保证同样内容在任何机器上产出同样的清单。
 * 软件包体积上限留给 ZIP 读取层（本版不做 ZIP，见 spec 的未实现项）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ALGORITHM = 'sha256';
export const INTEGRITY_FILE = 'integrity.json';

function walk(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      walk(full, base, out);
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 生成清单（不含 integrity.json 自身）。 */
export function buildManifest(packageDir) {
  const dir = path.resolve(packageDir);
  const files = {};
  for (const rel of walk(dir).sort()) {
    if (rel === INTEGRITY_FILE) continue;
    files[rel] = sha256File(path.join(dir, rel));
  }
  return { algorithm: ALGORITHM, files };
}

/** 写入 integrity.json，返回清单。 */
export function writeManifest(packageDir) {
  const manifest = buildManifest(packageDir);
  fs.writeFileSync(path.join(path.resolve(packageDir), INTEGRITY_FILE), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

/**
 * 校验：missing（清单有、磁盘无）/ extra（磁盘有、清单无）/ mismatched（哈希不同）。
 */
export function verifyManifest(packageDir) {
  const dir = path.resolve(packageDir);
  const file = path.join(dir, INTEGRITY_FILE);
  if (!fs.existsSync(file)) {
    return { ok: false, reason: '缺少 ' + INTEGRITY_FILE, missing: [], extra: [], mismatched: [] };
  }
  let declared;
  try {
    declared = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return { ok: false, reason: INTEGRITY_FILE + ' 不是合法 JSON：' + error.message, missing: [], extra: [], mismatched: [] };
  }
  if (declared.algorithm !== ALGORITHM) {
    return { ok: false, reason: '不支持的算法：' + declared.algorithm, missing: [], extra: [], mismatched: [] };
  }

  const actual = buildManifest(dir);
  const declaredFiles = declared.files || {};
  const missing = Object.keys(declaredFiles).filter((rel) => !(rel in actual.files));
  const extra = Object.keys(actual.files).filter((rel) => !(rel in declaredFiles));
  const mismatched = Object.keys(declaredFiles).filter(
    (rel) => rel in actual.files && declaredFiles[rel] !== actual.files[rel],
  );

  return {
    ok: missing.length === 0 && extra.length === 0 && mismatched.length === 0,
    reason: null,
    declaredCount: Object.keys(declaredFiles).length,
    actualCount: Object.keys(actual.files).length,
    missing,
    extra,
    mismatched,
  };
}
