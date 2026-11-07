/**
 * Real 适配器：对接真实 ZCode app-server（stdio JSON 协议）。
 *
 * 协议结论（2026-11-07 对本机 ZCode 3.17.2 实测，见 probe.ts 与 docs/adapter-contract.md）：
 *  - 帧格式 NDJSON：客户端请求 {id:number, method, params} → 应答 {id, result} | {id, error:{code,message}}；
 *  - 无 initialize 握手；服务端会主动发请求（string id），必须应答否则挂起；
 *  - 方法：session/list / create / resume / send / read / messages / events / subscribe / stop；
 *  - session/send 字段是 content（不是 message）；subscribe 需 deliveryKind="web-remote-replayable"；
 *  - 事件：通知 `session/event`（params 含 eventId/seq/payload/sessionId）与 `state.updated`
 *    （patch.status + reason=prompt_started|prompt_completed）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import {
  ConflictError,
  EngineOfflineError,
  NotFoundError,
  UnsupportedError,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterEventHandler,
  type AdapterSubscription,
  type ApprovalDecision,
  type CancelResult,
  type CreateTaskRequest,
  type CreateTaskResult,
  type EventKind,
  type HealthInfo,
  type IZcodeAdapter,
  type MessageInfo,
  type ProjectInfo,
  type TaskInfo,
  type TaskSnapshot,
} from '../types.ts';
import type { GatewayConfig } from '../../config.ts';

// ---------------------------------------------------------------------------
// 协议客户端
// ---------------------------------------------------------------------------

type JsonRpcLike = Record<string, unknown>;

class AppServerClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: JsonRpcLike) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private buffer = '';
  private readonly entry: string;
  readonly notificationHandlers = new Set<(method: string, params: Record<string, unknown>) => void>();

  constructor(entry: string) {
    this.entry = entry;
  }

  get alive(): boolean {
    return this.child !== null && this.child.exitCode === null;
  }

  async ensureStarted(): Promise<void> {
    if (this.alive) return;
    const child = spawn(process.execPath, [this.entry, 'app-server', '--surface', 'terminal'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });
    child.stdout!.on('data', (d: Buffer) => this.onData(d.toString()));
    child.stderr!.on('data', (d: Buffer) => {
      const s = d.toString().trim();
      if (s) console.error('[zcode-app-server stderr]', s.slice(0, 300));
    });
    child.on('exit', (code) => {
      // 进程退出：所有 pending 请求失败
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new EngineOfflineError(`app-server exited (code=${code})`));
      }
      this.pending.clear();
      this.child = null;
    });
    this.child = child;
    await this.waitReady();
  }

  private waitReady(): Promise<void> {
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const check = (): void => {
        if (this.alive) resolve();
        else if (Date.now() - started > 10000) reject(new EngineOfflineError('app-server 启动超时'));
        else setTimeout(check, 100);
      };
      check();
    });
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line.startsWith('{')) continue;
      let msg: JsonRpcLike;
      try {
        msg = JSON.parse(line) as JsonRpcLike;
      } catch {
        continue;
      }
      this.onMessage(msg);
    }
  }

  private onMessage(msg: JsonRpcLike): void {
    const id = msg.id as number | string | undefined;
    const method = msg.method as string | undefined;
    // 服务端 → 客户端请求：必须应答
    if (typeof id === 'string' && typeof method === 'string') {
      // 审批类请求：不得自动应答（会等于静默放行），登记后由网关 resolveApproval 回写
      if (/permission|approval|confirm|userinput|user_input/i.test(method)) {
        const params = (msg.params ?? {}) as Record<string, unknown>;
        const requestId = String(params.requestId ?? params.id ?? id);
        this.pendingInteractions.set(requestId, (result) => {
          this.child?.stdin!.write(JSON.stringify({ id, result }) + '\n');
        });
        if (this.onApprovalRequest) this.onApprovalRequest(requestId, method, params);
        return;
      }
      const result = this.serverRequestResult(method);
      this.child?.stdin!.write(JSON.stringify({ id, result }) + '\n');
      return;
    }
    if (typeof id === 'number' && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.resolve(msg);
      return;
    }
    if (typeof method === 'string' && msg.params && typeof msg.params === 'object') {
      for (const h of [...this.notificationHandlers]) h(method, msg.params as Record<string, unknown>);
    }
  }

  /** 审批类服务端请求登记表（nativeRequestId → 应答回写） */
  readonly pendingInteractions = new Map<string, (result: Record<string, unknown>) => void>();
  /** 新会话捕获钩子（lifecycle starting）由 RealAdapter 注入 */
  onApprovalRequest: ((requestId: string, method: string, params: Record<string, unknown>) => void) | null = null;

  /** 已知服务端请求的应答体（probe 实测） */
  private serverRequestResult(method: string): Record<string, unknown> {
    if (method === 'session/requestRuntimePreferences') {
      return { nativeSearchEnhancementsEnabled: false };
    }
    return {}; // interaction/requestOfficialMcpAuthHeaders 等可容忍空应答
  }

  request(method: string, params: Record<string, unknown>, timeoutMs = 10000): Promise<JsonRpcLike> {
    if (!this.alive) return Promise.reject(new EngineOfflineError('app-server 未运行'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new EngineOfflineError(`app-server 请求超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  shutdown(): void {
    this.child?.kill('SIGTERM');
    this.child = null;
  }
}

// ---------------------------------------------------------------------------
// 事件分类（基于 probe 捕获的 payload 结构）
// ---------------------------------------------------------------------------

function classifySessionEvent(payload: Record<string, unknown>): EventKind {
  if (payload.kind === 'text_delta') return 'assistant_delta';
  if (payload.input !== undefined) return 'user_message';
  if (payload.response !== undefined) {
    return payload.resultType === 'success' ? 'run_succeeded' : payload.resultType ? 'run_failed' : 'run_unknown_state';
  }
  if (payload.toolName !== undefined || payload.tool !== undefined) {
    if (payload.exit !== undefined || payload.result !== undefined) return 'tool_result';
    return 'tool_started';
  }
  return 'native_event';
}

function mapSessionStatus(nativeStatus: string, mode: string): TaskInfo['status'] {
  switch (nativeStatus) {
    case 'running':
    case 'executing':
      return { status: 'running', nativeRaw: nativeStatus, source: 'native' };
    case 'idle':
      // 交互式会话空闲 = 本轮结束、任务可继续（PRD §6.1：不与“任务完成”混同）
      return { status: 'waiting_input', nativeRaw: nativeStatus, source: 'native' };
    case 'waiting_approval':
      return { status: 'waiting_approval', nativeRaw: nativeStatus, source: 'native' };
    case 'waiting_input':
      return { status: 'waiting_input', nativeRaw: nativeStatus, source: 'native' };
    default:
      return { status: 'unknown', nativeRaw: `${nativeStatus}(mode=${mode})`, source: 'native' };
  }
}

// ---------------------------------------------------------------------------
// RealAdapter
// ---------------------------------------------------------------------------

interface SessionMeta {
  sessionId: string;
  workspaceKey: string;
  workspacePath: string;
  title: string;
  status: string;
  mode: string;
  updatedAt: number;
}

export class RealAdapter implements IZcodeAdapter {
  readonly capabilities: AdapterCapabilities;
  private readonly client: AppServerClient;
  private readonly handlers = new Set<AdapterEventHandler>();
  private readonly subscribed = new Set<string>();
  /** send 受理后引擎 projection 异步更新，本地先标记 running（prompt_completed 后解除） */
  private readonly locallyRunning = new Set<string>();

  constructor(config: GatewayConfig) {
    this.client = new AppServerClient(config.zcodeEntry);
    this.client.onApprovalRequest = (requestId, method, params) => {
      // 服务端审批请求 → 统一 approval_requested 事件（绑定 nativeRequestId）
      const sessionId = (params.sessionId as string) ?? '';
      if (!sessionId) return;
      this.dispatch({
        nativeEventId: `approval-${requestId}`,
        taskId: sessionId,
        kind: 'approval_requested',
        occurredAt: new Date().toISOString(),
        payload: { nativeRequestId: requestId, method, summary: JSON.stringify(params).slice(0, 300), ...params },
      });
    };
    this.capabilities = {
      supportsSteer: false, // 运行中插话语义未实测；先按不支持处理，仅排队
      supportsQueue: true,
      supportsApproval: true, // 经服务端 interaction 请求应答实现（见 onServerInteraction）
      supportsCancel: true,
      supportsSessionResume: true,
      persistentEventHistory: true,
      supportsTaskListing: true,
      backendId: 'real-appserver',
      backendVersion: '3.17.2 (app-server protocol v1)',
      compatible: true,
      compatibleDetail: 'WSL 实测通过；方法覆盖见 docs/adapter-contract.md',
    };
    this.client.notificationHandlers.add((method, params) => this.onNotification(method, params));
  }

  // -- 通知 → 统一事件 ---------------------------------------------------------

  private onNotification(method: string, params: Record<string, unknown>): void {
    if (method === 'session/event') {
      const sessionId = params.sessionId as string | undefined;
      const payload = (params.payload ?? {}) as Record<string, unknown>;
      const eventId = (params.eventId as string) ?? `evt-${params.seq}`;
      if (!sessionId) return;
      this.dispatch({
        nativeEventId: eventId,
        taskId: sessionId,
        kind: classifySessionEvent(payload),
        occurredAt: new Date().toISOString(),
        payload: { seq: params.seq, ...payload },
      });
      return;
    }
    if (method === 'state.updated') {
      const sessionId = params.sessionId as string | undefined;
      const patch = (params.patch ?? {}) as Record<string, unknown>;
      const reason = params.reason as string | undefined;
      if (!sessionId) return;
      if (reason === 'prompt_started') {
        this.locallyRunning.add(sessionId);
        this.dispatch({
          nativeEventId: `state-${sessionId}-${String(params.revision)}`,
          taskId: sessionId,
          kind: 'turn_started',
          occurredAt: new Date().toISOString(),
          payload: { reason },
        });
      } else if (reason === 'prompt_completed') {
        this.locallyRunning.delete(sessionId);
        this.dispatch({
          nativeEventId: `state-${sessionId}-${String(params.revision)}`,
          taskId: sessionId,
          kind: 'turn_complete',
          occurredAt: new Date().toISOString(),
          payload: { reason, permissionMode: (patch as { permission?: { mode?: string } }).permission?.mode },
        });
      }
      return;
    }
    if (method === 'session/lifecycle/changed') {
      const sessionId = params.sessionId as string | undefined;
      const lastError = params.lastError as Record<string, unknown> | null | undefined;
      if (params.state === 'starting' && sessionId) {
        this.latestLifecycleSession = sessionId; // awaitSessionId 消费
      }
      if (lastError && sessionId) {
        this.dispatch({
          nativeEventId: `lifecycle-${sessionId}-${String(params.revision)}`,
          taskId: sessionId,
          kind: 'engine_error',
          occurredAt: new Date().toISOString(),
          payload: lastError,
        });
      }
    }
  }

  private dispatch(e: AdapterEvent): void {
    for (const h of [...this.handlers]) h(e);
  }

  // -- 会话激活与订阅 ------------------------------------------------------------

  private async activate(sessionId: string): Promise<void> {
    await this.client.ensureStarted();
    // 已在本进程内激活（create 过）就无需 resume；resume 对已激活会话幂等（probe 实测 OK）
    if (!this.subscribed.has(sessionId)) {
      await this.client.request('session/subscribe', { sessionId, deliveryKind: 'web-remote-replayable' }, 8000);
      this.subscribed.add(sessionId);
    }
  }

  // -- IZcodeAdapter ----------------------------------------------------------

  async healthCheck(): Promise<HealthInfo> {
    try {
      await this.client.ensureStarted();
      const res = await this.client.request('session/list', {}, 8000);
      const n = ((res.result as { sessions?: unknown[] })?.sessions ?? []).length;
      return { ok: true, detail: `app-server ok, ${n} sessions` };
    } catch (e) {
      return { ok: false, detail: (e as Error).message };
    }
  }

  private async listSessionMeta(): Promise<SessionMeta[]> {
    await this.client.ensureStarted();
    const res = await this.client.request('session/list', {}, 10000);
    const sessions = ((res.result as { sessions?: Array<Record<string, unknown>> })?.sessions ?? []) as Array<
      Record<string, unknown>
    >;
    return sessions.map((s) => {
      const ws = (s.workspace ?? {}) as Record<string, unknown>;
      return {
        sessionId: String(s.sessionId),
        workspaceKey: String(ws.workspaceKey ?? ''),
        workspacePath: String(ws.workspacePath ?? ''),
        title: String(s.title ?? '(未命名)'),
        status: String(s.status ?? 'unknown'),
        mode: String(s.mode ?? 'unknown'),
        updatedAt: Number(s.updatedAt ?? 0),
      };
    });
  }

  async listProjects(): Promise<ProjectInfo[]> {
    const metas = await this.listSessionMeta();
    const byKey = new Map<string, ProjectInfo>();
    for (const m of metas) {
      if (!m.workspaceKey) continue;
      if (!byKey.has(m.workspaceKey)) {
        byKey.set(m.workspaceKey, {
          nativeWorkspaceId: m.workspaceKey,
          name: path.basename(m.workspacePath) || m.workspaceKey,
          rootDir: m.workspacePath,
          accessible: true,
        });
      }
    }
    return [...byKey.values()];
  }

  async listTasks(projectId?: string): Promise<TaskInfo[]> {
    const metas = await this.listSessionMeta();
    return metas
      .filter((m) => !projectId || m.workspaceKey === projectId)
      .map((m) => ({
        nativeTaskId: m.sessionId,
        nativeSessionId: m.sessionId,
        projectId: m.workspaceKey,
        title: m.title,
        status: mapSessionStatus(m.status, m.mode),
        revision: 1,
        createdAt: new Date(m.updatedAt).toISOString(),
        lastActivityAt: new Date(m.updatedAt).toISOString(),
      }));
  }

  async createTask(req: CreateTaskRequest): Promise<CreateTaskResult> {
    await this.client.ensureStarted();
    const res = await this.client.request(
      'session/create',
      { workspace: { workspaceKey: req.projectId, workspacePath: req.projectId } },
      20000,
    );
    if (res.error) throw new EngineOfflineError(`session/create 失败: ${JSON.stringify(res.error)}`);
    const sessionId = await this.awaitSessionId(res);
    await this.activate(sessionId);
    const sendRes = await this.client.request('session/send', { sessionId, content: req.message }, 10000);
    if (sendRes.error) throw new EngineOfflineError(`首条消息发送失败: ${JSON.stringify(sendRes.error)}`);
    const accepted = (sendRes.result as { accepted?: boolean } | undefined)?.accepted;
    if (accepted === false) throw new ConflictError('session/send 未受理');
    this.locallyRunning.add(sessionId);
    return { nativeTaskId: sessionId, nativeSessionId: sessionId };
  }

  /** create 应答不含 sessionId 时，从最近的 lifecycle 通知补取 */
  private latestLifecycleSession = '';
  private async awaitSessionId(_createRes: JsonRpcLike): Promise<string> {
    // create 返回的 projection.sessionId 可能为 "unknown"；session id 在 lifecycle 通知中
    // 通过短暂等待最新 lifecycle/starting 事件获取（probe 实测先于应答到达）
    if (this.latestLifecycleSession) {
      const id = this.latestLifecycleSession;
      this.latestLifecycleSession = '';
      return id;
    }
    // 兜底：等一小段时间捕获 lifecycle 通知
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 100));
      if (this.latestLifecycleSession) {
        const id = this.latestLifecycleSession;
        this.latestLifecycleSession = '';
        return id;
      }
    }
    throw new EngineOfflineError('未能从 lifecycle 通知获取新会话 ID');
  }

  async sendMessage(
    nativeTaskId: string,
    message: string,
    _opts?: { expectedRevision?: number },
  ): Promise<{ nativeRunId?: string; queued?: boolean }> {
    await this.activate(nativeTaskId);
    const sendRes = await this.client.request('session/send', { sessionId: nativeTaskId, content: message }, 10000);
    if (sendRes.error) {
      const err = sendRes.error as { code?: number; message?: string };
      if (err.code === -32010) {
        // 引擎明确拒绝：当前已有 prompt 在跑（PRD §6.2：明确冲突，不伪造生效）
        throw new ConflictError(`引擎拒绝追加：${err.message ?? 'prompt already running'}`);
      }
      throw new EngineOfflineError(`session/send 失败: ${JSON.stringify(sendRes.error)}`);
    }
    const accepted = (sendRes.result as { accepted?: boolean } | undefined)?.accepted;
    if (accepted === false) throw new ConflictError('session/send 未受理（会话可能不可用）');
    this.locallyRunning.add(nativeTaskId);
    return { queued: true }; // steer 语义未实测，按排队上报（PRD §6.2 不伪造“已生效”）
  }

  subscribe(handler: AdapterEventHandler): AdapterSubscription {
    this.handlers.add(handler);
    return { unsubscribe: () => this.handlers.delete(handler) };
  }

  /**
   * 审批应答：app-server 以服务端请求下发待审批项（interaction/...），
   * 适配器登记后在 resolveApproval 时向该请求回写决定。
   * （请求应答机制经 interaction/requestOfficialMcpAuthHeaders 实测验证；
   *  权限审批的确切方法在 AT 实测中记录，见 docs/adapter-contract.md。）
   */
  async resolveApproval(nativeRequestId: string, decision: ApprovalDecision): Promise<void> {
    const reply = this.client.pendingInteractions.get(nativeRequestId);
    if (!reply) {
      throw new NotFoundError(`审批 ${nativeRequestId} 不存在或已处理`);
    }
    this.client.pendingInteractions.delete(nativeRequestId); // 单次消费
    reply({ decision: decision === 'approve' ? 'approved' : 'denied' });
  }

  async cancel(nativeTaskId: string): Promise<CancelResult> {
    await this.activate(nativeTaskId);
    const res = await this.client.request('session/stop', { sessionId: nativeTaskId }, 8000);
    if (res.error) {
      const code = (res.error as { code?: number }).code;
      if (code === -32004) return { accepted: false, detail: '会话未激活，无运行中任务' };
      throw new EngineOfflineError(`session/stop 失败: ${JSON.stringify(res.error)}`);
    }
    // 受理即解除本地 running 标记；引擎确认后的真实终态由 projection/事件表达
    this.locallyRunning.delete(nativeTaskId);
    return { accepted: true, detail: 'cancel 请求已受理（引擎确认后进入终态）' };
  }

  async snapshot(nativeTaskId: string): Promise<TaskSnapshot> {
    await this.activate(nativeTaskId);
    const res = await this.client.request('session/read', { sessionId: nativeTaskId }, 10000);
    if (res.error) {
      const code = (res.error as { code?: number }).code;
      if (code === -32004) throw new NotFoundError(`会话 ${nativeTaskId} 不存在或未登记`);
      throw new EngineOfflineError(`session/read 失败: ${JSON.stringify(res.error)}`);
    }
    const result = (res.result ?? {}) as Record<string, unknown>;
    const projection = (result.projection ?? {}) as Record<string, unknown>;
    const rawMessages = (result.messages ?? []) as Array<Record<string, unknown>>;
    const messages: MessageInfo[] = rawMessages.map((m, i) => {
      const info = (m.info ?? {}) as Record<string, unknown>;
      const parts = (m.parts ?? []) as Array<Record<string, unknown>>;
      const text = parts
        .map((p) => (typeof p.text === 'string' ? p.text : ''))
        .filter(Boolean)
        .join('\n');
      return {
        nativeMessageId: String(info.messageId ?? `msg-${i}`),
        taskId: nativeTaskId,
        role: (info.role as MessageInfo['role']) ?? 'system',
        content: text,
        createdAt: new Date(Number((info.time as { created?: number })?.created ?? Date.now())).toISOString(),
      };
    });
    const pendingApprovals = ((projection.pendingPermissions as Array<Record<string, unknown>>) ?? []).map((p, i) => ({
      nativeRequestId: String(p.requestId ?? p.id ?? `perm-${i}`),
      taskId: nativeTaskId,
      kind: 'permission' as const,
      summary: JSON.stringify(p).slice(0, 200),
      payload: p,
      createdAt: new Date().toISOString(),
    }));
    // 状态合成：send 受理后引擎 projection 异步更新，本地 running 标记优先（避免把刚受理误报为空闲）
    const status = this.locallyRunning.has(nativeTaskId)
      ? ({ status: 'running', nativeRaw: `send_accepted(${String(projection.status ?? 'unknown')})`, source: 'inferred' } as TaskInfo['status'])
      : mapSessionStatus(String(projection.status ?? 'unknown'), String(projection.mode ?? ''));
    // updatedAt 来自 session/list；此处用当前时间（PRD：快照含 revision 与同步时间由网关负责）
    const meta = (await this.listSessionMeta()).find((m) => m.sessionId === nativeTaskId);
    const task: TaskInfo = {
      nativeTaskId,
      nativeSessionId: nativeTaskId,
      projectId: meta?.workspaceKey ?? '',
      title: meta?.title ?? '(未命名)',
      status,
      revision: 1,
      createdAt: meta ? new Date(meta.updatedAt).toISOString() : new Date().toISOString(),
      lastActivityAt: meta ? new Date(meta.updatedAt).toISOString() : new Date().toISOString(),
    };
    return { task, messages, pendingApprovals };
  }

  async shutdown(): Promise<void> {
    this.client.shutdown();
  }
}
