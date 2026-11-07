/**
 * Mock 适配器：脚本化 ZCode 引擎模拟（PRD §14.1 评估基线 / e2e 确定性后端）
 *
 * 可编排能力：
 *  - 任务脚本流（assistant 消息 / 工具 / 审批 / 成功失败）；
 *  - 行为注入：审批等待、断流丢事件、重复事件、未知状态、引擎崩溃；
 *  - 崩溃注入点用于 AT-07/AT-08（下发成功但响应丢失、网关崩溃边界）。
 */
import {
  AdapterError,
  ConflictError,
  EngineOfflineError,
  NotFoundError,
  type AdapterCapabilities,
  type AdapterEvent,
  type AdapterEventHandler,
  type AdapterSubscription,
  type ApprovalDecision,
  type ApprovalRequest,
  type CancelResult,
  type CreateTaskRequest,
  type CreateTaskResult,
  type EventKind,
  type HealthInfo,
  type IZcodeAdapter,
  type MessageInfo,
  type ProjectInfo,
  type StatusMapping,
  type TaskInfo,
  type TaskSnapshot,
} from '../types.ts';

// ---------------------------------------------------------------------------
// 脚本定义
// ---------------------------------------------------------------------------

export type MockStep =
  | { t: 'assistant'; text: string; delayMs?: number }
  | { t: 'tool'; name: string; detail?: string; delayMs?: number }
  | { t: 'approval'; summary: string; kind?: 'permission' | 'user_input'; delayMs?: number }
  | { t: 'succeed'; delayMs?: number }
  | { t: 'fail'; reason: string; delayMs?: number };

/** 全局注入项（针对 adapter 实例，不是单任务） */
export interface MockFaults {
  /** 第 N 个事件之后静默丢弃后续事件（模拟断流，AT-06） */
  dropEventsAfter?: number;
  /** 第 N 个事件后重复发送一次旧事件（模拟重放去重，AT-06） */
  duplicateEventAt?: number;
  /** sendMessage 返回成功前抛 RESULT_PENDING（已调用未记账场景，AT-07/08） */
  throwPendingAfterSend?: boolean;
  /** listTasks/snapshot 抛 ENGINE_OFFLINE */
  engineOffline?: boolean;
  /** listTasks 返回未知原生状态字符串（映射到 unknown，PRD §6.1） */
  unknownNativeStatus?: string;
}

export interface MockTaskScript {
  taskId: string;
  projectId: string;
  title: string;
  status?: TaskStatusOverride;
  messages?: Array<{ role: 'user' | 'assistant'; content: string }>;
  /** 收到新消息时按此脚本执行；未配置则默认「回复 + 成功」 */
  flow?: MockStep[];
}

type TaskStatusOverride = 'running' | 'succeeded' | 'failed' | 'waiting_approval' | 'queued' | 'cancelled';

export interface MockAdapterOptions {
  backendVersion?: string;
  compatible?: boolean;
  compatibleDetail?: string;
  projects?: ProjectInfo[];
  tasks?: MockTaskScript[];
  faults?: MockFaults;
}

// ---------------------------------------------------------------------------
// 内部结构
// ---------------------------------------------------------------------------

interface MockRun {
  runId: string;
  taskId: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'waiting_approval';
  startedAt: string;
  endedAt?: string;
  abort?: () => void;
}

interface MockTaskState {
  info: TaskInfo;
  messages: MessageInfo[];
  scripts: MockStep[][]; // 队列：每次 sendMessage 消费一个脚本
  approvals: Map<string, ApprovalRequest & { resolve: (d: ApprovalDecision) => void }>;
  runs: MockRun[];
}

let seq = 0;
const nextId = (prefix: string): string => `${prefix}-${(++seq).toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const nowIso = (): string => new Date().toISOString();
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export class MockAdapter implements IZcodeAdapter {
  readonly capabilities: AdapterCapabilities;

  private readonly projects: Map<string, ProjectInfo>;
  private readonly tasks = new Map<string, MockTaskState>();
  private readonly faults: MockFaults;
  private handlers = new Set<AdapterEventHandler>();
  private eventSeq = 0;
  private offline = false;

  constructor(opts: MockAdapterOptions = {}) {
    this.capabilities = {
      supportsSteer: false,
      supportsQueue: true,
      supportsApproval: true,
      supportsCancel: true,
      supportsSessionResume: true,
      persistentEventHistory: true,
      supportsTaskListing: true,
      backendId: 'mock',
      backendVersion: opts.backendVersion ?? 'mock-1.0.0',
      compatible: opts.compatible ?? true,
      compatibleDetail: opts.compatibleDetail,
    };
    this.faults = opts.faults ?? {};
    this.projects = new Map(
      (opts.projects ?? [
        { nativeWorkspaceId: 'ws-demo', name: 'demo-app', rootDir: '/tmp/zremote-demo', accessible: true },
        { nativeWorkspaceId: 'ws-locked', name: 'locked-repo', rootDir: '/srv/locked', accessible: false, inaccessibleReason: 'workspace_missing' },
      ]).map((p) => [p.nativeWorkspaceId, p]),
    );
    for (const t of opts.tasks ?? []) this.seedTask(t);
  }

  // -- 种子任务 ---------------------------------------------------------------

  private seedTask(script: MockTaskScript): void {
    const status: StatusMapping = script.status
      ? { status: script.status, nativeRaw: script.status, source: 'native' }
      : { status: 'succeeded', nativeRaw: 'idle', source: 'native' };
    const info: TaskInfo = {
      nativeTaskId: script.taskId,
      nativeSessionId: `sess-${script.taskId}`,
      projectId: script.projectId,
      title: script.title,
      status,
      revision: (script.messages?.length ?? 0) + 1,
      createdAt: nowIso(),
      lastActivityAt: nowIso(),
    };
    const messages: MessageInfo[] = (script.messages ?? [{ role: 'user', content: script.title }]).map((m, i) => ({
      nativeMessageId: `${script.taskId}-m${i}`,
      taskId: script.taskId,
      role: m.role,
      content: m.content,
      createdAt: nowIso(),
    }));
    this.tasks.set(script.taskId, {
      info,
      messages,
      scripts: script.flow ? [script.flow] : [],
      approvals: new Map(),
      runs: [],
    });
  }

  // -- IZcodeAdapter ----------------------------------------------------------

  async healthCheck(): Promise<HealthInfo> {
    if (this.offline || this.faults.engineOffline) {
      return { ok: false, detail: 'mock engine offline' };
    }
    return { ok: true, detail: `mock engine ${this.capabilities.backendVersion} ready` };
  }

  async listProjects(): Promise<ProjectInfo[]> {
    this.assertOnline();
    return [...this.projects.values()].map((p) => ({ ...p }));
  }

  async listTasks(projectId?: string): Promise<TaskInfo[]> {
    this.assertOnline();
    if (this.faults.unknownNativeStatus) {
      // 注入一个未知原生状态的任务（PRD §6.1：必须落为 unknown）
      const t = this.tasks.values().next().value as MockTaskState | undefined;
      if (t) t.info.status = { status: 'unknown', nativeRaw: this.faults.unknownNativeStatus, source: 'native' };
    }
    return [...this.tasks.values()]
      .filter((t) => !projectId || t.info.projectId === projectId)
      .map((t) => ({ ...t.info }));
  }

  async createTask(req: CreateTaskRequest): Promise<CreateTaskResult> {
    this.assertOnline();
    const project = this.projects.get(req.projectId);
    if (!project || !project.accessible) {
      throw new NotFoundError(`project ${req.projectId} not accessible`);
    }
    if (this.faults.throwPendingAfterSend) {
      // AT-07/08：模拟“已送达引擎并创建，但回执丢失”——任务已存在，网关侧进入待核对
      const taskId = nextId('task');
      this.seedTask({
        taskId,
        projectId: req.projectId,
        title: req.title,
        messages: [{ role: 'user', content: req.message }],
        flow: [{ t: 'assistant', text: `收到目标：${req.title}` }, { t: 'succeed' }],
      });
      throw new AdapterError('RESULT_PENDING', 'mock: create delivered but receipt lost');
    }
    const taskId = nextId('task');
    this.seedTask({
      taskId,
      projectId: req.projectId,
      title: req.title,
      messages: [{ role: 'user', content: req.message }],
      flow: [{ t: 'assistant', text: `收到目标：${req.title}` }, { t: 'tool', name: 'bash', detail: 'npm test' }, { t: 'succeed' }],
    });
    const state = this.tasks.get(taskId)!;
    state.info.status = { status: 'running', nativeRaw: 'running', source: 'native' };
    const run = this.startRun(taskId);
    void this.playScript(taskId, run);
    return { nativeTaskId: taskId, nativeSessionId: state.info.nativeSessionId, nativeRunId: run.runId };
  }

  async sendMessage(
    nativeTaskId: string,
    message: string,
    opts?: { expectedRevision?: number },
  ): Promise<{ nativeMessageId: string; nativeRunId?: string; queued?: boolean }> {
    this.assertOnline();
    const state = this.requireTask(nativeTaskId);
    if (opts?.expectedRevision !== undefined && opts.expectedRevision !== state.info.revision) {
      throw new ConflictError(`revision mismatch: expected ${opts.expectedRevision}, actual ${state.info.revision}`);
    }
    if (this.faults.throwPendingAfterSend) {
      // 已"送达引擎"但网关未拿到回执：调用方必须进入结果待核对，禁止自动重发
      throw new AdapterError('RESULT_PENDING', 'mock: send delivered but receipt lost');
    }
    const msg: MessageInfo = {
      nativeMessageId: nextId('msg'),
      taskId: nativeTaskId,
      role: 'user',
      content: message,
      createdAt: nowIso(),
    };
    state.messages.push(msg);
    state.info.revision += 1;
    state.info.lastActivityAt = msg.createdAt;

    const script = state.scripts.shift();
    if (!script) {
      state.info.status = { status: 'waiting_input', nativeRaw: 'idle', source: 'native' };
      this.emit({ taskId: nativeTaskId, kind: 'user_message', payload: { messageId: msg.nativeMessageId } });
      return { nativeMessageId: msg.nativeMessageId, queued: true };
    }
    const run = this.startRun(nativeTaskId);
    state.info.status = { status: 'running', nativeRaw: 'running', source: 'native' };
    void this.playScript(nativeTaskId, run, script);
    return { nativeMessageId: msg.nativeMessageId, nativeRunId: run.runId };
  }

  subscribe(handler: AdapterEventHandler): AdapterSubscription {
    this.handlers.add(handler);
    return { unsubscribe: () => this.handlers.delete(handler) };
  }

  async resolveApproval(nativeRequestId: string, decision: ApprovalDecision): Promise<void> {
    this.assertOnline();
    for (const state of this.tasks.values()) {
      const approval = state.approvals.get(nativeRequestId);
      if (approval) {
        state.approvals.delete(nativeRequestId); // 单次消费（PRD §6.2）
        if (state.info.status.status === 'waiting_approval') {
          state.info.status = decision === 'approve'
            ? { status: 'running', nativeRaw: 'running', source: 'native' }
            : { status: 'cancelled', nativeRaw: 'cancelled', source: 'native' };
        }
        approval.resolve(decision);
        this.emit({
          taskId: state.info.nativeTaskId,
          kind: 'approval_resolved',
          payload: { nativeRequestId, decision },
        });
        return;
      }
    }
    throw new NotFoundError(`approval ${nativeRequestId} not found or already resolved`);
  }

  async cancel(nativeTaskId: string): Promise<CancelResult> {
    this.assertOnline();
    const state = this.requireTask(nativeTaskId);
    const run = state.runs.find((r) => r.status === 'running' || r.status === 'waiting_approval');
    state.info.status = { status: 'cancel_requested', nativeRaw: 'cancelling', source: 'native' };
    this.emit({ taskId: nativeTaskId, runId: run?.runId, kind: 'run_cancelled', payload: { phase: 'requested' } });
    if (run?.abort) run.abort();
    return { accepted: true };
  }

  async snapshot(nativeTaskId: string): Promise<TaskSnapshot> {
    this.assertOnline();
    const state = this.requireTask(nativeTaskId);
    return {
      task: { ...state.info },
      messages: state.messages.map((m) => ({ ...m })),
      pendingApprovals: [...state.approvals.values()].map(({ resolve: _resolve, ...rest }) => rest),
    };
  }

  // -- 脚本执行 ---------------------------------------------------------------

  private startRun(taskId: string): MockRun {
    const state = this.requireTask(taskId);
    const run: MockRun = { runId: nextId('run'), taskId, status: 'running', startedAt: nowIso() };
    state.runs.push(run);
    this.emit({ taskId, runId: run.runId, kind: 'turn_started', payload: {} });
    return run;
  }

  private async playScript(taskId: string, run: MockRun, script?: MockStep[]): Promise<void> {
    const state = this.requireTask(taskId);
    const flow: MockStep[] = script ?? state.scripts.shift() ?? [{ t: 'assistant', text: '完成。' }, { t: 'succeed' }];
    const timers: NodeJS.Timeout[] = [];
    let aborted = false;
    run.abort = () => {
      aborted = true;
      for (const t of timers) clearTimeout(t);
      this.finishRun(state, run, 'cancelled');
    };

    for (const step of flow) {
      if (aborted) return;
      if (step.delayMs) await sleep(step.delayMs);
      if (aborted) return;
      switch (step.t) {
        case 'assistant': {
          const msg: MessageInfo = {
            nativeMessageId: nextId('msg'),
            taskId,
            role: 'assistant',
            content: step.text,
            createdAt: nowIso(),
          };
          state.messages.push(msg);
          state.info.lastActivityAt = msg.createdAt;
          this.emit({ taskId, runId: run.runId, kind: 'assistant_message', payload: { messageId: msg.nativeMessageId, text: step.text } });
          break;
        }
        case 'tool': {
          this.emit({ taskId, runId: run.runId, kind: 'tool_started', payload: { name: step.name, detail: step.detail ?? '' } });
          await sleep(step.delayMs ?? 20);
          if (aborted) return;
          this.emit({ taskId, runId: run.runId, kind: 'tool_result', payload: { name: step.name, detail: step.detail ?? '', exit: 0 } });
          break;
        }
        case 'approval': {
          const approval: ApprovalRequest = {
            nativeRequestId: nextId('apr'),
            taskId,
            runId: run.runId,
            kind: step.kind ?? 'permission',
            summary: step.summary,
            payload: {},
            createdAt: nowIso(),
          };
          const gate = new Promise<ApprovalDecision>((resolve) => {
            state.approvals.set(approval.nativeRequestId, { ...approval, resolve });
          });
          state.info.status = { status: 'waiting_approval', nativeRaw: 'waiting_approval', source: 'native' };
          this.emit({ taskId, runId: run.runId, kind: 'approval_requested', payload: { ...approval } });
          const decision = await gate;
          if (aborted) return;
          if (decision === 'deny') {
            this.finishRun(state, run, 'cancelled');
            return;
          }
          break;
        }
        case 'succeed':
          this.finishRun(state, run, 'succeeded');
          return;
        case 'fail':
          this.emit({ taskId, runId: run.runId, kind: 'run_failed', payload: { reason: step.reason } });
          this.finishRun(state, run, 'failed', step.reason);
          return;
      }
    }
    this.finishRun(state, run, 'succeeded');
  }

  private finishRun(
    state: MockTaskState,
    run: MockRun,
    end: 'succeeded' | 'failed' | 'cancelled',
    reason?: string,
  ): void {
    if (run.status !== 'running' && run.status !== 'waiting_approval') return;
    run.status = end;
    run.endedAt = nowIso();
    const status: StatusMapping =
      end === 'succeeded'
        ? { status: 'succeeded', nativeRaw: 'idle', source: 'native' }
        : end === 'failed'
          ? { status: 'failed', nativeRaw: 'error', source: 'native' }
          : { status: 'cancelled', nativeRaw: 'cancelled', source: 'native' };
    state.info.status = status;
    state.info.lastActivityAt = run.endedAt;
    const kind: EventKind = end === 'succeeded' ? 'run_succeeded' : end === 'failed' ? 'run_failed' : 'run_cancelled';
    this.emit({ taskId: run.taskId, runId: run.runId, kind, payload: reason ? { reason } : {} });
  }

  private emit(e: { taskId: string; runId?: string; kind: EventKind; payload: Record<string, unknown> }): void {
    const event: AdapterEvent = {
      nativeEventId: nextId('evt'),
      taskId: e.taskId,
      runId: e.runId,
      kind: e.kind,
      occurredAt: nowIso(),
      payload: e.payload,
    };
    this.eventSeq += 1;
    if (this.faults.dropEventsAfter !== undefined && this.eventSeq > this.faults.dropEventsAfter) return;
    const targets = [...this.handlers];
    for (const h of targets) h(event);
    if (this.faults.duplicateEventAt !== undefined && this.eventSeq === this.faults.duplicateEventAt) {
      // 稍后重放同一事件：客户端必须按 nativeEventId 去重
      const dup = { ...event };
      setTimeout(() => {
        for (const h of [...this.handlers]) h(dup);
      }, 30);
    }
  }

  private requireTask(nativeTaskId: string): MockTaskState {
    const state = this.tasks.get(nativeTaskId);
    if (!state) throw new NotFoundError(`task ${nativeTaskId} not found`);
    return state;
  }

  private assertOnline(): void {
    if (this.offline || this.faults.engineOffline) throw new EngineOfflineError('mock engine offline');
  }

  // -- 测试控制钩子 ------------------------------------------------------------

  /** 注入一个引擎侧待审批（模拟 permission_requested 已发出，AT-05） */
  injectApproval(taskId: string, req: { nativeRequestId: string; summary: string }): void {
    const state = this.requireTask(taskId);
    const approval: ApprovalRequest = {
      nativeRequestId: req.nativeRequestId,
      taskId,
      kind: 'permission',
      summary: req.summary,
      payload: {},
      createdAt: nowIso(),
    };
    state.approvals.set(approval.nativeRequestId, {
      ...approval,
      resolve: (_d: ApprovalDecision) => undefined,
    });
  }

  /** 模拟引擎崩溃/恢复（AT-08/AT-10） */
  setOffline(offline: boolean): void {
    this.offline = offline;
  }
  /** 设置已到达"调用成功但未记账"注入点 */
  armPendingSendFault(): void {
    this.faults.throwPendingAfterSend = true;
  }
  disarmPendingSendFault(): void {
    this.faults.throwPendingAfterSend = false;
  }
}
