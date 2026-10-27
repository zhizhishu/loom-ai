---
document_type: version-decisions
version: v1.60
lifecycle: historical
authority: decision-rationale
last_updated: 2026-09-19
---

# v1.60 版本决定

<a id="v1-60-d01"></a>
## V1.60-D01：等待责任属于 Delivery，执行边界属于冻结后的多输入 AgentRun

- 状态：accepted
- 日期：2026-09-17
- 当前权威：revision 2 已确认，按本决定实施

提前创建可追加 queued Run 会把排队、配置和执行身份混成一个可变对象。选择只持久化按
`CampId + AgentId` 排序的 Delivery，在 Scheduler claim 时原子选择队首完整前缀、创建 Run 并冻结有序输入、
当前执行配置和最后一条输入锚点。代价是 UI 只能把等待显示为队列预览，但 crash 恢复、设置变更、撤回和
Run immutability 都只剩一个权威边界。

<a id="v1-60-d02"></a>
## V1.60-D02：删除 CampTurn 执行权威、协作预算与 Gather，不建立换名替代物

- 状态：accepted
- 日期：2026-09-17
- 当前权威：revision 2 已确认，按本决定实施

CampTurn 同时承担调度、预算、完成聚合和渠道归属，迫使无关 Agent 互相等待，也让多输入 Run 必须选择虚假的
单一因果根。选择删除它对新执行的权威，并同时删除累计次数、deadline、fanout/depth、预算投影和 Gather
Barrier/completion。多人邀请与返回全部使用普通消息；Task、Mission、Automation 和 Channel 各自结算。

系统明确接受自动协作不再保证在固定次数或时长内结束，也不保证多人回复只唤醒主持人一次。历史 CampTurn、
Gather 和冻结 evidence 只读保留，不能被迁移伪造成新协议对象。

<a id="v1-60-d03"></a>
## V1.60-D03：撤回以首次 Agent 认知边界为门槛，并擦除 Rovai 控制范围内的原文

- 状态：accepted
- 日期：2026-09-17
- 当前权威：revision 2 已确认，按本决定实施

若目标 Agent 在 claim 前能从公共历史看见正文，“等待中”和撤回就不可信。选择在任何目标首次 claim 前只向
Principal 展示本地 Composer 消息；claim 事务使消息失去撤回资格。成功撤回删除 Rovai 活跃数据中的正文、
本消息引用/附件关系、搜索索引、缓存和普通内容摘要，只保留顺序、撤回者、时间、取消事实及无正文的
erased-terminal command receipt。

Quote snapshot 在存储中仍是不可变摘录，但外层消息可见不自动授予 source message 可见性；自动上下文、
read、search 与 thread 在每次 Agent-facing 投影时都按当前查看者和边界重验 source。这样既保留引用的历史
完整性，又不能用可见消息把仍可撤回或对另一目标仍 suppressed 的正文提前带给当前 Agent。

这不是取证级擦除，不覆盖 WAL、备份、剪贴板、用户原文件或第三方副本。Channel、Automation、Agent 和 A2A
内容有独立上游或执行证据，因此不复用该原文擦除合同。

<a id="v1-60-d04"></a>
## V1.60-D04：Agent-facing Built-in 结果完整交付或明确失败，不按总量静默降级

- 状态：accepted
- 日期：2026-09-17
- 当前权威：revision 2 已确认，按本决定实施

统一 1/8/16 MiB 或 Camp Read 80k 总量阈值会让合法成功结果在不同层被拒绝、截断或偷偷缩页。选择删除这些
Rovai-owned 全局总量规则；底层仍可使用 bounded buffer、chunk、backpressure 和 managed spool，但不能改变一个
调用的逻辑结果。完整到达才是成功，无法完整交付就明确失败或中断。

Runtime 输入是另一条边界：Scheduler 必须知道能冻结多少必要消息，因此在 claim 时只解析一次 payload budget，
未声明能力默认 96 KiB，不再把 1 MiB 写成通用上限。合批选择与最终交付复用同一消息投影和序列化口径，
正文、quotes、逐消息 source attachments 与 Skills 不再由另一份估算 DTO 近似。

Envelope 接收链只做一次完整验证。Canonical result 检查和 receipt digest 直接遍历借用的结果树；原样
projection 移动所有权。receipt v1 的字段、排序、转义、数字与 digest 保持不变，不为性能清理建立第二份 wire。

<a id="v1-60-d05"></a>
## V1.60-D05：Channel 与 Automation 复用普通消息和 Delivery，只保留自己的业务结果

- 状态：accepted
- 日期：2026-09-17
- 当前权威：revision 2 已确认，按本决定实施

Channel 入站在 CampMessage 与目标 Delivery 提交后即完成接收，外部回复由独立 ChannelDelivery 负责；
Channel-bound Camp 的 Agent 公开消息默认外发，不根据 Run 来源、合批组成或 anchor 推断。失败只重试 outbox，
不重跑模型。公开 `rovai send` 是对该 Channel Camp 外部可见的成员发言，不再混用作私有控制通道。

Automation 触发原子创建 started occurrence、新 Camp、系统消息和 Delivery，再由普通 Scheduler claim；相同
Automation 尚有 active occurrence 时直接 skipped(overlap)。不新增 queued occurrence、专用 AgentRun 输入或来源型
批次边界，occurrence timeout 与通知仍由 Automation 自己结算。

<a id="v1-60-d06"></a>
## V1.60-D06：普通 Delivery 使用单一事件唤醒 claim owner 与固定全局兜底

- 状态：accepted
- 日期：2026-09-18
- 当前权威：Public Camp Message/Delivery 架构与 Message Delivery v10

固定 500ms 扫描让空闲 Core 持续申请普通队列写事务，并把正常消息启动和同 lane 接续增加至多一个 tick 的等待；
终态、网络恢复和周期扫描又各自可能领取新 Delivery，使 claim 所有权分散。选择由单一常驻 Scheduler 拥有普通
batch claim：状态提交后只发送无负载 wake，Scheduler 从数据库分页领取并并发准备 Runtime；终态只结算和 wake，
网络恢复只派发其明确获准的既有 Run。

本次不保存精确 lane hint，也不引入持久通知或新的恢复状态机。相比按需启停 timer，保留一个不会被普通 wake 推迟的
全局 30 秒兜底更简单且能覆盖进程内漏通知；代价是空闲时仍有低频只读检查。兜底确认无 waiting Delivery 或 queued
batch Run 后不进入 claim 写事务。原 500ms 职责保留在一个独立、串行且不重叠的维护任务中，继续处理既有 non-batch
Run、Automation、取消和 Single Chat，但不得领取普通 Delivery、派发普通 queued batch Run，或用慢 preparation 占住
普通 batch 协调循环。

Scheduler 与旧维护循环由 `run_core` 作为 sibling task 统一监督。正常退出和强制 launch-handoff 超时都必须
取消并等待两者，不能因父 Scheduler future 被 abort 而遗留无句柄的慢 maintenance preflight。

<a id="v1-60-d07"></a>
## V1.60-D07：Camp Read 使用直接意图字段，不保留模式翻译层

- 状态：accepted
- 日期：2026-09-18
- 当前权威：Camp History v8 与 Built-in Tool Runtime

旧 `Item / Around / Thread / Timeline` union 同时把用户意图和内部查询策略暴露为 `mode/direction`，CLI 又在
发送前补写默认值，造成 direct flags、JSON 输入、Schema 与补读提示有两份合同。选择收敛为 timeline
`{before?, limit?}`、exact `{messageId}` 和 thread `{thread, before?, limit?}` 三种直接形状；默认 limit 为 20，
timeline/thread 固定向前读取。

`mode`、`direction`、`around`、`after` 和 generic `cursor` 从当前请求合同删除，CLI 不建立旧字段到新字段的
兼容翻译。这是开发期 clean break；输出可继续携带既有 mode/direction 描述结果形状，但不恢复旧请求面。

<a id="v1-60-d08"></a>
## V1.60-D08：Active Camp 未发送输入由 Desktop 按 Camp 本地恢复，不恢复 Core Draft

- 状态：accepted
- 日期：2026-09-19
- 当前权威：Camp Composer Draft v15 与 Public Camp Composer 架构

删除 Core Draft/Pending/revision/lease 不应同时删除用户在 Active Camp 中切换、刷新或重启后的未发送输入。
选择由 Desktop 保存一份按 Camp 隔离的有界 snapshot，包含结构化正文、quotes、reply、continuation 与附件身份；
Core 仍只在发送时接收一个冻结快照，不参与 autosave、跨客户端合并或恢复协调。

附件路径 authority 留在 Main，以 Camp+attachment identity 重验预览、open、reveal 和发送；Renderer snapshot
不能替换路径。Continuation 只来自上一条 accepted 本地用户消息的唯一显式非 Lead 接收者，并在下一次发送前
转换为普通 recipient。搜索/around 已显示的消息可直接形成本地 reply snapshot，发送时再由 Core 重验 ID。
Pending Camp 的首次输入仍遵循自己的非恢复合同。

<a id="v1-60-d09"></a>
## V1.60-D09：Delivery-first 完成通知直接引用 exact AgentRun

- 状态：accepted
- 日期：2026-09-19
- 当前权威：Notification Episode v7 与 Current User Attention v6

新 batch AgentRun 没有 CampTurn，继续用 Turn-only occurrence/action 会丢失正式完成/失败提醒与精确导航。
选择让每个终态 batch AgentRun 产生自己的 immutable occurrence，Episode/action 携带 `agentRunId` 并以
`open_agent_run` 打开对应成员的执行记录。历史 CampTurn 通知继续只读兼容，不为新 Run 伪造 Turn，也不创建
多人 completion aggregate。

确认仍按 exact source：只有该 Run 的执行节点进入当前可见执行视口才提交 `visibleAgentRunIds`；打开同一 Camp、
另一 Run 或来源消息都不能顺带确认。Migration 164/schema 114 只增加来源、投影与终态 trigger，不改写历史通知。

<a id="v1-60-d10"></a>
## V1.60-D10：公共 Camp 历史对所有受认证队员开放，成员关系不作为读取 ACL

- 状态：accepted
- 日期：2026-09-19
- 当前权威：Camp History v8、Mission v4 与 Built-in Tool Transport v28

CampMember 的职责是参与、寻址与执行。把它复用为公共历史 ACL，会让一个有效队员无法读取其他 Camp 的公开消息，
并使旧 ContextManifest 中的成员快照意外变成长期权限表。选择让每个受认证队员读取所有存续 Camp 的公共历史：
`camp.list/search/read` 与 `history.search` 不查询目标 Camp membership/profile；`camp.read` 直接使用调用时实时边界，
旧 Manifest 漏项由 discovery 查询动态补足。Manifest 仍保存自动上下文和时序证据，不授予或撤销读取权。

该开放只覆盖公共 CampMessage。Single Chat、Runtime 私有记录与文件内容 authority 不随之开放；recallable、withdrawn、
目标 waiting suppression 和 quote-source 重验继续按查看者执行。`mission.get` 同样作为纯读取与 mutation gate 分离；
`mission.update/status` 保留当前成员、Run 和 epoch 写入门禁。拒绝通过临时加入目标 Camp 或回写历史成员关系绕过问题，
也不为读取建立新的 ACL 表。

<a id="v1-60-d11"></a>
## V1.60-D11：发布事务建立目标 Conversation，claim 同事务修复历史断路 lane

- 状态：accepted
- 日期：2026-09-19
- 当前权威：Camp Message Send v22 与 Message Delivery v10

Delivery 是等待责任，但 Scheduler 的 eligible lane 需要稳定 Camp-member Conversation。旧实现只写 waiting Delivery，
首次 A2A 收件人没有 Conversation 时便永远无法进入 inner-join 候选。选择在消息发布事务中为每个显式目标幂等建立
Conversation，再写 Delivery；仍不提前创建 Run、冻结 Runtime 或执行外部工作。

仅修新消息不能恢复已经卡住的 waiting rows。claim 事务因此先补建 active/present 目标缺失的 Conversation，再执行
原有 membership lifetime、Runtime、隔离与 cleanup 门禁。启动扫描和固定 30 秒 fallback 都会进入同一路径，旧队列
无需 schema migration、一次性数据回写或额外维护事件即可自愈。拒绝把 Conversation join 改成可空并让无稳定路由的
Run 继续创建，也拒绝永久后台轮询另一份修复队列。
