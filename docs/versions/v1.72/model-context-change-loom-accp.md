---
document_type: model-context-change
version: v1.72
revision: 2
confirmation_status: confirmed
confirmed_revision: 2
confirmed_by: local_user
confirmed_at: 2026-10-31
last_updated: 2026-10-31
---

# LOOM 编排入口：Agent CLI `rovai loom` 与 cli-operations 参考

本稿 r1 为 LOOM 独立副本补上 Agent 侧入口：Agent 通过 `rovai loom ...` 导入计划、放行、认领、登记证据、提交交付；User 仍是唯一验收方。设计与审计见 [`docs/loom/plan-accp-entry-2026-10-31.md`](../../loom/plan-accp-entry-2026-10-31.md)。

## 基线与依据

| 项目 | 内容 |
| --- | --- |
| 基线提交 | `17c28ea`（`zhizhishu/loom-ai` main） |
| 触发原因 | 新增模型可见的 CLI 帮助与封闭工具合同；修改共享平台 Skill `cli-operations` 正文与 reference（[治理规则](../../development/model-context-change-governance.md#触发范围)） |
| 实证缺口 | Host RPC `loom.plan.import` 等 5 个 Agent 侧写操作只被测试调用；`rovai --help` 无 loom 族；自带 Skill 无 LOOM 指引 |

## 变更前

1. `rovai --help` Agent operations 段（`crates/rovai-core/src/bin/rovai.rs` `root_help_text`）：

```text
Agent operations:
  rovai send
  rovai member list|get|create|update
  rovai task create|get|list|update
  rovai thread list|search|read|runs
  rovai history search
  rovai memory view|search|read|write
  rovai automation list|get|create|run|close|update|delete
  rovai mission list|get|update|status
```

2. 无 `loom.*` builtin 工具定义；`TEAM_TOOL_NAMES` 30 项。
3. `skills/cli-operations/SKILL.md` 的「Choose the result to preserve」表无 LOOM 行；References 无 LOOM 条目；`references/` 无 `loom.md`。
4. Bootstrap `[ROVAI_PLATFORM_SKILLS]` 索引：`cli-operations` 与 `memory-stewardship` 的 `name` + `desc`。

## 变更后

### CLI 根帮助

在 `rovai mission list|get|update|status` 之后插入一行，其余逐字不变：

```text
  rovai loom status|plan|release|claim|evidence|submit
```

### `rovai loom --help` 族帮助（完整文本）

```text
rovai loom

Use LOOM when a Mission needs a plan whose tasks, claims, deliveries and User acceptance stay on record.
The target is always the current Thread's Mission. Only the User accepts or rejects a delivery, in the Mission's Delivery tab.

  status    Read the current Mission's plan, tasks and claims.
  plan      Import the Mission's one plan (Default Lead only).
  release   Make a planned task claimable (Default Lead only).
  claim     Claim a released task for this Run.
  evidence  Register a file you produced as delivery evidence.
  submit    Submit a claimed task's delivery for User acceptance.

Use rovai loom <command> --help for arguments.
```

### 封闭工具合同（6 项，`TEAM_TOOL_NAMES` 30 → 36）

所有输入 `additionalProperties: false`。**输入中不存在** `missionId`、`agentRunId`、`claimantAgentId`、`commandId`、`claimId`、`fenceGeneration`、`contentHash`；它们由 Core 从认证 Run、当前 Thread 的 Mission 与持久记录注入。

| name | title | description | inputSchema |
| --- | --- | --- | --- |
| `loom.status` | Read the current Mission's LOOM plan | Read the current Mission's plan, tasks, dependencies and claims. Returns `plan: null` when no plan exists. | `{}` |
| `loom.plan` | Import the current Mission's plan | Import the current Mission's one LOOM plan. Default Lead only. A Mission accepts one plan; it cannot be replaced. Does not start work; release tasks and message members separately. | required `goal`(string 1–2000), `criteria`(array ≥1 of `{criterionId, text}`), `tasks`(array ≥1 of `{taskId, title, description?, assigneeAgentId?}`); optional `dependencies`(array of `{upstreamTaskId, downstreamTaskId, condition?: task_done\|artifact_accepted}`, default `[]`), `acceptanceCriteriaVersion`(string, default `"1"`). CLI 经 `--input-file` 传 JSON。 |
| `loom.release` | Release a planned task | Make a draft task claimable once its dependencies allow it. Default Lead only. | required `taskId` |
| `loom.claim` | Claim a task | Claim a released task for this Run. A later valid claim by another Run replaces an expired one. | required `taskId`; optional `leaseSeconds`(integer 1–3600, default 300) |
| `loom.evidence` | Register delivery evidence | Register a file you produced as evidence. `relativePath` is relative to this Mission's working directory; Core hashes the bytes on disk. | required `relativePath`; optional `taskId`, `contentType` |
| `loom.submit` | Submit a delivery | Submit this Run's claimed task for User acceptance with registered evidence. Does not accept the delivery. | required `taskId`, `evidenceIds`(array of strings); optional `previousCandidateId` |

每个工具的 `--help` 由既有 formatter 从上述定义生成，不手写额外文本。示例（`operation_help_examples`）：

```text
rovai loom status
rovai loom plan --input-file plan.json
rovai loom release --task-id t1
rovai loom claim --task-id t1
rovai loom evidence --relative-path out/report.md --task-id t1
rovai loom submit --task-id t1 --evidence-ids <artifactId>
```

### `skills/cli-operations/SKILL.md`

「Choose the result to preserve」表在 Mission 行后插入：

```text
| Mission plan, task claims, delivery evidence and User acceptance | LOOM |
```

References 列表在 Mission 条目后插入：

```text
- [LOOM](references/loom.md): plan a Mission, claim tasks and submit deliveries for User acceptance.
```

`name` 与 `description` frontmatter **逐字不变**。

### 新增 `skills/cli-operations/references/loom.md`（完整文本）

```markdown
# LOOM

LOOM keeps a Mission's plan, task claims, deliveries and the User's verdicts on record. The User sees them in the Mission's Orchestration and Delivery tabs. Every `rovai loom` command targets the current Thread's Mission.

## Who does what

| Step | Who | Command |
| --- | --- | --- |
| Check whether a plan exists | Anyone | `rovai loom status` |
| Import the plan | Default Lead | `rovai loom plan --input-file plan.json` |
| Make a task claimable | Default Lead | `rovai loom release --task-id <id>` |
| Ask a member to take a task | Default Lead | `rovai send --to <member>` with the task id |
| Claim the task before working | Assignee | `rovai loom claim --task-id <id>` |
| Register each produced file | Assignee | `rovai loom evidence --relative-path <path> --task-id <id>` |
| Submit the delivery | Assignee | `rovai loom submit --task-id <id> --evidence-ids <artifactId>` |
| Accept or reject | User only | Delivery tab |

## Plan

Read `rovai loom status` first. A Mission accepts one plan and it cannot be replaced, so draft it from the Mission's full definition (`rovai mission get`) before importing. Write 2–8 tasks a member can finish and hand over; give each acceptance criterion a short stable `criterionId`. Use `task_done` dependencies for ordering and `artifact_accepted` only when the downstream task needs the User-accepted output.

## Deliver

Claim before working; a claim lease expires, so claim again if a long task outlives it. Register only files you produced inside the Mission's working directory, then submit with the returned artifact ids. Submitting proves the delivery is recorded, not that it is accepted. Tell the User in the Thread that a delivery awaits acceptance; do not set the Mission `completed` before the User accepts.

Follow `error.recovery` on failure; see [Recovery](recovery.md).
```

### 证据根（非模型可见，记录于此便于核对）

`loom.evidence` 与证据核验统一以当前 Mission 处于 `ready` 的 `mission_workspace.working_directory` 为根；没有隔离工作区时回落到 `camp.project_path`（现行为）。工作区清理后再核验报 `LOOM_EVIDENCE_UNREADABLE`，不静默换根。

## 明确不变

- Bootstrap `[ROVAI_PLATFORM_SKILLS]` 字节不变：平台 Skill 集合仍为 `cli-operations`、`memory-stewardship`，二者 `name`/`desc` 逐字不变；`SESSION_CHARTER`、`MEMBER_IDENTITY`、Memory Entrypoint、Dynamic Context section 与预算均不变。
- Host stdio RPC `loom.*` 方法签名与 web 准入（10 项）不变；验收（review/verification）仍不对 Agent 开放。
- 其他工具族的帮助、合同与输出逐字不变。

### 版本和生效策略

- 新工具与帮助随新二进制生效；已存在的 Native Session 不需重建 Bootstrap。
- 受管 Skill 目录按既有 `ManagedSkills::sync` 在下次 Core 启动覆盖为新版本。
- 工具输出合同新增金样 `crates/rovai-core/tests/fixtures/builtin-tool-agent-output-v15.json`，旧金样保留。

## 二次确认

开发者（User，`local_user`）于 2026-10-31 在本会话看过 r1 要点（6 个 `rovai loom` 命令、cli-operations 新增 LOOM reference、启动内容与验收权不变）后，经问答选项明确选择「确认，按 r1 实施」。此前两项方向性选择（加编排说明书；证据根统一用队员实际干活的目录）亦由 User 当场选定。语义改动须递增 revision 并重新确认。

## 验证

### 确定性验收

- 身份注入：payload 夹带 `missionId` / `agentRunId` 被 schema 拒；跨 Mission 的 `taskId` 被拒；无 Mission 的 Thread 与 Single Chat 明确报错。
- 权限：非 Default Lead 调 `plan` / `release` 被拒；`submit` 无本 Run 有效认领被拒；过期认领被拒。
- 幂等：同一工具调用重放（含回放缓存淘汰后）不产生第二份计划 / 放行 / 认领 / 候选。
- 证据：越界路径与软链被拒；worktree Mission 在工作区内登记成功并可核验。
- CLI：根帮助、族帮助与本稿逐字一致；`TEAM_TOOL_NAMES` 36 项穷举测试通过。
- 回归：bero 全量 `cargo test -p rovai-core`（只余 3 个已知基线失败）、`--lib loom`、`pnpm test:loom-core`、`pnpm typecheck`、`pnpm docs:check`；GitHub Actions Linux 与 Windows 打包全绿。

### 真实任务 Gate

User 在 Win11 已装 App 中：开 Mission → 让 Default Lead 规划 → 编排 tab 出现任务图 → 队员提交 → 交付 tab 出现候选 → User 验收。若 Agent 未自发使用 LOOM（`cli-operations` 描述未提及 LOOM），记录为 r2 候选：在描述中加入 LOOM 并按 Bootstrap 版本轴处理。

### 实施验收记录

在 `17c28ea` 基线上实施，提交 `e642e26`（实现）+ `8aa8e7e`（rustfmt），快进合入 `main`。实现与 r1 逐项一致：根帮助新增一行、`rovai loom --help` 族帮助逐字等于本稿（`bin/rovai.rs` 测试钉住）、6 项封闭工具合同（定义集中在 `crates/rovai-core/src/loom_tool.rs`）、`cli-operations` 正文两行 + `references/loom.md` 逐字等于本稿；平台 Skill 集合与 `name`/`desc` 未改。合同版本号保持 `contract-v44` / Agent output 14，新增金样 `builtin-tool-agent-output-v15.json`（v13 + 6 项 LOOM），v13 保留。

| 检查 | 结果 |
| --- | --- |
| bero `cargo fmt --all -- --check` | 通过 |
| bero `cargo test -p rovai-core --lib loom` | 82 通过 / 0 失败（含身份注入、Lead 限定、跨 Mission、认领缺失、重放、worktree 证据根） |
| bero `--lib builtin_tool` / `--lib team_tool` / `--bin rovai` / `--lib skill` | 29 / 10 / 31 / 17 通过，0 失败 |
| bero 全量 `cargo test -p rovai-core --lib` | 514 通过 / 3 失败（恰为既有 `database_admission` 环境基线）/ 1 ignored |
| bero `pnpm test:loom-core` | 2 通过 / 0 失败 |
| 本机 `pnpm typecheck`、builtin-tools vitest、`pnpm docs:check` | 0 错 / 41 通过 / 通过 |
| GitHub Actions CI（分支 `41220081638`、main `41220601142`） | 全绿 |
| GitHub Actions Windows 打包 `41220605557` | 通过；`Rovai-AI-0.5.1-x64.exe` sha256 `89882b0a…72e24685`，verifier `Result: passed` |

`pnpm docs:test` 有 1 项既有失败（`4b5d3a4` 给 `ci.yml` 加了 main push 触发），与本改动无关，未在本次修改。

**真实任务 Gate**：待 User 在 Win11 重装后执行（见上）。

## r2 修订（2026-10-31，已二次确认）

起因：实施后审查（`docs/loom/plan-accp-entry-2026-10-31.md` §9）发现：有先后的任务在上游被 User 验收后无人接力；`loom.release` 描述「once its dependencies allow it」与实际不符（`task_release` 只要求 DRAFT，依赖闸在 `claim_acquire`）；`taskId` 在整个数据库唯一（`plan_import` 撞 `LOOM_TASK_EXISTS`），r1 示例的 `t1` 会让第二个使命导入失败。User 选「A：验收后 User 回一句继续，由 Lead 接上」。

只改模型可见文本，不改工具 schema、权限、身份注入或领域行为。

### `loom.release` description

变更前：

```text
Make a draft task claimable once its dependencies allow it. Default Lead only.
```

变更后：

```text
Make a draft task claimable. Default Lead only. Releasing does not check dependencies; claiming a task whose dependencies are not yet met returns loom.dependency_unreleased.
```

### `rovai loom --help` 族帮助

只改 `release` 一行：

```text
  release   Make a planned task claimable (Default Lead only).
```

变更后：

```text
  release   Make planned tasks claimable (Default Lead only).
```

### `operation_help_examples`

变更前 `t1`，变更后用 Mission 专属前缀：

```text
rovai loom release --task-id report-draft
rovai loom claim --task-id report-draft
rovai loom evidence --relative-path out/report.md --task-id report-draft
rovai loom submit --task-id report-draft --evidence-ids <artifactId>
```

### `references/loom.md`（r2 完整文本，替换 r1）

```markdown
# LOOM

LOOM keeps a Mission's plan, task claims, deliveries and the User's verdicts on record. The User sees them in the Mission's Orchestration and Delivery tabs. Every `rovai loom` command targets the current Thread's Mission.

## Who does what

| Step | Who | Command |
| --- | --- | --- |
| Check whether a plan exists | Anyone | `rovai loom status` |
| Import the plan | Default Lead | `rovai loom plan --input-file plan.json` |
| Make every task claimable | Default Lead | `rovai loom release --task-id <id>` for each task |
| Ask a member to take a task | Default Lead | `rovai send --to <member>` with the task id |
| Claim the task before working | Assignee | `rovai loom claim --task-id <id>` |
| Register each produced file | Assignee | `rovai loom evidence --relative-path <path> --task-id <id>` |
| Submit the delivery | Assignee | `rovai loom submit --task-id <id> --evidence-ids <artifactId>` |
| Accept or reject | User only | Delivery tab |
| Continue after acceptance | Default Lead | `rovai loom status`, then message the next assignees |

## Plan

Read `rovai loom status` first. A Mission accepts one plan and it cannot be replaced, so draft it from the Mission's full definition (`rovai mission get`) before importing. Write 2–8 tasks a member can finish and hand over; give each acceptance criterion a short stable `criterionId`. Task ids are unique across every Mission, so start each with a word from this Mission, such as `report-draft`, never a bare `t1`. Use `task_done` dependencies for ordering and `artifact_accepted` only when the downstream task needs the User-accepted output.

After importing, release every task. Releasing does not wait for dependencies; a task whose dependencies are not met cannot be claimed yet. Message only the assignees whose tasks have no unmet dependencies.

## Deliver

Claim before working; a claim lease expires, so claim again if a long task outlives it. If the claim returns `loom.dependency_unreleased`, do not retry: end the Run and tell the Default Lead the task is waiting. Register only files you produced inside the Mission's working directory, then submit with the returned artifact ids. Submitting proves the delivery is recorded, not that it is accepted. Tell the User in the Thread that a delivery awaits acceptance; do not set the Mission `completed` before the User accepts.

## Continue after acceptance

The User's acceptance does not start anyone. When a dependent task is waiting, ask the User in the Thread to reply after accepting. On that reply, the Default Lead reads `rovai loom status` and messages each assignee whose dependencies are now met.

Follow `error.recovery` on failure; see [Recovery](recovery.md).
```

### r2 二次确认

开发者（User，`local_user`）于 2026-10-31 在本会话看过 r2 五点要点（放出全部任务、领到未轮到的任务就结束并告知 Lead、验收后回一句「继续」由 Lead 接力、任务编号带 Mission 专属词、改正 release 描述）后，经问答选项明确选择「确认，按 r2 实施」；此前已选「A：你回一句继续就接上」。

### r2 明确不变

`cli-operations` 的 `name` / `description` 与 SKILL.md 两行、根帮助、6 项工具的名称与 inputSchema/outputSchema、身份注入、权限、平台 Skill 集合与 Bootstrap 字节均与 r1 相同。

### r2 验证

- `bin/rovai.rs` 族帮助测试、`references/loom.md` 打包内容与本节逐字一致；`team_tool_catalog` / `builtin_tool` 测试通过。
- bero `--lib loom` 与全量回归、CI、Windows 出包。
- 真实任务 Gate 增加：两步依赖计划中，User 验收上游后回一句「继续」，Lead 派出下游任务并完成交付。
