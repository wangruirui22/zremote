/**
 * 任务/项目注册表 + 审批登记（PRD §7.1、§6.2）：
 *  - ZCode 原生存储仍是事实来源；这里只是网关缓存（可随时从 Adapter 重建）；
 *  - 审批绑定 nativeRequestId + 有效期；单次消费；过期/已处理后返回冲突。
 */
import type { DatabaseSync } from 'node:sqlite';
import type {
  ApprovalDecision,
  ApprovalRequest,
  IZcodeAdapter,
  ProjectInfo,
  TaskInfo,
} from '../adapter/types.ts';

export class ApprovalConflictError extends Error {
  readonly reason: 'already_resolved' | 'expired' | 'not_found';
  constructor(reason: 'already_resolved' | 'expired' | 'not_found', message: string) {
    super(message);
    this.name = 'ApprovalConflictError';
    this.reason = reason;
  }
}

export interface ApprovalRow extends ApprovalRequest {
  state: 'pending' | 'resolved' | 'expired';
  decision?: ApprovalDecision;
  resolvedByDevice?: string;
  expiresAt: string;
}

const DEFAULT_APPROVAL_TTL_MS = 10 * 60 * 1000; // 审批有效期（PRD §6.2）

export class Registry {
  private readonly db: DatabaseSync;
  private readonly adapter: IZcodeAdapter;
  private readonly approvalTtlMs: number;

  constructor(db: DatabaseSync, adapter: IZcodeAdapter, approvalTtlMs = DEFAULT_APPROVAL_TTL_MS) {
    this.db = db;
    this.adapter = adapter;
    this.approvalTtlMs = approvalTtlMs;
  }

  // -- 项目/任务缓存 ------------------------------------------------------------

  async syncProjects(): Promise<ProjectInfo[]> {
    const projects = await this.adapter.listProjects();
    const up = this.db.prepare(
      `INSERT INTO projects (native_workspace_id, name, root_dir, accessible, inaccessible_reason, last_synced_at)
       VALUES (?,?,?,?,?,?)
       ON CONFLICT(native_workspace_id) DO UPDATE SET
         name=excluded.name, root_dir=excluded.root_dir, accessible=excluded.accessible,
         inaccessible_reason=excluded.inaccessible_reason, last_synced_at=excluded.last_synced_at`,
    );
    const now = new Date().toISOString();
    for (const p of projects) {
      up.run(p.nativeWorkspaceId, p.name, p.rootDir, p.accessible ? 1 : 0, p.inaccessibleReason ?? null, now);
    }
    return projects;
  }

  async syncTasks(): Promise<TaskInfo[]> {
    const tasks = await this.adapter.listTasks();
    for (const t of tasks) this.upsertTask(t);
    return tasks;
  }

  upsertTask(t: TaskInfo): void {
    this.db
      .prepare(
        `INSERT INTO tasks (native_task_id, native_session_id, project_id, title, status, status_native_raw, status_source, revision, created_at, last_activity_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(native_task_id) DO UPDATE SET
           title=excluded.title, status=excluded.status, status_native_raw=excluded.status_native_raw,
           status_source=excluded.status_source, revision=MAX(tasks.revision, excluded.revision),
           last_activity_at=MAX(tasks.last_activity_at, excluded.last_activity_at)`,
      )
      .run(
        t.nativeTaskId, t.nativeSessionId, t.projectId, t.title, t.status.status,
        t.status.nativeRaw ?? null, t.status.source, t.revision, t.createdAt, t.lastActivityAt,
      );
  }

  cachedProjects(): Array<ProjectInfo & { lastSyncedAt: string }> {
    const rows = this.db.prepare('SELECT * FROM projects ORDER BY name').all() as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      nativeWorkspaceId: String(r.native_workspace_id),
      name: String(r.name),
      rootDir: String(r.root_dir),
      accessible: Number(r.accessible) === 1,
      inaccessibleReason: (r.inaccessible_reason as string) || undefined,
      lastSyncedAt: String(r.last_synced_at),
    }));
  }

  cachedTasks(projectId?: string): TaskInfo[] {
    const rows = projectId
      ? this.db.prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY last_activity_at DESC').all(projectId)
      : this.db.prepare('SELECT * FROM tasks ORDER BY last_activity_at DESC').all();
    return (rows as Array<Record<string, unknown>>).map(rowToTask);
  }

  cachedTask(nativeTaskId: string): TaskInfo | undefined {
    const r = this.db.prepare('SELECT * FROM tasks WHERE native_task_id = ?').get(nativeTaskId) as
      | Record<string, unknown>
      | undefined;
    return r ? rowToTask(r) : undefined;
  }

  // -- 审批 ---------------------------------------------------------------------

  /** 事件层回调：审批请求登记（带有效期） */
  registerApproval(a: ApprovalRequest): ApprovalRow {
    const expiresAt = new Date(Date.parse(a.createdAt) + this.approvalTtlMs).toISOString();
    this.db
      .prepare(
        `INSERT INTO approvals (native_request_id, task_id, run_id, kind, summary, payload_json, state, expires_at, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)
         ON CONFLICT(native_request_id) DO NOTHING`,
      )
      .run(a.nativeRequestId, a.taskId, a.runId ?? null, a.kind, a.summary, JSON.stringify(a.payload), 'pending', expiresAt, a.createdAt);
    this.expireStale();
    return this.requireApproval(a.nativeRequestId);
  }

  /**
   * 单项决定（PRD §6.2）：过期/已处理/不存在 → 冲突；批准只作用于该项。
   */
  resolveApproval(
    nativeRequestId: string,
    decision: ApprovalDecision,
    deviceId: string,
  ): ApprovalRow {
    this.expireStale();
    const row = this.db.prepare('SELECT * FROM approvals WHERE native_request_id = ?').get(nativeRequestId) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      throw new ApprovalConflictError('not_found', `审批 ${nativeRequestId} 不存在`);
    }
    const state = String(row.state);
    if (state === 'resolved') {
      throw new ApprovalConflictError('already_resolved', '该审批已处理，请刷新后继续');
    }
    if (state === 'expired') {
      throw new ApprovalConflictError('expired', '该审批已过期，请等待重新发起');
    }
    this.db
      .prepare('UPDATE approvals SET state=?, decision=?, resolved_by_device=?, resolved_at=? WHERE native_request_id=? AND state=?')
      .run('resolved', decision, deviceId, new Date().toISOString(), nativeRequestId, 'pending');
    return this.requireApproval(nativeRequestId);
  }

  listPendingApprovals(taskId?: string): ApprovalRow[] {
    this.expireStale();
    const rows = taskId
      ? this.db.prepare("SELECT native_request_id FROM approvals WHERE state='pending' AND task_id=?").all(taskId)
      : this.db.prepare("SELECT native_request_id FROM approvals WHERE state='pending'").all();
    return (rows as Array<{ native_request_id: string }>).map((r) => this.requireApproval(r.native_request_id));
  }

  private requireApproval(id: string): ApprovalRow {
    const r = this.db.prepare('SELECT * FROM approvals WHERE native_request_id = ?').get(id) as Record<string, unknown>;
    return {
      nativeRequestId: String(r.native_request_id),
      taskId: String(r.task_id),
      runId: (r.run_id as string) || undefined,
      kind: r.kind as ApprovalRow['kind'],
      summary: String(r.summary),
      payload: JSON.parse(String(r.payload_json)) as Record<string, unknown>,
      state: r.state as ApprovalRow['state'],
      decision: (r.decision as ApprovalDecision) || undefined,
      resolvedByDevice: (r.resolved_by_device as string) || undefined,
      expiresAt: String(r.expires_at),
      createdAt: String(r.created_at),
    };
  }

  private expireStale(): void {
    this.db
      .prepare("UPDATE approvals SET state='expired' WHERE state='pending' AND expires_at < ?")
      .run(new Date().toISOString());
  }
}

function rowToTask(r: Record<string, unknown>): TaskInfo {
  return {
    nativeTaskId: String(r.native_task_id),
    nativeSessionId: String(r.native_session_id),
    projectId: String(r.project_id),
    title: String(r.title),
    status: {
      status: String(r.status) as TaskInfo['status']['status'],
      nativeRaw: (r.status_native_raw as string) || undefined,
      source: (r.status_source as TaskInfo['status']['source']) || 'native',
    },
    revision: Number(r.revision),
    createdAt: String(r.created_at),
    lastActivityAt: String(r.last_activity_at),
  };
}
