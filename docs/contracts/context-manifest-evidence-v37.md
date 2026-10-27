---
document_type: protocol-contract
contract: context-manifest-evidence-v37
authority: public-multi-input-agent-run-context-evidence
status: accepted
version: 37
last_updated: 2026-10-14
---

# ContextManifest Evidence v37

继承 [v36](context-manifest-evidence-v36.md)。新 public Manifest／Formatter **37**、Profile **14**、
Run Facts **10**；非 batch 保持 35／12／6，旧 36／13／9 和更早已冻结输入按原版本恢复。
Bootstrap 5、Charter 22、Redelivery 2 与 Native Binding compatibility 保持。

普通输入和 Steer 使用同一 DynamicInputContext Builder、Formatter 和 RUN_INPUT 消息投影。
每次只取本次 Delivery 来源；作者、提及、引用、附件和 Skill 链接从同一来源集合构建。
Steer 不插入专用指导、标签、技术字段或裁剪策略。四种 historyHint 单句见
[已确认 R3 的紧邻前后对比](../versions/v1.72/model-context-change-steer-shared-input.md)。

启动 Run 的 AgentRunInput、claim 快照与初始 Manifest 不被后续输入改写。新投递读取当时的协作、
Tasks、Mission 与 Additional Skills；模型、权限、实际工作区和 Bootstrap 沿用 Run 的冻结环境。
同一输入一旦生成 Manifest，恢复优先使用该 Manifest 的最终原字节。历史访问 fence 选择该 Run
最新有效 accepted Manifest；尚未接受的插话不能扩大工具读取边界。

Migration **199** 将 schema **148 → 149**。不增加消息表或 RunSupplement：

- ContextManifest 增加可空 source_delivery_id；初始 Manifest 仍每 Run 唯一，每条 Steer Delivery 另有唯一 Manifest。
- Runtime Input Delivery 以 Manifest／epoch 唯一；input_kind、input_sequence 区分启动与后续输入。
  原生 turn ID 可以被该 turn 的多条 Steer 接受回执共用，初始原生输入唯一性保持。
- CampMessageDelivery 增加 requested_mode 与可空 target_execution_epoch；目标 Run 使用已有 claimed_agent_run_id。
  来源与输入序号不可更新，迁移保留旧行、Blob、接受证据和 Session。

ACK 必须关联精确输入；同一 Run 内较旧 ACK 不覆盖较新输入已接受的动态标记。迟到 ACK 仅补证据，
不复活结束执行、不推进后继 Run 水位。只有匹配当前 Run／epoch／binding 的有效接受回执推进动态标记。
重复 ACK 幂等；accepted／delivery_unknown 不自动重发。投递和终态规则见 [Delivery v13](message-delivery-v13.md)。
