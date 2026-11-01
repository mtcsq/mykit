/**
 * 最小 ZIP 读写（零依赖）。只用 node:zlib + 自己算 CRC32。
 *
 * 为什么需要：原生态分发的是单个 .motion 文件（本质是 ZIP），不读 ZIP 就只能渲染解包目录，
 * 等于"能跑别人的源码目录，接不住别人的交付物"。
 *
 * 硬边界（对齐 motion-spec 的声明式限制，也是防御 zip bomb 的唯一手段）：
 *   条目数 <= 5000 / 单文件解压后 <= 150 MiB / 总解压 <= 600 MiB / 超过 10 MiB 的文件压缩比 <= 200
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const LIMITS = {
  maxEntries: 5000,
  maxFileBytes: 150 * 1024 * 1024,
  maxTotalBytes: 600 * 1024 * 1024,
  ratioCheckMinBytes: 10 * 1024 * 1024,
  maxRatio: 200,
};

// —— CRC32 ——
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** 固定时间戳（1980-01-01），保证同样内容打出来的包字节一致。 */
const DOS_TIME = 0;
const DOS_DATE = (0 << 9) | (1 << 5) | 1; // 1980-01-01

/**
 * 打包。entries: [{ name, data }]（name 用 / 分隔、相对路径）。
 * 只做 deflate，不加密。
 */
export function writeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, 'utf8');
    const data = entry.data;
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 flag
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    locals.push(local, body);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4); // version made by
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + body.length;
  }

  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centrals.length, 8);
  eocd.writeUInt16LE(centrals.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([Buffer.concat(locals), centralBuf, eocd]);
}

/** 从目录收集条目（跳过 .git / node_modules / .tmp），按路径排序保证可复现。 */
export function collectDirectory(dir) {
  const base = path.resolve(dir);
  const out = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.tmp') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push({ name: path.relative(base, full).split(path.sep).join('/'), data: fs.readFileSync(full) });
    }
  };
  walk(base);
  return out;
}

function findEocd(buf) {
  const min = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * 读 ZIP 到内存（带边界校验）。
 * @returns {{ entries: Array<{name:string,data:Buffer}>, totalBytes:number }}
 */
export function readZip(buffer, limits = LIMITS) {
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error('不是合法 ZIP（找不到 EOCD）');

  const count = buffer.readUInt16LE(eocd + 10);
  const centralSize = buffer.readUInt32LE(eocd + 12);
  const centralOffset = buffer.readUInt32LE(eocd + 16);

  if (count > limits.maxEntries) throw new Error('条目数 ' + count + ' 超过上限 ' + limits.maxEntries);
  if (centralOffset + centralSize > buffer.length) throw new Error('中央目录越界');

  const entries = [];
  let cursor = centralOffset;
  let totalBytes = 0;

  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) throw new Error('中央目录项签名错误（第 ' + i + ' 项）');
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8');

    if (uncompressedSize > limits.maxFileBytes) {
      throw new Error(name + ' 解压后 ' + uncompressedSize + ' 字节，超过单文件上限');
    }
    if (compressedSize > limits.ratioCheckMinBytes && uncompressedSize / Math.max(1, compressedSize) > limits.maxRatio) {
      throw new Error(name + ' 压缩比 ' + Math.round(uncompressedSize / compressedSize) + ' 超过 ' + limits.maxRatio);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > limits.maxTotalBytes) throw new Error('解压总量超过 ' + limits.maxTotalBytes + ' 字节');

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(name + ' 的本地头签名错误');
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const raw = buffer.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(name + ' 使用了不支持的压缩方法 ' + method + '（仅 store/deflate）');

    if (data.length !== uncompressedSize) throw new Error(name + ' 解压长度不符');
    entries.push({ name, data });

    cursor += 46 + nameLen + extraLen + commentLen;
  }

  return { entries, totalBytes };
}

/** 安全解包到目录：拒绝绝对路径、..、盘符、反斜杠；软链不落地。 */
export function unpackZip(buffer, destDir, limits = LIMITS) {
  const dir = path.resolve(destDir);
  fs.mkdirSync(dir, { recursive: true });
  const { entries, totalBytes } = readZip(buffer, limits);

  for (const entry of entries) {
    const name = entry.name;
    if (name.includes('\\') || name.startsWith('/') || name.includes(':')) throw new Error('非法条目名：' + name);
    if (name.split('/').some((s) => s === '..' || s === '.' || s === '')) throw new Error('非法条目名：' + name);
    const target = path.resolve(dir, name);
    if (!target.startsWith(dir + path.sep)) throw new Error('条目越界：' + name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
  }

  return { entries: entries.length, totalBytes, dir };
}

/** 内容哈希，用作解包目录名（同样包解到同一处，可复用）。 */
export function contentHash(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex').slice(0, 12);
}
