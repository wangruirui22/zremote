/**
 * Gateway 编排层：Adapter ↔ 账本/注册表/事件总线 的装配与高层操作。
 * API 层只调用本模块，不直接触碰 Adapter。
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  AdapterEvent,
  ApprovalDecision,
  CreateTaskRequest,
  IZcodeAdapter,
  MessageInfo,
  ProjectInfo,
  TaskInfo,
  TaskSnapshot,
} from './adapter/types.ts';
import { IncompatibleError, NotFoundError } from './adapter/types.ts';
import { AuthStore } from './auth/store.ts';
import { EventBus, type GatewayEvent } from './events/bus.ts';
import { CommandLedger } from './ledger/ledger.ts';
import { Registry, type ApprovalRow } from './state/registry.ts';
import type { GatewayConfig } from './config.ts';

export type { GatewayEvent };

export class Gateway {
  readonly auth: AuthStore;
  readonly bus: EventBus;
  readonly ledger: CommandLedger;
  readonly registry: Registry;
  private readonly db: DatabaseSync;
  readonly adapter: IZcodeAdapter;
  readonly config: GatewayConfig;

  /** 已撤销设备的 SSE 订阅关闭钩子（PRD §9：撤销后断开现有订阅） */
  private connectionClosers = new Map<string, Set<() => void>>();
  /** 每项目写任务串行队列（PRD §7.4：首版每项目最多 1 个并行写任务） */
  private projectQueues = new Map<string, Promise<unknown>>();

  constructor(db: DatabaseSync, adapter: IZcodeAdapter, config: GatewayConfig) {
    this.db = db;
    this.adapter = adapter;
    this.config = config;
    this.auth = new AuthStore(db, { pairingTtlMs: config.pairingTtlMs, pairingMaxAttempts: config.pairingMaxAttempts });
    this.bus = new EventBus(db, { days: config.eventRetentionDays, max: config.eventRetentionMax });
    this.ledger = new CommandLedger(db);
    this.registry = new Registry(db, adapter);
    this.wireAdapterEvents();
  }

  private wireAdapterEvents(): void {
    this.adapter.subscribe((e: AdapterEvent) => {
      // 审批请求 → 登记并加过期
      if (e.kind === 'approval_requested') {
        const payload = e.payload as { nativeRequestId?: string; summary?: string; kind?: string };
        if (payload.nativeRequestId) {
          this.registry.registerApproval({
            nativeRequestId: payload.nativeRequestId,
            taskId: e.taskId,
            runId: e.runId,
            kind: payload.kind === 'user_input' ? 'user_input' : 'permission',
            summary: payload.summary ?? '(无摘要)',
            payload: e.payload,
            createdAt: e.occurredAt,
          });
        }
      }
      // 事件先落库再分发（EventBus 内保证）
      this.bus.publishFromAdapter(e);
      // 任务状态跟随事件（运行中/成功/失败/取消/等待审批）
      this.applyTaskStatusFromEvent(e);
    });
  }

  private applyTaskStatusFromEvent(e: AdapterEvent): void {
    const cached = this.registry.cachedTask(e.taskId);
    if (!cached) return;
    let status: TaskInfo['status'] | null = null;
    switch (e.kind) {
      case 'turn_started': status = { status: 'running', nativeRaw: 'running', source: 'inferred' }; break;
      case 'approval_requested': status = { status: 'waiting_approval', nativeRaw: 'waiting_approval', source: 'inferred' }; break;
      case 'run_succeeded': status = { status: 'succeeded', nativeRaw: 'done', source: 'inferred' }; break;
      case 'run_failed': status = { status: 'failed', nativeRaw: 'error', source: 'inferred' }; break;
      case 'run_cancelled':
        // PRD §6.1：cancel_requested 只是请求送达；事件 payload.phase==='requested' 不改终态
        status = e.payload?.phase === 'requested'
          ? { status: 'cancel_requested', nativeRaw: 'cancelling', source: 'inferred' }
          : { status: 'cancelled', nativeRaw: 'cancelled', source: 'inferred' };
        break;
      default: return;
    }
    this.registry.upsertTask({ ...cached, status, lastActivityAt: e.occurredAt });
  }

  // -- 高层操作 ----------------------------------------------------------------

  /** PRD §14.1：对不兼容升级优先停止写操作（AT-14） */
  private assertCompatibleForWrite(): void {
    const caps = this.adapter.capabilities;
    if (!caps.compatible) {
      throw new IncompatibleError(caps.compatibleDetail ?? '后端版本不兼容，写操作已停止');
    }
  }

  async health(): Promise<{ ok: boolean; detail: string }> {
    return this.adapter.healthCheck();
  }

  capabilities(): IZcodeAdapter['capabilities'] {
    return this.adapter.capabilities;
  }

  createPairing(): { code: string; expiresAt: string } {
    return this.auth.createPairingCode();
  }

  async projects(): Promise<Array<ProjectInfo & { lastSyncedAt: string }>> {
    try {
      await this.registry.syncProjects();
    } catch {
      // 引擎离线时回退缓存（PRD §10.2：不凭超时断言，缓存可见）
    }
    return this.registry.cachedProjects();
  }

  async tasks(projectId?: string): Promise<TaskInfo[]> {
    try {
      await this.registry.syncTasks();
    } catch {
      // 回退缓存
    }
    return this.registry.cachedTasks(projectId);
  }

  /** 创建任务：幂等（账本）+ 每项目写串行（PRD §7.4） */
  async createTask(
    clientCommandId: string,
    deviceId: string,
    req: CreateTaskRequest,
  ): Promise<{ commandId: string; nativeTaskId: string; nativeSessionId: string; nativeRunId?: string; taskId: string }> {
    const run = () =>
      this.ledger.submit(clientCommandId, deviceId, { kind: 'create_task', data: { ...req } }, async () => {
        this.assertCompatibleForWrite();
        const result = await this.adapter.createTask(req);
        const now = new Date().toISOString();
        this.registry.upsertTask({
          nativeTaskId: result.nativeTaskId,
          nativeSessionId: result.nativeSessionId,
          projectId: req.projectId,
          title: req.title,
          status: { status: 'running', nativeRaw: 'running', source: 'inferred' },
          revision: 1,
          createdAt: now,
          lastActivityAt: now,
        });
        this.auth.audit(deviceId, 'task_created', { projectId: req.projectId, taskId: result.nativeTaskId, title: req.title });
        return { taskId: `t-${result.nativeTaskId}`, nativeTaskId: result.nativeTaskId, nativeRunId: result.nativeRunId };
      });
    const prev = this.projectQueues.get(req.projectId) ?? Promise.resolve();
    const next = prev.then(run, run); // 队列不因前次失败而阻塞
    this.projectQueues.set(req.projectId, next.catch(() => undefined));
    const r = await next;
    const nativeTaskId = r.nativeTaskId ?? '';
    const nativeSessionId = this.registry.cachedTask(nativeTaskId)?.nativeSessionId ?? '';
    return {
      commandId: r.clientCommandId,
      nativeTaskId,
      nativeSessionId,
      nativeRunId: r.nativeRunId,
      taskId: r.taskId ?? `t-${nativeTaskId}`,
    };
  }

  /** 追加消息：账本幂等 + 乐观版本（PRD §6.2） */
  async appendMessage(
    clientCommandId: string,
    deviceId: string,
    nativeTaskId: string,
    message: string,
    expectedRevision?: number,
  ): Promise<{ commandId: string; queued?: boolean; nativeRunId?: string; nativeMessageId?: string }> {
    const r = await this.ledger.submit(
      clientCommandId,
      deviceId,
      { kind: 'append_message', taskId: nativeTaskId, data: { message, expectedRevision } },
      async () => {
        this.assertCompatibleForWrite();
        const res = await this.adapter.sendMessage(nativeTaskId, message, { expectedRevision });
        this.auth.audit(deviceId, 'message_appended', { taskId: nativeTaskId, revision: expectedRevision });
        return { taskId: nativeTaskId, nativeTaskId, nativeRunId: res.nativeRunId, nativeMessageId: res.nativeMessageId };
      },
    );
    return {
      commandId: r.clientCommandId,
      nativeRunId: r.nativeRunId,
      nativeMessageId: r.nativeMessageId,
    };
  }

  async cancel(
    clientCommandId: string,
    deviceId: string,
    nativeTaskId: string,
  ): Promise<{ commandId: string; accepted: boolean }> {
    const r = await this.ledger.submit(
      clientCommandId,
      deviceId,
      { kind: 'cancel', taskId: nativeTaskId, data: { nativeTaskId } },
      async () => {
        const res = await this.adapter.cancel(nativeTaskId);
        this.auth.audit(deviceId, 'cancel_requested', { taskId: nativeTaskId, accepted: res.accepted });
        return { taskId: nativeTaskId, nativeTaskId };
      },
    );
    return { commandId: r.clientCommandId, accepted: r.status !== 'failed' };
  }

  /**
   * 审批决定：登记表单次消费 + 账本幂等（PRD §6.2 / AT-05）。
   * 返回冲突信息时调用方映射 409。
   */
  async resolveApproval(
    clientCommandId: string,
    deviceId: string,
    nativeRequestId: string,
    decision: ApprovalDecision,
  ): Promise<{ commandId: string; approval: ApprovalRow }> {
    const r = await this.ledger.submit(
      clientCommandId,
      deviceId,
      { kind: 'resolve_approval', data: { nativeRequestId, decision } },
      async () => {
        const approval = this.registry.resolveApproval(nativeRequestId, decision, deviceId);
        await this.adapter.resolveApproval(nativeRequestId, decision);
        this.auth.audit(deviceId, 'approval_resolved', { nativeRequestId, decision, taskId: approval.taskId });
        return { taskId: approval.taskId };
      },
    );
    return { commandId: r.clientCommandId, approval: this.findApproval(nativeRequestId) };
  }

  private findApproval(id: string): ApprovalRow {
    const all = this.registry.listPendingApprovals();
    const hit = all.find((a) => a.nativeRequestId === id);
    if (hit) return hit;
    // 已处理的审批不在 pending 列表 —— 用一个轻量查询回读
    const row = (this.db.prepare('SELECT native_request_id FROM approvals WHERE native_request_id = ?').get(id)) as
      | { native_request_id: string }
      | undefined;
    if (row) {
      // resolveApproval 后回读：通过注册表内部状态（已解决）——重新登记会破坏语义，这里直接构造只读视图
      const resolved = this.db
        .prepare('SELECT * FROM approvals WHERE native_request_id = ?')
        .get(id) as Record<string, unknown>;
      return {
        nativeRequestId: String(resolved.native_request_id),
        taskId: String(resolved.task_id),
        runId: (resolved.run_id as string) || undefined,
        kind: resolved.kind as ApprovalRow['kind'],
        summary: String(resolved.summary),
        payload: JSON.parse(String(resolved.payload_json)) as Record<string, unknown>,
        state: resolved.state as ApprovalRow['state'],
        decision: (resolved.decision as ApprovalDecision) || undefined,
        resolvedByDevice: (resolved.resolved_by_device as string) || undefined,
        expiresAt: String(resolved.expires_at),
        createdAt: String(resolved.created_at),
      };
    }
    throw new NotFoundError(`approval ${id} not found`);
  }

  /** 快照：fetch-through + 缓存更新（PRD §11 GET /v1/tasks/{id}） */
  async snapshot(nativeTaskId: string): Promise<TaskSnapshot> {
    const snap = await this.adapter.snapshot(nativeTaskId);
    this.registry.upsertTask(snap.task);
    return snap;
  }

  async messages(nativeTaskId: string): Promise<MessageInfo[]> {
    // 历史正文遵循原生机制，从 Adapter 快照取（PRD §7.3：任务正文保存遵循 ZCode 原生机制）
    const snap = await this.snapshot(nativeTaskId);
    return snap.messages;
  }

  // -- 管理与查询辅助 ------------------------------------------------------------

  /** 本地管理令牌：首次启动生成并落盘（0600），菜单栏/CLI 读取 */
  adminToken(): string {
    const file = path.join(this.config.stateDir, 'admin-token');
    try {
      return fs.readFileSync(file, 'utf8').trim();
    } catch {
      const token = crypto.randomBytes(24).toString('hex');
      fs.mkdirSync(this.config.stateDir, { recursive: true });
      fs.writeFileSync(file, token + '\n', { mode: 0o600 });
      return token;
    }
  }

  /** run → task 反查（经事件流；网关不重建引擎内部映射） */
  taskIdByRun(runId: string): string | undefined {
    const row = this.db
      .prepare('SELECT task_id FROM events WHERE run_id = ? ORDER BY stream_seq LIMIT 1')
      .get(runId) as { task_id: string } | undefined;
    return row?.task_id;
  }

  listArtifacts(taskId: string): Array<{ id: string; taskId: string; runId?: string; mime: string; size: number; createdAt: string }> {
    const rows = this.db.prepare('SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at').all(taskId) as Array<
      Record<string, unknown>
    >;
    return rows.map((r) => ({
      id: String(r.id),
      taskId: String(r.task_id),
      runId: (r.run_id as string) || undefined,
      mime: String(r.mime),
      size: Number(r.size),
      createdAt: String(r.created_at),
    }));
  }

  // -- 连接与撤销 ---------------------------------------------------------------

  registerConnection(deviceId: string, close: () => void): () => void {
    let set = this.connectionClosers.get(deviceId);
    if (!set) {
      set = new Set();
      this.connectionClosers.set(deviceId, set);
    }
    set.add(close);
    return () => {
      set!.delete(close);
      if (set!.size === 0) this.connectionClosers.delete(deviceId);
    };
  }

  revokeDevice(deviceId: string): boolean {
    const ok = this.auth.revoke(deviceId);
    const closers = this.connectionClosers.get(deviceId);
    if (closers) {
      for (const c of [...closers]) c(); // 断开现有订阅
    }
    return ok;
  }

  // -- 产物（AT-12 路径安全） -----------------------------------------------------

  registerArtifact(args: { taskId: string; runId?: string; absPath: string; mime?: string }): string {
    const root = this.artifactRoot(args.absPath);
    const st = fs.statSync(args.absPath);
    const id = `art-${crypto.randomUUID().slice(0, 12)}`;
    this.db
      .prepare('INSERT INTO artifacts (id, task_id, run_id, path, root_dir, mime, size, sha256, created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(
        id, args.taskId, args.runId ?? null, args.absPath, root, args.mime ?? 'text/plain',
        st.size, '', new Date().toISOString(),
      );
    return id;
  }

  /** 产物读取：仅按资源 ID 解析；realpath 防符号链接逃逸 + 根目录前缀检查（PRD §9） */
  readArtifact(id: string): { absPath: string; mime: string; size: number } {
    const row = this.db.prepare('SELECT * FROM artifacts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) throw new NotFoundError(`artifact ${id} not found`);
    const absPath = String(row.path);
    const root = String(row.root_dir);
    const real = fs.realpathSync(absPath); // 逃逸检测：断链/符号链接跳转都会改变 realpath
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
      throw new NotFoundError(`artifact ${id} escape rejected`);
    }
    return { absPath: real, mime: String(row.mime), size: Number(row.size) };
  }

  private artifactRoot(absPath: string): string {
    const real = fs.realpathSync(absPath);
    const projectRoots = this.registry.cachedProjects().map((p) => p.rootDir);
    const hit = projectRoots.find((r) => real.startsWith(fs.realpathSync(r) + path.sep));
    if (!hit) throw new NotFoundError(`artifact outside authorized roots: ${absPath}`);
    return fs.realpathSync(hit);
  }
}
