---
document_type: protocol-contract
contract: run-process-detail-surface-v37
authority: execution-console-run-card-workspace
status: accepted
version: 37
source_version: v1.62
last_updated: 2026-09-20
---

# Run Process Detail Surface v37

继承 [v36](run-process-detail-surface-v36.md) 的 Delivery-backed 排队卡、多输入入口与紧凑卡几何，以及
[v35](run-process-detail-surface-v35.md) 的三位置执行台、共享工作区、进入规则、Run 卡片和
[v34](run-process-detail-surface-v34.md) 的 Evidence、按窗口读取、Tool 分组、完整内容及展示边界。
本版只替换终态工具组的步骤计数口径，不改变 AgentRun、Canonical Activity、Evidence、分页、缓存、
Renderer wire 或 Runtime 状态。

## 终态步骤计数

工具组真实收口后只显示 `已完成 N 个步骤`。这里“完成”表示步骤已经结算，不表示执行成功；`N` 统计
当前组已读取、去重后的全部逻辑操作。`completed`、`failed`、`stopped`、`skipped` 与 `recorded`
均各计一步，失败、停止、跳过和结果未知不再追加独立数量。每条操作的实际结果继续由展开后的 Tool 行、
状态图形和可访问名称表达。

同一 Built-in 与已关联 Shell 载体仍只计一步；started/result/delta 与一个 Activity 的多文件展示行不
重复计数。存在 `running` 或 `waiting` 操作时继续显示当前指令或等待审批，尚未形成真实边界的运行中尾组
继续使用 provisional 活动态，不提前显示终态步骤数。Runtime Compaction 仍是根级非 Tool item，不进入 N。

## 验收

- 单个失败操作收口后显示 `已完成 1 个步骤`，同时保留失败状态；
- 成功、失败与停止混合的三个逻辑操作显示 `已完成 3 个步骤`；
- skipped、recorded 与 completed 一样各计一步，但不伪造各自的成功状态；
- 活动组、等待审批、运行中尾组、去重、分页范围、展开详情和可访问状态保持既有行为。
