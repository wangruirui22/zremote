/**
 * /v1/* API 路由（PRD §11）。统一错误映射见 mapError。
 * 鉴权：除 /v1/health 与 /v1/pair 外全部需要 Bearer 设备 token；
 * SSE 同时接受 ?token=（EventSource 无法自定义头的场景），仍属应用层鉴权。
 */
import type http from 'node:http';
import fs from 'node:fs';
import {
  AdapterError,
  ConflictError,
  IncompatibleError,
  NotFoundError,
  UnsupportedError,
} from '../adapter/types.ts';
import type { Gateway } from '../gateway.ts';
import { HttpError, matchRoute, readJsonBody, type RouteDef } from '../http.ts';
import { AuthError } from '../auth/store.ts';
import { LedgerConflictError } from '../ledger/ledger.ts';
import { ApprovalConflictError } from '../state/registry.ts';

export function buildRoutes(gateway: Gateway): RouteDef[] {
  const routes: RouteDef[] = [];

  const json = (res: http.ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  const auth = (req: http.IncomingMessage, query: URLSearchParams) =>
    gateway.auth.authenticate(req.headers.authorization ?? (query.get('token') ? `Bearer ${query.get('token')}` : undefined));

  const deviceNameOf = (req: http.IncomingMessage): string => {
    const h = req.headers['x-device-name'];
    return typeof h === 'string' ? h : 'unknown';
  };

  // -- 健康与能力（health 不泄露项目及配置，PRD §11） ---------------------------

  routes.push({
    method: 'GET',
    pattern: '/v1/health',
    handler: async ({ raw }) => {
      const h = await gateway.health();
      json(raw.res, 200, { ok: h.ok, service: 'zremote-gateway', version: 1 });
    },
  });

  routes.push({
    method: 'GET',
    pattern: '/v1/capabilities',
    handler: async ({ raw, query }) => {
      const device = auth(raw.req, query);
      const caps = gateway.capabilities();
      json(raw.res, 200, { ...caps, deviceId: device.id });
    },
  });

  // -- 配对（无认证；限速/单次使用在 AuthStore 内） -----------------------------

  routes.push({
    method: 'POST',
    pattern: '/v1/pair',
    handler: async ({ raw }) => {
      const body = await readJsonBody(raw);
      const code = String(body.code ?? '');
      const name = String(body.deviceName ?? 'device');
      if (!code) throw new HttpError(400, 'missing_code', '缺少配对码');
      const { token, device } = await gateway.auth.pair(code, name);
      gateway.auth.audit(device.id, 'device_paired', { name: device.name });
      json(raw.res, 201, { token, device: { id: device.id, name: device.name, scope: device.scope } });
    },
  });

  // -- 项目与任务 ---------------------------------------------------------------

  routes.push({
    method: 'GET',
    pattern: '/v1/projects',
    handler: async ({ raw, query }) => {
      auth(raw.req, query);
      const projects = await gateway.projects();
      json(raw.res, 200, { projects });
    },
  });

  routes.push({
    method: 'GET',
    pattern: '/v1/projects/:id/tasks',
    handler: async ({ raw, params, query }) => {
      auth(raw.req, query);
      const tasks = await gateway.tasks(params.id);
      json(raw.res, 200, { tasks, revisionNow: Math.max(0, ...tasks.map((t) => t.revision)) });
    },
  });

  routes.push({
    method: 'POST',
    pattern: '/v1/projects/:id/tasks',
    handler: async ({ raw, params, query }) => {
      const device = auth(raw.req, query);
      const body = await readJsonBody(raw);
      const clientCommandId = String(body.clientCommandId ?? '');
      const title = String(body.title ?? '');
      const message = String(body.message ?? '');
      if (!clientCommandId || !title || !message) {
        throw new HttpError(400, 'missing_fields', '需要 clientCommandId、title、message');
      }
      const r = await gateway.createTask(
        clientCommandId,
        device.id,
        { projectId: params.id!, title, message },
      );
      json(raw.res, 202, { commandId: r.commandId, taskId: r.taskId, nativeTaskId: r.nativeTaskId, nativeSessionId: r.nativeSessionId, nativeRunId: r.nativeRunId, status: 'accepted' });
    },
  });

  routes.push({
    method: 'GET',
    pattern: '/v1/tasks/:id',
    handler: async ({ raw, params, query }) => {
      auth(raw.req, query);
      const snap = await gateway.snapshot(params.id!);
      json(raw.res, 200, {
        task: snap.task,
        pendingApprovals: snap.pendingApprovals,
        capabilities: gateway.capabilities(),
        serverTime: new Date().toISOString(),
      });
    },
  });

  routes.push({
    method: 'GET',
    pattern: '/v1/tasks/:id/messages',
    handler: async ({ raw, params, query }) => {
      auth(raw.req, query);
      const messages = await gateway.messages(params.id!);
      const limit = Number.parseInt(query.get('limit') ?? '100', 10) || 100;
      const before = query.get('before');
      let list = messages;
      if (before) {
        const idx = messages.findIndex((m) => m.nativeMessageId === before);
        if (idx > 0) list = messages.slice(0, idx);
      }
      const paged = list.slice(-limit);
      json(raw.res, 200, {
        messages: paged,
        hasMore: paged.length < list.length,
        oldestLoaded: paged[0]?.nativeMessageId,
      });
    },
  });

  routes.push({
    method: 'POST',
    pattern: '/v1/tasks/:id/messages',
    handler: async ({ raw, params, query }) => {
      const device = auth(raw.req, query);
      const body = await readJsonBody(raw);
      const clientCommandId = String(body.clientCommandId ?? '');
      const message = String(body.message ?? '');
      const expectedRevision = body.expectedRevision === undefined ? undefined : Number(body.expectedRevision);
      if (!clientCommandId || !message) {
        throw new HttpError(400, 'missing_fields', '需要 clientCommandId、message');
      }
      const caps = gateway.capabilities();
      if (!caps.supportsSteer && !caps.supportsQueue) {
        // PRD §6.2：不支持时不允许伪造“已生效”
        throw new HttpError(501, 'append_unsupported', '当前后端不支持追加消息，仅可保存草稿');
      }
      const r = await gateway.appendMessage(clientCommandId, device.id, params.id!, message, expectedRevision);
      json(raw.res, 202, { commandId: r.commandId, status: 'accepted', queued: caps.supportsQueue && !caps.supportsSteer });
    },
  });

  // -- 取消（任务与 Run 两个入口） ------------------------------------------------

  routes.push({
    method: 'POST',
    pattern: '/v1/tasks/:id/cancel',
    handler: async ({ raw, params, query }) => {
      const device = auth(raw.req, query);
      const body = await readJsonBody(raw);
      const clientCommandId = String(body.clientCommandId ?? '');
      if (!clientCommandId) throw new HttpError(400, 'missing_fields', '需要 clientCommandId');
      const r = await gateway.cancel(clientCommandId, device.id, params.id!);
      json(raw.res, 202, { commandId: r.commandId, accepted: r.accepted, status: 'cancel_requested' });
    },
  });

  routes.push({
    method: 'POST',
    pattern: '/v1/runs/:id/cancel',
    handler: async ({ raw, params, query }) => {
      const device = auth(raw.req, query);
      const body = await readJsonBody(raw);
      const clientCommandId = String(body.clientCommandId ?? '');
      if (!clientCommandId) throw new HttpError(400, 'missing_fields', '需要 clientCommandId');
      const taskId = findTaskByRun(gateway, params.id!);
      const r = await gateway.cancel(clientCommandId, device.id, taskId);
      json(raw.res, 202, { commandId: r.commandId, taskId, accepted: r.accepted, status: 'cancel_requested' });
    },
  });

  // -- 审批 ---------------------------------------------------------------------

  routes.push({
    method: 'POST',
    pattern: '/v1/approvals/:id/resolve',
    handler: async ({ raw, params, query }) => {
      const device = auth(raw.req, query);
      const body = await readJsonBody(raw);
      const clientCommandId = String(body.clientCommandId ?? '');
      const decision = String(body.decision ?? '');
      if (!clientCommandId || (decision !== 'approve' && decision !== 'deny')) {
        throw new HttpError(400, 'missing_fields', '需要 clientCommandId 与 decision(approve|deny)');
      }
      const r = await gateway.resolveApproval(clientCommandId, device.id, params.id!, decision);
      json(raw.res, 200, {
        commandId: r.commandId,
        approval: { nativeRequestId: r.approval.nativeRequestId, state: r.approval.state, decision: r.approval.decision },
      });
    },
  });

  // -- 命令查询（提交超时场景，PRD §7.2） -----------------------------------------

  routes.push({
    method: 'GET',
    pattern: '/v1/commands/:id',
    handler: async ({ raw, params, query }) => {
      auth(raw.req, query);
      const cmd = gateway.ledger.get(params.id!);
      if (!cmd) throw new HttpError(404, 'not_found', '命令不存在');
      json(raw.res, 200, {
        commandId: cmd.clientCommandId,
        kind: cmd.kind,
        status: cmd.status,
        pendingVerify: cmd.pendingVerify,
        taskId: cmd.taskId,
        nativeTaskId: cmd.nativeTaskId,
        nativeRunId: cmd.nativeRunId,
        nativeMessageId: cmd.nativeMessageId,
        errorCode: cmd.errorCode,
        updatedAt: cmd.updatedAt,
      });
    },
  });

  // -- 事件流（SSE；鉴权 + 游标补发，PRD §7.3） ------------------------------------

  routes.push({
    method: 'GET',
    pattern: '/v1/events',
    handler: async ({ raw, query }) => {
      const device = auth(raw.req, query); // 流连接必须鉴权
      const lastEventId = raw.req.headers['last-event-id'];
      const after =
        Number.parseInt(query.get('after') ?? (typeof lastEventId === 'string' ? lastEventId : '0'), 10) || 0;
      const res = raw.res;
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(`retry: 2000\n\n`);
      const replay = gateway.bus.replayAfter(after);
      if (!replay.continuous) {
        // 游标超出保留窗口：要求客户端取快照重建（PRD §7.3）
        res.write(`event: resync\ndata: {"reason":"cursor_out_of_window","latestSeq":${replay.latestSeq}}\n\n`);
      } else {
        for (const e of replay.events) writeEvent(res, e);
        res.write(`event: synced\ndata: {"latestSeq":${gateway.bus.latestSeq()}}\n\n`);
      }
      let closed = false;
      const busUnsub = gateway.bus.subscribe((e) => {
        if (closed) return;
        writeEvent(res, e);
      });
      const unregister = gateway.registerConnection(device.id, () => res.end());
      const heartbeat = setInterval(() => {
        if (!closed) res.write(`: ping ${Date.now()}\n\n`);
      }, 15000);
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        busUnsub();
        unregister();
        res.end();
      };
      raw.req.on('close', close);
      res.on('close', close);
    },
  });

  // -- 产物 ---------------------------------------------------------------------

  routes.push({
    method: 'GET',
    pattern: '/v1/tasks/:id/artifacts',
    handler: async ({ raw, params, query }) => {
      auth(raw.req, query);
      const rows = gateway.listArtifacts(params.id!);
      json(raw.res, 200, { artifacts: rows });
    },
  });

  routes.push({
    method: 'GET',
    pattern: '/v1/artifacts/:id',
    handler: async ({ raw, params, query }) => {
      auth(raw.req, query);
      const a = gateway.readArtifact(params.id!); // 内部做 realpath 逃逸检查
      res_json_file(raw.res, a.absPath, a.mime);
    },
  });

  // -- 设备管理（本地管理令牌，PRD MAC-03） ----------------------------------------

  routes.push({
    method: 'GET',
    pattern: '/v1/devices',
    handler: async ({ raw, query }) => {
      requireAdmin(gateway, query);
      json(raw.res, 200, { devices: gateway.auth.listDevices() });
    },
  });

  routes.push({
    method: 'POST',
    pattern: '/v1/devices/:id/revoke',
    handler: async ({ raw, params, query }) => {
      requireAdmin(gateway, query);
      const ok = gateway.revokeDevice(params.id!);
      json(raw.res, ok ? 200 : 404, { revoked: ok });
    },
  });

  return routes;
}

function requireAdmin(gateway: Gateway, query: URLSearchParams): void {
  const token = query.get('admin') ?? '';
  const expected = gateway.adminToken();
  if (!expected || token !== expected) {
    throw new AuthError(403, 'admin_required', '需要本地管理令牌');
  }
}

function findTaskByRun(gateway: Gateway, runId: string): string {
  const taskId = gateway.taskIdByRun(runId);
  if (!taskId) throw new NotFoundError(`run ${runId} not found`);
  return taskId;
}

function writeEvent(res: http.ServerResponse, e: { eventId: string; streamSeq: number; kind: string; taskId: string; runId?: string; occurredAt: string; payload: unknown }): void {
  res.write(`id: ${e.streamSeq}\nevent: gateway\ndata: ${JSON.stringify(e)}\n\n`);
}

function res_json_file(res: http.ServerResponse, absPath: string, mime: string): void {
  const content = fs.readFileSync(absPath);
  res.writeHead(200, { 'content-type': mime, 'content-length': content.length });
  res.end(content);
}

/** 统一错误映射（PRD §11 末段：明确区分各错误类） */
export function mapError(e: unknown): { status: number; code: string; message: string } {
  if (e instanceof AuthError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof LedgerConflictError) return { status: 409, code: 'command_conflict', message: e.detail };
  if (e instanceof ApprovalConflictError)
    return { status: 409, code: `approval_${e.reason}`, message: e.message };
  if (e instanceof HttpError) return { status: e.status, code: e.code, message: e.message };
  if (e instanceof IncompatibleError) return { status: 409, code: 'incompatible', message: e.message };
  if (e instanceof UnsupportedError) return { status: 501, code: 'unsupported', message: e.message };
  if (e instanceof AdapterError && e.code === 'RESULT_PENDING') {
    return { status: 202, code: 'result_pending', message: e.message };
  }
  if (e instanceof ConflictError) return { status: 409, code: 'revision_conflict', message: e.message };
  if (e instanceof NotFoundError) return { status: 404, code: 'not_found', message: e.message };
  if (e instanceof AdapterError) {
    if (e.code === 'ENGINE_OFFLINE') return { status: 503, code: 'engine_offline', message: e.message };
    return { status: 500, code: 'engine_error', message: e.message };
  }
  return { status: 500, code: 'internal', message: '内部错误' };
}
