---
document_type: implementation-plan
version: v1.72
authority: implementation-status
last_updated: 2026-10-27
---

# Hermes 首次输入规则实施与验证

当前实现为 [已确认 R2](model-context-change-hermes-first-input.md) 与 [D67](decisions.md#v1-72-d67)。
下面 R1 与私有 Home 的原始验收是历史记录，其 Hook、恢复 CLI 和树回收保证不适用于原生共享 Gateway。
原生接入与后续减量结果分别在“原生会话定位”和“接入减量”节记录，旧证据不改写。

## 清理前主线集成（2026-10-27）

按 User 在清理会话中的明确指令合入 PR #878 后移除 worktree。同步主线 `67780b44a` 时，
保留已发布的 Automation 命名 Migration 215 / schema 165，Hermes catalog 与规则证据迁移
分别顺延到 216 / schema 166、217 / schema 167。迁移按主线原顺序执行，既有 downgrade 与
回滚、数据保留和重开 owner 一并对齐；没有为未上线实验数据库增加兼容路径。
此前原生模型与压缩探针的历史结果仍绑定各自原提交，不冒充此次集成的复测。

集成验证：默认 Rust workspace **481 passed / 1 existing ignored / 0 failed**；
`extended-tests` 下的迁移状态矩阵、catalog receipt 回滚与数据保留、当前/未来数据库准入三个
既有 owner 均通过。类型检查、生产 workspace check、Rust 格式、Desktop 构建、
Vitest **3009 passed / 2 skipped**、Node 主集 **358 passed / 2 skipped**，以及十项文档测试、
当前与基于 `67780b44a` 的 diff-aware 文档门禁通过。首次定向矩阵命令未启用 feature，
实际选择零项；已按 owner 配置重跑并确认执行一项，不将零项运行计为验证证据。

## 原生观测接通尝试（2026-10-25）

User sequence 100 要求保持现有接入方式，尝试补齐压缩事件与本 Run 消耗。
在生产 `376f3c22e` 上扩展现有原生 smoke：15 个受控 Run、两次自动压缩及一次明确订阅后的
原生手动压缩。计数跨轮累计/Agent 重建重置、失败前已知 usage 在 ACP 错误响应中缺失，以及
无实时压缩通知均已复现。[详细结果与证据](../../research/hermes-runtime/README.md#原生-acp-观测验证2026-10-25)。
这次交付为可复现探针和能力边界修正；两项尚未端到端接通，没有生产协议/数据库/UI 改动。
没有重跑付费模型；既有上下文 gauge、原会话恢复、公开 Send 与 B/P 策略保持原样。
观测提交 `e6ba868b6` 后同步主线 `c99db24da` 的 Command Linux Preview，保留其平台项和 D61；
Hermes 尚未合入的决定顺延为 D62–D67，更新引用与兼容性登记摘要，不改变 Hermes 的平台范围或传输。

## 原生会话定位（2026-10-25）

按 User sequence 56/58/60 实施 [D67](decisions.md#v1-72-d67)。正式入口直接运行用户安装的
`hermes --profile default acp`，使用当前用户 `~/.hermes`。删除私有 Python 启动器、Home/config
副本、专用 Gateway、Hook、压缩补发和私有 steer/recovery 控制路径；不为未上线实验做迁移或回退。
其他 Runtime 的输入、CLI context 运输和清理保持不变，历史数据库字段与冻结正文保留。

CLI 从本机原生工具环境读取 `HERMES_SESSION_PLATFORM=local` 与逻辑 `HERMES_SESSION_CHAT_ID`，
一次业务请求直达 Core。Core 用已有 Conversation、当前 running Run/epoch、Binding/generation 与
ActiveLease 固定身份，再汇入现有 Router/领域校验/发送回执。没有新增表、映射文件、模型参数、
上下文获取握手或来源证明；旧后台执行在下一轮首次调用即属于下一轮，是 User 明确选择的语义。
无活动或未知 Session 返回既有 `builtin_tool.run_not_bound` 业务错误；已派发但响应丢失不重试到后继 Run。

固定 CLI 入口为 `~/.local/bin/rovai`；已有不同目标不覆盖。实例级 `connection.json` 只含 Core 地址，
不是会话映射或凭据文件。生产和探测使用 `RuntimeConnection` 只回收 ACP 根进程；共享 Gateway 由原生管理。
MCP 随 new/resume 参数提供，同名策略不再宣称 `rovai_wins`，空列表不冒充已撤销。

[隔离原生证据](../../research/hermes-runtime/native-session-acceptance-2026-10-25.json)使用生产 Core/CLI、
未补丁官方 0.22.4（`4d04303818b61bf3aa09278af48356315515965b`）、同一测试用户 Home 和预先运行的 Gateway。
Provider 为 loopback Responses，不使用付费模型或日常用户数据。最终二进制的 `VmUwPI` 共 12 个 Run：10 succeeded、
1 主动 cancelled、1 Core 强杀后 failed；后两项是故障场景的预期结果。

| 场景 | 实际结果 |
| --- | --- |
| 两成员并发普通终端 Send | 成员/Thread/Run 归属准确，工具环境没有 `ROVAI_CLI_CONTEXT`；Gateway 原 PATH 不含后来安装的 `.local/bin` |
| 同 Session 续轮与旧后台调用 | 原 Session 不变；A0 后台首次调用发生在 A1，回执精确属于 A1 |
| Core 正常重启、规则真实变化 | 原 Session 恢复，只有更新轮携带更新块；实际模型请求与投递证据一致 |
| 两次自动压缩 | 合成 usage 触发两次已提交原生摘要；无 Hook/补发需求，下一普通输入只有 P |
| 部分 MCP 失败与冷恢复 | 坏服务原生日志告警，成功服务真实调用可用；Core 冷恢复与测试主动重启 Gateway 后，同 Session MCP 重新可用 |
| 取消与强杀 | 取消 A 不影响 B；Core SIGKILL 不杀 Gateway，不重放 B2、不重复 Send，B4 继续原 Session |
| 原生配置 | config/.env 哈希不变，手写 system prompt 出现在真实模型请求中；未改上游源码 |

压缩使用窗口 65536、`protect_first_n=0`、`protect_last_n=2`、合成 input usage 60000；依据原生日志
`commit_status=committed` 与实际请求核对，不按辅助请求总数或物理 Session 是否旋转猜测压缩。
不承诺规则永久保留、取消回滚工具外部效果、共享 Home 的成员长期记忆隔离或即时 MCP 清空。
未验收 execute_code、子智能体、远程/容器终端、其他平台、付费模型质量和日常 App 安装。

迁移过程中实际发现并修复了两处仍调用已删恢复 envelope 的预算预留，以及无活动 Session 错误被 CLI
压成通用 IPC 错误的问题。测试自身还修正了提交后误取上一取消 Run、非模型请求缺 input 和 macOS
夹具路径 canonicalization；失败尝试独立记录，不算通过。

复现入口：`node scripts/smoke-hermes-native-session.mjs <official-source> <prepared-python>`。
旧私有 Home smoke/Python controller fixtures 随生产职责退役，历史结果和 Git 保留；没有删除迁移读取测试。

### 本轮回归

最终 `cargo test --workspace -- --test-threads=1` 为 **477 passed / 0 failed / 1 ignored**，包含 CLI 31 项。
Hermes slow/extended 3 项、ACP 相关筛选 77 项（另 2 个指定真实环境的用例 ignored）、Adapter 目录 25 项通过；
这些筛选与 workspace 存在重叠，不累加为独立覆盖数量。CLI 响应丢失仅派发一次，旧 context 来源的原重试测试保留。
Desktop User Automation 10 项、qualification helper/isolation 8 项、文档单测 10 项通过；
`cargo build -p rovai-core --bins`、`cargo check --workspace`、fmt、TypeScript、脚本语法、whitespace、
当前和 diff-aware 文档门禁通过。

并发 workspace 首先暴露已修复的 Skills 夹具规范化遗漏；修正后两次并发全量均在既有 Cursor alias
探测的 2 秒预算处超时（430 passed / 1 failed / 1 ignored）。该项单独复核为 0.14 秒通过，最终串行
完整 workspace 通过；未修改 Cursor 实现、超时或断言，也未跳过失败项。兼容性文档变更后的既有证据摘要
按实际文件更新，保持原 checksum 断言。当前路径未安装到日常 App，macOS arm64 仍为 Preview。

## 接入减量（2026-10-25）

按 User sequence 64/66/68/70 继续在 `rovai/hermes-runtime` 上实施；不新开旧 Hermes 兼容路线。

- `BuiltinToolProcessConfig` 使用可选的文件输出。Hermes 保留同一 ActiveLease 注册表和 `run-tmp`，
  无 `context.json` 创建、绑定写入、Task 投影/重试或撤权写入；普通绑定也跳过专供文件输出的 Task 查询。
  其他 Runtime 的文件投影、失败修复、锁顺序、撤权及回执原义保持。
- 复用 Command Code 分支现有的 `HostReusePolicy::NativeBinding` 与 nullable 摘要字段；Hermes 的
  Host/Binding/runtime 配置摘要为 `None`，不计算、不比较，也不保存伪造常量或实现 revision 摘要。
  实际配置与 Run 冻结审计摘要、B 内容摘要继续保留；其他 Runtime 仍生成原来的摘要值。
- 固定 CLI 链接由 macOS 安装版 App 初始化提供。已有文件/陌生目标保留，开发和隔离 App 不触碰日常
  入口。同路径 App 更新自然更新链接目标内容；每 Run 不再创建或核对。隔离 smoke 先准备测试用户入口。
- 当前规则选择只读已接受 `initial` / `update`，删除旧 system 输入转 update 的实验接续查询。
  已有 frozen/历史读取及数据库迁移保持；旧 `compaction_recovery` 不影响新输入的规则基线。
- 更正活动目录：当前无 Hermes 结构化 Diff 生成；MCP 自定义 cwd 尚未传递；可靠逐 Run usage/费用
  缺失时仍为未知。本轮不为补齐显示重建控制器或增强观测通道。

### 验证归属

没有增加或删除独立 Rust 测试。扩展既有 lease registry owner，验证无文件输出时初次绑定、轮换、
定向/全局 Task 刷新、解绑、全局撤权及注销均不接触被目录占用的 `context.json` 路径，同时保留临时目录
和旧授权失效。修复前该路径会在 bind 时写入失败；无需完整 DB 夹具即可覆盖这个文件/注册表边界。
既有 Fleet Session owner 同时覆盖 Native Binding 与摘要策略的成员、Thread、Binding 和 cwd 隔离。
既有 Adapter/ACP owner 覆盖摘要省略；共享 Core Task 设置 owner 保留全局刷新、同值修复和失败重试。

上下文 owner 保留 prepared/unknown、冻结正文、首次/更新/none、旧 pending 不消费；删除旧 system 实验
接续的两轮断言，加入旧 recovery 记录不参与新基线的断言。未删除历史读取或 Migration owner。
安装入口的两个 Vitest 用临时 Home 验证首次/重复初始化、同路径更新和用户文件/陌生链接冲突。
现有原生 smoke 增加在实际模型请求时无文件投影、Run 三类兼容性摘要为 NULL 的断言。

### 实际结果

[本轮原生验收记录](../../research/hermes-runtime/reduction-acceptance-2026-10-25.json)对应隔离夹具
`MJWMOO`：生产 Core/CLI、未修改官方 0.22.4、同一测试用户 Home、预先启动的共享 Gateway 与本地
Responses 端点。12 个 Run 中 10 succeeded、1 主动 cancelled、1 Core 强杀后 failed，后两项符合故障
场景预期。两成员并发、原 Session 冷恢复、普通 CLI Send、后台调用按调用时归属、MCP 部分失败及
Gateway 重启后恢复、两次自动压缩不补发、取消不影响另一成员、Core 强杀不重放均通过。
实际模型调用期间无 Hermes `context.json`；成功 Run 的 Host/Binding/runtime 兼容性摘要均为 NULL。
首次与真实规则更新仍正确，用户配置未改写，原生 system prompt 保留。

减量提交 `d8d14eeb7` 的 `cargo test --workspace -- --test-threads=1` 为 **477 passed / 0 failed / 1 ignored**，包含 CLI 31 项。
Hermes slow/extended 筛选 3 项通过；共享 Task 设置、ACP 配置摘要、Fleet Native Binding、冻结配置与
Cursor 身份探测 5 个指定 owner 通过。这些用例和默认 workspace 有重叠，不累加为独立覆盖数量。
`pnpm test` 最终通过：Vitest 257 个文件、2994 passed / 2 skipped，Node 组合 358 passed / 2 skipped，
另含文档 10、Skills 3 和 Electron sandbox admission 7 项。`pnpm typecheck`、Core/CLI 构建、
`pnpm build:desktop`、fmt、脚本语法和 whitespace 检查通过。

回归先发现 benchmark protocol 仍期待 schema 164，已对齐分支此前已有的 165；本轮未新增迁移。
一次完整 Rust 回归在既有 Cursor 的 2 秒版本探测处超时，该 owner 单独复核 0.77 秒通过；未改其
预算、实现或断言。一次 Vitest 文件监听用例在等待更新时超时，随后完整 `pnpm test` 通过；未改该
owner。最终完整 workspace 通过；当前与 diff-aware 文档门禁通过。

未执行日常 App 安装、付费模型、Windows/Linux、execute_code、子智能体或远程/容器后端验收。
安装行为依据临时 Home 的 helper 测试和桌面构建，不将其表述为已完成用户日常安装。

### 同步 Command Code 主分支

推送后主分支已合入 `1028095f6`（PR #890）。在 Hermes 分支合并该提交，统一两边的 nullable 摘要和
Native Binding 策略，保留 Command 的控制通道 Bootstrap 与冷启动准备、Hermes 的 FirstPayload 和
原生 Session CLI。保留两边的 Skills、恢复与接受账本用例；Command/Hermes 的项目 Skills 夹具使用
不同测试项目，避免相互添加测试 Skill。未增加生产兼容分支、协议或数据库迁移。

当时主分支已占用 D59，Hermes 决策曾顺延；本轮同步主线新增的 Command D60 后，Hermes 使用 D61–D66，当前选择为 D66。
合并后的兼容性登记正文摘要按实际文件更新，不删除原有摘要一致性检查。

合并后的官方原生复跑 `TPM8dy` 再次通过全部 12 个 Run 场景（10 succeeded / 1 cancelled / 1 failed），
结果追加在同一[减量证据](../../research/hermes-runtime/reduction-acceptance-2026-10-25.json)的
`afterMainMerge`，保留先前 `MJWMOO` 原记录。共享 ACP 筛选 **69 passed / 2 ignored**，Hermes、Task
设置、Skills、冻结配置、Binding 提交与 Fleet 定向 **8 passed**；计数与默认层重叠，不相加。
一个错误模块路径的筛选返回 0 tests，已用 `--list` 定位并重跑真实 owner，0 tests 不计入通过数。
合并后的 `pnpm test`、typecheck、Desktop 与 Core/CLI 构建、包含 slow-tests 的 workspace tests 编译通过。
最终合并树的 `cargo test --workspace -- --test-threads=1` 为 **479 passed / 0 failed / 1 ignored**；
Cursor 身份探测本次在全量内正常通过。fmt、whitespace、当前与 diff-aware 文档门禁通过。

## 删除实验快照识别与重复 MCP 比较（2026-10-25）

按 User sequence 79 的前两项继续减量：删除 Hermes 旧实验能力标记识别，以及发现提交、Ready
校验和静态能力复用中的专属降级/失效分支。安装发现仍按现有可执行文件、入口与指纹事实更新，
普通能力缓存和实际 ACP 连接检查保留；没有换用旧版本黑名单或新增迁移版本号。

Hermes 沿用 Command Code 的显式 Native Binding 分支，同一 Run 的 Runtime 不再保存或比较
`mcp_projection_digest`。MCP 的实际 new/resume 参数、共享冻结投影校验和原生错误传播保持不变；
这不放宽 Hermes 原生对已有会话 MCP 规格的限制。其他 Runtime 的摘要比较保持原义。

没有新增或删除独立 Rust 测试；在原有 Adapter owner 中删除旧实验拒绝断言，保留当前能力生成
断言。模型目录准入和相同模型/模式设置的优化本轮仅核对源码，没有改变生产行为。

`cargo test --workspace -- --test-threads=1` 最终 **479 passed / 0 failed / 1 ignored**。
首轮在既有 Cursor alias 版本探测的 2 秒预算处超时（432 passed / 1 failed / 1 ignored）；该 owner
单独复核 0.09 秒通过，完整复跑也正常通过。未改变 Cursor 实现、预算或断言。
Hermes、能力生成、安装发现、Binding 与 ACP 相关定向 **7 passed**，与默认层重叠，不累加计数。
文档单测 10 项、fmt、whitespace、当前和 diff-aware 文档门禁通过。本轮未重跑真实 Hermes/模型，
未启动日常 App；上述隔离原生验收仍保留为各自提交的历史证据。

## 原生选模与固定 Skills 目录（2026-10-25）

User sequence 81 确认将上述模型评估落实，sequence 82 同时收敛 Skills 文件发现。

- Hermes 探测不再要求当前模型存在于菜单。Ready 快照在目录缺失/损坏时保留空模型列表，正常
  Session 与默认执行继续可用；显式完整 ID 直接交给 `session/set_model`，原生拒绝不回退默认。
  通用模型选项仍不支持，不向只返回空 ACK 的配置接口发送这类选项。其他 Runtime 的准入保持。
- 只按本次 new/resume 返回的完整模型 ID、`currentModeId` 精确比较；相同则省略对应设置，
  不同或缺失则正常设置。没有 Provider 归一化、额外查询、跨轮缓存或 warm 改动。
- 删除 `hermes_skill_roots` 及其配置解析/过滤。用户级 `.hermes/skills`、`.agents/skills` 与当前
  项目根下同名目录使用公共扫描器；不要求 Git/信任，不找祖先，不枚举历史项目。保留同文件
  去重、同名不同来源、部分失败、缓存、预览和精确文件引用。自定义外部/创建目录不自动列入。
- Skills 页面仅替换 Hermes 的现有页首说明，明确文件发现不代表原生启用/加载；原生配置和
  加载行为不改写。没有新表、来源状态、服务、配置同步或自动加入模型输入。

### 验证归属

不增加独立 Rust 测试。原 live Session owner 更名为
`acp::tests::real_acp_session_model_selection_respects_native_adapter_boundaries`，保留 TRAE 的目录拒绝
与原生设置失败输入，新增受控 ACP 进程的新建/冷恢复表驱动场景：默认无目录、相同值不设置、
目录外模型、同模型名不同 Provider、未知状态、原生模型/模式拒绝。核对完整请求顺序及后续 prompt
的模型，失败无 prompt、无默认回退、无新 Session。仅测比较谓词不能证明真实 RPC 是否发出。

原 Grok/Kiro probe owner 更名为
`health::tests::acp_checks_keep_native_model_catalog_boundaries_without_lifecycle_rehearsals`，保留原有
四种输入，并追加 Hermes 的目录/当前模型缺失、不完整、损坏和原生会话拒绝；仍要求正常协议能力。
首轮新夹具遗漏 `loadSession` 后正确被拒，补齐官方能力广告，没有放宽生产能力要求。
Adapter owner 验证空菜单不合成模型、部分菜单保留和无 Session 仍失败；Skills owner 验证四目录、
非 Git 项目、不向上扫描、外部目录不加入、配置禁用/无效 YAML 不参与过滤且源配置不变。

### 本轮检查结果

- 上述 ACP、Adapter、probe、Skills 与 Hermes 规则/入口定向测试共 **12 passed**；Skills 配置输入
  补强为确实存在的外部目录后，原 owner 再次 **1 passed**，不重复累计。
- `cargo test --workspace -- --test-threads=1`：**479 passed / 0 failed / 1 ignored**。
  定向 owner 与默认集有重叠，不将二者相加。当前改动下默认集一次通过。
- 现有模型参数、Skills 选择与文件引用前端回归 **46 passed**；`pnpm typecheck` 与
  `pnpm build:desktop` 通过。没有启动 App，构建不代替界面人工验收。
- 文档单测 **10 passed**，fmt、whitespace、当前及 diff-aware 文档门禁通过。

本轮使用受控 ACP 进程和隔离文件 fixture；未新增真实官方 Hermes/付费模型流程、原生压缩或平台矩阵。
用户日常 Hermes 配置与 App 未修改。此前隔离原生验收只保留为各自提交的历史证据。

## 原生接入的真实模型验收（2026-10-25）

User sequence 84 明确要求真实模型。生产 Core/CLI 构建于 `37f017b68`，官方 Hermes 0.22.4 源码
`4d04303818b61bf3aa09278af48356315515965b` 不打补丁。复用原生会话 smoke 的显式真实模型分支，
在一次性用户 Home、独立 Core data、Skill Library、MCP 配置和非 Git 项目运行；先启动测试用户的
共享 Gateway，再启动 Core。日常 Gateway 和 App 不参与。

沿当前配置使用 Sub2API Responses 服务，测试 relay 只转发真实请求/响应；凭据不落盘、不写日志。
测试用 ACP stdio observer 原样转发字节，只记录方法、Session 和模型/模式元数据，帮助区分真正省略
设置与空 ACK；没有生产控制器、Hook、插件或模型可见的 CLI 包装路径。该 observer 会增加一个测试
进程，因此本轮不用于测量生产进程数或启动性能。

### 首轮发现与边界

`rovai-hermes-real-model-RRSFv4` 中 A0、B0、A1 三个真实 Run 均成功并完成文件操作和公开 Send，
但 A1 的“零设置 RPC”断言失败：new 返回 `custom:sub2api:gpt-6.1-sol`，首次生成后 resume 返回
`custom:gpt-6.1-sol`。完整 ID 不相同，生产代码按当时的合同发送 `session/set_model`，行为正确。
不能据此承诺相同底层模型总能省略设置；没有通过去 Provider 前缀或别名归一化修复这条断言。
后续 fixture 按实际观察到的完整原生值选择当前行，命名 Provider 仍用完整命名路由切换不同模型。
这是测试前提校正，没有修改生产比较逻辑，也没有重放原 Session 的旧输入。

### 最终一组结果

`rovai-hermes-real-model-BhSkZF`：**5 Run succeeded**，真实 `gpt-6.1-sol` / `gpt-5.6-sol`。
18 次主任务模型请求均 HTTP 200 且收到 completed，响应模型与请求模型一致；另有 2 次原生辅助请求。
这不是 Core 本轮费用或 Usage 完整入账的证据。结构化摘要见
[真实模型验收记录](../../research/hermes-runtime/real-model-acceptance-2026-10-25.json)。

| 场景 | 结果 |
| --- | --- |
| A0/B0 两成员并发 | 真实 read_file/write_file/terminal，独立原生 Session，公开 Send 精确归入各自 Run |
| A0 显式选择项目共享 Skill | 菜单四目录与预览成立；原生项目发现关闭且该 Skill 禁用，仍按精确文件引用读到验证内容并实际使用 |
| Core 重启后的 A1 | 原 Session ID 不变；显式选择原生完整当前 ID，模型/模式设置 RPC 均为 0；只发 P |
| A2 目录外模型与模式变化 | 发送完整命名路由的 set_model 和 set_mode 各一次；真实请求及响应均为 gpt-5.6-sol，无默认回退 |
| A3 同模型同模式续轮 | 原 Session 继续，两个设置 RPC 均为 0；只发 P |
| 结束与配置 | 5 个 Run 各一条精确公开 Send，无重复；Core 退出后测试共享 Gateway 仍存活，最后由 fixture 清理；配置摘要不变 |

真实分支退出 0；另以只读数据库复核唯一 Send，并把该断言加入可复现脚本。Node 语法检查与
whitespace 通过，文档单测 **10 passed**，当前及 diff-aware 文档门禁通过。生产 Rust/Renderer 未再修改，沿用上一节在同一生产提交上
的全工作区与定向回归，不重复计数。本轮没有新增真实模型压缩、取消、MCP、图片或平台矩阵。

### 环境准备记录

在正式隔离启动前，检查已有解释器时误在日常 Home 导入官方 bootstrap，触发一次原生依赖准备；
该次检查最终仍报 `ModuleNotFoundError: yaml`。没有启动日常会话或 Gateway。源码工作区保持干净，
`config.yaml`、`.env`、`install-stamp.json` 的修改时间仍分别为 10 月 23/23/22 日；依赖准备造成的
安装缓存变化没有逐文件审计，不能声称本轮完全未触碰日常安装。后续所有启动使用隔离 Home 和源码
副本；测试说明已明确依赖探针也必须隔离。日常配置在真实验收前后按字节摘要核对。

## custom Provider 模型比较（2026-10-25）

User sequence 92 将上节的完整 ID 比较收窄为局部字符串兼容。仅 Hermes 使用
`hermes::model_selection_matches`：完整相同直接跳过，裸模型选择只比完整模型名；明确 Provider
不同仍设置。兼容 `custom:<name>:<model>` 与 `custom:<model>`，不做任意后缀、大小写或
别名匹配。真正设置时仍传用户原始完整 ID，默认模型、模式设置和其他 Adapter 保持原义。
没有新增状态、数据库字段、缓存、查询或上游改动。上节旧测试假设与实际失败记录保留原义。

新增纯函数 owner `hermes::tests::model_selection_matches_native_provider_forms_without_suffix_matching`，
覆盖五个指定例子以及不同 Provider、不同模型、命名空间、后缀、大小写和未知状态。原有入口/Session
测试不拥有模型比较；新 owner 以无 I/O 的表驱动测试承担这个已复现兼容回归，避免为每个输入启动进程。
既有 `acp::tests::real_acp_session_model_selection_respects_native_adapter_boundaries` 只扩展两组
seam：new/resume 的 custom 简写零设置，以及真实模型变化时原样传完整 ID；原拒绝路径仍保留。

最小命令：

```sh
cargo test -p rovai-core --lib hermes::tests::model_selection_matches_native_provider_forms_without_suffix_matching -- --exact
cargo test -p rovai-core --features slow-tests,extended-tests --lib acp::tests::real_acp_session_model_selection_respects_native_adapter_boundaries -- --exact
```

现有真实 smoke 保留原始命名 Provider 选择，在 Core 重启、原 Session resume 后断言无重复设置；
改变模型时断言完整选择进入设置请求，下一轮继续同 Session 再次零设置。无需新的验收框架。

### 真实恢复结果

生产 `34dd2e2f9`、官方未修改 0.22.4，隔离夹具 `rovai-hermes-real-model-WDyVxp` **5 Run succeeded**。
17 次主任务请求和 2 次原生辅助请求经过真实 Sub2API；主任务均 HTTP 200/completed，响应模型与
请求一致。证据见 [custom 模型 ID 兼容验收](../../research/hermes-runtime/model-id-compatibility-2026-10-25.json)。

| 轮次 | 原选择与原生返回 | 实际结果 |
| --- | --- | --- |
| A0/B0 | 原生默认 `gpt-6.1-sol` | 两成员、不同原生 Session、文件工具及各一条公开 Send 正常；首次规则 |
| A1 Core 重启后 | 选择 `custom:sub2api:gpt-6.1-sol`，返回 `custom:gpt-6.1-sol` | 原 A Session；零模型/模式设置，实际仍使用 gpt-6.1-sol；不重复规则 |
| A2 真正换模型 | 选择 `custom:sub2api:gpt-5.6-sol`，返回仍为旧模型 | 完整原选择进入一次 set_model；实际请求/响应均为 gpt-5.6-sol，模式变更另一次 set_mode |
| A3 不再改选 | 仍选择完整 `custom:sub2api:gpt-5.6-sol`，返回 `custom:gpt-5.6-sol` | 原 A Session；零模型/模式设置，继续 gpt-5.6-sol；不重复规则 |

五个 Run 均有且只有一条精确 Send，归属和落盘文件正确。测试共享 Gateway 在 Core 退出后仍存活，
最终由夹具清理；已核对无该夹具残留进程。用户配置字节不变，上游源码未改；未启动日常 Gateway。
不同命名 Provider 对照由单测覆盖，未新增第二个真实 Provider 账号、取消/压缩/MCP/图片/平台或性能矩阵。

本次默认 `cargo test --workspace -- --test-threads=1` **480 passed / 0 failed / 1 ignored**；新增纯函数
owner 和既有 ACP seam 定向通过（与 workspace 有重叠，不累加），Core/CLI 构建、fmt、Node 语法及
whitespace 检查通过；文档单测 10 项、当前与 diff-aware 文档门禁通过（base `4d8625c94`）。
没有 Renderer 改动，未重跑前端或安装日常 App。
User sequence 93 要求的剩余复杂度与 14 轴对照见[当前研究记录](../../research/hermes-runtime/README.md#与-command-简化原则及-checklist-的当前对照2026-10-25)，
本轮只核对其他 Runtime 的代码和既有证据，没有替它们重新做真实模型验收。

### 主线集成

同步主线 `4d8625c94` 时保留已合入的 Team 指引 Migration 214 / schema 164；未上线的 Hermes
catalog 与规则证据迁移顺延到 215 / schema 165、216 / schema 166。没有新增业务字段、迁移旧实验
数据或修改模型比较语义；历史验收所用的旧编号保留原义。现有 catalog、规则、Team 指引及数据库
准入测试继续拥有升级、回滚、重开和数据保留验证。

合流后重新执行默认 workspace：**480 passed / 0 failed / 1 ignored**；`--features
slow-tests,extended-tests --lib hermes` 4 项以及 catalog、Team 指引、当前数据库准入、Bootstrap
回滚、迁移状态矩阵、ACP 模型选择 6 个既有 owners 均通过（与默认套件有重叠，不累加）。
Core/CLI 构建、fmt、TypeScript typecheck、Product Contract fingerprint、文档单测与文档门禁通过。
真实模型记录仍明确归属于 `34dd2e2f9`；本次主线集成没有再调用真实模型，也没有启动日常 App。

随后主线 `3425e7c1e` 合入 Command 的 macOS/Windows Preview 和设计文档整理，合流保留双方产品目录。
主线已占用 D60，尚未合入的 Hermes 决定顺延到 D61–D66，并同步引用；当前产品选择为 D66。
平台资格摘要按合并后的兼容性记录重新计算，Hermes 的平台范围和执行语义不变。

## 历史 R1 实施

按当时 R1 和 User sequence 31 实施。
Core 继续拥有完整 B；Hermes 在首次、更新或可靠完成通知后的下一普通输入携带一份规则。
官方 ACP/Gateway 与逐 Run lease 不变；原生 system/personality/环境变量不再被 Adapter 解析或覆盖。

Migration 215 / schema 165 保留旧记录，仅增加 nullable 输入证据；初次交付 controller revision v4（下节补修升至 v5），Hermes
outer envelope v1；共享 Bootstrap v6、Charter 25、Dynamic 40/42 与 Profile 15/16 不变。
历史 system Evidence 不改写。prepared/unknown 不消费规则或补发 revision，也不自动重放旧业务任务。

## 生产 Core 与实际请求

[受控 Core 证据](../../research/hermes-runtime/first-input-core-acceptance-2026-10-23.json)：
`protect_first_n=3` 和 `0` 各运行七个成功 Run，同一 Native Session，投递类型均为
`initial → none → none → update → compaction_recovery → compaction_recovery → none`。
第三轮和第七轮都重启 Core；第七轮在两次补发已接受后冷恢复，不重复规则。
原生完成 Hook 使 requested revision 从 0→1→2，输入 ACK 分别消费 1、2；较早 ACK 不清理较晚通知。
每轮同一任务只发一次实际 `session/prompt`，主模型为一次 terminal Send 加一次 final，未增加规则确认调用。

使用生产 Core/CLI、未修改的官方 ACP/Gateway、确定性 loopback Responses 和真实请求捕获。
测试窗口 65536、阈值 0.5、尾部保护 2，第三/四轮合成 input usage 60000 触发原生自动摘要；
它证明运输、事件、账本与恢复链路，不冒充真实模型质量或原生默认配置验收。
Gateway 原生会 trim 消息首尾空白，模型请求与冻结输入经这一原生规范化后相等，B 内部完整原文不变。
源配置手写 system prompt 仍位于 system 层，B 位于 user 层。

初版验收遇到原生最小窗口 64000 的明确拒绝，已改正测试窗口；未把失败 Run 计为通过。
另有新 Home 的原生 `--version` 被同步联网更新检查拖到 15 秒超时，尚未提交任务。
loopback fixture 使用原生 `updates.check=false` 关闭这项联网行为；未放宽生产超时或版本门槛。

## 真实模型自动压缩

[真实请求/完成事件证据](../../research/hermes-runtime/first-input-automatic-compression-2026-10-23.json)：
官方 0.22.4 / source `4d04303818b61bf3aa09278af48356315515965b`，Sub2API `gpt-6.1-sol`。
正常文件读取触发两次已提交 summarize，分别来自 pre_api 与 post_tool；没有主动 compact 或压缩器补丁。
保持原生配置 protect_first_n=3 / protect_last_n=20 / threshold=0.5；原生实际窗口 272000，
实际阈值 204000，以原生日志为准，没有把配置比例直接乘作有效阈值。
官方 pre_api_request 观察完整规则正文是否在 user 历史、是否进入 system；post_compaction 只观察完成事实。
下一普通输入补发后及原 Session 冷恢复后的请求均有完整规则，未进入 system，冷恢复没有新增规则输入。
这一层使用较小的合成规则块，完整 Core B 的证据由上节拥有。

原生摘要可能逐字保留规则，历史中也可能仍有旧副本；本方案按可靠完成通知补发一次，
不编辑或清除原生历史。不能从某次摘要保留推导所有路径永远保留，亦不宣称同 Run 内立即恢复。
旧 system 层压缩报告不作为此次 user 规则永久保留证据。

## 回归、限制与复现

Controller 4 个确定性回归通过。wire fixture `rovai-hermes-wire-NdYZkg` 的 7 个实际请求通过：
user 规则、原生 env/config/personality 各按优先级生效一次、控制命令、并发拒绝、失败与 usage delta。
原生 `gateway: null` 配置启动兼容已修复并随 wire 验证。
experience fixture `rovai-hermes-experience-dFMn8a` 通过文件片段、reasoning、问卷关闭及同 Session MCP 增改撤销。

[真实 Core 回归](../../research/hermes-runtime/first-input-core-recovery-2026-10-23.json)通过同 Run Steer、
唯一公开 Send、文件证据和冷续轮的真实终端取消。但强杀 Core 后的继续执行**未通过**：
原生 admission 留在 `unknown`，controller 拒绝 unsettled Session；Core 保留
`accepted_input_outcome_unknown`，没有自动重放旧任务、清理原生未知记录或换 Session 绕过。
这限制强杀后的即时续接，不混同已通过的正常冷恢复。所有已记录后代均退出；临时凭据副本已清除。

定向 Rust：Hermes 4、Bootstrap 11（另 1 个 Command Code 原生用例未启用）、compaction 16、redelivery 2、
CLI hook 1、catalog migration 1、迁移准入矩阵 1、数据库打开准入 1、Managed Blob 3 均通过；筛选间有重叠。
迁移夹具跟进 schema 165；缺当前 receipt/规则字段拒绝，历史可选统计缺失仍可重开。
新增最终 Blob 纳入现有 FK 引用保护与 Thread 删除回收。
`pnpm typecheck`、文档测试 10 项、通用/diff-aware 文档门禁、Rust fmt、脚本语法和 whitespace 检查通过。

复现入口：`scripts/smoke-hermes-first-input.mjs --compression` 与 `--compression --unprotected`；
真实模型使用 `scripts/smoke-hermes-auto-compression.mjs`。均声明独立 Home、data-dir、Skill Library 与 MCP。

## 合入前补修与显式恢复

按 User sequence 34 / [D64](decisions.md#v1-72-d64) 实施，保持 FirstPayload。生产 Ready 能力独立声明
`context.charter.first_payload`、`context.compaction.signal_driven`、`context.compaction.best_effort`，
移除 Hermes 的两个旧 system 保证；模型、effort、权限和 session.load 保留。
普通目录映射测试修复前实际失败，现已改正。静态发现使旧 Ready 变为 installed_unverified；
深检缓存也拒绝旧合同，运行检查后回到新 Ready，不为刷新能力而轮换原生 binding。

新增用户 CLI 查询和明确确认入口，合同见 [Hermes Managed Runtime](../../contracts/hermes-managed-runtime-v1.md#用户明确处理未知执行)。
Core 持久记录精确 Run/binding/admission/generation 的用户同意，再调用官方 `prompt.resolve_unknown`；
controller v5 使用独立控制连接，不加载普通 ACP Session，不发送任务。确认结果未知时重用同一检查文件，
先查询精确 receipt；同一个 commandId 不可更换确认目标。原 Run、输入和公开发送证据均不改为成功。
维护 Host 仍由 Fleet 回收；复用逐 Run 的原始 Session 存储，不复用旧 CLI lease。

[受控与真实恢复摘要](../../research/hermes-runtime/explicit-unknown-recovery-2026-10-23.json)分开保存：

- `rovai-hermes-first-input-566fmf`：官方原生执行＋loopback Responses，六阶段覆盖首次、后继、冷恢复及旧 Ready
  升级、规则更新、Core 强杀和显式处理后的新任务。错误 binding/generation、缺少确认和 commandId 换目标均拒绝；
  检查不消除 unknown，恢复零模型调用、零额外业务 Run，Core 再重启后的同确认重试幂等，旧任务失败且执行一次。
- `rovai-hermes-core-h3UHnB`：生产 Core/CLI＋真实 Sub2API `gpt-6.1-sol`。同 Run Steer、文件证据、公开 Send 和
  真实终端取消通过；同时强杀专用 Gateway 与 Core，明确得到 unknown；用户确认后原 Session 的新任务成功，
  旧任务仍失败、旧输入未重放、公开 marker 各一次，受管进程全部退出。

三个先行尝试保留为诊断：旧 Ready 升级首次未命中静态发现分支，现已修正；一次 Host 启动身份校验遇到
`try_lock` 读 PID 的竞争，改为只在 Hermes Ready 校验处等待 child 锁，保留 PID/revision/version 校验；
一次仅强杀 Core 的真实模型运行已经由原生结算为空闲，不计入 unknown 恢复通过。
后续 `--force-unknown` 明确同时强杀独占 Gateway，避免把原生正常结算路径冒充未知执行处理。
这批验收的凭据/config 副本已清理，源 Home 未改，保留脱敏摘要和隔离执行证据。

普通 Rust 全量回归单独执行；首次发现兼容性文档证据 hash 过期（431 passed / 1 failed / 1 ignored），
按实际文档更新 hash 后重跑，不跳过原断言。补修与主线合并提交 `2cdadec68` 的
`cargo test --workspace -j 2 -- --test-threads=1` 为 **478 passed / 0 failed / 1 ignored**；
最后将缓存校验严格限定为 Hermes，最终提交的同命令复核结果记录在 [PR #878](https://github.com/murray17/rovai-ai/pull/878)。
CI 的 fmt/check 不替代 Rust 单测。
Controller 确定性回归 5 项、User Automation 定向测试 10 项与 TypeScript 检查通过。
本次不重跑已记录的自动压缩矩阵，不把显式恢复当作同 Run 压缩恢复；未新增 Renderer 按钮或日常 App 安装验收。

## 原会话优先与可用性收口（2026-10-24）

按 User sequence 36 / [D65](decisions.md#v1-72-d65) 与共享同类 CLI Resume 规则对齐。原生 Session
选择本来就不应按历史指纹拒绝；此次删除 Hermes 额外的 Session 配置冻结和维护入口旧安装相等门槛，
保留实际启动的最低版本、原生能力和身份检查。正常任务及维护都使用当前选定安装，原 binding 的
Home/profile/Session 保留，版本和指纹只影响必要探测与进程更新。controller revision 为 v6。

历史恢复成功后先返回原生状态；Core 在投递前分别报告 running、approval、queued、unknown，模型、
权限和 MCP 变更留在空闲时准备。实际缺失或无恢复能力仍保留目标并报错，Hermes 不走自动新 Session
回退。没有输入在途时允许对同一专用 Gateway 的状态读取重连一次；不重启执行者、不重发业务请求。
删除跨 Hermes Session 长锁，复用 Fleet 的 binding owner 与同 Home 文件锁。

[本轮脱敏证据](../../research/hermes-runtime/availability-recovery-2026-10-24.json)对应
`rovai-hermes-first-input-k58OJV`，生产 Core＋未修改官方 0.22.4＋loopback Responses 全链通过：

- 原地修改 launcher 指纹后续聊；切换 launcher 路径并冷启动后续聊；启动 Home 改变后实际模型请求
  仍使用原 Home 的 system prompt，首次规则不重复，身份更新仅一次。
- Core 强杀留下 unknown 后，隔离 Core 安装夹具停用旧安装记录，选择新记录并加入过期 0.22.3 缓存，
  再切换路径/指纹。检查与确认使用当前安装，原 Session/绑定和旧 Run 证据保留。未编辑原生 SessionDB。
- unknown 时普通续聊的历史恢复成功，新 Run 以 `hermes_session_unknown` 失败且没有 dispatch。
  检查和错误确认不消除 unknown；明确确认只处理精确执行，重启后同确认幂等，旧任务保持失败。
- 处理后原 Session 新任务成功；旧业务动作一次，公开 Send 各一次，恢复过程零模型调用，强杀后代全部退出。
  新安装的目录深检在普通续聊已经成功之后单独执行，Ready 不是续聊的前置条件。

本轮普通 `cargo test --workspace -j 2 -- --test-threads=1`：**478 passed / 0 failed / 1 ignored**。
三个既有 extended owners 分别覆盖安装/路径/版本/指纹漂移仍选择原 Session、Hermes load-only 恢复，
以及不同 Hermes binding 同时进入启动、相同 binding 拒绝第二 owner。Python controller 8 项通过，
包括状态分类、读取断线重连、固定 Home 和无 marker 旧存储接续。未增加 Rust 测试入口。

首轮发现路径变化时已失效快照仍残留 system 能力，现已在发现阶段清除；其余先行夹具失败涉及取错
上一失败 Run、SQLite 纳秒时间需 BigInt，以及把新安装未验证快照当成 Ready。原始失败目录和原因保留，
不作为验收通过。实际执行版本只有 0.22.4，wrapper 与缓存变化不能冒充新版原生兼容性验收。
读取重连和运行/审批/排队分类本轮只有确定性控制器证据；真实模型与自动压缩沿用上节分层记录，
没有重跑或扩大平台资格。普通续聊不需要 CLI 维护；无法确认的 unknown 仍须用户明确处理，当前异常入口为 User CLI。


## 官方 ACP 直连简化（2026-10-24）

按 User sequence 38 和 [D66](decisions.md#v1-72-d66)，controller v7 改为启动器：原生 ACP 直接拥有协议
管道，删除消息转发、工具事件过滤/重建、额外 Gateway 订阅、连续序号 replay、逐 prompt receipt 门禁、
私有 Diff 解析、reasoning mutation、`_rovai/*` Hermes 协议和额外 storage flock。配置/凭据摘要不再参与
Hermes 进程兼容性。保留原 Home、SessionDB、原生能力关闭策略、FirstPayload、完成 Hook 和共享 Fleet/lease。

按需控制只处理 ACP 缺口：恢复后的完整 MCP assignment（包含空列表撤销）、同轮 Steer、已有 unknown
检查/明确处理。原生模型和权限直接使用 set_model/set_mode，失败保留 native details。旧 Ready 通过现有
发现入口失效并重探；本次没有新数据库迁移、新恢复框架或其他 Adapter 的行为切换。

明确降级：不再承诺完整工具参数、结构化 Files Changed/Diff、单 prompt 消耗或受管 reasoning effort。
官方 ACP 的 Session usage 不能当本轮 delta；失败之前的用量若 ACP 未独立报告，也保留未知。已有文件
修改、原生成功/失败/取消与公开 Send 不因这些详情缺失而改变。

本轮使用 macOS arm64 上未修改的官方 Hermes 0.22.4、loopback Responses 和新建隔离 Core/Home/Skills/MCP；
没有使用日常 userData，也没有调用真实付费模型。已完成：

| 既有验收入口 | fixture 后缀 | 结果 |
| --- | --- | --- |
| wire | `aWXwAP` | user 规则/更新、原生终态、env/config/personality 各一次、控制命令无模型调用 |
| experience | `aMneR9` | 文件实际写入/多文件更新、缺少增强信息仍成功、原生 reasoning、Steer、取消后续聊、两 Binding 并发、MCP 增改撤销 |
| first-input --availability | `wYbiyD` | 当前安装/指纹/路径/Home 变化仍原 Session；强杀无重放，明确解除 unknown 后原 Session 新任务，公开 Send 无重复 |
| first-input --compression --unprotected | `oHOuwd` | 首条/后继/冷恢复/规则变化；两次原生完成 Hook，下一普通输入补发，末次冷恢复不重复 |
| first-input（普通模式） | `eF68S0` | 四轮生产 Core 均 succeeded，补充 token/费用字段明确为空；首条/后继/冷恢复/规则更新正常 |
| failed-usage | `l63c2G` | 第一调用有用量和真实工具、第二调用失败；Run failed、无重放、缺失 prompt 消耗不虚构 |

迁移中先后发现并修正了旧探测能力要求、按需控制的 Home/socket 来源和 Steer 原生 queued 字段；最终
通过使用新 fixture。体验脚本的 MCP 撤销断言也改为检查本次 tool result，避免把保留历史中的旧结果
误当成当前仍可调用。旧失败 fixture 不计通过。
取消接受边界同时补齐：未观察到本轮活动的 cancelled 响应不独自确认 FirstPayload 接受；保留原生取消终态，不重放任务。

Rust 原生 patch 独立 owner 随其生产职责退役；launcher、目录/Ready、稀疏 usage、runtime_diff、恢复与
Fleet 复用现有 owner。Python 启动器/控制测试 5 项通过；普通 Rust workspace 为 477 passed / 0 failed / 1 ignored，
ACP extended 为 67 passed / 0 failed / 2 ignored，runtime_diff 17 项、稀疏 usage/目录/launcher 各 1 项通过。
文档单测 10 项、当前检查及相对 main 的治理检查通过。runtime_diff 首次定向回归发现一处旧私有片段
成功断言，按已退役合同改验拒绝后 17 项全过；未跳过失败测试。此前 controller 阶段的通过不替代本轮结果。

保留 Preview；本轮不扩展 warm 协议、专用聊天恢复按钮或其他平台资格。真实模型识图、所有历史版本和
所有边角组合不作为本轮简化的已完成宣称。

## 稀疏配置与 MCP 部分可用性（2026-10-24）

按 User sequence 40 在直连版本上补齐两处边界：`prepare_home()` 接受缺失/空白/注释/null 配置，
只对实际改写的节与追加列表兼容 null；保留未知字段、原生表达式和源文件，不载入完整默认配置。
原生允许的 disabled_toolsets 字符串形式交给原生小函数解析后追加关闭项，已有条目和 Hook 不重复。

恢复时 MCP mutation 正常返回部分或空发现集合，保留成功服务并沿现有 HostDiagnostic 报告缺失名称，
允许普通对话与原生工具继续。RPC 断线、状态冲突、异常结构与未确认撤销仍报错，不循环重连。
新建只随 `session/new` 绑定；冷恢复仍先恢复历史，再以一次快照的 revision/generation 执行一次 mutation。
这两条调用路径、直接官方 set_mode、删除 refresh_efforts/session_info 重复读取，已在直连简化中完成，
本次没有恢复旧 controller 或添加缓存、锁、轮询与新的恢复系统。

Python 既有入口 6 项通过，覆盖空配置/空节、错误类型/语法边界、源文件不变与重复准备、部分/全部失败、
空列表撤销、异常返回及 running/approval/queued/unknown 不改分配；调用计数只统计受管控制主动发起的
一次 resume 与至多一次 mutation，不包含官方 ACP 自己的必要查询。workspace check、fmt、既有 ACP
诊断脱敏用例及文档治理检查通过。本次没有新增 Rust 测试入口；上节完整 Rust 结果属于此前提交。

隔离官方 Hermes 0.22.4 + loopback Responses 的既有 experience 流程通过，最终 fixture 为
`rovai-hermes-experience-kXKqO4`。真实 YAML 空节可启动；新 Session 同时分配一个可用/一个失败的 MCP，
成功工具和普通对话可用；同 Session 冷恢复保留历史、重新连接相同分配、更新凭据、从有效分配明确清空后
旧工具消失；全部外部 MCP 不可用仍正常结束对话，原生日志报告失败。原有文件工具、取消、Steer、并发和
增强观测缺失仍成功的断言同次通过。未改官方源码、未使用日常数据或真实付费模型，未扩大平台矩阵。

## 显式模型选择与初始化预算（2026-10-24）

按 User sequence 42 修正 Core 的显式模型选择分支：Hermes 与 Kiro/Grok 复用已有 `set_model()`，
发送官方 `session/set_model`；不再进入只返回空配置 ACK 的 `set_config_option("model", ...)`。
此前直接调用官方接口的体验测试、以及默认模型与目标相同的 Core 流程，未覆盖这个遗漏。

既有 first-input 普通模式扩展为默认模型 A → Core 显式选择 B → Core 冷恢复 → 规则更新，始终断言
原 Session ID 不变，并检查每轮实际模型请求。修复前基线 `542fd99e9` 的 fixture `bVqS2A` 在选择 B 后
仍请求 A，断言失败；修复后 fixture `f62Pj4` 四轮全部通过，请求模型依次为 A/B/B/B。使用未修改的
官方 Hermes 0.22.4 和本地受控 Responses，未调用真实付费模型。

Hermes 正式 Host initialize 由 45 秒改为 90 秒，覆盖私有 Home 准备、Gateway 55 秒就绪预算和
官方 ACP 导入/握手余量，与既有 Hermes 探测预算一致。保留原超时清理，不增加重试；本次只对齐预算，
没有把正常启动验收当作慢机失败率或性能矩阵。插话锁、逐 Run 冷启动、按需恢复快照和启动串处理保持原状。

共享 ACP extended 回归 67 passed / 0 failed / 2 ignored；Core build、workspace check、fmt、脚本语法、
whitespace 和通用文档门禁通过。没有新增 Rust 测试入口或恢复/缓存机制。

## Skills 路径与普通绑定刷新范围（2026-10-24）

本轮只修改私有 Home 的 Skills 路径转换，以及共享工具上下文刷新目标。`external_dirs` 的单个字符串
与列表项采用原生 scalar/list 语义，先转字符串、trim、过滤空项，再展开变量/`~`，以 binding 记录的
来源 Home 处理相对目录；`create_dir` 只转换 trim 后的非空字符串。实际发现仍由 Hermes 执行，
源 config、稀疏未知字段和 Skills 链接保留。没有修改原生 personality/system prompt 或 Session 规则。

普通绑定向现有刷新函数传入 process/Run/epoch，只投影当前 ActiveLease；已解绑或换绑的旧目标跳过。
既有 invocation gate → 最新设置读取 → processes 锁顺序保持。全局设置保存、同值修复和有界重试仍用
全量入口，事务先提交并释放；投影错误不撤销 lease。当前进程仍可写两次小文件，其他无变化进程不写。
没有新增锁、服务、缓存或后台轮询；本轮不把减少文件写入描述为已测得的性能提升。

### 验证归属与结果

- Python 既有稀疏配置 owner 增加路径边界，6 个普通测试通过。原生模式 `--native-skills` 使用本机未修改
  Hermes 0.22.4（`4d04303818b61bf3aa09278af48356315515965b`）及已准备依赖；7 组隔离实际 Skill 发现通过，
  包含空项不引入 Home 搜索根、源 config 不改写、Skills 链接保留及重新准备时沿用记录的来源 Home。
- lease owner `builtin_tool_runtime::tests::lease_rotates_fences_and_replays_exact_request` 扩展当前进程写入、
  当前 lease 轮换、解绑/Run/epoch 换绑跳过和投影失败后认证仍有效。通过保留合法 JSON 的非标准空白检测
  同值重写，不依赖 inode、mtime 或磁盘耗时。
- 新增 slow owner `application::tests::task_discovery_refresh_scopes_bindings_and_repairs_saved_preferences`：
  原 registry owner 没有 SQLite/公开设置保存，不能证明 gate 之后读取最新设置、普通 bind 的定向调用、
  同值保存和有界重试的跨模块传递。复用既有私有 Core/数据库/Run fixture，不启动 Runtime；暂停 Tokio
  时钟驱动既有重试，显式 poll 到 gate 等待处后提交设置，不以线程调度猜测竞态。修复前绑定 B 会重写 A。
  最小命令：`cargo test -p rovai-core --lib --features slow-tests,extended-tests task_discovery_refresh_scopes_bindings_and_repairs_saved_preferences`；
  lease owner 使用同一入口的 `builtin_tool_runtime::tests::` 过滤器。两项 lease 回归和一项 Core 设置回归均通过。

普通 workspace 首轮在 Core 测试阶段停止，430 passed / 1 failed / 1 ignored：既有 Cursor 身份探测在 2 秒预算内超时，
未到达预期的身份不匹配断言。该项单独复核通过；未修改其实现或超时预算，完整 workspace 以
`--test-threads=2` 复跑为 477 passed / 0 failed / 1 ignored，保留首轮失败记录。Core/CLI build、workspace
check、fmt、whitespace、文档单测及通用文档门禁通过。

没有新增真实付费模型、自动压缩、平台扩展或性能矩阵验收；原 Session、Gateway、Fleet 和 CLI lease
机制保持，本轮在这两项局部修改处结束。
