/**
 * 服务器装配（可由 index.ts CLI 或 e2e 测试程序化调用）。
 */
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { GatewayConfig } from './config.ts';
import { MockAdapter } from './adapter/mock/mock-adapter.ts';
import { RealAdapter } from './adapter/real/index.ts';
import { Gateway } from './gateway.ts';
import { buildRoutes, mapError } from './api/routes.ts';
import { matchRoute, serveStatic, type RouteDef } from './http.ts';
import { openDb } from './db.ts';
import type { IZcodeAdapter } from './adapter/types.ts';

export function createAdapter(config: GatewayConfig): IZcodeAdapter {
  if (config.backend === 'real') return new RealAdapter(config);
  return new MockAdapter();
}

export function buildGateway(config: GatewayConfig): { gateway: Gateway; adapter: IZcodeAdapter } {
  const adapter = createAdapter(config);
  const db = openDb(config.stateDir);
  const gateway = new Gateway(db, adapter, config);
  return { gateway, adapter };
}

export interface RunningServer {
  server: http.Server;
  gateway: Gateway;
  adapter: IZcodeAdapter;
  port: number;
  close: () => Promise<void>;
}

export function startServer(config: GatewayConfig, opts?: { webDir?: string; adapter?: IZcodeAdapter }): Promise<RunningServer> {
  const { gateway, adapter } = opts?.adapter
    ? { gateway: new Gateway(openDb(config.stateDir), opts.adapter, config), adapter: opts.adapter }
    : buildGateway(config);
  const routes: RouteDef[] = buildRoutes(gateway);
  const staticDir = opts?.webDir ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web-client');

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    try {
      if (url.pathname.startsWith('/v1/')) {
        const hit = matchRoute(routes, req.method ?? 'GET', url.pathname);
        if (!hit) {
          res
            .writeHead(404, { 'content-type': 'application/json' })
            .end(JSON.stringify({ code: 'not_found', message: '未知端点' }));
          return;
        }
        await hit.handler({ params: hit.params, query: url.searchParams, raw: { req, res } });
        return;
      }
      if (req.method === 'GET') {
        serveStatic(staticDir, url.pathname, res);
        return;
      }
      res.writeHead(405).end();
    } catch (e) {
      const mapped = mapError(e);
      if (!res.headersSent) {
        res.writeHead(mapped.status, { 'content-type': 'application/json; charset=utf-8' });
      }
      try {
        res.end(JSON.stringify({ code: mapped.code, message: mapped.message }));
      } catch {
        /* 连接已断开 */
      }
    }
  });

  return new Promise((resolve) => {
    server.listen(config.port, config.host, () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : config.port;
      resolve({
        server,
        gateway,
        adapter,
        port,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res());
            void gateway.adapter.shutdown?.();
          }),
      });
    });
  });
}
