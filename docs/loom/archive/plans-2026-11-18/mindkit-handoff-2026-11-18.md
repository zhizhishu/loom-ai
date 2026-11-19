# LOOM — Mindkit 交接书 2026-11-18（复用优先 · 停止造轮子）

> **下一位施工者从这里开始。** 本页取代 `mindkit-handoff-2026-11-13.md` 的“下次最短路线”，但不推翻其中已验证事实。
> 读法顺序：本页 → 根 `TASK.md` → `PROJECT_CONTEXT.md` → `docs/loom/LOOM-V2-REFERENCE-LOCK.md` → `LOOM-IMPLEMENTATION.md`（进度唯一真源）。
> 本页的“现状”均来自 2026-11-18 晚对 `HEAD f24a461` 工作树的只读核对（`git grep`、文件行数、参考仓文档）；标「待验证」的是按文档/包结构做的判断，**没跑过对照实验，不得当结论**。

## 0. 本次用户要求（原话要点）

- “认真看项目内的参考项目……他好像一直在造轮子。”
- 参考锁 2026-11-18 已写明：**参考项目默认直接采用，不是只取思路；LOOM 只写最薄适配层；禁止为“架构纯净”重写成熟的 Agent Loop、RPC、ACP、Hooks、设备传输或任务算法。**
- 13 个参考快照许可已统一为 MIT：可直接复制、修改、集成、分发，保留原版权和 NOTICE 即可。“许可不确定”不再是自写的理由。

## 1. 架构（理解后再动手，以下部分不要改方向）

- **Core 唯一权威**：`crates/rovai-core`，SQLite（schema 186 / migration 236）。不引入第二套数据库或调度真源。
- **四层**：助手（持久 Bot）→ 接入与反馈（唤醒桥 / ACCP 式 claim-report-artifact / 原生协议或 ACP 托管）→ 控制层（Rovai 的 Message/Delivery/AgentRun + ACCP 的 Task/DAG/Claim/Lease/Review，8 张 `loom_*` 表）→ 可替换执行层（Pi / Codex / Claude Code / DSH）。
- **UI**：`apps/desktop/src/renderer/src/loom-native/`（Mikka/PiBot 三栏），不恢复旧 Rovai 页面。
- **不可混同**：Bot 身份 ≠ Session ≠ AgentRun ≠ 进程；Run 完成 ≠ 证据核验 ≠ 人工验收；ACP（线协议）≠ ACCP（控制面）；电脑在线 ≠ 可看屏 ≠ 模型可操作。

## 2. 造轮子清单（2026-11-18 核对）

| # | LOOM 自写 | 规模 | 应直接复用的上游（参考锁固定版本） | 核对到的事实 |
|---|---|---|---|---|
| 1 | 设备节点 `crates/loom-node`（process_pipe / session / workspace_rpc / computer_provider / mcp_environment）+ `crates/loom-protocol` | 约 15,641 + 9,738 行 | DeskFleet daemon（ACP Agent、File/PTY/Desktop 通道）、MindFS（File/Terminal/Relay） | 生产代码中 `deskfleet`、`mindfs` 引用均为 0 |
| 2 | 电脑控制 `resources/computer/host_desktop.py` 等 | 约 1,749 行 | DSH `packages/computer-use`、DeskFleet 桌面通道 | `computer-use` 引用为 0 |
| 3 | 私有 Hook 执行器 `crates/rovai-core/src/local_hook.rs` + `dsh/local-hooks.mjs` + `resources/dsh-hook-executor` | 739 行 + 脚本 | DSH 原生 `tools/pre-execute` / `post-execute` 瀑布 + `hooks-claude-code` / `hooks-codex` / `hook-protocol`；事件 `hook/invoked`、`hook/result` | 执行器锁 `@deepseek-ai/dsh-* 0.1.5-rc.2`，用户 DSH 与新打包运行时是 `0.2.0-rc.2`，两套版本并存 |
| 4 | 文件守卫 `scripts/loom-v2-runtime-file-guard.ts` | 473 行 | ACCP：claim 原子生成 Run + 快照 + 租约 + **fencing token**，之后每次写入都带 `If-Match` + `X-Run-Fencing-Token` | Core 已有 `claim_acquire`（`loom.rs:1269/1284/1300`）和“无 claim / 被取代 claim 拒绝候选”的测试，但守卫只认 grant，不认 claim；r9 实证写入比 Claim 早 6.031s |
| 5 | Pi Purge 桥 `scripts/loom-pi-purge-bridge.mjs` | 380 行 | 上游 `extensions/pi-purge.ts` | 文件头写明“不导入上游，行为抄写后模拟”；真实 Run 已经由 `crates/rovai-core/src/pi/host.rs:99` 加载上游扩展，模拟层是重复实现 |
| 6 | 记忆 `memory.rs` / `memory_retrieval.rs` / `memory_tool.rs` | 约 6,000 行 | Mikka：记忆归属个人工作区（glossary）；PiBot：Hindsight 插件，8 个 memory action，Center 按 Bot 授权启用 | L10：`Companion` 只按 Bot、不按 Workspace（按代码推断，未观测到串读） |
| 7 | ACCP 控制面 Rust 重写 `loom-protocol/src/v2_coordinator.rs` + `rovai-core/src/loom.rs` | 约 8,000 行以上 | ACCP（Go，约 16,873 行） | 仅注释写 “ACCP-style”；Go 无法嵌入 Rust Core、参考锁也禁止第二套调度，所以**重写可以接受，但必须搬 ACCP 的不变量和负例测试** |
| 8 | Pi 接 MCP 的自建桥 `loom-node/src/builtin_bridge.rs`、`mcp_environment.rs` | 约 77KB | `_references/pi-mcp-adapter`、Pi 原生 MCP | `pi-mcp-adapter` 引用为 0；功能是否重叠「待验证」 |

## 3. 任务（按顺序做）

### P0 先领后写——直接按 ACCP 裁决，不再二选一
`TASK.md` 里的两个候选（扩 Core 私有 IPC 白名单 / 让 Pi 侧做 Core SQLite 第二写者）都不选。照 ACCP `docs/m2-execution.md`、`docs/client-joint-acceptance.md`：
1. Core 在 claim 事务里原子生成 Run + 快照 + 租约，并发放**单调递增的 fencing token**。
2. **写授权只在 claim 成功后由 Core 签发**：guard 的 grant 由 Core 写入并携带 fence；没有 claim 就没有可写 grant。
3. guard 对每次写入（含首次新建）校验 fence；缺失或过期即 block（fail-closed）。
4. heartbeat / report / artifact 全部校验 fence 与版本；过期租约不能被旧 claim 或旧心跳复活（ACCP 默认 90s 租约 / 30s 心跳可照搬）。
5. 移植 ACCP 负例为测试：未 claim 写入被拒；旧 fence 写入被拒；依赖未满足 claim 返回无 Run。
- **验收**：重跑 r9 场景 10 次，“写入早于 claim”为 0；原始回执入 `_artifacts/delivery-20261118/L12-*`。

### P1 Hook 回归 DSH 原生
- 停止扩展私有 runner。DSH Run 的 Hook 走 DSH 自己的 pre/post-execute 瀑布，用 `hooks-claude-code` 加载用户已审阅的 Hook。
- LOOM 只负责：选择并冻结进 Run、写入 DSH Profile、读取 `hook/invoked` / `hook/result` 作回执。
- 依赖对齐 `0.2.0-rc.2`，退役 `0.1.5-rc.2` 锁；L3 的拒绝判据保留为回归。

### P2 设备与电脑控制：先对照实验，再替换
- 一天的**隔离对照实验**（不改生产、不碰 64851/64852 和日常数据）：跑 DeskFleet daemon 与 DSH computer-use，逐项对照 `loom-node` 能力表：File、PTY、桌面截图、输入、人类接管、撤销。
- 覆盖的能力：`loom-node` 收缩为薄适配，只保留 Grant / Lease / 工作区权威 / 回执（`workspace_authority.rs`、`process_admission.rs` 一类 LOOM 特有逻辑）。
- `host_desktop.py` 换成 DSH computer-use 或 DeskFleet 桌面通道；L5 合成帧测试保留为验收夹具。
- 不覆盖的能力：在报告里写清缺哪个 API，再决定补代码。

### P3 记忆隔离
- 契约直接采用 Mikka：记忆归属工作区，账号级只放个人资料类记忆。
- 实现参考 PiBot Hindsight：记忆是按 Bot 授权启用的插件，Core 不硬编码记忆服务。
- **验收**：同一 Core、同一 `agent_id`，W1 写随机标记，W2 的模型自主 `memory.search` 命中为 0。

### P4 清理重复实现
- `loom-pi-purge-bridge.mjs` 删去模拟层，只保留配置校验；Pi Purge 回执只认真实 Run（`native_extension_local`）。
- 对照 `pi-mcp-adapter` 与 Pi 原生 MCP，重叠即替换自建桥。

### 等用户拍板（施工者不要自定）
- **Claude Win11 准入**：文档说不跑，`agent_runtime_adapter.rs:911` 却返回 `qualified`。强制阻止，还是改成显式配置？
- **Codex MCP（L4）**：外部 relay 问题，挂起等取证，不占主线。
- **L8 恢复对账**：mission-ready，排在 P0 之后。

## 4. 硬规则（每个施工 Agent 的 READ FIRST）

1. **写任何新模块前**，先在交付报告给出「上游对照表」：参考项目 + 40 位 SHA + 上游文件路径 + 为什么不能直接用。给不出就不许写。
2. 单次新增超过 300 行，必须说明为何不是“最薄适配层”。
3. “抄写上游行为再模拟”算造轮子：要么直接导入/运行上游，要么写明具体不兼容点。
4. 依赖版本跟随用户实际安装版本（DSH `0.2.0-rc.2`、Pi 固定版本），仓内不另锁旧版。
5. 延续既有纪律：只认原始回执；不篡改失败记录；不碰 64851 / 64852、日常 userData 和正式数据；DE-BERO 根盘余量小，不投大编译；不 `reset` / 清理用户 WIP。
6. 阶段结果只更新 `TASK.md` / `LOG.md` / `LOOM-IMPLEMENTATION.md`，不另建开发书。

## 5. 本次落盘时的 Git 状态

- 2026-11-18 晚已把 L1/L2/L3/L5/L6 五组施工的 WIP 分组做成**本地提交**（未推送），提交前 `node --test` 跑 4 个相关测试文件：69 项，68 通过、1 跳过、0 失败。Rust 改动沿用候选 r3 已有的同源编译证据，本次未重新编译。
- 未提交：`LOG.md.bak-precompress`、`LOG.md.preview`（本地记忆备份）、`Microsoft/Windows/PowerShell/ModuleAnalysisCache`（PowerShell 缓存），已加入 `.git/info/exclude`，不进仓。
- 仍未做：推送远端、正式发布、Owner 接受。
