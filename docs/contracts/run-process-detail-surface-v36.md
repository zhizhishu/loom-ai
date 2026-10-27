---
document_type: protocol-contract
contract: run-process-detail-surface-v36
authority: execution-console-run-card-queue-projection
status: accepted
version: 36
source_version: v1.62
last_updated: 2026-09-20
---

# Run Process Detail Surface v36

继承 [v35](run-process-detail-surface-v35.md) 的三位置承载、共享详情 DOM、进入恢复、Run 导航、Evidence、停止与
折叠历史边界。本版只补齐 claim 前的 Delivery-backed 排队卡、多输入入口和紧凑 Run 卡几何；不改变
AgentRun、MessageDelivery、CampTurn、Evidence 或 Runtime 的权威状态。

## Delivery-backed 排队卡

Renderer 把同时满足下列条件的 MessageDelivery 投影为执行台当前区的“排队消息”卡：

- `deliveryKind=public_a2a`；
- `dispatchDisposition=dispatch`；
- `targetAgentRunId=null`；
- `status=waiting`，或兼容旧投影的 `status=pending` 且 `dispatchPhase` 为 `never_attempted | attempted_waiting`。

这些 Delivery 按 `recipientAgentId` 聚合，组内按 `createdAt + id` 稳定排序，输入层数按不同 `messageId` 去重。
即使接收队员尚无 AgentRun，该队员也进入执行台入口和总览；队员入口显示“排队中”。若同一队员同时存在
non-terminal Run，真实 Run 状态优先；若只有 terminal Run 与 waiting Delivery，则“排队中”优先于历史终态。

Delivery-backed 卡是只读队列投影，不是 AgentRun。它可以展开输入、打开多输入清单和定位原消息，但不得显示
Run Stop 或批量取消动作；用户消息撤回仍由 [Camp Message Send v23](camp-message-send-v23.md)拥有。Delivery 被
Scheduler claim、获得 `targetAgentRunId` 或离开上述 waiting 条件后，该预览退出；实际 queued/running Run 按 v35
进入当前区。Renderer 不为等待 Delivery 制造 AgentRun、取消原因或执行历史。

## 多输入入口

每个 AgentRun 的输入集合依次合并并去重 `inputMessageIds`、`anchorMessageId` 与对应 CampTurn 的
`triggerId`；queued Run 批次使用批内 Run 输入集合的并集，Delivery-backed 卡使用组内不同 `messageId`。
计数不得因消息正文尚未载入而退化。

输入数大于一时，卡头显示独立的层数按钮；它不得嵌入卡片展开按钮，也不得触发展开、收起或停止。按钮打开
输入清单浮层，逐条显示作者、最多两行摘要和“定位原消息”；尚未载入正文时保留对应输入占位。浮层打开后
键盘焦点进入内容，`Escape` 关闭并返回层数按钮。单输入卡不显示层数按钮。

## 紧凑卡几何

- 卡头最小高度为 40px；总览卡片中的队员头像固定为 20×20px，宽高和 flex basis 必须一致；
- 左侧 14px 状态节点与卡头首行垂直居中，竖向时间线从首节点中心延伸到末节点中心；
- 展开与停止操作相对卡片右边保留 9px inset，绝对定位的操作层不得越过该留白；
- 底部位置切换和详情收起控件保留各自命中区，不得因队员轨道收缩而重叠。

## 验收

- 没有 AgentRun 的 waiting Delivery 仍出现在单队员执行台与总览，claim 后由真实 Run 接管；
- waiting Delivery 卡没有停止入口，既有 queued Run 批次仍只停止其 exact Run ID；
- 普通、运行中、历史、queued 批次和 Delivery-backed 卡的多输入按钮均独立可点击，并保留键盘焦点往返；
- 未载入消息正文时，多输入计数仍使用冻结 ID；
- 总览头像为正方形，状态节点与卡头居中，卡片操作右侧留白和底部两个控制命中区满足上述几何。
