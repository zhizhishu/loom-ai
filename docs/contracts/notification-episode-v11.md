---
document_type: protocol-contract
contract: notification-episode-v11
status: accepted
version: 11
source_version: v1.72
last_updated: 2026-10-21
---

# Notification Episode v11

继承 [v10](notification-episode-v10.md) 未被下述条款替代的规则。Inbox 与 changes wire
`schemaVersion` 升为 **10**。本合同替代继承规则中“主动停止不生成通知”的限制。

## 中断来源

Occurrence 增加不可变、可空 `interruption_kind`：
`user_stop | app_shutdown | execution_lost`。分类只是原通知的来源事实；
Occurrence Disposition 仍是唯一已读真源，不增加中断已读水位，不修改本机 `manualUnread`。

用户精确停止、退出取消、现有恢复流程确认执行丢失时，在原 Run 终态事务中准入。
点击、请求在途、普通运输错误、仍可恢复的执行不构成中断。分类绑定精确 Run 和原单聊 Conversation。
正常业务失败不自动成为侧栏中断候选。历史已结束执行不回填。

此前排除的取消新增 `run_stopped`；原失败/未完成来源继续使用 `turn_failed` / `turn_incomplete`，
同一 Run 首次终态只准入一次。终态后的 cleanup、版本变化、同值更新、命令回放不再准入。
公屏 legacy Run、delivery-first batch 和单聊共用来源规则；不制造 CampTurn。
终态、Occurrence、Disposition、Episode 版本与 Journal 在同一事务提交或回滚。

Migration 209 将 projection schema 158 升为 159，增加分类、闭合语义枚举与 Thread 部分索引，
保留历史事实、Disposition、清除边界和 Journal，不扫描历史执行补造提醒。

## 有效候选和读取

侧栏候选必须属于当前 User 与目标 Thread、具有中断分类、精确 Run 仍存在；单聊的原 Conversation
还必须是未结束的 `single_chat` 且仍属于原 Thread。暂未出现在有界 Renderer 快照不是来源失效。
原单聊结束后，停止和复用失败来源一起退出候选；保留原未确认审计，不伪造 ACK、不让后继单聊代读。
持久蓝点还要求未 ACK 且在既有 Active Attention 清除边界之后。

`notifications.threadInterruptions({threadIds})` 每批最多 200 个非空 Thread ID，返回
`{throughChangeSequence, threads:[{threadId, hasUnreadInterruption}]}`。
边界与结果在一个只读事务捕获，查询从请求 ID 和
`(recipient_user_id,camp_id,admitted_change_sequence)` 的中断部分索引进入，不水合 Inbox/正文，
不枚举全部历史 Thread。客户端只请求已加载、置顶和当前 Thread；多批独立按序号接收。
开销与这些 Thread 的中断事实有关，不承诺与单个 Thread 的历史中断数量无关。

此读取进入既有独立读队列，使用从已准入 Database 绑定、惰性打开的只读 WAL 连接，
避免等待可选启动维护持有的主连接锁。每次读取都开启并结束自己的快照事务，
不暴露未提交的 Disposition，也不保留跨请求的旧事务。
这仍是同一 SQLite 权威；不启动第二个 Core、迁移、恢复、扫描、缓存或已读存储。
只读连接打开失败按该读取失败处理，不阻塞 Core 准入；确认命令继续由原 Gateway 和写连接提交。

既有通知事件、恢复轮询和重新聚焦驱动重读；不新增启动扫描或逐会话轮询。
迟到投影不能覆盖已知更新序号或确认回执。读取失败保留最后可信结果，未知不等于 false。

## 精确准入描述

changesSince 的每个 change 增加可空 `interruptionAdmission`：

```text
acknowledgementId, threadId, agentRunId, conversationId,
kind, admittedChangeSequence
```

只有该条 `occurrence_admitted` Journal 所绑定的精确 Occurrence 可提供描述，
不能从 Episode 当前 primarySemantic 或主动作推导。已 ACK 不移除该实时描述；
清除和来源失效会移除资格。它不受 heads-up 偏好、当前 Thread 静默或已读过滤影响。
不是第二份持久通知，也不通过 Inbox/reset 基线补播。

## 范围确认

新增 Domain Command `notification_episode.acknowledge_thread_interruptions`，
入口 `notifications.acknowledgeThreadInterruptions`：

```text
{commandId, command:{threadId, observedThroughChangeSequence}}
```

当前 User 在点击时冻结观察边界；Core 只确认该 Thread、该边界以内、尚未清除且来源有效的中断。
未来/负边界被拒绝；之后的新中断、其他 Thread、审批与其他通知不被顺带读取。
结果带 `changed`、原边界及 `resultingChangeSequence`。Gateway 按原 UUID/内容幂等回放。

侧栏“标记已读”先冻结中断投影边界和已知回复水位，再提交本机提醒/回复设置，
本机成功后才执行 Core 范围确认。本机失败不执行 Core；Core 失败保留原范围重试，
不重复清除本机提醒，不抹掉之后新设的“标记未读”。部分成功不能声称全部完成。
本机回执不确定时只回读偏好 owner；实际提醒值和回复水位证实保存成功后才继续 Core，
不能由降级默认值推断成功，也不在后台重新清除本机提醒。回读仍不确定时报告真实不确定性。
不能使用全 Inbox markAllRead 或本机遮点代替该命令。

自动确认继续使用 `acknowledgeVisibleSources`：必须在前台、正确表面、真实快照中实际看到精确终态结果。
公屏的中断标记、终态 Run 占位、三个执行台承载位置和原单聊终态摘要/最终输出均回报精确 Run。
缓存预览、正在运行的节点、仅选中 Thread、屏幕外内容都不是确认依据。

## 展示和保留

`run_stopped` 为未完成同级优先级，可由既有 Inbox 审计、定位、ACK 和 clear；
不增加停止弹出卡片或偏好设置，既有失败 heads-up 规则保持。
已读/清除且无其他活跃注意力的停止专属 Episode 进入原终态 retention；停止不能无限累积。
当前窗口短亮及无障碍标签由 [Current User Attention v9](current-user-attention-v9.md) 定义。
