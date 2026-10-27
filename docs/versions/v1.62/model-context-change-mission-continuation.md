---
document_type: model-context-change
version: v1.62
change_id: mission-continuation-charter
revision: 3
confirmation_status: confirmed
confirmed_by: local_user
confirmed_at: 2026-09-20T06:12:44Z
confirmed_revision: 3
confirmation_source_message_id: 5f0ee125-154a-4155-8dad-5581d1bd7b27
authority: confirmed-model-input-change-statement
implementation_baseline: 20f35163090d0b0a5a78fc188fa881d440a19df3
implementation_status: completed
supersedes_revision: 2
last_updated: 2026-09-20
---

# Mission 续作提示：模型输入变更（revision 3）

本 revision 取代 revision 1 的“每个新 Run 注入 WORKSPACE”和 revision 2 的“压缩后补发
WORKSPACE”方案。两套 WORKSPACE／compaction 方案均撤销且不得实施；本 revision 只在 Mission
专属 Session Charter 中增加一条续作说明。

开发者在完整 revision 3 可见后，通过 Camp 消息
`5f0ee125-154a-4155-8dad-5581d1bd7b27` 明确要求快速完成、创建 PR 并合入 `main`，因此本 revision
已取得二次确认并进入实施。此前 revision 均未取得确认，不能授权任何被本 revision 撤销的实现。

## 变更前

### Mission 专属 Session Charter（revision 10）

```text
Rovai Mission Contract

- All current members may use `rovai mission get|update|status` to maintain this Camp's Mission.
- Use `rovai mission get` when the current Mission's full definition is missing or outdated; judge completion against that definition.
- Change status only when the whole Mission's state changes, not merely when your Run ends.
```

只有当前 Camp 拥有 Mission 时才追加该块；普通 public Camp 不追加，Single Chat 使用独立 Charter。
该块只随 Native Session Bootstrap 交付，已经冻结的 Bootstrap 不原位改写。

## 变更后

### Mission 专属 Session Charter（revision 11）

```text
Rovai Mission Contract

- All current members may use `rovai mission get|update|status` to maintain this Camp's Mission.
- Use `rovai mission get` when the current Mission's full definition is missing or outdated; judge completion against that definition.
- The Mission working directory is already prepared. Continue follow-up work there on its current checkout by default. Do not create or switch branches, or create another Worktree, merely because a new Run starts, context is compacted, or more changes are requested. Follow explicit user requests for a different branch or baseline.
- Change status only when the whole Mission's state changes, not merely when your Run ends.
```

与 revision 10 相比只新增第三条，位置固定在 `mission get` 说明之后、状态说明之前。不增加第二条
“这不是分支锁”的解释，也不在 Bootstrap 中说明门禁、缓存、清理、digest、压缩检测或重投递实现。

Session Charter revision 从 10 递增到 11，并继续进入既有 Native Binding compatibility digest。
已有 Mission 的下一次新 Run 通过既有兼容性协调取得 revision 11；历史 Run、既有 Session 的冻结
Bootstrap evidence、Manifest 和 payload bytes 均不改写。

## 明确不变

- `[WORKSPACE]` 的 section 位置、JSON shape、事实来源、accepted digest 与发送条件全部不变。
- 不增加压缩后 WORKSPACE 补发；不修改任何 Runtime compaction event、detector policy、observer lease、
  redelivery requirement、Delivery ACK 或恢复路径。
- 不修改 Mission 工作区准备、当前 checkout、分支创建／切换／清理、累计 Diff 或运行准入；新增句是默认续作
  指导，不是分支锁。用户明确要求不同 branch 或 baseline 时仍遵从该请求。
- Mission definition、status、attachments、`mission get|update|status` 的输入输出和权限不变。
- `COLLABORATION_STATE`、`SELF_ACTIVE_TASKS`、`SHARED_CONVERSATION`、`RUN_FACTS`、`WORKSPACE`、
  `RUN_INPUT` 的 shape、顺序、选择、预算和证据不变。
- 普通 public Camp 与 Single Chat Charter 的模型可见 bytes 不变。

## 版本、迁移、恢复与兼容

| 轴 | 变更后 |
| --- | --- |
| Native Session Bootstrap contract / Formatter | v3 / 3，不变 |
| public Session Charter | revision 11 |
| public AgentRun Context Formatter / ContextManifest / Profile | 27 / 27 / 8，不变 |
| public Run Facts | 5，不变 |
| Single Chat Formatter / Manifest / Profile / Run Facts | 25 / 25 / 6 / 4，不变 |
| Bootstrap Redelivery Envelope / Formatter | 2 / 2，不变 |
| Built-in Tool Contract / CLI | 30 / 30，不变 |
| data contract / projection schema | v1.61 / 116，不变 |

不需要数据库 Migration、历史数据转换、ContextManifest 升版或 Profile 升版。新的 Charter revision 进入
既有 Binding compatibility digest，使不兼容的后续执行使用新 Bootstrap；恢复同一历史 Run 仍使用原冻结输入。
当前 ContextManifest Evidence 合同只更新 Mission Charter 的完整文本和 revision 号，不改变任何字段级协议。

## 验证

按开发者“不要做太多测试”的要求，只执行与本次单句变更直接相关的最小集合：

1. 扩展既有 `session_charter_publishes_one_cli_only_builtin_contract`，逐字断言四条 Mission block、
   新句位置和唯一性，并保留普通 Camp 负向断言；既有 Single Chat 负向断言继续覆盖隔离边界。
2. 更新既有 `binding_contract_freezes_each_context_axis_version`，断言 revision 11 进入 compatibility digest。
3. 运行上述两个 Rust 定向测试、`cargo fmt --all -- --check`、`pnpm docs:check` 与 `git diff --check`。
4. 创建合入 `main` 的 PR；不在本地扩大为全量测试、Runtime smoke 或 App 构建，远端 required checks 通过后合并。

## 二次确认

开发者在本 revision 的完整前后合同通过 Camp 附件可见后，于 `2026-09-20T06:12:44Z` 明确要求实施、
创建 PR 并合入 `main`。确认来源为消息 `5f0ee125-154a-4155-8dad-5581d1bd7b27`，确认 revision 为 3。
任何语义调整都必须再次递增 revision 并重新确认。

## 实施收口

revision 3 已按确认文本实现：Mission 专属 Session Charter 只增加指定续作句，Session Charter revision
已轮换到 11；WORKSPACE、Runtime compaction、Formatter/Manifest/Profile、数据库与 Migration 均未改变。

既有 Charter owner 以 `slow-tests` feature 精确执行 1/1 passed，既有 Binding contract owner 1/1 passed；
`cargo fmt --all -- --check`、`pnpm docs:test`、`pnpm docs:check`、以最新 `origin/main` 为 base 的
`pnpm docs:check:ci` 与 `git diff --check` 均通过。PR 继续以远端 required checks 作为合入门槛。
