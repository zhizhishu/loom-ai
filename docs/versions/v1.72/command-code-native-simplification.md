---
document_type: implementation-report
source_version: v1.72
last_updated: 2026-10-26
---

# Command Code 1.88 原生接入简化

当前实现以[启动合同 v72](../../contracts/runtime-launch-and-verification-v72.md)为准。
只保留原生 HOME、官方 Mod、标准 ACP 与共享 Fleet。当前 macOS arm64/x64 按 User seq61 开放 Preview，
Windows 与 Linux 随各自独立验收后也开放 Preview；该开放不代替完整平台资格，具体范围见文末。

## 实际减少

删除 Command 原生 auth/provider/settings/Mod/项目 MCP 的遍历与摘要、HOME 与 `.commandcode` 镜像/链接、
原生 projects/sessions 补偿目录、私有 settings/mcp 合并、nonce 文件、重复 readiness 读取与每轮 `mcp list`。
新 Adapter 投影的两个兼容性摘要为 null，Command 退出 Native Session key 摘要和 ACP runtime digest 生成。
Fleet 的显式 Native Binding 策略与其配置摘要策略互斥；不以字段缺失默认为可复用。旧数据保持可读。

启动准备在进程创建前清理目录；实际 child 从底层启动失败也能交回清理 owner。Host 构造期间 owner 同时
持有进程/材料，确认停止与 reap 后清理，不能确认则保留诊断。Host 成功接管后继续已有 shutdown；没有改写
pending/stdin/取消/退出的锁顺序。清理只用已有 `Option<root>` 表示材料所有权，删除两个恒真开关。
Native Binding 提交从已有 JOIN 读取 Runtime kind，删除同一行的额外查询。

PR #890 后续审查将 Command 的入口/指纹检查和必要刷新移到 Fleet cold spawn；warm 只保留安装身份、
显式禁用/删除及既有准入。cold 使用当前安装证据启动，冻结 Run 的逻辑选择、Binding 和 Session 不换代，
启动事件使用实际 Host 版本。MCP 修改只将本次受影响成员传到现有失效入口，无变化不退役；warm Session
不再构造不会发送的 MCP wire 参数。Bootstrap 已改用现有 ACP 控制通道，删除整个正文 binding 文件路径；
没有新增文件种类、专属队列或长期管理状态。

2026-10-25 可用性跟进删除 Command 的新旧 Bootstrap 逐字比较和 Rust/Mod 两端的 256 KiB JSON
封装限制。每 Run 发送前将已有 Context 准备的冻结 B 经官方 Mod 命令交给内存，首次/warm/cold 一致；
不读取旧正文做相等判断。正文继续使用共享 128 KiB 预算，
不新增跨 Host 冻结管理器，也不因成员编辑更换 Host 或 Session。
成员环境保存将已解析值和继承选项的实际变化传给既有失效入口，格式无变化和命令重放不触发退役。
health probe 删除丢失原始错误的 Command 特例，和其他 ACP 共用错误分类与展示脱敏；未修改 Run 卡片。

后续六项审查修复：启动设置释放 `runtime_search_update`、安装更新释放数据库锁后才等待 Fleet；
字段目标已达到时返回成功，安装命令重放不重复失效，新命令保存相同安装值也不增加 version/generation。
Command 最低版本判断复用通用解析器，接受产品名前缀、`v` 前缀和构建元数据，保留 1.88 稳定版下限。
MCP 成员集合使用实际增减成员；关闭 Server 的定义、分配、删除和导入替换不触发 Host 退役，
`setMembers` 非空分配启用 Server 的原行为保留。共享认证状态和失败摘要使用“认证未通过”，
检查登录状态或凭据配置，仍优先显示现有脱敏原生原因。共享 ACP 仅在策略提供 MCP 摘要时比较它，
Native Binding 不再执行 `None == None`，没有增加 Command 特例或新的复用条件。

## 收口复核（2026-10-25）

User 后续清单引用 `ce140e684`；以下核对的是已推送的 `abf8f4cdc`。前五行已有修复，
本次只补注释和说明，不再扩展 Runtime 行为。

| 问题 | 当前结果与边界 |
| --- | --- |
| 持锁等待 Fleet | `save_runtime_startup` 显式释放 `runtime_search_update`，安装更新结束数据库锁作用域后，才等待 Fleet。安装路径有受控并发回归；启动设置路径由调用链复核，不声称已真实复现原死锁。 |
| 非空设置请求重试 | `prepare_save` 保留字段合法性、重复字段和实际冲突检查，剔除当前值已等于目标的字段；全无变化沿既有返回路径退出，不检查程序文件、不增加 revision/generation、不退役。覆盖 A→B 成功后入口暂时消失再重试。 |
| 安装更新重放 | `execution.replayed` 不触发后续失效；新命令保存相同目标也返回 `adapter_installation.unchanged`，不增加 version/generation。与上一行是两个分别覆盖的入口。 |
| 版本误拒绝 | 使用共享版本解析器；接受 `v`、产品名前缀与 build metadata，仍要求稳定版至少 1.88。 |
| MCP 退役范围 | 已启用 Server 从 A、B 改为 A、B、C，只影响 C；修改前后仍关闭的定义、单成员分配、删除和导入替换不退役。`setMembers` 非空集合会按既有语义启用 Server，此时新分配成员的有效配置确实变化。 |
| 认证文案与 BYOK 注释 | 认证失败沿共享分类和脱敏原因展示，不一律要求网页登录。本次删除代码注释中“Command BYOK 选模仍不支持”的旧结论；原生默认模型占位分支仍处理当前模型未出现在返回目录中的情况，不影响目录内 BYOK 的显式选择。 |

以上为 `abf8f4cdc` 时点的收口结果。后续 User 收口取消 `session/list` 强制预检，采用原生尽力恢复；
直接传输验证通过后已删除正文 binding 文件及其 SHA 校验。一次 ready、不同 stdio cwd 包装和 wire
转义保留；当前交付见下文生产接入记录，没有新增认证探针、配置比较或正文缓存管理器。

### 成员身份与长期指令何时生效

共享规则区分“本轮准备了什么”与“Adapter 实际投递什么”，见
[Bootstrap 不变量](../../architecture/foundational-invariants.md#context-session-bootstrap)和
[补发门禁](../../architecture/native-session-bootstrap-redelivery.md#delivery-gate-与-prepared-cutoff)。
`members.update` 只保存成员资料并发布名册事件，不创建 Run、补发要求、Session 或 Fleet 退役。
专业职责、工作原则等完整 self identity 仍只在 Bootstrap；Dynamic Context 的 peers 不代替它。

| 时点 | 当前 Command 行为 |
| --- | --- |
| 身份编辑前已 claim 的公开 Run | 继续使用该 Run 已冻结的身份；编辑不回写既有输入。 |
| 身份编辑后 claim 的公开 Run | 共享 Context 准备新身份；旧／非 batch Run 沿准备时读取规则。准备新 B 本身不等于已向模型投递。 |
| 同一 Host／Session warm 续用 | 发送本轮输入前，以官方 Mod 控制命令替换内存中的 B，等待成功后发送原输入；不依赖进程重启。 |
| 后续新 Host 冷恢复，或新 Session 首次绑定 | 经同一控制通道交付该 Run 准备的 B。若该 Run 在编辑后取得身份，就使用新内容；冷恢复保留精确原 Session ID，不要求新旧 B 相等。 |

一轮内冻结与 Host 生命周期固定不再混同。同 Run 重试仍由 Context 的 Run Evidence 取回原冻结字节；
成员编辑操作本身不向 Mod 更新正文，执行中的 Run 不被中途更新。后继 Run 的准备规则与 Codex/Pi 等共用，
Command 在发送前实际交付这些字节，不增加摘要、重启或缓存。下述隔离原生试验验证了同 PID/Session
的 A→B→B 和换进程同 Session 的 C；新传输另有生产 ManagedProcess/ACP 的 A→B→A 验证。
两者均不是完整 Core 队列／失败重试验收。

### Run 边界与原生能力补齐（2026-10-25）

在 `6470ebd6` 之后的同一 worktree 修改：删除 Command 专属目录校验函数和 `session/list` 调用，
保留精确 Session ID、共享请求归属及 accepted-input 边界。1.88 仍会接受缺失 ID；这是原生尽力恢复，
不标记为已证明完整历史，也不以认证/网络错误触发新 Session。

官方 Mod 文档的 `getActiveTools` / `setActiveTools` 在固定 1.88 ACP 中已接通。现有 Mod 的
`onSessionStart` 只从当前工具集合排除 `ask_user_question`，没有硬编码白名单、beforeToolCall fallback
或运行时探测。对照组模型 schema 有 13 个工具，过滤后 12 个，差集仅为该问卷；强制返回被禁用调用
没有产生问卷，随后 read_file 与后继 prompt 正常。所有测试均未代选用户答案。

Skills 只给现有 `native_skills` 增加 user/project 的 `.agents/skills` 来源。原生同名优先级是
项目 `.commandcode` → 项目 `.agents` → 用户 `.commandcode` → 用户 `.agents`，不能泛称所有
`.commandcode` 都覆盖 `.agents`。共享发现保留各来源身份，原生选择由 CLI 负责，不复制或重排用户文件。

Diff 仍关联同 ToolCall 的成功终态。单次 edit 用 reported mutation 展示片段；空 old_string 加
精确原生 `Created <同路径> (<行数> line[s])` 回执接入已有 full-before-after/add 展示。
原生 write_file 对已有空文件也说 created，故不凭该文案或提案的 oldText:null 声称新增；
2026-10-26 修正其行数映射：精确同路径的 created 成功回执与非空 content 已足以说明旧正文为空，
按完整 update 显示 `+N / −0` 和 Diff。空 content、非空覆盖及无完整结果的多处替换保留操作记录，
失败不生成 Diff。不新增磁盘读取或 Git 检查。

本次使用官方 npm `command-code@1.88.0`，CLI SHA-256 为
`600725f967cc98f6144066c24e850d934bd4a1f503c3bf82f2bd2584a8757dfd`。
自动验收在独立 HOME/cwd 中使用本地确定性模型响应，未调用外部模型，未启动 App/Core。
原生工具、ACP 和生产 Mod 实际执行；这与下文 sub2api 真实模型试验分开记账。

| 隔离场景 | 原生回执 |
| --- | --- |
| 默认问卷 / 官方工具过滤 | 默认 1 次问卷；过滤后 0 次，schema 中移除且其他工具保留；当前与后继输入均 end_turn |
| write/read/edit | 新写入、读取、单次编辑、edit 新建、已有空文件填充、覆盖、多处替换成功；不存在片段的编辑返回 failed |
| 生产 Mod warm | 同 PID/Session 的三个请求分别只有 A、B、B；System 各一份，user 均为零 |
| 生产 Mod cold | 新 PID 直接恢复旧精确 ID，三个请求均只包含本轮 C；没有 session/list |
| 缺失 ID | 原生接受精确随机 ID 并执行；只记录此原生行为，不当作历史恢复证明 |
| 当时的稳态材料 | ready 校验后删除；当时每 Host 为 Mod 与一个实际 Session binding。后续直接交付已删除该 binding，旧试验结果不改写。 |

代码回归和文档门禁结果在文末验证记录中更新；公开资格仍保持不变。

## 与其他 Runtime 的资源与复杂度对照（2026-10-25）

首次基于 `942219d36` 检查生产调用链并修改 stdio wire 的目录分支；下表的 Bootstrap、恢复和提问行为
已同步本页后续 Run 边界收口与 ACP 直接交付。比较重点是额外常驻进程、每轮重复工作、磁盘开销、后台任务与锁；
其他 Runtime 也存在某个步骤，不能单独作为保留依据。

| 关注点 | Command 当前行为／成本 | 其他 Runtime 对照 | 处理结论 |
| --- | --- | --- | --- |
| 默认目录 stdio MCP | 修复前所有投影的 stdio 都多一个常驻 Node，因为共享投影将缺省 cwd 补为 execution_root。本次相同 Session cwd 直接传原命令。 | Codex 的 Session MCP 配置直接携带 cwd；Cline 用原生配置字段，不由 Rovai 为每个 stdio 加 Node。 | **已减量**：每个实际启动的默认目录 stdio 少一个包装进程；HTTP 原本没有。 |
| 不同目录 stdio MCP | ACP 无 cwd 字段，仍保留 `node --eval` spawn 包装；该 Node 与子进程同时存活。 | ZCode 也按 cwd 包装；Unix 使用 shell `exec` 替换进程，Windows 使用 Node。Pi 未支持外部分配 MCP，不能把其零 MCP 开销当等价实现。 | 保留现有必要适配；不引入 Shell 拼接、缓存或守护进程。 |
| 原生配置与 HOME | 沿用用户 HOME；不扫描/复制 auth、settings、Mods 或原生 MCP。 | Codex 同样使用原生 HOME；部分 ACP 的私有配置文件来自各自协议需求。 | 无可删除的 Command 配置镜像；不为对齐其他 Runtime 增加文件。 |
| Run 级 MCP 投影 | 仍走共享 prepare：读取冻结投影，必要时生成 `runtime/mcp/.../canonical.json`、同步并重新读取校验。 | 所有消费共享投影的 Adapter 均承担该成本，不取决于最终交给原生的是文件还是 ACP 参数。 | 有 I/O，但不是 Command 私有原生配置副本。本 PR 不改，也不增加内存模式旁路。 |
| 新 Host 的 Bootstrap | 一个 Mod；一次 ready 写入、校验、删除；通过已有 ACP 控制命令接收正文。 | Cline 用原生 System Rule；Pi 用受管扩展和 binding；Codex 用会话指令字段。 | 稳态只保留 Mod，删除正文文件，不建立共享资源缓存。 |
| warm Bootstrap | 每 Run 发送前一次普通 ACP 控制往返，JSON 解码后替换一个内存值；hook 直接返回 B。 | Pi 激活时更新 binding；Codex 在会话请求传当次指令。Command 多一层官方 Mod 命令适配。 | 删除正文读写、rename 和 SHA；没有多发模型对话，不新增锁或队列。未测性能，不能据此宣称更快。 |
| warm 启动准备 | Fleet 复用成功时，不执行 cold callback 中的入口验证、环境解析、Built-in 进程上下文创建及 spawn。 | 继续使用共享 acquire/spawn 边界；其他 Runtime 保持原兼容策略。 | 未发现仍可直接删除的 Command 冷启动重复工作。 |
| 进程池与锁 | 使用共享 Fleet 和 ACP 的 stdin/pending/Session 状态；Run map 锁只做对象取放。 | Cline、Kimi 等使用相同 Host；DSH 另有原生 Session 锁对应的旧 Host 退役等待，Command 没有该分支。 | 无 Command 专属池、账号锁或新锁；不改 pending 的终态/退出顺序。 |
| 启动失败清理任务 | 未交接 child 的 owner Drop 启动一次停止、reap、进程树确认任务；无法确认则留材料诊断。 | 来自共享 `PreparedAcpProcess`，不是 Command 常驻任务。 | 保留；删除会留下取消/构造失败的资源所有权空档。 |
| 原生用量观察 | Command 不启用 `NativeUsageReader` 日志尾读路径。 | Kimi、Qoder、Codebuddy、MiniMax、TRAE 等按原生数据源启用；Cline 有自己的观察来源。 | 没有可删的 Command 用量轮询；不能误报为每个 ACP 都有后台日志扫描。 |
| 压缩与后台监控 | Command 当前没有启用专属 compaction relay/outbox；也没有配置 watcher。 | 部分 Runtime 有已接通的 best-effort 原生压缩策略。 | 没有新增资源候选；缺少压缩能力不等于资格已经完成。 |
| cold 恢复 | 直接提交精确 ID，不再查询 Session 目录。 | 共享协议归属与错误处理不变；其他 Adapter 的目标确认策略不搬到 Command。 | 原生尽力恢复，不额外证明历史完整；无配置或正文扫描。 |
| 模型／权限 RPC | 沿共享 Session 方法应用当前 Run 设置，模型 ID 原样传递。 | 其他 ACP 也应用冻结 Run 的权限和选择。 | 不为省一次 RPC 新增“上次值”缓存；没有额外登录探针。 |
| env/header 与工具事件 | 一次 wire 转义；工具初始/完成事件沿共享关联 map 补全输入和编辑片段。 | 1.88 会再次展开 env/header；稀疏事件关联与 Cline 共用。 | 均有原生回执或协议缺口依据，不扩展成配置缓存、额外锁或文件扫描。 |

可核对的代码入口：[Command wire 与 Bootstrap](../../../crates/rovai-core/src/command_code_acp.rs)、
[共享 ACP](../../../crates/rovai-core/src/acp.rs)（`ensure_agent_run_runtime`、`native_usage_selected`、
`PreparedAcpProcess`）、[共享投影](../../../crates/rovai-core/src/mcp_projection.rs)、
[Codex Session MCP](../../../crates/rovai-core/src/codex.rs)（`codex_mcp_session_config`）、
[Cline](../../../crates/rovai-core/src/cline.rs)、[ZCode](../../../crates/rovai-core/src/zcode.rs)、
[Pi Host](../../../crates/rovai-core/src/pi/managed-host.ts)和[压缩策略](../../../crates/rovai-core/src/compaction.rs)。

其中共享投影在 Unix 发布新文件时，依次同步文件、临时目录和 rename 后的 Run 父目录；冻结与恢复校验
仍有消费者。warm Bootstrap 已不读写正文文件，但不能据此声称整轮零 I/O。上述锁与任务结论只限当前接入差异，
不声称整个共享 ACP 已证明无死锁；也未测量 CPU／内存，不给出 MB 节省数字。

没有为共享一个小 Mod 新建资源缓存，没有专属锁、进程池、配置快照、文件监听器或回收队列。
Bootstrap 冻结内容、system/user 角色及证据轴未变，因而无需新增模型上下文 revision。

### stdio 默认目录的最小减量

旧报告将包装范围写成“自定义 cwd”并不准确：共享 `resolve_definition` 会补全缺省 cwd，旧适配只判断
`Some(cwd)`，因此每个经 Rovai 投递的 stdio 都会包装。现在把已有 Session 执行目录传入 wire 适配，
沿共享路径比较处理相同目录与 Windows 前缀表示；相同就保留 command/args，不同才继续原包装。
项目选择与 Mission 工作区已有 canonical 路径约束，本次不增加 realpath 扫描或新的目录准入检查；显式
配置其他路径别名时仍可沿原包装运行，不为消除所有等价拼写增加解析机制。

官方 1.88 在原生 `bindAgentSession` 中先进入 Session cwd，再连接 editor MCP。隔离原生控制探针将
CLI 初始目录设为 `host space`、ACP 目录设为不同的 `session space`，直接 MCP 自报后者且父进程就是 CLI；
不同目录用生产 `mcp-cwd.cjs`，回执为 `custom space`，进程链仍为 CLI → Node → Server。
该事实分别在 `session/new` 与同 ID 的 `session/load` 验证，不是从 Host 启动目录推测。

两条路径的空参数、空格、引号、中文、shell 字面字符及 env 原样到达；关闭 stdin、执行夹具进程组清理后，
所有已记录进程退出。该结果不单独证明原生仅靠 EOF 就会回收全部子进程。
首次夹具用 JavaScript 字符串替换时误用 replacement 的 `$$` 语义，env 检查失败；改用回调返回字面值后
两条路径通过，生产 Rust wire 转义没有修改。失败及修正一并保留在证据中。
本次只发送 initialize、Session 与 MCP discovery 控制请求，没有 `session/prompt` 或 `tools/call`，
不声称重新通过模型工具回执、历史内容恢复或 Windows/Linux 资格。原生凭据只传给隔离子进程，
没有复制到验收证据；日常安装、App 与原生历史未改动。

## 按接入 Checklist 对照其余方案（2026-10-25）

首次对照基线为 `e1e667905`，下表已同步后续 Run 边界收口；范围包括当前[接入 Checklist](../../development/runtime-integration-checklist.md)、
旧 [Command/Cline 14 轴表](../../research/runtime-monitoring/command-cline-checklist-2026-10-05.md)及
[10 月 6 日追加表](../../research/runtime-monitoring/command-cline-native-system-2026-10-06.md)。
旧表是特定版本的研究证据，不能把其中 headless、私有 HOME、原生 MCP 文件合并或 Preview 当成当前方案。
以下把“已实现的接线”与“1.88 已验证的子场景”分开，未验子项不冒称整轴通过。

| Checklist 能力轴 | 其他 Runtime 的代表方案 | 当前 Command 方案与已验范围 | 仍需区分的边界／最小处理 |
| --- | --- | --- | --- |
| Auth / Provider / Model | 各 Runtime 读取自身原生来源；Codex app-server 与 ACP 使用各自目录及选模方法。 | 原生 HOME、真实 ACP 目录、标准 set_model；sub2api 显式选择及 cold 后保存模型本次通过。 | 生产不借用其他 Runtime 凭据。测试使用已有原生认证，不能据此宣称 BYOK 不需要原生认证；全认证方式与凭据轮换未验。无需增加登录探针。 |
| Host / Fleet / LRU | ACP 共享 Fleet；Codex/Pi 等通过同一 Fleet 所有权与租约管理生命周期。 | 按所属范围、成员、Native Binding、cwd 复用；正常生产同一根 Binding 使用自己的 Host。共享冷启动回归已过，本次原生 warm 保持 PID。 | 原生同 PID A→B→A 是 Adapter 隔离证据，不意味着生产要跨 Binding 拼池；1.88 完整 App/LRU 压力未补验。 |
| Native Session / Continuation | Codex 使用 Thread resume，ACP 使用 load/resume；Host 配置摘要不等于必须丢弃旧 Session。 | exact ID；此前原生 Host 重启后恢复同 ID、回忆原 receipt，并再次调用 MCP。 | 当前已删除 session/list，采用原生尽力恢复。Core/App 重启证据仍来自旧版本，不能用原生重启替代。 |
| Bootstrap / Context | Codex/Claude 用原生指令入口，Pi/DSH/Cline 用各自受管 System 交付。 | 官方 Mod 控制命令经现有 ACP 更新内存；生产 Host 的首次、同 PID/Session A→B→A 和 cold 已验，System 中 B 一份、user 为零。 | 首次/warm/cold 同路；控制结果不成为业务事件，无正文文件或 argv/fallback，不新增跨 Host 仓库。 |
| Compaction continuity | System 原生保留与 Core 补发是不同策略；只有补发正确性需要信号时才接 detector。 | Command 每次 System hook 追加 B，当前 detector 为 Disabled；这不等于原生压缩功能被禁用。 | 旧 1.74 manual/threshold/cold 证据不能替代 1.88 的 manual/threshold/overflow+retry 矩阵。补验 System 保留即可，不为打勾另造 detector/outbox。 |
| Skills | 当前共享来源是平台索引、成员工具箱和 Harness 原址发现；原生目录依 Runtime 不同。 | 共享 native_skills 同时枚举 `.commandcode/skills` 和 `.agents/skills` 的 user/project 来源；无私有投影。Registry 仍标 DocumentationOnly。 | 原生目录兼容与同名优先级不等于整轴通过；读取、热更新、删除与相邻成员完整矩阵仍分别验收。 |
| External MCP | Codex Session 配置、Cline 原生配置、其他 ACP 参数交付；同名规则可因原生行为不同。 | 标准 mcpServers，原生同名优先；本次默认目录直启、自定义 cwd 包装、HTTP 均真实调用，cold 后再次直启。 | 默认包装已删；保留共享投影和必要 wire 转义。生产 Assignment 更新/撤销、相邻成员与取消副作用的完整新版本矩阵不能只靠工具调用通过。 |
| Tool / Action / Output | 共享 Tool ID、Action、命令输出与分级 Diff；Cline/MiniMax 也需要关联稀疏事件。 | 单次 edit 片段、明确 edit 新建及 write 空正文到新正文进入共享展示；write 不凭 created 文案宣称新增。 | 不将工具执行前的 Diff 当成功，不伪造多处替换行号；完整命令输出矩阵仍分别验收。 |
| Narration / Final / Missing-Send | 各协议提供权威终态，公开发送与 Missing-Send 使用共享规则。 | ACP prompt 结果与稀疏事件沿共享路径；本次四轮 end_turn 均回传实际 receipt。 | 原生 final 不等于产品公开消息已发送；本次未运行 Core 的 zero-send/accepted-send/tool→final 全链路。无需新增 Command 终态状态机。 |
| Permission / Approval / Workspace | 唯一原生审批权威；例如 Kimi 用 Session mode，Cline 用 mode 与 auto_approve。 | 五种原生 mode 经 set_mode；Command 不再由 Core 自动允许同一请求，避免第二层审批。本次使用 bypass。 | allow/deny/cancel、只读及实际目录边界仍需独立验；不能把 bypass 的 MCP 成功当作这些选项通过。 |
| Built-in rovai CLI | 当前 bundled CLI、逐 Run binding/lease 和操作目录共享。 | 沿共享 Built-in 进程上下文与租约，没有 Command 专属 CLI 或桥。 | 旧版本公开发送证据保留；本次没有 Core lease，未重跑当前完整 operation 集，不能把 MCP 当 Built-in CLI 资格。 |
| Usage / Cache / Cost | 各原生字段分别归一；Cline 可用观察来源，其他 Runtime 可能有日志 reader。 | `result._meta.usage` 解析 Prompt 四桶，Session gauge 单列；不启用 NativeUsageReader，不把 Session totals 当当前 Run。 | reasoning、request cache hit 与 Run 费用未被声明可用；1.88 字段、重发、retry/compact/cold 归属需核验。不要用额外日志扫描或估算填未知值。 |
| Retry / Queue / Cancel / Cleanup | 公共 accepted-input、epoch、队列与受管进程回收；原生差异保留在协议适配层。 | 共享实现和先回收后清理 owner；本次关闭/进程组清理后记录的 8 个 PID 全部消失。 | 正常清理不代表 in-flight cancel、崩溃、超时或迟到副作用矩阵通过；旧产品故障记录与当前共享测试分别记账，不另建 Command 清理器。 |
| Ready / Version / Platform | discovery/health 与平台资格分开；普通检查不承担全部生成验收。 | 公共版本解析器、1.88 稳定版下限、一次必需 Mod ready；普通错误保留原生分类。 | 所有平台 NotQualified。macOS arm64 本次原生 smoke 不提升 App、Intel、Windows 或 Linux 资格；不因清单增加 warm 每轮探针。 |

上述实现入口为 [Adapter Registry](../../../crates/rovai-core/src/agent_runtime_adapter.rs)、
[原生 Skills](../../../crates/rovai-core/src/native_skills.rs)、[用量归一](../../../crates/rovai-core/src/monitoring.rs)
与上一节的共享 ACP/Fleet 入口。Checklist 的 process compatibility 可由明确所属身份表达，不等于必须有
配置摘要；“配置更新生效”按当前合同的显式操作或原生加载规则验收，不恢复外部文件扫描和隐式换 Session。

### 主干后来增加的两项方案

- **原生提问**：Claude/Copilot/Qwen/OpenCode V2/ZCode 走已验证的原生禁用；Kimi 等走精确识别后的原生取消。
  Command 现在通过现有 Mod 的官方 active-tools 过滤器禁用问卷，固定 1.88 ACP 已验证 schema 移除和
  零问卷请求；普通 deny 或 enable=false 不具有同等效果。不新增问卷 UI/管理器，也不代选答案。
- **原生自动记忆**：当前产品决定专门覆盖 Claude/Codex，采用原生开关且保留会话和工程规则。
  没有依据把它机械复制成 Command 的文件隔离、目录清理或全局配置覆盖；Command 的原生能力与产品要求需分别确认。

### 旧方案的文档边界

旧 Checklist 中 one-shot/headless、私有 HOME、MCP 文件合并、BYOK 无显式选模、Preview 均已被后续方案替代。
revision 5 输入说明仍保留初次确认快照中的“再次绑定正文必须相同”“256 KiB 外层预算”与“配置/profile fence”；
本次补充其历史边界和当前 v72 路由，不改写已确认输入快照，也不重新引入已删除的实现。
结论是继续补齐有具体范围的资格证据；本次没有发现需要再增加或删除一套 Command 生命周期机制的理由。

### sub2api 真实回执补验

在 `e1e667905` 的独立 worktree 上，使用官方 `command-code@1.88.0`、Command 自己已有的
`sub2api/gpt-6-sol` 配置与认证、全新隔离 HOME/cwd、合成固定 Bootstrap、当前生产 Mod 和 argv 包装。只将隔离 Provider URL
指向透明 loopback 观察器，模型请求/响应字节不改写，不借用其他 Runtime 的凭据或重写上游工具集合。

| 场景 | 原生 PID／Session | 实际 MCP 调用与结果 |
| --- | --- | --- |
| first：默认目录 stdio | PID 46909；Session `238b1212-7ea9-4a1d-af0d-df4868f8fbd9` | 直启 MCP，父进程为 CLI；调用一次，随机 receipt 回到后继模型输入与最终答复。 |
| warm：不同目录 stdio | 同 PID／Session | 原 argv 包装切换 cwd；调用一次，完整回执闭环通过。 |
| warm：HTTP | 同 PID／Session | 调用一次，header 字面值保持，完整回执闭环通过。 |
| cold：默认目录再次调用并回忆 | 新 PID 47404；同 Session | 先精确目录确认再 load，保存的 BYOK 模型保持；回忆首轮随机 receipt，再实际调用一次取得新 receipt。 |

共 11 次前台模型请求与 1 次无工具后台请求，全部 HTTP 200；无中断请求。前台每次 System 中 B 恰好一份，
user 为零。四次 codemode 调用均以同一原生 Tool ID 关联 ACP completed 和服务器回执；搜索完成不算工具调用。
两次 Host 的 stdio cwd、空参数、空格、引号、中文和 env 字面值正确，HTTP header 正确。
关闭 stdin 并执行夹具进程组清理后，8 个已记录 PID 均不存在，隔离目录已删除；仅导出脱敏结果。
这证明当前原生 ACP 与 Mod/MCP 交付，不冒称已经经过产品 Core/App 的完整 AgentRun、审批取消或跨平台资格。

## Bootstrap 直接传输验证（2026-10-25，仅方案验证）

**固定 1.88.0 已找到并验证逐轮直接传输的候选：通过现有 ACP 调用官方 Mod 命令，更新 Mod 内存中的
Bootstrap，再由原有 System hook 交付。它通过了同 PID／Session 的 A→B→A，不只是启动参数传一次。**
本节保留 `02ac0a514` 的方案验证记录；当时尚未修改生产 binding。后续已按 User 确认实施，
见下节生产接入记录；公开资格不变。

对照 worktree HEAD 为 `9807c9261786b95cf72cf838ac5ea30d2fb99fa7`。使用官方 npm
[`command-code@1.88.0`](https://registry.npmjs.org/command-code/-/command-code-1.88.0.tgz)，实际 executable 的
`--version` 与 ACP initialize 均为 1.88.0。发布包完整性及 `dist/cli.mjs` SHA-256 记录在既有证据 JSON；
bundle SHA-256 为 `600725f967cc98f6144066c24e850d934bd4a1f503c3bf82f2bd2584a8757dfd`。
环境为 macOS arm64、独立 HOME/cwd、本地确定性模型和合成认证占位值；没有外部模型请求、真实凭据
或日常配置写入。这不验证原生账号／BYOK 认证，也不把测试 HOME 变为生产方案。

### A：实际入口与消费位置

核对[官方 CLI](https://commandcode.ai/docs/reference/cli)、[Mod API](https://commandcode.ai/docs/mods)、
[ACP](https://commandcode.ai/docs/acp)及固定发布包。官网的
[1.87.2 变更记录](https://commandcode.ai/changelog)只是查找线索，以下结论来自 1.88 包和实际请求：

| 入口 | 固定包的实际行为 | 判断 |
| --- | --- | --- |
| `--mod-option name=value` | ACP 启动路径传入 Mod host；按第一个 `=` 分开，已声明 string flag 的其余内容原样保留。 | 可交付初始正文；不是运行中更新接口。 |
| `addFlag/getFlag/appendSystemPrompt` | flags 在 Mod factory 注册后应用，hook 调用时读取 `getFlag()`；返回值进入原生 System。 | 不能在 factory 执行时提前复制尚未应用的 flag 值。 |
| Session new/load/resume、set_config_option 与 ACP dispatcher | 所检查路径没有消费 System/developerInstructions 字段；配置入口处理模型和推理强度。 | 没找到 Codex 式直接指令字段；不猜测未知参数。 |
| `addCommand` → `resolveCommand` → `servePrompt` | 已注册 Mod 命令先执行 handler；handler 不返回 `prompt` 或 `message` 时，直接回复 end_turn，不进入 runTurn。 | 官方已有通道可用于只更新内存，不生成用户／模型对话。 |
| `parseSlashCommand` | 只接受一个 text block，拒绝含实际换行的命令文本。 | 正文使用一个 JSON string literal 表达换行、引号等；不是 Shell 拼接、Base64 或分片。 |

试验 Mod 的核心如下；`rovai-bootstrap` 是本次 Mod 自己声明的名称，不是 Command 内置参数或标准 ACP 字段：

```js
let current;
cmd.addFlag('rovai-bootstrap', { type: 'string', default: '' });
cmd.addCommand({
  name: 'rovai-bootstrap',
  description: 'Set synthetic System text for the following probe Run.',
  handler({ args }) {
    current = JSON.parse(args);
    if (typeof current !== 'string') throw new Error('probe bootstrap must be a string');
  },
});
cmd.hooks({
  onSessionStart() {
    cmd.setActiveTools(cmd.getActiveTools().filter(name => name !== 'ask_user_question'));
  },
  appendSystemPrompt() { return current ?? cmd.getFlag('rovai-bootstrap'); },
});
```

试验沿用一次 ready 握手，验证后删除。以上只是验证副本；未改写生产 Mod。启动参数组用结构化 argv
传递 `acp --mod <probe-mod.mjs> --mod-option <rovai-bootstrap=合成正文>`。动态组经同一 stdin/stdout
发送正常 `session/prompt` 请求，其唯一 text 为 `'/rovai-bootstrap ' + JSON.stringify(正文)`；等控制回复后，
另发原样业务输入。没有旁路读取 stdin、额外传输服务或正文文件。

### B、C：真实 System 与同进程更新

最终复跑 PID `69932`、Session `7e1dc3b6-e11f-412e-aaf5-0fc0fab6714e`，依次为启动 A、命令 B、命令 A：

| 场景 | 实际模型请求 | 当轮 System | 用户输入／原生历史 |
| --- | --- | --- | --- |
| 首次 argv A，随后调用 read_file | 2 次，包括工具回执后的请求 | 两次均 A 一份，原生 System 保留 | 正文不在 user，业务输入原样；实际读到夹具 receipt。 |
| 同 PID／Session 更新 B | 1 次业务请求 | B 一份，旧 A 为零 | 控制操作本身 0 模型请求、0 assistant 消息，原生 JSONL 历史字节不变。 |
| 同 PID／Session 再更新 A | 1 次业务请求 | A 一份，旧 B 为零 | 同上；System SHA 与初次 A 相同，没有累计追加。 |

模型端检查的是收到的实际请求、完整正文出现次数及解码后的 user 内容，不采用模型自述。
初版夹具将 user 内容重新 JSON 序列化后搜索多行正文，检查力度不足；改为检查解码字符串并断言业务
输入精确相等后，完整 B/C/D 再跑通过。没有把该断言修正描述成原生缺陷。

### D：有希望替换的路线及边界

| 边界 | 结果 | 证据范围 |
| --- | --- | --- |
| 字符与容量 | 小正文及 10 KiB、131072 字节正文完整到达 System，均恰好一份 | ACP 命令保持中文、首尾空白、换行、引号、反斜杠、`=`、`${literal}`；没有缩小 128 KiB 预算。 |
| 启动参数容量 | 官方 npm executable 直接启动，131072 字节 argv 正文通过 | 未绕过 executable 直接运行 Node；没有走产品 Core 的 ManagedProcess/App 启动链，Windows/Linux 未测。 |
| 首次与 cold 都只走控制通道 | 空正文启动 → 控制 A → 首次业务请求；新 PID 精确 resume 同 ID → 控制 C → 业务请求，均通过 | PID `69976`→`69984`，Session `303114cf-a6a8-4177-8d8f-457c162f5f72` 不变；没有 session/list，不必保留“argv 首次＋RPC 后续”双路线。 |
| 执行边界 | 模型执行 A 时发更新 B，被原生以 -32600 拒绝；当前请求仍为 A，结束后更新 B 生效 | 证明按 Run 间隙更新可行；运行中不能用此方法 steer，也不需要新增锁来模拟更新。 |
| 同值重送 | 连续两次交付 B 均无模型／历史副作用，后继请求只含 B 一份 | 这是原生控制重送，不是完整 Core 故障重试验收；Run 冻结字节仍应来自已有 Context。 |
| 工具组合 | 保留问卷过滤，普通 read_file 和一次真实 MCP ping 均通过 | MCP tools/call 计数为 1，`ROVAI_MCP_PROBE_OK` 进入后继模型请求；不是仅 discovery 成功。 |
| 取消与清理 | 原生 session/cancel 返回 cancelled；记录的 Host 进程组与 MCP 子进程均已退出 | 夹具关闭 stdin，并沿既有试验进程组清理；不把它替代生产 ManagedProcess 全故障矩阵。 |
| 正文中转文件 | Mod 不读写 binding，所有 Host 的握手材料目录最终为空 | 仍有试验 Mod、ready 的短暂写入、CLI 原生配置／历史和测试脚本／日志；不是“完全没有文件”。 |
| 正常日志／参数采样 | 正常启动、更新、取消的 stderr 未观察到完整合成正文；非空 argv 的启动后和 initialize 后 ps 采样未显示正文 | 原生设置 process.title；采样不能保证启动窗口、系统审计或其他平台不可见。Core 诊断、公开 command 与 UI 未做端到端验收。 |
| 错误正文可见性 | 故意传无效 JSON，ACP -32603 错误与 stderr **会包含合成输入片段** | 裸 JSON.parse 异常不可直接作为最终错误文案；失败没有模型／历史副作用，下一轮仍用原 A。此项不是隐私全通过。 |

最终 B/C/D 与错误路径复跑共记录 16 次前台本地模型请求；10 次成功控制操作全部没有额外模型请求、
agent_message 或历史写入。工具 schema 查询的前期探索与最终 tools/call 分开，不将查询算作调用。
这些结果是 macOS arm64 原生夹具证据，未运行完整 Core/App；当前无跨平台资格变更。

### 是否值得替换，以及最小范围

**当时建议采用“官方 Mod 控制命令”进行后续最小替换；该报告提交不改生产 binding。**
本轮已证明每轮 Bootstrap 可通过已有 ACP 通道到达 System，无正文中转文件、无额外对话或模型请求；
没有发现标准 `developerInstructions` 对应字段。它在“已有通道逐轮交付”的目标上可行，接线形式与 Codex 不同。

后续若实施，范围只需落在现有 Mod 和 Run 发送前的 Bootstrap 交付点：Mod 接收字符串并保存在内存，
Core 先等控制回复，再提交原始业务输入；首次、warm、cold 都用这一条通道。这样可删除 binding 正文
序列化、写入／rename、Mod 文件读取与正文 SHA；继续保留现有 Mod、问卷过滤和一次 ready。
代价是一轮既有 ACP 控制往返、一次 JSON 编解码和一个内存值；没有测量性能，不能宣称必然更快。

接入时仍需核对三个具体边界：控制回复的 end_turn／usage_update 不能归约成业务 Run 终态或新增用量；
解码失败应沿已有错误路径返回固定说明，避免原始解析异常带出正文；Mod 闭包是进程级状态，本次只验证
同一 Host 的根 Session，与当前按 Native Binding 隔离 Host 的生产范围一致，不证明跨 Session／子代理隔离。
这些是有限的接线与语义确认，不要求新锁、缓存、扫描、控制服务或自动 fallback。`02ac0a514` 时生产
接线尚未执行；下节记录后续实施与回归，不把这份早期试验改写成当时已完成生产接入。

## Bootstrap 直接交付的生产接入（2026-10-25）

User 确认 `02ac0a514` 的方案后，在同一独立 worktree 完成最小替换。生产路径现在是：

```text
建立／恢复精确 Session
→ 普通 ACP RPC：/rovai-bootstrap <JSON string>
→ Mod 解析并检查局部值，成功后替换内存正文
→ 等待控制 end_turn
→ 原始业务输入 P
```

首次、warm、cold 都只走该路径；没有正文 argv、文件 fallback 或新的传输服务。Mod 仍通过官方
`--mod` 加载，ready 改用交付 revision v2，在命令和 hook 都注册后写入，校验后删除。
稳态只有 `rovai-bootstrap.mjs`；删除正文 bindings 目录、文件序列化、临时写入、rename、读取、
SHA-256、文件名专用 Session ID 限制及旧的缺失／损坏文件退出分支。共享 Context Evidence 与
Native Binding/Run 所属检查不变，没有数据库迁移或模型上下文 revision。

`AcpRuntime::bind_managed_bootstrap` 复用普通 `rpc`，对应 `PendingRpc::Response`；准备后的 Session
处于既有 Ready 状态，控制期间的 usage/mode 通知沿 Session metadata 分支处理。控制 `end_turn`
只唤醒调用者，不生成业务接受、终态、输出或用量；非 end_turn／RPC 失败直接返回准备错误，调用方
在业务 materialize/dispatch 前退出。没有新增控制状态机、队列、锁或更改 pending/取消/退出排序。

Mod 先解析到局部变量，沿用非空字符串和 UTF-8 128 KiB 正文限制，再替换一个内存值；失败固定返回
`command_code_bootstrap_invalid`，不回传解析异常、输入片段或正文。hook 直接返回该值。成员编辑
不触碰当前 Run，后继 Run 仍使用共享 Context 已为其冻结的 B；没有跨 Host 内容管理或摘要复用条件。
现有 Host 由根 Native Binding 隔离；未将这次根 Session 验证扩展成多 Session／子代理隔离承诺。

### 实际生产路径验证

官方包身份仍为上节的 1.88.0，CLI `--version` 与 bundle SHA 均核对一致；本次生产 Mod SHA 为
`bca8cadca01d225914b2c6b7ee8b1f201db593a05df47206dcb917caf77379ea`。
复用并更名既有 ignored 原生 owner，实际走 ManagedProcess、AcpHost、AcpRuntime 和生产 Mod，
不是仅用另一个 Python ACP 客户端验证原理。一次性隔离 HOME/cwd、本地确定性 Provider、合成认证占位值；
没有外部模型调用或日常 App/配置写入。未启动完整 Core/App。

| 场景 | 结果 |
| --- | --- |
| 首次与 warm | PID 80689、Session `05ace62d-09b0-47c9-b9c7-d771ab304246`，A→B→A，每次实际 System 正文一份、无旧值累积，原生 System 保留。 |
| 工具后的请求 | 首轮真实 read_file 回执进入下一次模型输入，该次仍含同一 A 一份。模型工具集合为 12，问卷工具不存在。 |
| 完整预算 | 同 PID/Session 的 131072 字节引号正文完整到达；ACP 双层 JSON 编码没有造成截断或第二道封装预算。 |
| cold | PID 80699 直接恢复同一 ID，控制交付 C 后再执行业务输入；无 session/list 或正文文件。 |
| 原生设置 | 保留旧 owner 的五种 Session mode 与显式 BYOK 选模检查；首次和 cold 均通过，模型为本地夹具 `rovai-probe/model`。 |
| 无效控制 | 四次非法 JSON／数字／null／对象返回固定错误，原生错误和收集的 stderr 不含合成坏输入；正常后继 Run 继续通过。失败保留旧内存值另由生产 Mod Node owner 覆盖。 |
| 业务分流 | 五次成功控制都没有业务事件；五个原始 user 输入各接受一次，各自终态只对应实际业务请求。协议 owner 另覆盖控制 usage/mode、错误和 cancelled，不发送后续业务输入。 |
| 模型与历史 | 六次前台请求均校验 System/user；另一次原生标题请求单独记账。原生 JSONL 不含控制命令或非法控制参数。 |
| 材料与回收 | 每次控制与业务轮后 Host 目录只含 Mod，ready 已删除；两次 Host shutdown 都删除其材料，受管进程记录无残留文件。三轮验收记录的六个 PID 均退出，完整隔离目录已删除。 |

首次 Rust owner 已通过；观察器把额外无工具请求先标为未知。补采样确认其 System 明确用于原生会话
标题生成，输入为首轮业务 user 和 assistant 结果，随后独立记账，不归因于控制命令，也未改生产代码。
最终复跑仍为六次前台请求加一次原生标题请求，通过全部正文／事件断言。
默认 `cargo test --workspace` 整套通过：核心 431 通过、1 忽略，其余目标 46 通过，doc-tests 通过；
定向 extended Rust 5 通过、1 原生 owner 默认忽略，该原生 owner 已显式运行三次并通过。Node Mod 1 项、
文档测试 10 项、`cargo check --workspace`、格式、差异和基于 PR base 的文档治理均通过。

### 旧路径退役与验证归属

扩展原有 Rust/Node owners，没有增加 Rust 测试函数或仓库文件。Command HOME/控制 owner 承接编码
与预算；共享恢复隔离 owner 承接控制回复归属；真实 ignored owner 承接首次/warm/cold；Node owner
承接先验证后替换与错误脱敏。Cline 的长正文文件测试继续保留，删除其中不再有生产消费者的 Command
文件分支。旧文件缺失、坏 SHA、路径命名和多个正文文件的断言退役，不搬成新内存管理机制。
完整测试归属见[测试指南](../../development/testing.md#command-code-188-简化测试归属2026-10-24)。

本次没有重跑 MCP 或外部真实模型；前次同一官方通道的 MCP/取消证据仍单独保留。共享回归不替代
完整 Core/App、Windows/Linux、子代理范围或平台资格；当时 Command 继续所有平台 NotQualified。
没有测量延迟、CPU 或内存，准确收益是删除正文文件及读写责任，代价是每 Run 一次现有 ACP 控制往返。

## 验证记录

脱敏数据见[原生接入证据](evidence/command-code-native-simplification-2026-10-24.json)。

自动验收使用新建私有 fixture，官方 npm 1.88.0；日常 1.66 安装、配置和 App 未修改。
原生控制探针确认 `--mod` ready 的 revision/nonce/PID，随后删除 ready；原生同名定义优先，stdio 自定义
cwd 正确。未转义 ACP `$${literal}` 被原生变为 `${literal}`；wire 转义一次后 stdio env 与 HTTP header
均原样收到 `$${literal}`、反斜杠、引号和 shell 字面字符。load/resume 对随机不存在 UUID 仍成功，初始
实现曾据此保留目录预检；本页后续已按原生尽力恢复删除该预检，不改写这一原生行为记录。

真实 sub2api/gpt-6-sol 经官方 Mod + ACP stdio/HTTP 两组，各实际调用工具一次、返回本次随机 receipt，
receipt 回到后继模型输入并由最终 ACP 答复返回。两组各 3 次前台模型请求均 HTTP 200；所有前台请求的
System 包含 Bootstrap，user 不含。增加完整字符串出现次数计数后，两组再次各调用工具一次，
每次前台 System 中 B 恰好一份，user 为零。两轮各有 1 次无工具后台请求在 fixture 关闭时中断，单独记账。
原生使用 codemode 调 MCP，不能以 tools 数组缺少直接 MCP schema 判失败；证据关联原生工具调用 ID、
目标引用、服务器实际请求和随机回执。

同一原生 Session 经一次 warm 与两次 cold 仍能精确回忆先前随机回执，保存的 BYOK 模型未被覆盖。
再将该 Session 的分配 MCP 从 stdio 替换为新 HTTP endpoint，冷恢复仍使用原 ID/冻结 binding。
首个探针没有重设权限，客户端拒绝原生 permission 请求，工具零调用；按生产路径调用 `session/set_mode`
后，新 endpoint 实际调用一次并返回新回执。此失败及修正均保留，不把模型返回 UNAVAILABLE 算作成功。

隔离 fixture 的进程已退出，复制的凭据和原生历史随整个 fixture 删除；只导出明确白名单证据。
本记录不声称隔离 App 或 Windows/Linux 资格通过。完整资格仍按现有流程补齐。

PR 后续控制边界回归在隔离夹具中完成：42 项定向 Rust 测试通过，1 项既有真实账号 smoke 按条件忽略。
覆盖 cold callback、Command 入口变动/禁用/删除、MCP 成员范围与 no-op、导入、Fleet 取消/回收及旧 Binding。
两处初始测试预期（setMembers 自动启用、入口验证不额外探测版本）已修正，保留在证据中。
本次跟进未重新调用真实模型；上文原生 1.88 证据与公开资格边界不变。

默认工作区整套两次均为核心 428 通过、1 个既有 Cursor 身份探针超时、1 忽略；该探针在同一个工作区
测试二进制中单独复跑通过（0.32 秒）。其余工作区目标分开运行 46 项通过，doc-tests 通过。保留整套
超时记录，不把单独复跑算作整套全绿，也未修改 Cursor 探针代码或超时阈值。

2026-10-25 四项修复的定向回归 5 项 Rust 通过、1 项既有真实账号 smoke 忽略；既有 Mod Node owner 通过。
覆盖 binding 内容变化后继续复用、转义正文、环境保存事实及 Command/Kimi 真实 probe 入口的三类模拟错误；
既有 dispatcher/Fleet 的 MCP 退役回归也通过。成员环境的退役条件通过代码核对，没有为绕过公开资格新增测试入口。
工作区全目标 slow-tests 编译、格式检查及文档门禁通过（文档测试 10 项）；未重跑全套或真实模型/MCP。
该轮零新增仓库文件、生产文件种类和 Rust test owner。

同日六项审查修复的 8 项定向 Rust 回归通过，安装写入/Fleet 并发 owner 在最终代码再次通过。
覆盖数据库锁释放后等待启动、同命令 replay 与相同目标新命令、程序入口暂时移走时旧字段保存重试、
版本文本、有效 MCP 成员变化及关闭状态导入、共享 ACP 复用与认证错误分类。
启动设置的锁作用域由调用链复核；并发夹具使用共享安装写入路径，没有绕过 Command 公开资格。
`pnpm typecheck`、`pnpm test` 通过：Vitest 2992 通过/2 跳过，主 Node suite 358 通过/2 跳过。
`cargo check --workspace` 与格式检查通过。默认工作区为核心 429 通过/1 个相同 Cursor 探针超时/1 忽略，
同一二进制单独复跑 Cursor 通过（1.01 秒）；未修改其实现/超时，也不把整套标绿。
其余工作区目标分开运行 46 项通过，doc-tests 与文档治理通过；失败测试的临时夹具已删除。
本轮没有新增仓库文件或生产文件种类；增加一个无 I/O 的版本解析 owner，其余扩展既有 owner。
未重跑真实模型/MCP 或平台资格，完整证据继续见上面的 JSON 记录。

同日基于 `abf8f4cdc` 的收口复核只修改两处代码注释及既有报告/导航，没有新增文件、测试或 Runtime 行为。
文档治理（含 10 项测试和真实 base 差异检查）、Rust 格式检查通过。提交前默认 workspace 再跑为
核心 429 通过/1 个相同 Cursor 身份探针超时/1 忽略；同一二进制单独复跑通过（0.25 秒），其余目标
46 项及 doc-tests 通过。仅清理本次失败夹具，不改 Cursor 探针或阈值，不把整套标绿。
本次身份生效时机为共享合同与生产调用链核对；没有新增真实模型/MCP 或跨平台验收。

同日 stdio 默认目录跟进：新增的纯 wire owner 通过；最终 `pnpm test:rust:pr` 整套通过，核心 431 通过／
0 失败／1 忽略，其余目标 46 通过，doc-tests 通过。之前超时的 Cursor 身份探针本次在整套中通过，
此前失败记录保留。`cargo check --workspace`、格式检查、10 项文档测试及文档治理通过。
官方 1.88 的新建／恢复 stdio 控制探针见上节；增加一个无 I/O 的 Rust owner，零新增仓库文件或生产文件种类。
未重跑模型工具调用、App 或跨平台资格，也未测量性能。

同日 sub2api / Checklist 跟进仅更新四个已有文档/证据文件，生产逻辑与 Rust test owner 不变。
10 项文档测试、文档治理、格式与差异检查通过。默认 workspace 首跑核心 429 通过／2 失败／1 忽略：
一项为本轮编辑兼容性登记表导致冻结证据字节不匹配，已撤回该处编辑，保持原有资格 revision，
新结果仅写入本页和既有 JSON；同一 workspace 配置重编译后该 owner 通过。
另一项为相同 Cursor 身份探针超时，同一 workspace 二进制单独复跑通过（0.30 秒）；未改其实现或阈值。
其余目标 46 项和 doc-tests 通过；首跑失败记录保留，不将分项复跑描述为整套全绿。
仅清理本轮产生的失败测试夹具；真实 sub2api 的四轮与原生验收清理结果见上节。

同日 Run 边界收口：最终 `cargo test --workspace` 整套通过，核心 431 通过／0 失败／1 忽略，
其余目标 46 通过，doc-tests 通过。Command、恢复隔离、Skills 来源、Diff 映射、原生错误分类、权限
取消及长正文的既有定向 Rust owners 通过；真实账号 owner 仍按条件忽略，既有 Node Mod owner 通过。
中间夹具修正保留 Command/TRAE 各自输入接收顺序，并退役 Command 整 Host 正文不变的旧断言；
未修改共享锁、事件顺序或其他 Runtime 的生产交付方式。没有新增 Rust 测试函数或仓库文件。
10 项文档测试、基于 PR base 的文档治理、格式和差异检查通过。官方 1.88 的六个记录进程组均已退出，
隔离材料已删除；本轮没有外部模型请求、Renderer 点击验收或平台资格变更。

同日直接传输跟进仅追加本页与既有证据 JSON，不改生产代码。最终原生复跑结果见本页直接传输验证；
所有记录进程组与 MCP 子进程退出后，精确删除本次隔离根目录。`cargo test --workspace` 整套通过：
核心 431 通过／0 失败／1 忽略，其余目标 46 通过，doc-tests 通过。10 项文档测试、当前文档治理、
基于 PR base 的差异治理与差异检查通过。没有创建新仓库文件或提高公开资格。

## Windows npm 入口的 Bootstrap PID 归属修复（2026-10-25）

Windows 真机验收中，官方 `command-code@1.88.0` 的检查和模型目录正常，但实际 Run 在发送模型输入前
返回 `command_code_bootstrap_readiness_invalid`。独立原生对照确认 revision、nonce 一致；受管根是
`cmd.exe`，Mod 上报其 Node 进程 PID，两者正常不同。原先把上报 PID 与受管根 PID 直接相等比较，
不适用于已支持的 Windows command shim。

本次改为由 Managed Process 在其精确 Job handle 上证明上报 PID 是存活成员；非 Windows 保留根 PID
等值要求。ready 的 revision、一次性 nonce、正 u32 PID 和消费后清理继续执行。查询失败、外部进程或
退出进程仍拒绝；不枚举进程、不缓存后代、不暴露 OS handle。握手查询结束即释放 child guard，再进入
失败 shutdown，保留现有锁顺序与进程树清理。没有修改 Mod wire shape、Bootstrap 正文或平台公开准入。

扩展既有 ready owner 和 Windows Job 生命周期 owner，归属和最小命令见
[Command Code 测试归属](../../development/testing.md#command-code-188-简化测试归属2026-10-24)。
Windows x64 真实模型复验使用同一补丁构建的 debug Core/CLI、官方 Command Code 1.88.0、独立 D 盘
数据／Skill Library／原生 HOME 与 sub2api `gpt-6/xhigh`。仅隔离 Core 启用既有逐 Adapter qualification
override；正式平台准入不变。以下五项均通过完整 Core AgentRun 与公开消息链路验证：

| 场景 | 结果 |
| --- | --- |
| 首次 Run | 真实读取未知随机文件回执，按 System 身份前缀发布公开消息；Runtime 请求使用 xhigh。 |
| warm Run | 编辑成员工作原则后，新指令生效；包装／Node PID、Native Binding 和 Session 均不换。 |
| 文件操作 | 真实写入、编辑并读取工作区文件，最终字节与公开消息相符。 |
| cold Run | 正常关闭 Core 后重启，新包装／Node PID 恢复精确原 Session 并回忆首轮随机回执。 |
| 取消与后继 | 真实模型请求开始后取消，随后新的 Run 成功回复；两个 Core 生命周期的所属进程全部退出。 |

已扩展的 ready 与 Windows Job 定向 owners 通过；原生登录副本在结束后删除，原 mcode 配置哈希未变。
Command Code 1.88.0 原生 MCP 的 Windows 路径／argv 问题属于另一项，本修复未改其投影和启动逻辑。

## macOS 双架构开放（2026-10-25）

User seq61 要求 macOS 两个架构开放。以主干 `51da43668fa9b9e50cd94c86a29825db8666f79a` 为基线，
在独立 worktree 的 `rovai/command-code-macos-preview` 分支实施；本项是公开准入调整，不新增原生模型验收结论。

| 平台 | 当前准入 | 行为 |
| --- | --- | --- |
| macOS arm64 / Apple Silicon | Preview | 允许正常发现、配置、检查和执行。 |
| macOS x64 / Intel | Preview | 同上；不将本机 Renderer 平台夹具当作 Intel 真机证明。 |
| Windows x64、Linux x64 | NotQualified | 沿现有平台限制，不因可见目录恢复而开放执行。 |

两条 Preview 行保留 `qualification_evidence_missing` 与空 evidenceRevision，不增加资格文件。
最低版本仍为 1.88.0 稳定版。共享可见目录恢复设置、新手引导、队员/Skill 选择和监控入口；
安装引导仅链接 [Command 官方说明](https://commandcode.ai/docs)，不增加安装脚本或认证探针。
App CLI 删除 Command 的旧全平台拒绝分支，配置请求交由 Core 判断目标平台；Cline 继续暂缓公开。
界面使用现有状态与检查详情，不增加常驻实验标签。没有更改 Bootstrap 传输、Host/Session 生命周期，
也没有新增生产文件、锁、池、缓存或监听器。当前决定见 [V1.72-D60](decisions.md#v1-72-d60)。

验证复用现有 owners：前端全套 256 文件 / 3005 项通过、2 项既有跳过；TypeScript 与桌面/Web 构建通过。
隔离 Electron Runtime Picker 实际选中 Command 并保留原生默认模型，原有键盘、IME、日夜主题、尺寸及
200% 缩放回归通过；其 userData 位于独立临时目录，不启动 Core/Skill Library/真实 Runtime，结束后已清理。
最终 `cargo test --workspace --quiet` 通过：Core 431 项通过、1 项既有忽略，其余目标 46 项通过，
doc-tests 通过；其中 App CLI 31 项包含 Command 原生默认配置解析。文档治理测试 10 项、格式检查及
基于上述 base 的 `docs:check:ci` 通过。
兼容性清单更新同步既有 register revision，平台证据 owner 五项复验通过；Command Preview 不引用该摘要，
也不恢复配置摘要式 Host/Session 判断。

未新增 Intel 原生模型、完整 macOS Core/App、子代理或跨平台 MCP 资格验收；已有原生证据仍见本报告
前文。本次不安装、重启或改写日常 App，也不自动升级 Command。Preview 开放和完整资格通过分别记录。

## Windows Preview 开放（2026-10-25）

按 User 后续要求，把 Windows 补验和 macOS 开放提交 `3c5d6343c` 一起交付；Windows x64 同样采用
Preview，Linux 仍关闭。最低稳定版 1.88.0、原生 HOME/Mod/ACP/Fleet 及共享产品入口保持。
前文 macOS 开放时“Windows 仍 NotQualified”是该提交当时状态，由本节更新。

真实模型测试使用已含 Bootstrap PID 修复的主干 `51da43668` debug Core/CLI、官方 Command Code 1.88.0、
独立 D 盘 Core、Skill Library、MCP config 与原生 HOME。仅该隔离 Core 使用既有逐 Adapter qualification
override；模型为本机 sub2api `gpt-6/xhigh`。开放补丁只调整准入/入口，不修改上述执行链。
脱敏证据见 [Windows Preview 实测](../../research/command-code-runtime/windows-preview-2026-10-25.evidence.json)。

| 补验场景 | 观察结果 |
| --- | --- |
| Skill 与分配 MCP | Core Run 实际读取 Skill 随机回执并调用 MCP echo；两个回执进入公开消息。 |
| 更新与撤销 | 修改 Skill 与 MCP 后，下一轮采用新回执，Binding/Session 保持；撤销后搜索无工具且零新增 MCP 调用。 |
| 正常关闭与恢复 | 所属 Runtime/MCP 退出；重启后恢复精确 Session，重新读取 Skill 并调用更新后的 MCP。 |
| 原生手动压缩 | 真实摘要将 16 条消息压为 5 条；压缩后与 cold 恢复后均保留随机记忆和最新 System。 |
| 权限拒绝 | 持久回执为 user_selected_deny，目标文件不存在。 |
| 强杀与后继 | MCP hold 已开始时只强杀隔离 Core，Job 回收后代，35 秒延迟写入未发生；重启后新 Run 成功。另测模型请求中强杀，Runtime/MCP 同样退出且后继恢复。 |

八项正向/恢复检查通过，拒绝分支独立核对。拒绝写权限时，1.88 原生可直接以 end_turn 结束，不继续生成
公开最终消息；Core 如实报告 runtime_missing_final_output，本项不计作成功发布的 Run。最初权限脚本
把原生 reject_once 当作公开 kind，又读取未公开的内部字段，两项假设已纠正，失败记录保留。
短历史的两次手动压缩返回 Nothing to compact yet，也不计作成功；补足原生 30000-token recent tail
与较早消息后才获得真实摘要证据。

官方 Windows ACP 独立对照已确认：MCP executable 绝对路径含空格可启动失败，复杂 argv 可被拆分；
普通 `node` 与简单参数可实际调用。这是未经过 Rovai 时同样存在的限制，本轮不修改用户上游安装包。
阈值/溢出自动压缩、完整 Skills 变体/成员隔离、Usage/成本及完整资格矩阵仍未闭合，因此保留
qualification_evidence_missing 与空 evidenceRevision，不晋升 Qualified。临时登录副本已删除，
记录的所属进程全部退出，原 mcode 配置哈希未变。

准入扩展复用既有 Windows/macOS/Linux 矩阵、App CLI、App、OnboardingFlow、member-runtime-apply 和安装/监控
owners，无新增 Rust 测试函数；归属见[测试说明](../../development/testing.md#command-code-188-简化测试归属2026-10-24)。
正式 release 无 override 的准入、已安装 App 和本机数据保留由安装回执另记；debug 模型证据不替代它们。


## Linux x64 目标机验收与开放（2026-10-25）

独立目标机使用官方 1.88.0 与真实 Sub2API，Core 数据、Skills、MCP 与原生 HOME 均隔离。
[验收报告](../../research/command-code-runtime/linux-acceptance-2026-10-25.md)区分真实模型、浏览器、
受控故障、已接受差异与未覆盖范围。维护者要求本次 Linux 开放与上述 macOS 分支一同交付；
采用同一 Preview 状态，稳定版下限、原生配置和共享生命周期不变。前节的平台表保留 macOS 开放时的事实。

## write_file 行级 Diff（2026-10-26）

User 的实际 1.88 会话只显示一次写入，尽管原生已提供完整新正文与 created 成功回执。核对固定包的
`createWriteFileTool`：该回执只在原先不存在或旧正文为空时返回，非空覆盖返回 updated 回执。
因此“无法区分新文件与已有空文件”不妨碍计算空正文到新正文的行数。

在 `rovai/command-code-write-diff` 独立 worktree、`origin/main` 基线 `db8cd6e34` 上补齐现有
Command normalizer：同调用成功回执与非空 content 生成 `oldText:""` 的完整 update。共享 Diff、
Activity 和 Files Changed 自动获得行数与可展开正文；保持未知的文件创建身份，不增加 Renderer 分支、
文件读写、扫描、锁、协议或数据库迁移。空 content 保留操作，不把可能的新建空文件误写为 no_changes。
只作用于新 ingress；历史已存的 operation-only 证据不回填。

扩展现有 `acp_tool_events_expose_only_the_public_command_and_payload_digests` owner，修复前成功 write
案例失败、修复后通过；同时验证成功 edit 新建仍为 add，write 为 update、`+2 / −0`，CRLF 与中文空格
路径保真，以及失败／未完成／异路径／未知回执／非空覆盖／空 content 的回退。
该变更不改变 Activity 分类或公开 schema，不新增测试 owner；本轮没有重跑真实模型或完整 App 验收。

验证在 macOS arm64 独立 worktree 中完成：

| 检查 | 结果 |
| --- | --- |
| 定向 ACP 映射 owner | 修复前失败、修复后通过；未增加测试函数。 |
| `pnpm typecheck`、`pnpm test` | 通过；Vitest 256 个文件、3005 项通过/2 项跳过；Node suite 358 项通过/2 项跳过。 |
| `cargo fmt --all --check`、`git diff --check` | 通过。 |
| `pnpm docs:test`、`pnpm docs:check`、`pnpm docs:check:ci` | 通过；CI 文档门禁使用本节记录的 base。 |
| `pnpm test:rust:pr` 首次 | Core 430 项通过、1 项失败、1 项忽略；失败为 `runtime_probe_process::tests::successful_leader_with_stdio_holding_descendant_finishes_bounded` 的 `runtime_probe_stdout_cleanup_timed_out`，单独重跑通过。 |
| `pnpm test:rust:pr` 完整重跑 | 保持原命令及测试设置，通过：Core 431 项、CLI 31 项、Host 4 项、Web 11 项，共 477 项通过、1 项忽略。 |
| `pnpm test:rust:extended` | Core 1027 项通过、1 项失败、8 项忽略。`acp::tests::client_terminal_rejects_invalid_cwd_and_cleans_a_run_session` 在 `bridge.is_empty()` 断言失败；使用同一测试二进制单独重跑通过。 |

上述两个首次失败都在未修改的进程清理路径，不是 Command Diff 映射用例；仍保留完整命令的失败结果，
不以单独重跑通过宣称扩展 workspace 全绿，也未修改清理代码或测试阈值。

交付 worktree 为 `/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-command-write-diff`，
分支 `rovai/command-code-write-diff`，base `db8cd6e34aa9e0348fa750020105acf8f04869fd`，状态 `ready`。
按 User 的分支交付约定推送并保留此 worktree；后续 PR、合并与本机安装另按明确指令执行。
