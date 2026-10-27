---
document_type: version-overview
version: v1.62
lifecycle: historical
authority: version-scope-and-status
design_status: confirmed
implementation_status: completed
model_context_change: true
last_updated: 2026-09-20
---

# Rovai-ai v1.62：Mission 状态解耦、执行提示与工作区收敛

前置：[v1.61](../v1.61/README.md)。后续：[v1.63](../v1.63/README.md)。本版让 Mission 业务状态成为真正独立的操作：有权修改当前
Mission 的 Agent 可直接设置任一状态，`sourceMessageId` 对所有状态都只是可选关联；并把 Worktree 清理改为
持久意图驱动的后台流程，让使命板各状态列独立滚动，同时让启动入口和执行提示直接跟随 Delivery/AgentRun
事实，并保留既有视觉体系。

## 目标

- `needs_you` 与 `completed` 不再要求 Agent 先发布消息并取得消息 ID。
- 显式来源仍必须是同 Camp、已公开且未删除的消息；无效来源原子拒绝。
- 省略来源会清除旧关联；状态与关联共同决定 `changed`，Replay 与活动幂等保持不变。
- catalog、真实 CLI help、实际错误恢复和 Core 使用同一语义。
- 状态解耦不改变 Mission 修改权限、执行生命周期、数据库、Bootstrap、Run Facts、ContextManifest 或 UI wire；
  启动增量只为既有 path-free `MissionRecord` 增加 `startAvailable`。
- 已确认的 Mission
  续作增量只在专属 Bootstrap 中增加一条工作目录说明并轮换 Session Charter revision。
- Worktree 清理命令先拒绝可预见的脏现场与不安全 detached 提交；独立后台 owner 按目录归属、expected OID 和双检查点执行，未发生删除的失败可安全恢复。
- 删除使命并清理时，清理意图与 Camp/Mission 删除同事务提交，卡片先消失，后续失败进入既有 orphan route。
- 持久 Mission Worktree 的当前分支不再作为执行门禁；受管分支身份保留给资源清理，活动页实时展示 checkout。
- 累计 Diff 继续使用固定 `base_sha`，checkout 与列表同次刷新，文件详情不复用旧临时 index。
- 看板四个状态列各自拥有纵向滚动位置；标题、筛选和列头固定，窄桌面窗口只在看板区域横向切换。
- 跨列拖动在目标列边缘自动滚动；右键和 Shift+F10 继续提供同一非拖拽状态操作。
- 执行台支持右侧、浮层和底部三个保存位置；右侧与 Mission 活动、文件共享标签集合和分栏比例。
- claim 前的当前 waiting CampMessageDelivery（包括用户消息）以只读排队消息卡进入执行台；多输入 Run/队列使用独立可点击层数入口。
- 进入普通或完整 Mission 会话时，只为最新 `running` Run 自动打开总览并定位该 Run 的最新指令；使命板抽屉的
  底部执行台保持收起，后台刷新不抢选择或焦点。
- 当前用户消息显示轻量处理回执，并在所有接收队员均未读时通过权威版本围栏直接撤回。
- Mission 启动受理后立即隐藏入口；claim 创建 queued Run 即显示“执行中”，不等待 Runtime 连接或输出。
- 等待领取的启动 Delivery 只关闭重复启动入口，不伪装成执行；普通消息 claim 后使用同一活跃 Run 判定。
- 使命板一级入口蓝点按 Core-owned `hasUnread` 统计有未读 Agent 回复的使命，不再复用 `needs_you` 状态。
- 当前普通或 Mission Camp workspace 位于前台时，该 Camp 全语义通知不弹临时浮层，但精确来源未读保持不变。
- AgentRun 通知跨底部、Inspector 与右侧 Portal 使用同一可见性和定位边界；关闭的右侧执行标签可被精确恢复。
- 冷启动超过 400ms 时以不透明整窗品牌画布替代内容区“正在打开会话”；只保留完整 Logo 的轻呼吸，ready 后短暂淡出，
  错误恢复继续使用独立可操作界面。

字段级协议见 [Mission v11](../../contracts/mission-v11.md)与
[Built-in Tool Transport v30](../../contracts/builtin-tool-transport-v30.md)；执行与消息增量见
[Run Process Detail Surface v40](../../contracts/run-process-detail-surface-v40.md)、
[File Preview v17](../../contracts/file-preview-v17.md)和
[Camp Message Send v23](../../contracts/camp-message-send-v23.md)。实施与验证见
[实施计划](implementation-plan.md)，取舍理由见[版本决定](decisions.md)。

Mission Bootstrap 续作提示的完整前后合同、版本边界与二次确认见
[模型上下文变更 revision 3](model-context-change-mission-continuation.md)。

## 当前状态

状态解耦、异步 cleanup、独立列滚动、Agent Run Card 与消息撤回增量已经完成实现及各自验收。
Mission 启动与执行提示的 Core/Renderer/合同实现与全量门禁已经完成，由 PR #453 合入 `main`，并验证功能
提交是最新 `origin/main` 的祖先。使命板入口蓝点现与卡片共用 `MissionRecord.hasUnread`，业务状态不再影响其显示。
终态工具组步骤数已恢复统计全部已结算逻辑操作；失败步骤保留失败状态，同时进入“已完成 N 个步骤”的 N。
当前 Camp 通知静默和右侧 AgentRun Portal 定位回归也已完成；普通 Camp、完整 Mission 会话与使命板抽屉使用
同一 quiet scope，失焦或离开该 Camp 后恢复提醒，静默不会写入 acknowledgement。
启动加载呈现增量已经收敛为日夜主题实心画布、48px 完整品牌标记、400ms anti-flash 与 180ms 退出；不改变
Supervisor、Core capability、恢复目标或 Renderer wire。
本版不轮换 data contract：继续使用 v1.61/schema 116；清理复用 schema 112 已有 workspace 状态、命令身份、
expected OID 与双检查点，不新增 Migration。

Mission Worktree checkout 增量同样不轮换 data contract：已有 `branch` 列继续是唯一受管分支记录，对外投影为
`managedBranch`；实时 `checkoutState` 和进程内 Diff view handle 均不持久化。

同日完成的 Agent Run Card 与用户消息撤回增量只调整 Renderer 编排、安装级位置偏好和既有 Domain Command
准入，不增加 Migration、Runtime 输入版本或 AgentRun 状态。

后续以真实会话复核时发现，首次实现虽然完成 Renderer waiting 卡，却在 Camp Open loader 中沿用了旧 A2A 的
Agent 作者过滤，导致用户 waiting `camp_message_delivery` 在到达前端前被遗漏；层数按钮也没有完整沿用交互稿的
三层图标与字形。校正后 Open 和 coverage 都投影当前用户 Delivery，执行台按同一队列准入，并由
[Run Process Detail Surface v38](../../contracts/run-process-detail-surface-v38.md)固定入口视觉与交互。

同一轮真实使命抽屉复核还发现，执行卡重构移除了抽屉原有的自动打开抑制，导致保存位置为底部时，已有或新建
running Run 会挤开会话并展开 Drawer。[Run Process Detail Surface v39](../../contracts/run-process-detail-surface-v39.md)
只恢复使命板抽屉的底部例外；普通 Camp、完整 Mission、其他位置和用户显式执行入口保持不变。

后续进入行为收敛为 [Run Process Detail Surface v40](../../contracts/run-process-detail-surface-v40.md)：普通 Camp
与完整 Mission 仍以最新 `running` Run 作为精确 focused Run 并保持原位置、展开和阅读定位，但默认过程 scope
改为总览。Camp／Mission route、显式队员入口、发送回执、Task 与通知精确导航均不改变。

同日完成的 Camp Open 职责增量将 `camps.open` 和 enter 的投影阶段收敛为实际零写入读取：旧取消协议修复前移到
mandatory startup recovery，终态文本写入失败由原 block 保存退避并接入既有 AgentRun maintenance tick。
它不新增 timer、worker、数据库表、连接或 Migration。后续性能收敛将 Open wire 升级为 schema 8：
保留最多 96 个 Run 摘要及各自的原始 Evidence 计数，移除无产品消费者的 Camp-wide Evidence
精确 coverage 及其全表扫描。字段级边界见
[Camp Open Projection v22](../../contracts/camp-open-projection-v22.md)。

Mission 续作增量把 Session Charter revision 从 10 轮换到 11，只增加一条继续使用已准备工作目录及当前
checkout 的默认指导。Bootstrap contract/Formatter、Context Formatter/Manifest/Profile、Schema 与 Runtime
compaction 行为均不变。

## Worktree 异步清理增量

`missions.workspace.cleanup` 在持久化 `cleanup_pending` 与命令结果后立即返回；独立 cleanup worker 使用通知快路和
固定维护兜底继续执行 verified Worktree removal 与 expected-OID branch deletion。实时 Mission 投影公开
cleaning/failed/cleaned 及两个 path-free checkpoint，failed 不自动重试。使命删除的 cleanup intent 与聚合删除
同事务，资源失败只保留 orphan cleanup 行，不恢复使命卡片。

Renderer 把资源状态固定在现有卡片层级中；确认窗不承担长期进度。失败同时进入可操作 Toast、卡片持久错误和
详情重试，部分失败只显示/重试本地分支；成功提示约四秒且刷新或重进不重播。删除后的失败沿用
“工作区待清理”入口。

清理短路径继续使用同一后台 owner 和持久字段：请求入口不再重复访问文件系统或 Git，普通成功 worker 将身份、
HEAD、受管 OID 与实际 checkout 合并为一次观测，并以非 force Worktree 删除、一次占用列表和一次条件删引用完成，
正常上限为 4 个 Git 进程。安全的脏现场拒绝恢复为可执行的 `ready` 并保留诊断与再次清理入口；部分或不确定结果
仍为 `cleanup_failed`。各阶段耗时写入结构化日志，不改变协议结果。

## Worktree checkout 与当前 Diff 增量

既有 Worktree 的执行校验只证明路径、仓库、Git 注册、owner marker、Host 与执行目录；当前分支、受管分支是否
仍存在、detached HEAD、checkout 读取和固定基准可读性不再成为 Runtime 门禁。Rovai 不自动切分支、接管分支或
重设基准。活动页一次返回实时 checkout 和相对固定基准的累计变化；文件详情使用新临时 index 重读当前状态，
旧请求迟到时由 view association 和 Renderer generation 丢弃，不新增监听、哈希或持久快照。清理仍只把受管分支
与 expected OID 作为分支删除身份；Worktree 目录由路径、注册和 owner marker 独立证明。干净的非受管具名 checkout
允许删除目录并保留其分支，脏现场和没有其他持久引用的 detached 提交继续保留。

## 使命板独立列滚动增量

Board mode 把每个 status lane 的 card region 变成独立、可聚焦、contained-overscroll 的纵向 scroll owner；页面标题、
筛选和列头不进入该滚动区。外层 board host 仅在窄桌面窗口或放大时横向滚动并保留最小列宽。Mission/cleanup 异步
更新、详情抽屉开合和其他列的状态变化复用稳定 lane DOM，不重置已有位置；列表往返恢复各列 offset，搜索/筛选
更新从新结果顶部开始。拖拽靠近目标列上下边缘时只自动滚动目标列；紧凑状态入口可直接横向定位。
卡片不显示省略号；右键菜单与 Shift+F10 状态入口共用同一操作菜单，继续提供非拖拽操作路径。行为参考稿不作为视觉
还原目标，现有组件层级、色彩和卡片样式保持权威。

## Agent Run Card 与消息撤回增量

执行台使用 `right | inspector | bottom` 三个安装级保存位置。右侧 Execution 是无文件能力的合成标签，和
Mission Activity、普通文件共用标签集合与分栏比例；切换标签或自动打开不会改变文件预览宽度。总览、当前执行、
聚合排队批次和默认折叠的执行历史复用同一详情 DOM，Run 卡片保留触发消息摘要、状态、耗时与常驻动作。
确认后的局部 UI 调整统一总览四格图标及执行心跳图标，标题加强层级并仅在本卡内吸顶，使命板创建入口为中性主操作“新使命”；
不改变消息/排队数据、停止协议、默认展开或使命创建流程。呈现细节由 [Camp 会话工作区](../../ui/components/conversation-workspace.md)
与[使命板 UI](../../ui/components/mission-board.md)拥有。
尚未 claim 的当前 waiting CampMessageDelivery 按接收队员投影为只读“排队消息”卡；用户和 Agent 作者使用同一
准入，不制造 AgentRun 或停止入口；claim 后由
真实 Run 接管。Run、queued Run 批次和 Delivery 队列的多输入层数使用独立按钮打开输入清单，不嵌入展开按钮，
并以冻结输入 ID 保持计数。层数按钮使用交互稿的三层堆叠图标、10.5px 常规字重计数与带图标的“定位原消息”。
总览头像固定 20×20px，状态节点对齐 40px 卡头，卡片操作保留 9px 右侧留白。

从其他页面、Camp 或应用恢复进入普通或完整 Mission 会话时，只以精确 `status=running` 的最新 Run 触发自动打开，
展开后定位最新已载入指令；用户停留底部时继续跟随，上滚后暂停。Mission 仍先建立 Activity；保存位置为右侧且
存在 running Run 时，Execution 取得当前显示，Activity 保留为可切换标签。后台刷新和后续状态变化不重复执行
进入规则，也不抢键盘焦点。使命板抽屉保存位置为底部时不自动选择或展开执行，显式入口仍可用。

当前用户消息的“待处理 / 处理中”聚合回执与复制按钮保持同一操作行，终态失败不增加“未完成”汇总；
具体接收队员按需展开。执行历史标题只显示历史总数，不增加失败待处理汇总。队员消息继续使用既有底色框。撤回入口只采用
`CampMessageView.canWithdraw` 和 `expectedVersion`，确认文案为“所有接收队员均未读，可直接撤回。”；取消只关闭
弹窗，确认复用既有 `camp.messages.withdraw` 原子语义。Desktop 与 Web Host 接受同一 operation，成功后原位置显示
撤回标记，不创建新的 AgentRun 取消原因。

## Mission 启动与执行提示增量

Mission read model 公开 Core-owned `startAvailable`，并把 `runningAgentIds` 的非终态集合补齐为
queued/running/waiting。只有 Mission start Delivery 的 waiting/claimed 或 Camp 内非终态 Run 会关闭启动入口；
普通等待消息不伪装为执行。`missions.start` 在同一事务复用该判定，因此旧投影或快速连点也不会追加启动任务。

Renderer 在点击后立即保留按钮几何、禁用并显示“正在开始…”；受理成功后先以本地确认态隐藏，再由权威投影接管，
明确拒绝才恢复并提示错误。Delivery batch claim 新增普通导航失效提示，使使命板、抽屉和完整会话在 Runtime
连接前就能刷新 queued Run。内部 Mission start 消息继续从 Timeline 过滤，业务状态不随启动或 Run 自动变化。

## 当前 Camp 通知静默与 AgentRun Portal 定位增量

前台且有焦点的当前 Camp workspace 成为 Renderer-local quiet scope：完成、失败、未完成、Mention 和审批 signal
在 Journal 归约时不进入临时队列，进入该 Camp 前已排队的同 Camp 卡片也撤下且离开后不重放。普通 Camp、完整
Mission 会话和使命板会话抽屉共用该规则；其他 Camp、其他一级页面和后台窗口继续按偏好排队。Core unread、
Occurrence acknowledgement、侧栏标记和精确可见来源确认均保持独立。

AgentRun 的可见扫描、Mutation/Resize 观察和通知定位改为围绕稳定 execution Portal；该 Portal 可在底部、Inspector
及位于会话根节点之外的右侧宿主间移动。右侧关闭时通知动作先打开 Execution 标签，再选择并聚焦 exact Run；
紧凑布局只为消息/旧 CampTurn 定位让出预览区，不再关闭 AgentRun 自己的目标页。

## Camp Open 只读职责增量

普通取消、成功和失败继续由现有 Domain Command Gateway 在业务提交后收尾正文，受控关闭与 planned-shutdown
直提交流程保留自己的提交后调用。旧两阶段取消中间态只在 Core ready 前按精确持久条件扫描并统一 settlement；
失败沿用 authority recovery 的 fail-closed 处理，重复启动零结算。

文本收尾失败保留原内存 block、失败次数和单调到期时间。现有 500ms maintenance tick 在无失败或未到期时不读
Run/Camp，到期只重试文本并在成功后复用 block event；失败最高退避至 30 秒。Camp open/read-only enter 的回归同时
用 SQLite authorizer 阻断 DML 并检查 `managed-blobs` 文件目录，证明跨 Camp 待收尾正文不会被读取入口冲刷。

## Camp Open Evidence coverage 性能收敛

`camps.open` 不再为首屏计算全 Camp 原始 Execution Evidence 精确总数。该字段没有 Renderer
消费者，却会从全局 Evidence 索引开始扫描，使目标 Camp 的打开成本随所有历史累积。
Open schema 8 删除 `coverage.executionEvidence`，不用 0 或局部求和伪装全量；
`coverage.agentRuns`、最多 96 个 Run 标题/状态及各自按 `agent_run_id` 索引计数的
`executionEvidenceCount` 均保留。可见 Run 的详情继续按需分页，既有
`reasoning_summary` 展示过滤不变。

## 启动加载品牌画布增量

Renderer 继续先挂载不可交互的目标框架并沿用同一个 400ms 截止时间；超时后用不透明的全视口纯色画布覆盖框架，
中央仅保留完整 Rovai horizon 标记及轻微明暗呼吸。可见层不再显示“正在打开会话”、进度圈、骨架或模糊的底层内容，
但 polite busy status 仍为辅助技术提供同一状态。`prefers-reduced-motion` 下标记静止，真实内容可用后以 180ms 淡出。

偏好读取或目标加载失败直接切换到独立恢复面，保留安全标题、重试与诊断动作，不把原始异常带入产品界面。该增量只调整
Renderer 呈现与焦点边界，不改变数据库、Supervisor snapshot、Core 请求门禁、Onboarding 或恢复位置提交语义。

## 跨版本文档影响

| 范围 | 结论 | 证据或理由 |
| --- | --- | --- |
| Version lifecycle | 已更新 | v1.61 冻结为 historical；本概览、[实施计划](implementation-plan.md)与[版本索引](../README.md)建立唯一 current v1.62 |
| Decisions | 已更新 | [版本决定](decisions.md)记录状态/消息解耦、异步 cleanup owner、独立列滚动、受管分支与实时 checkout 分离，以及移除无消费者的 Camp-wide Evidence 精确 coverage 取舍；Agent Run Card、运行中会话总览与当前 Camp quiet scope 均是可逆 Renderer 策略并由当前合同完整说明 |
| Contracts | 已更新 | 发布 [Mission v8](../../contracts/mission-v8.md)、v9、v10 后继续发布当前 [Mission v11](../../contracts/mission-v11.md)，并从 [Run Process Detail Surface v35](../../contracts/run-process-detail-surface-v35.md)继续发布 v36、v37、v38、v39 与当前 [v40](../../contracts/run-process-detail-surface-v40.md)，同时发布 [File Preview v17](../../contracts/file-preview-v17.md)、[Camp Message Send v23](../../contracts/camp-message-send-v23.md)、[Notification Episode v8](../../contracts/notification-episode-v8.md)、[Current User Attention v7](../../contracts/current-user-attention-v7.md)及当前 [Camp Open Projection v22](../../contracts/camp-open-projection-v22.md)；[ContextManifest v27](../../contracts/context-manifest-evidence-v27.md)记录 Session Charter revision 11，Built-in 继续使用 [v30](../../contracts/builtin-tool-transport-v30.md) |
| Architecture | 已更新 | Mission 明确状态、cleanup、启动可用性、claim 后执行投影、checkout 执行准入及固定基准 Diff 边界；File Preview、Public Message Delivery 与统一 Host 同步共享标签、撤回和 Host 准入；Camp Open、启动恢复与文本维护明确读取/恢复 owner，且 Camp Open 成本不再随其他 Camp 的 Evidence 增长；Renderer 启动边界增加不透明整窗品牌画布但不改变 capability gate；通知架构明确当前 Camp quiet scope、精确已读独立和 execution Portal 边界 |
| UI | 已更新 | [使命板 UI](../../ui/components/mission-board.md)增加独立列滚动、清理恢复、一致启动/执行反馈、Core-owned 未读入口蓝点及实时 checkout/Diff 刷新；[Camp 会话工作区](../../ui/components/conversation-workspace.md)和[文件预览区](../../ui/components/file-preview.md)同步三位置执行台、进入规则、运行中会话总览、回执和共享分栏，并补齐当前 Camp 静默与右侧 AgentRun 精确定位；[App Shell](../../ui/components/app-shell-navigation.md#冷启动反馈)将超时启动反馈收敛为整窗品牌画布与独立恢复面 |
| Runtime Activity | 确认无需更新 | 不改变 Canonical Runtime Activity 分类、证据来源或展示映射 |
| Runtime compatibility | 确认无需更新 | 不改变 Runtime Adapter 行为或平台资格；只轮换 Rovai-owned Built-in capability |
| Documentation routing | 已更新 | 文档任务入口、合同索引、当前决定导航和版本索引指向 v1.62 及本增量的当前权威 |
| Root README | 确认无需更新 | Mission 状态输入约束不改变项目定位、安装方式或公开支持范围 |
