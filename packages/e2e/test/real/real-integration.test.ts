/**
 * Real 后端集成测试（P0 实验第 5 条的 WSL 版，对应 PRD AT-01/AT-02/AT-08/AT-09）。
 *
 * 前提：本机存在 ZCode CLI（ZREMOTE_ZCODE_ENTRY）。真实模型调用仅 2 次超短 prompt。
 * 无 ZCode 环境时自动跳过（CI / 其他机器可跑 mock 套件）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { accessSync, constants } from 'node:fs';

import { startServer, type RunningServer } from '../../../gateway/src/server.ts';
import { loadConfig, type GatewayConfig } from '../../../gateway/src/config.ts';

const ZCODE_ENTRY =
  process.env.ZREMOTE_ZCODE_ENTRY ??
  path.join(os.homedir(), '.zcode', 'server', 'releases', '3.17.2-linux-x64-88a41b337faa', 'runtime', 'zcode.cjs');

let entryOk = false;
try {
  accessSync(ZCODE_ENTRY, constants.X_OK);
  entryOk = true;
} catch {
  entryOk = false;
}

const sandbox = path.join(os.tmpdir(), 'zremote-real-sandbox');
let running: RunningServer;
let token = '';
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-real-'));

function realConfig(): GatewayConfig {
  const cfg = loadConfig();
  return { ...cfg, backend: 'real', stateDir, port: 0, host: '127.0.0.1', zcodeEntry: ZCODE_ENTRY };
}

const get = async (p: string): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${running.port}${p}`, { headers: { authorization: `Bearer ${token}` } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const post = async (p: string, body: unknown): Promise<{ status: number; body: any }> => {
  const res = await fetch(`http://127.0.0.1:${running.port}${p}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 等待任务进入期望状态（快照轮询） */
async function waitStatus(nativeTaskId: string, want: string[], timeoutMs = 60000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const snap = await get(`/v1/tasks/${nativeTaskId}`);
    last = snap.body?.task?.status?.status ?? '';
    if (want.includes(last)) return last;
    await sleep(500);
  }
  return last;
}

/** 等待助手回复包含指定文本（引擎异步持久化，必须轮询消息而非只看状态） */
async function waitReply(nativeTaskId: string, include: string, timeoutMs = 90000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let content = '';
  while (Date.now() < deadline) {
    const msgs = await get(`/v1/tasks/${nativeTaskId}/messages`);
    const list: Array<{ role: string; content: string }> = msgs.body?.messages ?? [];
    content = list.filter((m) => m.role === 'assistant').map((m) => m.content).join('\n');
    if (content.replace(/\s/g, '').includes(include)) return content;
    await sleep(800);
  }
  return content;
}

before(async () => {
  if (!entryOk) return;
  fs.mkdirSync(sandbox, { recursive: true });
  running = await startServer(realConfig());
  const { code } = running.gateway.createPairing();
  const res = await fetch(`http://127.0.0.1:${running.port}/v1/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, deviceName: 'real-test' }),
  });
  token = ((await res.json()) as { token: string }).token;
});

after(async () => {
  if (running) await running.close();
});

// ---------------------------------------------------------------------------
test('R-01 健康检查与能力自检（real）', { skip: !entryOk ? '无 ZCode 入口' : false }, async () => {
  const h = await get('/v1/health');
  void h;
  const caps = await get('/v1/capabilities');
  assert.equal(caps.body.backendId, 'real-appserver');
  assert.equal(caps.body.compatible, true);
  assert.equal(caps.body.supportsSessionResume, true);
  const health = await running.gateway.health();
  assert.equal(health.ok, true, health.detail);
});

test('R-02 沙箱项目可见（real）', { skip: !entryOk ? '无 ZCode 入口' : false }, async () => {
  const projects = await get('/v1/projects');
  const found = projects.body.projects.find((p: any) => p.nativeWorkspaceId === sandbox || p.rootDir === sandbox);
  assert.ok(found, `项目列表应含沙箱 ${sandbox}，实际 ${JSON.stringify(projects.body.projects).slice(0, 300)}`);
});

// ---------------------------------------------------------------------------
// AT-01 WSL 版：网关建任务 → 同一原生会话
// ---------------------------------------------------------------------------
let nativeTaskId = '';
test('R-03 建任务 + 首轮执行（真实短 prompt）', { skip: !entryOk ? '无 ZCode 入口' : false }, async () => {
  const create = await post('/v1/projects/' + encodeURIComponent(sandbox) + '/tasks', {
    clientCommandId: 'real-1',
    title: 'zremote 集成测试',
    message: '请只回复两个字：收到',
  });
  assert.equal(create.status, 202, JSON.stringify(create.body));
  nativeTaskId = create.body.nativeTaskId;
  assert.match(nativeTaskId, /^sess_/);

  // 引擎异步执行：轮询助手回复（超时 90s）
  const reply = await waitReply(nativeTaskId, '收到', 90000);
  assert.match(reply.replace(/\s/g, ''), /收到/, `助手回复应为“收到”，实际: ${reply.slice(0, 80)}`);

  const final = await waitStatus(nativeTaskId, ['waiting_input'], 20000);
  assert.equal(final, 'waiting_input', `首轮后应空闲可续，实际 ${final}`);
});

// ---------------------------------------------------------------------------
// AT-02 WSL 版核心：同一原生会话双向续聊
// 网关追加 → 快照含两条 assistant/追加内容；再由独立 CLI 进程 --resume 续聊 → 网关可见
// ---------------------------------------------------------------------------
test('R-04 网关追加进入同一会话（AT-02 上半）', { skip: !entryOk ? '无 ZCode 入口' : false }, async () => {
  const append = await post(`/v1/tasks/${nativeTaskId}/messages`, {
    clientCommandId: 'real-2',
    message: '再回复两个字：继续',
  });
  assert.equal(append.status, 202, JSON.stringify(append.body));
  const content = await waitReply(nativeTaskId, '继续', 90000);
  assert.ok(content.includes('继续'), '同一会话应包含第二轮回复');
});

test('R-05 独立 CLI 进程 --resume 同会话续聊（AT-02 下半：跨进程同会话）', { skip: !entryOk ? '无 ZCode 入口' : false }, async () => {
  const { spawnSync } = await import('node:child_process');
  const before = await get(`/v1/tasks/${nativeTaskId}/messages`);
  const beforeCount = before.body.messages.length;

  // 独立进程 resume：模拟“回到 Mac 桌面继续”（桌面即另一进程）
  const r = spawnSync(process.execPath, [ZCODE_ENTRY, '-p', '现在回复两个字：明白', '--resume', nativeTaskId, '--cwd', sandbox, '--mode', 'build'], {
    cwd: sandbox,
    timeout: 120000,
    encoding: 'utf8',
  });
  assert.equal(r.status, 0, `CLI resume 失败: ${String(r.stderr).slice(0, 300)}`);

  // 网关（另一进程）能看到 CLI 进程写入的同一会话消息
  const after = await get(`/v1/tasks/${nativeTaskId}/messages`);
  assert.ok(after.body.messages.length > beforeCount, 'CLI 续聊后消息数应增长（同一会话）');
  const content = after.body.messages.map((m: any) => m.content).join('\n');
  assert.ok(content.includes('明白'), `CLI 轮回复应可见，实际: ${content.slice(-120)}`);
});

// ---------------------------------------------------------------------------
// AT-08 real 版：网关重启后账本幂等 + 任务清单从原生恢复
// ---------------------------------------------------------------------------
test('R-06 网关重启：任务从原生恢复、账本幂等保持', { skip: !entryOk ? '无 ZCode 入口' : false }, async () => {
  await running.close();
  running = await startServer(realConfig());
  // 设备 token 仍在（持久化）
  const list = await get('/v1/projects');
  assert.equal(list.status, 200);
  const tasks = await get('/v1/projects/' + encodeURIComponent(sandbox) + '/tasks');
  assert.ok(tasks.body.tasks.some((t: any) => t.nativeTaskId === nativeTaskId), '重启后任务清单应从原生恢复');
  // 幂等：重启后同 clientCommandId 重试 → 返回原状态
  const retry = await post('/v1/projects/' + encodeURIComponent(sandbox) + '/tasks', {
    clientCommandId: 'real-1',
    title: 'zremote 集成测试',
    message: '请只回复两个字：收到',
  });
  assert.equal(retry.status, 202);
  assert.equal(retry.body.nativeTaskId, nativeTaskId, '重启后重试同 ID 不得新建会话');
});

// ---------------------------------------------------------------------------
// AT-09 real 版：停止
// ---------------------------------------------------------------------------
test('R-07 停止运行中任务（受理 + 终态）', { skip: !entryOk ? '无 ZCode 入口' : false }, async () => {
  // 发起一个会长一点的任务，然后立刻取消
  const create = await post('/v1/projects/' + encodeURIComponent(sandbox) + '/tasks', {
    clientCommandId: `real-cancel-${Date.now()}`,
    title: '取消测试',
    message: '请从 1 数到 100000，每个数字单独一行输出。',
  });
  assert.equal(create.status, 202);
  const id = create.body.nativeTaskId;
  await sleep(1500); // 让任务开始跑
  const cancel = await post(`/v1/tasks/${id}/cancel`, { clientCommandId: `real-cancel-req-${Date.now()}` });
  assert.equal(cancel.status, 202, JSON.stringify(cancel.body));
  // 引擎确认后进入终止态
  const final = await waitStatus(id, ['waiting_input', 'cancelled', 'succeeded', 'failed', 'unknown'], 30000);
  assert.ok(['waiting_input', 'cancelled'].includes(final), `取消后应到终态/waiting_input，实际 ${final}`);
});
