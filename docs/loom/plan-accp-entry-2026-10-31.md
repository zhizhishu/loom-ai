# LOOM 方案 A：给助手补 ACCP 入口（2026-10-31 设计草案）

> 状态：草案，待 Astra 只读审计补全改动清单。用户已选方案 A（助手自己编排，用户只验收）。

## 1. 问题（已实证）

- 5 个 agent 侧写操作（`loom.plan.import` / `loom.task.release` / `loom.claim.acquire` / `loom.candidate.record` / `loom.artifact.register`）只挂在 Host stdio RPC（`application.rs` 约 9521 行起），**唯一调用方是测试** `scripts/lib/loom-core-e2e.test.mjs`。
- 助手实际能用的 `rovai` CLI（`crates/rovai-core/src/bin/rovai.rs`）没有 loom 族；自带 skill（`skills/`）无 loom；web 按设计不准入。
- 结果：真实使用中「编排」tab 永远是「尚未配置编排」。阶段书 W 阶段 2 第 4 步卡在这里。

## 2. 形态决定

新增 **builtin tool 族 `loom.*`**，走与 `mission.*` 完全相同的通道：

`rovai loom <verb>` → 本地 IPC → `application.rs` builtin tool 分发（带 `authenticated_run`）→ 复用 `rovai_core::loom::*` 现有领域函数。

Host stdio RPC 的 `loom.*` 方法**不动**（桌面 UI 与测试继续用）。

| CLI | 工具名（暂定） | 领域函数 | 读/写 |
|---|---|---|---|
| `rovai loom status` | `loom.status` | plan.get + tasks.list + claims.list 汇总 | 读 |
| `rovai loom plan --file <json>` | `loom.plan` | `plan_import` | 写 |
| `rovai loom release --task-id <id>` | `loom.release` | `task_release` | 写 |
| `rovai loom claim --task-id <id>` | `loom.claim` | `claim_acquire` | 写 |
| `rovai loom evidence --path <rel> [--task-id]` | `loom.evidence` | `artifact_register` | 写 |
| `rovai loom submit --task-id <id> --evidence-id ...` | `loom.submit` | `candidate_record` | 写 |

验收（review / verification）**不给助手**：仍只由用户在「交付」tab 裁决。

## 3. 身份与作用域（安全边界，硬要求）

- `missionId` **不出现在输入 schema**，一律由 `mission_for_camp(authenticated_run.camp_id)` 注入；当前 Thread 无 Mission → 明确错误码。助手无法跨 Mission 写。
- `agentRunId` / `claimantAgentId` 由 `authenticated_run` 注入，payload 不可夹带。
- `commandId` 由 `runtime_tool_call_id` 派生，保证重放幂等。
- `submit` 的 `claimId` / `fenceGeneration` 由 Core 查本 Run 在该任务上的有效认领得出，助手不传。
- `plan` / `release` 限主助手（参照 `team.create_task` 的 "User/Default Lead only" 实现方式）。

## 4. 冻结边界

优先**零改动** `loom.rs` / `db_loom.rs` / `db.rs` / `packages/contracts/src/loom.ts` / 迁移。若确需改，由主管亲手改并单独送审。

## 5. 自带 skill

`skills/loom/SKILL.md`：教队长 收到使命 → `rovai loom status` → 拆计划 `rovai loom plan` → `release` → 用 `rovai send` 派队员；队员 `claim` → 干活 → `evidence` → `submit`；之后提示用户去「交付」tab 验收。

## 6. 验收（完成判据）

1. bero：`cargo test -p rovai-core`（全量只剩 3 个基线失败）+ `--lib loom` + 新增身份注入测试 + CLI help/契约测试 + `pnpm test:loom-core`。
2. GitHub Actions Linux 全绿 + Windows 打包绿。
3. 用户 Win11 重装后：开使命 → 对叮叮说「帮我规划」→「编排」tab 出现任务图 → 队员交付后「交付」tab 出现候选 → 用户点验收，状态变「已验收」。

## 7. 待 Astra 补全

见派工任务；结论回填本文件 §8。

## 8. Astra 审计结论（PLAN-OK，pi-skill session `67b92d52`，主管已逐条抽查）

**工具族定稿（6 个）**：`loom.status` / `loom.plan` / `loom.release` / `loom.claim` / `loom.evidence` / `loom.submit`。输入 schema（均无 `missionId` / `agentRunId`）：

| 工具 | 输入 |
|---|---|
| `loom.status` | `{}` |
| `loom.plan` | `--input-file`：`{goal, acceptanceCriteriaVersion, criteria[], tasks[], dependencies[]}` |
| `loom.release` | `{taskId}` |
| `loom.claim` | `{taskId, leaseSeconds?}` |
| `loom.evidence` | `{relativePath, taskId?, contentType?}` |
| `loom.submit` | `{taskId, evidenceIds[], previousCandidateId?}` |

**改动面**：`bin/rovai.rs`（族识别 / help / 示例 / 测试）、`team_tool.rs`（`[&str;30]`→36）、`team_tool_catalog.rs`、`builtin_tool_transport.rs`、`builtin_tool_cli_output.rs`（新金样 `tests/fixtures/builtin-tool-agent-output-v15.json`）、`builtin_tool_evidence_projection.rs`、新 `loom_tool.rs`（身份 / 权限 / 哈希）+ `lib.rs` 注册、`application.rs` 分发与错误映射、桌面 `builtin-tools.ts`（+测试）、`LoomWorkspace.tsx` 变更后回读、`scripts/smoke-builtin-cli.mjs`、`loom-core-e2e.test.mjs`、文档门禁 `docs:test` / `docs:check` / `docs:check:ci`。

**主管抽查属实的三处风险**：

1. **重放幂等**：CLI 每次新生成 `request_id`（`bin/rovai.rs:177-184`）；回放缓存有容量淘汰（`builtin_tool_runtime.rs:627`）；`plan_import` / `task_release` 无 `commandId`（`loom.rs:387,872`）。→ 需冻结例外：把两者事务体抽出，接 `command.rs` 的 Gateway 持久回执；Host RPC 签名不变。主管亲写。
2. **证据根不一致**：登记 / 核验根是 `camp.project_path`（`loom.rs:2018`），Git 隔离的 Run cwd 是 worktree（`application/mission.rs:581`）。→ 未决：二选一（a）登记 / 核验统一改用冻结的 Mission 执行根（需兼容旧产物）；（b）第一版只在非 worktree 使命开放 `loom.evidence`，worktree 时明确报错。
3. **模型上下文治理**：新增自带 skill 改变模型可见的技能索引，触发 `docs/development/model-context-change-governance.md`，须在 `docs/versions/<current>/model-context-change.md` 写独立变更说明并由**开发者（用户）二次确认**后才能实施。CLI 子命令本身走 `rovai --help`（Charter 已教，`resources/charter-rovai-cli.md:3`），不改 Bootstrap。

**权限**：`plan` / `release` 照 `collaboration.rs` 的活跃写权限 + 当前 Default Lead 判定，不只看角色名；`claim` / `evidence` / `submit` 要求当前公开 Mission Run，`submit` 另需本 Run 在该任务上的有效认领（`claims_list` 筛选后由领域事务再核 fence）。

**切片**：flash 做映射 / help / 金样 / 展示 / 冒烟；主管写身份、权限、事务重放、路径与哈希、冻结文件、合同。
