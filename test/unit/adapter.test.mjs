import test from 'node:test';
import assert from 'node:assert/strict';
import { adapterCommand } from '../../src/adapter.mjs';

const runtime = {
  adapter: {
    command: 'node',
    args: ['adapter.mjs', '--frames', '{start}-{end}', '--out', '{out}', '--inputs', '{inputs}', '--template', '{template}'],
  },
};

test('占位符全部替换', () => {
  const spec = adapterCommand(runtime, {
    start: 10,
    end: 20,
    framesDir: '/tmp/frames',
    inputsFile: '/tmp/inputs.json',
    templateDir: '/pkg',
  });
  assert.equal(spec.command, 'node');
  assert.deepEqual(spec.args, [
    'adapter.mjs',
    '--frames',
    '10-20',
    '--out',
    '/tmp/frames',
    '--inputs',
    '/tmp/inputs.json',
    '--template',
    '/pkg',
  ]);
});

test('缺 command 必须报错，而不是静默跑空', () => {
  assert.throws(() => adapterCommand({ adapter: {} }, { start: 0, end: 1 }), /必须.*command/);
});

test('缺 inputs 时占位符变成空串（不写 "undefined"）', () => {
  const spec = adapterCommand(runtime, { start: 0, end: 1, framesDir: '/x', templateDir: '/pkg' });
  const i = spec.args.indexOf('--inputs');
  assert.equal(spec.args[i + 1], '');
});
