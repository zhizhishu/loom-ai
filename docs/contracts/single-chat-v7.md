---
document_type: contract
name: Single Chat
version: v7
status: accepted
source_version: v1.64
last_updated: 2026-09-22
---

# Single Chat v7

继承 [v6](single-chat-v6.md) 的私有路由、Context、FIFO、Source Attachment 与 operation policy version 2。
本版只为 `SingleChatRunView` 增加必需、非负的 `executionEvidenceChangeSequence`，其语义与
[Camp Open Projection v23](camp-open-projection-v23.md) 相同。

Single Chat 执行窗口使用 [Run Process Detail Surface v42](run-process-detail-surface-v42.md) 的独立 change cursor；
`executionEvidenceCount` 不再充当更新 revision。历史 Run 水位为 0 且不回填，私有 Conversation、审批、注意力、
附件和迟到 fence 均不改变。
