---
document_type: implementation-plan
version: v1.60
lifecycle: historical
authority: version-implementation-plan
status: completed
last_updated: 2026-09-19
---

# v1.60 实施与验收

范围见[版本概览](README.md)，字段级模型输入见
[模型上下文变更 revision 2](model-context-change-camp-message-run.md)。

## Gate 0：模型上下文二次确认

- [x] 调查当前 CampTurn、Message Delivery、Gather、Context、Automation、Channel、Runtime cleanup 与幂等边界。
- [x] 开发者逐项确认产品和架构取舍。
- [x] 形成完整的 revision 2 前后合同与迁移说明。
- [x] 开发者在阅读 revision 2 后确认同一 revision。

Gate 0 已完成；从 revision 2 实施，不擅自改变已确认语义。

## Gate 1：当前权威与数据库 clean break

- [x] 发布新 ContextManifest、Context Delivery Profile、Run Facts、Message Delivery、Camp History、
  Built-in Tool Transport、Automation 与 Channel 合同。
- [x] 以后续合同版本冻结首次目标 Conversation、存量 waiting 自愈、全员公共历史读取及 Mission 读写权限分层；
  Built-in Transport v28 原子轮换 catalog/capability，Session Charter revision 8 与模型上下文字节不变。
- [x] 更新长期 Architecture、`CONTEXT.md`、当前决定导航、UI 规范与文档任务路由。
- [x] 在 v1.59 Mission workspace lifecycle Migration 162/schema 112 之后新增 Delivery-first Migration 163/schema 113；
  保留历史 migration、终态 CampTurn/Gather、冻结 ContextManifest 与 evidence，并将已运行旧功能分支
  Delivery-first 162 的精确物理结构收敛到同一 163 当前结构。
- [x] 以 Migration 164/schema 114 增加 exact AgentRun Notification source/action/trigger；历史 CampTurn
  occurrence 原样兼容，不伪造 Turn 或 completion aggregate。
- [x] 删除旧 Composer Draft、未公开 Pending 和可重新激活的编辑/恢复状态，但不删除用户源文件。
- [x] 切换前让旧 active execution/Gather 安全终结；新调度不扫描或推进历史 Gather/CampTurn。

## Gate 2：Delivery-first 队列与多输入 Run

- [x] Message Delivery 以 `(camp_id, recipient_agent_id, queue_sequence)` 形成稳定 FIFO。
- [x] publication 在写 waiting Delivery 前幂等建立目标 Camp-member Conversation；claim 事务在 lane 查询前修复
  active/present 存量目标的缺失 Conversation，启动扫描与固定 fallback 自动恢复，不增加 migration。
- [x] Scheduler 在一个事务中选择可完整交付的队首最大前缀、创建 AgentRun、写入有序 AgentRunInput、
  claim 对应 Delivery，并冻结 Run 配置与输入锚点。
- [x] 未 claim Delivery 不提前创建 Run；新消息不追加已冻结 Run；严格 FIFO，不跳过队首。
- [x] 第一条必要输入超过本次 Runtime payload budget 时创建精确失败 Run，不交给 Runtime，随后继续队列。
- [x] claim 从本次 Runtime 配置解析一次容量；队首选择与正式交付复用同一消息投影和序列化口径，覆盖
  body、viewer-visible quotes、逐消息 source attachments 与 Skills，不保留独立估算 DTO。
- [x] 接受、取消、恢复和成员移除都按整个冻结批次及每条 Delivery 保留证据。

## Gate 3：发布、可见性、撤回与幂等

- [x] Core 对自动上下文、Camp Read、搜索、线程、回复展开和结构化引用执行同一消息可见性规则；每个
  quote source 在投影时按当前 Agent 和边界独立重验，外层消息可见不能泄露被 suppress/withdraw 的来源。
- [x] 本地可撤回消息在首次目标 claim 前只向 Principal 展示；claim 事务原子结束撤回资格。
- [x] 撤回原子取消全部 waiting Delivery，清除受控正文、引用、附件关系、FTS/缓存及 body digest。
- [x] 原发送命令转为 erased-terminal receipt；相同 command ID 永不再次进入 Handler。
- [x] Channel/Automation/Agent/A2A 消息不复用本地 Composer 的原文擦除合同。

## Gate 4：模型输入与历史读取

- [x] public Camp 使用 `RUN_INPUT.messages[]`；Single Chat 继续使用原 `CURRENT_INPUT`。
- [x] `SHARED_CONVERSATION` 从上次整批 accepted 的公共尾部到本次 claim 尾部选择增量消息，保留当前 Agent 自己的
  消息和原始顺序；最新 15 条之外使用 `omittedCount + historyReadCursor`，整条选择或省略，不裁正文。
- [x] Run Facts 删除 Gather 与 delegation；A2A Guidance 和特殊 Mission/Gather Current Input 分支退出。
- [x] `camp.read` 按调用时最新状态和 recipient-specific visibility 选页，不受 frozen ContextManifest 边界限制；
  完整返回选中消息，删除 80k scalar budget 与尺寸缩页。
- [x] `camp.list/search/read` 与 `history.search` 不再以目标 Camp membership/profile 授权；新 Manifest 捕获所有
  存续 Camp，旧 Manifest 漏项由 discovery 查询动态补足，`camp.read` 直接实时解析目标 Camp。
- [x] `camp.read` 请求收敛为 timeline `before/limit`、exact `messageId` 与 thread `thread/before/limit`；删除
  `mode/direction/around/after/cursor` 请求和 CLI 帮助，不增加旧模式翻译层。
- [x] `RUN_INPUT.messages[]` 按每条 message ID 投影 source attachments，不以作者类型决定是否加载。
- [x] 旧冻结上下文按原版本读取，不回填历史 `input_message_ids` 或重算 anchor。

## Gate 5：删除旧协作支线

- [x] 删除 CampTurn 新执行权威、协作预算、deadline、fanout/depth 和 ancestor-cycle 逻辑。
- [x] 删除 Gather Core 模块、CLI/catalog、captured return、completion pump、recovery、UI、Skill 和当前文档路由。
- [x] 删除 Message Delivery 业务重试和用户重试入口；保留同 Run 的明确未接受运输恢复。
- [x] 更新 Campfire 与 cli-operations，使多人邀请和成员返回都使用普通 send。

## Gate 6：Automation、Channel 与执行隔离

- [x] Automation admission 原子创建 `started` occurrence、新 Camp、系统消息和 Delivery；Scheduler 普通 claim。
- [x] overlap 直接 skipped；occurrence time limit 从 started admission 起计时；没有 queued occurrence。
- [x] Channel 入站在消息与 Delivery 提交后完成；Channel-bound Camp 的 Agent 公开消息自动创建独立 outbox。
- [x] Run 失败与 execution-isolation ACK 分离；cleanup 未确认时只保留后继 Delivery。
- [x] claim 前分别检查同一 Camp+Agent 的旧执行隔离与实际共享 executionRoot 的旧执行清理；任一未确认时
  Delivery 保持 waiting 且不创建新 Run。
- [x] accepted/unknown 默认换新 Native Session，除非 Adapter 已有可验证的旧 turn 终止证明。
- [x] 普通 batch claim 收敛到单一事件唤醒 Scheduler；启动检查和固定 30 秒全局兜底均从数据库恢复，
  空闲兜底不进入 claim 写事务；原 500ms 职责由独立串行维护任务承担，不再处理普通 batch，慢 non-batch
  preparation 不占住 batch wake/fallback 协调循环。

## Gate 7：完整 Built-in 结果与副本清理

- [x] 删除 Core request/response、CLI reader 和等效 wrapper 的统一总量拒绝。
- [x] 移除 Runtime Adapter 对 Built-in 完整结果的静默前缀截断；无法完整交付时明确失败。
- [x] 正常 Agent-facing 结果不引入 preview/blobRef/nextOffset 补读协议。
- [x] CLI 单次接收链只执行一次完整 Envelope validation；错误版本、未知 operation、非法 result/error 与
  损坏 receipt 仍拒绝。
- [x] Canonical result 检查改为借用，原样 Agent projection 移动所有权；保留确实改变字段的 operation-specific
  projection，消除只读检查和原样转交的全文 clone。
- [x] receipt v1 canonical digest 直接遍历借用结果树，不经 `json!`/`Value::clone()` 重建 payload；固定 digest
  golden 证明字段、排序、Unicode/转义、数组和数字 wire-compatible。
- [x] Replay 保存首次定稿的完整结果；evidence 保存完整结果或受管存储身份、字节数和 digest。
- [x] `mission.get` 与 mutation gate 分离；update/status 继续校验写权限。Catalog/CLI help 删除“authorized Camp”
  误导，并以 Transport v28 轮换 catalog/capability；无需改变 Charter 或 Native Binding context contract。

## Gate 8：Renderer 与产品收口

- [x] 执行区显示当前 Run 和“等待 · N 条”Delivery 预览，不伪造 queued Run 卡。
- [x] Stop 精确 CAS 当前 Run；删除公屏通用 Stop、队列暂停/恢复、重试和 unknown 手工结束入口。
- [x] accepted/unknown 主界面使用普通红色失败；诊断和 evidence 仍保留真实类型。
- [x] 删除 Core 持久 Draft/Pending/revision/lease；Active Camp 的结构化正文、quotes、reply、continuation 与
  ready attachments 由 Desktop-local Camp snapshot 恢复，发送失败或未知结果保留。
- [x] Continuation 只从 accepted 的唯一显式非 Lead 接收者产生并在提交前物化；anchored-only 可见消息直接
  建立本地 reply intent，发送时 Core 重验 message ID。
- [x] Main 持有 Camp+attachment authority，发送前图片预览、应用内预览、系统打开、reveal 与发送均重验路径；
  Renderer sourcePath 不能替换 authority。
- [x] batch AgentRun 终态进入 Notification Episode/heads-up，`open_agent_run` 精确定位，并由
  `visibleAgentRunIds` 独立确认；历史 CampTurn 通知继续兼容。
- [x] 撤回占位只用于人类时间线，不进入 Agent Read Model 或分页名额。

## Gate 9：验证与切换

- [x] Migration 覆盖 fresh DB、当前 schema、受支持旧来源、失败回滚、历史 frozen evidence 和旧 active cutover。
- [x] 队列覆盖 FIFO、合批、并发 claim、crash before/after commit、超大队首、Runtime 容量、用户附件、
  Skills、不可执行候选饥饿、双重 cleanup 门禁、成员移除和设置变更。
- [x] 可见性/撤回覆盖自动上下文、读取、搜索、线程、quote source、旧 cursor、FTS、附件与 command replay。
- [x] Runtime 覆盖 accepted/unknown cleanup、迟到 launch、进程 reap、executionRoot fence 和 Native Session rotation。
- [x] 强制 abort Scheduler 时同步 abort/wait sibling maintenance，慢 non-batch preflight 不越过 shutdown quiescence。
- [x] 大结果覆盖超过旧 1/8/16 MiB、Unicode、quotes、慢接收、分段到达、中断、replay 与 digest 一致。
- [x] Channel/Automation 覆盖 overlap、timeout、普通 claim、默认外发、outbox retry 与模型不重跑。
- [x] 运行 `pnpm docs:test`、`pnpm docs:check`、diff-aware 文档门禁、TypeScript、Rust 定向及全量测试；
  UI/真实 Runtime 验收只使用隔离 userData、Skill Library、MCP config 和临时数据库。

## 2026-09-19 使命卡片 v5.1 展示增量

执行中成员组保持最多三个头像，蓝色与琥珀色双弧改为包围头像、`+N` 和“执行中”的整组轨道，文字不再扫光；
页面隐藏及 reduced motion 继续暂停轨道动画。底部成员组使用 23px 头像和 7px 重叠，常规宽度最多显示五人，
卡片变窄时按实际可用宽度减少头像并以无底色、无描边的半粗体 `+N` 汇总。未读状态改为 8px 实心蓝点和
12px 半粗体“未读”，同时加重标题；浅色与深色主题分别使用可读的语义色。该增量不改变 Mission 数据、
运行状态或 IPC 合同。

定向验证覆盖常规与窄卡片的成员数量重算、头像尺寸和重叠、两个 `+N` 的光学垂直对齐、未读标记、执行双弧、
静态文字与恢复宽度。单 worker 完整 Vitest 207 个文件／2132 项、`pnpm typecheck`、`pnpm build:desktop`、
隔离 Electron `pnpm test:mission-board`、浅色／深色截图复核及文档治理门禁均通过。

## Rust 测试准入与退役记录

本次删除的 active Rust 测试随生产合同在同一改动中退出：public Gather/Barrier/completion、持久
Pending/Draft、CampTurn 预算/取消和旧 Delivery 重试不再存在于新执行主链。按源码中的 active `#[test]`
声明核对，合并后的 `origin/main@6b44843d` 基线 1,162 项、当前 1,145 项；diff 中删除 44 个旧 owner，
同时新增或迁入 27 个新 owner，净减少 17 项。保留的 successor owner 是 `delivery_queue::tests`、
v163 migration、public batch context、
撤回擦除/replay、完整结果运输、Channel/Automation 与 execution-isolation 测试；Single Chat 和历史 migration
测试未随 public Camp clean break 删除。

最后退役的 8 个 Context owner 分别依赖已退出的冻结式 Camp Read、CampTurn execution budget、单一 A2A
lineage，以及正文 prefix/continuation 与 whole-history character budget。相应当前合同由
`current_history_reads_live_state_without_id_guessing`、`delivery_unknown_never_consumes_a_redelivery_requirement`、
`batch_public_window_keeps_the_camp_agent_watermark_across_new_sessions`、
`run_input_is_complete_even_when_it_exceeds_the_history_body_limit`、
`oversized_required_context_fails_before_manifest_or_boundary_ack` 和 `delivery_queue::tests` 接管。v68-v71 与 v93
Migration owner 均保留并适配 Delivery-first fixture，没有因旧版本名称或执行时间而退役。

新增的独立 Delivery 队列与撤回测试拥有新的事务失败语义：修复前 waiting Delivery 会提前物化 Run、
cleanup 未确认可能放行后继、撤回命令可能重新发布。纯函数无法证明 claim、擦除与 erased receipt 的同事务
边界，因此使用隔离 SQLite fixture；最小命令分别为
`cargo test -p rovai-core --lib delivery_queue::tests::` 和
`cargo test -p rovai-core --features slow-tests --lib recallable_local_composer_message_is_erased_and_cannot_be_republished`。

首次 A2A 路由与公共读取回归使用真实 SQLite 事务而不是纯函数替代：Agent send 到没有 Conversation 的首次收件人后
必须立即可被 batch claim；历史 waiting lane 在 claim 中补建路由；目标 Camp 在 Manifest 捕获前无 membership、
捕获后退出或被旧 Manifest 漏掉时，list/search/read/history 仍遵循公开范围；跨 Camp `camp.read` 可读取 Run 启动后
的新消息。`mission.get` 的 operation 分类另以单元 owner 锁定为 read-only，update/status 保持 mutation。

本次新增三个 Rust owner 各自覆盖无法由既有测试表达的边界：`application` 的 forced-abort drop guard 证明
父 Scheduler 被取消时 sibling maintenance 与 launch permit 同步回收；Transport digest golden 证明借用式
canonical writer 没有改变 receipt v1 preimage；Notification 数据库测试跨 terminal trigger、Episode hydration、
action 与 exact visible acknowledgement，低层纯函数无法证明该事务/read-model 链。最小命令分别为
`cargo test -p rovai-core --lib forced_scheduler_abort_also_reclaims_supervised_maintenance`、
`cargo test -p rovai-core --lib receipt_v1_keeps_the_existing_canonical_digest_goldens` 和
`cargo test -p rovai-core --lib batch_agent_run_terminal_notification_navigates_and_acknowledges_exact_run`。

## 最终验证证据

- `cargo check --workspace --all-targets`：通过。
- `cargo test -p rovai-core --lib`：838 passed，0 failed，6 ignored，0 filtered out；ignored 均为文档声明的
  人工真实 Runtime smoke。
- `cargo test -p rovai-core --bin rovai`：28 passed，0 failed。
- `cargo test -p rovai-core --features slow-tests --lib camp_history::slow_tests::`：7 passed，0 failed。
- `cargo test -p rovai-core --features slow-tests --lib context::slow_tests::`：44 passed，0 failed；包含
  Delivery-first Context、Runtime Input Delivery、历史 v68-v71/v93 migration、全员公共历史与 live Camp Read owner。
- `cargo test -p rovai-core --features slow-tests --lib --no-run`：全部 slow-test target 编译通过。
- `pnpm typecheck`：通过。
- `pnpm test`：文档、Skill、Electron sandbox、207 个 Vitest 文件/2,127 项测试，以及 Node 脚本
  324 passed、2 skipped，全部通过。
- `cargo fmt --all -- --check` 与 `git diff --check`：通过。

本轮没有执行安装包、第三方真实 Runtime 或真实 Channel 网络 smoke；它们不是上述仓库实现完成结论的证据。
