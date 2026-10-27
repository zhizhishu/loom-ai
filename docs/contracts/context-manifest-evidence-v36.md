---
document_type: protocol-contract
contract: context-manifest-evidence-v36
authority: public-multi-input-agent-run-context-evidence
status: accepted
version: 36
last_updated: 2026-10-14
---

# ContextManifest Evidence v36

继承 [v34](context-manifest-evidence-v34.md) 的模型字段和 section 顺序。
新 public Formatter／Manifest **36**、Profile **13**、Run Facts **9**；非 batch 保持
**35／12／6**。Bootstrap v5／Formatter 5、Charter 22、Redelivery 2 和 Native Binding compatibility 不变。

公开 Run 在 claim 事务把所选输入和预算需要的上下文保存到唯一的 `agent_run_claim_context`，
与 Run、AgentRunInput 及 claimed Delivery 原子提交。JSON 保存实际恢复内容，不增加平行证明摘要。
预算和内容规则见 [Profile 13](context-delivery-profile-v13.md)。首次物化使用该快照，之后仍优先
恢复已物化 Manifest 的最终原字节。claim 快照不成为 Session 恢复资格或接受证明。

Migration **198** 将 schema **147 → 148**，增加上述 Run-owned 存储和不可变更新约束，扩展
Context／Profile／RunInput 准入。保留所有历史行、Blob 和原生 Session。新 RunInput 写 36；
旧已领取输入按自身版本组包，不回填最新 Memory，不重写旧 payload。新 v36 缺少 claim 快照是
存储错误，不静默用最新状态重新生成不同内容。

实际 Bootstrap 仍在既有串行 input preparation 中选择 redelivery revision、绑定到当前
Native Binding，并由有效 accepted ACK 推进水位；新旧 Input 都不因为升级自动重放。
后续 Binding 变化沿用本 Run 启动内容，避免再次扩大已冻结批次。正常 Bootstrap 是否出现
仍按 accepted digest 和 delivery mode 判断。其他既有 Evidence 和恢复规则保持。

范围、确认和验证记录见 [R1](../versions/v1.72/model-context-change-bootstrap-claim-budget.md)。

新 ContextManifest 的目录模式与正文 fence 分离，参见 [Camp History v14](camp-history-v14.md)。
新 Run 不再保存整份跨会话目录；旧 Manifest、目录行、正文与 Blob 不转换。
