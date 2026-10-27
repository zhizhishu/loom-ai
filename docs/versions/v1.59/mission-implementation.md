---
document_type: implementation-plan
version: v1.59
status: completed
last_updated: 2026-09-19
---

# 桌面使命实施

开发者已确认[模型输入 revision 3](model-context-change-mission.md)。原始使命方案与后续反馈共同决定
产品范围：使命与 Task／执行状态分离；一个主 Camp；用户开始或消息触发执行；持久 Git 工作区和固定基准 Diff；
非 Git 使用原目录，无分支与 Diff；只向桌面开放。

开始使命只派发执行并记录开始活动，不再把业务状态推到 `in_progress`；最新 Turn 是否提及 Principal
也不再触发或指导 `needs_you` 更新。Mission 状态只通过用户或 Agent 的显式状态命令改变。

## 交付步骤

| 步骤 | 状态 | 完成条件 |
| --- | --- | --- |
| 领域与持久化 | 已实现并验收 | 原子 Mission + Camp、当前成员权限、后提交字段覆盖、历史、标签／PR |
| 工作区与 Git | 已实现并验收 | preparing 才创建、稳定关联、实际 Git 净 Diff、冲突／恢复／清理 |
| 输入与 CLI | 已实现并完成定向验收 | 已确认 shape、版本轴与证据，三个 Mission 操作；通用评测状态另列 |
| 桌面 | 已实现并验收 | 真正导航、列表／看板、抽屉、会话板、交付／活动、普通会话状态复用 |
| 验证与安装 | 已安装；通用评测提前结束 | 常规门禁、隔离执行／UI、同步 main 与 daily 安装完成；按用户追加指令停止通用评测 |

## 2026-09-16 定义编辑与 Git 基线修订

用户随后移除创建期“起始版本”，要求首个 preparing 读取当时源工作树的本地分支与 HEAD；同时正式加入
标题／描述编辑及 Agent 定义更新提示。Migration 159/schema 109 删除 `source_branch`，新增内部
`details_version`、当时的 conversation 读取水位和 workspace `base_branch`。Renderer 用内部版本拒绝旧弹窗覆盖，
Agent `mission get|update` 仍无版本且保持字段后提交覆盖。该读取确认语义随后由下一节的 accepted 投递水位取代；
`CURRENT_INPUT` 与 WORKSPACE shape 始终不变。

创建／恢复 UI 不再展示或提交起始版本；卡片、列表与打开的 Mission 共享编辑菜单。使命板标题采用 Memory／
Scheduled Automation 相同的 34px 顶部留白。定向验证包括 `cargo check -p rovai-core --lib`、`pnpm typecheck`
和 8 段生产组件 Mission 桌面验收；按用户先前指令未运行 Rust 测试，本增量也未执行安装。

## 2026-09-16 稳定编号与 accepted 更新水位

用户纠正了 UUID 外泄命名并替换读取确认语义。Migration 160/schema 110 为 Mission 分配删除后不复用的
数字号；界面使用 `M-018`，新 Git 关联使用 `rovai/mission/018` 与 `<repo>-mission-018`。内部 UUID 继续作为
关系主键。Mission 活动、开始记录和开始消息不再复制标题／描述；旧弹窗冲突通过重新读取最新投影恢复。

ContextManifest 内部冻结本轮 `details_version`，只有对应 Runtime Input 在当前 binding/generation 上
`accepted` 才推进 Conversation 已投递水位。`mission get` 为纯读取。定向 owner 覆盖字段变化事实、数字号、
迁移保留、真实 accepted ACK 及 Mission 桌面生产组件；当前 Run 不重命名既有持久工作区。

## 测试准入

现有 `collaboration`、`runtime`、`context`、`db` owner 已检索；没有 Mission 领域与持久 worktree owner。
新增测试按独立失败语义分配，不建立平行全栈 fixture：

- Mission 事务 owner：创建失败不残留 Camp，成员权限、同字段最后提交、不同字段保留、no-op 与幂等；
  SQLite 事务是合同本体，需要隔离数据库。最小命令 `cargo test -p rovai-core --lib mission::tests`。
- Git 文件系统 owner：固定基准、临时 index 保真实 index、未跟踪／忽略／二进制／特殊路径、冲突及恢复；
  纯 parser 矩阵不能证明 Git 行为，使用临时真实仓库。最小命令 `cargo test -p rovai-core --lib mission_workspace::tests`。
- 已有 Context Evidence owner 扩展使命输入、once-per-binding ACK 和恢复负向分支；沿用唯一 golden，不复制 JSON 断言。
- Migration 158 扩展受支持来源的 admission 矩阵，在 DSH 157 后同时接纳主线附件路径 schema 106 与已安装的 Mission preview schema 106；Migration 160 另行覆盖已部署 Mission 157–159/schema 109 与 DSH 的原位收敛。独立 Mission migration owner 证明事务回滚和当前默认保留行为；Migration 162 owner 证明最小检查点列、触发器移除、既有行保留和失败回滚。旧迁移 owner 没有这个生命周期，需隔离 SQLite。最小命令分别为 `cargo test -p rovai-core --lib mission_migration_is_atomic_and_workspace_survives_camp_deletion` 与 `cargo test -p rovai-core --lib workspace_lifecycle_migration_is_atomic_preserves_rows_and_removes_delete_trigger`。

真实模型只在隔离 Smoke 和已冻结 Gate 中运行。交互稿的 15 组 fixture 检查不构成以上产品验收。

## 2026-09-17 宽屏定义弹窗与源附件

新建和编辑使命复用宽屏无框书写面：名称、描述、标签及源附件可编辑；项目、队员和队长在编辑态锁定，
正式编辑入口仍仅为卡片／列表右键菜单。附件沿用本机原路径引用，支持选择、粘贴、拖入、移除和预览，
开始使命时随 commission 消息进入既有附件发布路径。Migration 161/schema 111 为旧使命补空数组并保留
所有业务行；Desktop Main 独占将 Renderer File 转成路径的私有编排，Web 不接收本机路径。

## 2026-09-18 使命板文件变更与创建恢复增量

使命入口恢复为 Desktop／宽屏 Web 的正式导航项；`needs_you` 只用右侧垂直居中的蓝点提示，视觉上不显示
数量。完整会话的折回按钮保持原位置，改用已确认交互稿的收拢图标。新建使命在同一挂载期保留一份未完成
草稿，关闭后再次打开会恢复名称、描述、项目、队伍、标签和附件；只有创建成功才清空。项目和队员选择器
增加搜索及受限高度滚动，标签选择器使用更醒目的身份色圆点并保持在当前编辑上下文。卡片／列表右键菜单
在保留点击展开子菜单的前提下，为编辑、状态、查看队员、队长、标签和删除全部补齐 hover／键盘焦点反馈；
普通项统一使用中性灰底，删除继续使用危险色语义。

交付区不再截断前五项，而是展示完整、可搜索、支持单子目录压缩的文件树。累计 Diff 使用 1320px 宽屏
阅读面：固定基准及总计位于标题区，左侧文件树与右侧单文件差异通过可拖动且可键盘操作的分隔条连接；
窄屏时文件树折叠到阅读器上方。既有 `missions.changes`、`missions.fileDiff` 和
`missions.diffSession.release` 接口、固定基准、请求合并、LRU 缓存、迟到响应隔离及终态刷新语义保持不变，
本增量没有改变 Core、Git 工作区或 Mission 合同。

定向验证覆盖文件树结构、目录压缩与计数、搜索／滚动、弹窗布局和分隔条键盘调整、缓存与迟到响应、
项目／队员搜索、标签选择、草稿恢复及成功创建后清空。`pnpm typecheck`、完整 Vitest 207 个文件／
2124 项、隔离 Electron `pnpm test:mission-board`、`pnpm docs:test`、`pnpm docs:check` 与带 merge-base
的 `pnpm docs:check:ci` 均通过。

## 2026-09-18 累计 Diff 样式隔离与大文件集窗口化

合入后的复核发现，旧 flat-list Diff 的 `.mission-diff-file-list button` 仍会命中新目录树标题中的
折叠按钮，造成纵向布局、左对齐和旧内边距泄漏；相关旧选择器及无现存 DOM 对应的规则已删除，仍在使用的
计数、二进制、加载与错误状态样式保留在当前树形阅读器附近。

详情区与 Diff 弹窗继续共享同一文件树，并保持目录默认全部展开。完整过滤、建树和扁平结果仍作为逻辑树与
键盘导航依据，但大结果集只挂载当前滚动窗口及前后余量，通过等高占位保留完整滚动范围。Arrow、Home、End
可把未挂载的目标行带入窗口后再转移焦点；弹窗打开时同样先揭示当前选择。Core、Git Diff 接口、固定基准、
缓存与刷新合同均未改变。新增 1200 文件的隔离 Electron 验收，覆盖详情树与弹窗树的有界 DOM、默认展开、
搜索、滚动、完整总计和跨窗口键盘焦点，并用静态回归阻止旧广域按钮选择器返回。

修复验证包括 `pnpm typecheck`、完整 Vitest 207 个文件／2126 项、含标准与 1200 文件场景的隔离
Electron `pnpm test:mission-board`、`pnpm docs:test`、`pnpm docs:check`、带 merge-base 的
`pnpm docs:check:ci` 与 `git diff --check`。

## 2026-09-18 显式 Worktree 清理与删除处置

用户选择可用性优先的最小实现。卡片／列表原有右键菜单只在 Core 的 `cleanupAvailable` 为真时显示
`清理使命 Worktree`；没有详情页省略号、保留资源页面、后台重试、脏文件拦截或额外风险确认。弹窗删除
Worktree 和本地分支，使用中性操作。删除使命新增默认 `retain` 的 `workspaceDisposition`；只有用户勾选时
才先结束执行、完成两步清理并删除使命，任一步失败都保留使命。

实现复用 `mission_workspace` 与命令记录，只增加准备模式、generation、清理命令、expected branch OID 和
两个步骤检查点。清理与 preparing 使用同一互斥，Core 按同 Camp 或相同 execution root 检查全部活跃 Run；
分支使用 expected OID 条件删除。后续 Run 在 Worktree 缺失时按实际分支状态恢复，既有 Native Session resume
不变。Migration 162/schema 112 原位补列并删除旧的无条件 Camp-delete cleanup trigger；历史孤儿清理 route
仅继续处理已经处于旧 `cleanup_pending`／`cleanup_failed` 的记录。

最终验证覆盖 `cargo check --workspace --all-targets`、`cargo test -p rovai-core --lib`
（832 passed、6 ignored）、`cargo test -p rovai-web`（8 passed）、`pnpm typecheck`、
`pnpm test:desktop-bridge`、`pnpm test:mission-board`（标准场景与 1200 文件窗口化场景）、
`pnpm test:host-web`（4 passed）、`pnpm build:web`，以及完整 documentation governance／diff-aware CI 门禁。

## 2026-09-19 Worktree 清理短路径

显式清理继续使用既有互斥、执行占用检查、所有权证明、expected OID 条件删除和两个持久检查点，不增加队列、
状态机或通用锁。首次尝试在确认路径、仓库、owner marker 与分支归属后只读取一次分支 OID 并持久化；重试复用
该 OID，已完成的 Worktree 步骤不再重做整套校验。正常路径收敛为移除已验证 Worktree、一次分支占用检查和
一次 `update-ref -d <ref> <expectedOid>`；删除前后的重复 OID 探测已移除。资源已经不存在或删除后尚未来得及
记录检查点时仍按幂等成功处理，异常 registration／staging 仍只删除带该使命 owner 证明的精确资源。

Renderer 在 `missions.workspace.cleanup` 成功后先关闭原确认弹窗，再并发刷新 Mission 列表与当前 Camp。
刷新失败走独立通知，明确清理已经成功，不会把弹窗恢复为清理失败；确认文案、按钮和入口保持不变。

## 主线整合与验收

已整合 `origin/main` 的 `42427999`（含 #397–#403）。主线 Migration 156/schema 106 保留；Mission 与附件上下文曾在 Migration 157/schema 107 汇合，并兼容先前安装的 Mission schema 106；定义编辑与基线修订曾推进到 Migration 158/schema 108，稳定编号与 accepted 水位曾推进到 Migration 159/schema 109。preparing 与 claim 共用准入检查，同时保留主线无时限执行的语义。

随后整合 `origin/main` 的 `e6d7f0cf` 时，主线已把 Migration 157/schema 107 分配给 DSH。最终序列保留
DSH 157，将 Mission context／definition／delivery 顺延到 158–160，由定义附件 Migration 161 推进到 schema 111，
再由工作区处置 Migration 162 推进到当前 schema 112；已安装的 Mission
157–159/schema 109 被精确识别为旧 preview，只能通过 Migration 160 补齐 DSH 并收敛，不改写 Mission
业务行、已冻结 Context 或既有工作区。

随后整合 `243eb748`（#399 文件链接间距）。这次整合只改 Renderer／UI 文档；冻结的 Core／Skill
内容指纹 `57adf680f418ab212392d3c79e533cc76e830d22ad34d82c99abf12e430d69d2` 保持不变。
相关 98 项单元测试、类型检查，以及文件预览、链接导航、使命生产组件三项桌面集成均通过。

生产组件的浅色／深色、1040／1440／2560 宽度及抽屉／完整会话草稿保持已验证。
更新原有 Pending v3 页面夹具到当前 v4 移回输入框语义；旧编辑 API 继续由 Core owner 覆盖。
回归同时修复迟到 route read 在本地输入后更新接收者的问题，既有 Coordinator 和真实 Composer owner 已覆盖。
真实运行入口为 `node scripts/smoke-mission.mjs <absolute-core> <new-output>`，显式创建独立 data-dir、Skill Library 与 Git/非 Git项目。
常规门禁与最终安装已完成；上下文 Gate 按用户追加指令提前结束，不记为完整通过。

真实运行第七次验收已通过六个阶段：保存不执行、开始幂等与 preparing 建工作区、A2A／非队长更新、
固定基准净 Diff 与文件来源、Core 重启及非 Git 普通消息、当时合同下删除 worktree 并保留分支。证据位于
`/private/tmp/rovai-mission-evidence-20260915/runtime-7/report.json`，四个真实 Codex Run 均成功。
执行夹具使用独立空 `ZDOTDIR`，避免本机登录 Shell 把候选 CLI 的 PATH 改回日常安装版。

这轮实际执行发现并修复两条生命周期回归，均扩展既有 owner，没有新增平行测试：

- `team_tool::tests::public_delivery_runtime_consumes_the_pre_run_frozen_context_bytes` 增加当前 v25
  A2A 工作区类型传递；修复前接收 Run 的类型被重置为 shared，preparing 拒绝冻结输入。v22／v23／两种 v24 仍验证原有恢复。
- `collaboration::slow_tests::camp_rename_lead_change_and_quiescent_delete_are_versioned` 增加已经提交的
  Agent 文件 ingest intent；修复前删除其 Camp Message 触发外键错误。Camp 删除现在先移除随 Camp 清理的
  ingest intent，文件系统仍归原有清理 journal。最小命令为该名称的 `cargo test -p rovai-core --features slow-tests --lib`。

默认 Rust 工作区门禁通过；完整 slow-tests 首轮有 13 项失败，保留日志。其中 Git／进程测试受到共享
Runtime PATH 夹具或 deadline 影响，13 项在独立进程复验均通过，未将首轮记录改写为全绿。
生产 Mission UI fixture 通过整卡点击、项目右侧标签、多队员头像、抽屉／会话草稿保持、交付预览和来源跳转。
文件预览主题切换的回归也已通过：固定 CodeMirror phrases 配置身份，避免主题更新触发完整编辑器状态重置。

## 上下文评测提前结束

2026-09-15 用户追加指令“评测先结束吧”。已停止本轮 Gate 及全部已确认属于它的子进程，
没有继续启动评测或自动重跑。冻结计划、原始结果、失败记录与未完成项保持原样。

原计划为 12 Case／24 次版本运行；停止时已写入 15 个完整 slot。候选 DEMO-101 至 DEMO-108
八项硬验收及专项规则通过。DEMO-106 基线执行通过但评分中止；DEMO-109 基线运行中止；
其他未运行项不计通过。两个版本的 16 项合同检查均通过。

保留的限制包括：DEMO-104 基线写入了范围外文件；DEMO-105 候选的结果评审被模型服务以
`invalid_json_schema` 拒绝；DEMO-108 候选的声明准确性为部分满足。模型别名也不构成固定权重
快照证明。完整 Gate 未完成，不声称 Formal qualification、语义全部通过或统计上的非劣性。

停止记录与可视索引位于 `/private/tmp/rovai-mission-evidence-20260915/gate/user-stop-report.json`
和同目录 `index.html`，已经通过无界面浏览器打开检查。冻结计划摘要为
`adb670428da9d023bb2f6307e9d9a8404c25762e8987e567e76cb70603ddcd7f`。

## 安装边界

使用 `/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-mission-board` 的 `rovai/mission-board` 分支。
基线 `b2df4d85cdb8c6b8a9346290b16311b94fa4b7ed`。最后执行 `git pull --ff-only origin main`，
确认 main 为 `243eb748`（#399），并已整合进任务分支。
2026-09-15 从 daily profile 原子安装 `/Applications/Rovai AI.app`，安装脚本的三个位置验签均通过。
旧包保留在 `/Applications/Rovai AI.backup-before-mission-20260915-2132.app`。

`pnpm package:mac:daily` 已生成 arm64 ad-hoc 产物并通过验签。隔离 packaged App 的六项验收通过，
记录为 `/private/tmp/rovai-mission-evidence-20260915/packaged-1/report.json`：真实新使命弹窗保存、
Core admission、Mission RPC、整卡导航、普通会话顶栏、抽屉／完整会话草稿保持和交付／活动。
隔离目录使用自己的 `user-data/managed-skill-library` 与 `mcp.json`；没有启动额外的日常实例。

安装后 Core、Host、CLI 三个二进制与已验收源包的摘要一致，CLI 为 contract-v25／ipc-v2；
旧包 CLI 为 contract-v24。原 App PID 95883、Host PID 95895 及三个 Helper 均仍存活。
安装记录位于 `/private/tmp/rovai-mission-evidence-20260915/installation-1.json`。
磁盘新版本已经安装，当前进程仍为旧版本；用户稍后退出并从规范安装路径重新打开时生效。
Computer Use 保持关闭，未终止当前会话，也未改写日常用户数据。
