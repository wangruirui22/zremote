# ZCode Remote — 可实施性结论与 WSL 模拟验证记录

日期：2026-11-07 · 环境：WSL2 Ubuntu 22.04 · ZCode 3.17.2-linux-x64-88a41b337faa

## 1. 结论

**PRD §1 的"有条件可行"判断成立，且关键不确定项已在 WSL 内实测收敛。**
PRD 最大的风险（§1.2："独立 Web/CLI 与桌面版是否共享任务存储、是否可安全恢复同一会话"）在 WSL 得到直接验证：

> **独立进程通过 `zcode app-server`（stdio JSON 协议）可以创建、续聊、订阅、停止与桌面同一存储的原生会话；独立 CLI 进程可用 `--resume <sessionId>` 续接网关创建的同一会话（R-05）。**

据此，路线 B（伴随网关接入桌面任务服务）在 Linux 侧成立。Mac 侧剩余验证项见 §4。

## 2. WSL 内已验证项（对应 PRD §13.1 P0 实验清单）

| P0 条目 | 状态 | 证据 |
| --- | --- | --- |
| 1. 记录版本/构建，准备测试项目 | ✅ | ZCode 3.17.2-linux-x64-88a41b337faa；沙箱 `~/zremote-sandbox/demo-app`（`scripts/sandbox-init.sh`） |
| 4. 建立项目/任务/会话/Run 的 ID 对照 | ✅ | 见 `adapter-contract.md`：workspaceKey/Path ↔ Project、sessionId ↔ Task/Session、turn ↔ Run |
| 5. Mac 建任务 → 手机续聊 → Mac 继续 → 手机查看结果闭环 | ✅(WSL 版) | R-03/R-04/R-05：网关建会话 → 网关续聊 → 独立 CLI `--resume` 续聊 → 网关快照可见 |
| 6. 断线、重启、重复提交、审批冲突测试 | ✅(mock) | AT-06/AT-07/AT-08/AT-05 通过（mock 引擎确定性注入） |
| 2/3. 官方 Remote Control 与 Tailscale 链路 | ⏳ 待 Mac | 需真机验证官方远控路径；自建链路已按 PRD §9 实现为 loopback + 预留 Tailscale Serve |
| 7. 自有构建验证 | 不需要 | 协议原生可用，未改任何 ZCode 源码 |

自动化测试：单测 17/17、AT 套件（mock）14/14、real 集成 7/7（含 2 次超短真实 prompt）。

## 3. 关键技术事实（实测）

- `zcode.cjs app-server` 是桌面宿主的内部协议子进程，独立可用（无 initialize 握手）。
- 帧格式 `{id, method, params}` → `{id, result}` / `{id, error}`；服务端会向客户端发请求（必须应答）。
- `session/send` 字段为 `content`；`session/subscribe` 需 `deliveryKind: "web-remote-replayable"`——正是官方"手机远控"使用的交付模式。
- 事件：`session/event`（含 eventId/seq/payload）+ `state.updated`（reason=prompt_started/prompt_completed）。
- 会话库 `~/.zcode/cli/db/db.sqlite`（SQLite WAL）；`zcode --resume <sess_...> --cwd <dir>` 跨进程恢复。
- **PRD 修正一处**：README 所述 `zcode --web` 在当前 CLI 构建（3.17.2）中不存在，属 desktop/server 分发包能力——印证 PRD"不能凭 Web 入口推断共享会话"的谨慎判断；自建网关因此走 `app-server` 协议。

## 4. 待 Mac 真机复验清单（WSL 无法覆盖）

1. **桌面窗口集成**：Mac 桌面 App 是否暴露/接受 app-server 桥接（或桌面即另一 app-server 消费者），桌面本地操作与网关写操作的控制权互斥（PRD §4.3）。WSL 无桌面端，只验证了 CLI 进程间一致性。
2. **Tailscale 链路**：Serve 配置、HTTPS、tailnet ACL；官方 Remote Control 是否依赖外部转发（AT-15）。
3. **macOS 伴随服务形态**：菜单栏壳、登录自启动、防睡眠（MAC-05）——本仓库网关可直接以 launchd 用户级服务运行。
4. **官方安装版与开源 3.17.2 的协议一致性**：Mac 上跑 `npm run probe`（本仓库 `packages/gateway/src/adapter/real/probe.ts`）核对方法覆盖。
5. **审批端到端**：协议的审批经由服务端 interaction 请求应答（机制已实测），真实权限审批的方法名与参数需在 guarded 模式下实测确认（adapter 已按模式匹配实现）。
6. Android 真机：息屏/后台回收（AT-11 为 Web 模拟）。

## 5. 运行方式

```bash
scripts/sandbox-init.sh          # 建沙箱
npm run gateway                  # 启动网关（默认 mock 后端，127.0.0.1:7801）
ZREMOTE_BACKEND=real npm run gateway   # 真实 ZCode app-server 后端
node packages/gateway/src/index.ts pair    # 生成本地一次性配对码
node packages/gateway/src/index.ts devices # 已配对设备（revoke <id> 撤销）
# 浏览器打开 http://127.0.0.1:7801/ 走完整闭环
scripts/run-at-suite.sh          # 单测 + AT 套件
node --test packages/e2e/test/real/*.test.ts   # real 集成（需 ZCode，消耗少量额度）
```

环境变量见 `packages/gateway/src/config.ts`（端口、状态目录、事件保留期、配对码 TTL、每项目写并发等均可调）。

## 6. 本轮边界

Android APK、Tailscale 实链路、macOS 菜单栏/睡眠策略、Mac 桌面窗口集成未实现（见 §4）；P2 三端复用同一网关与 `/v1` API（Web 客户端即其原型）。
