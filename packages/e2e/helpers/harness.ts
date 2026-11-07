/**
 * e2e 夹具：程序化启动网关（默认 mock 后端）+ 极简 HTTP/SSE 客户端。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, type RunningServer } from '../../gateway/src/server.ts';
import { loadConfig, type GatewayConfig } from '../../gateway/src/config.ts';
import { MockAdapter, type MockAdapterOptions } from '../../gateway/src/adapter/mock/mock-adapter.ts';

export interface Harness {
  running: RunningServer;
  mock: MockAdapter;
  baseUrl: string;
  pair: (name?: string) => Promise<string>;
  get: (p: string, token?: string) => Promise<{ status: number; body: any }>;
  post: (p: string, body?: unknown, token?: string) => Promise<{ status: number; body: any }>;
  openSse: (after: number, token: string, onEvent: (raw: string) => void) => Promise<() => Promise<void>>;
  stateDir: string;
  shutdown: () => Promise<void>;
}

export function tempStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'zr-e2e-'));
}

export function mockConfig(stateDir: string): GatewayConfig {
  const cfg = loadConfig();
  return { ...cfg, backend: 'mock', stateDir, port: 0, host: '127.0.0.1' };
}

export async function bootHarness(mockOpts: MockAdapterOptions = {}): Promise<Harness> {
  const stateDir = tempStateDir();
  const mock = new MockAdapter(mockOpts);
  const running = await startServer(mockConfig(stateDir), { adapter: mock });
  const baseUrl = `http://127.0.0.1:${running.port}`;

  const pair = async (name = 'e2e-device'): Promise<string> => {
    const { code } = running.gateway.createPairing();
    const res = await fetch(`${baseUrl}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: name }),
    });
    const body = (await res.json()) as { token: string };
    return body.token;
  };

  const get = async (p: string, token?: string) => {
    const res = await fetch(`${baseUrl}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const post = async (p: string, body?: unknown, token?: string) => {
    const res = await fetch(`${baseUrl}${p}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body ?? {}),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };

  const openSse = (after: number, token: string, onEvent: (raw: string) => void) =>
    new Promise<() => Promise<void>>((resolve, reject) => {
      const ctrl = new AbortController();
      fetch(`${baseUrl}/v1/events?after=${after}&token=${token}`, { signal: ctrl.signal }).then(async (res) => {
        if (!res.body) {
          reject(new Error('no sse body'));
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        void (async () => {
          try {
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              buf += decoder.decode(value, { stream: true });
              let idx: number;
              while ((idx = buf.indexOf('\n\n')) >= 0) {
                const frame = buf.slice(0, idx);
                buf = buf.slice(idx + 2);
                if (frame.includes('event: gateway')) {
                  const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
                  if (dataLine) onEvent(dataLine.slice(6));
                }
              }
            }
          } catch {
            /* 客户端主动断开（abort）属正常退出 */
          }
        })();
        resolve(async () => {
          ctrl.abort();
        });
      }, reject);
    });

  return { running, mock, baseUrl, pair, get, post, openSse, stateDir, shutdown: () => running.close() };
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
