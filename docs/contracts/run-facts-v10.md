---
document_type: protocol-contract
contract: run-facts-v10
status: accepted
version: 10
source_version: v1.72
last_updated: 2026-10-18
---

# Run Facts v10

继承 [v9](run-facts-v9.md)。新 non-batch 的持久 Facts schema 为 **13**；public 保持 **11**。
内部 schema 只进入证据，不进入模型正文。新 Single Chat 删除整个 `singleChat` 属性，无替代字段或提示。

新单聊的完整形状为：

```ts
type SingleChatRunFacts = {
  attachmentOutputRoot: string;
  externalEffect?: {
    state: "unsettled";
    requiredAction: "reconcile_before_repeat";
  };
};
```

附件输出根必有；当前 Conversation 存在 unknown Action execution 时才出现 `externalEffect`，否则省略。
其余 invocation 的模型业务字段保持；`runFactRefs` 原来没有 `singleChat` 项，引用集合保持。
新旧版本配对及持久恢复见 [ContextManifest v42](context-manifest-evidence-v42.md)。
单聊 Charter/Guidance、实际工具白名单和私有输出路由由 [Single Chat v9](single-chat-v9.md)继续约束。
历史已冻结 facts 和最终输入原字节恢复，不重新序列化以删除旧字段。
