# LOOM 控制层契约 v0.4

> 状态：阶段一已关闭（2026-10-27）；阶段二 2.1 已收、2.2 已实现待终审（2026-10-28）。
> 原则：Rovai 是能用的完整产品，只做 ACCP 补全 + archify 流程视图。
> **接手请先读 `docs/loom/handoff-2026-10-28.md`**（实测数字、风险坑、认知陷阱都在那里；与本文件冲突以它为准）。

## 阶段一交付与验证（已关闭）

| 交付 | 验证 | 结果 |
|---|---|---|
| TS 契约 `packages/contracts/src/loom.ts` | 本机 `pnpm typecheck`、`vitest` | 7 条契约回归通过 |
| Rust 只读投影 + 受控导入（迁移 218/219，schema 168/169） | bero `cargo test -p rovai-core --lib loom` | 当时 12 passed / 0 failed（现已扩展至 32） |
| Core 端到端（真实二进制） | bero `node --test scripts/lib/loom-core-e2e.test.mjs` | 1 passed |
| 编排/交付 UI（fixture 数据） | 本机 Electron fixture | 8 场景通过（**未接真实 Core**） |
| 全量回归 | bero `cargo test -p rovai-core --lib` | 464 passed / 3 failed（基线 `33f6ded` 复现同样 3 个，属机器环境） |

## 阶段二进度

| 切片 | 内容 | 状态 |
|---|---|---|
| 2.1 | 迁移 220 / schema 170：`loom_claim` + `loom.task.release` + `loom.claim.acquire`（原子、fence 单调、commandId 幂等、租约过期接管） | 已收（限"存储与 API 基础"，不含提交端 fencing） |
| 2.2 | 迁移 221 / schema 171：`loom_candidate`（内容列不可改）+ `loom.candidate.record`，提交端 fence = 锁内取时 + claimId/fenceGeneration 双校验 | **Astra 终审 PASS**（`d360194` 修完 `claim_acquire` 锁前取时的 P2 后复审通过）；`cargo test --lib loom` 32 passed；全量 lib 464 passed / 3 环境失败（与基线 `33f6ded` 一致） |
| 2.3 → **A1** | Review / 人工验收 / 证据核验 / 依赖首次释放冻结 + 迁移 222/schema 172（`loom_review` 不可变、逐条结论、`loom.candidates.list`/`loom.reviews.list`/`loom.review.record`） | 未开始（`artifact_accepted` 边目前永不释放，属诚实未实现） |
| 2.3b → **A2** | 判定列防篡改：SQLite 触发器拒绝直接 UPDATE 内容列与判定列 | 未开始 |
| 2.4 → ~~B1~~ | claim/Candidate 接入 UI | **复核纠正：读路径已接真 RPC**（`LoomWorkspace.tsx:186`），无 mock 回退；仅缺非夹具的真实链路证据 |
| 2.5 → **B2** | archify 连线拓扑：SVG 连线层 + 依赖方向箭头 + 按依赖深度分的泳道 + 阻塞边标红 | **已收**（bero `pnpm test:loom-workspace` pass，断言 `edgeCount===3`/`dashedCount>=1`/`laneCount>=2`/图区 864→不溢出） |
| 2.5b → **B3** | 视觉打磨第一轮：状态中文化、列头「阶段 N」、左状态条、图例 footer、卡片抬升 | **已收**（同上夹具 pass，`legendItems===3`；截图为证） |
| 2.5c → **B3+** | 品牌层：LOOM 字标/主色、空状态插画、交付 tab 双徽章、移动端底部弹层 | 未开始 |

> 调整说明（2026-10-28 复核）：原顺序 2.3→2.4→2.5 会让用户长期看不到东西，改为 **A 线（后端）与 B 线（前端）并行**。完整评估、分工、UI 方案与四层验收见 [`handoff-2026-10-28.md`](handoff-2026-10-28.md) 附录。

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
