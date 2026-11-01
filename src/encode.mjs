/**
 * FFmpeg 编码管道。
 *
 * 色彩链参数取自 626/_inner/render.mjs:20 的实测写法（sRGB JPEG -> BT.709 限幅），
 * 参数原样复用、代码全新实现。
 */
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

/** sRGB 显示色 -> BT.709 视频色的正确转换（漏了这步，暗部发绿、红色溢出）。 */
export const COLOR_CHAIN =
  'scale=in_primaries=bt709:in_transfer=iec61966-2-1:in_range=full' +
  ':out_primaries=bt709:out_transfer=iec61966-2-1:out_color_matrix=bt709:out_range=full,' +
  'format=yuv444p,' +
  'colorspace=ispace=bt709:irange=pc:iprimaries=bt709:itrc=srgb:space=bt709:range=tv' +
  ':primaries=bt709:trc=bt709:format=yuv420p,sidedata=mode=delete';

export function videoArgs({ fps, frames, out, crf = 18, preset = 'veryfast' }) {
  return [
    '-y',
    '-v', 'error',
    '-f', 'image2pipe',
    '-vcodec', 'mjpeg',
    '-framerate', String(fps),
    '-i', 'pipe:0',
    '-vf', COLOR_CHAIN,
    '-c:v', 'libx264',
    '-preset', preset,
    '-crf', String(crf),
    '-pix_fmt', 'yuv420p',
    '-frames:v', String(frames),
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-color_range', 'tv',
    '-movflags', '+faststart',
    out,
  ];
}

/**
 * 起一个 ffmpeg 进程，往里写 JPEG 帧。
 * @returns {{ write:(buf:Buffer)=>Promise<void>, finish:()=>Promise<{code:number}>, kill:()=>void }}
 */
export function createEncoder(options) {
  const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const child = spawn(ffmpegPath, videoArgs(options), { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });

  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const closed = new Promise((resolve, reject) => {
    child.once('error', (error) => reject(new Error('ffmpeg 启动失败：' + error.message)));
    child.once('close', (code) => {
      if (code === 0) resolve({ code, stderr });
      else reject(new Error('ffmpeg 退出码 ' + code + '\n' + stderr.trim()));
    });
  });

  let broken = null;
  child.stdin.on('error', (error) => {
    broken = error;
  });

  return {
    async write(buffer) {
      if (broken) throw new Error('ffmpeg 管道已断开：' + broken.message);
      if (!child.stdin.write(buffer)) await once(child.stdin, 'drain');
    },
    async finish() {
      child.stdin.end();
      return closed;
    },
    kill() {
      if (child.exitCode === null) child.kill();
    },
  };
}

/** 从 JPEG 序列编码（并发渲染落盘后走这条路，比共享管道简单且可断点续跑）。 */
export function encodeSequence(options) {
  const ffmpegPath = options.ffmpegPath || process.env.FFMPEG_PATH || 'ffmpeg';
  const input = options.dir + '/f%05d.jpg';
  const args = [
    '-y',
    '-v', 'error',
    '-framerate', String(options.fps),
    '-i', input,
    '-vf', COLOR_CHAIN,
    '-c:v', 'libx264',
    '-preset', options.preset || 'veryfast',
    '-crf', String(options.crf ?? 18),
    '-pix_fmt', 'yuv420p',
    '-frames:v', String(options.frames),
    '-color_primaries', 'bt709',
    '-color_trc', 'bt709',
    '-colorspace', 'bt709',
    '-color_range', 'tv',
    '-movflags', '+faststart',
    options.out,
  ];
  const r = spawnSync(ffmpegPath, args, { encoding: 'utf8', windowsHide: true });
  if (r.error) throw new Error('ffmpeg 执行失败：' + r.error.message);
  if (r.status !== 0) throw new Error('ffmpeg 退出码 ' + r.status + '\n' + (r.stderr || '').trim());
  return { code: r.status };
}

/** ffprobe 结构化读取；失败抛出带 stderr 的错误。 */
export function probeMedia(file, options = {}) {
  const ffprobePath = options.ffprobePath || process.env.FFPROBE_PATH || 'ffprobe';
  const r = spawnSync(
    ffprobePath,
    [
      '-v', 'error',
      '-show_entries',
      'stream=index,codec_type,codec_name,width,height,r_frame_rate,nb_frames,pix_fmt,color_primaries,color_transfer,color_space,color_range',
      '-show_entries', 'format=duration,size',
      '-of', 'json',
      file,
    ],
    { encoding: 'utf8', windowsHide: true },
  );
  if (r.error) throw new Error('ffprobe 执行失败：' + r.error.message);
  if (r.status !== 0) throw new Error('ffprobe 退出码 ' + r.status + '\n' + (r.stderr || '').trim());
  return JSON.parse(r.stdout);
}

/** 从 ffprobe 结果里抽出用于断言的视频流摘要。 */
export function summarize(probe) {
  const streams = probe.streams || [];
  const video = streams.find((s) => s.codec_type === 'video') || null;
  const audio = streams.find((s) => s.codec_type === 'audio') || null;
  return {
    video: video && {
      codec: video.codec_name,
      width: video.width,
      height: video.height,
      fps: video.r_frame_rate,
      frames: video.nb_frames !== undefined ? Number(video.nb_frames) : null,
      pixFmt: video.pix_fmt,
      primaries: video.color_primaries,
      transfer: video.color_transfer,
      space: video.color_space,
      range: video.color_range,
    },
    audio: audio ? { codec: audio.codec_name } : null,
    duration: probe.format ? Number(probe.format.duration) : null,
    size: probe.format ? Number(probe.format.size) : null,
  };
}
