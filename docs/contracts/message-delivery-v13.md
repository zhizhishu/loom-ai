---
document_type: protocol-contract
contract: message-delivery
version: 13
status: accepted
authority: public-message-delivery-route-reconciliation
source_version: v1.72
last_updated: 2026-10-14
---

# Message Delivery v13

继承 [v12](message-delivery-v12.md)。公开 User 消息可经 [Send v27](camp-message-send-v27.md) 请求 Steer。
同一 CampMessage 仍按每位接收者建立一条现有 Delivery。支持且处于已接受原生输入的活跃执行时，
原子捕获 Run／epoch 并领取该 Delivery；其他接收者保留普通 waiting，空闲 lane 正常启动。
既有普通队列不转换为 Steer。Agent、Automation、Single Chat 与 Channel 不使用此入口。

Scheduler 复用现有事件唤醒与恢复扫描，同一执行按 Delivery 队列顺序串行投递；不同执行可以并行。
准备和提交均检查目标存活、取消、epoch 与 binding。输入绑定后不改投后继执行。
当前接入 Codex turn/steer，原生 expectedTurnId 必须匹配；其他 Adapter 使用普通发送或排队。
原生能力实验与产品准入分开记录。
只有原生目标／方法／参数校验拒绝可作为未接收证据；Host 退出、通道中断和内部错误保持未知。

| 原生结果／执行状态 | Delivery 行为 |
| --- | --- |
| 匹配输入的明确接受 | settled，显示已加入当前执行；不等同于模型已执行要求 |
| 明确拒绝或普通执行成功前尚未提交 | 本条退回普通 waiting，保留原消息；没有结束提示 |
| 已提交但接受结果未知 | runtime input 为 delivery_unknown，保留核对入口；不重发、不转排队 |
| 用户取消或执行失败时尚未提交 | 跟随原执行取消或失败，不自动重新启动 |
| 结束时仍有提交中的输入 | 标记未知，不能批量标成成功；迟到的精确接受证据仍可补齐 |

`runtimeInputs.reconcile({deliveryId})` 核对原记录，不发送输入。当前可在仍存活的 Codex Host 查询
原 turn 的 userMessage，并匹配冻结 payload；查不到、Host 已退出或暂时无法查询均不能证明未送达。
没有证据时维持未知，不制造成功。消息处理回执和 CampOpen 共用现有读模型。
