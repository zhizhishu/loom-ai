# LOOM V2：人格库、Prompt 合成、跨内核记忆与授权安全测试——架构补充

> **DISCUSSION_PROPOSAL v0.1 / 2026-11-15，PLANNING_ONLY。** 用户要求在原 LOOM UI 与四 Runtime（Claude Code、Codex、DSH、Pi）不变的前提下，研究 ZiChuanLan/agent-purge 的人格库/覆盖方式，并解决切换人格、长期记忆和偶尔授权安全测试的问题。**本轮只读研究+文档；没有安装或运行 agent-purge，没有更改任何宿主系统提示词、模型 Provider、审批 Hook 或真实设备授权。**
> **新产品决定（2026-11-15）**：**[pi-purge v0.3.0](../LOOM-V2-PI-PURGE-EXTENSION-PLAN.md) 选为 Pi-only 受管可选 Extension**，不能混淆为 agent-purge 的跨四内核插件；具体 Off/Append/Replace/**Fallback**/Strict、会话默认关闭/Strict 模式默认值与启动桥接边界见专篇。当前全部**未运行、未封包**。
> [唯一总计划](../LOOM-V2-MASTER-PLAN.md) · [运行端与四能力方案](loom-v2-runtime-bundles-and-capability-selection-proposal-2026-11-15.md) · [通用 Ports](loom-v2-universal-architecture-and-ports-proposal-2026-11-15.md) · [参考 Git Lock](../../../LOOM-V2-REFERENCE-LOCK.md) · [Persona/Memory JSON Schema](../../../loom-v2-persona-memory-contract.schema.json)

## 一、先讲清五种不同东西，不再把“人格”误当 Rules、Skills、记忆或权限

1. **PersonaProfile / 人格**：回答风格、语气、角色职责、分析偏好、语言和项目工作习惯；有版本和来源，可从 Markdown/frontmatter 导入。Persona 不是一个 Bot 的不可变身份。
2. **BotIdentity**：Hanzi、Linxi 这种长期存在的助手实体，拥有固定 BotId、独立长期记忆引用和 Goal；切人格、换 Pi/DSH、换电脑不改变 BotId。
3. **Capability**：Skill/MCP/Rule/Hook 仍由已有统一 Capability Registry 选择、物化和验收。Persona 可推荐某个 Skill 或 Rule，但**不能直接打开它、安装 Hook、授予 Secret/Device/Terminal 权限**。
4. **Memory**：跨会话/跨设备的 Bot、Project、Team 知识与事实来源；不塞进 Persona Markdown，不随着 Prompt Strict/Replace 自动清空或泄露到其他 Bot。
5. **Authorization & Safety**：模型 Provider/宿主规则、Core ResourceGrant、Device OS/Sandbox、审批和审计互相独立。**调整 Persona 不等于解除审批/沙箱，也不保证突破模型提供方的上下文或安全限制。**

用户界面保持原助手编辑面板：在现有“能力”区域旁增加可折叠“人格与记忆”子配置，显示 *人设/作用范围/当前 Runtime/生效方式/记忆策略/安全实验环境*。不重画配色/三栏/群聊。

## 二、agent-purge 的实际机制（来自固定本地源码，不是我独立运行得出的验收结论）

固定参考：**ZiChuanLan/agent-purge，MIT，commit 5881e309c5d2bca3eb0cc4125d75f8b573ae5aa0**，只读目录 _artifacts/reference-repos/agent-purge-current；源码入口：lib/personas.mjs、lib/activation.mjs、lib/extension.mjs、lib/dsh.mjs、lib/restore.mjs、lib/project.mjs、backends/index.mjs、matrix.json、docs/reference/compatibility.md、docs/guide/personas-and-modes.md。

| 可借鉴点 | 仓库中可见的事实 | LOOM 的设计结论 |
|---|---|---|
| 一份人格，多执行器 | 每个 personas/id.md 是 frontmatter + 正文，正文是注入文本；能按 harness/model 匹配，global 与 per-harness override | 导入器只解析 **id/name/description/order/harness/model** 与正文；转为 LOOM PersonaManifest，按内容 SHA、license、来源审查；保留原 MD，不复制到用户全局 Home |
| 四模式 | off / append / replace / strict；strict 只替换宿主可控入口，其余系统段落可能残留 | LOOM 用户级模式：Off、Append（默认）、Replace host-persona（明确兼容性）；纯 Prompt-Only 只在隔离 Lab，不能让“strict”承诺清空服务端/Provider 策略 |
| 多通道 | install（持久配置）、shim（PATH 替身）、slash（会话命令）、project（规则文件追加）；能通过 stash SHA 还原 | **不采用修改全局 PATH/CLI/AGENTS.md 的默认方式**。只用受管 Pi/DSH 独立 Profile 或新 RunAttempt 内的本次注入；版本、来源与撤销回执由 Core 管理。项目 AGENTS.md 只读发现，未经用户确认不自动改写 |
| Pi | lib/extension.mjs 的 before_agent_start/session_start；作者 2026-11-14 记录 Pi 1.5.2 隔离抓包 4 模式 | 可做受管 Pi Extension/PromptMaterializer，允许下一 Run 生效，若支持同会话每轮切换亦不能在 **同一 RunAttempt** 默默换人格版本 |
| DSH | lib/dsh.mjs 的 Cordis Profile/Patch 与每次组装读取配置；兼容文档有 0.2.1-rc.5/0.2.2-rc.1 演变 | 设计 DSH 受管 Profile Materializer，**只借“配置插件生命周期”原理**，不用它的 Permission Hook 或全量 Context 清空实现 |
| Codex | backends/index.mjs 的原生命令入口，有 developer instruction/model instructions file 路径；不保真实热切 | 外部 Codex Runtime Adapter 按启动/本次配置生效，声明 needNewAttempt；不劫持用户系统 Codex Home |
| Claude Code | 有原生 system prompt file/append 参数；兼容文档说明仍可能有宿主 SDK 固定段 | Claude Code Adapter 只做受权配置发现/按官方入口传递人设；**本机 Windows 11 执行禁用**。不做二进制补丁或“保证清除 Claude 身份/安全”承诺 |

**必须单独记录的危险细节**：当前 agent-purge 的 lib/dsh.mjs 生成插件代码包含对名为 approval:policy / sandbox:policy 的 runtime contexts 的排除，并有 approval/request 处理返回 allowed-once；作者 matrix.json 的安全计数也描述了此行为。它确实可能改变宿主原有工具审批的效果，所以**绝对不能不经审计直接将原 DSH purge 插件/其 strict 或 replace 清理逻辑接入有文件、终端、设备工具和凭据的生产 Bot**。这比“提示词太长”重要得多。Pi 的 strict 也可能丢掉 AGENTS.md、Skills 索引与其他 Extension 注入的指导，必须检测并显式显示差异。

**关于“Pi 没有客户端审查”**：该仓库在某一版 Pi 请求的局部系统提示词中统计到 0 条特定内置内容限制，**这只是作者按特定规则计数、特定版本和本地测试 Provider 的观察**；不代表实际模型 API、运行平台或服务端没有限制，更不能将“无本地提示词拦截”当作“可无条件执行”。LOOM Core 的权限/审计与模型端策略仍有效。该项目自己也强调 persona 替换不保证模型行为，历史捕获和当前会话生效是不同状态。

## 三、建议新增的两个 Core Port 和三个服务（规划）

### 3.1 PersonaRegistryPort（人格资产）

~~~
discover(source) -> PersonaCandidate[]                 # 本地 .md / GitHub 固定 SHA / 手动文本，只读扫描
inspect(candidate) -> PersonaRiskReview                # 来源、license、hash、frontmatter/schema、隐性请求扩权
import(candidate, review) -> ImmutablePersonaManifest # 只把正文存为内容定址对象，version 固定
bind(botId, personaId, scope, applyMode, expectedRev) -> PersonaBinding
resolve(botId, teamId?, runAttemptId, runtimeKind) -> PersonaResolution
revoke(bindingId, expectedRev) -> PersonaRevocation
~~~

PersonaManifest：personaId、name、description、version、sourceUrl/commit、origin、license、contentDigest、targets 四 Runtime 兼容矩阵、locale/roleHints、promptBodyRef、riskClass、ownerScope。PersonaBinding：BotId/Project/Team 的引用、mode、revision；**persona 文件不能声明“允许跳过安全策略”的真实 Capability Grant**。

### 3.2 PromptComposerPort（可重现、解释为何生效）

~~~
compose(botIdentity, personaRevision, selectedRules, capabilitySnapshot,
        authorizedMemoryRefs, goalContextSnapshot, runtimeDescriptor)
       -> EffectivePromptSnapshot
materialize(snapshot, runtimeKind) -> RuntimePromptLoadReceipt
explain(runAttemptId, redacted=true) -> PromptAssemblyReport
~~~

Prompt 的**分层**：Core 的授权规则/工具拒绝是强制侧通道（不可用提示词单独保证）；Runtime 固定必要运行协议；Workspace/Project Rules；Persona 风格与角色；Goal/Step ContextSnapshot；授权检索的 Memory 引用。**不靠「用更强的 system prompt 盖住别人」实施安全**。物化时记录每段 digest、原生 role（system/developer/user）、最终 prompt digest、是否截断、Host 版本、Adapter 支持、是否需重启。Prompt 的原文可以由有权限的 owner 在预览中看，但日志默认只留 hash+脱敏摘要；模型端透传的完整提示词须视为可能发往 Provider 的数据。

**应用模式**：
- **Off**：不用 Persona，保留 Core 策略/项目授权/运行能力；
- **Append（默认）**：把人格作为已知层次的一段用户/系统可控文本添加，宿主最稳定；
- **Replace host-persona**：只替换 **LOOM 自己能保证可控的宿主人格段**，不替换授权/沙箱/Project Rules，也不得隐式改审批。Runtime 不支持时显示 UNSUPPORTED 或需新 RunAttempt；
- **Prompt-only Lab**：仅在隔离、无生产凭据、无外网/无真实工具的安全评测环境观察不同合成策略。它不承诺覆盖模型 Provider 的系统/安全层。不能通过常规 Bot UI 在有权设备上开启。
- **Switch policy**：一个 RunAttempt 的 Persona/Rules/MemoryScope 固定。用户点“切换”后提示“下一次任务生效”；要立即生效必须取消当前 Attempt 并创建新 Attempt，旧证据/记忆不覆盖，避免热切导致任务重放和审计断裂。

### 3.3 MemoryService / LabService / ProvenanceService

- **MemoryService** 是长期记忆事实源：BotMemory、ProjectKnowledge、TeamSharedMemory、RunScratch、SecurityLabEphemeral 各有明确 owner、读写范围与 retention；Persona Markdown 永不自动带出跨 Bot 秘密。
- **LabService** 处理授权安全测试：测试目标、批准范围、沙箱设备、网络策略、假密钥、恢复策略、测试用例、结果归档；用户可以测试 Prompt Injection 抵抗、人格偏移、内容保留与审批策略是否被弱化，但测试不得对生产资源扩权。
- **ProvenanceService** 关联 Persona、Rules、MemoryRef、Capability、Runtime 与最终 Prompt 的 ID/版本/哈希到 RunAttempt / Artifact / Review；支持事件回放但不把长提示词/秘密全文存公开日志。

## 四、记忆长久/上下文限制怎么解决

**人设并不等于记忆**。在同一个 Bot 切换 Pi→DSH→Codex→Claude 时，记忆应由 LOOM Core 返回有权限的 refs，而不是从旧 Runner Session 隐式读取。建议五层：

| 层 | 用途 | 默认读写/隔离 |
|---|---|---|
| Bot durable memory | 用户长期偏好、稳定工作约定、项目索引 | 仅 owner Bot/有权限协作成员读；写入需来源/版本/可撤回 |
| Project knowledge | repo 事实、接口、Mindkit、日志、代码证据 | 按 ProjectGrant/WorkspaceGrant 检索，团队共享只授权相关 refs |
| Team task context | ACCP 式冻结 ContextSnapshot、共享可验证成果 | 当前 Goal/Step 的 TTL 与版本隔离，过期 worker 不能更新 |
| Run scratch + checkpoint | 一次执行的摘要、关键决定、进度、token budget | 默认不进入长期记忆；恢复通过 checkpoint+Artifact refs，不无限堆上下文 |
| SecurityLabEphemeral | 防护测试用人格、对抗样本、假密钥和回执 | **默认不写长期 Bot/项目记忆**；独立 DB 命名空间、到期删除、手动选择才可导出经审查总结 |

解决“上下文装不下”的办法是 **检索+分段、摘要压缩、重点固定、版本化事件日志、独立事实存储、跨运行状态恢复**，而不是宣称突破模型物理 context window。模型可见窗口/Provider 配额仍有限；用户可以选“本次无记忆 / Bot 长期 / 仅本项目 / 受限团队共享”，每种显示预计注入 token 和引用来源。

**记忆污染负例**：外部 Skill/README 中的指令不能写入 Bot long-term 事实；从 Lab 运行中产生的越权内容不能被“自动学习”送回普通 Bot；同一 Bot 切人设不能自动继承另一个 Bot 的私有记忆；清除/撤销后新 Run 必须不可再次检索，旧审计证据按保留政策存储而非假称历史被抹除。

## 五、偶尔的授权安全测试：怎么给用户一个可用按钮

原 UI 的 Bot 编辑页增加“运行配置”中的实验开关，仅让用户进入 **Security Lab（隔离试验）**，不放一个叫“突破安全限制/取消审核”的全局开关。

~~~text
Hanzi · 运行配置
  Runtime       [Pi ▼] [DSH] [Codex] [Claude Code]
  Persona       [代码架构师 ▼]  [导入 .md / GitHub 固定 SHA] [预览应用差异]
  应用方式      [追加（默认）▼] [替换宿主人格（仅受支持）] [关闭]
  Memory        [Bot 长期 ▼] [本项目] [本次无记忆]
  四能力        Skill ☑   MCP ☑   Rule ☑   Hook ☑
  试验          [在隔离 Security Lab 中测试]  ← 不改变当前 Bot 的授权
  状态          已选择 / 已加载 / 本次调用 / 失效原因 / 对应证据
~~~

Security Lab 有三种模板：
- **Persona A/B**：相同模型/任务/工具权限，一组 Off、一组 Append/Replace，比较输出、token、Prompt hash、真实性。
- **Memory Boundary**：灌入**假的**跨 Bot、跨 tenant、长期与临时记忆，验证正常 Run 不会检索到不授权的内容。
- **Prompt-Injection & Tool Approval Regression**：用模拟网页/文件/MCP 回复测试规则和工具审批是否仍生效；**不能因为 persona strict/replace 就自动允许原本应阻止的设备操作**。

强制边界（真正的代码 Gate，而不是模型自律）：
- Lab 必须显式选择**自有/书面授权**的环境；不继承生产 Runner 的设备授权、Cloud secrets、MCP token、浏览器 Cookie 或项目可写路径。
- 默认无网络、只读/临时文件系统、假工具或固定 fixtures；如要带网络/真测试靶场，需额外允许清单、到期时间、单独授权，不能暗中连真实第三方。
- 真正的 Core Policy/DevicePort OS 权限始终 fail closed，审批必须由用户/策略显式产生，插件自行返回 allow 不算人类审批。
- 隔离日志、审计、运行结果、实验 Prompt 版本和受影响的文件 hash；测试结束自动停掉沙箱进程，下一次普通 Run 重新从批准的人格与 MemorySnapshot 启动。
- 同名 persona 本地导入/远端 GitHub 更新要显示 diff/版本变化、SHA、source。恢复只撤销自己的受管配置，有 SHA 冲突就拒绝并保留原 bytes；不能直接清理 Claude/Codex 原用户目录。
- Provider 仍可能拒绝某些任务；LOOM 不尝试通过二进制补丁、隐藏代理、取消供应商审核或自动放行审批去“破限”。研究重点是**受控测试可复现**与记忆/上下文管理。

## 六、四 Runtime 的 Persona 兼容合同（建议，尚未实测 LOOM 本身）

| Runtime | 推荐接口位置 | 可控范围 | 当前实际事实与未知 |
|---|---|---|---|
| Pi bundled | 受管 Pi Extension / PromptComposerMaterializer，before_agent_start | Append + 受控 Host Persona Replacement；可观察一轮是否生效 | agent-purge 作者报告 1.5.2 真请求捕获；LOOM Pi 固定版本并不一定一致，需真实 E4 |
| DSH optional | 独立 Cordis Profile 插件，仅处理 Persona 段 | Append + Profile 受控替换；不得触摸 Approval/Sandbox Context 或自动放行 | 作者报告 0.2.1-rc.5/0.2.2-rc.1 行为；当前仓库样例有危险的审批/沙箱副作用，必须**自己重写窄 Adapter** |
| Codex native | 已授权外部 Codex 的官方 per-run instructions/profile 接口 | 启动时生效，切换要求新 Attempt | 作者报告 0.166.0 launcher 支持，LOOM 与当前 Codex 本机版本未做真请求测试 |
| Claude Code native | 官方允许的 per-run persona/append prompt 接口，仅经配置探测 | 启动时生效；当前 Win11 执行禁用 | 不启动本机 Claude Code；不能宣称去除所有宿主/服务端说明；不采用二进制改写 |

**逐端验收必须区别**：Configured / Materialized / Loaded / PromptSeen（请求实际角色/Hash）/ AppliedByModel（本轮输出遵循测试标记）/ NoPrivilegeEscalation。没有实际执行就显示 NOT_RUN；“模型说自己是某人格”不是提示词传送证据；真实请求角色 system/developer/user 因宿主可能不同，不能一律称“系统层已替换”。

## 七、正式开工后工兵分工（本轮 NOT_STARTED）

| Worker | 可写边界（需 P1 先冻结） | 预期验收 |
|---|---|---|
| Persona Registry | Core V2 persona registry/import/provenance | GitHub/local Markdown 导入、版本化、拒绝路径穿越、未知前言字段、攻击性导入不扩权 |
| Prompt Composition | Core PromptSnapshot + Pi/DSH Materializer（按 Adapter 文件独占） | Off/Append/Replace 真 Prompt hash、遵守 Core policy、切换新 Attempt |
| Memory Policy | Memory store/retrieval/compaction/checkpoint | Bot/Project/Team/Lab scope 正负例、召回准确与串租户拒绝 |
| Security Lab | 测试工作区/模拟工具/证据与临时数据删除 | Persona A/B、伪密钥泄漏、审批否定、无网络无生产凭据 |
| QA / Red Team | 只写隔离测试报告，不修产品源码 | 当前四 Runtime 的同条件对照、许可范围、误报与实际失败 |

**与 PDF 阶段映射**：P0 把 agent-purge 新增为参考 SHA；P1 冻结 Persona/Prompt/Memory/Lab 合同；P2 加 Bot→Persona binding 与 Memory Scope；P3 在四 Runtime 各实现 materializer；P4 加 Persona A/B/Prompt role 捕获负例；P8 对 run switch/持久上下文/Attention 加事件；P9 Capability Registry 与 PersonaRegistry 严格分离但配置页并列；P12 仅轻量增强现有 Bot 编辑 UI；P13/14 验证跨设备与 tenant Memory/Persona 隔离。**不新造第五 Runtime，不改变 PDF 的 P0–P14 编号**。

**验收扩展**（在原 T0–T22 之外）：
- T23：导入 agent-purge Markdown 人格→保存 immutable digest→版本化 Bind→Pi 真 LoadReceipt，切换 DSH 仍同 BotId。
- T24：Off/Append/Replace 与目标 Runtime 的真实 role/hash 吻合；不支持时 truthful unavailable，切换需新 Attempt。
- T25：不同 Persona 的 Bot/Project/Team/Run Memory 按授权检索；试验数据不能污染真实长期记忆。
- T26：模拟 Prompt Injection 与失效 Hook 后，Core ResourceGrant、审批、沙箱没有被打开；模拟 DSH auto-allow 插件的测试必须 fail closed。
- T27：Security Lab 使用假密钥和模拟工具；退出后删除临时工作区、撤销 Grant，真实云端服务/64851/已有浏览器 Cookie 不受影响。
- T28：上下文压缩/恢复可复现，真实 token window 未突破；仍能从已授权来源恢复事实、引用与原 Goal/Step。

## 八、现状与研究边界

- 本轮仅 git clone 指定开源仓库到只读研究目录并检查代码；**没有安装 npm 包、执行其源码、修改任何全局 CLI 配置或 Prompt、调用模型或启动工兵**。
- 11 份原本的参考仓库与历史五处 WIP 原状保留；本次新增第 12 份参考，不授权其他 Runtime 入口。
- 当前已在用户已有 Chrome 会话打开 [LOOM V2 规划板](../../legacy-plans-2026-11-15/LOOM-V2-PLANNING-BOARD.html)，静态页面不是实时产品完成率。
- Persona/Memory/Lab 的 Schema 只是草案，尚未正式写入当前 v1.72 Contract，不能标任何 T23–T28 PASS。
