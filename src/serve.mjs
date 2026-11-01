/**
 * 本地静态服务：MIME 表 + 路径穿越防护。
 *
 * 防护规则参考 891 的 relative() 四条禁令（禁反斜杠 / 禁冒号 / 禁前导斜杠 / 禁 . 与 ..），
 * 另外补一层 realpath 复核，挡住软链逃逸。代码为全新实现。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export class PathError extends Error {}

/**
 * 把 URL 相对路径解析成 root 内的绝对路径，越界一律抛 PathError。
 * @param {string} root 已 resolve + realpath 的根目录
 */
export function safeResolve(root, relative) {
  if (typeof relative !== 'string' || relative.length === 0) throw new PathError('空路径');
  if (relative.includes('\\')) throw new PathError('路径不允许反斜杠');
  if (relative.includes(':')) throw new PathError('路径不允许冒号');
  if (relative.startsWith('/')) throw new PathError('路径不允许前导斜杠');
  const segments = relative.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) {
    throw new PathError('路径不允许空段 / . / ..');
  }

  const absolute = path.resolve(root, relative);
  if (absolute !== root && !absolute.startsWith(root + path.sep)) throw new PathError('路径越界');

  // 软链复核：找到存在的最深祖先后 realpath，必须仍在 root 内
  let probe = absolute;
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    probe = parent;
  }
  const realProbe = fs.realpathSync(probe);
  if (realProbe !== root && !realProbe.startsWith(root + path.sep)) throw new PathError('软链越界');

  return absolute;
}

/**
 * 起一个只监听 127.0.0.1 的静态服务。
 * @returns {Promise<{ port:number, origin:string, close:()=>Promise<void> }>}
 */
export async function serve(rootDir, options = {}) {
  const root = fs.realpathSync(path.resolve(rootDir));
  const server = http.createServer((req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      let relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (relative === '' || relative.endsWith('/')) relative += 'index.html';

      const file = safeResolve(root, relative);
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new PathError('不是文件');

      res.writeHead(200, {
        'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': 'no-store',
      });
      fs.createReadStream(file).pipe(res);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('404');
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });

  const port = server.address().port;
  return {
    port,
    origin: 'http://127.0.0.1:' + port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
