---
document_type: protocol-contract
contract: context-manifest-evidence-v42
status: accepted
version: 42
source_version: v1.72
last_updated: 2026-10-18
---

# ContextManifest Evidence v42

继承 [v40/v41](context-manifest-evidence-v40.md)。新 non-batch 使用 Formatter/Manifest **42**、
Run Facts **13**、Delivery Profile **16**。public 初始输入和 Steer 保持 **40 / 11 / 15**。

新 Single Chat 的 `RUN_FACTS` 不包含 `singleChat`；精确字段与条件见 [Run Facts v10](run-facts-v10.md)。
其他 section、Charter 24、Bootstrap formatter 5、Binding compatibility 16、消息选择、历史预算、
当前输入及 accepted ACK 保持。少 235 字节可能使既有字节预算边缘保留更多可选历史，不改变预算算法。

Migration **208** 将 projection schema **157 → 158**，仅扩展已有版本约束、非 batch 准入与
Profile 16 配对。保留旧 Manifest/Blob、运行策略、输出目标、索引、触发器与其他业务行，失败事务回滚。
旧已物化输入复用原始最终 Blob；尚未物化输入按现有路径首次生成当前格式。
Native Session 不轮换，accepted/unknown Delivery 不重放。其他 non-batch invocation 原有模型字节保持。
