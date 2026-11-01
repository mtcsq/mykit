import test from 'node:test';
import assert from 'node:assert/strict';
import { videoArgs, COLOR_CHAIN, summarize } from '../../src/encode.mjs';

const args = videoArgs({ fps: 30, frames: 254, out: 'out.mp4' });

test('视频参数带 BT.709 显式标记与限幅', () => {
  for (const key of ['-color_primaries', '-color_trc', '-colorspace', '-color_range']) {
    assert.ok(args.includes(key), key + ' 缺失');
  }
  assert.equal(args[args.indexOf('-color_primaries') + 1], 'bt709');
  assert.equal(args[args.indexOf('-color_range') + 1], 'tv');
});

test('帧数钉死，避免管道读多写多', () => {
  assert.equal(args[args.indexOf('-frames:v') + 1], '254');
});

test('编码器与像素格式固定', () => {
  assert.equal(args[args.indexOf('-c:v') + 1], 'libx264');
  assert.equal(args[args.indexOf('-pix_fmt') + 1], 'yuv420p');
  assert.ok(args.includes('+faststart'));
});

test('色彩链包含 sRGB -> BT.709 的转换', () => {
  assert.ok(COLOR_CHAIN.includes('in_transfer=iec61966-2-1'));
  assert.ok(COLOR_CHAIN.includes('out_color_matrix=bt709'));
  assert.ok(COLOR_CHAIN.includes('format=yuv420p'));
});

test('summarize 抽取视频摘要', () => {
  const summary = summarize({
    streams: [
      { codec_type: 'video', codec_name: 'h264', width: 1920, height: 1080, r_frame_rate: '30/1', nb_frames: '254', pix_fmt: 'yuv420p', color_primaries: 'bt709' },
      { codec_type: 'audio', codec_name: 'aac' },
    ],
    format: { duration: '8.46', size: '1413086' },
  });
  assert.equal(summary.video.frames, 254);
  assert.equal(summary.video.width, 1920);
  assert.equal(summary.audio.codec, 'aac');
  assert.equal(summary.duration, 8.46);
});
