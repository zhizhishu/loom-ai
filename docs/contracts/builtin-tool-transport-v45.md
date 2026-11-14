---
document_type: protocol-contract
contract: builtin-tool-transport-v45
authority: builtin-tool-transport
status: accepted
version: 45
source_version: v1.72
last_updated: 2026-11-05
---

# Built-in Tool Transport v45

继承 [v44](builtin-tool-transport-v44.md) 的输入来源、IPC、授权、完整结果交付、Send 来源、Thread 分页和既有操作语义。本版增加五个 Workspace RPC 命令；其字段级边界由 [Workspace RPC v1](workspace-rpc-v1.md) 拥有。

Transport/CLI 为 **45**，capability 为 **builtin_cli.transport.v45**，Agent Output 为 **15**。IPC 保持 **3**，Envelope 保持 **2**。CLI、Core 与远端 Node 的 helper 准入必须配套；版本不匹配在执行业务前拒绝，不能把旧 helper 的测试作为新版本运行证据。

## 新操作与命令

| Canonical operation | CLI |
| --- | --- |
| loom.workspace.list | rovai workspace list |
| loom.workspace.read | rovai workspace read |
| loom.workspace.run | rovai workspace run |
| loom.workspace.poll | rovai workspace poll |
| loom.workspace.cancel | rovai workspace cancel |

这五项在唯一 catalog、CLI identity、TEAM_TOOL_NAMES、Agent output projection 和 Built-in execution evidence projection 中共同注册。catalog 顺序位于 loom.submit 后、Automation 家族前；当前 canonical 操作共 41 个。它们使用现有 Built-in lease、真实 AgentRun 与 execution epoch 身份，不建立通用 HTTP execute 入口，不接受调用者填写 member、camp、mission、run、node 或本机 root。

初始 list/read/run 的必选 workspaceId 从已准备工作区定位节点。run 当前只接受本机固定策略中的 git.status，外部 args 只能为空；没有任意 executable、shell 字符串或环境变量字段。路径、范围及输出上限见 Workspace RPC v1。

## 两种请求标识

初始 list/read/run 可带 requestId UUID，CLI 对应 --request-id。该 UUID 是调用者明确重试同一次操作的键；同一 Run/epoch 中必须与原参数完全相同地重用。缺省时沿现有 Built-in invocation request ID。

Core 使用固定域、实际 agent_run_id、实际 execution_epoch 和选定调用键计算 wrpc_ 加 64 位小写十六进制摘要。外部 UUID替代默认调用键参与此计算，不与新 transport 调用 ID叠加。跨 Run 或 epoch 不能取得原请求身份。

poll/cancel 的 requestId 是前次返回的 wrpc_64hex 标识。此字段不成为它们自己的 IPC invocation UUID；每个控制调用仍有独立的 Built-in IPC request ID。初始 UUID 与目标请求 ID 不能混用。

相同请求的重试只能观察原请求及原 deadline，不重新执行。unknown_outcome 使用 confirm_outcome 恢复类别；不能将未知结果转换为安全重跑。只有尚未准入的 offline/busy 错误允许 retry_same_request。

## 输出与故障

成功 CLI stdout 是既有 Agent-facing domain projection，不额外制造 ok/result 包装。五个操作共用严格有界的状态、事件与归档凭据 schema：

- requestId、state、runId、sessionId、attempt、deadlineUnixMs；
- lastSeq、nextAfterSeq、hasMore、outputBytes、omittedBytes；
- 最多 256 个 events 和最多两个 archives；
- 控制投递失败可含闭集 deliveryError，同时保留已知真实请求状态。

事件 discriminator 统一为 kind。文本结果编码为 encoding=utf8 与 text；其他字节为 encoding=base64 与 data，不同时重复返回两份内容。完整单次文件读取及 run 保留输出可带 A 端实际字节校验后的归档凭据。凭据不是模型自报 hash，也不携带 A 端私有路径。

错误继续使用现有 Agent-facing error 对象及固定恢复类别。输出不符合当前闭合 schema 时沿既有 output_contract_mismatch 分支，不将原始异常内容作为成功结果。

## Evidence、兼容与验收

Execution Evidence 只投影请求/Run/Session 标识、允许的操作参数元数据、状态、事件数、归档数和字节计数；不记录 raw argv、路径、文件正文、base64 或进程输出。原始输入/结果仍由既有摘要绑定，不增加平行授权真源。

旧操作的输入/输出、历史 Envelope、成功结果和摘要不重写。历史 v44 合同保持；v45 只改变当前命令集合和五项新操作的字段/投递语义。新增 output golden fixture v16 保留 v15 文件；fixture 文件编号与 Agent Output 合同版本是不同的既有编号空间。

本合同规定实现必须满足的行为，不等同于端到端验收已完成。源代码 owner、当前编译、原生 helper 与真实 A+B 结果在[实施证据](../loom/workspace-rpc-v1-implementation-2026-11-04.md)分开记录。人工治理字段由对应版本决定文档拥有，本合同不代填人工确认。
