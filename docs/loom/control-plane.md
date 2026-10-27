# LOOM 控制层契约 v0.2

> 状态：基于 Pi 工兵 ACCP 盘点 + Astra UI 审查的最终草案。
> 原则：Rovai 是能用的完整产品，只做 ACCP 补全 + archify 流程视图。
> 证据：`docs/loom/accp-gap-analysis.md`（Pi 工兵盘点）、Astra UI 审查结果。

## 从 ACCP 直接抄的机制

| ACCP 概念 | 实现方式 | 落点 |
|---|---|---|
| **Task 状态机** | DRAFT → READY → BLOCKED → IN_REVIEW → DONE / CANCELED | 扩展 `MissionStatus`，新建 `LoomTaskStatus` |
| **DAG 依赖边** | `task_dependencies` 表，条件：`TASK_DONE` / `ARTIFACT_ACCEPTED` | 新建 `LoomDependency` |
| **依赖释放** | `taskReady()` 一条 SQL 求值，首次满足即冻结 | 新建 `loomTaskReady()` |
| **人工验收** | `reviewTask()`：Owner 专属、IN_REVIEW 才可审、必须最新 attempt、验收标准全 true | 新建 `loomReviewTask()` |
| **Artifact 两段状态** | `verification_status` × `acceptance_status`，不可变审核记录 | 新建 `LoomCandidate` + `LoomReview` |
| **证据链溯源** | 服务端补全 task/run/session/agent/owner/snapshot，跨 Run 引用需 VERIFIED+ACCEPTED | 新建 `LoomEvidence` |

## 从 ACCP 改抄的机制

| ACCP 概念 | 调整原因 | 落点 |
|---|---|---|
| **Run attempt + fencing_token + lease** | Rovai 已有 `responsibilityGeneration` 代次去重，扩展为 attempt 计数 | 扩展 `AgentRunView` |
| **ContextSnapshot** | Rovai 已有 `ContextManifestView`（digest 冻结），扩展为含计划/节点修订/验收标准 | 扩展 `ContextManifestView` |
| **审批桥** | Rovai 已有 `ActionApprovalView`（目标人+version+epoch fence），扩展为图 gate | 扩展 `ActionApprovalView` |

## 不抄的 ACCP 机制

- ContextVersion/API_DOCUMENT 体系（太重，绑 ACCP API 契约场景）
- outbox/event_feed/event_inbox（对本地单机过重）
- maintenance/recovery_items（Rovai 已有恢复机制）

## UI 落点

- **编排 tab**：archify 流程图显示 Task 依赖，点节点看合同/状态/证据
- **交付 tab**：真实验收记录 + 接受/打回操作（替代现在的“未接入”占位）
- **不加新页面、不加新导航**，Rovai 的 Mission UI 骨架不动

## 不变量

1. Agent 身份 ≠ 原生 Session ≠ AgentRun ≠ 进程
2. 输入被接受 ≠ 完成 ≠ 核验通过 ≠ 人工验收
3. 取消请求 ≠ 进程静止；失租 ≠ 进程已停
4. Mission `completed` ≠ 业务验收通过
5. 审批（工具权限）≠ 验收（业务结论）
6. 不自动重试；幂等提交、原子 claim、过期写拒绝是首版硬要求
