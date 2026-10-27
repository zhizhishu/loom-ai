---
document_type: implementation-record
version: v1.58
status: implemented
last_updated: 2026-09-13
---

# Camp 执行窗口性能

2026-09-13 恢复执行组“已完成 N 个步骤”时沿用了失败、停止等结果数量摘要；用户再次指出这些数量应去掉。
当前摘要只显示“已完成 N 个步骤”，N 仅计成功，具体结果保留在展开后的 Tool 行。分页读取不再
替换组摘要为“已载入 N 项执行记录”；计数限于当前组已读取的逻辑操作，加载范围留在更早记录入口。
本次移除 Renderer 文案覆盖及共享组摘要的终态数量后缀，并同步当前 UI 与 Run Process Detail Surface v34，不改变分页、缓存、
数据协议或 Runtime 状态。验证证据见本次 PR。

用户要求取消执行展示中的脱敏，并选择“按需分页＋相邻页预取”。本次工作基于 main 的
`afd01d1010639a99ad4862774d1d17c03e1dd19b`，使用独立 `rovai/camp-execution-loading` worktree。

## 原因与实施

初次采样的目标 Camp 包含 1,155 条活动 Run Evidence，属于持久事件数；其中正文 block 27、reasoning
block 325、393 次操作的开始/完成各 393、Core action 8、compaction 9。它们归并后是 429 个展示项，
不能将原始行数等同于可见步骤数。该样本没有旧版大量 `command.output.delta` 回归。

首屏投影约 4.44 MB，执行 Evidence 占约 96%。Canonical 关联查询逐 Evidence 扫描整轮来源数组；
Renderer 又对整轮命令与输出做重复格式化、敏感值扫描。18,743 个 DOM 节点中，关闭的工具组内部占
16,403 个，包括并未展开的文件 Diff。数据传输、全轮计算与隐藏 DOM 都有可以移出的工作。

- Open schema 7 只带业务摘要和 Evidence coverage；执行详情使用 `agentRunExecution.page`。
- 逻辑操作 cursor 合并开始/完成，最新页补充仍活动的操作；完整历史保留按需访问。
- 初始批次为一页加相邻预取，最多两页展示加一页缓存；其缓存与初始定位问题由下述后续修正替代。
- Canonical 来源一次展开索引关联，关闭工具组不挂载子行，Diff 只在单条展开后解析和读取。
- 移除执行内容的敏感值检测、正文省略和结果替换；Desktop 不生成未使用的渠道 publicResult。

## 验证边界

Rust 扩展现有 Evidence 读取 owner，覆盖原始分页与展示分页并存、起止合并、跨 Camp 拒绝、活动操作补充
及跨页 CLI 关联。前端测试覆盖有界缓存、相邻预取、翻页失败、迟到响应和展示原值。
生产 Run 组件的 Electron 夹具验证两种主题、底部与 440px Inspector、锚点保持以及按条读取命令输出和 Diff；
独立 userData，不运行 Core、SQLite、Skill Library 或 Runtime。

性能对照以只读数据库快照及生产 Renderer 重放测量，区分 Core 读取、首屏业务绘制与执行窗口绘制；
历史初次样本和当前固定样本分别记录，不能将运行期间记录数变化当作优化收益。
固定快照保留了 617 条当前活动 Run Evidence，前后都读取同一份快照。11 次 Core 读取取首轮之外的中位数：

| 指标 | 原路径 | 执行窗口路径 |
| --- | ---: | ---: |
| Camp Open | 124.01 ms | 2.35 ms |
| Open 响应 | 1,997,591 B | 183,341 B |
| 首个执行窗口 | 包含在 Open 中 | 24 项，39,140 B，8.58 ms |
| 相邻页预取 | 无独立窗口 | 7.33 ms |
| Renderer 初始 DOM | 8,565 | 1,819 |
| Renderer 预热绘制中位数 | 186.15 ms | 82.70 ms |

Renderer 使用生产 CampWorkspace、适配器与 CSS，1440×920 隔离 Electron，前后各五次切入，去除首次取中位数。
新路径的绘制时间包括首个执行窗口到达后的绘制，恰好两次窗口请求，没有初始工具结果读取。
这不是已安装 App 的端到端切换时延；Core 与 Renderer 分开测量，机器其他负载会影响帧时间。
初次 1,155 行样本与固定 617 行样本属于不同采样时刻，不能直接跨样本计算提升。

本机诊断记录位于 `/tmp/rovai-camp-diag-20260912`，原始内容仅留在本机私有目录，不纳入仓库。
严格 Clippy、桌面构建和 diff-aware 文档门禁已通过；Rust 基础 553 项、CLI 35 项、数据库集成 309 项已验证，
staged 路由的 workspace 验证另覆盖 Core Main 237 项（6 项既有忽略）。合并主线前 `VITEST_MAX_WORKERS=1 pnpm test` 已通过：176 个 Vitest 文件、1,802 项测试；脚本测试 317 项通过、2 项既有平台跳过。
默认并行执行曾触发已有 Supervisor/Evaluation 测试的短时轮询超时；单独复跑 35 项通过，随后完整单 worker 门禁通过，未修改这些既有测试。
最终 Electron 的正文 Blob 重试和执行窗口两项均通过；窗口测试包括屏幕外延迟读取、键盘焦点、跨组边界保留已展开结果、
不重复读取保留结果，以及 Day/Night 两个真实主题。Impeccable detector 执行一次，38 项均为既有 CSS 提示，新增样式行没有命中。

合并主线 `f30024ae76bdeb3534e10a56d0da6a6a8bd56e13` 后再次通过类型检查、严格 Clippy、桌面构建、文档门禁与完整 `pnpm test`：175 个 Vitest 文件、1,794 项测试及 317 项脚本测试。测试数量变化来自主线待发送消息功能的既有测试收口。三项 Electron 验收同时覆盖执行窗口、正文 Blob 和主线待发送消息退回输入框；两个 Rust 退回输入框 owner 与执行分页 owner 定向复跑通过。

## 权威与影响

[Camp Open v19](../../contracts/camp-open-projection-v19.md)、[Run Process v34](../../contracts/run-process-detail-surface-v34.md)、
[Camp Open Architecture](../../architecture/camp-open-read-path.md)、会话 UI 和 CURRENT 同步更新。
无需数据库迁移、历史数据清理、模型上下文变化、Runtime classifier 变化或版本指针变更。
旧数据曾被省略的字段不会反推；展示字段白名单、大小预算和 Built-in 输入用途继续保留。

## 缓存与初始定位修正

用户确认会话区的更早记录样式，并指出向下恢复已读内容不应要求“加载较新记录”。本次基于 main
`cc91ec0d10d3ccfe10d77ccebfeadebea7e64fd1`，使用 `codex/execution-history-cache` 隔离分支。

初始跟随标记在 IntersectionObserver 开始异步请求前被清除，分页到达后父级原始 Evidence 数量没有变化，
导致滚动停在顶部。原缓存又跟着两页展示窗口裁剪，返回已读页必须再次请求。回归先证明两个失败：旧实现
在离线返回已读页时失败；真实 CampWorkspace 的延迟页面／正文场景中，底部 `scrollTop = 0`、距底部 202px。

- 页面缓存采用按 cursor 的 LRU，最新页固定保留；历史阅读保留旧链头，后台只更新最新缓存。回到最新采用
  缓存并重建 cursor 链，不混合不同边界；向下滚动恢复已读页，淘汰后的缺页才自动请求。
- DOM 仍只挂载两页。页面 12 页／8 MiB、正文 64 条／8 MiB 的目标预算独立于 DOM，必需内容的预算例外
  由 [Camp Open v18](../../contracts/camp-open-projection-v18.md) 拥有，不声称精确 heap 上限。
- 初始跟随等待页面成功到达，完整正文后续填入时继续跟随；历史翻页保留锚点。
- 更早入口直接复用会话区的文字箭头、计数、spinner 与错误状态；删除较新记录按钮，保留回到最新跳转。

缓存与在途刷新由现有 `execution-window.test.ts` owner 验证；真实滚动由现有 CampOpen Electron fixture
扩展，纯函数或静态渲染不能证明滚动位置。两种位置各重复三次用于覆盖异步首屏／焦点调度，另验证正文缓存、
离线向下恢复、键盘焦点、展开组和 Diff。仅使用合成数据和独立 userData，不启动 Core、Skill Library 或 Runtime。
本机验收不能替代用户另一台 Windows 的真机结果；本次不启动或更新日常安装版。

本地门禁通过：`pnpm typecheck`、`pnpm build:desktop`、`VITEST_MAX_WORKERS=1 pnpm test`
（181 个 Vitest 文件、1,920 项测试；脚本 317 项通过、2 项既有平台跳过），以及固定基线的
`pnpm docs:check:ci`。CampOpen 的其余六个 Electron 场景通过；执行场景补正连续向下滚动的夹具操作后重跑通过，
底部三次距底部均为 0px，Inspector 三次也均为 0px。两种主题下离线返回已读页均没有增加分页请求，
展开结果后的夹具 DOM 为 428 个节点；这个合成夹具节点数不作为真实 Camp 性能收益。


## 连续阅读与跨 Camp 缓存修正

前次修正保留了刷新后只显示最新一页的规则，导致第 13 条到来时第 1 条消失。基于 main
`49b7b623` 的回归先确认该失败，再替换为连续区间和实测高度虚拟列表。当前规范由
[Camp Open v19](../../contracts/camp-open-projection-v19.md) 与
[Run Process Detail Surface v34](../../contracts/run-process-detail-surface-v34.md) 拥有，上述两页窗口规则不再适用。

- 首屏继续按视口读取 12–48 项，历史批次 64 项，只预取一页；新记录追加不改变历史边界。
- 展示增量按原始变化水位读取，旧 command 完成仍更新原位置；原地完成的正文刷新使用展示页返回的
  Evidence ID，不能使用带 delta offset 的传输帧 ID。
- 展示与完整正文缓存跨 Run 组件卸载保留，并复用在途正文读取；缓存的展示模型复用，切回不重复归约全部历史。
- 原生滚动空间由实测高度占位维持，组内长列表同样虚拟化；翻页锚点保持到测量完成，程序滚动补偿不触发历史加载。
- 单 Run 展示、正文与 Renderer session 各自有预算；缓存内回看没有加载按钮，淘汰后才按需恢复。

现有 Rust 分页和正文 owner 扩展了增量、向前范围、同一正文行原地完成及错误目标/水位输入，未新增独立 SQLite
fixture。Renderer 状态 owner 将原两页替换断言更新为连续保留、较大历史批次、离线回看、淘汰后恢复和跨组件缓存。
真实 Electron 在底部和 Inspector 各验证异步初始定位、连续新增 513 条、首部不消失、历史页请求不增加，
切走后重新挂载不请求执行页，以及键盘分页锚点、正文复用、Diff 和工具结果展开。

固定 Camp 回放仅使用既有诊断副本，不启动 Core 或真实 Runtime，不读取或写入日常数据库。
性能数字只代表本机 Renderer 的固定数据回放，不能替代 Windows 真机结果；原始执行数据与截图不进入仓库。

基线 `49b7b623` 与本次实现使用相同固定投影、生产 CampWorkspace 和 CSS，在 1440×920 隔离 Electron 中
各回放 8 次 A→B→A；先访问历史，再切回同一 Run。执行分页 stub 立即返回，不包含真实 IPC、Core 或 Blob 延迟：

| 指标 | 基线 | 连续缓存 |
| --- | ---: | ---: |
| 每次切回的执行分页请求 | 2 | 0 |
| 执行内容绘制中位数 | 66.75 ms | 65.55 ms |
| 8 次绘制范围 | 62.9–74.4 ms | 56.8–78.4 ms |
| 切回后 DOM | 1,823 | 1,778–1,862 |

本机绘制时间基本持平；此结果证明缓存回看消除了重复分页读取，并在保留历史时维持有限 DOM，
不将帧调度波动解释为性能百分比收益。前文 18,743 个节点与最初优化数据不作为这次修正的前后对照。

本地门禁：189 个 Vitest 文件、1,958 项测试及 317 项脚本测试通过（2 项既有平台跳过）；Rust staged
workspace 默认门禁 834 项通过（6 项既有忽略），慢速集成 310 项通过。严格 Clippy、类型检查、桌面构建、
文档 diff-aware 门禁与 7 个 CampOpen Electron 场景通过；执行窗口场景在最终虚拟范围调整后再次验证。

## Command 与 Compact 交互细化（2026-09-14）

在 `rovai/agentrun-command-interaction` worktree 中接入本地执行台及 Inspector。收起的活动摘要使用同一条
操作的文字与类型图标；文字按 2.4 秒周期依次高亮，展开后及静态状态停用，思考／连接提示复用同一效果。
command／Compact 保留最右端唯一状态 icon，展开提示跟随文字且不挤动布局，详情移除旧 52px 右侧预留。
触摸、键盘、窄视口和减少动态效果均沿用当前 UI 合同；文件预览、真实计数、独立 Compact 与结果读取语义不变。

点击锚点由生产 Drawer 的滚动容器维护，与窗口最新跟随及实测高度虚拟列表协调。加载、错误、重试和收起
保留 summary 的屏幕位置；必要的末尾阅读空间允许收起，内容较少的底部外壳保留点击时高度，用户滚动立即释放锚点。
这是 Renderer 交互增量，不改变 Core、Runtime classifier、模型上下文、wire、数据库或版本指针。
当前 Contract 与会话 UI 已同步；不新增决策或扩展现有文档检查例外。

本机隔离 Electron 使用生产 CampWorkspace、分页与虚拟列表，在底部 Day 及窄 Inspector Night 验证：

- command／Compact 展开、加载、结果到达、Compact 失败重试及收起的纵向偏移均小于 2px；
- 详情分别为 829/831px、361/363px，仅保留原 2px 左外边距；
- 键盘展开、可见焦点、缓存重开、文件预览不触发展开、用户滚动优先于迟到结果、背景追加不抢阅读位置；
- 2.4 秒高亮、展开后子行静态、减少动态效果、触摸常显提示与 44px 点击区，以及窄视口位置切换文字；
- 原执行窗口与回到最新回归通过：历史、分页、完整结果缓存及首次异步最新跟随仍成立。

场景使用受控数据，不启动 Core 或真实 Runtime；自动检查不替代用户对开发包的手动验收。开发包保留在本次
worktree，后续修改继续复用该分支和目录。
