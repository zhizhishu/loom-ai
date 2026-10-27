---
document_type: protocol-contract
contract: camp-message-send
version: 20
status: accepted
authority: camp-message-send-agent-visible-target-teaching
last_updated: 2026-09-16
---

# Camp Message Send v20

继承 [v19](camp-message-send-v19.md) 的正文、收件人、Principal attention、调度、Task/Gather 和命令幂等合同。
仅替换文件发布规则为 [Camp Attachment v10](camp-attachment-v10.md)：所有新 `files` 原地登记，不依赖旧快照发布。

输入字段不变，文件说明精确为：

```text
Optional local file or directory paths to attach, in order. Pass each actual path directly. Rovai registers a reference without copying, moving, linking or changing permissions. Later reads use the current file at that path. Temporary files may become unavailable when their source is cleaned up.
```

Agent 成功输出在原 messageId、agentAddressingMode、effectiveRecipients、deliveryIds 之外，有文件时追加
`attachments: {attachmentId: string, path: string}[]`，按输入顺序，path 为实际绝对位置；无文件省略。
不新增命令、外部编号、目录预分配或 Bootstrap 章节。内部 request ID、已有重试与命令原子性继续，不回滚删除源。
