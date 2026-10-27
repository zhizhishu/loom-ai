---
document_type: research-report
authority: task-capability-implementation-evidence
status: implemented-gate-insufficient
last_updated: 2026-10-18
---

# 会话 Task 开关实施与验证

按 User 消息 `fd9bee73-2ea8-4798-9d3d-dbb9ca067963` 授权，在独立 worktree 的
`rovai/task-capability` 分支实施 [R4](model-context-change-task-capability.md)。主分支基线为
`c69a97fbff1e986bbd1ff12ecfa55797b73e0553`；交互依据为
[现有风格设计稿](../../research/task-capability-ui.md)。本页记录实际实现及证据，不改变已确认的模型输入方案。
功能实施、当前窗口输入保护与真实普通 CLI 链路已完成验证；正式 Context Gate 仍为证据不足，
不能视为完整质量验收通过。各轮记录按发生顺序保留，最新结果以下表及末节为准。

## 最新验收摘要

本轮草稿提交修复冻结于 `7f8741494f998b464116248e87a48c686c45e1c1`，后续提交只补充验收记录。
普通 CLI 与完整扩展 Rust 证据仍对应上一轮 `bc53fa77f69bd816ac80170d9c22eb480d41f198`；
本轮未改 Rust、通知、开关、CLI 或模型输入，未将历史执行改写成本轮实测。

| 检查 | 截至 2026-10-18 的结果 |
| --- | --- |
| Task 编辑输入 | 补齐提交生命周期：未决保存重开不能重复提交、未修改的恢复草稿成功后清除、后来输入保留、未知回执重试复用精确命令；仍仅当前窗口内存保留 |
| 普通 CLI 与运行中切换 | 真实 Codex Run 通过：普通 `rovai --version`、普通 `rovai send`，五阶段 Task 可用性与帮助显隐；同一 Run／epoch／process／lease |
| 前端与构建 | `pnpm typecheck`、完整 `pnpm test`、`pnpm build:desktop` 通过；Darwin／Win32 fixture 分支在 macOS Electron 执行 |
| 默认 Rust workspace | 本轮 `pnpm test:rust:pr` 完整通过：473 通过、0 失败、1 项既有人工检查忽略 |
| 完整 Rust 扩展 workspace | 上一轮固定候选单次完整命令 exit 0：1064 通过、0 失败、8 项既有原生 Runtime 人工检查忽略；其中 Core lib 1018 通过；本轮未重跑扩展组 |
| 验收前置 | 相同 Core 二进制的 Runtime 冻结配置差异为 `[]`；CLI Judge 传输探针为一次请求、`tools=[]`，仅诊断资格 |
| 正式 Context Gate | 仍为 `insufficient`。原 campaign 两次尝试保留；尚缺固定模型快照 Judge 配置及后续正式运行预算 |

首轮完整扩展运行的两项 ACP 失败和更早的清理超时均保留在后文；上一轮完整复验没有再现它们，
但不将未稳定复现解释为已经定位并修复了这些进程时序问题的根因。

## 已实现行为

| 范围 | 结果 |
| --- | --- |
| 设置 | Core 实例级持久开关，默认关闭。设置位于通用 → 会话 → 世界地图下方；保存失败只影响这一行，并可重试 |
| 旧任务 | 关闭后也不再允许新读取或更新，数据保留；重新开启后恢复管理，不自动补写关闭期间的任务状态 |
| 执行可用性 | 随时切换，不等待任务结算，不取消 Run、消息或队列；实际操作在同一锁/事务内检查当前开关 |
| Bootstrap / Skill | 开关两态共用精简教学；去掉 Task 对象依赖，不增加关闭说明。Native Session compatibility 仍为 16 |
| 动态上下文 | 关闭时不选择或输出 SELF_ACTIVE_TASKS；新 Run Facts 移除 taskContext、singleChat.taskMutationAllowed；已冻结输入保持原字节 |
| CLI / 工具 | 关闭时 help、目录、schema 不发现 Task。CLI help 只读本地能力投影，不发 IPC；缺失、损坏、未知或未绑定投影按关闭处理 |
| Task 直接调用 | 返回 task.feature_disabled / recovery stop，CLI exit 2；只拒绝该次操作，不中止当前执行 |
| Send | 开关两态共用无 Task 关联的定义。合法旧 taskId（含 null）兼容为普通发送；不推导接收者，不检查任务负责人/状态 |
| 读侧 / 通知 | 关闭时省略 Task 数据、覆盖率及计数；通知在 SQL LIMIT 前过滤，未读数排除任务；关闭期间不新建任务提醒，旧通知导航退回来源会话 |
| 会话界面 | 真实 DOM 顺序为执行、队员、单聊、任务；任务为可选第 4 项。关闭时卸载 Task 面板/弹窗，保留消息草稿、阅读状态与当前窗口的 Task 编辑草稿 |
| 快捷键 | v1→v2 一次性统一执行/队员/单聊/任务为 Mod+1/2/3/4；清除其他操作对这四键的占用，保留其余键位、侧键和发送方式 |
| 快捷键关闭态 | 隐藏并停用任务键位和侧键；不消费输入。隐藏任务键位被其他操作使用时原子转移，重开不抢回；迁移失败保留磁盘原值并提供重试 |
| Host Web | 同步 Core 的开关事件；切换 Host 重置投影，重连/读取失败保留本 Host 已确认状态；设置与通知按序号合并，旧响应不能恢复旧 Host 或较旧开关状态 |

Task 历史消息、审计、旧关联、已提交回执仍可按原有历史/恢复规则保留。领域 commandId 重试遵循
既有“返回首次提交结果”语义；CLI 的 requestId 另外校验原始请求摘要，旧 taskId 仍参与该摘要。
这两个幂等边界保持各自原语义，没有为了兼容旧 Send 丢弃身份字段。

## 合同与迁移

合入主线时保留 MiniMax 的 Migration 205 / schema 155，Task 两步顺延为 Migration 206 / schema 156
与 Migration 207 / schema 157。前者新增设置及新输入格式准入，后者增加固定通知边界；不重写旧任务或冻结输入。
下文旧候选验收保留当时的 205/206、155/156 编号，只对应所注明候选；未把隔离候选库声明为日常已发布升级源。
新公开输入使用 ContextManifest 40 / Profile 15 / Facts 11；非批量输入使用 41 / 16 / 12。
旧 Steer 输入唯一性、来源关联和不可变约束继续参与数据库准入；迁移故障回滚后可重试。

本次继任合同为 Durable Task v6、Built-in Transport v42、Context Manifest v40、Context Delivery Profile v15、
Run Facts v9、Send v28、Continuation v4、Camp Open v30、Notification Episode v10、Desktop Shortcuts v2、Host Web v6。
当前权威入口已更新，历史合同不追改。

## 首轮检查记录

| 检查 | 实际结果与范围 |
| --- | --- |
| Renderer / shared / Main Vitest | 246 文件、2729 测试通过 |
| 通知最终定向回归 | App 与通知 owner 共 203 测试通过；随后 typecheck 与 Desktop 构建通过 |
| Node 包测试组 | 375 通过，2 个既有 Windows 专属项跳过；总数 377 |
| Rust 默认 workspace | 473 通过，1 个既有人工验收项忽略；Core lib 为 427 通过 |
| Rust 扩展 workspace | Core 1026 项：1010 通过、8 个既有忽略、8 处旧 fixture/版本断言失败；修正后八个失败 owner 全部定向复验通过。完整扩展命令在 Core 失败后停止，未重跑全套，不写作一次全绿 |
| TeamTool owner | 56 通过；覆盖旧 taskId、不推导接收者、publicOnly 和既有回执 |
| Steer 与迁移 owner | Steer 3 通过，来源布局收敛 1 通过，当前库准入 1 通过；当前 schema 两项、成员路由及 v95/v98/v172 历史升级 owner 复验通过 |
| Pending 邀请 / Task 升级 / 续做 owner | 首次发送接受合法旧 taskId 且保持邀请原子性；Task 迁移 owner（extended + slow）通过；续做按当前开关读取 Task，同时保留原冻结输入 |
| Single Chat owner | 15 通过 |
| CLI | 单元 31 通过；真实 CLI 文件输入/能力投影进程 owner 通过，帮助零 IPC |
| 通知分页 owner | 通过：任务不占分页、不计未读，关闭不新增任务提醒，重开恢复原条目 |
| 通知 Electron fixture | 两个 owner 分别通过：设置偏好保留、任务提醒关闭撤下/重开不补弹、普通提醒保留、执行/任务/使命来源定位；旧 fixture 补齐显式开启与当前 snapshot schema 后复验 |
| 快捷键 Electron fixture | Darwin / Windows 分支通过；真实键盘输入、浅/深色、中英文、冲突及保存失败路径覆盖 |
| 类型 / 构建 / 桥接 | typecheck、build:desktop、cargo check workspace、cargo fmt check、Desktop request bridge 通过 |
| 文档与 Skills | docs:check、docs:check:ci（基线 c69a97f）、docs:test、skills:check 通过 |

普通回归与专项检查的结果不能替代真实 Runtime 上下文 Gate；下面单独记录。
Windows 快捷键 fixture 在 macOS 执行，只证明 Windows 分支控制流和渲染，未声称 Windows 真机或物理鼠标验收。

## 隔离 App 操作验证

使用 `pnpm dev` 和 worktree 下独立的 `.local/task-capability-ui`，Skill Library 位于同一隔离目录。
没有复制或写入日常数据库，没有停止、升级或部署日常 App。验证结束后已停止该开发实例。

实际通过的交互链路：

1. 默认关闭时检查通用设置位置，开启后四项入口按执行/队员/单聊/任务排列，⌘4 打开任务面板。
2. 在隔离会话创建“任务开关隔离验收”，保留未发送草稿“验收草稿：切换任务开关后保留。”；不启动 Agent Run。
3. 关闭后任务入口、面板、提醒分类、快捷键行消失，⌘4 不打开任务，草稿仍在。
4. 重新开启后同一任务及 pending 状态恢复，数量为 1，草稿仍在。

## 上下文 Gate

基线和候选使用独立二进制、数据目录、Skill Library 与测试项目；固定 Suite 2.12.0 的 12 个通用 Case，
两侧各一轮，三位 Codex CLI 队员，模型 gpt-6.1-sol / medium，最多同时执行两个 Case。
预算及评分标准沿用已冻结的 R4 配置，不因结果修改。

Judge 准备返回 `judge.cli_tools_not_disabled`，未产生合格配置。本轮使用 `judge: null` 验证真实执行与机械规则；
即使它们全部通过，整体也只能报告语义评估证据不足，不能写作完整 Gate 通过。

第一次 attempt 在基线离线检查阶段中断；尚未执行 Runtime Case。中断原因和日志保留在原 campaign，
修复合同 owner 名称与测试版本后使用同一 campaign 的第二次机会，不删除旧尝试或另建 campaign 重置计数。
第二次 `attempt-02` 已结束，CLI exit 2，报告状态为 `insufficient`：

| 检查 | 结果 |
| --- | --- |
| Current Contract Conformance | 基线和候选各 16 项全部通过，进程 exit 0 |
| DEMO-101～112 | 两侧共 24 个 slot，全部在 preflight 结束，`dispatchAccepted: false` |
| 预检原因 | 两侧均为 `frozen member Runtime drifted: agent_1`；Runner 对配置后成员的 readiness、adapter、model、permissions 与冻结计划进行核对时未通过 |
| 语义评价 | Judge 未运行，质量覆盖率 0%；质量分、协作结果与资源比较均不可用 |
| 比较结论 | `regressions` 0、`evaluationFailures` 0、`evidenceGaps` 54；没有可比较的真实执行，不能由空退化列表得出“没有退化” |

已打开原 campaign `index.html` 和 `attempt-02/report.html`，核对版本、两次尝试、结论、逐 slot、
证据缺口及资源比较。第一次不完整尝试仍列为证据不足并保留中断说明。
本 campaign 达到两次上限，按[评测流程](../../development/evaluation.md#上下文改动-gate)停止；
没有删除失败、修改冻结标准、绕过 Runtime 校验或另建同标准 campaign 重置次数。
真实上下文质量与协作验证仍待解决 Runtime 预检和 Judge 工具禁用问题后完成。

本地证据根目录为 `.local/task-capability-validation/campaign`，原始报告与私有测试状态不提交仓库。
冻结 Plan digest 为 `7753863c4bb267bde01c0da1d9764104281dd25e0aeb2026e16620c3e89f2e58`；
候选源码摘要为 `a972a7673704d03d5824f277f9b1dd529bf4bb726b029c4cb39d695fa631cb19`，
Core 摘要为 `f6096353486a30d8a88126894e9d4bd8b172fe3f8e68628c94196c1e97c85e14`。
构建记录的候选 Git HEAD 是提交前的 `d30c1fe`，实际改动由源码摘要冻结；报告完成后再提交实现。
已确认 R4 文档保持冻结版本，最新实施状态由本页提供。

## 评审后修复与真实执行验证

本节记录 `997c0840` 的实施与验证；其中异步 Task 水位方案仍有慢请求和失败窗口缺陷，已由下节固定边界方案替代。

根据 User 消息 `376f5143-18de-4241-8938-d9792254345f` 独立核对，三项问题均成立；修复不改变
Session 连续性、冻结输入、统一 Send 或旧 taskId 的既定行为，没有新增用户配置。

| 问题 | 最小修复 | 回归证据 |
| --- | --- | --- |
| A 保存中切换 B，B 继承 saving/error | Host 变化时重置能力 Provider 的完整 React state；本地代次也隔离 A→B→A 的旧保存结果，不 key/remount 工作区 | 真实 React/Electron：A 的保存悬而未决，切到 B 后 ready=true、saving=false；A 后续成功/失败不污染 B，切回原 A 对象也不恢复旧错误，子树输入 DOM 与草稿保留 |
| Task 切换推进全局游标，漏掉未轮询的普通提醒 | 全局游标继续原增量消费；只给 Task 建立启用水位，关闭时过滤 Task 排队项和在途结果 | 两次轮询间插入普通提醒，再分别关闭/开启，提醒仍弹出；旧 Task 不入队，新 Task 正常弹出；水位读取短暂失败时普通提醒仍显示，后续轮询恢复 |
| 投影写入失败后，相同值无法修复旧进程 | 每次保存均刷新；失败后最多三次有界重试，间隔 100/500/2000ms，各次在调用锁内重读当前值，等待时不持锁 | 既有 lease owner 注入文件故障，验证原 lease 有效及同状态重写；真实 Run 分别验证耗尽后同值保存修复与自动重试 |

定向验证：TypeScript typecheck 通过；App/通知 Vitest 203 项通过；通知 Electron 两个 owner 通过；
`builtin_tool_runtime::tests::lease_rotates_fences_and_replays_exact_request` 实际执行 1 项通过；
Qualification Core/Artifacts/Evaluation Context 12 项通过。初次误选 binary test target 的命令执行了 0 项，
已改用 `--lib` 真正运行 owner，不将 0 项计为测试通过。Rust 未新增、删除或永久禁用 owner，文件故障分支扩展原 lease owner。

本次另执行完整 `cargo test --workspace --features extended-tests -- --test-threads=4`：Core **1017 通过、
1 失败、8 忽略**，耗时 1951.41s，命令 exit 101，在 Core 失败后停止，后续 workspace targets 未运行。
此前八个修正 owner 在本轮均已通过；本次失败为未修改模块中的
`runtime_probe_process::tests::successful_leader_with_stdio_holding_descendant_finishes_bounded`，具体错误是
`runtime_probe_stdout_cleanup_timed_out`（500ms 清理预算）。随后带 `--features extended-tests --lib` 的精确单项
复验执行 1 项、0.02s 通过。根因尚未确认，没有放宽时间预算、忽略或删除测试，也没有把单项复验计作全套全绿。
完整日志为 `/tmp/rovai-task-review-rust-extended.log`，单项复验为 `/tmp/rovai-task-review-probe-rerun.log`。
最终 typecheck、Desktop 构建、通知 Electron 两个 owner（含 A→B→A 和水位读取失败恢复）、文档通用门禁均通过。

真实功能探针为 [`scripts/probe-task-capability.mjs`](../../../scripts/probe-task-capability.mjs)，使用新建的绝对目录、
独立 Core/Skill Library/MCP/原生 Codex 目录；调用生产 Core、真实 Codex CLI 和随 Run 注入的 Rovai CLI，
不是伪造 lease 或直接修改 SQLite。Agent 执行探针脚本，Host 从外部切换设置。
冻结的 gpt-6.1-sol / medium、danger-full-access / never 保持不变。最终 `live-05/report.json` 的实际结果：

| 阶段 | 根帮助发现 Task | Task help / task list 退出码 | 普通 Send 退出码 |
| --- | --- | --- | --- |
| 默认关闭 | 否 | 2 / 2，task.feature_disabled | 0 |
| 开启 | 是 | 0 / 0 | 0 |
| 再关闭 | 否 | 2 / 2，task.feature_disabled | 0 |
| 写入失败、三次重试耗尽、恢复文件后保存相同 true | 是 | 0 / 0 | 0 |
| 写入短暂失败，文件恢复后自动重试 | 是 | 0 / 0 | 0 |

五阶段共用 Run `1984ed06-b2e6-4300-9a86-b6a22b8e5bde`、execution epoch 1、同一进程和 lease；
每阶段读取的 Run 均为 running，最后 succeeded。Runtime input 只有一条 start / accepted，未重绑定或重启 Run。
Agent 还成功发布 `TASK_SWITCH_DONE`；六条消息均核对 author_type=agent 与同一 source_agent_run_id，
收尾标记按完整正文精确匹配。验收 Core 正常停止，exit 0。
本次 Core SHA-256 为 `168eab9fe5a3891bff4d908229eef397bc70719c16a205369c5f236d9b836751`。
这是同一真实 Run 的工具切换及 Send 集成证据；草稿由前述独立 UI 和 Provider 子树测试覆盖，
本次 headless 探针不声称完成“真实 Run 中的整套 Desktop 手工验收”。

证据保存在 `.local/task-capability-review/`；`live-01` 的旧环境配置接口错误、`live-02` 的静态 readiness
断言和 `live-03` 的帮助匹配断言错误均保留。`live-04` 的五阶段成功，但 Agent 最后裸 `rovai send`
解析到日常 CLI v41，对候选 v42 context 返回 cli_error；旧探针的 includes 断言误匹配 User 提示，不能采信其
整体 passed。原报告保留并在本页纠正；`live-05` 在同一个真实 Agent 环境中记录了两条 CLI 的绝对路径与版本，
显式使用 Run 注入的候选 CLI，收紧收尾消息校验后才完整通过。没有升级或修改日常 CLI。
`live-05` 使用的 CLI 为 0.4.12 / contract-v42 / ipc-v3；登录 shell 解析到的日常版本为 0.4.11 / v41 / ipc-v3。
这些是功能诊断，不新增或重置 Context Gate campaign 的尝试次数。

### Runtime drift 的逐字段复现

本次重新读取配置后的成员，原始配置与冻结值的比较结果如下；只有一项不同。
readiness 的 ready 是 Runner 的内置预期，其余项来自冻结 team 配置：

| 字段 | Runner 预期／冻结配置 | 实际读回 |
| --- | --- | --- |
| runtimeReadiness.status | ready | installed_unverified |
| runtimeConfiguration.adapterKind | codex-cli | codex-cli |
| runtimeConfiguration.model.mode | explicit | explicit |
| runtimeConfiguration.model.modelId | gpt-6.1-sol | gpt-6.1-sol |
| runtimeConfiguration.model.options.reasoning_effort | medium | medium |
| runtimeConfiguration.permissions.adapterKind | codex-cli | codex-cli |
| runtimeConfiguration.permissions.schemaVersion | 1 | 1 |
| runtimeConfiguration.permissions.values.sandbox_mode | danger-full-access | danger-full-access |
| runtimeConfiguration.permissions.values.approval_policy | never | never |

`runtime.product.check` 同时返回 ready=true，成员 blockers=[]。当前 `agent_profile::runtime_readiness()`
对有效静态配置返回 installed_unverified，已有 Rust owner 明确断言此行为；成员查询不替代真实 Host 启动校验。
因此，本次复现定位为 Runner 仍要求旧成员投影 ready；没有观察到模型或权限漂移。
Runner 只增加了限定字段的差异诊断，没有放宽原 Gate 条件，也不输出原生认证或环境变量。
功能探针按当前 Core 正常执行准入启动，真实 input accepted / Run succeeded 单独作为执行证据。
原 campaign 的 24 个 slot 仍为未 dispatch，Judge 仍未运行，正式 Gate 状态继续为 insufficient。

## Task 通知固定边界修复

User 消息 `9a39dd92-80f7-4131-bbac-b96b0aa105ce` 的两个问题均成立：原 Task 水位 Promise 会占住全局 poll；
失败返回 Infinity 后推进游标，会吞掉失败窗口内的新 Task。立即 reject 的旧测试没有覆盖 pending 和窗口内通知。

| 项目 | 改前 | 改后 |
| --- | --- | --- |
| 开启边界 | Renderer 另读 Inbox，读取成功时才决定 | Core 开启事务保存一个通知序号，与 enabled 一起返回 |
| 慢请求/失败 | 整批等待；Infinity 过滤并消费 Task；重试边界后移 | 删除 Task 水位请求、Promise 和重试；直接使用固定数字 |
| 重读/重复保存 | 可能取得更晚水位 | 固定边界不变；再次 false→true 才更新 |
| 旧库 | schema 155 只有 enabled | Migration 206 增加一列；保留开关、通知、未读与业务数据 |

没有增加用户配置、等待队列或通用开关调度。模型上下文和冻结 R4 未变。
通知 Electron 既有 owner 扩展三条时序；Rust 复用 inbox/cursor、Task 升级与当前 schema 准入 owner，
验证固定边界、同值保存、重开保留及 155→156 升级/回滚，不新增 Rust 测试函数。

已经完成的定向验证：

- 同一新 Electron fixture 放回 `997c0840` Controller 后，在 pending 场景失败：普通提醒未出现；恢复修复后两个 owner 全部通过，包含三条评审时序、精确 Task acknowledgement ID、一次处理及快速关/开队列清理。
- App/通知 Vitest 210 项通过；快捷键隔离 Electron 的 macOS/Windows 分支通过；typecheck 和 Desktop/Web 构建通过。
- Rust 使用 `extended-tests,slow-tests` 实际执行通知 12 项，以及 Task 升级、当前迁移矩阵、当前库准入、必要对象、Delivery-first 和 v1.72 保留输入六个 owner，共 18 项通过；没有新增或停用 Rust 测试函数。
- 初次 Rust 命令只启用 extended-tests，目标 owner 在 slow-tests 下，实际 0 项，不计通过。补全 feature 后，新 heads-up 断言发现原 inbox fixture 没有对应业务 Task；补入合法 Task 来源后验证真实信号，不将来源不可用误当水位缺陷。
- 首轮 `pnpm test` 的 Vitest 全部通过；Node 的 Product Contract Fingerprint 仍硬编码 schema 155，按实际 Migration 206 更新为 156 后重跑。没有放宽比较条件。

最终 `pnpm test` 完整通过：Vitest 246 文件 / 2729 项，Node 包测试 356 通过、2 个既有 Windows 平台项跳过；文档、Skills 与 Electron capability 子门禁同时通过。
最终 `cargo test --workspace` 完整通过：473 通过、1 个既有人工验收项忽略，其中 Core 为 427 通过。最终 typecheck、Desktop/Web 构建、通知两个 Electron owner、快捷键 owner、通用文档门禁与格式检查均通过。
原正式上下文 Gate 仍为 insufficient，上一轮完整扩展回归的一处清理超时仍保留记录；本轮没有重跑完整 extended workspace、真实模型 Run 或正式 Context campaign，不将普通回归写作整体质量 Gate 通过。

## Task 设置与通知响应乱序修复

User 消息 `a2580c5b-0b9c-4d70-9b1a-29631a1ec525` 指出的竞态成立。固定边界没有移动，但通知先返回时，
Renderer 仍可能用旧的 enabled=false 丢掉边界后的 Task，再推进全局游标。上一节的 Inbox pending/失败测试
没有覆盖 settings get；不将前一轮通过解释成已经验证本次跨响应时序。

| 项目 | 改前 | 改后 |
| --- | --- | --- |
| 消费依据 | 依赖独立 settings get 更新的缓存 | changesSince 在同一读取事务内返回增量、开关与固定边界 |
| 响应乱序 | 启用响应迟到可能丢 Task；无法按 Core 顺序合并 | get/set/通知共用 observedThroughChangeSequence，只接收不旧于已确认状态的快照 |
| 仅切换、没有新通知 | 无法区分同水位的开启/关闭 | 实际切换在同一事务内递增已有通知时钟，不创建通知或改未读 |
| 设置读取失败 | 本地回到关闭/未知 | 保留本 Host 已确认状态；有效通知批次可直接恢复投影 |
| 重复空批次 | 新接入投影时可能重复触发渲染 | 相同快照返回原 React state，不形成渲染/轮询循环 |

复用一个开关、现有固定边界和已有通知时钟。没有新增表、列、Migration、等待队列、后台同步器或用户配置。
普通提醒不等待设置；全局游标只在正常批次消费后推进。Host A→B→A 仍按访问代次隔离，不重建会话工作区。
模型上下文、提示词、冻结 R4 与 CLI 执行策略均未修改。

验证沿用已有 owner：

- 新 Electron fixture 在未改生产实现时，稳定复现 `pending: the new Task was queued before settings returned` 断言失败；普通提醒已经处理，精确新 Task 没有进入队列。
- 修复中间版本的 Electron owner 触发 75 秒超时：相同快照重复 setState 形成渲染/轮询反馈；增加相同状态不更新后复验，保留原失败记录，不放宽超时或修改生产回调以隐藏问题。
- 核心场景包括 settings get 长期 pending、pending 后 reject、立即读取失败、旧关闭响应单独迟到、旧开启通知批次晚于已确认关闭；逐个核对精确 Task acknowledgement 一次、旧 Task 不补弹、普通提醒继续处理。
- Rust 继续扩展现有 inbox/cursor owner：批次有效快照、空页/reset、一致的开关过滤、无通知间隔的切换顺序、同值保存不递增、事务回滚；未新增或停用 Rust owner。分页局部游标 owner 验证跨页能力变化。

最终通知 Electron 两个 owner、快捷键一个 owner（macOS 上执行 Darwin/Windows 分支）、定向 Vitest 210 项、
Rust 通知 12 项均通过。完整 `pnpm test` 通过：Vitest 246 文件 / 2729 项，Node 包测试 356 通过、2 个既有平台项跳过。
完整默认 `cargo test --workspace` 通过：473 通过、1 个既有人工验收项忽略，Core 427 通过；
typecheck、Desktop/Web 构建、通用文档门禁与格式检查通过。

正式 Context Gate 仍为 insufficient；前一轮完整扩展回归的清理超时保留。本轮未重跑完整 extended workspace、
真实模型 Run 或正式 Context campaign。历史 `live-05` 是 `997c0840` 的功能执行证据，不冒充本轮新验收。

## 交付边界

本分支实施 R4，无每会话覆盖、Agent 改设置、数据清理或自动转换任务。此次不包含主分支合并、发版或日常 App 安装。
历史 Session 可能仍含旧说明，Core 按当前开关执行；已冻结输入继续按原证据恢复，这是有意保留的连续性边界。


## 用户输入与普通 CLI 入口收尾（2026-10-17）

本节回应 User 消息 `e53193d0-498e-41a3-86c1-efca49abbb97` 对 `ed7c34f7` 的复查。
通知快照、启用边界、游标与开关核心没有继续改动；Rovai Bootstrap、动态上下文、统一 Send 教学均无新增文本。

### Task 编辑输入

原来草稿 Map 与表单一起属于 TaskPanel，关闭功能时卸载即丢失。现在 Map 由 Renderer 按稳定
ThreadClient（Host／Owner）、Thread、Task／新建标识持有，表单每次提交到 UI 的输入同步保留；
面板仍按原规则完全卸载。重新开启并打开编辑器后恢复标题、说明、负责人、状态说明和取消原因。
只重建 Task 编辑器以隔离 Host／Thread，不重建整个会话工作区，也不写数据库或自动提交任务。

当轮覆盖了保存失败保留输入、普通成功清除草稿，以及旧请求完成不能清除重开后继续编辑的新输入。
未覆盖“不修改地恢复”的提交状态及成功清理，后续复查确认的缺口与修复见末节。
编辑基线随草稿保留，因此未改动字段不会用旧值覆盖远端更新。草稿仅在当前窗口内存保留，窗口
关闭／重载不承诺恢复。沿用原 Dialog 和文案，没有增加切换确认或阻止全局关闭。

[会话界面说明](../../ui/components/conversation-workspace.md#taskapproval-与停止)同时明确：关闭期间
工作可以继续，但任务状态不能更新；重新开启不自动从执行结果或聊天推算任务完成。

### 普通 CLI 入口

`live-06-normal` 通过真实 Codex 默认命令工具复现：Core 注入的候选为 `0.4.12 / contract-v42`，
普通 `rovai` 却被登录初始化解析到日常安装的 `0.4.11 / contract-v41`。原记录保留，没有把显式路径成功
当作普通入口成功。

修正只有 Codex 的 Built-in Host 启动参数 `allow_login_shell=false`，沿用 Host 已准备的 PATH，
避免再次登录初始化改变候选 CLI 的优先级。它不修改用户 Shell 配置、全局 PATH 或安装版 CLI；
显式 `login=true` 请求按 Codex 原生规则拒绝。参数语义由本机 `codex-cli 0.162.1` 实测，并核对
[OpenAI 配置参考](https://learn.chatgpt.com/docs/config-file/config-reference)。其他 Runtime 不改。

新 `live-07-normal` 在独立 Core、Skill Library、MCP、原生 Codex 和项目目录完成真实执行：

- Agent 的原生命令工具直接执行 `rovai --version` 和 `rovai send --public-only --body TASK_SWITCH_DONE`，
  没有指定 login、改 PATH 或使用 CLI 绝对路径；普通路径和 Run 绑定路径均为候选 `target/debug/rovai`。
- 同一个 Run `5c969f53-48f8-4c2d-bb5c-0e59a0452aca`、epoch 1 和同一 process／lease，走完关闭、开启、
  再关闭、相同值修复、自动重试五阶段；每阶段普通 Send exit 0。Task help／list 在关闭时 exit 2、开启时 exit 0。
- 最终 Run succeeded，六条 Agent 消息含精确 `TASK_SWITCH_DONE`，只有一次 start input accepted，Core 正常退出。
- 另行显式启动登录 Shell 仍可解析到日常 CLI，这是保留的用户 Shell 行为；不把修正宣称为任意 Shell 子进程的版本绑定。

私有原始证据保存在 `.local/task-capability-review/live-06-normal/`、`live-07-normal/`。
这些是功能集成验证，不占用或冒充正式 Context Gate 尝试。

### 验收前置排障

1. Core 的 `members.get/list` 对有效静态配置返回 `installed_unverified`、空 blockers，
   即使主动 Runtime 检查已成功也如此。Runner 不再把这个静态状态单独记作配置漂移；仍要求空 blockers、
   adapter／model／options／permissions 精确一致，保留已有真实 installation 检查和执行时 Host 准入。
   原来两次 campaign 的失败证据不重写。`live-07-normal` 中尚未修正 Helper 的静态 readiness 差异也保留；
   后续 `preflight-08` 对同一 Core SHA-256 返回差异 `[]`，没有重写真实 Run 的旧记录。
2. 当前模型目录的 `experimental_supported_tools` 额外声明异步提问和时钟，独立于既有 feature 开关。
   诊断 Judge 目录清空该字段后，`judge-03` 的真实 CLI 本地传输探针捕获一次请求、工具数组为空。
   这是无模型调用的能力检查，不是评分结果。之前 `judge-02` 中无效的额外配置尝试也保留，产品没有新增这些配置。
3. CLI Judge 仍为 `catalog_bound_alias`，不能提供固定 provider snapshot 证明。原 campaign 两次尝试已经用尽，
   本轮没有重置目录或更改次数上限。正式 Gate 仍是 insufficient；继续正式评分还需要合格 Judge 配置及明确的续跑预算。

### 本轮验证记录

生产组件 Electron owner 验证 Host／Thread／Task 隔离、关闭重开、失败／迟到／成功回执、
相对编辑基线与状态说明恢复；Darwin 与 Win32 键位分支在 macOS Electron 中通过，不宣称 Windows 真机验证。
TypeScript 检查、完整 pnpm test（246 文件／2729 Vitest 项；主 Node 测试组 356 通过、2 项平台跳过）通过。
Runner／Judge 定向 11 项通过；真实普通 CLI 五阶段及最终发送通过。

Desktop／Web 构建、Rust 格式检查和通用文档门禁通过。草稿 fixture 首次运行在语言切换为英文之后，
中文字段选择器因此失败；将同一 owner 调整到语言切换之前后复验通过，生产界面没有为 fixture 修改语言行为。
最终截图来自真实 TaskPanel 在隔离 Electron fixture 中的恢复状态，不冒充完整 App 或 Windows 真机证据。

Rust 使用本机 `1.98.0-aarch64-apple-darwin`、`CARGO_BUILD_JOBS=4`。完整命令为：

```bash
cargo test --workspace --features extended-tests -- --test-threads=4
```

| 运行 | 实际结果 |
| --- | --- |
| 首轮，最终 Codex 参数修正前启动 | Core 1016 通过、2 失败、8 忽略，2408.31 秒，exit 101；Cargo 在 Core 失败后停止 |
| 单项排查 | 两项 ACP owner 各复验通过；Codex 25 通过、1 项原生人工检查忽略。这些结果没有替代完整运行 |
| 固定候选 `bc53fa77f` 完整复验 | Core 1018 通过、0 失败、8 忽略，2163.03 秒；CLI 31、Host 4、Web 11 通过；workspace 合计 1064 通过、exit 0 |

首轮两项失败分别是 `acp::tests::leader_exit_reaps_inherited_pipes_and_preserves_buffered_response`
（父进程退出后子进程仍写入）和 `acp::tests::runtime_cancellation_terminates_and_releases_client_terminals`
（等待 Terminal response／cancel 回执超时）。两项均在固定候选的完整复验中通过；此前的
`runtime_probe_process::tests::successful_leader_with_stdio_holding_descendant_finishes_bounded`
也在两次完整运行中通过。没有修改 ACP 实现、超时或测试准入范围来取得这次结果；原失败仍留作未稳定复现的记录。

这次结果是完整 **extended workspace**，不是 `--all-features` 或全部原生 Runtime 人工检查；
也不替代正式 Context Gate。八项既有忽略项需要相应原生安装、配置或单独授权的 Provider。
报告与脱敏 JSON、Darwin／Win32 fixture 截图一并交付；JSON 保留真实 Run、精确普通命令、
各阶段退出码和测试日志摘要，process／lease 只导出摘要以证明连续性。私有原始数据留在本地，不进入 Git。

## 草稿提交生命周期收尾（2026-10-18）

回应 User 消息 `1a6166a4-a3d2-4968-a608-9021ab5620d7`。在 `833aad039` 上扩展既有生产组件
Electron owner，实际复现：恢复后 `pending=false`，原请求成功后编辑器仍打开、旧标题仍保留。
这确认了提交状态与输入生命周期脱节；没有重新打开已收敛的开关或通知问题。

| 场景 | 修复前 | 修复后 |
| --- | --- | --- |
| 保存未决，关闭重开、不改输入 | 按钮可再创建新命令 | 同一草稿仍显示正在保存；按钮和提交入口均阻止第二次请求 |
| 同上，随后原请求成功 | 恢复产生新对象，旧草稿残留 | 恢复不增加输入版本；清除该版本，当前编辑器同步收起 |
| 未决期间继续修改输入 | 只在重新挂载后偶然可编辑 | 输入可以继续改，原回执只结算已提交版本，不自动发送新输入 |
| 断连后结果未知，原样重试 | 再生成 commandId | 沿用该版本的精确 commandId 与请求参数，由现有 Core 幂等回执恢复 |
| 实际修改后提交，或明确拒绝后再试 | 每次调用都生成新命令 | 使用新命令，与未改动输入的未知结果重试区分 |

仅在现有 `TaskDraftStore` 保留输入版本、最近一次提交及其状态，并用 React 原生订阅让恢复后的
编辑器收到回执。创建、更新和取消共用这个局部保存入口；Host／Thread／Task 隔离和窗口内存边界
不变。没有数据库迁移、跨窗口草稿同步、自动重试队列、切换确认或新增提示词。

### 本轮验证与边界

生产 TaskPanel 的同一 Electron owner 在 Darwin、Win32 分支通过，覆盖上述时序、Host／Thread／Task
隔离、明确拒绝后的重试、卸载期间成功／失败回执、更新及取消；检查实际发送次数与精确请求参数。
这是 macOS 上带受控 transport 的生产组件验收，不是 Windows 真机或真实 Core 的重复创建实验。
隐藏验收窗口的 Win32 恢复态截图未完整绘制，原图保留但不作视觉通过证据。随后使用同一构建和
生产组件、独立 userData 的可见 Electron 窗口，只重跑 Win32 草稿 owner；断言通过且恢复态完整显示。
交付 Darwin 原图和 Win32 可见窗口复核图，后者仍是 macOS 上的分支验证，不是 Windows 真机。

`pnpm typecheck`、完整 `pnpm test`（246 文件／2729 Vitest 项，主 Node 组 356 通过、2 个既有平台
跳过）及 `pnpm build:desktop`（含 Web）通过。首轮完整前端回归发现 React 静态渲染缺少
`getServerSnapshot`，8 项失败；补上空的服务端快照后重新完整运行全绿，原日志保留。

默认 `pnpm test:rust:pr` 完整 workspace exit 0：Core 427、CLI 31、Host 4、Web 11，共 473 通过、
0 失败、1 项既有原生人工检查忽略。首次 Rust 命令因当前 Shell 未包含 Cargo 而没有启动测试，
随后使用本机既有 1.98.0 工具链重新执行，没有改系统配置。
通用文档门禁 `docs:test`（10 项）、`docs:check` 和 `docs:check:ci` 通过，CI 比较基线为
`833aad039f61934e298a296073a04922866f4e32`。

本轮原始日志和截图保存在 `.local/task-capability-review/draft-submission-20261018/`，不进入 Git。
正式 Context Gate 仍为 `insufficient`；固定快照 Judge 与正式续跑预算尚未补齐，本轮没有重新运行
真实模型、扩展 Rust 或重置原 campaign 的两次尝试。当前修复不替代这项独立质量验收。


## 主线集成（2026-10-18）

User 明确要求 PR 到 main、合并并安装本机 App。集成基线为 `80d11450b`，保留主线 MiniMax
与 Web 断线恢复。主线已占用 Migration 205 与 D50，Task 迁移顺延为 206/207（最终 schema 157），
Task 决定改为 D51；开关、通知与草稿的产品行为不变。

迁移沿用既有 owner：`current_migration_state_admission_matrix`、
`runtime_catalog_migrations_preserve_rows_and_roll_back_with_their_receipts`、
`migration_sources_converge_without_reinterpreting_migration_199` 与原 Task 升级/回滚 owner。
不新增并行测试或迁移兼容平台。正式 Context Gate 保持 `insufficient`，本机安装不等于正式发布验收。
