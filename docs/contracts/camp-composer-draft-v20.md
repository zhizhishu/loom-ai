---
document_type: protocol-contract
contract: camp-composer-draft-v20
status: accepted
version: 20
source_version: v1.72
last_updated: 2026-10-22
---

# Camp Composer Draft v20

继承 [v19](camp-composer-draft-v19.md)。公开 Composer 在现有 version 2 Text／Atom 文档中加入
[Thread Reference v1](thread-reference-v1.md) 的对话、使命 Atom。所有 clone、比较、校验、纯文本、
节点序列化、本机保存、待发送恢复和输入历史分支保留其类型、ID 与本机展示标签。

目录查询属于用户客户端读取，不依赖 AgentRun。Single Chat 和使命描述不启用引用候选；跨到这些输入面
粘贴引用时只接纳普通定位文本。Composer 自有剪贴板严格校验版本与字段，不按标签或 Markdown 反向绑定。
客户端只有确认对应快照成功发布后才清理本机内容；结果未知继续用原 commandId 核对。

引用 Atom、成员 Atom 和空白不能独自构成本轮内容，需补充文本或附件。来源不可用保留草稿和显示标签，
不丢弃 Atom。其余附件、quotes、回复和 continuation 权威及恢复行为不变。
