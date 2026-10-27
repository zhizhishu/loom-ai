---
document_type: protocol-contract
contract: context-manifest-evidence-v34
authority: public-multi-input-agent-run-context-evidence
status: accepted
version: 34
last_updated: 2026-10-13
---

# ContextManifest Evidence v34

继承 [v33](context-manifest-evidence-v33.md) 和[输入快照存储 v1](input-snapshot-storage-v1.md)。
新 public batch Formatter/Manifest **34**、Profile **11**、Run Facts **9**；新非 batch Formatter/Manifest
**35**、Profile **12**、Run Facts **6**。非 batch 跳过历史已用编号，不与旧 batch 格式复用协议身份。

唯一投影变化是 [Collaboration State v4](collaboration-state-v4.md) 不携带 peer 专业职责。Section 顺序、
选择、self 排除、Lead、accepted ACK 和现有恢复边界不变。Bootstrap v5/Formatter 5、Charter 22、
Redelivery 2 和 Native Binding 兼容标识不变；已存在 Session 上新 Run 使用新投影，继续恢复原生 ID。

Migration **197** 将 schema **146 → 147**：事务内扩展 Manifest、RunInput、Profile 及相关 trigger 的
准入，保留所有旧版本分支及原始行/Blob 引用；不扫描重算职责、Profile、冻结输入或 accepted 摘要。
新 RunInput 只能写 34。已领取但未物化的 29～33 RunInput 沿用对应旧 serializer/Profile，34 使用新
投影。已物化的历史动态输入直接恢复，不从最新 Profile 重算它。历史数据库准入仍遵循原有迁移机制。

完整 payload 容量与领取预算见 [Profile 11/12](context-delivery-profile-v11.md)。这次提升内部字节限额，
不宣称任何真实 Runtime 或模型已支持未验证的输入量；真实投递记录和未覆盖范围在
[R4 实施记录](../versions/v1.72/model-context-change-member-routing.md)。
