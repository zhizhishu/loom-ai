# LOOM 交接书（唯一现行版）

> **下一位施工者从这里开始。** 读法：本页 → [LOOM-ARCHITECTURE.md](LOOM-ARCHITECTURE.md)（尤其 §3 复用总表）→ 根 `TASK.md` → `PROJECT_CONTEXT.md` → [参考锁](LOOM-V2-REFERENCE-LOCK.md) → [LOOM-IMPLEMENTATION.md](../../LOOM-IMPLEMENTATION.md)（进度唯一真源）→ 验收看 [LOOM-ACCEPTANCE.md](LOOM-ACCEPTANCE.md)。
>
> 本页取代 `mindkit-handoff-2026-11-13.md`、`mindkit-handoff-2026-11-18.md`、`MASTER-HANDOFF-2026-10-28.md` 及各阶段交接（已归档到 [archive/plans-2026-11-18](archive/plans-2026-11-18/README.md)），其中已验证的事实不作废。

## 1. 用户的话（不要再理解偏）

- “Mikka 和 PiBot 为主，其它是参考。”
- “UI 就是我们现在这个，很满意了。”
- “Pi 和 Pi Purge 是内置的，可以理解为主助手，也可以操控 B，四个端口。”
- “之前老是说开源，不舍得用。”参考快照许可已统一为 MIT，**许可不确定不再是自己写的理由**。

## 2. 复用硬规则（每个施工 Agent 的 READ FIRST）

1. **先找上游，再动手。** 任何新模块、新函数文件、新协议字段之前，先查 [架构](LOOM-ARCHITECTURE.md) §3 对应行。主体来源（Mikka / PiBot）有现成实现的，**直接复制/移植/运行**，不是“参考思路”。
2. **上游对照表是交付物的一部分。** 每份报告写：参考项目 + 40 位 SHA + 上游文件路径 + 复用方式（直接依赖 / 复制改写 / 原样运行）+ 若不能直接用，具体不兼容点（某个 API、某张表、某个平台）。给不出对照表就不许写新代码。
3. **只写最薄适配层。** 允许写的只有架构 §3 “LOOM 只写”一列。单次新增超过 300 行，必须说明为什么不是适配层。
4. **抄写上游再模拟 = 造轮子。** 要么导入/运行上游，要么写明不兼容点。读完上游后自己“重新实现一个简化版”同样算造轮子。
5. **复制代码的规矩**（沿用 PiBot `docs/reuse-first-development-plan.md` §9）：成熟库作依赖，不复制库源码；独立小模块才 vendor，放进明确的 `third-party/` 或 `adapted/` 目录，记录原路径、SHA、改动，更新 `THIRD_PARTY_NOTICES.md`；从原仓库/发布包取代码，不从网页文本粘贴。
6. **数据只进一个 Core。** 移植 Mikka/PiBot 逻辑时，存储落到 Rust Core + SQLite；不另跑 Postgres、不另起 PiBot Center、不建第二套调度。
7. **依赖版本跟随用户实际安装版本**（DSH `0.2.0-rc.2`、固定 Pi 版本），仓内不另锁旧版。注意系统 PATH 上的 `dsh --version` 仍报 `0.1.5-rc.2`，不要误判。
8. **既有纪律不变**：只认原始回执；失败记录不改写；不碰 64851 / 64852、日常 userData 和正式数据；DE-BERO 根盘余量很小，不投大编译；不 `reset`、不清理用户 WIP；未经用户同意不推送远端。
9. 阶段结果只更新根 `TASK.md` / `LOG.md` / `LOOM-IMPLEMENTATION.md`，**不再新建计划书或交接书**；需要改计划就改本页三件套。

## 3. 当前状态（2026-11-18 晚，细节以 LOOM-IMPLEMENTATION 为准）

**有原始回执的**（路径相对 `_artifacts/delivery-20261118/`）
- 装机：`L1-install/local-personal-186-install-proof.json`、`L6-build/local-personal-186-install-proof-l6.json` PASS（启动、HTTP、登录、schema 186 / migration 236）。
- DSH：`L3-dsh/summary.json` Skill + Hook 调用 + Hook 拒绝三格 PASS。
- Pi Purge：`L2-purge/pi-purge-ui-07-r13/report.json` PASS（`exactCopyMet` 如实为 false）。
- Pi Skill + Rule：`L11-pi-caps/summary.json` 正反两 Run PASS。
- 电脑控制：`L5-computer/run-07/run.json` 模型自主截图识码，`synthetic_frame=true`。
- 能力矩阵：`L9` 16 格真实表，7 格正向回执。

**未完成**：写入早于认领（r9 实证 claim 晚 6.031 秒）；E6-B 恢复对账缺故障注入；记忆只按 Bot 不按 Workspace；Claude Win11 准入口径冲突；Codex MCP 外部 relay 卡点；Owner 接受 = 0。

**Git**：分支 `rovai/loom-v2-personal-20261116`，本地提交未推送。

## 4. 造轮子清单（按“主体 Mikka + PiBot”重新定性）

| # | LOOM 现状 | 应对标的上游 | 处理 |
|---|---|---|---|
| 1 | 文件守卫 `scripts/loom-v2-runtime-file-guard.ts` 只认 grant 不认 claim | Mikka `lib/factory/claim.ts`、`lib/computer/worker-lease.ts`；ACCP fencing token 规则 | P0 修 |
| 2 | 私有 Hook 执行器 `local_hook.rs` + `dsh/local-hooks.mjs` + `resources/dsh-hook-executor`（锁 0.1.5-rc.2） | DSH 原生 pre/post-execute 与 hooks 包 | P1 回归原生 |
| 3 | 群聊路由/唤醒/派工在 `loom-protocol/src/v2_coordinator*.rs` 自写 | Mikka `lib/coordinator/group-routing.ts`、`wake-after-commit.ts`、`lib/factory/automatic-dispatch.ts` | P2 逐函数对照，缺的照搬 |
| 4 | 能力“勾选/加载/生效”没有 PiBot 那样的四态与双指纹 | PiBot `host-core/plugins/manager.js`、`turn-sync.js`、`capabilities/*.js` | P3 对齐 |
| 5 | 记忆 `memory*.rs` 只按 Bot 隔离 | PiBot Hindsight 插件 + `bot-learning.js`；Mikka `lib/profile/*` | P4 |
| 6 | Pi Purge 桥 `scripts/loom-pi-purge-bridge.mjs` 抄写上游后模拟 | 上游 `extensions/pi-purge.ts`（真 Run 已由 `pi/host.rs` 加载） | P5 删模拟层 |
| 7 | Pi 接 MCP 的 `loom-node/src/builtin_bridge.rs`、`mcp_environment.rs` | Pi 原生 MCP / `pi-mcp`；`_references/pi-mcp-adapter` | P5 对照，重叠就换 |
| 8 | 电脑控制 `resources/computer/host_desktop.py` | PiBot `shower-*.js`、`cua-*.js`；Mikka `lib/computer/store.ts`（接管租约） | P6 |

**更正上一版交接**：`crates/loom-node` 不是要替换的轮子。原计划已写明“不得重做已实现基础”（配对、主动连接、代次、心跳、Workspace/Computer RPC），它对标的是 PiBot Host / Mikka daemon，只按它们补缺；DeskFleet / MindFS 降为参考零件。协作调度的主体是 Mikka，ACCP 只提供防抢不变量。

## 5. 施工顺序

### P0 先领后写
1. Core 在 claim 事务里原子生成 Run + 快照 + 租约，并发放单调递增的 fence（对照 Mikka `claim.ts` / `worker-lease.ts` 的租约写法与 ACCP 不变量）。
2. 写授权只在 claim 成功后由 Core 签发并携带 fence；guard 对每次写入（含首次新建）校验，缺失或过期即拒绝。
3. heartbeat / report / artifact 全部校验 fence；过期租约不能被旧心跳复活。
4. 负例测试：未 claim 写入被拒；旧 fence 写入被拒；依赖未满足时 claim 不产生 Run。
- 验收：r9 场景重跑 10 次，“写入早于 claim” = 0；回执进 `_artifacts/delivery-20261118/L12-*`。

### P1 Hook 回归 DSH 原生
LOOM 只负责：选择并冻结进 Run → 写入 DSH Profile → 读 `hook/invoked` / `hook/result` 作回执。依赖对齐 `0.2.0-rc.2`，退役私有执行器；L3 判据保留为回归。

### P2 群聊与 Coordinator 对齐 Mikka
逐个对照 `group-routing.ts`、`group-turns.ts`、`wake-after-commit.ts`、`wake-recovery.ts`、`automatic-dispatch.ts` 与现有 `v2_coordinator*.rs`：已等价的保留并在注释写上游出处；缺的直接移植（TS → Rust 只改语言不改算法）。验收用 T19/T20。

### P3 每 Bot 能力对齐 PiBot
照 `plugins/manager.js` 的内容指纹 / 授权指纹分离、`turn-sync.js` 的 prepare/confirm/restore，把“已保存 / 设备已准备 / 本 Run 已生效 / 失败原因”四态接到现有 `member_capability.rs` 与 UI。验收用 T22。

### P4 记忆
契约：记忆归 Workspace，账号级只放画像（Mikka glossary）。实现：记忆是按 Bot 启用的插件（PiBot Hindsight），Core 不硬编码记忆服务。验收：同一 Core、同一 Bot，W1 写随机标记，W2 自主 `memory.search` 命中 0。

### P5 清理重复实现
删 Pi Purge 模拟层，回执只认真 Run；对照 Pi 原生 MCP，重叠就替换自建桥。

### P6 电脑能力补缺
`loom-node` 保留；按 PiBot Shower（虚拟屏）和 Mikka 接管/交还租约补缺。`host_desktop.py` 能被 PiBot `cua-*` 或 DSH computer-use 覆盖的部分就替换；L5 合成帧测试留作夹具。

## 6. 工单卡模板（Root 派工用）

```text
TASK-ID / Owner / 阶段(P0–P6) / 依赖
上游对照：项目 + 40 位 SHA + 文件路径 + 复用方式
可写白名单：<唯一文件列表>
测试与必需回执：<命令 + 产物路径>
失败/停工条件：超时、无增量、需扩白名单 → 回报 Root
回滚：<怎么撤>
```
工兵 2–4 分钟有界任务，只读 Scout 用 `--tools file`；写入先报微计划，Root 批准唯一白名单。工兵不得碰用户凭据、64851、日常 DB、全局 Pi/DSH/Claude/Codex 配置、GitHub/Bero 外传。

## 7. 等用户拍板

见 [架构](LOOM-ARCHITECTURE.md) §7。施工者不要自定。
