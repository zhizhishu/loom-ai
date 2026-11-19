# LOOM 交接书（唯一现行版）

> **下一位施工者从这里开始。** 读法：本页 → [LOOM-ARCHITECTURE.md](LOOM-ARCHITECTURE.md)（尤其 §3 复用总表）→ 根 `TASK.md` → `PROJECT_CONTEXT.md` → [参考锁](LOOM-V2-REFERENCE-LOCK.md) → [LOOM-IMPLEMENTATION.md](../../LOOM-IMPLEMENTATION.md)（进度唯一真源）→ 验收看 [LOOM-ACCEPTANCE.md](LOOM-ACCEPTANCE.md)。
>
> 本页取代 `mindkit-handoff-2026-11-13.md`、`mindkit-handoff-2026-11-18.md`、`MASTER-HANDOFF-2026-10-28.md` 及各阶段交接（已归档到 [archive/plans-2026-11-18](archive/plans-2026-11-18/README.md)），其中已验证的事实不作废。

## 1. 用户的话（不要再理解偏）

- “Mikka 和 PiBot 为主，其它是参考。”
- “UI 就是我们现在这个，很满意了。”
- “Pi 和 Pi Purge 是内置的，可以理解为主助手，也可以操控 B，四个端口。”
- “之前老是说开源，不舍得用。”参考快照许可已统一为 MIT，**Mikka、PiBot 等上游代码可以整段照抄**，许可不确定不再是自己写的理由。
- “Claude 依然禁用，Claude CLI 容易封号。”开发、测试、验收都不调用 Claude CLI。
- “直接在 DE-BERO 沙箱那边模拟我环境实现。”“以 DE-BERO 验收吧，Bero 走通了 Win 不难，GitHub 镜像多构建一个。”“最终我希望跑到云上。”

## 2. 复用硬规则（每个施工 Agent 的 READ FIRST）

1. **先找上游，再动手。** 任何新模块、新函数文件、新协议字段之前，先查 [架构](LOOM-ARCHITECTURE.md) §3 对应行。主体来源（Mikka / PiBot）有现成实现的，**直接复制/移植/运行，可以整段照抄**，不是“参考思路”。
2. **上游对照表是交付物的一部分。** 每份报告写：参考项目 + 40 位 SHA + 上游文件路径 + 复用方式（直接依赖 / 复制改写 / 原样运行）+ 若不能直接用，具体不兼容点（某个 API、某张表、某个平台）。给不出对照表就不许写新代码。
3. **只写最薄适配层。** 允许写的只有架构 §3 “LOOM 只写”一列。单次新增超过 300 行，必须说明为什么不是适配层。
4. **抄写上游再模拟 = 造轮子。** 要么导入/运行上游，要么写明不兼容点。读完上游后自己“重新实现一个简化版”同样算造轮子。
5. **复制代码的规矩**（沿用 PiBot `docs/reuse-first-development-plan.md` §9）：成熟库作依赖，不复制库源码；独立小模块才 vendor，放进明确的 `third-party/` 或 `adapted/` 目录，记录原路径、SHA、改动，更新 `THIRD_PARTY_NOTICES.md`；从原仓库/发布包取代码，不从网页文本粘贴。
6. **数据只进一个 Core。** 移植 Mikka/PiBot 逻辑时，存储落到 Rust Core + SQLite；不另跑 Postgres、不另起 PiBot Center、不建第二套调度。
7. **依赖版本跟随用户实际安装版本**（DSH `0.2.0-rc.2`、固定 Pi 版本），仓内不另锁旧版。注意系统 PATH 上的 `dsh --version` 仍报 `0.1.5-rc.2`，不要误判。
8. **既有纪律不变**：只认原始回执；失败记录不改写；不碰 64851 / 64852、日常 userData 和正式数据；DE-BERO 只用自己建的独立容器、不动已有容器；不 `reset`、不清理用户 WIP；未经用户同意不推送远端。
9. **不调用 Claude CLI**：Claude Code 运行端禁用，开发与测试也不拿它当工兵或验收对象。
10. **在 DE-BERO 沙箱开发和验收**（见 §3.1）；Windows 包走 GitHub 镜像 Actions；终态上云，Core 不依赖 Windows 本机路径。
11. 阶段结果只更新根 `TASK.md` / `LOG.md` / `LOOM-IMPLEMENTATION.md`，**不再新建计划书或交接书**；需要改计划就改本页三件套。

## 3. 当前状态（2026-11-18 晚，细节以 LOOM-IMPLEMENTATION 为准）

**有原始回执的**（路径相对 `_artifacts/delivery-20261118/`）
- 装机：`L1-install/local-personal-186-install-proof.json`、`L6-build/local-personal-186-install-proof-l6.json` PASS（启动、HTTP、登录、schema 186 / migration 236）。
- DSH：`L3-dsh/summary.json` Skill + Hook 调用 + Hook 拒绝三格 PASS。
- Pi Purge：`L2-purge/pi-purge-ui-07-r13/report.json` PASS（`exactCopyMet` 如实为 false）。
- Pi Skill + Rule：`L11-pi-caps/summary.json` 正反两 Run PASS。
- 电脑控制：`L5-computer/run-07/run.json` 模型自主截图识码，`synthetic_frame=true`。
- 能力矩阵：`L9` 16 格真实表，7 格正向回执。

**未完成**：~~写入早于认领~~（P0 已修，2026-11-19）；E6-B 恢复对账缺故障注入；记忆只按 Bot 不按 Workspace；Claude 已定禁用但代码仍判可用；Codex MCP 外部 relay 卡点；Owner 接受 = 0。

**Git**：分支 `rovai/loom-v2-personal-20261116`，本地提交未推送。

### 3.1 Bero 极速开发与测试（用户 2026-11-18 决定）

目标：在 DE-BERO 上把“改 → 编译 → 测 → 回执”压到分钟级，Bero 走通再出 Windows 包，终态上云。

**一次性准备（只做一次）**
1. 用 `komari-ssh` + `berobox` 在 DE-BERO 建独立容器 `loom-dev`（Linux，4 核 / 19 GB，2026-11-18 实测可用 150 GB）；不动已有 23 个容器。
2. 镜像固定：Node 22、Rust stable + `sccache`、pnpm、Pi 固定版本、DSH `0.2.0-rc.2`、Codex、cospan（`45ab14d`）。**不装 Claude CLI**。
3. 卷：`/src`（代码）、`/cache/cargo`、`/cache/target`、`/cache/pnpm` 持久化，编译只做增量。
4. 模型只用用户已授权的现有服务（Octopus / DeepSeek），密钥只进容器环境，不进仓库与回执。

**每轮循环**
1. 用户电脑只提交到本地分支；容器从固定提交拉取（经 Bero 中转的 git bundle 或私有镜像仓库，推送远端须用户同意）。
2. Root 拆 2–4 分钟工单，用 **cospan** 在容器里派 Codex / DSH 工兵并行跑（`send` 后台、`observe` 看进度、`result` 收），每个工单自带上游对照表。
3. 分层测试：`cargo check -p <crate>` → 改动 crate 单测 → 相关 Node 测试 → 该阶段 E 门禁；跨设备用“Core 容器 + 独立 Node 容器”。
4. 回执写 `_artifacts/<批次>/`，结论只进 `LOOM-IMPLEMENTATION.md`。

**当前状态（2026-11-18 22:05 PST，Hark 起头，下一位接手）**
- 已建：DE-BERO 宿主 `/root/sandbox/projects/loom-dev/`，镜像 `loom-dev:base`（node:24-bookworm + Rust 1.97.1 + pnpm 11.20.0），容器 `loom-dev`（runc、无宿主密钥）。说明与脚本见 [`scripts/bero/README.md`](../../scripts/bero/README.md)。
- 代码：`src/` 在 `b5c5d67`（GitHub 分支 `915ffa1` + 17 个未推送提交经 git bundle 传入，sha256 已核对）。
- 基线（`logs/baseline.summary`）：pnpm install 5 s；`cargo check --workspace --all-targets` 冷 129 s、热 0 s；文档决策检查 37 s 通过；`cargo test -p rovai-core --lib` 484 s，**634 过 / 4 败 / 1 忽略**；cospan `doctor` 0.1.1 可用，但 codex、dsh 尚未安装。
- Linux 下 4 个失败，**根因已在 Bero 复现确认（2026-11-18 22:55 PST，Pi 工兵只读定位 + Hark 复测）**：
  - `runtime_probe_process` 进程组 ×1：容器缺 init。`docker run --init` 下 5/5 通过。
  - `database_admission` ×3：unix 的 `artifact_state_key`（`database_admission.rs` 约 1096 行）把 ctime 算进身份；bundled SQLite 在 euid=0 时每次打开 `-wal`/`-journal` 都 `fchown`，Linux 会刷新 ctime，于是 `db.rs` 约 7871 行的严格复核判成 `IdentityChanged`。同一测试二进制：**root 9/12，uid 10001 12/12**。Windows 身份不含 ctime，所以没暴露。
  - **已修（2026-11-18 23:25 PST，方案②，Pi 工兵执笔、Hark 审+复测）**：`ArtifactIdentity::unchanged_by_admission` 只在 unix 准入复核忽略 ctime（dev:ino、长度、mtime 仍须一致；旁路文件有无须一致）；身份 token 与迁移 manifest 仍严格；Windows 不变。新增测试 `admission_revalidation_ignores_only_a_ctime_change_on_unix`；macOS xattr 断言同批翻转。Bero 容器 root + `--init`：**rovai-core lib 639 过 / 0 败 / 1 忽略**。Windows 上尚未跑此测试，macOS 未验证。
- 下一位接手顺序：① ~~`--init`~~ 已重建；~~身份判等~~ 已修；② 用户电脑上跑一次 `cargo test -p rovai-core --lib database_admission::` 确认 Windows 不回退；③ 在容器里装 Pi 固定版本、DSH `0.2.0-rc.2`、Codex（密钥只进容器环境），`cospan doctor --check` 见到 codex、dsh；④ 进 P0。

**2026-11-19 更新（Hark，阶段交接）**
- **用户硬规则**：用户 Win11 是大本营，不浪费本机资源。编译、测试、文档检查全在 Bero；Windows 包走 GitHub Actions；用户电脑只做 git、文档编辑和安装冒烟。要在用户电脑跑重活必须先问。
- Windows 回归：`cargo test -p rovai-core --lib database_admission::` 在用户电脑 **13 过 / 0 败**（2026-11-19 01:28 PST）；之后全量测试按用户要求中止，不再在本机跑。
- **Pi 工兵已搬进 `loom-dev`**：Pi `1.5.0` + pi-skill + 守卫，模型走 Octopus 公网 `https://oct.agent-ai.vip/v1`（内网 `10.10.0.101` 从 Bero 不可达），密钥只在容器环境。容器内只读冒烟 94 s 通过。用法见 [`scripts/bero/README.md`](../../scripts/bero/README.md)。
- 仍未做：容器里装 DSH `0.2.0-rc.2`、Codex（P1b 前）；macOS 未验证；20+ 本地提交未推送（等用户同意）。
- 下一步：**P0 先领后写**，Pi 在容器里先只读出计划，Root 审后授权落地，测试在 Bero 跑。

**2026-11-19 04:30 PST 更新（Hark，P0 阶段交接）**
- **P0 先领后写（T34）完成**，HEAD `37e35ca`：guard 对绑定 LOOM Task 的 Run 要求完整未过期 claim（`claim_missing` / `claim_expired`），`loom.claim` 与 `loom.claim_heartbeat` 成功后 Core 重签写授权，本地 `artifact_register` 查 fence，接管后旧 Run 报 `LOOM_CLAIM_ABSENT`；普通聊天不变。Claude 运行端默认禁用，`LOOM_CLAUDE_RUNTIME_ENABLED=1` 才放行。
- Bero 回执：rovai-core lib 667/0/1；`pi::host` 扩展 18/0/1；Node 34/0；r9 重跑 10 次写入早于认领 = 0（`_artifacts/delivery-20261118/L12-r9-*`，脚本 `scripts/loom-r9-write-before-claim-rerun.mjs`，守卫+授权文档回放，非真模型在环）。
- 缺口：E-5 `loom.evidence` 不带 `taskId` 仍绕过 fence（需 Run↔Task 绑定，产品决定）；UI TS 测试、Claude 启用路径生命周期测试、Claude/Codex 经 oct 冒烟、DSH 与 `cospan doctor` 未做。
- 下一步：重读 MASTER-PLAN §B / ARCHITECTURE / 本文件后进 P1 / P1b。

**留给 GitHub 与用户电脑**
- Windows：Bero 通过后，由 GitHub 镜像仓库 Actions（`windows-package.yml`、`loom-v2-e3-windows.yml`）多构建 Windows 包；用户电脑只做安装冒烟，不碰 64851/64852、日常 userData。
- 云端：DE-BERO 上的部署按云端形态做（Linux Core + Web 登录 + Node 连入）。

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

### P-1 Bero 开发容器（先做）
按 §3.1 建 `loom-dev`，跑通一次 `cargo check` 与现有 Node 测试，cospan `doctor --check` 通过（codex、dsh），记录基线耗时。**进行中**：容器与基线已完成（见 §3.1 当前状态），剩 4 个 Linux 失败与运行端安装。

### P0 先领后写（附带：Claude 禁用对齐）
0. 把 `agent_runtime_adapter.rs` 中 Claude Code 的准入改为禁用（只识别），UI 显示“已禁用”；加负例测试：选 Claude 派工被拒。
1. Core 在 claim 事务里原子生成 Run + 快照 + 租约，并发放单调递增的 fence（对照 Mikka `claim.ts` / `worker-lease.ts` 的租约写法与 ACCP 不变量）。
2. 写授权只在 claim 成功后由 Core 签发并携带 fence；guard 对每次写入（含首次新建）校验，缺失或过期即拒绝。
3. heartbeat / report / artifact 全部校验 fence；过期租约不能被旧心跳复活。
4. 负例测试：未 claim 写入被拒；旧 fence 写入被拒；依赖未满足时 claim 不产生 Run。
- 验收：r9 场景重跑 10 次，“写入早于 claim” = 0；回执进 `_artifacts/delivery-20261118/L12-*`。

### P1 Hook 回归 DSH 原生
LOOM 只负责：选择并冻结进 Run → 写入 DSH Profile → 读 `hook/invoked` / `hook/result` 作回执。依赖对齐 `0.2.0-rc.2`，退役私有执行器；L3 判据保留为回归。

### P1b 运行端派活接 cospan
Codex、DSH 的 Run 改为交给设备上的 cospan worker（`send`/`observe`/`result`/`continue`/`cancel`）；Rust Adapter 只负责把 Run 快照交过去、把 job 状态和 git 差异写回 Core。删掉与 cospan 重复的自写进程管理与输出解析。上游：cospan `src/drivers/{codex,dsh}.mjs`、`job-worker.mjs`、`envelope.mjs`。

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

见 [架构](LOOM-ARCHITECTURE.md) §8。施工者不要自定。
