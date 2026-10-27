---
document_type: version-overview
version: v1.60
lifecycle: historical
authority: version-scope-and-status
design_status: confirmed
implementation_status: completed
model_context_change: true
last_updated: 2026-09-19
---

# Rovai-ai v1.60：Camp 消息与多输入 AgentRun

前置：[v1.59](../v1.59/README.md)。后继：[v1.61](../v1.61/README.md)。本版只重构公开 Camp；Single Chat 继续使用自己的
Conversation-local 输入、队列和上下文合同。

## 目标

公开 Camp 的执行主链收敛为：

```text
CampMessage publication
→ 为每个目标建立稳定 Camp-member Conversation 路由
→ 每个目标一条有序 Message Delivery
→ Scheduler 原子 claim 队首完整前缀
→ 创建并冻结一个多输入 AgentRun
→ Runtime 接受整批输入
→ Run 与 Delivery 分别记录执行和处理事实
```

CampTurn 不再拥有新执行的调度、预算、输入或完成权威；历史 CampTurn 只读保留。
消息是公共事实，Delivery 是一个目标的处理责任，AgentRun 是一次实际执行。普通聊天不再拥有
一个替代 CampTurn 的通用“全部完成”对象；Task、Mission、Automation occurrence 和
ChannelDelivery 继续维护自己的业务状态。

## 确认范围

- 等待阶段只持久化按 `CampId + AgentId` 排序的 Delivery；claim 成功才创建 AgentRun。
- 带目标的 publication 在同一事务中幂等建立必要 Conversation；claim 会修复旧实现已遗留的无路由 waiting lane，
  启动扫描与 30 秒兜底均可自愈，无需数据库回写。
- 一个 Run 冻结有序 `input_message_ids`，并以最后一项确定唯一 `anchor_message_id`。
- 用户、A2A、Mission start、Automation 与 Channel 入站统一为普通消息并按 FIFO 合批；来源不形成批次边界。
- claim 时读取并冻结当前 Agent 的 Runtime、模型、模式、权限、工作区和工具配置；等待 Delivery 不冻结配置。
- 删除协作预算、deadline、固定 fanout/depth、祖先环检查、`RUN_FACTS.delegation` 和所有替代账本。
- 删除 Gather 工具、Barrier、captured return、completion、`RUN_FACTS.gather` 和专属恢复；多人协作使用普通多目标 send。
- 只保留 self-send 拒绝。Agent Stop 精确停止一个 Run，不暂停队列，也不取消未领取 Delivery。
- 不开放用户业务重试。明确未接受且无副作用风险的同 Run 运输恢复继续保留；accepted/unknown 永不重放。
- accepted/unknown 在内部保留类型化证据，主界面只显示普通红色失败；旧执行真正隔离前，后继 Delivery 不得 claim。
- 本地 Principal Composer 消息仅在任何目标尚未 claim、且未进入冻结 Runtime 上下文时允许原文擦除式撤回。
- 删除 Core 持久 Composer Draft、旧未公开 Pending 及其恢复状态；已激活 Camp 的当前编辑由 Desktop
  按 Camp 本地恢复，发送失败或结果未知不清空。
- Channel 收敛为异步消息桥；Channel-bound Camp 的 Agent 公开消息默认产生独立、可去重 ChannelDelivery。
- Automation occurrence 只有 `started` 或 `skipped(overlap)` 两种入口结果，仍通过普通 Delivery claim 创建首个 Run。
- 普通 batch claim 由单一事件唤醒 Scheduler 负责；Core 启动时检查存量，并以不重置 deadline 的全局 30 秒只读优先
  兜底恢复；原 500ms 职责在独立串行维护任务中保留既有 non-batch Run 派发与其他职责，不再扫描普通
  Delivery/queued batch Run，也不以慢 preparation 阻塞 batch wake。
- claim 与最终交付复用同一 `RUN_INPUT.messages[]` 投影和 Runtime capacity；正文、viewer-visible quotes、
  逐消息 source attachments 与 Skills 共同参与 FIFO 前缀选择。
- `camp.read` 请求直接使用 `before/limit`、`messageId` 或 `thread/before/limit`；不再接受或翻译旧
  `mode/direction/around` 请求。
- Built-in IPC、Runtime Adapter 和 `camp.read` 不再用统一总量阈值裁剪成功结果；完整交付或明确失败。
- Runtime 输入仍有确定性容量：profile 缺省 96 KiB，不再应用通用 1 MiB clamp。
- `SHARED_CONVERSATION` 使用每个 Camp+Agent 的 accepted 增量公共消息窗口，保留原始顺序和当前 Agent 自己的消息；
  `camp.read` 则始终读取调用时最新可见状态，不受 Run 的 frozen ContextManifest 上下界限制。
- 所有受认证队员可发现、搜索并读取所有存续 Camp 的公共历史；目标 Camp membership 只服务参与、寻址与执行，
  不是 read ACL。旧 Manifest 漏项在 discovery 时动态补足，Single Chat 与 Runtime 私有记录不在此范围。
- `mission.get` 是不复用 Camp mutation gate 的只读操作；`mission.update/status` 继续要求当前写入权限。

字段级模型输入与 clean break 见[模型上下文变更 revision 2](model-context-change-camp-message-run.md)。
实施顺序和验证门槛见[实施计划](implementation-plan.md)，高成本取舍见[版本决定](decisions.md)。

## 当前状态

产品与架构决策以及完整字段级 revision 2 已由开发者确认。合同、Schema、Core、Runtime、CLI、Renderer、
Skill、Migration 与自动化验证已完成，并以 Delivery-first 主链取代旧 public Camp 执行模型。此处记录的是
仓库实现完成状态，不把未执行的安装包、第三方真实 Runtime 或真实渠道 Smoke 描述为发布资格。
`main` 的 Mission workspace lifecycle 拥有 Migration 162/schema 112；Delivery-first clean break 因此使用
Migration 163/schema 113，并显式接纳已运行旧功能分支 162 的精确物理结构作为收敛来源。AgentRun
Notification source 兼容扩展使用 Migration 164/schema 114。
首次 A2A 路由修复、公共读取范围与 Mission read/mutation 分层不改变 schema；存量 waiting Delivery 在普通 claim
事务中自愈，历史 Manifest 不回写。

## 使命卡片 v5.1 对齐增量

使命卡片按确认稿统一执行双弧整组轨道、最多五人的响应式重叠成员组、无框 `+N` 与实心蓝点未读提示。
执行中组继续最多显示三个头像；卡片变窄时优先收起成员头像，不挤压未读和时间。浅色与深色主题分别使用
满足正文对比度的未读语义色。这一展示增量不改变 Mission 数据、运行状态或 IPC 合同。

## 跨版本文档影响

| 范围 | 结论 | 证据或理由 |
| --- | --- | --- |
| Version lifecycle | 已更新 | v1.59 冻结为 historical；本概览、[实施计划](implementation-plan.md)与[版本索引](../README.md)建立唯一 current v1.60 |
| Decisions | 已更新 | [版本决定](decisions.md)记录 Delivery-first、CampTurn/Gather clean break、撤回擦除、完整传输、渠道/Automation、事件唤醒调度、本机 Composer 恢复、AgentRun 通知、公共读取范围与首次目标路由取舍 |
| Contracts | 已更新 | [模型上下文变更说明](model-context-change-camp-message-run.md)与当前合同索引已发布 Context、Run Facts、Message Delivery、Camp Read、Built-in Transport、Mission、Composer、Notification 与 Planned Shutdown 新版本 |
| Architecture | 已更新 | 长期 Architecture、系统图源与生成图已同步 Delivery-first 主链、目标 Conversation 自愈、公共历史读范围、`RUN_INPUT`、受监督调度任务、本机 Composer authority 与 AgentRun attention |
| UI | 已更新 | 当前 UI 规范与 Renderer 已同步等待预览、精确 Run Stop、红色失败、撤回、按 Camp 草稿恢复、continuation、发送前附件与 AgentRun 定位；使命卡片使用整组双弧、最多五人的响应式重叠成员组、无框 `+N` 与蓝点未读提示 |
| Runtime Activity | 确认无需更新 | 不改变 Canonical Runtime Activity 分类；只改变 Run 输入、运输完整性和终态/隔离调度 |
| Runtime compatibility | 确认无需更新 | 不改变已发布 Runtime 资格；大结果与新上下文使用独立 smoke 验证，不把本版推导为平台晋级 |
| Documentation routing | 已更新 | 版本索引、当前 Architecture、Contract 与 Decision 路由均指向已实施的 v1.60 权威 |
| Root README | 确认无需更新 | 本次重构改变内部消息与执行模型，不改变项目定位或 Runtime 支持范围 |
