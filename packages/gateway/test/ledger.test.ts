/** 命令账本幂等语义单测（PRD §7.2 / AT-07 / AT-08） */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.ts';
import { CommandLedger, LedgerConflictError } from '../src/ledger/ledger.ts';
import { ResultPendingError, ConflictError } from '../src/adapter/types.ts';

function freshLedger(): { ledger: CommandLedger; db: ReturnType<typeof openDb> } {
  const db = openDb(`/tmp/zr-test-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  return { ledger: new CommandLedger(db), db };
}

test('同一 clientCommandId 重试只执行一次 executor，返回原状态', async () => {
  const { ledger } = freshLedger();
  let calls = 0;
  const exec = async () => {
    calls += 1;
    return { nativeTaskId: 'nt-1', nativeRunId: 'nr-1' };
  };
  const r1 = await ledger.submit('cmd-1', 'dev-1', { kind: 'create_task', data: { title: 'x' } }, exec);
  const r2 = await ledger.submit('cmd-1', 'dev-1', { kind: 'create_task', data: { title: 'x' } }, exec);
  assert.equal(calls, 1, 'executor 必须只执行一次');
  assert.equal(r1.clientCommandId, 'cmd-1');
  assert.equal(r2.status, 'completed');
  assert.equal(r2.nativeTaskId, 'nt-1');
});

test('相同 ID 不同内容 → 拒绝（LedgerConflict）', async () => {
  const { ledger } = freshLedger();
  await ledger.submit('cmd-1', 'dev-1', { kind: 'create_task', data: { title: 'x' } }, async () => ({}));
  await assert.rejects(
    ledger.submit('cmd-1', 'dev-1', { kind: 'create_task', data: { title: 'y' } }, async () => ({})),
    LedgerConflictError,
  );
});

test('同 ID 不同 kind 同样拒绝', async () => {
  const { ledger } = freshLedger();
  await ledger.submit('cmd-1', 'dev-1', { kind: 'create_task', data: { a: 1 } }, async () => ({}));
  await assert.rejects(
    ledger.submit('cmd-1', 'dev-1', { kind: 'cancel', taskId: 't', data: { a: 1 } }, async () => ({})),
    LedgerConflictError,
  );
});

test('executor 抛 RESULT_PENDING → pending_verify，重试不重发副作用', async () => {
  const { ledger } = freshLedger();
  let calls = 0;
  const pendingExec = async () => {
    calls += 1;
    throw new ResultPendingError('已调用未记账');
  };
  const r1 = await ledger.submit('cmd-p', 'dev-1', { kind: 'append_message', taskId: 't1', data: { message: 'm' } }, pendingExec);
  assert.equal(r1.status, 'pending_verify');
  assert.equal(r1.pendingVerify, true);
  // 重试（用户刷新后查询/重提交同一 ID）不应再次调用引擎
  const r2 = await ledger.submit('cmd-p', 'dev-1', { kind: 'append_message', taskId: 't1', data: { message: 'm' } }, pendingExec);
  assert.equal(calls, 1, 'RESULT_PENDING 后重试禁止自动重发');
  assert.equal(r2.status, 'pending_verify');
  const list = ledger.listPendingVerify();
  assert.equal(list.length, 1);
});

test('executor 明确失败（非 pending）→ 账本留痕 failed 并重抛；重试不重复执行', async () => {
  const { ledger } = freshLedger();
  let calls = 0;
  await assert.rejects(
    ledger.submit(
      'cmd-f',
      'dev-1',
      { kind: 'cancel', taskId: 't1', data: {} },
      async () => {
        calls += 1;
        throw new ConflictError('revision mismatch');
      },
    ),
    ConflictError,
  );
  assert.equal(calls, 1);
  // failed 后同 ID 重试：账本幂等返回留痕状态（客户端可查询，不重复执行）
  const r2 = await ledger.submit('cmd-f', 'dev-1', { kind: 'cancel', taskId: 't1', data: {} }, async () => {
    calls += 1;
    return {};
  });
  assert.equal(calls, 1, '同 ID 重试不重复执行');
  assert.equal(r2.status, 'failed');
  assert.equal(r2.errorCode, 'CONFLICT');
});

test('账本跨实例恢复（重启后重试返回已完成状态）', async () => {
  const dir = `/tmp/zr-test-ledger-reopen-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const db1 = openDb(dir);
  const l1 = new CommandLedger(db1);
  await l1.submit('cmd-x', 'dev-1', { kind: 'create_task', data: { title: 't' } }, async () => ({ nativeTaskId: 'nt-9' }));
  // 模拟网关重启
  const db2 = openDb(dir);
  const l2 = new CommandLedger(db2);
  let calls = 0;
  const r = await l2.submit('cmd-x', 'dev-1', { kind: 'create_task', data: { title: 't' } }, async () => {
    calls += 1;
    return { nativeTaskId: 'nt-other' };
  });
  assert.equal(calls, 0);
  assert.equal(r.status, 'completed');
  assert.equal(r.nativeTaskId, 'nt-9');
});
