---
document_type: protocol-contract
contract: camp-message-send-v28
status: accepted
version: 28
source_version: v1.72
last_updated: 2026-10-17
---

# Camp Message Send v28

继承 [camp-message-send-v27](camp-message-send-v27.md) 未被下述条款替代的规则。

新 Agent/User Send 不关联 Task，无论开关是否开启。Agent public schema/help 不提供 taskId；旧 --task-id、IPC taskId 和 User execution.taskId 可继续传入合法旧值但不参与业务。持久请求身份与摘要包含原输入，精确 receipt replay 不重算。新 publication event 不写入 Task ID，不从 Task 推断 recipients。

只按显式收件人、消息规则、membership、Runtime 和权限准入；删除 Task terminal、assignee 和数量歧义对 Send 的门禁。已排队旧关联工作和用户继续不重新检查 Task 状态/分配，历史关联不改写。Task 关闭只使 Task 操作自身不可用。

Bootstrap、Send 描述和 cli-operations 使用一套简洁教学；新增 Task 时仅 task 子命令 help 教学 create 后可 `rovai send --to <assignee>`。
