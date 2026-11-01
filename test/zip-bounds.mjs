#!/usr/bin/env node
/**
 * ZIP 边界测试：越界条目、绝对路径、条目数上限、正常包。
 * 运行：node test/zip-bounds.mjs
 */
import { writeZip, readZip, unpackZip } from '../src/zip.mjs';

const cases = [];
function tryCase(label, fn) {
  try {
    fn();
    cases.push({ label, blocked: false });
  } catch (error) {
    cases.push({ label, blocked: true, reason: error.message.slice(0, 80) });
  }
}

tryCase('路径穿越 ../evil.txt', () => unpackZip(writeZip([{ name: '../evil.txt', data: Buffer.from('x') }]), '.tmp/zip-evil'));
tryCase('绝对路径 /etc/passwd', () => unpackZip(writeZip([{ name: '/etc/passwd', data: Buffer.from('x') }]), '.tmp/zip-evil'));
tryCase('反斜杠 windows 路径', () => unpackZip(writeZip([{ name: 'a\\..\\b.txt', data: Buffer.from('x') }]), '.tmp/zip-evil'));
tryCase('条目数 5001', () => {
  const many = [];
  for (let i = 0; i <= 5000; i += 1) many.push({ name: 'f' + i + '.txt', data: Buffer.from('x') });
  readZip(writeZip(many));
});
tryCase('正常包应通过', () => {
  const info = unpackZip(writeZip([{ name: 'a/b.txt', data: Buffer.from('hello') }]), '.tmp/zip-ok');
  if (info.entries !== 1) throw new Error('条目数不对');
});

const ok =
  cases[0].blocked && cases[1].blocked && cases[2].blocked && cases[3].blocked && cases[4].blocked === false;
console.log(JSON.stringify({ ok, cases }, null, 2));
process.exit(ok ? 0 : 1);
