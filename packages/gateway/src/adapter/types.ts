/**
 * ZCode Remote — Adapter 契约（PRD §11 / §14.1）
 *
 * 网关与 ZCode 后端之间的唯一边界。所有后端（mock / real app-server / 未来桌面桥）
 * 实现同一接口；网关其余部分只依赖本文件的领域模型。
 *
 * 注意：这些是自建网关的内部契约，不是 ZCode 官方 API。
 */

// ---------------------------------------------------------------------------
// 统一运行状态（PRD §6.1）
// ---------------------------------------------------------------------------

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'waiting_input'
  | 'waiting_approval'
  | 'cancel_requested'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface StatusMapping {
  status: TaskStatus;
  /** 原生状态原值；原生没有对应状态时必须记录映射依据（PRD §6.1） */
  nativeRaw?: string;
  /** 该映射是直读原生还是网关推断 */
  source: 'native' | 'inferred';
}

// ---------------------------------------------------------------------------
// 领域对象
// ---------------------------------------------------------------------------

export type MessageRole = 'user' | 'assistant' | 'system' | 'tool';

export interface ProjectInfo {
  nativeWorkspaceId: string;
  name: string;
  rootDir: string;
  /** 当前是否可接入（PRD §5.4：不可接入必须显式给出原因） */
  accessible: boolean;
  inaccessibleReason?: string;
}

export interface TaskInfo {
  nativeTaskId: string;
  nativeSessionId: string;
  projectId: string;
  title: string;
  status: StatusMapping;
  /** 单调递增的任务修订号；用于乐观并发（PRD §6.2 追加消息带预期版本） */
  revision: number;
  createdAt: string;
  lastActivityAt: string;
}

export interface MessageInfo {
  nativeMessageId: string;
  taskId: string;
  role: MessageRole;
  /** 文本内容；工具调用等结构化内容进 payload */
  content: string;
  createdAt: string;
  payload?: Record<string, unknown>;
}

export type ApprovalKind = 'permission' | 'user_input';

export interface ApprovalRequest {
  nativeRequestId: string;
  taskId: string;
  runId?: string;
  kind: ApprovalKind;
  /** 人类可读的操作摘要（命令行、影响范围） */
  summary: string;
  payload: Record<string, unknown>;
  createdAt: string;
}

export type EventKind =
  | 'user_message'
  | 'assistant_message'
  | 'assistant_delta'
  | 'tool_started'
  | 'tool_progress'
  | 'tool_result'
  | 'tool_error'
  | 'approval_requested'
  | 'approval_resolved'
  | 'turn_started'
  | 'turn_complete'
  | 'run_failed'
  | 'run_cancelled'
  | 'run_succeeded'
  | 'run_unknown_state'
  | 'engine_error'
  /** 原生事件透传（无法归类时保持原样，不伪造语义，PRD §6.1 精神） */
  | 'native_event';

export interface AdapterEvent {
  /** 原生事件标识；无原生 ID 时由 Adapter 生成（去重用） */
  nativeEventId: string;
  taskId: string;
  runId?: string;
  kind: EventKind;
  occurredAt: string;
  payload: Record<string, unknown>;
}

export interface AdapterCapabilities {
  /** 原生支持在运行中插话（steer 当前 Run） */
  supportsSteer: boolean;
  /** 原生支持消息排队（等待本轮结束后投递） */
  supportsQueue: boolean;
  supportsApproval: boolean;
  supportsCancel: boolean;
  /** 跨进程恢复同一原生会话（P0 硬性验收） */
  supportsSessionResume: boolean;
  /** 原生是否持久化可回读的事件历史 */
  persistentEventHistory: boolean;
  /** 原生任务列表发现能力 */
  supportsTaskListing: boolean;
  backendId: string;
  backendVersion: string;
  /** 版本兼容自检结论（PRD §14.1：不兼容优先停止写操作） */
  compatible: boolean;
  compatibleDetail?: string;
}

// ---------------------------------------------------------------------------
// 契约
// ---------------------------------------------------------------------------

export interface CreateTaskRequest {
  projectId: string;
  title: string;
  /** 首条用户消息（任务目标） */
  message: string;
}

export interface CreateTaskResult {
  nativeTaskId: string;
  nativeSessionId: string;
  nativeRunId?: string;
}

export type ApprovalDecision = 'approve' | 'deny';

export interface CancelResult {
  /** 引擎受理（不等于已停止） */
  accepted: boolean;
  detail?: string;
}

export interface HealthInfo {
  ok: boolean;
  detail: string;
}

export interface TaskSnapshot {
  task: TaskInfo;
  messages: MessageInfo[];
  pendingApprovals: ApprovalRequest[];
}

export interface AdapterEventHandler {
  (event: AdapterEvent): void;
}

export interface AdapterSubscription {
  unsubscribe(): void;
}

/**
 * 所有后端必须实现的统一契约。
 * 实现方约定：
 *  - 方法抛出 AdapterError 及其子类，不抛任意异常；
 *  - 事件只含 Adapter 已接收的内容，不伪造从未发生的输出（PRD §7.3）；
 *  - 未知原生状态映射为 unknown 并保留 nativeRaw。
 */
export interface IZcodeAdapter {
  readonly capabilities: AdapterCapabilities;
  healthCheck(): Promise<HealthInfo>;
  listProjects(): Promise<ProjectInfo[]>;
  listTasks(projectId?: string): Promise<TaskInfo[]>;
  createTask(req: CreateTaskRequest): Promise<CreateTaskResult>;
  sendMessage(
    nativeTaskId: string,
    message: string,
    opts?: { expectedRevision?: number },
  ): Promise<{ nativeMessageId?: string; nativeRunId?: string; queued?: boolean }>;
  subscribe(handler: AdapterEventHandler): AdapterSubscription;
  resolveApproval(
    nativeRequestId: string,
    decision: ApprovalDecision,
  ): Promise<void>;
  cancel(nativeTaskId: string): Promise<CancelResult>;
  snapshot(nativeTaskId: string): Promise<TaskSnapshot>;
  shutdown?(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 适配器错误分类（网关统一错误映射的依据，PRD §11 末段）
// ---------------------------------------------------------------------------

export type AdapterErrorCode =
  | 'ENGINE_OFFLINE'
  | 'ENGINE_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNSUPPORTED'
  | 'RESULT_PENDING'
  | 'INCOMPATIBLE';

export class AdapterError extends Error {
  readonly code: AdapterErrorCode;
  readonly retryable: boolean;
  constructor(code: AdapterErrorCode, message: string, opts?: { retryable?: boolean; cause?: unknown }) {
    super(message, { cause: opts?.cause });
    this.name = 'AdapterError';
    this.code = code;
    this.retryable = opts?.retryable ?? false;
  }
}

export class EngineOfflineError extends AdapterError {
  constructor(message: string, cause?: unknown) {
    super('ENGINE_OFFLINE', message, { retryable: true, cause });
    this.name = 'EngineOfflineError';
  }
}
export class NotFoundError extends AdapterError {
  constructor(message: string) {
    super('NOT_FOUND', message);
    this.name = 'NotFoundError';
  }
}
export class ConflictError extends AdapterError {
  constructor(message: string) {
    super('CONFLICT', message);
    this.name = 'ConflictError';
  }
}
export class UnsupportedError extends AdapterError {
  constructor(message: string) {
    super('UNSUPPORTED', message);
    this.name = 'UnsupportedError';
  }
}
/** 已发起调用但无法确认是否生效：禁止自动重发（PRD §7.2） */
export class ResultPendingError extends AdapterError {
  constructor(message: string, cause?: unknown) {
    super('RESULT_PENDING', message, { cause });
    this.name = 'ResultPendingError';
  }
}
export class IncompatibleError extends AdapterError {
  constructor(message: string) {
    super('INCOMPATIBLE', message);
    this.name = 'IncompatibleError';
  }
}
