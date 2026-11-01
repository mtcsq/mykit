/**
 * 音轨挂载：给已成片的视频加一条外部音轨（不内置合成器，v1 只做挂载）。
 *
 * 为什么必须有：57 个真实模板里 40 个需要配乐，没有这个开关等于体系无法交付带声音的成片。
 * 视频流直接 copy，不重编码，所以加音轨几乎不增加时间。
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function probeAudio(file, options = {}) {
  const ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
  const r = spawnSync(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,channels,sample_rate:format=duration', '-of', 'json', file],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.error) throw new Error('ffprobe 执行失败：' + r.error.message);
  if (r.status !== 0) throw new Error('音频不可读：' + (r.stderr || '').trim());
  const data = JSON.parse(r.stdout);
  const streams = data.streams || [];
  // 必须挑音轨：成片里第一条流通常是视频，直接取 [0] 会把它当音频报出去
  const stream = streams.find((s) => s.codec_type === 'audio') || streams[0] || {};
  return {
    codec: stream.codec_name || null,
    channels: stream.channels || null,
    sampleRate: stream.sample_rate ? Number(stream.sample_rate) : null,
    duration: data.format ? Number(data.format.duration) : null,
  };
}

/**
 * 把音轨混进视频（视频流 copy）。原地替换：先写 .tmp 再改名。
 * @returns {{ codec:string, offset:number, gain:number, duration:number|null }}
 */
export function muxAudio({ video, audio, offset = 0, gain = 1, ffmpegPath }) {
  if (!fs.existsSync(video)) throw new Error('视频不存在：' + video);
  if (!fs.existsSync(audio)) throw new Error('音频不存在：' + audio);
  const bin = ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const temp = video.replace(/\.mp4$/i, '') + '.mux.mp4';

  const filters = [];
  if (gain !== 1) filters.push('volume=' + gain);
  if (offset > 0) filters.push('adelay=' + Math.round(offset * 1000) + ':all=1');

  const args = ['-y', '-v', 'error', '-i', video, '-i', audio, '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000'];
  if (filters.length) args.push('-af', filters.join(','));
  args.push('-shortest', '-movflags', '+faststart', temp);

  const r = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error('ffmpeg 执行失败：' + r.error.message);
  if (r.status !== 0) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      /* 忽略 */
    }
    throw new Error('加音轨失败（退出码 ' + r.status + '）：' + (r.stderr || '').trim());
  }

  fs.rmSync(video, { force: true });
  fs.renameSync(temp, video);
  const probe = probeAudio(video, { ffprobePath: process.env.FFPROBE_PATH });
  return { codec: 'aac', offset, gain, duration: probe.duration };
}
