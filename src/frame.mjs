/**
 * 取帧：按 profile 分流，不做"默认一条路 + 静默回落"。
 *
 *  - canvas 路径：页面内 canvas.toDataURL('image/jpeg', q)，快（参考 892）
 *  - dom 路径：Page.captureScreenshot(jpeg)，兼容性最好（参考 891 / 626）
 *
 * canvas 路径明确失败时（tainted canvas / 无 canvas）会回落 screenshot，并在结果里标 fallback=true，
 * 不把失败藏起来。
 */

export function pickPath(profile) {
  return /canvas/i.test(String(profile || '')) ? 'canvas' : 'dom';
}

/**
 * 实测决定取帧路径：声明 html-canvas/1 不等于页面真有 canvas。
 * 873 就是反例——声明 canvas、页面零个 canvas，全靠 DOM/CSS。
 * 只降级不升级：声明 dom 时即使有 canvas 也走截图（canvas 通常只是背景层）。
 */
export async function detectShape(page, declared) {
  const info = await page.evaluate(
    '(function(){var l=document.querySelectorAll("canvas");var best=0;' +
      'for(var i=0;i<l.length;i++){var a=(l[i].width||0)*(l[i].height||0);if(a>best)best=a;}' +
      'return {count:l.length,area:best};})()',
  );
  if (declared === 'canvas' && info.area > 0) return { shape: 'canvas', declared, reason: null };
  if (declared === 'canvas') {
    return { shape: 'dom', declared, reason: '声明 canvas 但页面无可用 canvas（' + info.count + ' 个），已降级为截图' };
  }
  return { shape: 'dom', declared, reason: null };
}

/** 找页面上面积最大的 canvas 并直接返回 dataURL；没有 canvas 返回 null。 */
function canvasDataUrlExpr(quality) {
  return (
    '(function(){' +
    'var list=document.querySelectorAll("canvas");var best=null,bestArea=0;' +
    'for(var i=0;i<list.length;i++){var c=list[i];var a=(c.width||0)*(c.height||0);if(a>bestArea){bestArea=a;best=c;}}' +
    'if(!best||!bestArea)return null;' +
    // 强制一次读回，确保 2D 绘制指令已经真正光栅化。并发负载下不加这一步，
    // toDataURL 可能拿到尚未完成的画面（实测 4 worker 渲染 892 时 133 帧之后开始分叉）。
    'try{best.getContext("2d").getImageData(0,0,1,1);}catch(e){}' +
    'return best.toDataURL("image/jpeg",' + Number(quality) + ');' +
    '})()'
  );
}

/**
 * @returns {Promise<{ bytes:Buffer, path:'canvas'|'dom', fallback:boolean, note?:string }>}
 */
export async function capture(page, options = {}) {
  const path = options.path || 'dom';
  const quality = options.quality ?? 0.93;
  const notes = [];

  if (path === 'canvas') {
    try {
      const dataUrl = await page.evaluate(canvasDataUrlExpr(quality));
      if (typeof dataUrl === 'string' && dataUrl.startsWith('data:image/')) {
        return { bytes: Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'), path: 'canvas', fallback: false };
      }
      notes.push('页面没有可用的 canvas');
    } catch (error) {
      notes.push('toDataURL 失败：' + error.message);
    }
  }

  const shot = await page.send('Page.captureScreenshot', {
    format: 'jpeg',
    quality: Math.round(quality * 100),
    captureBeyondViewport: false,
    fromSurface: true,
  });
  return {
    bytes: Buffer.from(shot.data, 'base64'),
    path: 'dom',
    fallback: path === 'canvas',
    note: notes.join('; ') || undefined,
  };
}


/**
 * 帧数规划：把契约里的三种时长策略真正算出来。
 *
 *  - fixed            → 由 seconds 算，与音频无关
 *  - fit-voiceover    → 由配音时长算，受 maxSeconds 夹紧（音频比上限长就截断）
 *  - fit-content      → 目前没有内容长度来源，交回调用方（拿不到就报错，不瞎猜）
 *
 * 返回 frames=null 表示"缺信息"，由调用方决定报什么错——绝不默认猜一个数字。
 */
export function planFrames(runtime, options = {}) {
  const fps = runtime.fps || 30;
  const den = runtime.den || 1;
  const max = runtime.maxSeconds || null;

  if (runtime.frameCount) {
    return { frames: runtime.frameCount, basis: 'declared', seconds: (runtime.frameCount * den) / fps };
  }

  if (runtime.durationPolicy === 'fit-voiceover' && typeof options.audioSeconds === 'number') {
    const usable = Math.max(0, options.audioSeconds - (options.audioOffset || 0));
    const seconds = max ? Math.min(usable, max) : usable;
    const frames = Math.max(1, Math.round((seconds * fps) / den));
    return { frames, basis: 'audio', seconds, clamped: max ? usable > max : false };
  }

  return { frames: null, basis: 'unknown', seconds: null };
}

/** 调 window.renderFrame(frame, inputs)；inputs 会被 JSON 序列化后注入。 */
export async function renderFrame(page, frame, inputs) {
  const payload = inputs && Object.keys(inputs).length ? JSON.stringify(inputs) : 'null';
  return page.evaluate('window.renderFrame(' + Number(frame) + ',' + payload + ')');
}

/** 从包内 motion.json 读出取帧所需的最小信息。 */
export function describeRuntime(motion) {
  const runtime = (motion && motion.runtime) || {};
  const output = (motion && motion.output) || {};
  const fps = (output.fps && Number(output.fps.num)) || 30;
  const den = (output.fps && Number(output.fps.den)) || 1;

  // 三种时长写法都要认：
  //   mykit-template: output.duration = {policy:'fixed', seconds}
  //   MotionGit 兼容:  output.durationSeconds + durationPolicy
  //   显式帧数:        output.frames
  const seconds =
    (output.duration && typeof output.duration.seconds === 'number' && output.duration.seconds) ||
    (typeof output.durationSeconds === 'number' && output.durationSeconds) ||
    null;
  const policy = (output.duration && output.duration.policy) || output.durationPolicy || (seconds ? 'fixed' : null);
  const frames = output.frames ?? (seconds ? Math.round((seconds * fps) / den) : null);
  return {
    profile: runtime.profile || 'html-canvas/1',
    entry: runtime.entry || 'src/index.html',
    width: output.width || 1920,
    height: output.height || 1080,
    fps,
    den,
    toSeconds: (f) => (f * den) / fps,
    frameCount: frames,
    durationPolicy: policy,
    maxSeconds: (output.duration && output.duration.maxSeconds) || null,
    preset: (motion && motion.parameters && motion.parameters.defaultPreset) || null,
  };
}
