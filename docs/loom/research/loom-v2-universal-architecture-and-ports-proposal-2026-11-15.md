# LOOM Core V2：多 Bot / 多 Agent 通用架构与扩展接口提案

> **最新边界（2026-11-15）**：仅提供 **Claude Code、Codex、DSH、Pi** 四种用户可选 Runtime Adapter。ACP 是线协议、ACCP 是任务控制面参考而非第五 Runtime；Pi 优先封包、DSH 受管可选；旧底层 API 可以重构，已喜欢的 UI 不重做。**下一轮唯一入口**：[LOOM-V2-MASTER-PLAN.md](../LOOM-V2-MASTER-PLAN.md)，本文件仍是未冻结技术提案。

> **状态：DISCUSSION_PROPOSAL / v0.1，待用户与工程合同评审。不是当前 Rovai v1.72 Contract、不是实现完成声明。**
> 依据：用户认可的《LOOM 深度架构研究与正式开工计划》27 页 PDF（尤其第 1–17、18–23 页）；本地源码快照 Mikka `d59c85cb...`、ROVAI `f5f4cb26...`、ACCP `77f05778...`、PiBot `8b9f3d7a...`、Pi `ddaa0a03...`、DSH `39163dd3...`、AgenTeam `d12b5076...`、MOVO `e16174ac...`、DeskFleet `098485a4...`、UFO `eae3c0a8...`。固定 HEAD **不是**远端最新声明。
> 与已有 [完整工作空间接口](../archive/legacy-plans-2026-11-15/ultimate-interface-contracts.md)、[产品化接口](../productization-interfaces-2026-11-13.md)并存：旧文描述已有产品/旧适配；**V2 允许替换领域模型和旧接口，不以兼容旧 API 为最高目标**。保留用户数据、迁移/回滚和当前 64851 服务，UI 视觉/配色/使用习惯不重做。新接口只有评审采纳并更新 canonical docs/architecture、docs/contracts、版本决策后才成为权威。

## 一、各项目只学习擅长的那一层

| 本地项目 | 真实参考机制与源文件 | LOOM V2 的设计所得，不是照搬整个服务 |
|---|---|---|
| Mikka | `lib/coordinator/group-routing.ts`、`group-turns.ts`、`group-factory.ts`、`wake-after-commit.ts`、`docs/design/glossary.md` | 长期 Bot 身份、群聊只唤醒必要成员、委派给真正的任务、durable wake、Attention、Factory/check/Review |
| ROVAI | `crates/rovai-core/src/collaboration.rs`、`docs/architecture/team-management.md`、`docs/architecture/missions.md` | 保留现有群聊、Lead、Team 模板、Thread/Mission 工作体验；**旧 Team 是创建模板，不自动等于长期 BotTeam** |
| ACCP（不是 ACP） | `docs/architecture.md`、`docs/collaboration-flow.md`、`internal/bridge/bridge.go`、`tasks_execution.go` | 任务 DAG、独立责任人、冻结 ContextSnapshot、claim/lease/fencing、候选成果、真实人类验收、可恢复幂等执行 |
| PiBot | `docs/bot-sessions.md`、`center-server/README.md`、`docs/bot-management-learning.md` | 每 Bot 长期配置、跨设备访问、能力按 Bot 绑定与部署确认、身份/消息来源隔离；不照搬一 Bot 单会话串行限制到全部 worker |
| AgenTeam | `AgentHireApiController.java`、`RunApprovalController.java`、`TeamDefinitionApiController.java` | 面向用户的 AI 员工/团队/角色/雇用/技能/资源分配体验 |
| MOVO | `services/admin-api/app/position_roles/service.py`、`core/quota_policy.py`、`services/chat-api/dsh/runtime-host/src/official-host/composition.mjs` | 企业人员/岗位权限、额度/审计、DSH 受管组合与真实插件生效证据；不假称 Community 已具全量企业资源隔离 |
| DeskFleet / MindFS / AgentDock | DeskFleet `agents/docs/architecture.md`、`apps/daemon/src/agents/acp.ts`；MindFS Relay/File/Session；AgentDock 机器操作能力 | 远端电脑工具与 Agent Runtime 独立、跨端 daemon、PTY/文件/屏幕/人类接管，不要求每台电脑先安装 Pi/DSH |
| UFO Galaxy | `galaxy/agents/constellation_agent.py`、`constellation/orchestrator/orchestrator.py`、`client/device_manager.py` | DAG 规划、流程控制、设备事实与调度分别拥有独立职责；跨机能力不由模型猜测 |
| Pi / DSH | Pi `docs/rpc.md`、`extensions.md`、`mcp.md`；DSH `docs/architecture.md`、`tool-execution-pipeline.md` | 可替换 Runtime，能力物化/Tool Hooks 映射；不自己写第二套 Agent Loop |

## 二、产品级对象，拒绝“Bot=Runtime=Device=Agent”的混用

```text
Account/User ── Workspace (future Tenant boundary)
                  ├── Bot (durable identity, Memory, configuration)
                  ├── BotTeam (roster + per-team coordination policy)
                  ├── Chat/GroupChat (user-facing channel, not task source of truth)
                  ├── Goal (one user's durable request)
                  │     └── Step[*] DAG, dependency version & status
                  │          └── Assignment[*]  (owner bot/profile/worker, role, claim)
                  │               └── RunAttempt[*]  (optional RuntimeBinding)
                  │                    └── DeviceInvocation[*] (independent capability)
                  ├── AttentionItem (needs human)
                  └── Artifact / Evidence / Review (immutable proof)
```

**Bot** 是用户能长期找到的角色：Bot 的身份、SOUL/记忆、Goal 与权限始终由 LOOM 拥有。**BotTeam** 是用户可编辑的成员名册/协作策略，而不是把四个进程硬拉成一个 Session。**Lead** 是**当前群聊/Goal 的协调职责**，不是管理员、不是自动拥有所有文件/密钥的高权限身份。**Worker/AgentProfile** 是执行角色配置，RunAttempt 才是一次执行，Runtime 是 Pi/DSH/可选 ACP 客户端，Device 是真实电脑。Bot 之间可私聊/委派，但委派转为有责任与验收条件的 Step/Assignment；不能只记一条聊天消息。

- Chat routing：显式 @ 指定被唤醒者；未 @ 时依角色、能力和当前任务状态选择 `reply|delegate|clarify|ignore`；返回可展示原因。不得让每个群成员无条件各推理一轮。
- Multi-agent：允许一个 Goal 的多个 Step 并行、依赖、返工和终止；共享的是**版本化上下文与已授权成果引用**，不是默认共享全量上下文、凭据、私有 Bot Memory。
- Coordinator：事务 `business state + DomainEvent + Outbox` 原子提交，commit 后 wake；消费者至少一次，业务去重与 reconnect reconciliation，不能用模型会话进程持有 Bot 身份。
- ACCP 式 Execution：Assignment 的 `claim` 冻结 `TaskContextSnapshot`、grant、repo revision、能力版本；lease/epoch/fence 防旧工兵晚到覆盖新工兵。Result 先 `candidate`，Review 再 accept / return；“模型说已完成”不改变 Goal 最终状态。
- DeviceInvocation 可在无 RunAttempt/CLI 设备上成立；不得伪造 `remote_runtime_installation`；所有电脑操作走设备已验证 grant/WorkspaceBinding。Work/设备不需要 1:1。

## 三、通用 Port 最小草案（分清 Authority、Contract、Adapter）

所有端口未来正式入 `docs/contracts/` 之前都只属提案；字段必须携带 `apiVersion` / `requestId` / `traceId`，写操作需 `idempotencyKey`，涉及授权需 `actor` 与资源作用域，拒绝模型任意指定受信身份。

| Port（v0.1） | 最小方法与输出 | 权威与可扩展边界 |
|---|---|---|
| `BotPort` | `get/list/upsert/clone/revise`、`BotSnapshot` | Core 的 Bot 身份、记忆引用、配置版本；不持有 Runtime 私有 Session |
| `TeamPort` | `create/updateRoster/setLead/setPolicy`、`TeamRevision` | 名册+协作策略；群聊成员/Lead 与跨项目 Grant 独立 |
| `ChatRouterPort` | `routeMessage(group,mention,context)` → `RouteDecision` | 路由≠任务执行；模型决策不得越过群权限 |
| `GoalPort` | `create/revise/steps/attachEvidence` → `GoalRevision` | Core 拥有 Goal/Step DAG、依赖、状态 |
| `AssignmentPort` | `assign/claim/heartbeat/report/cancel/reconcile` → `ClaimLease/RunAttempt` | 运行权经快照、lease/fence、幂等；ACCP 设计参考 |
| `CoordinatorPort` | `ingestEvent/wake/nextAction/awaitHuman/reconcile` → `CoordinatorDecision` | Core 事务+Outbox+重放，模型只建议而不写权威状态 |
| `RuntimePort` | `discover/probe/prepare/start/stream/steer/answerApproval/cancel/recover/settle/shutdown` → `RuntimeEvent/CapabilitySupport` | Pi、DSH、未来 ACP 各自 adapter；`accepted` 不等于 `settled` |
| `DevicePort` | `inventory/bind/invoke/observe/abort/reconcile` → `DeviceReceipt` | 独立 WSS 设备身份+scope；无本地 CLI 仍可用；文件/PTY/Browser/Computer 各子 Provider |
| `CapabilityRegistryPort` | `discover/inspect/import/assign/resolve/materialize/prove/revoke` → `CapabilityPlan/Receipt` | Core 保存 Skills/MCP/Rules/Hooks/Memory 的产品级真源，不以文件扫描/勾选冒充生效 |
| `MemoryPort` | `query/pin/share/revoke/delete` → `ScopedMemoryRefs` | Chat facts/长期 Bot Memory/Project Knowledge/Run evidence 区分，授权过滤 |
| `PolicyPort` | `check/ask/grant/revoke/enforcementEvidence` → `Decision/Grant` | User policy、ResourceGrant、Runtime sandbox、OS enforcement 四层独立 |
| `ArtifactPort` | `stage/verify/publishCandidate/review/accept/return` → `ImmutableArtifact` | 设备/Worker 回执、hash、owner、source refs、Review，不能直接信模型自报 |
| `IdentityPort` | `authenticate/authorize/workspaceScope/revokeSession` | 个人版也保存 owner/workspace/tenantNullable；团队/组织逐步启用 |
| `ExtensionHostPort` | `install/inspect/activate/health/disable/uninstall` | 新插件以隔离进程/运行端，未知插件不能在 LOOM Core 内裸执行 |

### 3.1 RuntimePort 的归一化状态与能力表

```text
RuntimeDescriptor { apiVersion, runtimeKind, packageDigest, os, arch, protocol,
  features: { stream, steer, cancel, resume, approval, mcp, skills, rules, hooks },
  limits, unavailableReasons[] }
RuntimeRunRequest { runAttemptId, snapshotId, runtimeBindingId, modelRef,
  workspaceBindingId?, effectiveCapabilitySnapshotId, grantRefs[], deadline }
RuntimeEvent { eventId, runAttemptId, seq, type:
  accepted|started|message|tool_requested|tool_result|approval_needed|checkpoint|
  settled|failed|cancelled|unknown_outcome, traceId, producerProof? }
```

- `prompt accepted` 只是确认请求；Pi RPC 等到原生 `agent_settled` 或等价稳定终态；DSH 采用其真实 SDK/ACP 终态，不伪造统一事件。
- 新适配器只新增 `RuntimeDescriptor` + `RuntimePort` + mapper + 独立 Contract Tests，**不修改 Bot/Goal/Device/Artifact 表结构**。
- RunAttempt 的完成不自动等于 Step 的验收。Provider/Runtime 切换必须创建新的 RunAttempt，旧尝试和回执永不覆盖。

### 3.2 DevicePort 与跨设备事实

```text
DeviceInvocation { id, goalId, stepId, runAttemptId?, actorId, ownerWorkspaceId,
  deviceId, connectionGeneration, workspaceBindingId, operation, boundedArgsDigest,
  resourceGrantRef, grantRevision, epoch?, idempotencyKey, state, deadline }
DeviceReceipt { invocationId, nodeId, generation, state, outputDigest?, evidenceRefs[],
  appliedGrantRevision, observedAt, signatureOrAuthBinding }
```

`state=unknown_outcome` 时对有副作用操作只能查询或人工恢复，**不能直接重放**。Windows 电脑控制另用 `controllerEpoch` 栅栏；macOS TCC、Linux Wayland/Portal、Windows 安全桌面均真实探测、缺授权就拒绝或降级，不能用一个 `online=true` 充数。

### 3.3 接口通用性：避免下一次重构

- 所有公开请求有 `apiVersion=loom.v2alpha1`，受控领域 ID、`expectedRevision`，错误统一 `unsupported/unavailable/not_authorized/conflict/needs_approval/timeout/unknown_outcome`；强制区分 **unsupported** 与 **失败**。
- `extensions` 只接受已注册 `namespace + version + schema`，不能凭未知字段增权；收敛 v1 时可做 typed SDK。
- 后端插件新增时先变 Manifest/Adapter/Schema/Contract tests；UI 只绑定通用视图，不添加 `if(runtime==='dsh')` 散落业务页面。
- **旧 API 可以废弃**，但持久数据先做导出+字段映射+影子读取+可回滚迁移。不要一次性直接删除已有 Mission/Thread、用户上传文件和原有凭据。
- 首期模块化 Core/进程隔离 Host，不为“未来企业”现在就强制十几个微服务。后期依据负载、tenant/隔离需要拆服务。

## 四、跨层执行示例：你发一句话，群 Bot 与工兵真的工作

```text
群聊: “Hanzi 负责 Octopus，Linxi 改 UI，让测试 Bot 验收”
  -> ChatRouter 只唤醒 Hanzi，记录来源
  -> Goal + Step DAG + Assignment (Lead=Hanzi，不自动高权限)
  -> ACCP 式 context snapshot + claim + lease/fence
  -> Agent Worker (RuntimePort Pi 或 DSH，在 Cloud 或某台本地机器)
  -> 需要电脑B文件/PTY -> DeviceInvocation (Device-only Node，无 Pi/DSH)
  -> 完成后返回 Receipt + Evidence/Artifact Candidate
  -> Coordinator 在事务提交后被唤醒，触发 QA/Review
  -> 不足则返工；需要用户决策则 Attention；最终用户接受
```

一个 Bot 可调度多个并行 RunAttempt；一个 Worker 可通过已授权的多 DevicePort 操作；一个 Device 也可选择性运行 Local Runner。这三项互不绑定。

## 五、评审与落地前必须冻结的六条不变量

1. Bot/Goal/Step/Team **与 RuntimeSession、Device 完全分离**；每个执行动作有确定责任主体。
2. GroupChat 不是协作数据库；聊天文本不取得权限，任务依赖/回执必须持久可审计。
3. 每 RunAttempt 固定 Model/Runtime/CapabilitySnapshot/Grant，重试不得悄悄升级模型或权限。
4. Core 只把凭据 **引用**分发给已授权最小隔离执行环境；未知 Extension/Hook 不在 Core 进程执行。
5. 真实证据 E0–E7，真实双物理机 E5 和故障恢复 E6 不能以同主机双进程、单测或 UI 假通过。
6. 当前 LOOM UI 的配色、三栏、Bot 群聊、工作/资产/流程/电脑基本保留；后端接口换代不等于 UI 重画。

## 六、这份提案尚不代表的事实

- 尚未实施新的 `BotTeam` / `AssignmentPort` / `RuntimePort V2` / `CapabilityRegistryPort`。
- 已验证 E3 是 Win 同机独立 Host→Device-only Node 文件链；E4 Bot→Artifact、E5 Linux↔另一物理 Windows/macOS、E6 故障恢复 **未验收**。
- 内置 Pi/DSH 哪个成为新默认 **尚未完成公平 bake-off**。
- 无需为了新提案立即切换或停止 `127.0.0.1:64851`；下一步按 [内核与能力勾选合同](loom-v2-runtime-bundles-and-capability-selection-proposal-2026-11-15.md) 与评审完成后再拆给 Pi 工兵。
