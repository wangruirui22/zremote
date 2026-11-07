/**
 * app-server 协议探测（P0 实验第 4 条的 WSL 版）：
 * 生成 app-server、做 JSON-RPC 握手、逐个试探方法是否存在（-32601 = method not found）。
 * 只调用无副作用方法（initialize / session/list / workspace/*），不发起模型请求。
 *
 *   node src/adapter/real/probe.ts
 */
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ENTRY =
  process.env.ZREMOTE_ZCODE_ENTRY ??
  path.join(os.homedir(), '.zcode', 'server', 'releases', '3.17.2-linux-x64-88a41b337faa', 'runtime', 'zcode.cjs');

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

class AppServerProbe {
  private child: ChildProcess;
  private pending = new Map<number, Pending>();
  private buffer = '';
  private nextId = 1;
  readonly notifications: unknown[] = [];

  constructor() {
    this.child = spawn(process.execPath, [ENTRY, 'app-server', '--surface', 'terminal'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ZCODE_PROTOCOL_STDIO: '1' },
    });
    this.child.stdout!.on('data', (d: Buffer) => this.onData(d.toString()));
    this.child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) console.error('[stderr]', s.slice(0, 300));
    });
    this.child.on('exit', (code, sig) => console.error(`[exit] code=${code} sig=${sig}`));
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    // NDJSON 或 LSP 风格头都试探：先按行 JSON 解析
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      if (line.startsWith('{')) {
        try {
          this.onMessage(JSON.parse(line));
          continue;
        } catch {
          console.error('[non-json line]', line.slice(0, 200));
        }
      } else {
        console.error('[raw line]', line.slice(0, 200));
      }
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    const id = msg.id as number | string | undefined;
    // 服务端 → 客户端请求（string id 如 "server-1"）：礼貌性应答空结果，避免 create 挂起
    if (typeof id === 'string' && typeof msg.method === 'string') {
      console.log(`[server-req] ${msg.method} ${JSON.stringify(msg.params ?? {}).slice(0, 200)}`);
      const result =
        msg.method === 'session/requestRuntimePreferences'
          ? { nativeSearchEnhancementsEnabled: false }
          : {};
      this.child.stdin!.write(JSON.stringify({ id, result }) + '\n');
      return;
    }
    // 生命周期通知携带激活中的 sessionId
    if (msg.method === 'session/lifecycle/changed') {
      const p = msg.params as { sessionId?: string; state?: string } | undefined;
      if (p?.sessionId && p.state === 'starting' && !this.activeSessionId) this.activeSessionId = p.sessionId;
    }
    if (id !== undefined && this.pending.has(id as number)) {
      const p = this.pending.get(id as number)!;
      this.pending.delete(id as number);
      p.resolve(msg);
    } else {
      this.notifications.push(msg);
      const m = msg.method as string;
      if (m === 'session/event' || m === 'state.updated' || m === 'session/lifecycle/changed') {
        // 事件目录捕获：完整落盘（/tmp/zr-probe-events.jsonl）
        try {
          fs.appendFileSync('/tmp/zr-probe-events.jsonl', JSON.stringify(msg) + '\n');
        } catch {
          /* 忽略落盘失败 */
        }
      }
      console.log('[notify]', JSON.stringify(msg).slice(0, 240));
    }
  }

  activeSessionId = '';

  request(method: string, params?: unknown, timeoutMs = 5000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    // 线上格式：{id, method, params}（实测服务端拒绝 "jsonrpc" 键）
    const frame = JSON.stringify({ id, method, params: params ?? {} }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as Record<string, unknown>);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.child.stdin!.write(frame);
    });
  }

  kill(): void {
    this.child.kill('SIGTERM');
  }
}

async function main(): Promise<void> {
  const probe = new AppServerProbe();
  await new Promise((r) => setTimeout(r, 1500)); // 等启动横幅/通知

  console.log('\n=== initialize ===');
  for (const params of [
    { clientInfo: { name: 'zremote-probe', version: '0.0.1' } },
    {},
  ]) {
    try {
      const res = await probe.request('initialize', params);
      console.log('[initialize OK]', JSON.stringify(res).slice(0, 800));
      break;
    } catch (e) {
      console.log('[initialize fail]', (e as Error).message);
    }
  }

  console.log('\n=== method probing ===');
  const candidates: Array<[string, unknown]> = [
    ['session/list', {}],
  ];
  let latestSessionId = '';
  for (const [method, params] of candidates) {
    try {
      const res = await probe.request(method, params, 4000);
      const s = JSON.stringify(res);
      console.log(`[${method}] ${res.error ? 'ERR ' + JSON.stringify(res.error).slice(0, 200) : 'OK ' + s.slice(0, 400)}`);
      const result = res.result as { sessions?: Array<{ sessionId: string; updatedAt: number }> } | undefined;
      if (result?.sessions?.length) {
        const sorted = [...result.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
        latestSessionId = sorted[0]!.sessionId;
      }
    } catch (e) {
      console.log(`[${method}] ${(e as Error).message}`);
    }
  }

  console.log(`\n=== read-only session probes (latest=${latestSessionId}) ===`);
  const readProbes: Array<[string, unknown]> = [
    ['session/read', { sessionId: latestSessionId }],
    ['session/messages', { sessionId: latestSessionId }],
    ['session/messages', { sessionId: latestSessionId, limit: 5 }],
    ['session/events', { sessionId: latestSessionId }],
    ['session/subagents', { sessionId: latestSessionId }],
    ['session/usage', { sessionId: latestSessionId }],
  ];
  for (const [method, params] of readProbes) {
    try {
      const res = await probe.request(method, params, 4000);
      const s = JSON.stringify(res);
      console.log(`[${method}] ${res.error ? 'ERR ' + JSON.stringify(res.error).slice(0, 300) : 'OK ' + s.slice(0, 400)}`);
    } catch (e) {
      console.log(`[${method}] ${(e as Error).message}`);
    }
  }

  console.log('\n=== session/create shape (sandbox cwd, no model call) ===');
  const sandbox = path.join(os.tmpdir(), 'zremote-sandbox-probe');
  fs.mkdirSync(sandbox, { recursive: true });
  let createdSessionId = '';
  for (const params of [
    { workspace: { workspaceKey: sandbox, workspacePath: sandbox } },
  ]) {
    try {
      const res = await probe.request('session/create', params, 15000);
      console.log('[session/create]', JSON.stringify(res).slice(0, 700));
      const result = res.result as { sessionId?: string; projection?: { sessionId?: string } } | undefined;
      createdSessionId =
        result?.sessionId ?? probe.activeSessionId ?? result?.projection?.sessionId ?? '';
      break;
    } catch (e) {
      console.log('[session/create fail]', (e as Error).message);
    }
  }

  if (createdSessionId) {
    console.log(`\n=== schema discovery on created session (${createdSessionId}) ===`);
    // 真实调用（空会话无模型交互）+ Zod 报错法
    for (const [method, params] of [
      ['session/read', { sessionId: createdSessionId }],
      ['session/messages', { sessionId: createdSessionId }],
      ['session/events', { sessionId: createdSessionId }],
      ['session/subscribe', { sessionId: createdSessionId, deliveryKind: 'web-remote-replayable' }],
      ['session/send', { sessionId: createdSessionId, message: 12345 }],
      ['session/resume', { sessionId: createdSessionId }],
    ] as Array<[string, unknown]>) {
      try {
        const res = await probe.request(method, params, 4000);
        if (res.error) {
          const err = res.error as { code?: number; message?: string; data?: { message?: string } };
          const zod = (err.data?.message ?? err.message ?? '').replace(/\s+/g, ' ');
          console.log(`[${method}] ERR ${err.code} ${zod.slice(0, 900)}`);
        } else {
          console.log(`[${method}] OK ${JSON.stringify(res).slice(0, 300)}`);
        }
      } catch (e) {
        console.log(`[${method}] ${(e as Error).message}`);
      }
    }
  }

  probe.kill();
  await new Promise((r) => setTimeout(r, 300));
}

/**
 * --send 模式：真实一轮超短对话，完整录制事件通知流（唯一消耗额度的探测）。
 *   node src/adapter/real/probe.ts --send
 */
async function sendProbe(): Promise<void> {
  const sandbox = path.join(os.tmpdir(), 'zremote-sandbox-send');
  fs.mkdirSync(sandbox, { recursive: true });
  const probe = new AppServerProbe();
  await new Promise((r) => setTimeout(r, 1200));

  const createRes = await probe.request(
    'session/create',
    { workspace: { workspaceKey: sandbox, workspacePath: sandbox } },
    15000,
  );
  if (createRes.error) throw new Error(`create failed: ${JSON.stringify(createRes.error)}`);
  const sessionId = probe.activeSessionId;
  console.log(`[send-probe] session=${sessionId}`);

  const subRes = await probe.request(
    'session/subscribe',
    { sessionId, deliveryKind: 'web-remote-replayable' },
    5000,
  );
  console.log('[subscribe]', JSON.stringify(subRes).slice(0, 200));

  const sendRes = await probe.request('session/send', { sessionId, content: '请只回复一个字：好' }, 8000);
  console.log('[send ack]', JSON.stringify(sendRes).slice(0, 300));

  // 录制事件流 25 秒
  await new Promise((r) => setTimeout(r, 25000));

  const readRes = await probe.request('session/read', { sessionId }, 5000);
  console.log('[read after turn]', JSON.stringify(readRes).slice(0, 1200));
  const msgRes = await probe.request('session/messages', { sessionId }, 5000);
  console.log('[messages after turn]', JSON.stringify(msgRes).slice(0, 1500));

  probe.kill();
  await new Promise((r) => setTimeout(r, 300));
}

if (process.argv.includes('--send')) {
  void sendProbe().catch((e) => {
    console.error('send probe failed:', e);
    process.exit(1);
  });
} else {
  void main().catch((e) => {
    console.error('probe failed:', e);
    process.exit(1);
  });
}

void main().catch((e) => {
  console.error('probe failed:', e);
  process.exit(1);
});
