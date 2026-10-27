---
document_type: protocol-contract
contract: camp-history-v13
authority: public-camp-history-read-scope
status: accepted
version: 13
last_updated: 2026-10-14
---

# Camp History v13

继承 [v12](camp-history-v12.md) 的读取范围、三种模式、正文、Mention、附件、引用、分页和撤回规则。
新 thread.read、thread.search、history.search 正常消息结果按 [Message Senders v1](message-senders-v1.md)
统一为 senderType/senderId/senderName，移除该层 authorType/authorId。引用内作者快照不改写。
保留 Profile 名称在本次读取事务按原作者 ID 解析，请求内缓存包括缺失；不按当前成员身份过滤作者。

Agent Output 12 的当前封闭 Schema 只接受新结构；历史成功回执在回放边界分别接受旧 author +
addressing、author + mentions 及旧搜索结果，保持字节与摘要，不补名称。空集合及撤回项仍符合原结构。
搜索结果仍提供 snippet，不改成正文，不扩展可见性，不重新调度读取到的任何目标。
