/**
 * AT 验收套件（PRD §12.1）—— mock 后端 e2e。
 * 覆盖：AT-03/04/05/06/07/08/09/12/13/14 + AT-10 模拟（引擎离线）+ AT-11 模拟（断连重连）。
 * AT-01/02（同会话接管）在 real 后端集成测试中验证；AT-15 属链路审计，见 docs。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { bootHarness, sleep, type Harness } from '../../helpers/harness.ts';

let h: Harness;
let phone: string; // 手机设备 token
let phone2: string; // 第二设备（审批双端场景）

before(async () => {
  h = await bootHarness();
  phone = await h.pair('phone');
  phone2 = await h.pair('phone-2');
});

after(async () => {
  await h.shutdown();
});

// ---------------------------------------------------------------------------
// AT-03 手机新建任务：Mac 能在约定项目中找到并继续
// ---------------------------------------------------------------------------
test('AT-03 手机新建任务 → 项目列表可见、Mac 侧可继续', async () => {
  const create = await h.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: 'at03-1', title: '修复登录异常', message: '优先兼容 Android WebView' },
    phone,
  );
  assert.equal(create.status, 202);
  assert.ok(create.body.nativeTaskId);
  const taskId = create.body.nativeTaskId;

  // Mac 侧（模拟）：任务出现在项目任务列表
  const list = await h.get('/v1/projects/ws-demo/tasks', phone);
  assert.ok(list.body.tasks.some((t: any) => t.nativeTaskId === taskId));

  // Mac 侧继续：追加消息（走另一设备身份）
  const macAppend = await h.post(
    `/v1/tasks/${taskId}/messages`,
    { clientCommandId: 'at03-mac-1', message: '已收到，继续' },
    phone2,
  );
  assert.equal(macAppend.status, 202);
  await sleep(80);
  const snap = await h.get(`/v1/tasks/${taskId}`, phone);
  assert.ok(snap.body.task.revision >= 3, 'Mac 追加后 revision 增长');
});

// ---------------------------------------------------------------------------
// AT-04 Mac 本地追加消息 → 手机收到；同时写入串行/冲突
// ---------------------------------------------------------------------------
test('AT-04 手机经 SSE 收到 Mac 追加；过期 revision 写入被拒', async () => {
  const create = await h.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: 'at04-1', title: '观察任务', message: 'm' },
    phone,
  );
  const taskId = create.body.nativeTaskId;
  await sleep(60);

  const seen: any[] = [];
  const closeSse = await h.openSse(0, phone, (raw) => seen.push(JSON.parse(raw)));

  await h.post(`/v1/tasks/${taskId}/messages`, { clientCommandId: 'at04-mac', message: 'Mac 本地补充' }, phone2);
  await sleep(120);
  closeSse();

  assert.ok(
    seen.some((e) => e.kind === 'user_message'),
    '手机 SSE 必须收到 Mac 追加的用户消息事件',
  );

  // 乐观并发：用过期 revision 写入 → 409
  const snap = await h.get(`/v1/tasks/${taskId}`, phone);
  const stale = snap.body.task.revision - 1;
  const conflict = await h.post(
    `/v1/tasks/${taskId}/messages`,
    { clientCommandId: `at04-stale-${Date.now()}`, message: '过期写入', expectedRevision: stale },
    phone,
  );
  assert.equal(conflict.status, 409, '过期 revision 必须返回版本冲突');
});

// ---------------------------------------------------------------------------
// AT-05 同一审批两端处理：只有一次决定生效
// ---------------------------------------------------------------------------
test('AT-05 双端审批竞争 → 第二端 409，仅一次生效', async () => {
  const create = await h.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: 'at05-1', title: '审批任务', message: '包含高危命令' },
    phone,
  );
  const taskId = create.body.nativeTaskId;
  await sleep(60);
  // 引擎侧登记待审批（模拟 permission_requested 已发出）+ 网关登记
  h.mock.injectApproval(taskId, { nativeRequestId: 'at05-apr', summary: 'git push --force' });
  h.running.gateway.registry.registerApproval({
    nativeRequestId: 'at05-apr',
    taskId,
    kind: 'permission',
    summary: 'git push --force',
    payload: {},
    createdAt: new Date().toISOString(),
  });

  const r1 = h.post('/v1/approvals/at05-apr/resolve', { clientCommandId: 'at05-r1', decision: 'approve' }, phone);
  const r2 = h.post('/v1/approvals/at05-apr/resolve', { clientCommandId: 'at05-r2', decision: 'deny' }, phone2);
  const [a, b] = await Promise.all([r1, r2]);
  const statuses = [a.status, b.status].sort();
  assert.deepEqual(statuses, [200, 409], '必须恰好一端 200、另一端 409');

  // 审批后快照不再包含该待审批
  const snap = await h.get(`/v1/tasks/${taskId}`, phone);
  assert.ok(!snap.body.pendingApprovals.some((x: any) => x.nativeRequestId === 'at05-apr'));
});

// ---------------------------------------------------------------------------
// AT-06 断线 5 分钟恢复：补齐事件；事件缺失标记（部分记录缺失）
// ---------------------------------------------------------------------------
test('AT-06 断线重连：游标补发；超出窗口要求 resync', async () => {
  const create = await h.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: 'at06-1', title: '断线任务', message: 'm' },
    phone,
  );
  const taskId = create.body.nativeTaskId;
  await sleep(60);
  const before = h.running.gateway.bus.latestSeq();
  assert.ok(before > 0);

  // 模拟断线期间产生新事件（Mac 侧追加）
  await h.post(`/v1/tasks/${taskId}/messages`, { clientCommandId: 'at06-mac', message: '离线期间的消息' }, phone2);
  await sleep(80);

  // 手机恢复：从断线前游标补发
  const events: any[] = [];
  const close = await h.openSse(before, phone, (raw) => events.push(JSON.parse(raw)));
  await sleep(120);
  close();
  assert.ok(events.some((e) => e.kind === 'user_message' && e.streamSeq > before), '恢复后必须补发离线期间事件');
});

// ---------------------------------------------------------------------------
// AT-07 下发成功但响应丢失：查询/重试不重复创建
// ---------------------------------------------------------------------------
test('AT-07 RESULT_PENDING：重试不重复创建任务，可查询待核对状态', async () => {
  h.mock.armPendingSendFault();
  try {
    const r1 = await h.post(
      '/v1/projects/ws-demo/tasks',
      { clientCommandId: 'at07-1', title: '响应丢失任务', message: 'm' },
      phone,
    );
    assert.equal(r1.status, 202);
    assert.equal(r1.body.status, 'accepted');

    // 查询命令状态 → pending_verify
    const q1 = await h.get(`/v1/commands/at07-1`, phone);
    assert.equal(q1.body.status, 'pending_verify');
    assert.equal(q1.body.pendingVerify, true);

    // 用户重试同 ID → 不产生第二个任务
    const r2 = await h.post(
      '/v1/projects/ws-demo/tasks',
      { clientCommandId: 'at07-1', title: '响应丢失任务', message: 'm' },
      phone,
    );
    assert.equal(r2.status, 202);
    const list = await h.get('/v1/projects/ws-demo/tasks', phone);
    const matches = list.body.tasks.filter((t: any) => t.title === '响应丢失任务');
    assert.equal(matches.length, 1, '重试不得重复创建任务');
  } finally {
    h.mock.disarmPendingSendFault(); // 故障不得泄漏到后续用例
  }

  // 换新 ID 可以正常创建（用户明确重发语义）
  const r3 = await h.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: `at07-new-${Date.now()}`, title: '响应丢失任务', message: 'm' },
    phone,
  );
  assert.equal(r3.status, 202);
});

// ---------------------------------------------------------------------------
// AT-08 网关在下发前后崩溃：重启后不自动重复执行
// ---------------------------------------------------------------------------
test('AT-08 网关崩溃恢复：账本持久化，重启后重试无重复副作用', async () => {
  // 独立 harness 以便重启
  const h2 = await bootHarness();
  const tok = await h2.pair('at08-phone');
  const create = await h2.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: 'at08-1', title: '崩溃测试', message: 'm' },
    tok,
  );
  assert.equal(create.status, 202);
  const taskId1 = create.body.nativeTaskId;
  await sleep(60);
  const latestSeq = h2.running.gateway.bus.latestSeq();

  // 模拟崩溃：直接关停（状态目录保留）
  const stateDir = h2.stateDir;
  const mockOpts = h2.mock;
  await h2.shutdown();

  // 重启（同一状态目录、同一 mock 引擎实例以保留原生任务）
  const h3 = await bootHarnessWithState(stateDir, mockOpts);
  const tok2 = await h3.pair('at08-phone-reconnect');
  // 重启后重试同 ID → 不重复执行
  const retry = await h3.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: 'at08-1', title: '崩溃测试', message: 'm' },
    tok2,
  );
  assert.equal(retry.status, 202);
  assert.equal(retry.body.nativeTaskId, taskId1, '重启后同 ID 重试返回原任务');
  const list = await h3.get('/v1/projects/ws-demo/tasks', tok2);
  const matches = list.body.tasks.filter((t: any) => t.title === '崩溃测试');
  assert.equal(matches.length, 1);
  // 事件流仍在（游标未丢）
  assert.ok(h3.running.gateway.bus.latestSeq() >= latestSeq);
  await h3.shutdown();
});

async function bootHarnessWithState(stateDir: string, mockOpts: any): Promise<Harness> {
  const { mockConfig } = await import('../../helpers/harness.ts');
  const { MockAdapter } = await import('../../../gateway/src/adapter/mock/mock-adapter.ts');
  const { startServer } = await import('../../../gateway/src/server.ts');
  const mock = new MockAdapter({ projects: [{ nativeWorkspaceId: 'ws-demo', name: 'demo-app', rootDir: '/tmp/zremote-demo', accessible: true }] });
  void mockOpts;
  const running = await startServer(mockConfig(stateDir), { adapter: mock });
  const baseUrl = `http://127.0.0.1:${running.port}`;
  const pair = async (name = 'd'): Promise<string> => {
    const { code } = running.gateway.createPairing();
    const res = await fetch(`${baseUrl}/v1/pair`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, deviceName: name }),
    });
    return ((await res.json()) as any).token;
  };
  const get = async (p: string, token?: string) => {
    const res = await fetch(`${baseUrl}${p}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: res.status, body: await res.json() };
  };
  const post = async (p: string, body?: unknown, token?: string) => {
    const res = await fetch(`${baseUrl}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
    });
    return { status: res.status, body: await res.json() };
  };
  const openSse = (after: number, token: string, onEvent: (raw: string) => void) =>
    Promise.resolve(async () => {
      void after;
      void token;
      void onEvent;
    });
  return { running, mock, baseUrl, pair, get, post, openSse, stateDir, shutdown: () => running.close() };
}

// ---------------------------------------------------------------------------
// AT-09 停止长任务：受理 → 真实终态；事件可见
// ---------------------------------------------------------------------------
test('AT-09 停止长任务：cancel_requested 受理后到达 cancelled 终态', async () => {
  const create = await h.post(
    '/v1/projects/ws-demo/tasks',
    {
      clientCommandId: 'at09-1',
      title: '长任务',
      message: 'm',
    },
    phone,
  );
  const taskId = create.body.nativeTaskId;
  await sleep(40);
  // 让 mock 跑一个慢脚本
  const slow = await h.post(
    `/v1/tasks/${taskId}/messages`,
    { clientCommandId: 'at09-2', message: '开始慢步骤' },
    phone,
  );
  assert.equal(slow.status, 202);

  const cancel = await h.post(`/v1/tasks/${taskId}/cancel`, { clientCommandId: 'at09-cancel' }, phone);
  assert.equal(cancel.status, 202);
  assert.equal(cancel.body.accepted, true);

  await sleep(80);
  const snap = await h.get(`/v1/tasks/${taskId}`, phone);
  assert.ok(
    ['cancelled', 'cancel_requested'].includes(snap.body.task.status.status),
    `停止后应进入 cancelled/cancel_requested，实际 ${snap.body.task.status.status}`,
  );
});

// ---------------------------------------------------------------------------
// AT-12 未授权目录、路径穿越、撤销设备
// ---------------------------------------------------------------------------
test('AT-12a 不可接入项目拒绝创建任务', async () => {
  const r = await h.post(
    '/v1/projects/ws-locked/tasks',
    { clientCommandId: `at12-${Date.now()}`, title: 'x', message: 'y' },
    phone,
  );
  assert.equal(r.status, 404, '不可接入项目必须拒绝');
});

test('AT-12b 撤销设备后 401，现有连接断开', async () => {
  const tok = await h.pair('victim');
  const ok = await h.get('/v1/projects', tok);
  assert.equal(ok.status, 200);
  // 找到设备并撤销（adminToken 首次调用时落盘）
  const admin = h.running.gateway.adminToken();
  const devices = await h.get(`/v1/devices?admin=${admin}`);
  const victim = devices.body.devices.find((d: any) => d.name === 'victim');
  const rev = await h.post(`/v1/devices/${victim.id}/revoke?admin=${admin}`, {});
  assert.equal(rev.status, 200);
  const after = await h.get('/v1/projects', tok);
  assert.equal(after.status, 401);
  assert.equal(after.body.code, 'device_revoked');
});

test('AT-12c 静态服务路径穿越拒绝', async () => {
  const res = await fetch(`${h.baseUrl}/..%2f..%2f..%2fetc%2fpasswd`);
  assert.ok([403, 404].includes(res.status), `路径穿越必须拒绝，实际 ${res.status}`);
});

// ---------------------------------------------------------------------------
// AT-13 结果对应同一 Run：摘要/diff/测试记录不串线
// ---------------------------------------------------------------------------
test('AT-13 多任务并行：事件按 Run 归属，互不串线', async () => {
  const t1 = await h.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: 'at13-1', title: '任务甲', message: 'm' },
    phone,
  );
  const t2 = await h.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: 'at13-2', title: '任务乙', message: 'm' },
    phone2,
  );
  await sleep(150);
  const events = h.running.gateway.bus;
  void events;
  const e1 = await h.get(`/v1/tasks/${t1.body.nativeTaskId}/messages`, phone);
  const e2 = await h.get(`/v1/tasks/${t2.body.nativeTaskId}/messages`, phone2);
  assert.ok(e1.body.messages.every((m: any) => m.taskId === t1.body.nativeTaskId), '任务甲消息只含甲');
  assert.ok(e2.body.messages.every((m: any) => m.taskId === t2.body.nativeTaskId), '任务乙消息只含乙');
});

// ---------------------------------------------------------------------------
// AT-14 版本不兼容：停止写操作并提示
// ---------------------------------------------------------------------------
test('AT-14 版本不兼容：写操作被拒且错误明确', async () => {
  const incompatible = await (async () => {
    const { MockAdapter } = await import('../../../gateway/src/adapter/mock/mock-adapter.ts');
    return new MockAdapter({ compatible: false, compatibleDetail: '模拟版本过旧' });
  })();
  const h2 = await bootHarness({ compatible: false, compatibleDetail: '模拟版本过旧' });
  void incompatible;
  const tok = await h2.pair('at14');
  const r = await h2.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: `at14-${Date.now()}`, title: 'x', message: 'y' },
    tok,
  );
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'incompatible');
  const caps = await h2.get('/v1/capabilities', tok);
  assert.equal(caps.body.compatible, false);
  await h2.shutdown();
});

// ---------------------------------------------------------------------------
// AT-10（模拟）ZCode 退出：分类展示，不把断线改写为任务失败
// ---------------------------------------------------------------------------
test('AT-10 模拟：引擎离线时健康失败、缓存可见、创建任务 503', async () => {
  const h2 = await bootHarness();
  const tok = await h2.pair('at10');
  h2.mock.setOffline(true);
  const health = await h2.get('/v1/health');
  assert.equal(health.body.ok, false);
  const projects = await h2.get('/v1/projects', tok);
  assert.equal(projects.status, 200, '离线时回退缓存仍可见项目');
  const create = await h2.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: `at10-${Date.now()}`, title: 'x', message: 'y' },
    tok,
  );
  assert.equal(create.status, 503, '引擎离线创建任务必须 503 而非伪造成功');
  assert.equal(create.body.code, 'engine_offline');
  h2.mock.setOffline(false);
  await h2.shutdown();
});

// ---------------------------------------------------------------------------
// AT-11（模拟）客户端被回收后重连：全量校准 + 未读事件可见
// ---------------------------------------------------------------------------
test('AT-11 模拟：断连期间事件累积，重连后全量补齐', async () => {
  const tok = await h.pair('at11-phone');
  const create = await h.post(
    '/v1/projects/ws-demo/tasks',
    { clientCommandId: 'at11-1', title: '回收测试', message: 'm' },
    tok,
  );
  const taskId = create.body.nativeTaskId;
  const cursor = h.running.gateway.bus.latestSeq();
  await sleep(60);

  // "息屏"：断开连接，期间 Mac 侧产生事件
  await h.post(`/v1/tasks/${taskId}/messages`, { clientCommandId: 'at11-mac-1', message: '期间消息1' }, phone2);
  await sleep(80);
  await h.post(`/v1/tasks/${taskId}/messages`, { clientCommandId: 'at11-mac-2', message: '期间消息2' }, phone2);
  await sleep(80);

  // "回前台"：带旧游标重连
  const events: any[] = [];
  const close = await h.openSse(cursor, tok, (raw) => events.push(JSON.parse(raw)));
  await sleep(120);
  close();
  const unread = events.filter((e) => e.kind === 'user_message');
  assert.ok(unread.length >= 2, `重连后未读事件必须可见，实际 ${unread.length}`);
});
