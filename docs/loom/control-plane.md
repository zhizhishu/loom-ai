# LOOM 控制层契约 v0.3

> 状态：阶段一已关闭（2026-10-27，Astra 终审 + 主管独立验证）。
> 原则：Rovai 是能用的完整产品，只做 ACCP 补全 + archify 流程视图。
> 证据：`docs/loom/accp-gap-analysis.md`（Pi 工兵盘点）、Astra 三轮审查结果。

## 阶段一交付与验证（已关闭）

| 交付 | 验证 | 结果 |
|---|---|---|
| TS 契约 `packages/contracts/src/loom.ts` | 本机 `pnpm typecheck`、`vitest` | 7 条契约回归通过 |
| Rust 只读投影 + 受控导入（迁移 218/219，schema 168/169） | bero `cargo test -p rovai-core --lib loom` | 12 passed / 0 failed |
| Core 端到端（真实二进制） | bero `node --test scripts/lib/loom-core-e2e.test.mjs` | 1 passed |
| 编排/交付 UI 接真数据 | 本机 Electron fixture | 8 场景通过 |
| 全量回归 | bero `cargo test -p rovai-core --lib` | 432 passed / 3 failed（基线 `33f6ded` 复现同样 3 个，属机器环境） |

已知未做：写路径为 `loom.plan.import` / `loom.task.release` / `loom.claim.acquire`；无 Candidate/Review；**claim 的 fence 只生成、尚无提交端校验**（失租防提交未闭环）；UI 仍是顺序卡片不是连线拓扑；品牌未换。

## 阶段二进度

| 切片 | 内容 | 状态 |
|---|---|---|
| 2.1 | 迁移 220 / schema 170：`loom_claim` + `loom.task.release` + `loom.claim.acquire`（原子、fence 单调、commandId 幂等、租约过期接管） | 已收（限"存储与 API 基础"，不含提交端 fencing） |
| 2.2 | Candidate + Review + 提交端 fence 校验 + 依赖首次释放冻结 | 未开始 |
| 2.3 | claim/Candidate 接入 UI | 未开始 |

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
