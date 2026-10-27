---
document_type: protocol-contract
contract: camp-history-v15
status: accepted
version: 15
source_version: v1.72
last_updated: 2026-10-22
---

# Camp History v15

继承 [v14](camp-history-v14.md)。带有 [Thread Reference v1](thread-reference-v1.md) 引用段的历史消息，
正文共用发布内容 projector，保留每个位置及 titleAtSend 的定位链接。投影时不读取目标、不替换标题；
来源失联不抹掉 owner 消息。撤回消息继续只输出原撤回标记，不泄漏被擦除引用。

RUN_INPUT 仍是现有 body、mentions、skills 等字段，引用不增加字段、自动展开或新的 Context 版本。
thread.read 的 live 边界、跨 Thread 搜索的 Run 冻结 publication boundary 与私有记录隔离均保持原规则。
