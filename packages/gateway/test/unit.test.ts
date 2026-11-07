/** 脱敏、事件总线、审批单例消费、路径安全单测 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DatabaseSync } from 'node:sqlite';

import { redactString, redactValue } from '../src/redact.ts';
import { openDb } from '../src/db.ts';
import { EventBus } from '../src/events/bus.ts';
import { MockAdapter } from '../src/adapter/mock/mock-adapter.ts';
import { Registry, ApprovalConflictError } from '../src/state/registry.ts';
import { Gateway } from '../src/gateway.ts';
import { AuthError } from '../src/auth/store.ts';
import type { GatewayConfig } from '../src/config.ts';
import type { AdapterEvent } from '../src/adapter/types.ts';

// -- 脱敏 ---------------------------------------------------------------------

test('redactString: Bearer 头与常见密钥前缀', () => {
  assert.equal(redactString('Bearer abc123xyz'), 'Bearer [redacted]');
  assert.ok(!redactString('sk-abcdef1234567890').includes('abcdef1234567890'));
  assert.equal(redactString('普通文本'), '普通文本');
});

test('redactValue: 敏感键名递归脱敏', () => {
  const out = redactValue({
    token: 'topsecret',
    nested: { apiKey: 'key123', note: 'hello' },
    list: [{ password: 'p', ok: 1 }],
  }) as Record<string, unknown>;
  assert.equal(out.token, '[redacted]');
  const nested = out.nested as Record<string, unknown>;
  assert.equal(nested.apiKey, '[redacted]');
  assert.equal(nested.note, 'hello');
  const listItem = (out.list as Array<Record<string, unknown>>)[0]!;
  assert.equal(listItem.password, '[redacted]');
  assert.equal(listItem.ok, 1);
});

// -- 事件总线 -------------------------------------------------------------------

function mkAdapterEvent(id: string, kind: AdapterEvent['kind'], taskId = 'task-1'): AdapterEvent {
  return { nativeEventId: id, taskId, kind, occurredAt: new Date().toISOString(), payload: {} };
}

function freshBus(retention = { days: 7, max: 100 }): { bus: EventBus; db: ReturnType<typeof openDb> } {
  const db = openDb(`/tmp/zr-test-bus-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return { bus: new EventBus(db, retention), db };
}

test('EventBus: 重复 nativeEventId 去重，streamSeq 单调递增', () => {
  const { bus } = freshBus();
  const got: number[] = [];
  bus.subscribe((e) => got.push(e.streamSeq));
  const a = bus.publishFromAdapter(mkAdapterEvent('e1', 'assistant_message'));
  const dup = bus.publishFromAdapter(mkAdapterEvent('e1', 'assistant_message'));
  const b = bus.publishFromAdapter(mkAdapterEvent('e2', 'tool_started'));
  assert.ok(a && b && dup === null);
  assert.deepEqual(got, [a!.streamSeq, b!.streamSeq]);
  assert.ok(b!.streamSeq > a!.streamSeq);
});

test('EventBus: replayAfter 游标补发与 resync 判定', () => {
  const { bus } = freshBus();
  for (let i = 0; i < 5; i++) bus.publishFromAdapter(mkAdapterEvent(`e${i}`, 'assistant_message'));
  const r1 = bus.replayAfter(0);
  assert.equal(r1.continuous, true);
  assert.equal(r1.events.length, 5);
  const r2 = bus.replayAfter(3);
  assert.equal(r2.events.length, 2);
  // 超出窗口：把保留上限设为 2，触发裁剪后游标 1 已不可达
  const { bus: small } = freshBus({ days: 7, max: 2 });
  for (let i = 0; i < 6; i++) small.publishFromAdapter(mkAdapterEvent(`s${i}`, 'assistant_message'));
  const r3 = small.replayAfter(1);
  assert.equal(r3.continuous, false, '游标超出保留窗口必须要求快照重建');
});

test('EventBus: 容量上限裁剪', () => {
  const { bus } = freshBus({ days: 7, max: 10 });
  for (let i = 0; i < 25; i++) bus.publishFromAdapter(mkAdapterEvent(`p${i}`, 'assistant_message'));
  assert.equal(bus.latestSeq(), 25);
  const replay = bus.replayAfter(0);
  assert.equal(replay.events.length, 10, '只保留最近 max 条');
});

// -- 审批登记与单次消费（AT-05） ---------------------------------------------------

function freshRegistry(): { registry: Registry; mock: MockAdapter } {
  const db = openDb(`/tmp/zr-test-reg-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const mock = new MockAdapter();
  return { registry: new Registry(db, mock, 50), mock };
}

test('审批：登记→决定→再决定冲突（单次消费）', async () => {
  const { registry, mock } = freshRegistry();
  const events: AdapterEvent[] = [];
  mock.subscribe((e) => events.push(e));
  const { nativeTaskId } = await mock.createTask({
    projectId: 'ws-demo',
    title: '审批任务',
    message: '包含一个需要批准的命令',
  });
  // 重新运行一个含审批的脚本
  const res = await mock.sendMessage(nativeTaskId, '继续，但先等待批准', );
  void res;
  // mock sendMessage 无脚本时进入 waiting_input，不会产生审批；直接登记一个审批
  const approval = registry.registerApproval({
    nativeRequestId: 'apr-1',
    taskId: nativeTaskId,
    kind: 'permission',
    summary: 'rm -rf dist',
    payload: {},
    createdAt: new Date().toISOString(),
  });
  assert.equal(approval.state, 'pending');
  const resolved = registry.resolveApproval('apr-1', 'approve', 'dev-1');
  assert.equal(resolved.state, 'resolved');
  assert.throws(() => registry.resolveApproval('apr-1', 'deny', 'dev-2'), ApprovalConflictError);
});

test('审批过期后返回 expired 冲突', () => {
  const { registry } = freshRegistry();
  registry.registerApproval({
    nativeRequestId: 'apr-old',
    taskId: 't',
    kind: 'permission',
    summary: '旧审批',
    payload: {},
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // TTL 50ms 已过
  });
  assert.throws(() => registry.resolveApproval('apr-old', 'approve', 'dev-1'), (e: unknown) => {
    assert.ok(e instanceof ApprovalConflictError);
    assert.equal(e.reason, 'expired');
    return true;
  });
});

// -- Gateway 集成：状态跟随事件、版本冲突、产物路径安全 -----------------------------

function freshGateway(projectsRoot?: string): { gw: Gateway; stateDir: string } {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-gw-'));
  const config: GatewayConfig = {
    host: '127.0.0.1',
    port: 0,
    backend: 'mock',
    zcodeEntry: 'unused',
    stateDir,
    eventRetentionDays: 7,
    eventRetentionMax: 1000,
    logRetentionDays: 14,
    pairingTtlMs: 60_000,
    pairingMaxAttempts: 5,
    maxConcurrentWritesPerProject: 1,
  };
  const mock = new MockAdapter({
    projects: projectsRoot
      ? [{ nativeWorkspaceId: 'ws-art', name: 'art-proj', rootDir: projectsRoot, accessible: true }]
      : undefined,
  });
  const db = openDb(stateDir);
  return { gw: new Gateway(db, mock, config), stateDir };
}

test('Gateway: 状态跟随事件 turn_started→running / run_succeeded→succeeded', async () => {
  const { gw } = freshGateway();
  const r = await gw.createTask('c1', 'dev-1', { projectId: 'ws-demo', title: 'T', message: 'm' });
  await new Promise((r2) => setTimeout(r2, 100));
  const snap = await gw.snapshot(r.nativeTaskId);
  assert.equal(snap.task.status.status, 'succeeded');
});

test('Gateway: revision 冲突返回 ConflictError（PRD §6.2）', async () => {
  const { gw } = freshGateway();
  const r = await gw.createTask('c1', 'dev-1', { projectId: 'ws-demo', title: 'T', message: 'm' });
  await new Promise((r2) => setTimeout(r2, 50));
  const snap = await gw.snapshot(r.nativeTaskId);
  const rev = snap.task.revision;
  await assert.rejects(
    gw.appendMessage('m1', 'dev-1', r.nativeTaskId, 'msg', rev - 1),
    (e: unknown) => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /revision/i);
      return true;
    },
  );
});

test('Gateway: 产物 realpath 逃逸拒绝（AT-12）', async () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-root-'));
  const { gw } = freshGateway(rootDir);
  await gw.projects(); // 同步项目缓存，使 artifactRoot 能识别授权根目录
  // 在授权目录内注册一个产物
  const okFile = path.join(rootDir, 'report.md');
  fs.writeFileSync(okFile, '# report');
  const id = gw.registerArtifact({ taskId: 't-1', absPath: okFile });
  const read = gw.readArtifact(id);
  assert.match(read.absPath, /report\.md$/);
  // 逃逸：符号链接指向授权目录外
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'zr-out-'));
  const secret = path.join(outside, 'secret.txt');
  fs.writeFileSync(secret, 'TOP SECRET');
  const link = path.join(rootDir, 'innocent.md');
  fs.symlinkSync(secret, link);
  assert.throws(
    () => gw.registerArtifact({ taskId: 't-1', absPath: link }),
    /outside authorized roots/,
    '注册时按真实路径拒绝授权目录外的文件',
  );
  // 数据库被直接写入逃逸路径时，读取也应拒绝
  const artId = (() => {
    try {
      return gw.registerArtifact({ taskId: 't-1', absPath: link });
    } catch {
      return gw.registerArtifact({ taskId: 't-1', absPath: okFile });
    }
  })();
  // 直接篡改 DB 中的 path/root_dir 验证读取防护
  const dbPath = path.join((gw as unknown as { config: GatewayConfig }).config.stateDir, 'gateway.sqlite');
  const db = new DatabaseSync(dbPath);
  db.prepare('UPDATE artifacts SET path = ?, root_dir = ? WHERE id = ?').run(secret, rootDir, artId);
  assert.throws(() => gw.readArtifact(artId), /escape rejected/, 'realpath 逃逸必须在读取时被拒绝');
});

test('Gateway: 撤销设备断开现有订阅（PRD §9）', async () => {
  const { gw } = freshGateway();
  const { token, device } = await gw.auth.pair(gw.createPairing().code, 'victim');
  let closed = false;
  gw.registerConnection(device.id, () => {
    closed = true;
  });
  gw.revokeDevice(device.id);
  assert.equal(closed, true, '撤销后现有订阅必须断开');
  assert.throws(
    () => gw.auth.authenticate(`Bearer ${token}`),
    (e: unknown) => {
      assert.ok(e instanceof AuthError);
      assert.equal(e.code, 'device_revoked');
      return true;
    },
  );
});
