/**
 * 命令账本（PRD §7.2）：
 *  - 先持久化命令，再调用 Adapter；相同 clientCommandId 重试返回原状态；
 *  - 相同 ID 但 payloadHash 不同 → 拒绝；
 *  - 「调用成功但未记账」崩溃窗口 → pending_verify，禁止自动重发；
 *  - 不宣称绝对 exactly-once：异常不确定状态可识别、不自动重复副作用。
 *
 * 并发模型：进程内单飞（per-command promise 去重）+ SQLite 唯一约束兜底。
 */
import crypto from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export type CommandKind = 'create_task' | 'append_message' | 'cancel' | 'resolve_approval';

export type CommandStatus =
  | 'received' // 已持久化，尚未调用引擎
  | 'dispatched' // 已调用引擎，等待终态
  | 'completed' // 引擎确认成功
  | 'failed' // 引擎明确拒绝（可安全重试）
  | 'pending_verify'; // 不确定是否已产生副作用（PRD §7.2：禁止自动重发）

export interface CommandRow {
  clientCommandId: string;
  deviceId: string;
  kind: CommandKind;
  payloadHash: string;
  status: CommandStatus;
  taskId?: string;
  nativeTaskId?: string;
  nativeRunId?: string;
  nativeMessageId?: string;
  errorCode?: string;
  errorDetail?: string;
  pendingVerify: boolean;
  createdAt: string;
  updatedAt: string;
}

export class LedgerConflictError extends Error {
  readonly detail: string;
  constructor(detail: string) {
    super(`clientCommandId 冲突: ${detail}`);
    this.name = 'LedgerConflictError';
    this.detail = detail;
  }
}

export interface CommandPayload {
  kind: CommandKind;
  taskId?: string;
  /** 幂等载荷（进入 hash；用于同 ID 不同内容检测） */
  data: Record<string, unknown>;
}

export class CommandLedger {
  private inflight = new Map<string, Promise<CommandRow>>();
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  /**
   * 幂等入口。executor 仅在命令首次持久化后执行一次；
   * 重试（同 ID 同 hash）不再调用 executor，直接返回当前状态。
   * executor 抛 RESULT_PENDING 类错误时命令进入 pending_verify。
   */
  async submit(
    clientCommandId: string,
    deviceId: string,
    payload: CommandPayload,
    executor: () => Promise<{
      taskId?: string;
      nativeTaskId?: string;
      nativeRunId?: string;
      nativeMessageId?: string;
    }>,
  ): Promise<CommandRow> {
    const payloadHash = sha256Json(payload.data);
    const existing = this.get(clientCommandId);
    if (existing) {
      if (existing.payloadHash !== payloadHash || existing.kind !== payload.kind) {
        throw new LedgerConflictError('相同 clientCommandId 但内容不同，已拒绝');
      }
      return existing;
    }
    const running = this.inflight.get(clientCommandId);
    if (running) return running;

    const p = this.runOne(clientCommandId, deviceId, payload, payloadHash, executor).finally(() =>
      this.inflight.delete(clientCommandId),
    );
    this.inflight.set(clientCommandId, p);
    return p;
  }

  private async runOne(
    id: string,
    deviceId: string,
    payload: CommandPayload,
    payloadHash: string,
    executor: () => Promise<{
      taskId?: string;
      nativeTaskId?: string;
      nativeRunId?: string;
      nativeMessageId?: string;
    }>,
  ): Promise<CommandRow> {
    const now = new Date().toISOString();
    // 1) 先持久化（received）
    try {
      this.db
        .prepare(
          'INSERT INTO commands (client_command_id, device_id, kind, payload_hash, status, task_id, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
        )
        .run(id, deviceId, payload.kind, payloadHash, 'received', payload.taskId ?? null, now, now);
    } catch (e) {
      // 并发兜底：唯一约束冲突 → 已有记录，按幂等重试处理
      const existing = this.get(id);
      if (existing) {
        if (existing.payloadHash !== payloadHash || existing.kind !== payload.kind) {
          throw new LedgerConflictError('相同 clientCommandId 但内容不同，已拒绝');
        }
        return existing;
      }
      throw e;
    }

    // 2) 调用引擎
    this.mark(id, { status: 'dispatched' });
    try {
      const result = await executor();
      return this.mark(id, { status: 'completed', pendingVerify: false, ...result })!;
    } catch (e) {
      const err = e as Error & { code?: string; name?: string };
      if (err.name === 'ResultPendingError' || err.code === 'RESULT_PENDING') {
        // 不确定副作用：进入待核对，不自动重发；返回行由调用方查询
        this.mark(id, { status: 'pending_verify', pendingVerify: true, errorCode: 'RESULT_PENDING', errorDetail: err.message });
        return this.get(id)!;
      }
      this.mark(id, { status: 'failed', errorCode: err.code ?? 'EXECUTOR_ERROR', errorDetail: err.message });
      // 明确失败：账本留痕后向调用方重抛（API 层映射 4xx/5xx）；同 ID 重试返回留痕状态
      throw e;
    }
  }

  private mark(
    id: string,
    patch: Partial<Pick<CommandRow, 'status' | 'taskId' | 'nativeTaskId' | 'nativeRunId' | 'nativeMessageId' | 'errorCode' | 'errorDetail' | 'pendingVerify'>>,
  ): CommandRow | undefined {
    const cur = this.get(id);
    if (!cur) return undefined;
    this.db
      .prepare(
        `UPDATE commands SET
           status = ?, task_id = COALESCE(?, task_id), native_task_id = COALESCE(?, native_task_id),
           native_run_id = COALESCE(?, native_run_id), native_message_id = COALESCE(?, native_message_id),
           error_code = COALESCE(?, error_code), error_detail = COALESCE(?, error_detail),
           pending_verify = ?, updated_at = ?
         WHERE client_command_id = ?`,
      )
      .run(
        patch.status ?? cur.status,
        patch.taskId ?? null,
        patch.nativeTaskId ?? null,
        patch.nativeRunId ?? null,
        patch.nativeMessageId ?? null,
        patch.errorCode ?? null,
        patch.errorDetail ?? null,
        patch.pendingVerify ?? cur.pendingVerify ? 1 : 0,
        new Date().toISOString(),
        id,
      );
    return this.get(id);
  }

  get(clientCommandId: string): CommandRow | undefined {
    const r = this.db.prepare('SELECT * FROM commands WHERE client_command_id = ?').get(clientCommandId) as
      | Record<string, string | number>
      | undefined;
    if (!r) return undefined;
    return {
      clientCommandId: String(r.client_command_id),
      deviceId: String(r.device_id),
      kind: r.kind as CommandKind,
      payloadHash: String(r.payload_hash),
      status: r.status as CommandStatus,
      taskId: (r.task_id as string) || undefined,
      nativeTaskId: (r.native_task_id as string) || undefined,
      nativeRunId: (r.native_run_id as string) || undefined,
      nativeMessageId: (r.native_message_id as string) || undefined,
      errorCode: (r.error_code as string) || undefined,
      errorDetail: (r.error_detail as string) || undefined,
      pendingVerify: Number(r.pending_verify) === 1,
      createdAt: String(r.created_at),
      updatedAt: String(r.updated_at),
    };
  }

  /** 待核对命令清单（诊断/人工核对入口） */
  listPendingVerify(): CommandRow[] {
    const rows = this.db.prepare("SELECT client_command_id FROM commands WHERE pending_verify = 1").all() as Array<{
      client_command_id: string;
    }>;
    return rows.map((r) => this.get(r.client_command_id)!);
  }
}

/** 规范化 JSON（递归键排序）后取哈希，保证同内容不同键序产生相同 hash */
function sha256Json(obj: unknown): string {
  const canonical = JSON.stringify(canonicalize(obj));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = canonicalize((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}
