---
document_type: version-decisions
version: v1.62
lifecycle: historical
authority: decision-rationale
last_updated: 2026-09-20
---

# v1.62 版本决定

<a id="v1-62-d01"></a>
## V1.62-D01：Mission 状态操作不以消息发布为前置条件

- 状态：accepted
- 日期：2026-09-19
- 当前权威：Mission v10 与 Mission Architecture

Mission 状态是独立业务事实，公开消息是可选解释材料。要求 Agent 在设置 `needs_you` 或 `completed`
前先发布消息，会把两项可分别授权、失败和重放的操作强制串联，并让“状态是否可更新”取决于一条消息是否已
创建。选择让所有状态都可省略 `sourceMessageId`，同时保留显式关联的同 Camp、公开、未删除校验。

省略来源沿用现有单次写入语义并清除旧关联，不引入“未提供 / 保留 / 清空”三态 patch，也不自动选择最近消息。
状态活动本身继续记录操作者与变化，因此无来源不等于无审计。沟通是否必要仍由当前协作任务决定，但不再成为
Core 接受状态命令的条件。

拒绝保留 `needs_you/completed` 条件必填，因为它维持不必要的跨操作耦合；拒绝自动发布或绑定最近消息，因为
这会伪造用户可见内容或产生时序歧义；也拒绝新增 `--force`、`--skip-message` 或三态清空参数，因为现有可选字段
与整行写入已经能无歧义表达目标状态。

<a id="v1-62-d02"></a>
## V1.62-D02：Worktree 清理先提交持久意图，Git 步骤由独立后台 owner 执行

- 状态：accepted
- 日期：2026-09-20
- 当前权威：Mission v10 与 Mission 架构

前台命令同时执行 Git 删除会把确认窗、Camp 删除和一个可能持续或失败的外部进程绑在一起；Renderer 无法在
命令返回前可靠区分“意图已保存”和“资源已删除”，删除使命也会被后续资源失败反向阻断。选择复用既有
`cleanup_pending/cleanup_failed`、命令身份、expected OID 与双检查点：Domain Command 只在事务中提交意图，随后
以无负载通知唤醒单一后台 cleanup owner，固定维护 pass 仅恢复未完成 pending，failed 必须显式重试。

后台 Git 工作使用独立串行 fence，不占住其他使命的准备和普通操作；同一 workspace 则由持久状态阻止重复准备
或重复清理。删除且清理时，清理意图与 Camp/Mission 删除处于同一数据库事务，卡片可立即消失；后续失败作为
orphan workspace 保留到显式重试成功。默认 retain 仍不加入维护路线，清理正在执行时拒绝 retain 删除，以免把
“保留实际资源”承诺与已经开始的破坏性步骤并置。

拒绝只在 Renderer 保存 loading 状态，因为重启后会失去 owner；拒绝把每个 Git 步骤建成 Task 或新增百分比状态，
因为现有两个 durable checkpoint 已足以恢复且 Git 不提供诚实进度；也拒绝自动重试 failed，因为 branch OID 变化、
占用或 Host 不一致需要用户看到实际状态并作出显式恢复选择。本决定不增加 schema，只增加 path-free cleanup
投影与现有 orphan route 的当前职责。

<a id="v1-62-d03"></a>
## V1.62-D03：使命板由状态列拥有纵向滚动，外层只拥有窄窗横向移动

- 状态：accepted
- 日期：2026-09-20
- 当前权威：使命板 UI

整板纵向滚动会让短列跟随长列离开视口，用户无法同时看到各状态名称、数量与不同位置的卡片；详情开合或异步
结果导致的重绘也容易把工作位置带回顶部。选择把纵向 scroll owner 下沉到每个稳定 status-keyed lane card region，
标题、筛选栏和列头留在滚动区外；外层 board host 只在列宽放不下时承担受约束的横向移动。每列使用原生滚动与
contained overscroll，不劫持 wheel；普通 Mission/cleanup 投影更新复用列 DOM，因此不会重建其他列或重置其位置。
临时切到列表时 Renderer 保存并恢复各列 offset；搜索或筛选改变的是结果集合，因此明确从各列顶部开始。窄窗保留
最小列宽，并以紧凑状态入口直接移动横向 viewport，不把四列压扁或串成长页面。

跨列拖动继续提交同一权威 status command。拖拽指针进入目标列上下边缘时，以 animation frame 只推进目标列，
接近外层左右边缘时才推进横向 host；drag end、drop、Escape 或离开看板都会停止循环。卡片不显示省略号；
右键菜单和 Shift+F10 继续作为 WCAG 所需的非拖拽替代，聚焦列可以用 Left/Right 切换可见列。拒绝一份全板 `scrollTop`，
也拒绝用 wheel 事件手工转发四列，因为两者都会破坏原生滚动、键盘行为与位置所有权。本决定不新增持久偏好、
IPC 或 schema，也不把行为参考稿提升为新的视觉权威。

<a id="v1-62-d04"></a>
## V1.62-D04：Mission 受管分支身份与实时 checkout 分离

- 状态：accepted
- 日期：2026-09-20
- 当前权威：Mission v10 与 Mission 架构

Mission 绑定的是一个由 Rovai 验证所有权并持续复用的 Worktree；分支只是该目录当前的 Git checkout。把创建时的
分支同时用作执行门禁、活动页标签和清理目标，会让用户或外部工具的普通切分支阻断 Runtime，并使一个可变观测
错误地改变资源归属。选择保留数据库现有 `branch` 作为唯一受管资源身份，对外命名为 `managedBranch`；实时
checkout 只按需观测为 branch、detached 或 unavailable，不持久化、不写回，也不自动切换或接管。

执行准入只验证目录、仓库、注册、owner marker、Host、权限与并发边界。分支不匹配、受管分支缺失、detached
HEAD、checkout 观测失败和 Diff 基准不可用不再单独阻断有效 Worktree 的 Run。活动页把 checkout 与文件列表放在
同一次视图读取中，文件详情重新建立私有临时 index 并在旧关联不适用时要求刷新；进程内句柄只关联请求，不宣称
文件系统原子快照。选择少缓存，而不是引入内容哈希、监听服务、持久快照或工作区状态机。

清理把 Worktree 目录和受管分支作为两个独立资源：目录归属只来自规范路径、Git 注册和 owner marker，受管分支
只按记录的 expected OID 条件删除。具名非受管 checkout 不再阻断已验证且干净的目录删除，其分支和提交保留；受管
分支缺失视为对应步骤已经完成，不追踪或接管改名后的分支。detached HEAD 只有在提交可从本次不会删除的持久引用
到达时才允许删除目录。脏现场始终保留，正式 Worktree 删除不使用 `--force`，且未发生任何删除的失败可经实际资源
审计恢复为 `ready`。拒绝直接覆盖原分支字段或删除当前 checkout，因为这会让展示观测改变资源归属；也拒绝自动
stash、commit、切分支、建立保留分支、更新固定基准或只显示 `git diff HEAD`，因为这些都会改变用户成果或 Mission
固定基准累计净变化语义。

<a id="v1-62-d05"></a>
## V1.62-D05：Camp Open 不精确统计无消费者的全 Camp 原始 Evidence 总数

- 状态：accepted
- 日期：2026-09-20
- 当前权威：Camp Open Projection v22 与 Camp Open Read Path

Camp Open 的产品任务是交付有界首屏：最近消息、当前业务状态、最多 96 个 Run 的标题与状态，
以及已返回 Run 的局部变化信号。`coverage.executionEvidence.totalCount` 统计的却是所有
Run 的全部原始持久行；Renderer 没有消费它，它也不能表达用户可见的逻辑步骤。当 Evidence
是 append-only 时，从 Evidence 全表出发再过滤 Camp 使打开成本随所有无关历史线性增长。

选择在 Open schema 8 中移除该 coverage 字段和它的精确查询，同时保留 `coverage.agentRuns`、
有界 Run 集合和各 Run 通过 `agent_run_id` 索引计算的原始 `executionEvidenceCount`。真正的执行
内容继续只对可见 Run 按需读取，`reasoning_summary` 继续在执行窗口的准入 SQL 中过滤，不借
此偷偷重定义原始计数。

拒绝保留全 Camp 精确计数后只改为 Camp→Run→Evidence 定向查询，因为它仍为无消费者做随当前 Camp
历史增长的工作；拒绝把 96 个 Run 求和或 0 写入旧字段，因为这会伪装全量语义；也拒绝在 Evidence
冗余 `camp_id`，因为现有 Run 归属已是权威，冗余会引入一致性、迁移和删除负担。
