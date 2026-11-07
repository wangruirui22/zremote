# Adapter 契约与 app-server 实测协议对照表

日期：2026-11-07 · 实测对象：ZCode 3.17.2-linux-x64-88a41b337faa（`zcode.cjs app-server`）

## 1. 网关侧统一契约（`packages/gateway/src/adapter/types.ts`）

所有后端（mock / real）实现 `IZcodeAdapter`：

| 方法 | 语义 | PRD 对应 |
| --- | --- | --- |
| `healthCheck()` | 引擎可达性 | §10.2 可用性诊断 |
| `listProjects()` | 已登记工作区（不可接入须给原因） | §5.4 |
| `listTasks(projectId?)` | 任务清单（含原生状态映射） | §11 |
| `createTask(req)` | 建会话 + 首条消息 | §11 POST tasks |
| `sendMessage(taskId, msg, opts)` | 追加（steer/排队语义由能力声明） | §6.2 |
| `subscribe(handler)` | 统一 AdapterEvent 流 | §7.3 |
| `resolveApproval(id, decision)` | 单项审批（单次消费） | §6.2 |
| `cancel(taskId)` | 停止请求（受理 ≠ 终态） | §6.1 |
| `snapshot(taskId)` | 快照（task+messages+pendingApprovals） | §11 GET task |

错误分类：`ENGINE_OFFLINE / NOT_FOUND / CONFLICT / UNSUPPORTED / RESULT_PENDING / INCOMPATIBLE` → HTTP 503/404/409/501/202/409。
状态映射：原生 `idle→waiting_input`、`running→running`、未知→`unknown`（保留 nativeRaw，PRD §6.1）。

## 2. app-server 协议（实测）

### 2.1 帧格式

- NDJSON over stdio。客户端请求：`{"id": <number>, "method": "...", "params": {...}}`（**无 jsonrpc 字段**，发送会被 -32600 拒绝）。
- 应答：`{"id": N, "result": {...}}` 或 `{"id": N, "error": {"code": -32xxx, "message": "...", "data": {Zod issues}}}`。
- **双向协议**：服务端会向客户端发请求（`id` 为字符串如 `"server-1"`），客户端必须应答 `{"id": "server-1", "result": {...}}`，否则服务端挂起等待。
  - `session/requestRuntimePreferences` → 需 `{"nativeSearchEnhancementsEnabled": <boolean>}`；
  - `interaction/requestOfficialMcpAuthHeaders` → 空对象 `{}` 可容忍；
  - **审批类请求（方法名含 permission/approval/confirm/userinput）不得自动应答**——须登记后由网关 `resolveApproval` 回写决定（适配器已按此实现，防止静默放行）。
- 无 initialize 握手；连接即可调用。

### 2.2 方法对照（✅=本机实测通过）

| 网关动作 | app-server 方法 | 参数 | 实测 |
| --- | --- | --- | --- |
| 项目发现 | `session/list` | `{}` | ✅ 返回 sessions[].workspace{workspaceKey, workspacePath} |
| 任务发现 | 同上 | | ✅ session ≙ Task（status: idle/running/…） |
| 建任务 | `session/create` | `{workspace:{workspaceKey, workspacePath}}` | ✅ 应答含 projection{status,mode,pendingPermissions}；sessionId 经 `session/lifecycle/changed`(state=starting) 通知 |
| 追加消息 | `session/send` | `{sessionId, content}`（**content 非 message**） | ✅ 立即受理 `{accepted:true, stateRevision}`；运行中重复发送 → `-32010`（映射 409） |
| 快照 | `session/read` | `{sessionId}` | ✅ messages[].info+parts[].text；projection.pendingPermissions |
| 历史 | `session/messages` | `{sessionId}` | ✅ |
| 事件订阅 | `session/subscribe` | `{sessionId, deliveryKind:"web-remote-replayable"}` | ✅（该 deliveryKind 即官方手机远控模式） |
| 事件回读 | `session/events` | `{sessionId}` | ✅ |
| 停止 | `session/stop` | `{sessionId}` | ✅ 受理后引擎确认终态 |
| 恢复 | `session/resume` / CLI `--resume <sess_>` | `{sessionId}` | ✅ 跨进程同会话（R-05） |
| 跨进程读 | `session/usage` / `session/subagents` | `{sessionId}` | ✅ 未激活也可读 |
| 未激活读 | `session/read|messages|events`（其他进程的会话） | | `-32004 Session is not active`（先 create/resume/subscribe 激活） |

### 2.3 事件通知（经 `session/subscribe` 后到达）

| 通知 | 结构 | 网关映射 |
| --- | --- | --- |
| `session/event` | `{deliveryKind, eventId, payload, seq, sessionId}` | 统一 AdapterEvent：`nativeEventId=eventInfo.eventId`（去重键） |
| ├─ payload `{kind:"text_delta", delta, assistantMessageId, done}` | 流式增量 | `assistant_delta` |
| ├─ payload `{input, messageId, turnNumber, queryId}` | 用户输入 | `user_message` |
| ├─ payload `{response, resultType, tokenCount, duration, toolCallCount}` | 本轮结果 | resultType=success→`run_succeeded`；其他→`run_failed`/`run_unknown_state` |
| ├─ payload `{toolName/tool...}` | 工具调用 | `tool_started`/`tool_result` |
| └─ 其余（model/provider 元信息等） | | `native_event` 透传（不伪造语义） |
| `state.updated` | `{patch:{status}, reason, revision, sessionId}` | reason=prompt_started→`turn_started`；prompt_completed→`turn_complete` |
| `session/lifecycle/changed` | `{sessionId, state: starting/ready/stopping/unloaded, lastError}` | lastError→`engine_error`；starting 用于捕获新会话 ID |

### 2.4 已知缺口（Mac P0 补验）

- 权限审批的确切服务端请求方法名与应答 schema（机制已验证：服务端请求→客户端应答；适配器按方法名模式匹配捕获，`AT` 真机验证时确认后固化）。
- 运行中插话（steer）语义：`-32010` 表明运行中 send 被拒——当前按"排队不支持、冲突明确报错"处理；`session/queueMessage` 类方法待探测。
- 桌面 App 的 app-server 复用/共存方式（WSL 无桌面端）。

## 3. Mock 后端（确定性测试）

`packages/gateway/src/adapter/mock/mock-adapter.ts`：脚本化任务流（assistant/tool/approval/succeed/fail）+ 故障注入（断流丢事件、重复事件、RESULT_PENDING、引擎离线、未知状态、版本不兼容）+ 审批注入钩子。AT 套件全部基于它做确定性验收。
