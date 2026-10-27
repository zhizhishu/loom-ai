---
document_type: protocol-contract
contract: context-manifest-evidence-v39
authority: public-multi-input-agent-run-context-evidence
status: accepted
version: 39
last_updated: 2026-10-15
---

# ContextManifest Evidence v39

合并 [v38 的发送者投影](context-manifest-evidence-v38.md)与
[Mission 064 v37 的多次投递](context-manifest-evidence-v37.md)。新 public Manifest／Formatter
为 **39**、Profile **14**、Run Facts **10**；非 batch 保持主线 **37／12／6**。
Bootstrap、Charter、Redelivery、Native Binding compatibility 不因合并改变。

普通消息与 Steer 仍共用 Builder、Formatter 和消息投影；RUN_INPUT 仅有本次投递的消息。
不新增模型指导、Steer 标签、快照解释或裁剪策略。初始 claim 与 Manifest 不被后续投递改写。
历史输入使用已保存的最终载荷、摘要和接受证据，不能用当前 Builder 重算来修复版本碰撞。

## 数据库来源与合并迁移

主线和 Mission 064 曾分别写入 Migration 199／schema 149，语义不同。不得仅靠这两个数字认库：

- 主线来源有发送者格式的 Manifest 37／Facts 6 和 public 38／Facts 9，仍是一 Run 一份初始 Manifest。
- 分支来源有 source_delivery_id、input_kind／input_sequence、requested_mode／target_execution_epoch、
  对应唯一索引和不可变来源约束，以及 public Manifest 37／Profile 14／Facts 10。
- 分类器要求已知迁移链及实际结构一致；未知混合结构拒绝写入，不猜测来源。

两类 199 来源均经过主线 200、201、202。主线 **203／schema 153** 新增紧凑操作格式；
Mission 064 已部署的同号 203 则新增多输入结构。最终由 **Migration 204／schema 154** 按实际结构
补齐缺少的另一部分，不覆盖或重命名历史 199／203 回执。
全新库沿主线 203 后执行 204。已有分支 203 不重建输入表，只补操作格式；主线 203 补多输入约束。
消息、Manifest、payload、摘要、native ID、ACK 和 Delivery 状态均原样保留；事务失败回滚，可重入检查。

同为历史 Manifest 37，需结合 Profile／Facts 和所属 Run 的 batch 类型解释：主线 non-batch
37／12／6 与分支 public 37／14／10 均保留原样。合并后的新 public 输入只写 39；旧数据的恢复
不是继续允许任意旧程序写新库。历史目录模式继续遵守 [History v14](camp-history-v14.md)。

新 Steer 来源以现有 Delivery 为唯一入口；每来源一份 Manifest、每 Manifest／epoch 一份 Runtime
Input，原生 turn ID 可由同轮多输入共享。accepted 和 delivery_unknown 不重发；迟到 ACK 只补原输入证据，
不改变后继 Run，详见 [Delivery v16](message-delivery-v16.md)。

普通输入与 Steer 一致遵守[输入快照存储](input-snapshot-storage-v1.md)：最终动态上下文只保存一份
Managed Blob；不恢复已退役的 Profile、Run Facts、任务／A2A 证据正文或独立校验摘要。
Delivery 只增加目标／顺序关联，回执不复制输入正文；`canSteer` 及不可用原因读取时计算，不另存资格快照。
执行输出继续使用[紧凑操作存储](execution-record-storage-v3.md)，不因插话创建另一套活动或原始事件副本。

逐段模型输入对照见[合并前后对照](../versions/v1.72/model-context-change-steer-merge.md)。


## 当前 Run Facts 的历史提示

沿用已经确认的 Steer R3，普通输入与插话共用四句（P 为最近一次有效接受的公共边界）：

| 边界／是否有额外可见消息 | 完整文本 |
| --- | --- |
| P > 0／无 | `All visible messages after sequence {P} are in RUN_INPUT or were written by you.` |
| P > 0／有 | `There are additional visible messages after sequence {P} beyond RUN_INPUT and messages written by you.` |
| P = 0／无 | `All visible messages in this Thread are in RUN_INPUT or were written by you.` |
| P = 0／有 | `There are additional visible messages in this Thread beyond RUN_INPUT and messages written by you.` |

没有新增“快照如何覆盖”的解释；历史 Manifest 的旧提示按原字节恢复。Facts 10 仍是内部版本，不进入模型正文。
