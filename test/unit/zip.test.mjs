import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { writeZip, readZip, unpackZip, collectDirectory } from '../../src/zip.mjs';

const work = path.resolve('.tmp/test-zip');

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

test('打包可复现：同样内容打两次字节一致', () => {
  const entries = [
    { name: 'a.txt', data: Buffer.from('hello') },
    { name: 'dir/b.json', data: Buffer.from('{"k":1}') },
  ];
  assert.equal(sha(writeZip(entries)), sha(writeZip(entries)));
});

test('往返：写入再读出内容一致', () => {
  const entries = [{ name: 'x/y.txt', data: Buffer.from('内容') }];
  const { entries: back, totalBytes } = readZip(writeZip(entries));
  assert.equal(back.length, 1);
  assert.equal(back[0].name, 'x/y.txt');
  assert.equal(back[0].data.toString('utf8'), '内容');
  assert.equal(totalBytes, Buffer.byteLength('内容'));
});

test('解包：拒绝路径穿越', () => {
  assert.throws(() => unpackZip(writeZip([{ name: '../evil.txt', data: Buffer.from('x') }]), work + '/a'), /非法条目名/);
});

test('解包：拒绝绝对路径', () => {
  assert.throws(() => unpackZip(writeZip([{ name: '/etc/passwd', data: Buffer.from('x') }]), work + '/b'), /非法条目名/);
});

test('解包：拒绝反斜杠路径', () => {
  assert.throws(() => unpackZip(writeZip([{ name: 'a\\..\\b.txt', data: Buffer.from('x') }]), work + '/c'), /非法条目名/);
});

test('解包：正常包落地正确', () => {
  const info = unpackZip(writeZip([{ name: 'p/q.txt', data: Buffer.from('ok') }]), work + '/ok');
  assert.equal(info.entries, 1);
  assert.equal(fs.readFileSync(path.join(work, 'ok/p/q.txt'), 'utf8'), 'ok');
});

test('条目数超过 5000 要拒绝', () => {
  const many = [];
  for (let i = 0; i <= 5000; i += 1) many.push({ name: 'f' + i + '.txt', data: Buffer.from('x') });
  assert.throws(() => readZip(writeZip(many)), /超过上限/);
});

test('collectDirectory 跳过 .git / node_modules / .tmp', () => {
  const dir = path.join(work, 'collect');
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.git', 'x'), 'x');
  fs.writeFileSync(path.join(dir, 'src', 'a.js'), 'a');
  fs.writeFileSync(path.join(dir, 'b.txt'), 'b');
  const names = collectDirectory(dir).map((e) => e.name);
  assert.deepEqual(names.sort(), ['b.txt', 'src/a.js']);
});
