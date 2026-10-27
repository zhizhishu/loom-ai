---
document_type: protocol-contract
contract: camp-open-projection-v21
authority: camp-open-and-execution-window-read-boundaries
status: accepted
version: 21
source_version: v1.62
last_updated: 2026-09-20
---

# Camp Open Projection v21

继承 [v20](camp-open-projection-v20.md) 的 Open schema 7、Snapshot 34、Data Contract 99、零写入读取边界、
执行窗口、连续缓存、虚拟滚动和维护职责。本版只校正 `messageDeliveries` 当前集合的覆盖范围；wire 字段、分页、
Evidence 身份、数据库合同和 Migration 均不变。

## 当前 Delivery 集合

Camp Open 与完整 Snapshot 的 `messageDeliveries` 必须投影目标 Camp 中所有关联消息未 tombstone 的当前
`camp_message_delivery` 行，不按 `camp_message.author_type` 过滤。用户、Agent、Mission、Automation 与 Channel
来源使用同一当前 Delivery 集合。

当前表通过既有 `MessageDeliveryView` 兼容形状公开：

- `deliveryKind=public_a2a`、`dispatchDisposition=dispatch`；该标签描述兼容 View，不把作者限定为 Agent；
- Agent 作者消息可以携带 `sourceAgentRunId`；用户消息没有来源 Run 时省略该可选字段；
- `waiting` 映射为 `dispatchPhase=never_attempted` 且 `targetAgentRunId=null`；claimed 与终态继续使用既有映射；
- 历史 `message_delivery` 只补充没有同 ID 当前行的兼容记录，不能遮盖或替代当前表。

有界 Open 的 `coverage.messageDeliveries` 与集合 loader 必须使用同一准入集合。活动 Delivery 继续优先于终态行；
达到窗口上限时按既有 coverage 公开遗漏，不能通过作者过滤让用户 waiting Delivery 在 `complete=true` 时消失。

## 验收

- 一条用户消息对两个接收者建立的两条当前 Delivery 与后续 Agent 交接 Delivery 均出现在完整 Snapshot 和 Camp Open；
- 忙碌接收者后续两条用户 waiting Delivery 在 claim 前出现在 Open，且 `sourceAgentRunId` 缺省、目标 Run 为空；
- 相同 fixture 的完整与有界读取都保留当前用户 Delivery；coverage 总数与实际 eligibility 一致；
- Open 继续拒绝 event history、业务 DML 和 Managed Blob 写入，v20 的启动恢复与文本重试 owner 不变。
