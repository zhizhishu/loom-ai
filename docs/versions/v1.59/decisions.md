---
document_type: version-decisions
version: v1.59
lifecycle: historical
authority: decision-rationale
last_updated: 2026-09-18
---

# v1.59 版本决定

<a id="v1-59-d01"></a>
## V1.59-D01：唯一 Rust Host，按语义保真检查点接入 Web

- 状态：accepted
- 日期：2026-09-11
- 当前权威：[统一 Rust Host](../../architecture/unified-rust-host.md)

独立 Server 和 Desktop Web 需要同一业务、恢复与权限事实。另建 Node Server 或第二份 Core 会产生双重
调度、状态与迁移成本。选择把现有应用运行层嵌入同一个 Rust Host，并让 Axum 模块只消费既有服务句柄。
旧 Desktop 先通过共享运行层回归，再迁本机 IPC，避免 HTTP 并发暗中改变原普通串行命令语义。

代价是必须逐项交代 Main 后台职责，三平台各自验证 Runtime 与环境；共享代码不提供兼容性证明。
首轮只补草稿归属、上传引用、显式会话认证；控制面威胁模型按下文最新确认执行，保留 source reference 弱持久性。
不采用跨端同步、永久上传资产、通用沙箱或新的基础常驻服务来替代这些具体边界。

2026-09-12 用户补充明确：统一 Rust 解决领域与执行权威，生产 React 页面复用解决共同业务交互。
独立只读 Web 的列表和主题复用不能作为阶段 1–3 完成证据。保留 Host/Core/Axum，先做生产组件对照稿，
确认后依次完成共享 Camp、真实写入、双入口与逐页业务能力；Mobile/扩平台/发布优化暂停。
安全发布阻塞与页面复用缺口分开，等待安全决策时继续受控本机 UI 与非发布测试。

同日用户通过方向评审，要求立即接入实际 Web。采用从原生产 App 提取的 BusinessApp 协调导航、刷新和操作，
两端显式注入客户端与资源能力，不以目录重组或 fixture 入口一致作为完成标志。浏览器设备快捷键与 Host 的
Runtime/OS 投影分开；SSE 失效通知进入共同的授权重读路径，不广播内部事件全集。

短期认证 Session 与长期于本次页面生命周期的编辑身份分开：同 Owner 重新登录保留输入与原命令核对，
编辑身份的恢复需要新管理认证及 Core 校验的独立证明。不同标签页不共享草稿；不建立跨端同步服务。
待发送仍是同一 Camp 的 FIFO，另一客户端可明确接管现有编辑占用并轮换令牌，不能隐式读取或合并其未提交编辑。
Web 上传仅创建临时 source ref；Core 接受后的源文件寿命不随退出、发送失败或删除引用而变化。

同日用户正式收敛为“单 Owner、可信自托管 Host”：取消目录预授权名单、一次性令牌展示和唯一手填访问地址，
允许 Owner 直接使用 Host 有权访问的目录。多接口发现只影响地址呈现，198.18/15 不作为默认 LAN 推荐而非禁用。
令牌保留在 Host 进程内以便重复查看，重新生成独立撤销旧会话。由此明确接受同 UID 恶意进程风险，不再以原
S1 系统级隔离证明为交付前置，也不实施 AppContainer/Landlock 等强隔离工程。历史失败不改为通过；网络认证、
跨站/内容保护、文件校验、限额及 Runtime 既有权限审批继续有效。优先验收另一设备登录后选择目录并继续工作。

2026-09-13 用户进一步收紧地址发现：198.18.0.0/15 不是本产品的 VPS／公网目标，直接从发现结果排除，
不展示、复制、扫码或推荐，不增加特殊入口。此呈现规则替代前述“不默认推荐但可选”，不改变网络层接入规则。
设置页按现有风格简化为“远程访问”开关与地址、令牌行；最初二维码仅含地址，后续扫码登录决定如下。

同日用户明确将 Desktop 二维码升级为扫码直接登录：普通地址分享仍不含凭据；显式扫码登录允许
fragment 携带两分钟一次性票据，禁止长期管理 Token 和已有浏览器 Session。这一决定替代旧的
“所有二维码只能含地址”约束。统一 Rust Host 负责签发、原子兑换、到期和重新生成／轮换／关闭失效；
前端立即清除 fragment 后 POST，复用原 Session 与草稿证明机制，不建设账号或设备管理系统。

随后用户确认端口常驻、修改在下次启动生效；开关不再要求本机／远程选项，关闭无需二次确认。
开启后分别标注本机与远程地址，各自提供复制、二维码图标；沿用会话区复制图标和设置页风格。
端口的未应用编辑属于前端窗口状态，不改变 Rust 当前监听、认证或会话生命周期。

用户随后要求令牌栏常驻且移除环形箭头按钮。管理令牌的寿命因此归于 Host 进程，关闭监听不再清空它；
同一 Host 再次开启沿用原令牌，但旧浏览器 Session 仍失效。设置页只保留显隐和复制，底层显式轮换操作保留。
本轮不增加跨 Host 进程重启的令牌存储。

<a id="v1-59-d02"></a>
## V1.59-D02：原生 Server 独立数据根与安装归属

- 状态：accepted
- 日期：2026-09-13
- 当前权威：[统一 Host 的原生 Server 数据与分发](../../architecture/unified-rust-host.md#原生-server-数据与分发)、[Host Lifecycle v2](../../contracts/host-lifecycle-v2.md)

共享 Host 不意味着 Desktop 与独立 Server 共用数据或程序安装。把 Desktop SQLite 迁往 `.rovai` 会扩大
迁移范围；让 Server 的库、MCP、Skills 和实例文件继续散落在 Desktop 关联目录，又使部署和备份边界不清。
最终保持 Desktop 现状，独立 Server 使用 `~/.rovai-server`，一个 data-dir 决定所有自有持久位置。
该决定明确替代较早的 `~/.rovai/server` 建议，不做自动 Desktop 接管、数据同步或通用迁移平台。

两者使用共享 Rust 路径解析与存储实现。旧预览布局给出兼容提示，不能静默另起空库。独立 Server
管理令牌持久在自有根内以支持重启和程序更新；前述 D01 的进程内令牌规则继续适用于 Desktop，
不再限制独立 Server。Web Session 仍受进程代次和既有撤销规则约束。

正式部署采用 GitHub Releases 原生预编译包，程序与配套 WebUI 按安装归属更新。相较依赖源码构建或
容器作为前置，原生包降低用户部署依赖，并保留未来的分发渠道选择。代价是必须维护每个原生目标的
库基线、资产校验和安装验证，不能以共享代码或 CI 构建代替资格。Docker 完全移出本轮任务，不作为
可选阶段或 Mobile 前置；不另建 Node/Bun 服务端或独立业务后端。

<a id="v1-59-d03"></a>
## V1.59-D03：新对话默认队伍按 Host 归属

- 状态：accepted
- 日期：2026-09-13
- 当前权威：[Host Web v2](../../contracts/host-web-v2.md#shared-creation-preferences)、[Camp Activation](../../architecture/camp-activation-lifecycle.md#component-authority)

共享页面最初把整份通用设置当成浏览器展示偏好，导致同一 Host 的默认队伍和一键创建行为与 Desktop 分叉。
用户要求带入现有设置。选择由当前 Rust Core 保存这组创建偏好，Desktop 旧值只导入一次，保留其他展示偏好的客户端归属。
不采用重复复制浏览器 localStorage 或长期转发到 Electron Main：前者会继续产生冲突，后者使独立 Server 缺少同一持久入口。
代价是增加小型 Core 偏好记录及一次性导入边界；共享的是创建选择，不共享 Composer 草稿或不同实例的数据。

<a id="v1-59-d04"></a>
## V1.59-D04：Web HTML 附件使用共享查看器与不透明源沙箱

不透明源与存储隔离部分已由 [V1.59-D09](#v1-59-d09)取代；保留下述原始理由用于追溯。

- 状态：accepted
- 日期：2026-09-13
- 当前权威：[统一 Host 的用户文件](../../architecture/unified-rust-host.md#草稿与用户文件)、[Host Web v2](../../contracts/host-web-v2.md)、[文件查看器](../../ui/components/file-preview.md)

用户指出浏览器把 HTML 附件打开为源码，要求恢复页面预览。取消首版一律按文本处理 HTML 的边界，
继续复用正式 Viewer 和诊断/查找通道。采用认证读取后向无凭据静态 shell 交付文档，浏览器原生 sandbox
隔离页面脚本与主应用存储；Rust 仍拥有文件读取、编辑归属与代次校验，不增加 Node 或另一个业务后端。

不把附件作为可访问 Session 存储的主应用同源页面执行。本轮也不为每份 HTML 增加远程可达的独立端口或预览代理；
静态 shell 没有文件读取凭据，不扩大 Host 的公开资源能力。代价是 Web 当前只支持单文件 HTML 和 HTTP(S)
依赖，本地多文件站点资源仍是实现缺口；Desktop 的既有不同源站点能力保持，不能据此宣称两端全部 HTML 能力相同。

<a id="v1-59-d05"></a>
## V1.59-D05：长期登录 Token 与可续期普通 Session

- 状态：accepted
- 日期：2026-09-14
- 当前权威：[统一 Host 身份与控制面](../../architecture/unified-rust-host.md#身份与控制面)、[Host Web v2](../../contracts/host-web-v2.md#session-lifetime-and-renewal)、[Host Lifecycle v2](../../contracts/host-lifecycle-v2.md)

用户明确要求正常浏览器重开、Host 重启及升级后保持登录，而 30 分钟内存 Session 与只存标签页的认证无法满足。
选择长期可重复登录 Token、默认 30 天普通 Bearer 和剩余 7 天内延期；仅延长到期时间，保留原编辑身份。
扫码仍兑换相同普通 Session。此决定替代 D01/D02 中进程内 Token、短期 Session 与重启撤销的限制。

不采用保存管理 Token 自动重登、双 Token 或 OAuth；这些方案分别扩大浏览器长期管理权限或引入本轮不需要的身份体系。
代价是两端持久化、撤销提交与跨标签页竞争需要明确处理。浏览器持久认证只用于认证恢复，新标签页仍由 Host 分配
新编辑身份；认证持久化不授权共享、合并或恢复其他标签页的草稿。撤销范围、故障与时间语义归当前协议拥有。

<a id="v1-59-d06"></a>

## V1.59-D06：Linux GNU 发布基线与两类资格独立

- 状态：accepted
- 日期：2026-09-14
- 当前权威：[统一 Host](../../architecture/unified-rust-host.md#命令事件与兼容性)、[平台准入](../../contracts/runtime-platform-admission-v2.md)、[Server 验收](../../development/server-preview.md#linux-的两个验收-gate)

Ubuntu 24.04 构建得到的 GLIBC_2.39 依赖排除了 Debian 12 和 Ubuntu 22.04 VPS。首发改用 Ubuntu 22.04
原生构建，以 glibc 2.35 为兼容基线，通过 ABI 检查及同一归档的跨发行版实际运行约束后续依赖升级。
选择 GNU x86_64 覆盖现有 VPS；进一步降低到 Debian 11 或增加 musl/ARM64 会扩大平台维护面，本轮不采用。

Server OS 资格只拥有 Host 安装与生命周期；Runtime 资格继续按 Adapter 及版本独立推进。
首批 Codex CLI、Claude Code 允许 preview 实测，保留缺失证据状态；其他 Runtime 的上游探测不自动晋升。
用户明确允许将既有 MiniMax key 配入本次测试账号的原生 BYOK 配置；不复制其他 Runtime Home、原生订阅或 Session，
也不把自定义 Provider 成功误报为官方订阅资格。真实机器资源不足时先停止测试，保留代理服务。

2026-09-14 后续范围修订：用户将验收迁往 8 GB 专用开发机，并要求适配现有 Runtime 中除 Cursor、
DeepSeek Harness 外的全部 Linux 入口。现有目录的 14 项因此显式开放 preview；DeepSeek Harness 不在目录，
不据此新增 Adapter。新适配范围不等于完成资格，不把原生 CLI 成功或跨平台历史证据当作 Linux First-Class。
原 DMIT 测试账号与安装已按用户要求删除；具体主机访问资料只保存于私有运维文档。

2026-09-17 后续独立验收：DeepSeek Harness 已经作为正式 Adapter，按自己的 14 轴矩阵在 GNU x86_64
目标主机完成真实验证并绑定独立 evidence digest。它因此取得 Linux x64 qualified，不继承上述 14 项 preview
范围，也不把 Server OS、macOS 证据或另一 Runtime 的结果当作资格。Cursor 与其余 preview 行不变。


<a id="v1-59-d07"></a>

## V1.59-D07：窗口预览会话与有限 HTML 后台保留

- 状态：accepted
- 日期：2026-09-15
- 当前权威：[文件预览架构](../../architecture/file-preview.md)、[File Preview v14](../../contracts/file-preview-v14.md)

切 Camp 销毁资源会重复打开、读取与重建页面，丢失阅读状态。用户确认将预览资源交给窗口会话，以分层容量
回收代替导航销毁和固定时间过期；保持现有 Camp/Runtime 生命周期，不新增正文持久化。

选择最多 4 个实际 HTML 页面与站点后台保留，接受作者脚本和网络继续运行，以换取切回无需重建。
不增加通用冻结、API 劫持或自动重页面治理。缓存优化不承诺 CPU、网络、进程内存全部同时下降。

逻辑句柄满额先回收后台可重建资源；刷新以独立候选准备、成功显示后替换，避免旧正文配新句柄或先拆旧站点。
新旧共存也计容量，无安全空间就保留旧版本并报告失败。不采用无限扩容或通用事务框架。

<a id="v1-59-d08"></a>

## V1.59-D08：Agent 附件使用实际路径，默认输出与文件归属分开

- 状态：accepted
- 日期：2026-09-16
- 当前权威：[附件架构](../../architecture/camp-published-attachment-view.md)、[Camp Attachment v10](../../contracts/camp-attachment-v10.md)、[File Preview v15](../../contracts/file-preview-v15.md)

用户最终否决复制一次、tmp/rename、预分配和双根上下文的 revision 1。选择所有新 send 原路径登记，
复用已有 Source Ref，不建立另一套 Managed 系统。永久输出目录只给 Agent 一个正常生成交付文件的位置。
代价是临时源可被清理，跨 Camp 引用会随拥有者删除失效；明确接受，不用引用计数、自动复制或文件保活补偿。

历史受管记录保持原位和原校验；新发布与普通 Run 不经过旧 publication gate。位置展示不等于更改文件权限。
此决定替代 V1.32-D01 的新增 CLI 快照流程及 V1.40-D01 中 Agent 继续受管的部分；用户输入规则保持。
Web 本地相对资源补入已有句柄下的临时资源能力，仍运行于不透明源沙箱；这补齐 D04 的多文件缺口，
不采用另起端口或通用预览代理。模型可见字段完整确认见[revision 2](model-context-change-editable-attachments.md)。

<a id="v1-59-d09"></a>

## V1.59-D09：可信 Web HTML 使用同来源原生浏览器能力

- 状态：accepted
- 日期：2026-09-16
- 当前权威：[统一 Host 的用户文件](../../architecture/unified-rust-host.md#草稿与用户文件)、[Host Web v2](../../contracts/host-web-v2.md#workspaces-uploads-and-resources)、[文件查看器](../../ui/components/file-preview.md)

D04 及 D08 延续的不透明来源使作者初始化代码读取 localStorage 即抛 SecurityError，本机和手机均不能通过重试恢复。
用户明确选择可信 HTML 下的可用性：iframe 与预览响应同步开放脚本、来源、表单、新窗口和原生弹窗，消息桥改用
实际来源并保留窗口与预览身份匹配；不扩大工作台/API 策略或增加顶层导航权限。

代价是附件可以访问同来源主页面及登录材料，不再提供来源或每附件存储隔离。Storage 归访问设备浏览器，
不写入 Server 数据根、不修改源 HTML。这替代 D04 的隔离保证；共享 Viewer、认证源读取及统一 Rust Host 保留。
不选择 Storage 模拟或按附件能力检测，因为它们不能提供完整原生行为并增加状态系统；也不建立独立预览服务器，
避免增加远程部署入口和生命周期。Desktop 原生预览与 CSS/JS 资源加载均不扩入本轮。

<a id="v1-59-d10"></a>
## V1.59-D10：DeepSeek Harness 使用官方 ACP 与原生系统层

- 状态：accepted
- 日期：2026-09-15
- 当前权威：[Runtime Catalog Boundaries](../../architecture/runtime-catalog-boundaries.md#deepseek-harness-acp)、[Runtime Platform Admission v2](../../contracts/runtime-platform-admission-v2.md)

用户要求按 Runtime checklist 接入内置 ACP 的 dsh 0.1.5-rc.2，并逐项对照 host warm、bootstrap、compact。
采用共享 ACP Host/Fleet，官方 profile/patch 与 systemPrompt 扩展承载冻结 Bootstrap；保留原生 Home、Provider、
模型、Skills、MCP 和 sandbox/approval，不建立独立 Runtime 进程池或另一套配置。

DSH ACP 没有 system 字段，也不输出 Bash 的 canonical exit status 或文件工具的完整 Diff。使用官方 systemPrompt 与
tools/result 扩展点分别提供高权限 Bootstrap 和一次性结构化结果；拒绝用户消息伪装系统提示、结果文本猜测和
vendor 日志反推。observer 只保留 exact Session/call 的 shell 终态、canonical path、逐调用 usage、compaction owner，
以及官方 write/edit 结果中的完整 before/after；完整文件状态被翻译为标准 ACP terminal Diff，缺失、超限或无变化时
保持文件级回退，不复制 stdout、参数或完整结果。
代价是必须随 Host 管理私有绑定/观测文件，并测试丢失、串 Session、重复消费与 shutdown。

接受上游 ACP 差异：无 session/load、additionalDirectories、手动 /compact 命令与 compact lifecycle；以 exact resume、
原生持续系统层和原生工作区策略闭合对应行为。ACP used/size 只提供上下文占用；官方 committed
assistant/message 与自动 compaction/summary 的逐调用 usage 补充独立 Token/cache buckets；摘要通过
compaction/start 的原生 ID/owner turn 关联，不读取正文。空闲手动压缩无 active turn，不归入后续 Run；
缺失字段及 cost 保持 unknown。
SSE MCP、MCP resources/prompts 与 Client FS/Terminal bridge 未在该 profile 暴露；标准 stdio/HTTP 与原生工具负责实际执行。
上游插件可实现的行为不因此标成 Unsupported；自动压缩与恢复、MCP/Skill scope 等仍按真实证据逐项验收。

原生交互式 permission preset 会覆盖冻结参数并拒绝其表中不存在的合法组合；仅在受管 ACP Host 关闭该
插件，保留原生 sandbox/approval 服务与用户设置文件。队员页、持久化和 Host patch 逐字使用原生
`sandbox_mode = read-only | workspace-write | danger-full-access` 与 `approval_policy = ask | never`；
Workspace access 不再替换这些值。DSH 的 sandbox/approval 是唯一安全决定者：Core 只承载 Runtime 实际发出的
审批请求和原生选项，不按 MCP 工具名、副作用注解或 read-only 状态合成第二层 allow/deny/ask。当前 0.1.5-rc.2
没有为普通 MCP 调用发出审批时，该调用是否执行完全服从 DSH 原生结果。

同名原生 Server 的全部 Tool 仍使用官方 scoped restriction 遮蔽；这是 MCP whole-definition 配置投影，不是安全
审批。配置变化由共享 Fleet 处理 DSH 的 Session 文件锁：旧 Host 空闲时必须确认回收后才启动 replacement；旧 Host
正在执行时只标记退役，等待当前 Run 正常结束并确认回收，再以新 Host exact resume；回收失败则阻断 replacement，
不退化为 fresh Session，也不建立 DSH 专属进程池。

0.1.5-rc.2 的 ACP app 可在同级 Loader entry 尚未 settle 时先开放 stdio，原生 MCP 因而可能缺席首个模型步。
受管 patch 让 ACP entry 额外依赖 Bootstrap 发布的 readiness service；Bootstrap 等所有已配置的官方
`@deepseek-ai/dsh-mcp-client` entry 完成 Cordis lifecycle 后才发布该 service。该顺序不使用固定延时、不重放 prompt，
不改变 MCP 的原生连接失败、重连、工具或审批语义；工具表变更监听使用上游 `tools/change` 事件。

本次先以 preview 执行真实验收；在 14 个核心能力轴闭合后，macOS arm64 取得 First-Class 并晋升 qualified。
2026-09-16 的原生权限、锁顺序与通用 Diff 收敛由
[DSH v2 增量归档](../../../qualification/runtime-platform/macos-arm64-deepseek-harness-v2.json) 绑定新的不可变摘要；
v1 继续作为此前 14 轴验收的历史证据，不被改写。
2026-09-17 在 Windows 10 x64、本地 NTFS 上按同一 checklist 独立闭合 14 轴；
[Windows x64 DSH v1 归档](../../../qualification/runtime-platform/windows-x64-deepseek-harness-v1.json) 绑定该宿主、
固定 0.1.5-rc.2 包、真实 Golden Flows 与实现来源摘要，因此 windows-x64 同步晋升 qualified。
2026-09-17 的 GNU x86_64 验收在 Ubuntu 24.04.5 上使用相同官方包与真实 MiniMax-M3 路径闭合 14 轴，
并以 [Linux x64 独立归档](../../../qualification/runtime-platform/linux-x64-deepseek-harness-v1.json) 绑定该目标主机。
产品版本门槛保持 `>=0.1.5-rc.2`；证据精确记录所测 `0.1.5-rc.2`，不把未知未来版本预先写入证据。
维护者同时确认 macOS x64 已完成当前目标主机矩阵且无阻断，按既有 maintainer-target-host-acceptance 先例由
[macOS x64 DSH v1 归档](../../../qualification/runtime-platform/macos-x64-deepseek-harness-v1.json) 记录明确验收与发布批准。
四个平台各自绑定 evidenceRevision 并全部晋升 qualified；逐项证据与上游差异见
[Parity Matrix](../../research/deepseek-harness-runtime/acp-0.1.5-parity.md)。Machine Ready 仍是独立检查。
Migration 157 将 v1.59/schema 106 原位升级到 107，只扩充 Runtime/Skill 闭集，保留已有行、索引、trigger 与分配。
Bootstrap 的内容、Manifest、选择/预算与证据结构不变，现有 Native Binding 不做 clean break。

<a id="v1-59-d11"></a>

## V1.59-D11：使命复用 Camp，以首次执行基准保留长期工作区

- 状态：accepted
- 日期：2026-09-15
- 当前权威：[Mission 架构](../../architecture/missions.md)、[Mission v3](../../contracts/mission-v3.md)、[ContextManifest v25](../../contracts/context-manifest-evidence-v25.md)

使命需要跨多轮、恢复和队员切换保持连续，但已有 Camp 已经拥有消息、草稿、成员及执行。因此使命作为
独立业务定义关联唯一 Camp，避免第二套会话生命周期。业务状态由当前成员显式维护，不从 Run 终态推断。

选择首次进入 preparing 才读取当时源工作树的当前本地分支与 HEAD、创建持久 worktree，并固定该 commit 为累计比较基准。保存时创建会产生未执行
工作区，逐轮创建或移动基准则会丢失累计意义并增加恢复成本。临时 index 纳入未跟踪文件，保持真实暂存区；
不维护每轮快照或非 Git 内容基线。删除才清理工作区，独立清理记录承担失败后的恢复。

用户确认 Agent 只接收简短身份/状态、必要时的固定定义更新提示与首次成功投递的工作环境；Agent 使命
读写不暴露版本。采用字段补丁与最后提交覆盖，接受同字段并发编辑的后写覆盖，避免模型理解版本冲突协议。
Renderer 编辑使用内部乐观版本防止旧弹窗覆盖新定义，但该机制不进入模型或 Agent CLI。工作环境描述不增加 Agent 管控。

<a id="v1-59-d12"></a>

## V1.59-D12：使命用稳定数字命名，更新提醒以 Runtime accepted 为送达

- 状态：accepted
- 日期：2026-09-16
- 当前权威：[Mission 架构](../../architecture/missions.md)、[Mission v3](../../contracts/mission-v3.md)、[ContextManifest v25](../../contracts/context-manifest-evidence-v25.md)

内部 UUID 适合关联但不适合用户识别或 Git 路径。Mission 因此另获全局单调、删除后不复用的数字号；界面、
分支和 worktree 只使用最少三位的数字表示，内部关系仍使用 UUID。已经持久关联的旧工作区不在迁移中重命名，
避免移动正在使用的工作树或破坏恢复证据。

Mission 只保留最新标题、描述和详情版本；活动、开始记录与开始消息不复制正文，只保留变化／引用事实。
更新提示表示 Runtime 已收到新定义这一事实，而不是 Agent 是否调用过读取工具。因此 ContextManifest 冻结本次
详情版本，只有当前 binding 的 Runtime Input `accepted` 才推进 Conversation 水位；`mission get` 保持纯读取。
这避免“读过但下一轮输入未送达”与“输入已经送达却被要求额外调用 get”两种错误确认。

<a id="v1-59-d13"></a>

## V1.59-D13：使命附件原路径只通过受认证 Agent 读取投影披露

- 状态：accepted
- 日期：2026-09-17
- 当前权威：[Mission 架构](../../architecture/missions.md)、[Mission v3](../../contracts/mission-v3.md)、[Built-in Tool Transport v27](../../contracts/builtin-tool-transport-v27.md)

使命定义附件已经参与内部详情版本和更新提醒，但 v26 的 `mission get` 只返回五个定义字段，导致 Agent 收到
“Mission details have changed”后仍无法发现新增附件。要求用户重新点击开始或再次发送附件会把数据投影缺口变成
隐含操作前提，并使当前 Mission 定义和 Agent 可读取定义不一致。

选择在现有无参数、当前 Camp 鉴权的 `mission get` 结果中增加始终存在的有序绝对路径数组。路径直接来自已提交
source refs，不做文件系统观察；因此目录、缺失文件和权限变化都不会改变定义读取结果。此能力使用独立
`MissionAgentInfo` 投影，不把 raw path 加入共享 `MissionInfo`、Renderer/Web 投影、活动、日志、错误或证据。

不选择自动把路径加入每轮 Run Facts 或 CURRENT_INPUT，因为附件只需在收到提醒后显式读取，持续注入会扩大模型
上下文和路径披露面；不选择只返回附件元数据，因为 Agent 仍无法访问用户指定源；也不增加 Mission selector，
避免当前 Run 枚举其他使命。精确前后 shape、兼容与验证已由开发者确认的
[revision 1](model-context-change-mission-attachment-read.md)冻结。

<a id="v1-59-d14"></a>

## V1.59-D14：使命工作区采用显式前台清理，删除默认原地保留

- 状态：accepted
- 日期：2026-09-18
- 当前权威：[Mission 架构](../../architecture/missions.md)、[Mission v3](../../contracts/mission-v3.md)、[使命板 UI](../../ui/components/mission-board.md)

用户要求把功能复杂度控制在直接可用的最小范围，并明确接受不为本功能增加额外保护流程。使命删除因此
默认不清理 Worktree 或本地分支；删除弹窗只提供一个默认未勾选的处置选项，未勾选的资源原地保留，Rovai
不提供保留资源页面、后续入口或后台维护。勾选时必须先结束相关执行并完成清理，失败则保留使命供用户重试。
这局部替代 D11 的“删除即进入独立清理记录”结论，不改变 preparing 才创建、长期复用和固定累计 Diff 基准。

单独清理由 Core 投影可用性，Renderer 不根据使命状态推断。清理与 Run 准备共用现有互斥，只在确认时再次
核对工作区归属、相关执行占用和分支身份；删除 Worktree 后以捕获的 expected OID 条件删除本地分支。命令身份、
两个完成步骤和 OID 复用现有工作区／命令记录，不引入通用资源管理器、后台恢复服务、自动重建或自动重试。
脏文件、未跟踪文件和仅本地提交不会增加阻断、备份、二次确认或风险清单；这是明确的可用性取舍，不取消
防止删错目标所需的归属、占用和 OID 校验。

清理后的下一个真实 Run 才恢复工作区：分支仍在时从其当前提交重建并保留原 `base_sha`；分支也不存在时从
源项目当时的 `HEAD` 重建并更新 `base_sha`；存在 Worktree 但分支缺失或不匹配时明确报错。既有 Native Session
继续 resume，不增加工作区变化提示、公共消息、上下文注入或 Session 重置。内部 generation 只隔离旧 Diff 和
迟到结果。UI 保留卡片／列表右键入口和简洁中性确认，不增加详情页省略号。
