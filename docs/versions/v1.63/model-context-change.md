---
document_type: model-context-change
version: v1.63
change_id: task-help-routing-charter
revision: 1
confirmation_status: confirmed
confirmed_by: local_user
confirmed_at: 2026-09-21T14:10:22Z
confirmed_revision: 1
confirmation_source_message_id: bd949a18-3094-4c6f-931e-e5eaf5fafd21
authority: confirmed-model-input-change-statement
implementation_status: completed
last_updated: 2026-09-21
---

# Task help 路由：模型输入变更（revision 1）

开发者先在消息 `64d2118a-d9b5-44b2-8cc3-bf8d20c62b4e` 给出完整前后文本及边界，随后在消息
`bd949a18-3094-4c6f-931e-e5eaf5fafd21` 明确要求实施完整版本切换，因此 revision 1 已取得二次确认。

## 变更前

Session Charter revision 11 的 Built-in CLI help 条目为：

```text
- Use `rovai --help` when the operation is unclear, and consult the selected operation's exact `--help` when the required syntax is unclear. Reuse help already available in the current Native Session when possible. Do not assume that a command family has its own help entry.
```

## 变更后

Session Charter revision 12 的对应条目完整替换为：

```text
- Use `rovai --help` to choose an operation and its exact `--help` for syntax. Reuse help already available in the current Native Session.
```

这里只删除与新增 `rovai task --help` 冲突的绝对提示并压缩同一条规则。Charter 不增加 Task 字段、历史数据、
输出裁剪、权限矩阵或操作流程段落。

## 明确不变

- Built-in CLI Contract 的标题、operation catalog、单一输入来源、Send publication、`public-only`、Agent
  addressing、Principal attention 与提交证明条目逐字不变。
- Mission Contract、Authority boundaries、Member Identity、Memory Entrypoint 和 Adapter-specific guidance 不变。
- `COLLABORATION_STATE`、`SELF_ACTIVE_TASKS`、`SHARED_CONVERSATION`、`RUN_FACTS`、`WORKSPACE` 与
  `RUN_INPUT` 的 shape、顺序、选择、预算和证据不变。
- 具体 Task 参数仍由 exact operation help 拥有；Task family help 只是 operation index。

## 版本、迁移、恢复与兼容

| 轴 | 变更后 |
| --- | --- |
| Native Session Bootstrap / Formatter | v3 / 3，不变 |
| public Session Charter | revision 12 |
| public AgentRun Formatter / ContextManifest / Profile | 27 / 27 / 8，不变 |
| Single Chat Formatter / Manifest / Profile | 25 / 25 / 6，不变 |
| Built-in Tool / CLI / Agent Output | 31 / 31 / 4 |
| data contract / projection schema | v1.63 / 117 |

Charter revision 进入既有 Native Binding compatibility digest，使后续不兼容 Binding 使用新 Bootstrap；历史
Run、已冻结 Bootstrap evidence、Manifest 和恢复 payload 不改写。Migration 167 只调整 Task 数据约束，不
修改 Context 表。旧 v30 CLI context 与 v31 Core 不混用。

## 验证

1. Charter 单元测试逐字断言替换后的完整条目，并确认旧绝对提示不存在。
2. Binding contract 测试断言 revision 12 进入 compatibility digest。
3. CLI 测试断言 `rovai task --help` 的固定文本与成功路由，其他 family 仍走既有无效输入路径。
4. 运行 Rust、Skill、文档与 diff-aware 门禁；远端 required checks 通过后才合入 `main`。

## 二次确认

开发者在完整前后文本与版本切换缺口可见后，于 `2026-09-21T14:10:22Z` 明确要求实施，并指定旧
reconciliation payload 直接拒绝。确认来源为消息 `bd949a18-3094-4c6f-931e-e5eaf5fafd21`，确认
revision 为 1。任何模型可见语义调整都必须递增 revision 并重新确认。

## 实施收口

revision 1 已按确认文本实现；没有新增其他 Charter 条目，也没有改变 Formatter、Manifest、Profile 或动态
上下文。实际验证结果由本版[实施计划](implementation-plan.md)和 PR 门禁记录。
