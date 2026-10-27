---
document_type: protocol-contract
contract: builtin-tool-transport-v25
version: 25
status: accepted
authority: builtin-tool-transport
last_updated: 2026-09-16
---

# Built-in Tool Transport v25

继承 [v24](builtin-tool-transport-v24.md) 的命令、认证、IPC 2 和 Envelope 1。
Contract/CLI version=25，capability=`builtin_cli.transport.v25`，Agent Output Projection=3。

变更仅为 [Send v20](camp-message-send-v20.md) 的 files 描述与有序实际路径结果，以及
[Camp History v6](camp-history-v6.md) 的附件位置及 nullable 观察元数据。CLI 不再执行 `.send-import`。
命令数量、参数、内部 requestId 和运输重试不变；没有 attachment allocate 或面向 Agent 的请求编号。
Session Charter revision 6、Bootstrap v3/Formatter 3 不变。
