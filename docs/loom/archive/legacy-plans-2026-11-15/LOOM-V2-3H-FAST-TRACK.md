# LOOM V2：「3 小时冲刺」未来派工书（不是本轮开工）

> **ACTIVE_P1_A_SLICE / 2026-11-15**：用户最新指令已批准执行，Root 正按 [P1-A 四路独立合同](../plans-2026-11-18/LOOM-V2-P1-FOUR-LANE-SLICE-2026-11-15.md) 组织实际 Pi 工兵；**这只激活首批独立可测模块，不代表下文全部 G2–G6、生产部署或 130 例验收已授权/已跑**。用户希望将原 4–6 周单用户基础版尽量压缩到 3 小时，需尽可能复用代码，但**不承诺三小时得到同等产品质量**；未验必须标 NOT_RUN。

## 0. 时间盒的正确目标（建议）

**Stretch Goal：**保留现有 LOOM UI → 创建持久 Bot/群聊 Goal → Lead 派两个工兵跑受限任务 → Cloud/本地受管 Pi 实际流式执行 → 四能力中至少每类一条真实 loaded/invoked 回执 → 返回 Artifact/Review；能通过已存在 E3 Device-only 真文件链读取隔离工作区。如果有真实另一物理 Windows 设备，追加 E5，但不将其列为未准备时的假通过。

**不能冒称 3 小时完成**：全部 P0–P14、130 例双内核 Bake-off、跨平台 macOS GUI/Wayland/人工接管、生产级 Tenant 隔离、安全攻防和实际断电/断线 E6、多运行端四能力全兼容。这些仍需后续实测。理想结果是高密度的**垂直可用演示+清晰缺口**；失败时交付真实证据、代码差异和可恢复状态，绝不填 100%。

## 1. 开工前根任务的必要条件（本轮只记录，不执行）

> **Pi Purge 扩展已纳入正式候选工单（非已完成）**：先读 [Pi Purge 固定 SHA、Extension Bridge 与 T29–T33](../plans-2026-11-18/LOOM-V2-PI-PURGE-EXTENSION-PLAN.md)，Pi 受管封包时只增加可选 Extension，不 Fork 原 Pi Agent Loop、不依赖全局 pi install；三小时只有主闭环完成后才尝试 Off/Append 的真实 Loaded/PromptApplied 证据，不能因此承诺五模式/恢复/Strict/Lab 全通过。
> **人格与安全测试新边界**：新增 [LOOM-V2-PERSONA-MEMORY-AND-SECURITY-LAB.md](../plans-2026-11-18/research/LOOM-V2-PERSONA-MEMORY-AND-SECURITY-LAB.md)。agent-purge 固定源码可作为文档参考，不能把剔除 DSH Approval/Sandbox Context、自动允许工具审批的原插件加入核心 Runtime。Persona/Memory/Lab 允许并行只读 Scout；三小时只争取 **1 份可信 Persona Manifest + 1 次受管 Pi Append Loaded/PromptReceipt**（在 Domain/Runtime 核心闭环通过后）；完整跨四内核人格/长期记忆/安全实验自动化是独立后续 Gate。

- Root 阅读 PROJECT_ID.md、AGENTS.md、docs/README.md、docs/versions/README.md、[V2 MASTER](../plans-2026-11-18/LOOM-V2-MASTER-PLAN.md)、两份 V2 Port/Capability 提案、JSON Schema、原 PDF 与参考源码索引；
- 用户同意具体范围：不重做 UI，四 Runtime 只选 Claude/Codex/DSH/Pi、Pi 首先封包、DSH 保留 Adapter；Windows 11 Claude Code 执行禁用；
- 根任务明确标记从 PLANNED_ONLY → ACTIVE，建立独立 Git 分支/worktree、文件 Allowlist、原五处 WIP 备份 SHA、隔离 DB/端口/沙箱/凭据通道；
- 每条设计变更先由 Root 冻结 Spec，确认旧数据迁移/回滚；Pi 工兵不得自行扩大全局权限或推送发布；
- 检查实际 Bero 可用空间/容器、模型通道有效性、必要硬件、GitHub/GHCR 凭据是否有权限；不把旧测试结果冒充当前实测。

## 2. 180 分钟最短关键路径（硬时间盒）

| 时间 | Root 关键路径与并行方式 | 退出门槛（不通过立刻缩范围） |
|---|---|---|
| **00–20 min** | G0：核对主 WIP/版本/服务、作隔离快照；冻结 Bot/Goal/Assignment、RuntimePort、CapabilitySnapshot/DeviceInvocation 最小 IDL；每个 Owner 独占 write scope。启动只读审查/构建 Scouts 仅在下一轮授权后。 | 合同无双重 Owner、没有把 Device 绑到 CLI，用户数据/64851 不被触碰。 |
| **20–55 min** | G1：Domain 工兵搭最小 Bot/Goal/Step/Assignment 状态；Pi 工兵复用已有受管包/JSONL；Capability 工兵复用现有选择页与能力扫描。Root 审查变更。 | 能保存/读回一个 Goal、一份明确的 effective snapshot，并让 Pi 通过现有受管 launcher 回复。 |
| **55–110 min** | G2：多 Agent 工兵从群聊生成一个 Goal 的两项受限 Assignment；Pi Runtime 真执行一段任务；设备工兵尝试复用已证 E3 FilePort。DSH 工兵此时只做只读 Adapter 快速适配审计，不冲突 Core 主改动。 | 真实两个 worker 身份/任务/回执；不存在假 CLI Binding；任一失败标 BLOCKED 并回退到 Bot/Goal/一 Worker 演示。 |
| **110–150 min** | G3：Skill/MCP/Rule/Hook 每类先一正例一负例；有实际装载/工具调用/Rule 注入/Hook 事件证据；Artifact/Review 读回并保留用户接受权。 | 四能力不可只有 UI 选中；任一没有实测则标 PARTIAL/UNSUPPORTED。旧视觉回归/简单安全否定项由 QA 独立验。 |
| **150–180 min** | G4：冻结所有新写入、单测/有界集成回归、合并前审查、完整 E0–E7/T0–T22 状态矩阵、差异/进程/凭据泄露检查、Mindkit 交接；条件允许才生成**隔离构建产物**，不自动部署主服务。 | 通过的签原始 log/commit/hash/真实调用；失败的留在隔离 worktree；不为了“3h 完成”跳过安全门。 |

**风险早停规则**：在 60 分钟仍无法让可信 Bot/Goal/Runtime 产生稳定回执，不再开始跨机/DSH/GUI 扩面；聚焦 Task DAG+受管 Pi+统一能力 Snapshot 的可审查切片。任何授权/tenant/设备边界失败禁止发布，即使演示 UI 看起来正常。

## 3. 备选资源分配：Root + 多路 Pi Skill，谁拥有哪部分

| Owner（下一轮派） | 唯一写入范围（最终以 Git worktree 精确 allowlist 为准） | 最小输出 | 不允许做什么 |
|---|---|---|---|
| **Root / Architect** | 跨模块合同与合并权，旧主仓先只读 | 审批冻结 IDL、裁决冲突、根最终验收与 Mindkit | 不把自己当同时写全部文件的工兵 |
| **Domain** | 新 V2 domain/schema/migration 的独占分支 | BotTeam/Goal/Step/Assignment/DeviceInvocation 关系、shadow mapping | 不碰现有生产 DB |
| **Pi Runtime** | Pi Host/launcher/adapter 的独占分支 | 受管原版 Pi 真运行和 settled/stop/恢复回执、可选固定 v0.3.0 Pi Purge Extension | 不 Fork Agent Loop、不偷读/重写全局 Pi/Claude 配置；Pi Purge 实际激活须另证 |
| **DSH Runtime** | DSH Profile/Adapter 的独占分支 | 启动/Bundle/插件支持声明，真实可运行后才列 E4 | 不替代 Pi 默认或全局 DSH 配置 |
| **Capability** | Manifest/Binding/Resolver/Materializer 独占分支 | 四类选择→真实 loaded/invoked/evidenced | 不以 prompt 假冒 MCP/Hook |
| **Coordinator / ACCP** | event/wake、Task DAG、lease/claim、Review 独占分支 | 两 worker 并发任务与迟到回执拒绝 | 不建立另一个任务数据库 |
| **Device** | 独立 wire/broker/Node 分支 | E3 延伸到可信 Invocation、File/PTY、E4 Artifact | 不绑定错误 CLI Installation、不执行任意 Shell |
| **QA Red Team** | 只写 _artifacts/ 测试证据，不修改产品源码 | 反例、断线、私密范围、承诺用例的 E2–E5 真状态；Persona/Memory 边界安全验证 | 不“帮忙”修代码，保持独立审查 |
| **Persona / Memory / Pi Purge（可选并行）** | 独占 PersonaRegistry、PromptComposer、MemoryScope、Pi Purge Bridge 设计/代码（需正式 P1 指定） | Persona Markdown 导入+Hash、Pin Pi Purge 的 Off/Append 真 PromptReceipt、Session 不串人格；Lab 禁联网/假凭据 | 不能改 Core Grant、不引入 DSH auto allow、Strict 默认不进生产、不在三小时承诺真实长期记忆全部实现 |
| **Platform/Release** | 隔离 Bero/GitHub 构建脚本，只有后续发布准入才写 | 分支/镜像 digest、清洁构建、部署/回滚准备 | 不修改 64851、真实凭据、生产卷 |

旧 P0–P14 仍是总阶段；这张表只描述第一次 180 分钟适合并行的**小切片**，不是替换总蓝图。所有 Pi 工兵都使用用户已有受管 pi-skill，并按每卡相同模板 Task/Owner/Dependency/Source SHA/Write allowlist/Test/Evidence/Failure/Rollback/Handoff；工兵不继续调度工兵。

## 4. 哪些模块必须最先稳定，而不是追求大量新特性

- **单一产品真源**：Root 明确一个 Core 新领域写入入口；不把 ROVAI v1 Mission/Run 旧绑定复制到 V2。
- **跨 Runtime 的包裹**：仅四个 Runtime AdapterKind，Pi 默认、DSH 可选，不先追求 Claude Code 在 Windows 能运行；ACP 只作协议载体。
- **单一 Capability Snapshot**：Bot/Team 四类勾选有来源/版本/生效回执，Provider/credential 通过窄引用，不复制用户环境变量明文。
- **单一工具/证据通道**：RunAttempt、DeviceInvocation、Artifact 都带 traceId、ownerScope、Grant、回执 ID；unknown_outcome 保持待 reconciliation。
- **UI 不动大结构**：优先复用既有服务与配色，可改内部 typed adapter；测“原 UI 仍能创建群、选 Agent、编辑能力、看工作”而不是重做页面。

## 5. 构建/发布策略（**本轮未执行，下一轮仍按 Gate**）

推荐顺序：本机独立 worktree 或 Bero 隔离目录 → 单元/合同测试 → 真实受管 Pi → E3/E4 → 有条件 E5 → 从固定 SHA 创建可审查 PR 分支 → GitHub Actions/GHCR 或 Bero Docker **隔离镜像构建** → 验证 manifest + SBOM/许可/secret scan → 发布候选（非生产）→ 用户验收再切换。GH push、镜像 push、线上切换属于独立动作，**不因用户给了广泛开发许可就视为本轮正在执行**。

Bero 的根盘先前恢复约 23.4 GiB，但重建两个 Rust target 很可能再次填满；必须把 Cargo target 单独固定到受控目录/容器缓存，并定量限制并发构建。Win11 Claude Code 只发现、不执行，必要 Claude/Codex/DSH/Pi 对照装在隔离 Linux/容器时也不默认连接生产凭据。

## 6. 真实交付定义与失败报告

| 证据维度 | 三小时最多力争 | 没达到如何写 |
|---|---|---|
| Bot / 2 Worker | 同一 Goal 两条各有唯一 lease/回执 | BLOCKED：接口不兼容，不将普通聊天冒充派工 |
| Pi 封包 | 固定版本/隔离 Home/真实 settled | PARTIAL：已有旧包但新 V2 未连 |
| 四能力 | 四类各 1 正/负证据 | NOT_RUN/UNSUPPORTED：只有勾选 UI |
| Device | 无本地 CLI 的真 Files，受权与越界拒绝 | E3 历史可引用，但必须注明非 V2 E4 |
| Artifact / Review | 真实候选、人工决定独立 | FAIL：模型一句“完成” |
| 系统回归 | 原 UI 正常，安全负例可复核 | 代码存在≠验收 |
| Cloud E5 / 故障 E6 | 有实际多物理机条件才测试 | NOT_RUN，不用本机双进程冒充 |

**开工后最新交接（2026-11-15）**：用户已经批准；四路 Pi Skill 工兵、唯一 P1-A 合同及可见本机看板 [127.0.0.1:8767](http://127.0.0.1:8767) 已启动，状态以 Mindkit TASK/LOG 和真实工具回执为准。当前仅 G0/G1 薄切片，不因做出纯 Rust/Node 合同就认定 Pi Bundle/三小时核心演示全部完成。Persona/Memory/Security Lab 为 T23–T28，Pi Purge T29–T33，真实 Prompt 注入/多设备/生产部署须后续独立实测。
