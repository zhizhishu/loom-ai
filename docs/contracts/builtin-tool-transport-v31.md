---
document_type: protocol-contract
contract: builtin-tool-transport-v31
authority: builtin-tool-transport
status: accepted
version: 31
last_updated: 2026-09-21
---

# Built-in Tool Transport v31

v31 继承 [v30](builtin-tool-transport-v30.md) 的 26 项 operation、IPC 2、Envelope 1、receipt 1、完整
logical result 运输和闭合 request/result schema。Contract 与 CLI command version 为 31，Agent Output
Projection wire version 为 4，Runtime capability 为 `builtin_cli.transport.v31`。

Task operations 切换到 [Durable Task v4](durable-task-v4.md)：create/update 输入删除
`acceptanceCriteria` 与 `clearAcceptanceCriteria`，`description` 上限为 16000 且统一表示 scope and
requirements；旧字段由闭合 schema 拒绝。CLI help 与 Tool description 使用同一份精简当前文案，不附带
后台字段、历史兼容或权限实现细节。

`team.get_task` 的 Agent projection 不再透传完整 canonical `TaskDetail`，而是七个基础字段加至多一个与
当前状态匹配的说明字段。Create/update 的既有 compact projection、list 摘要、receipt、Replay、授权和
idempotency 不变。该不兼容输出 shape 使 Agent Output wire 从 3 轮换为 4；v30 不与 v31 混用。

CLI 新增一个只读 family index：

```text
rovai task

  create  Create a durable task.
  get     Read task details and version.
  list    List task summaries.
  update  Update an existing task.

Use rovai task <command> --help for arguments.
```

`rovai task --help` 输出上述文本并以 0 退出；其他 command family 不增加别名或新的 help 模式。
Session Charter revision 12 删除“command family 没有 help entry”的绝对提示，同时保留根 help、精确
operation help 与本 Native Session 内复用规则。Bootstrap、Formatter、ContextManifest、operation 数、
endpoint、IPC、Envelope 与 receipt version 均不改变。
