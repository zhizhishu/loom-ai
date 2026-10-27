---
document_type: protocol-contract
contract: run-facts-v9
status: accepted
version: 9
source_version: v1.72
last_updated: 2026-10-17
---

# Run Facts v9

继承 [run-facts-v8](run-facts-v8.md) 未被下述条款替代的规则。

本合同说明当前业务字段；持久 schema 是 public **11**、non-batch **12**，见 [Manifest](context-manifest-evidence-v40.md)。新 facts 无 taskContext，Single Chat 的模式事实无 taskMutationAllowed。必需 attachmentOutputRoot、公开 historyHint，以及原有 Mission、恢复和未结算外部效果事实不变。不新增解释开关的模型段落。

历史已冻结 facts 和引用证据原样恢复；不因字段退出重写审计。
