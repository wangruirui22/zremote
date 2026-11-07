/**
 * HTTP 基座：路由、静态文件、SSE 工具。仅绑定 loopback（PRD §9）。
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

export interface RawConn {
  req: http.IncomingMessage;
  res: http.ServerResponse;
}

export interface RequestContext {
  params: Record<string, string>;
  query: URLSearchParams;
  raw: RawConn;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

export interface RouteDef {
  method: string;
  /** /v1/tasks/:id/messages 形式 */
  pattern: string;
  handler: Handler;
}

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function matchRoute(
  routes: RouteDef[],
  method: string,
  pathname: string,
): { handler: Handler; params: Record<string, string> } | null {
  for (const r of routes) {
    if (r.method !== method) continue;
    const pp = r.pattern.split('/').filter(Boolean);
    const sp = pathname.split('/').filter(Boolean);
    if (pp.length !== sp.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < pp.length; i++) {
      const seg = pp[i]!;
      if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(sp[i]!);
      else if (seg !== sp[i]) {
        ok = false;
        break;
      }
    }
    if (ok) return { handler: r.handler, params };
  }
  return null;
}

export async function readJsonBody(raw: RawConn): Promise<Record<string, unknown>> {
  const text = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    raw.req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > 2 * 1024 * 1024) {
        reject(new HttpError(413, 'payload_too_large', '请求体过大'));
        raw.req.destroy();
        return;
      }
      chunks.push(c);
    });
    raw.req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    raw.req.on('error', reject);
  });
  if (!text.trim()) return {};
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not object');
    return v as Record<string, unknown>;
  } catch (e) {
    if (e instanceof HttpError) throw e;
    throw new HttpError(400, 'invalid_json', '请求体不是有效 JSON 对象');
  }
}

/** 静态文件服务（web 客户端），路径规范化防穿越 */
export function serveStatic(rootDir: string, urlPath: string, res: http.ServerResponse): boolean {
  let realRoot: string;
  try {
    realRoot = fs.realpathSync(rootDir);
  } catch {
    res.writeHead(404).end('not found'); // 静态根目录不存在（如未部署 web 客户端）
    return true;
  }
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.normalize(path.join(realRoot, rel));
  let real = abs;
  try {
    real = fs.realpathSync(abs);
  } catch {
    res.writeHead(404).end('not found');
    return true;
  }
  if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
    res.writeHead(403).end('forbidden');
    return true;
  }
  const st = fs.statSync(real, { throwIfNoEntry: false });
  if (!st || !st.isFile()) {
    // SPA fallback
    const index = path.join(realRoot, 'index.html');
    if (fs.existsSync(index)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(fs.readFileSync(index));
      return true;
    }
    res.writeHead(404).end('not found');
    return true;
  }
  const mime =
    {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
    }[path.extname(real).toLowerCase()] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': mime, 'cache-control': 'no-store' });
  res.end(fs.readFileSync(real));
  return true;
}
