---
document_type: interface-contract
contract: thread-replies
version: 1
status: accepted
authority: thread-reply-reading
last_updated: 2026-10-21
---

# Thread Replies v1

`thread.messages.replies` 是 Desktop/Web 的 Thread-scoped 只读操作。Core 内部路由为
`camp.messages.replies`；不创建消息、Run、模型调用或数据库 migration。

## 关系与可见性

只沿持久化的 `replyToThreadMessageId` 追溯最早祖先，再读取该祖先的所有后继，按消息
`sequence` 平铺、每条仅一次。同一消息的多个 Run inputs、quote excerpts、Turn 不形成边。
父节点必须属于同一个 Thread 且 sequence 小于子节点；断链在最后可达祖先终止，这也使损坏的
循环或向前链接有限。Tombstone 保留关系穿透，正文不返回；withdrawn 返回状态占位，清空
body/content/attachments/quotes。请求的消息不存在、已 tombstone 或属于另一 Thread 时返回
`sourceAvailable:false` 和空列表。不存在的 Thread 拒绝请求。

## 分页

参数：`threadId`、`messageId` 必填；`sequence` 默认 0、不得为负；`before` 默认 false；
`limit` 默认 50，Core 限制到 1–100；`runAnchorMessageIds` 默认空、最多 96 个。
after 方向取 sequence 严格大于游标的最早一页；before 取严格小于游标的最后一页，响应仍升序。
删除导致游标页为空时，after 返回剩余最后一页，before 返回剩余第一页，保留导航可达性。

响应 `schemaVersion:1`，含 `threadId`、请求 `messageId`、`rootMessageId|null`、
`throughGlobalSequence`、`sourceAvailable`、`replyCount`、`hasEarlier/hasLater`、
`messages:ThreadMessageView[]` 和属于该链的请求 `runAnchorMessageIds` 子集。
replyCount 排除可见根消息，不包含执行占位。水位与关系、内容在同一只读事务读取。
水位是当前观察版本，不是历史快照分页锁；消息撤回等新状态可改变后续页。

## 成本与缓存

Core 使用主键追溯祖先，复用 `camp_message_direct_reply_idx` 遍历子节点。
每次查询遍历当前链的 ID/sequence/可见性，成本随该链长度增长；分页限制的是正文 hydration
与返回数量，不能宣称遍历成本固定。无关会话历史不参与链遍历。不读取 event_log 或 Evidence；关系查询不读 Run inputs/Turn，
单页正文复用既有消息 hydration（含来源模型和可撤回元数据）。不检查附件文件或启动 Runtime。
当前数据规模不为此新增持久 root 索引。

Renderer 在当前挂载的 Thread/Host 内最多缓存 8 页，每页 50 条，只渲染当前页。
未打开不读；重复打开未失效页复用结果。现有 Thread 消息通知、重连、显式 resync 和新增活动 Run
anchor 使缓存失效；通知可粗化到整个 Thread，100ms 合并，单请求飞行加一次必要后继读取。
撤回/删除通知先移除旧内容，代际和水位校验拒绝迟到结果；失败保留安全旧页与重试入口。
切换目标/卸载不能提交旧页；不增加定时轮询。完整长链通过双向分页访问，不靠公屏最近消息猜测完整性。

当前活动 Run 以 `anchorMessageId` 判断链归属，即使锚点不在当前消息页。执行条显示在最后一页，
复用既有 Run 时间线顺序与连续执行摘要；终态后撤去占位，已发布消息保留。执行过程读取继续由
现有按 Run 分页模块拥有，不计入回复计数或回复正文缓存。
