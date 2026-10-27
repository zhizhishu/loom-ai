---
document_type: protocol-contract
contract: context-manifest-evidence-v40
status: accepted
version: 40
source_version: v1.72
last_updated: 2026-10-17
---

# ContextManifest Evidence v40 / v41

继承 [context-manifest-evidence-v39](context-manifest-evidence-v39.md) 未被下述条款替代的规则。

新 public 初始及 Steer 输入使用 Manifest/Formatter **40**、Profile **15**、Run Facts **11**；新 non-batch 使用 **41 / 16 / 12**。Migration **205 / schema 155** 扩展准入并保留既有行、最终载荷、摘要和接受证据；不重写旧输入。

Charter revision **24** 删除 Task 职责教学；Bootstrap formatter 5、Native Binding compatibility revision **16** 保持。老 Session 正常继续，新 Bootstrap 采用统一文案，不因开关轮换原生绑定。

公开新输入在实际冻结时读取能力：开启时沿用紧凑 SELF_ACTIVE_TASKS，关闭时连 section 一并省略且不查任务。Single Chat 永远省略。claim 的能力选择、任务投影、预算与最终输入一起冻结；后续开关变化不改写已冻结输入。Task 不再影响 Memory counterparty 优先级，开关两态使用同一规则。

新 RUN_FACTS 省略 taskContext 和 singleChat.taskMutationAllowed，其他事实保持。逐项完整前后文本由 [R4 确认说明](../versions/v1.72/model-context-change-task-capability.md)拥有。
