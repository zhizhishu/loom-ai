---
document_type: model-context-change
version: v1.61
change_id: mission-completion-judgment
revision: 1
confirmation_status: confirmed
confirmed_by: local_user
confirmed_at: 2026-09-19T14:52:47Z
confirmed_revision: 1
confirmation_source_message_id: 1df59027-9aac-4427-a973-6b2faa981483
authority: confirmed-model-input-change-statement
implementation_baseline: 27e117205722a03c6945ffdc3e418d572776c809
implementation_status: completed
last_updated: 2026-09-19
---

# Mission 完成判断：模型输入变更（revision 1）

开发者在 Mission 中保存了完整逐字方案与验收口径，随后明确要求当前 Agent 独立完成 PR 并合入
`main`。来源消息发生在完整方案可见之后，因此确认本说明 revision 1；它不是由实现者自行确认。

本变更只扩充 Mission 专属 Session Charter 追加块，让 Agent 在定义缺失或过时时显式读取完整
Mission，并始终以完整定义判断整体是否完成。它不形成固定操作序列，不改变普通 Camp 或 Single
Chat Bootstrap，也不改变权限、状态、CLI、调度、动态 Context、Manifest 或 Evidence schema。

## 二次确认

开发者通过 Camp 消息 `1df59027-9aac-4427-a973-6b2faa981483` 明确要求完成已经保存的 Mission、创建
PR 并合入 `main`。该消息创建于 `2026-09-19T14:52:47Z`，确认本说明 revision 1。任何语义调整都必须
递增 revision 并重新取得开发者确认。

## 变更前

### Mission 专属追加块（Session Charter revision 9）

```text
Rovai Mission Contract

- All current members may use `rovai mission get|update|status` to maintain this Camp's Mission.
- Change status only when the whole Mission's state changes, not merely when your Run ends.
```

### 选择与版本轴

- 只有当前 Camp 拥有 Mission 时才追加该块；普通 Camp 不追加，Single Chat 在该判断前返回自己的独立 Charter。
- Native Session Bootstrap 为 v3，Bootstrap Formatter 为 3，public Session Charter revision 为 9。
- public Context Formatter/ContextManifest 为 26，Single Chat Context Formatter/ContextManifest 为 25。
- Run Facts 为 5，Built-in Tool Contract/CLI 为 29，IPC 为 2，Envelope 与 receipt 为 1。

## 变更后

### Mission 专属追加块（Session Charter revision 10）

```text
Rovai Mission Contract

- All current members may use `rovai mission get|update|status` to maintain this Camp's Mission.
- Use `rovai mission get` when the current Mission's full definition is missing or outdated; judge completion against that definition.
- Change status only when the whole Mission's state changes, not merely when your Run ends.
```

### 选择与版本轴

- 追加条件与位置不变；普通 Camp 和 Single Chat 的模型可见正文逐字不变。
- 只把 public Session Charter revision 从 9 递增到 10，并按既有机制轮换新 Binding compatibility/digest。
- Native Session Bootstrap、Bootstrap Formatter、public/Single Chat Formatter 与 ContextManifest、Run Facts、
  Built-in Tool、IPC、Envelope 和 receipt 版本均不变。

## 明确不变

- 完整定义已经在本次模型上下文中且仍有效时，不要求再次调用 `mission.get`。
- 不建立 `get → send → status` 或任何其他固定流程；每个操作仍只在当前工作需要时调用。
- Mission 的四个状态、状态写权限、当前 Camp mutation gate、CLI 输入输出与调度行为不变。
- `RUN_INPUT`、`RUN_FACTS`、`SHARED_CONVERSATION`、Workspace、Task、Memory 的选择、字段、顺序和预算不变。
- 普通 Camp 与 Single Chat Bootstrap 正文不变；历史 Bootstrap、Manifest、Evidence 与冻结 Runtime 输入不重写。

## 迁移、恢复与兼容

不需要数据库迁移或历史数据转换。新的 revision 10 进入 Native Binding compatibility digest，使新绑定取得
新 Charter；既有绑定继续复用其不可变 Bootstrap Evidence。恢复同一历史 Run 仍使用原 Manifest 与输入字节，
不会被重新格式化或补写。

## 验证

- 结构测试精确断言 Mission Charter 是普通 Camp Charter 加三条 Mission 追加内容，且新句只位于该块。
- 负向测试断言普通 Camp 不含 Mission 块，即使以 Mission 标志调用 Single Chat 也逐字返回独立 Charter。
- Binding contract 测试断言 revision 10，并证明相对旧 revision 的 compatibility digest 发生变化。
- 运行 Rust 定向测试、格式检查、文档治理、完整 PR Rust 门禁与 Clippy；远端 required checks 通过后才合并。

## 实施收口

revision 1 已按确认文本实现，Session Charter revision 已轮换到 10。Mission/普通 Camp/Single Chat
定向 Rust 断言、Binding contract、格式、TypeScript、完整 Node 测试、文档治理与 PR #440 隔离 CI 均通过。
本机全量 fast-lib 在 840 passed、6 ignored 后，因同机多个 worktree 并发编译使一个未改动的两秒 Runtime
版本探针超时；Clippy 命中三处未改动主线 lint。两项均已保留事实，不把它们误报为本变更通过证据，
也不扩大本次已确认的 Mission-only 修改范围。
