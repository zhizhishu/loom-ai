---
document_type: protocol-contract
contract: context-manifest-evidence-v38
authority: public-multi-input-agent-run-context-evidence
status: accepted
version: 38
last_updated: 2026-10-14
---

# ContextManifest Evidence v38

继承 [v36](context-manifest-evidence-v36.md) 的 claim 快照、完整预算、投递和恢复规则。
仅公开 RUN_INPUT.messages 与 SHARED_THREAD 普通消息采用 [Message Senders v1](message-senders-v1.md)。
新 public Formatter/Manifest **38**、Profile **13**、Run Facts **9**；非 batch Formatter/Manifest
**37**、Profile **12**、Run Facts **6**。非 batch 的 CURRENT_INPUT.source 和私聊专用结构不改。
Bootstrap v5/Formatter 5、Charter 22、Redelivery 2 和 Native Binding compatibility 原值保持。

公共作者名称随完整 RUN_INPUT 存入现有 agent_run_claim_context，不另存名称缓存或历史表。
所有预算与最终渲染复用该 JSON；最终 payload digest 包含实际 sender 字段。
内部 SharedMessage evidence 继续保留原作者身份，不能用模型 user/system 反向解释内部路由。
非 batch 在组装 SHARED_THREAD 时只解析已选消息的当前作者名称，同批复用查询；领取时不为
名称扫描历史或读取 Profile。名称随实际完整输入按既有机制保存，不增加专用名称快照、状态或
恢复分支。消息选择、预算校验、完整上下文及工具回执的保存与回放机制保持。

Migration **199** 将 schema **148 → 149**，仅扩展 Manifest、RunInput 及关联版本约束。
新 public RunInput 写 38；35/36 及更旧的已保存输入和 Manifest 原样保留。新旧快照读入不回填名称，
旧成功工具回执不重新生成。新 Run 不依赖 Session 年龄，既有 accepted 水位和恢复策略保持。

确认与验证见 [R2](../versions/v1.72/model-context-change-message-senders.md)。

新 Run 的目录模式独立于正文边界，见 [Camp History v14](camp-history-v14.md)。不复制目录，不迁移旧 Context。
