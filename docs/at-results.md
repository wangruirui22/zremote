# AT-01～AT-15 模拟结果记录（PRD §12.1）

日期：2026-11-07 · 环境：WSL2 · 网关 + Web 客户端 + 双后端（mock 确定性 / real ZCode 3.17.2）

| 编号 | 场景 | 结果 | 说明 |
| --- | --- | --- | --- |
| AT-01 | Mac 新建并开始任务，手机打开 | ✅ WSL 版 | R-03：网关建任务（原生 sess_…），Web 快照/消息一致 |
| AT-02 | 手机追加需求 | ✅ WSL 版 | R-04/R-05：网关追加进入同一原生会话；独立 CLI `--resume` 续聊同会话，双向可见 |
| AT-03 | 手机新建任务 | ✅ | e2e：任务出现在项目列表，第二设备（Mac 侧）可继续 |
| AT-04 | Mac 本地追加消息 | ✅ | SSE 实时收到；过期 revision 写入 409（串行/冲突明确） |
| AT-05 | 同一审批在两端处理 | ✅ | 双端并发 resolve：一端 200、另一端 409；单次消费 |
| AT-06 | 手机断网 5 分钟后恢复 | ✅ | 游标补发离线事件；窗口外 resync；事件按 eventId 去重、streamSeq 检漏 |
| AT-07 | 下发成功但响应丢失 | ✅ | RESULT_PENDING → pending_verify；同 ID 重试不重复创建；查询命令状态可见 |
| AT-08 | 网关在下发前后分别崩溃 | ✅ | 重启后账本持久化、同 ID 返回原任务、无自动重复执行（real 版 R-06 同样通过） |
| AT-09 | 停止长任务 | ✅ | cancel 受理（cancel_requested）→ 引擎确认终态；已有变更保留展示 |
| AT-10 | Mac 休眠、ZCode 退出、模型错误 | ✅ 模拟 | 引擎离线：health 失败、缓存可见、创建任务 503（不把断线改写为任务失败）；模型错误归 run_failed 事件 |
| AT-11 | Android 息屏并被系统回收 | ⚠️ Web 模拟 | 断连期间事件累积、重连后全量补齐；Android 真机行为待 M2 |
| AT-12 | 未授权目录、路径穿越、撤销设备 | ✅ | 不可接入项目拒绝；静态服务穿越 403/404；产物 realpath 逃逸拒绝；撤销后 401 + 现有连接断开 |
| AT-13 | 完成含代码修改与测试的任务 | ✅ | 多任务并行事件/消息按 Run/Task 归属，无串线（真实后端 R-03/04 消息归属同会话） |
| AT-14 | 重启与版本不兼容 | ✅ | 重启可恢复（R-06）；compatible=false 时写操作 409 incompatible |
| AT-15 | 检查远控链路 | ⏳ 待 Mac | 自建控制流按 PRD §9 仅 loopback 监听，跨机走 Tailscale Serve（未在本环境实测）；无隐性外部转发（app-server 全本地 stdio；模型调用目的地记录见 adapter-contract.md） |

## 汇总

- mock 套件：14/14 通过（`packages/e2e/test/mock/at-suite.test.ts`）
- real 集成：7/7 通过（`packages/e2e/test/real/real-integration.test.ts`，2 次超短真实 prompt）
- 单元测试：17/17（幂等账本、脱敏、事件去重/补发/裁剪、审批单次消费、路径防护、设备撤销）
- 指标口径（PRD §12）：AT-07/08 覆盖崩溃不确定性；性能指标（P95 ≤2s 等）未压测——个人使用规模下无阻塞证据，P1 交付前在 Mac + Tailscale 环境补测。

## 待 Mac 复验后才能关闭的项

AT-01/02 的桌面窗口版本（桌面与网关共存）、AT-11 Android 真机、AT-15 Tailscale 实链路与官方远控路径核对。
