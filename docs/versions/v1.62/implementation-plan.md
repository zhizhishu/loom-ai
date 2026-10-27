---
document_type: implementation-plan
version: v1.62
lifecycle: historical
authority: version-implementation-plan
status: completed
last_updated: 2026-09-20
---

# v1.62 实施与验收

范围见[版本概览](README.md)，字段级行为见 [Mission v11](../../contracts/mission-v11.md)、
[Run Process Detail Surface v40](../../contracts/run-process-detail-surface-v40.md)、
[File Preview v17](../../contracts/file-preview-v17.md)与
[Camp Message Send v23](../../contracts/camp-message-send-v23.md)，Camp 打开职责见
[Camp Open Projection v22](../../contracts/camp-open-projection-v22.md)，通知呈现见
[Notification Episode v8](../../contracts/notification-episode-v8.md)与
[Current User Attention v7](../../contracts/current-user-attention-v7.md)。

## Gate 0：当前基线与权威

- [x] 从最新 `main` 复核 Mission v5、Built-in v29、Core status 路径、catalog、CLI help 与错误恢复。
- [x] 确认本版不修改数据库、Bootstrap、Charter、ContextManifest、Run Facts 或 Renderer wire。
- [x] 发布 Mission v6/Built-in v30 后继续发布 Mission v7/v8/v9，补齐当前权威、版本决定并切换文档导航。

## Gate 1：Core 状态语义

- [x] 删除 Agent 对 `needs_you/completed` 的条件必填拒绝。
- [x] 四种状态均允许省略来源；省略会清除旧关联，显式有效来源继续保存。
- [x] 显式无效来源继续原子拒绝，不部分更新状态、关联或活动。
- [x] no-op、命令重放、活动记录、权限、Run/epoch fence 与执行独立性保持不变。

## Gate 2：Catalog、CLI 与错误恢复

- [x] catalog 将 `sourceMessageId` 描述为可选，空字符串与非法类型仍由闭合 schema 拒绝。
- [x] CLI help 提供不带来源的 `needs_you` 示例，并覆盖全部 26 个 exact help 入口。
- [x] 删除当前错误目录中的 `mission.source_message_required`。
- [x] 实际 invocation recovery 读取 operation 错误目录；`mission.invalid_source_message` 返回 `fix_input`。
- [x] Transport/CLI/capability 原子轮换到 v30，operation 数、IPC、Envelope、receipt 与 Output 不变。

## Gate 3：验证与合并

- [x] 定向 Mission、Transport 与 CLI Rust 回归通过。
- [x] Rust 全量、workspace check、fmt、Node/文档治理与 diff-aware 门禁通过。
- [x] 隔离的有效 AgentRun 通过 bundled CLI 无来源设置 `completed`。
- [x] 状态解耦增量 PR #443 的 required gate 通过并已合入 `main`。

## Gate 4：Worktree 异步清理

- [x] `missions.workspace.cleanup` 只在 Domain Command 事务中提交 pending intent；重复 pending 请求被拒绝。
- [x] 独立 cleanup worker 使用通知快路与固定恢复 pass，按 expected OID 和两个既有 checkpoint 执行；failed
  不进入自动恢复。
- [x] Renderer Mission 投影增加 cleaning/failed/cleaned 与实际步骤状态；Workspace 详情公开两个 checkpoint，
  私有命令身份和 expected OID 不外泄。
- [x] `camps.delete(workspaceDisposition=cleanup)` 在删除聚合的同一事务保存清理意图，返回后不等待 Git；
  orphan 成功删除记录，失败使用既有待清理入口。retain 不登记后台维护。
- [x] 卡片、Toast、详情与 orphan dialog 分别拥有即时进度、持久失败、查看、实际状态和未完成步骤重试；
  成功反馈为约四秒的本地 one-shot，刷新/重进不重播。

## Gate 5：使命板独立列滚动

- [x] Board host 仅保留横向 overflow；四个 status lane 的 card region 分别拥有纵向原生滚动、stable gutter 与
  contained overscroll，页面标题、筛选和列头固定。
- [x] status-keyed lane DOM 在 Mission refresh、cleanup feedback、详情抽屉与跨列状态更新中保持挂载；列表往返用
  Renderer 瞬时内存恢复 offset，搜索/筛选变化则把新结果恢复到顶部，不用 IPC 或持久偏好。
- [x] HTML5 drag 在目标列上下边缘使用 animation frame 自动滚动该列，在窄窗左右边缘滚动 board host；结束、
  drop、Escape 和离开区域均清理循环。
- [x] 每列为带名称的可聚焦 region，Left/Right 可切换列；卡片不显示省略号，右键/Shift+F10 共用菜单并提供 WCAG 非拖拽状态操作。
  窄桌面窗口保留 278px 列宽与横向 scroll-snap，并以带筛选后数量的紧凑状态入口直接切换可见列。
- [x] 保留现有视觉体系；行为参考稿不作为像素级还原或替换现有组件样式的依据。

## Gate 6：清理与滚动验证

- [x] 异步清理 Rust 定向/全量测试、Mission Electron 验收、TypeScript、文档治理、格式、diff 与编译检查通过。
- [x] `pnpm build:desktop` 生产构建通过；清理/滚动增量基于 PR #443 已合入的 `main` 变基并保持一条功能提交。

## Gate 7：Agent Run Card 与共享工作区

- [x] 执行位置扩展为 `right | inspector | bottom`，位置菜单保存同一个安装级偏好；提交失败保留原位置。
- [x] 右侧 Execution 作为无文件能力的合成标签接入 File Preview Session，与 Activity、普通文件复用标签集合和
  分栏比例；切换内容不改变文件预览宽度。
- [x] 总览、单队员当前区、聚合排队批次和折叠历史共用同一详情 DOM；卡片动作只作用于显示的 exact Run ID。
- [x] claim 前 waiting Delivery 以无停止动作的只读排队卡进入当前区；Run、queued 批次和 Delivery 队列的
  多输入层数是独立可点击入口，冻结 ID 在正文未载入时仍保持计数。
- [x] 总览头像固定 20×20px，状态节点与 40px 卡头居中，操作区保留 9px 右侧留白；底部位置和收起控件
  保持分离命中区。
- [x] 执行历史标题只显示历史总数，不增加“失败待处理”汇总；失败事实仍保留在对应 Run 卡片中。
- [x] 进入普通或 Mission 会话时只选择最新 running Run，展开后定位最新指令并按用户阅读意图跟随；后台刷新
  不重复进入规则或抢焦点。Mission 的 Activity 先建立，右侧 Execution 在符合条件时取得当前显示。

## Gate 8：消息回执、撤回与验收

- [x] 当前用户消息的“待处理 / 处理中”聚合回执与复制按钮保持同一操作行，终态失败不增加“未完成”汇总；
  按需队员明细和队员消息既有底色框保持不变。
- [x] 撤回只使用 `canWithdraw + expectedVersion`，取消关闭弹窗，确认通过 Desktop/Web 的同一
  `camp.messages.withdraw` operation 提交；成功后使用既有撤回标记。
- [x] Renderer、File Preview、偏好保存、时间线定位、Host operation 与 Core 撤回边界的定向测试通过。
- [x] 隔离 Electron 验收覆盖三位置往返、共享宽度、最新 running Run 自动打开、指令跟随、waiting Delivery、
  独立多输入弹层、卡片几何、排队合批、停止、撤回取消/确认、恢复和长 Tool 输出；类型、文档、生产构建与
  macOS App 验证通过。

## Gate 9：Mission 启动与执行提示

- [x] `MissionRecord.startAvailable` 由等待/已领取的 Mission start Delivery 与 Camp 非终态 Run 共同决定；
  普通等待 Delivery 不进入该判定。
- [x] `runningAgentIds` 覆盖 queued/running/waiting，Delivery claim 后发布导航失效，连接前即可刷新执行提示。
- [x] `missions.start` 与 Renderer 共用同一 Core 判定；旧投影、快速连点或普通消息活跃 Run 不会追加启动任务。
- [x] 开始按钮立即 disabled、`aria-busy` 并显示“正在开始…”；受理后隐藏，明确拒绝恢复且显示错误；内部
  Mission start 消息继续不进入 Timeline。
- [x] Mission Rust owner、Electron 使命验收、TypeScript、文档治理、格式、workspace check、Rust 全量、Node
  全量与 Desktop 生产构建通过。
- [x] 分支提交并推送；PR #453 required gate 通过后合入 `main`，并验证功能提交是 `origin/main` 祖先。

## Gate 10：Mission Worktree checkout 与当前 Diff

- [x] 既有 Worktree 的执行校验与 checkout/Diff 观测拆开；准备链不再预查受管分支 OID 或固定基准。
- [x] 当前分支不同、受管分支缺失、detached HEAD、checkout 观测失败与 Diff 基准不可用不单独阻断 Runtime；
  路径、仓库、注册、owner marker、Host、权限和执行占用仍是硬门禁。
- [x] workspace 投影把已有 `branch` 映射为 `managedBranch`，活动页使用不持久化的 `checkoutState`；无 Migration。
- [x] checkout 与文件列表由一次 changes view 返回；文件详情重建私有临时 index 并验证 view association，旧请求
  迟到不会覆盖新视图或移除新句柄，Renderer 刷新时清除文件详情并丢弃旧响应。
- [x] 清理分离 Worktree 目录归属与受管分支 expected OID；干净的非受管具名 checkout 删除目录但保留分支，
  detached 提交必须有本次保留的持久引用，脏现场不自动切换、stash、commit、reset 或 clean。
- [x] 既有 Rust owner 覆盖分支切换、受管分支删除、detached、观测降级、固定基准失败、同 HEAD 的 staged/
  unstaged/untracked 刷新和 cleanup fence；真实 Runtime smoke 经过调度准备链验证重启续跑。

## Gate 11：Camp Open 只读职责

- [x] 普通取消/成功/失败保留 Gateway 提交后文本收尾；受控关闭与 planned-shutdown 的直提交流程保留原有
  post-commit 收尾，不在 Adapter 增加平行实现。
- [x] 旧取消中间态在数据库 open/migration 后、其他 execution recovery 前按精确持久条件统一结算；多个 Camp
  一次恢复，重复执行零写入，恢复失败继续阻断 ready。
- [x] 文本收尾失败在原 block buffer 记录 500ms–30s 有界退避；既有 AgentRun maintenance tick 到期只重试文本，
  无失败/未到期不查持久状态，成功复用 block event。
- [x] `camps.open` 与 read-only enter 投影阶段不再调用取消 settlement 或 `flush_settled`；SQL authorizer 与
  Managed Blob 目录断言覆盖目标 Camp 旧取消和其他 Camp 大文本的组合副作用。
- [x] Open schema 7、Snapshot 34、Data Contract 99、Renderer wire、数据库锁/连接和 Migration 均不变。

## Gate 12：Mission 续作提示

- [x] 开发者二次确认[模型上下文变更 revision 3](model-context-change-mission-continuation.md)；revision 1 的逐 Run
  WORKSPACE 注入与 revision 2 的压缩后补发均撤销。
- [x] Mission 专属 Session Charter 在 `mission get` 说明后只增加已确认的续作句，并把 Charter revision 从
  10 轮换到 11；普通 Camp、Single Chat、WORKSPACE、Runtime compaction 与数据库均不变。
- [x] 两个既有 Rust owner、格式、文档治理与 diff 检查通过；PR 继续由 required checks 约束合入。

## Gate 13：Worktree 清理安全修复

- [x] 正式 Worktree 删除改用非 force 路径；切到其他具名分支且现场干净时删除目录并保留当前分支，受管分支
  缺失视为步骤完成，残留注册只按精确路径与 owner marker 清理。
- [x] staged、unstaged、untracked 与无保留引用的 detached 提交在删除前拒绝；清理不自动修改用户现场。
- [x] 预检拒绝不进入 `cleanup_failed`；worker 或旧失败只有在完整目录、注册、owner marker 与执行目录均实际
  存在时恢复 `ready`，部分删除与未知结果继续复用原 expected OID 和检查点。
- [x] 活动页在 Workspace 尚未创建时不挂载“累计文件变更”区域；ready 工作区及拒绝后的改动读取保持不变。
- [x] 完成定向 Rust/Renderer、默认 feature PR 门禁及 Mission Board 隔离自动验收；本地 App 安装与追加真实
  Mission smoke 按本次交付指令不执行。

## Gate 14：终态步骤计数恢复

- [x] 工具组真实收口后以去重后的全部已结算逻辑操作作为“已完成 N 个步骤”的 N；失败、停止、跳过和结果未知均计入。
- [x] 单条 Tool 的实际终态、状态图形、详情、活动尾组、等待审批、分页范围与 Runtime Compaction 排除保持不变。
- [x] 既有 Renderer 分组 owner 覆盖单个失败、混合结果及 skipped/recorded；只运行定向 Vitest、文档治理、类型检查和静态 UI detector。

## Gate 15：Run Card 真实队列校正

- [x] Camp Open 当前 Delivery loader 与 coverage count 不再按消息作者过滤；用户 waiting
  `camp_message_delivery` 与 Agent 作者行使用同一有界集合。
- [x] 既有 projection 单元 owner 同时覆盖完整 Snapshot 与有界 Open 的用户 waiting 行；既有 Camp Open
  SQLite owner加入两条用户 waiting Delivery，证明只读投影、完整集合和 coverage 一致。
- [x] 合批入口使用交互稿三层路径、13px 图标、1.5px 描边、10.5px 常规字重计数，并在输入清单恢复定位图标；
  排队卡与真实多输入 Run 共用同一按钮和焦点边界。
- [x] Renderer 定向回归、Camp Open slow owner、隔离 Electron 双状态截图、类型检查、文档门禁和 Desktop
  生产构建通过；Rust 验证收敛为上述两条定向 owner。

## Gate 16：使命抽屉底部执行台保持收起

- [x] 仅在使命板抽屉与 `bottom` placement 同时成立时启用既有执行自动打开抑制；普通 Camp、完整 Mission、
  `right` / `inspector` 与显式执行入口保持原行为。
- [x] Renderer 定向 owner 同时证明普通底部执行台继续自动选择 running Run，使命抽屉的底部入口保持未选中且
  Drawer 不挂载；不增加 Rust、Core、数据库或 wire 变更。
- [x] TypeScript、当前 Renderer owner、文档治理、diff 检查与静态 UI detector 通过；不运行 Rust 或全量测试。

## Gate 16：Mission Worktree 清理短路径

- [x] 清理请求入口只保留权限、状态、占用和幂等准入；文件系统与 Git 安全判断由 worker 单一拥有。
- [x] 正常成功路径合并身份、HEAD、受管分支 OID 和实际 checkout 观测，不执行 `git status`，并将 Git 进程调用限制为 4 次。
- [x] expected OID 在删除前持久化，Worktree 检查点先于分支步骤；部分结果与不确定失败继续失败关闭并只重试未完成步骤。
- [x] staged、unstaged、untracked 脏现场经非 force 删除安全拒绝，恢复 `ready`、保留内容与诊断，Activity 提供明确重试。
- [x] 增加排队、安全、删除、分支与结果发布耗时日志；既有 Rust owner 验证调用上限和实际入口，Renderer owner 验证拒绝反馈。

## Gate 17：运行中会话默认进入总览

- [x] 普通 Camp 与完整 Mission 进入时选择总览，同时保留 `createdAt + id` 最新 running Run 的精确聚焦、展开、
  最新指令定位和 live follow；无 running Run 与使命抽屉底部例外保持不变。
- [x] 显式队员入口、消息发送回执、Task、通知与其他精确导航保持原 Agent／Run scope；不改变 route、位置偏好、
  Renderer wire、Core、数据库或 Runtime。
- [x] 既有 Renderer owner、隔离执行台验收、TypeScript、文档治理、diff 检查与静态 UI detector 通过；不扩大为 Rust 测试。

## Gate 18：当前 Camp 静默与 AgentRun Portal 定位

- [x] 窗口可见且有焦点、普通或 Mission Camp workspace 为当前 surface 时，同 Camp 全部 heads-up 语义不入队；
  已排队卡片也移除且不在离开后重放。
- [x] 静默不调用 acknowledge、clear 或 mark-all；消息、CampTurn、AgentRun 与审批仍只由精确可见来源确认。
- [x] AgentRun 可见扫描、变化/尺寸观察与通知定位统一使用 execution Portal；右侧关闭时显式打开 Execution 标签。
- [x] 紧凑布局保留 AgentRun 的右侧目标页；隔离 Electron 同时证明“右侧已开时回报 exact Run”和“右侧已关时
  点击可打开、聚焦并完成定位”。
- [x] 修正 notification fixture 的 schema 8 与 `agentRunIds` 输入，TypeScript、Renderer 单测、隔离 Electron、
  文档治理和静态 UI detector 作为本增量门禁；不修改 Core、Migration 或 Rust 测试。

## Gate 19：Camp Open Evidence coverage 性能收敛

- [x] Open schema 升级为 8，移除 `coverage.executionEvidence`、对应 Rust/TypeScript 字段与
  Camp-wide Evidence 精确计数 SQL；不用 0 或最多 96 个 Run 的局部求和伪装全量。
- [x] 最多 96 个 Run 的标题、状态与各自 indexed raw `executionEvidenceCount` 保留；
  可见 Run 仍按需读取执行窗口，现有 `reasoning_summary` SQL 过滤不变。
- [x] 既有 Camp Open SQL 规模 owner 扩展无关 Camp Evidence 从 1,000 到 100,000 行的阶梯，
  断言目标投影不变且 SQL VM 工作量不随规模增长；既有 Evidence 分页 owner 证明单 Run 原始计数仍为 85。
- [x] 同步合同、架构、当前决定导航、Renderer schema fence 与 fixture；不增加 Migration、持久字段或新的 Rust test owner。

## Gate 20：启动加载品牌画布

- [x] 保留唯一 400ms anti-flash 截止时间与已挂载的非权威目标框架，超时后以实心整窗画布阻断视觉与交互。
- [x] 正常加载只显示 48px 完整 Rovai horizon 标记；移除可见文案、Spinner、进度、骨架和底层模糊预览，保留 polite
  busy status。
- [x] 增加 1600ms 轻呼吸、180ms ready 退出与 `prefers-reduced-motion` 静止呈现；日夜主题均使用既有语义 token。
- [x] 将本机偏好／目标读取失败收敛为独立恢复面，保留安全文案、重试、诊断、焦点进入与键盘约束。
- [x] 扩展现有 Renderer 单测和隔离 Electron startup fixture，覆盖 anti-flash、完整视口、品牌几何、主题、动效、退出与恢复；
  不增加 Rust test owner、数据库字段、Core wire 或 Migration。

## Rust 测试准入记录

不新增独立 Rust test owner。既有 Mission command owner 扩展四状态无来源、有效/无效来源、清除、no-op、
Replay、活动、执行副作用与 epoch/membership 边界；既有 Transport 与 CLI owner 扩展 v30、错误恢复和实际
help。删除测试为零。

当前 Camp 静默与 AgentRun Portal 定位不新增 Rust test owner：它不改变 Notification schema、Core unread、
acknowledgement 或 AgentRun 投影，只调整 Renderer queue policy 与已存在 DOM 的观察/定位边界。纯函数 owner 覆盖
全语义静默且 unread 不变，隔离 Electron 生产组件 fixture 覆盖右侧 Portal 可见、关闭后恢复与紧凑布局定位。

异步清理不新增平行 Rust 测试函数：`mission_cleanup_capability_comes_from_workspace_records_and_execution_occupancy`
继续拥有 Renderer cleanup projection 输入矩阵；`camp_rename_lead_change_and_quiescent_delete_with_cleanup_are_versioned`
继续拥有 Camp 删除事务/replay，并增加 cleanup intent 与聚合删除原子性的断言。较低层纯函数不能证明 gateway
transaction 与 Camp aggregate 删除。独立列滚动不改变 Core 行为，由隔离 Electron 密集卡片验收拥有。

Agent Run Card 增量不新增 Rust 测试 owner。撤回继续由既有多接收者 waiting Delivery 原子撤回、首个 claim 后拒绝
和幂等命令用例拥有；Desktop/Web 只补齐同一 operation 的 Host 准入。新的偏好保存回归由共享 TypeScript owner
覆盖，避免 unrelated Host read 阻塞已提交的保存结果。

Mission 启动增量不新增独立 Rust 测试函数：既有
`mission_commands_keep_definition_atomic_patch_only_and_start_status_independent` 继续拥有 start admission、Replay、
业务状态独立与活动副作用，并扩展 waiting start、普通消息 claim、queued 投影及重复启动输入。修复前普通消息
claim 后仍可能重复创建 Mission start，queued Run 也不会进入执行提示；同一数据库/命令 owner 已覆盖完整事务，
平行 fixture 只会重复 setup。最小验证命令为
`cargo test -p rovai-core --lib mission_commands_keep_definition_atomic_patch_only_and_start_status_independent`。删除测试为零。

Worktree checkout 增量不新增平行 Rust test owner。既有 `persistent_worktree_preserves_source_recovers_owned_creation_and_retains_branch_on_delete`
扩展执行准入、detached、受管分支缺失、checkout 降级与非受管分支 cleanup fence；既有
`fixed_base_diff_is_final_net_content_without_mutating_real_index` 扩展同 HEAD 刷新、固定基准失败和多 view handle。
`scripts/smoke-mission.mjs` 继续拥有真实调度/Runtime 证明，Electron Mission fixture 继续拥有迟到响应与活动页刷新。

清理安全修复继续扩展同一个 `persistent_worktree_preserves_source_recovers_owned_creation_and_retains_branch_on_delete`
owner：修复前非受管 checkout 固定失败且正式删除使用 force；现在同一真实 Git fixture 同时证明脏文件保留、具名
分支提交保留、受管分支缺失、detached 引用准入与变更后的 stale registration。跨 Core 命令、持久状态和后续
preparing 的 seam 仍由 `scripts/smoke-mission.mjs` 拥有，扩展 dirty rejection、旧 `cleanup_failed` 恢复、成功清理
及下一 Run 重建；较低层测试不能证明 Gateway/worker/preparation 串联。Renderer 继续扩展现有
`MissionDelivery.test.ts` owner，修复前 `workspace=null` 仍挂载变化区。删除测试为零。最小自动命令分别为
`cargo test -p rovai-core --lib persistent_worktree_preserves_source_recovers_owned_creation_and_retains_branch_on_delete`
与 `pnpm exec vitest run apps/desktop/src/renderer/src/MissionDelivery.test.ts`。

Camp Open 增量改写既有 `open_repairs_only_cancellation_marked_work_in_the_requested_camp` owner：旧 service 修复
合同退出，successor `open_and_read_only_enter_never_settle_work_or_write_managed_blobs` 拥有读取入口的 SQL 与文件
副作用边界；修复前目标取消或其他 Camp 待收尾文本会触发写入。它必须使用完整数据库，因为纯查询测试不能观察
Gateway/Blob 副作用。既有 Execution text 跨模块 owner 扩展 post-commit 故障、未到期零扫描、maintenance retry、
大正文 Blob 与命令 replay，不新增平行测试。新增 startup recovery owner 拥有跨 Camp 精确发现及重复执行幂等；
只有启动层测试能证明 service 不再是 repair owner。

Run Card 真实队列校正不新增 Rust test owner。既有
`read_model::tests::public_delivery_projection_preserves_causal_source_not_target_lineage` 增加当前用户 waiting 行，
并在 `None`/有界 limit 两条路径断言可选 `sourceAgentRunId` 与空目标 Run；修复前同一输入稳定少一行。既有
`camp_open_preserves_business_state_without_reading_event_history` 在完整 SQLite fixture 中增加两条用户 waiting
Delivery，证明 Open loader、coverage、完整 Snapshot 与 event-log 禁读 seam 同时成立。纯 Renderer fixture 无法证明
Core SQL → DTO 边界，另建平行数据库 owner只会重复 setup。最小命令为
`cargo test -p rovai-core public_delivery_projection_preserves_causal_source_not_target_lineage` 与
`cargo test -p rovai-core --features slow-tests camp_open_preserves_business_state_without_reading_event_history -- --nocapture`。

Camp Open Evidence coverage 收敛不新增 Rust test owner。既有
`execution_evidence_is_counted_in_snapshot_and_paged_by_agent_run` 用例继续拥有原始 Evidence 分页与
Run-local 计数，并改为断言 Open 不公开 Camp-wide coverage；既有
`camp_open_work_is_independent_of_unrelated_event_volume` 规模 owner 扩展为同时覆盖无关 Event 与
Evidence 历史。这两个边界分别需要完整 Read Model 和 SQLite progress handler；纯 SQL 单元测试
不能证明序列化 wire 或整条 Open 路径的工作量。删除测试为零。

启动加载品牌画布不新增 Rust test owner：它只改变 Renderer 呈现、焦点与退出过渡，不改变 Supervisor、Core wire、
数据库或启动恢复。既有 `App.test.ts` 拥有组件状态与安全文案断言，隔离 Electron startup fixture 拥有真实生产组件、
计时、完整视口、日夜主题、缩放、reduced motion、退出和恢复边界。删除测试为零。

Mission 续作提示不新增 Rust test owner：既有 `session_charter_publishes_one_cli_only_builtin_contract` 继续拥有
Mission／普通 Camp 的逐字 Charter 边界，既有 `binding_contract_freezes_each_context_axis_version` 继续拥有
Session Charter revision 与 Binding compatibility digest。只扩展这两个 owner 的期望值和唯一性断言。

## 实施收口

- 启动加载品牌画布增量：`App.test.ts` 174/174、`pnpm test:startup-presentation` 1/1、`pnpm typecheck`、
  `pnpm build:desktop`、`pnpm docs:test`、普通与固定 base 的 diff-aware 文档门禁及 `git diff --check` 通过；
  隔离 Electron 截图复核日间纯白、夜间实心深色、200% reduced motion 和独立错误恢复面。
- Camp Open Evidence coverage 收敛：单 Run 的 85 条原始 Evidence 计数 owner、Camp Open 纯读投影
  owner 与规模 owner 各 1/1 passed；50,000→5,000,000 条无关 Event 及 1,000→100,000 条无关
  Evidence 下目标 Open 保持在 2450–2451 SQLite VM steps。`App.test.ts` 174/174、`pnpm typecheck`、
  `cargo check -p rovai-core --all-targets`、`cargo fmt --all -- --check`、`pnpm docs:test`、普通与固定 base
  的 diff-aware 文档门禁、`pnpm build:desktop` 与 `git diff --check` 通过。
- 运行中会话总览增量：`App.test.ts` 174/174、`pnpm test:execution-avatar-rail` 2/2、`pnpm typecheck`、
  `pnpm docs:test`、`pnpm docs:check`、固定 base 的 `pnpm docs:check:ci`、`pnpm build:desktop` 与
  `git diff --check` 通过；Impeccable 静态 detector 对 `CampWorkspace.tsx` 返回零发现。
- `cargo test -p rovai-core --lib mission_commands_keep_definition_atomic_patch_only_and_start_status_independent`：1 passed。
- `cargo test -p rovai-core --lib builtin_tool_transport::tests::`：8 passed。
- `cargo test -p rovai-core --bin rovai mission_status_help_and_direct_flags_keep_source_message_optional`：1 passed。
- `cargo test -p rovai-core --bin rovai exact_help_surface_covers_the_current_catalog_and_no_family_aliases`：1 passed。
- `cargo test -p rovai-core --bin rovai -- --test-threads=4`：29 passed；`cargo check --workspace --all-targets`、
  `cargo fmt --all -- --check`、`pnpm typecheck` 与 `git diff --check` 通过。
- 清理增量基线 `cargo test -p rovai-core --lib -- --test-threads=4`：845 passed、0 failed、6 ignored；
  cleanup projection、部分失败重试与 Camp 删除原子性定向用例通过。
- `pnpm test:mission-board`：4 passed、0 failed；覆盖异步清理、独立列滚动、820px 桌面窄窗横向切换、
  大 Diff 虚拟化、宽屏抽屉与编辑器指针交互；`pnpm build:desktop` 通过。
- Mission 启动增量在最新 `origin/main` 上定向 owner 1 passed；默认 feature workspace 为 Core 844 passed、
  6 ignored，CLI 29 passed、Host 4 passed、Web 8 passed，0 failed。
- `pnpm test:mission-board` 为 4 passed、0 failed；新增覆盖 pending/拒绝/受理、claim 前入口隐藏、queued
  执行提示、状态独立和内部启动消息不可见。`pnpm typecheck`、diff-aware 文档治理、格式、workspace check、
  `git diff --check` 与 `pnpm build:desktop` 均通过。
- 完整 `pnpm test` 为 Vitest 2162/2162、Node 324 passed/2 skipped、0 failed；同时把主线已经轮换的 schema 116、
  ContextManifest/Formatter 27 与 Delivery Profile 8 同步到 Product Contract Fingerprint owner。
- PR #453 required gate 通过并合入 `main`；功能提交的最终 SHA 已由 `git merge-base --is-ancestor` 对
  `origin/main` 验证。
- `node scripts/smoke-mission.mjs ...` 在 rebase 后隔离 data-dir/Skill Library 通过 6 个场景，4 条真实
  AgentRun 全部 succeeded；bundled CLI 以 `{status:'completed'}` 更新并读回 `sourceMessageId: null`，
  Core 重启后的续轮保持该状态。
- Camp Open 增量定向验证：slow Camp Open 3/3、读取复杂度 2/2、startup cancellation recovery 1/1、
  post-commit Execution text retry 1/1；500 万 unrelated events 仍为 2143 VM steps。默认 Rust lib 全量
  845 passed、0 failed、6 ignored；最终 retry-owner 收紧后同一故障/replay owner 再次 1/1 通过。
- `cargo check -p rovai-core --all-targets`、`cargo fmt --all -- --check`、`git diff --check`、
  `pnpm docs:check` 与带固定 base 的 `pnpm docs:check:ci` 通过。隔离 Electron 的正文、执行窗口、终态
  artifacts 与当前用户 profile 场景通过；其余五个 Renderer fixture 断言在本分支和干净
  `da55f981` 基线以相同位置失败，未纳入本后端增量的通过声明。
- Mission 续作提示定向验证：`session_charter_publishes_one_cli_only_builtin_contract` 在 `slow-tests`
  feature 下 1/1 passed，`binding_contract_freezes_each_context_axis_version` 1/1 passed；格式、文档单测、
  普通与 diff-aware 文档门禁、`git diff --check` 均通过，未扩大为 Runtime smoke 或 App 构建。
- 当前 Camp 静默与 AgentRun Portal 定位增量验证：Attention Controller 定向单测 16/16、关联 Renderer
  单测 193/193，`pnpm test:notification-attention` 的通知队列与右侧 Portal 两个隔离 Electron 场景 2/2，
  `pnpm test:execution-avatar-rail` 的执行台完整交互与状态迁移 2/2 通过；`pnpm typecheck`、
  `pnpm build:desktop`、`pnpm docs:test`、普通与 diff-aware 文档门禁、`git diff --check` 均通过，
  Impeccable 静态 detector 对四个变更 Renderer/fixture 文件返回零问题。
