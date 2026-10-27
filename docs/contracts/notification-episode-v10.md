---
document_type: protocol-contract
contract: notification-episode-v10
status: accepted
version: 10
source_version: v1.72
last_updated: 2026-10-17
---

# Notification Episode v10

继承 [notification-episode-v9](notification-episode-v9.md) 未被下述条款替代的规则。

Episode wire schema 9 保持；Task 能力关闭时 Task 来源、inbox、未读计数、changesSince、单项和 heads-up 均不可见。列表过滤发生在分页 LIMIT 前，游标按原变化水位推进，不删除存量 episode。Task 偏好保留，开关不回写这些偏好。

Renderer 关闭时立即去除 Task 浮层与排队项目，并过滤在途响应中的 Task。Core 在 false→true 的设置事务中将当前通知序号保存为 `headsUpAfterSequence`，与 enabled 一起由设置 get/set 返回。读取、同值保存与重启不移动此边界；再次关闭后开启才建立新边界。

`changesSince` 每页（包括空页与 reset）增加 `taskCapability: {enabled, headsUpAfterSequence, observedThroughChangeSequence}`，与增量、SQL Task 过滤依据在同一读取事务中捕获；`observedThroughChangeSequence` 等于该页 `throughChangeSequence`。该字段也由设置 get/set 返回。

开关实际变化时，在设置事务内先捕获启用边界，再递增已有 `notification_change_clock`。这次递增只标记通知可见性变化，不产生 Occurrence/Journal 行或改变未读；游标允许经过这样的空序号。重复保存不递增。这样即使开关之间没有新通知，迟到响应也有确定顺序；没有新增数据库列或独立能力版本。

Renderer 用批次快照判断 Task，而不是等待另一路设置请求；多页消费使用最后一页快照。设置与通知共用一个 Host 能力投影，按 `observedThroughChangeSequence` 接收，较旧响应不能覆盖已确认的较新关闭；后续异步呈现前仍检查最新投影。设置读取失败保留已确认状态，初次未知不能否定有效通知快照。

Renderer 直接比较 Task changeSequence 与固定边界，不另读 Inbox 获取 Task 水位，不等待辅助 Promise，也不用 Infinity 消费未知变化。普通提醒继续按全局游标处理；Task 切换不直接改写消费游标，只有正常消费批次后才推进。旧 Task 不补弹，开启后产生的 Task 不因设置或 Inbox 慢、失败或迟到而被划为旧通知。原启动/reset 的全局基线规则不变。
用户原有显式审计仍保留。旧通知 Task 动作退到会话本身，不阻止普通导航。
