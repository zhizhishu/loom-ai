---
document_type: architecture
architecture: durable-gather-barrier
authority: retired-gather-history
status: retired
last_updated: 2026-09-19
---

# 持久 Gather Barrier（已退役）

Gather 已从当前 Built-in catalog、CLI、Core 调度、Run Facts、Context 与官方 Skill 中删除。本文件只为冻结历史
`GatherRecord/GatherItem`、旧 Message Delivery、ContextManifest 与 evidence 提供定位，不定义任何可调用能力。

当前多人协作使用普通多目标 `rovai send`。每个目标获得普通 waiting Delivery，回复作为普通公共消息进入发起者的
FIFO，能够合批时合批。Core 不捕获 return、不维护 Barrier、不生成 completion，也不保证收齐后只唤醒一次。

Migration 163 终态化残留的非终态 Gather 和旧 completion 调度状态，但不会伪造 completion。已经公开、未冻结且仍安全
的成员消息责任可以按 [Message Delivery v10](../contracts/message-delivery-v10.md) 迁入普通队列；历史终态对象原样只读。

当前架构见 [Public Camp Message、Delivery 与 AgentRun](public-a2a-message-delivery.md)。历史字段见
[Gather v5](../contracts/gather-v5.md)，不得把它列为当前合同或重新引入换名聚合对象。
