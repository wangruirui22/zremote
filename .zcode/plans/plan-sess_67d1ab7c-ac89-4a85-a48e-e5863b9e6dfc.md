# ZCode Remote：可实施性确认 + WSL 模拟开发测试

## Context（背景与结论）

PRD 的核心风险在 §1.2：接入方式未验证。本次调研已把其中多项在 WSL 内落实：

- **本机已装 ZCode 3.17.2**（`~/.zcode/server/releases/3.17.2-linux-x64-88a41b337faa/runtime/zcode.cjs`）
- **`app-server` 子命令存在**：stdio JSON-RPC 协议（正是桌面版的内部协议），方法含 `session/create|resume|send|list|messages|events|subscribe|stop|fork` 等——PRD 需要的建任务/续聊/订阅/停止均有对应
- **无头模式确认**：`-p --output-format stream-json`（NDJSON 事件流）+ `--resume <sess_...>`/`-c` 跨进程恢复；会话持久化于 `~/.zcode/cli/db/db.sqlite`（SQLite WAL）
- **事件目录确认**：~90 种事件（`assistant_message`、`tool_call_*`、`permission_requested/resolved`、`turn_*`、`cancel` 等），覆盖流式消息/工具卡/审批/停止
- **PRD 需修正一处**：README 的 `zcode --web` 在当前 CLI 构建中不存在（属 desktop/server 分发包能力），印证 PRD "不能凭 Web 入口推断共享会话" 的判断

**结论：有条件可行成立，且 WSL 模拟可高保真**——网关 Adapter 直接对真实 app-server 协议开发。WSL 无法替代的仅剩：Mac 桌面窗口集成路径、Tailscale HTTPS、菜单栏/睡眠策略、Android 真机后台行为（记入文档，留待 Mac P0）。

按你的选择：**双后端（真实 + mock）**、**暂缓 Android（Web 客户端模拟手机端）**。

## 交付物与目录结构

```
/mnt/d/linux/zremote/
├── docs/
│   ├── feasibility-wsl-sim.md   # 可实施性结论：WSL 已验证/待 Mac 复验清单、PRD 修正项
│   ├── adapter-contract.md      # IZcodeAdapter 契约 + app-server 实测方法对照表（Mac P0 依据）
│   └── at-results.md            # AT-01～AT-15 模拟结果记录
├── packages/
│   ├── gateway/                 # TypeScript + Node 22，运行时零第三方依赖
│   │   ├── src/
│   │   │   ├── http.ts          # node:http 路由，仅绑 127.0.0.1
│   │   │   ├── api/             # /v1/* 按 PRD §11 全部端点
│   │   │   ├── auth/            # 一次性配对码(5min/限速)、设备 token、撤销
│   │   │   ├── ledger/          # node:sqlite 命令账本：先记账后调用、幂等、"结果待核对"
│   │   │   ├── events/          # streamSeq 单调序号 + 有界缓存 + SSE after=cursor 补发
│   │   │   ├── state/           # PRD §6.1 运行状态机 + 原生状态映射
│   │   │   ├── redact.ts        # 密钥/授权头脱敏
│   │   │   └── adapter/
│   │   │       ├── types.ts     # IZcodeAdapter 契约（能力声明 + 版本自检）
│   │   │       ├── real/        # 真实 app-server 适配器（spawn stdio 子进程）
│   │   │       └── mock/        # 脚本化 mock（可编排：审批/失败/崩溃/断流）
│   │   └── test/                # node:test 单测 + 集成
│   ├── web-client/              # 静态 SPA：配对/主机/项目/任务/会话/结果/审批页
│   └── e2e/                     # AT 场景自动化（参数化：mock 与 real 双跑）
├── scripts/
│   ├── sandbox-init.sh          # 建 ~/zremote-sandbox/demo-app 测试工作区
│   └── run-at-suite.sh
```

运行时状态放 `~/.local/state/zremote/`（ext4，避开 /mnt/d 的 DrvFS 性能问题）；真实后端的测试会话统一 `--cwd ~/zremote-sandbox`，与你现有会话隔离，不动当前运行中的 ZCode 进程。

## 关键实现点

1. **Adapter 契约**（`adapter/types.ts`）：`listProjects/createTask/sendMessage/subscribeEvents/resolveApproval/cancelRun/snapshot/healthCheck`，双后端同接口；real 适配器对 `app-server` 做 spawn + JSON-RPC 帧 + 事件翻译到统一 Event 模型。实现时实测确认审批的确切 RPC 方法名与 `permission_requested` 事件配对（调研未钉死，这正对应 PRD P0 实验第 4 条），结果写入 adapter-contract.md
2. **命令账本**：sqlite WAL、`clientCommandId` 唯一约束；先持久化再调 Adapter；同 ID 同 payloadHash 重试返回原状态，同 ID 不同内容拒绝；注入"已调用未记账"崩溃点 → "结果待核对"不自动重发（AT-07/AT-08）
3. **事件恢复**：网关统一 streamSeq，SSE `?after=` 补发，游标超出窗口取快照（AT-06）；mock 可编排断流
4. **审批**：绑定 nativeRequestId+版本+有效期，单次消费，双端处理后另一端失效（AT-05）
5. **安全**：仅 loopback、token 哈希存储、artifact 路径规范化+符号链接逃逸检查、审计与脱敏（AT-12）
6. **Web 客户端**：走与未来 Android 完全相同的 `/v1` API，可手动走通 PRD §15 验收语句场景（配对→选项目→续聊/新建→审批→看结果→断线重连）

## 验证步骤（全部跑通后交付）

1. `npm run test`：单测（状态机、幂等、脱敏、路径防护）
2. mock 后端 e2e：AT-03～AT-09、AT-12～AT-14 自动化通过
3. real 后端集成（少量短 prompt，消耗少量额度）：建任务→流式事件→终端 `zcode --resume <sess>` 续聊同一会话→网关重启后恢复→取消→真实审批流（AT-01/AT-02 的 WSL 版）
4. Web 客户端人工走查核心闭环
5. `docs/at-results.md` 记录：模拟通过项 / 待 Mac 复验项逐条对照

## 边界（本轮不做）

Android 工程/APK、Tailscale 实链路（用 loopback + 文档说明替代）、macOS 菜单栏/睡眠、Mac 桌面窗口集成验证——均记入 feasibility-wsl-sim.md 待办。