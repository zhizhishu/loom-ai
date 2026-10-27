---
document_type: protocol-contract
contract: run-process-detail-surface-v40
authority: execution-console-workspace-entry-overview-selection
status: accepted
version: 40
source_version: v1.62
last_updated: 2026-09-20
---

# Run Process Detail Surface v40

继承 [v39](run-process-detail-surface-v39.md) 的三位置承载、共享详情 DOM、使命板抽屉底部例外、
Run 导航、Evidence、停止、折叠历史、Delivery 队列与紧凑卡片。本版只替换普通 Camp 与完整
Mission 会话进入时的默认过程 scope，不改变 AgentRun、Delivery、Evidence、位置偏好、Renderer wire
或 Camp／Mission route。

## 进入运行中会话的总览 scope

从其他 Camp、一级页面或应用启动／恢复进入普通 Camp 或完整 Mission 会话时，Renderer 继续只以
`status=running` 的 AgentRun 作为自动打开资格，并按 `createdAt + id` 选择最新 exact Run。保存的
`right | inspector | bottom` 承载位置、执行 Tab 激活、卡片展开、最新指令定位、live follow 与不移动
DOM 键盘焦点的行为保持不变。

本次进入的过程 selection 改为“总览”，同时把上述最新 Run 保留为精确 `focusedRunId`。因此 Run 卡片仍在
总览中展开并定位，只有入口选中态和 Drawer scope 从所属 Agent 改为全部队员。该 selection 仍是工作区
局部瞬时状态，不写入 URL、Main preferences、Camp、Core 或 SQLite；重新进入时从当前权威 snapshot 重建。

没有 running Run 时仍不自动打开。`queued`、`waiting`、`recovery_blocked` 与 terminal Run 不具备资格。
用户已经停留在同一 workspace 时，后台 refresh、A2A、Runtime 事件或后续状态变化仍不得自动切换 scope、
Run 或焦点。

## 保持不变的精确导航

用户显式点击队员入口仍进入该 Agent 的过程；用户显式点击总览仍进入总览。消息发送回执、Task 关联执行、
通知与其他既有精确执行导航继续选择其目标 Agent／Run，不改为总览。使命板抽屉在 `bottom` placement 下
继续遵守 v39：已有 running Run 或本抽屉新提交消息产生 Run 时均不自动选择 scope 或展开 Drawer。

## 验收

- 普通 Camp 与完整 Mission 会话进入时，总览入口选中，最新 running Run 在总览中保持精确聚焦、展开和最新指令定位；
- 多个 running Run 继续按 `createdAt + id` 稳定选择，且 Agent、Run、route 与位置偏好均不持久化新增状态；
- 没有 running Run、同 workspace 后台更新及使命板抽屉底部例外保持既有关闭／不抢焦点行为；
- 显式队员、发送回执、Task、通知、停止、Evidence、三位置切换与共享 Drawer DOM 保持 v39 既有行为。
