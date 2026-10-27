---
document_type: protocol-contract
contract: notification-episode-v12
status: accepted
version: 12
source_version: v1.72
last_updated: 2026-10-21
---

# Notification Episode v12

继承 [v11](notification-episode-v11.md) 未被下述条款替代的规则。Inbox 与 changes wire
`schemaVersion` 升为 **11**。本合同收窄为 App 退出或已确认执行丢失的中断提醒，删除实时短亮的准入描述。

## 来源与升级

仅 `app_shutdown` 和 `execution_lost` 构成侧栏执行中断提醒。Cmd+Q 的既有受控退出流程在真实终态
事务中记录退出取消；强杀来不及提交时，由下次启动的既有恢复流程在确认执行丢失后记录。
App 仍在运行时，既有 Runtime 恢复流程确认 Host/worker 已结束且执行丢失，也保留 `execution_lost` 提醒。
仍可恢复的执行、普通 command 进度、网络抖动及按钮点击都不能据此生成执行中断提醒。
不新增关闭回调保证、在途清单、后台任务或启动逐会话推断。

用户在会话中手动停止不再准入 `run_stopped`，也不触发短亮。其他正常失败/未完成通知保持原规则。
同一 Run 的终态、Occurrence、Disposition、Episode 和 Journal 仍同事务提交；终态后更新不重复准入。
持久 `interruption_kind` 继续接受历史 `user_stop`，但它退出侧栏候选及 Thread 执行中断确认范围。
不改写历史事实，不把它伪造为已读，不影响独立的新回复和本机手动提醒。

Migration 210 将 projection schema 159 升为 160，只替换终态 producer 并与 receipt 原子提交。
既有事实、Disposition、清除边界和 Journal 保留；不回填历史执行。

## 读取与事件边界

`notifications.threadInterruptions({threadIds})` 保持 v11 的最多 200 ID、独立只读 WAL 事务和
Thread 部分索引。仅查询已加载、置顶及当前 Thread；不水合 Inbox 正文，不遍历全部历史会话。
有效候选必须属于当前 User/Thread，具有上述中断分类、精确 Run 仍存在；原单聊 Conversation 还必须
未结束。已结束 C1 的退出/失败来源一起退出候选，保留审计，C2 不代读。
持久点仍要求未 ACK 且处于既有 Active Attention 清除边界之后。

初始化/导航范围变化、通知 reset、重新聚焦及既有 30 秒恢复轮询可读取该范围；
`notification_episode.changed` 增量只刷新受影响的已加载 Thread，remove 缺少身份时才刷新范围。
空 changes 批次不刷新投影。消息/command 进度、普通 snapshot invalidation 和 snapshotSequence
变化不能触发通知轮询或投影重读。Dispatcher 身份不随阅读来源更新而重建。
Web 既有失效流只为通知事实/偏好变化附加 `notificationsChanged: true`，不运输内部事件正文；
客户端归并该标识后触发通知读取，普通 messages invalidation 不触发。重连 resync 仍正常恢复。
拉取期间收到的新通知信号合并为一次待刷新，当前请求结束后补读，并保留聚焦/恢复请求的恢复意图。
读取失败仍遵守原退避；停用或卸载后不补读。不增加队列、定时器或后台任务。

各批成功立即应用，失败保留该批最后可信值；挂起批次不能阻止其他批或后续受影响 Thread 的刷新。
代次、已知通知序号及确认回执共同拒绝旧响应。未知不是 false，reset 加载期间保留最后可信显示，
但旧代次快照不能作为新的自动确认依据。开销仍与请求 Thread 的中断事实量有关，不宣称恒定时间。

changesSince 删除 `interruptionAdmission`。不再为每条 Journal 水合停止短亮描述，
不保留本机停止意图、展示计时、状态槽几何检测或补播队列。

## 打开会话与范围确认

执行中断提醒表达“该会话的执行被 App 退出打断或已确认丢失”。前台有焦点的会话页面成功展示正式 Thread 内容后，
使用已加载的当前代次中断投影，冻结 Thread 和 `observedThroughChangeSequence`，调用既有
`notifications.acknowledgeThreadInterruptions`。不要求看到具体 Run、command 或输出；空输出同样可确认。
仅选中、缓存预览、加载失败和后台窗口都不能确认。侧栏是否展开不参与确认条件。
确认与工作区共用实际挂载条件；使命记录仍在加载或加载失败时不确认。
下一帧回调执行前重新验证请求与快照代次，失效回调不得记下本次已查看。
每次实际展示/重新聚焦只确认当时观察范围；之后的新中断不能被旧请求顺带确认。

`acknowledgeVisibleSources` 排除带中断分类的 Occurrence；精确消息/Run 可见性继续服务其他通知，
执行中断提醒不再依赖这一链路；普通失败气泡实际可见时继续回报精确 Run，包含无输出且执行抽屉关闭的场景。
Thread 范围命令保持当前 User、未清除、来源有效及观察边界的交叉校验，
未来/负边界拒绝，其他 Thread/通知不受影响。返回 `resultingChangeSequence` 防止迟到读取复活旧点。

显式“标记已读”保持 v11 的分步提交：先冻结中断投影边界和回复水位，保存本机提醒/回复设置，
本机成功后提交 Core。失败保留范围和原 UUID 重试，不扩大边界，不重复清除后来新设的本机提醒。
自动确认失败同样只重试原 Core 请求；复用通知恢复机制，不增加独立后台任务。
不得用全 Inbox markAllRead、本机遮点或倒退回复水位代替范围确认。

## 展示和保留

蓝点组合与名称由 [Current User Attention v10](current-user-attention-v10.md) 定义。
退出取消不新增 heads-up；其他失败的 heads-up 保持现有规则。
`run_stopped` 继续是终态 retention 的有效语义，历史手动停止审计也保留原 ACK/clear/回收能力。
