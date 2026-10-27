---
document_type: protocol-contract
contract: run-process-detail-surface-v39
authority: execution-console-mission-drawer-auto-open
status: accepted
version: 39
source_version: v1.62
last_updated: 2026-09-20
---

# Run Process Detail Surface v39

继承 [v38](run-process-detail-surface-v38.md) 的当前 Delivery 队列与层数入口，以及此前版本的三位置承载、
共享详情 DOM、进入恢复、Run 导航、Evidence、停止、折叠历史、终态步骤计数和紧凑卡片。本版只收窄使命板
抽屉中底部执行台的自动打开边界，不改变 AgentRun、Delivery、Evidence、位置偏好或 Renderer wire。

## 使命抽屉的底部执行台

当 Mission 以使命板上的抽屉呈现，且保存的执行台位置为 `bottom` 时，Renderer 不因以下两类事实自动选择
队员或展开底部 Drawer：

- 进入该使命时，权威 snapshot 已含 `running` Run；
- 用户在该抽屉提交消息，随后 Delivery 被 claim 并出现对应 Run。

Run Pulse 仍显示真实队员与状态，用户显式点击“总览”或队员入口后继续打开同一个执行详情。普通 Camp、完整
Mission 会话，以及 `right` / `inspector` 位置继续沿用 v35 的既有自动打开规则。Mission Activity 仍先建立并
保持当前选择；本例外不写回位置偏好，也不持久化 Drawer 状态。

## 验收

- 使命抽屉、`bottom` 与已有 running Run 同时成立时，Activity 保持可见，底部 Run Pulse 不选中队员，Drawer 不展开；
- 同一抽屉发送消息并产生新 Run 后仍保持收起，不夺走 Composer 焦点；
- 用户显式点击队员或总览后可以正常打开，普通 Camp 与完整 Mission 的 `bottom` 自动打开保持不变；
- `right` / `inspector`、三位置切换、Run selection、Evidence 与停止入口保持既有行为。
