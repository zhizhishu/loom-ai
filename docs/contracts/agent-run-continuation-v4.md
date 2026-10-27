---
document_type: protocol-contract
contract: agent-run-continuation-v4
status: accepted
version: 4
source_version: v1.72
last_updated: 2026-10-17
---

# AgentRun Continuation v4

继承 [agent-run-continuation-v3](agent-run-continuation-v3.md) 未被下述条款替代的规则。

取消 Task ID/状态/分配对新继续及 waiting 继续执行的准入。Task 关闭、完成、取消或改派不取消已排队的继续，也不改变接收者。原 Task 审计关系保留；成员、Conversation、原 Run、Session、取消和执行 fencing 仍按 v3 判断。
