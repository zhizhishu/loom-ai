---
document_type: protocol-contract
contract: camp-message-send-v29
status: accepted
version: 29
source_version: v1.72
last_updated: 2026-10-22
---

# Camp Message Send v29

继承 [v28](camp-message-send-v28.md)。用户公开 Composer 可提交
[Thread Reference v1](thread-reference-v1.md) 的对话与使命 Atom，Core 首次发布在既有事务内校验目标并捕获标题。
引用不进入成员寻址、邀请、Skill 或命令解析。重复 commandId 优先返回首次结果；来源删除不改变成功回执。

正式引用段保存于原 structured_content_json，无独立来源快照。Pending 失败回滚首发邀请、激活与消息/Delivery；
Active 已成功的独立邀请仍保持原结果。Agent 输出及外部渠道不新增引用语法。
