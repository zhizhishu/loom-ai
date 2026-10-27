---
document_type: protocol-contract
contract: durable-task-v6
status: accepted
version: 6
source_version: v1.72
last_updated: 2026-10-17
---

# Durable Task v6

继承 [durable-task-v5](durable-task-v5.md) 未被下述条款替代的规则。

实例 Core 是唯一开关真源：`preferences.tasks.get {}` 与 `preferences.tasks.set {enabled:boolean}` 只向 User Host 暴露。新库和缺少设置的升级库默认 false。Migration 206 / schema 156 新建单行 task_preference；设置与变更通知事务后发布，设置可随时切换，不等待 Run、队列或任务结算。

Migration 207 / schema 157 为该行增加 `heads_up_after_sequence`，升级时取当前通知序号，不改 enabled、任务、通知事实或未读状态。get/set 返回 `{enabled, headsUpAfterSequence, observedThroughChangeSequence}`；后两者分别是 Core 管理的固定通知边界和读取时序号，不能通过 set 输入修改。false→true 与边界捕获同事务；实际切换同时递增已有通知时钟，用来隔离迟到响应。重复保存只修复工具投影，不移动边界或递增时钟。通知批次携带同一快照，见 [Notification Episode v10](notification-episode-v10.md)。

新 Task create/get/list/update 在实际操作时校验开关；关闭返回 `task.feature_disabled`、`Tasks are disabled. Continue with messages.`、recovery `stop`。开关在业务读写同一 Core 锁/事务内判断；关闭不读取 Task 内容、不创建/修改业务任务、不停止 Run。已提交的精确命令/运输回执继续原样重放。

关闭不删除 Task、历史关联、事件和冻结输入，不批量完成、取消或释放任务。关系结束等既有生命周期完整性维护继续；普通读取、计数、通知和 UI 不公开其 Task 结果。重新开启恢复业务管理。其他状态、权限、审计和终态规则继承 v5。

新 Send 不再建立 Task 关联，与开关无关；旧参数、等待工作和续做规则见 [Send v28](camp-message-send-v28.md)。
