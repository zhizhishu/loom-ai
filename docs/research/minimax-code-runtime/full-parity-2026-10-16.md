---
document_type: research-report
authority: runtime-comparison-evidence-only
status: partial-verification
last_updated: 2026-10-16
---

# MiniMax Code 与全部 Runtime 的完整接入对照

后续 User seq10/11 的[真实模型/App 增量验收](live-acceptance-2026-10-16.md)已补齐账号、图片理解、
Renderer、手动 compact/cold 和能力更新。本表冻结于 seq8 的代码审计/控制服务阶段；
其“真实未验”状态不代表最新验收结果，其他 18 款也未在本轮重跑。

回应 User seq8：按最近接入清单核对全部能力，不把 Steer 或 Shell 写文件当作完整接入。
范围为 `AdapterKind::ALL` 的 **19 个 closed identity：MiniMax Code 加其他 18 个**。
这是当前分支代码审计、既有固定版本验收和本次 MiniMax 实测的合并对照，不是重新运行了其他 18 款。
MiniMax 固定实际安装 **mcode 0.6.12 / macOS arm64**，来自 `@minimax-ai/code`。
基础实现提交 `3f5e9f8f694533eb4b2985c1446a32ed02ee0638`；本次额外修正文件来源映射。

**结论：MiniMax 已有 Preview 主路径，仍未达到 First-Class。** System/Host/resume 不需要另建冻结层；
本轮实际查出并修复相对 Read 路径缺失、Write 创建标识遗漏、Edit 预览误当完整文件状态。
compact 完整连续性、原生配置热更新、Skills、真实账号、完整内置 CLI/故障/平台矩阵仍不能写成通过。

## 依据和读法

- 当前总准入：[14 轴 Checklist](../../development/runtime-integration-checklist.md)。
- 最近对照：[Command/Cline 14 轴](../runtime-monitoring/command-cline-checklist-2026-10-05.md)、
  [文件层次区分](../runtime-monitoring/command-cline-files-context-2026-10-04.md)、
  [原生 System/MCP](../runtime-monitoring/command-cline-native-system-2026-10-06.md)、
  [DSH 完整矩阵](../deepseek-harness-runtime/acp-0.1.5-parity.md)。
- 后续更正：[Cline 3.0.70 ACP/compact](../cline-runtime/latest-acp-2026-10-08.md)、
  [Command 1.74.1/1.79.1 选模](../command-code-runtime/model-selection-2026-10-09.md)、
  [15 Runtime 恢复及修复](../runtime-monitoring/native-session-resume-2026-10-12.md)、
  [Steer 收口](../runtime-monitoring/steer-hardening-2026-10-15.md)。
- 当前真源：[Context 路由](../../../crates/rovai-core/src/context.rs)、
  [ACP Host/工具/恢复](../../../crates/rovai-core/src/acp.rs)、
  [Catalog/权限/MCP/准入](../../../crates/rovai-core/src/agent_runtime_adapter.rs)、
  [Activity Registry](../../runtime-activity/registry.md)、
  [File Change v8](../../contracts/runtime-file-change-observation-v8.md)。
- 数值对照：[15 款 App 验证](../runtime-monitoring/all-runtime-app-verification-2026-10-03.md)、
  [原生缺失字段补查](../runtime-monitoring/native-source-completion-2026-10-03.md)；不能将那次模型的空值
  推广为 Runtime 永久不支持。

下表“接入/有”描述代码通路；“实测”注明真实模型或脚本模型。`DocumentationOnly / 未验 / 未接`
均不等于上游 `Unsupported`。其他 Runtime 的旧版本成功不自动覆盖当前安装、所有模型及平台。
截至本分支，macOS arm64 的 Cline/Command/Cursor 为 `NotQualified`，普通目录不开放；MiniMax 为 Preview，
其他 15 个 identity 有现行资格。这里仍比较全部 19 个，避免把隐藏 Adapter 遗漏。

## 1. 要对比的项目：14 轴拆成可验收行为

| 能力轴 | 必须分别比较 | MiniMax 当前结论 |
| --- | --- | --- |
| Auth / Provider / Model | 原生认证来源、默认与显式模型、Provider 路由、effort、配置/凭据刷新 | 原生来源；opaque provider/model/variant、config ACK；脚本 BYOK 通过，真实账号未生成；原生配置热刷新尚无证明 |
| Host / Fleet / LRU | 普通 warm、跨 Session/成员、并发、idle eviction、兼容键、停止 | 共享 ACP/Fleet；同 Binding 普通两轮同 PID；完整 A/B/A、并发与 LRU 未验 |
| Native Session | 完整 ID、warm、cold/Core 重启、缺历史、replay 隔离 | 控制服务下 exact resume 与缺失后一次替换通过；不以最近 Session 恢复 |
| Bootstrap / Context | System 层位置、文件/协议/插件、何时读取、同 Run 冻结、新 Run 更新、resume 关系 | 原生 append 文件；启动读取；主模型请求系统层 Charter 恰好一份；不改变 shared Formatter/Manifest |
| Compaction | 原生压缩、Bootstrap 保留/补发、manual/threshold/overflow+retry、失败/取消、cold、执行台展示 | 原生 System 保留策略已接；完整连续性待验；MiniMax 压缩展示未接 |
| Skills | 平台索引/工具箱、原生发现、实际读取、同名、更新/删除、相邻隔离 | 共享 Skills v2；原生来源声明 DocumentationOnly；实际能力矩阵未验 |
| External MCP | stdio/HTTP、分配、实际调用、同名、更新/撤销、邻 Session、取消/秘密 | ACP Session 投影；实际 echo 与撤销通过；完整冲突/HTTP/并发/故障未验 |
| Tool / Action / Output | ID、started→terminal、去重、command 输入、stdout/stderr/mixed/empty/nonzero/large | 真实 CLI＋脚本模型六类命令通过；permission ID 与 call ID 关联已适配 |
| 文件观察（Tool 子轴） | Read、Write、新建/覆盖/空文件、Edit、失败、相对/中文路径、Diff、Files Changed、重开 | 本次补验 10 个用例＋重开；见第 3 节；Renderer 点击仍待验 |
| Narration / Final | 公开正文/thinking、权威 final、流/快照去重、zero-send、accepted-send suppression | 共享 ACP；控制服务实际 send 与零发送恢复通过；不将进程退出当 final |
| Permissions / Workspace | 原名权限、默认值、审批权威、allow/deny/cancel、目录/附件边界 | 原生权限；allow/deny 和取消子进程通过；additionalDirectories 上游拒绝，不声称有额外目录沙箱 |
| Built-in rovai CLI | 当前 operation 集、每 Run lease、冷恢复、解除、旧 lease 拒绝 | 实际 bundled send 子集通过；尚未跑正式 operation 全集 |
| Usage / Cache / Cost | 逐调用/Session、输入缓存语义、去重/baseline、尾部、Context used/window、费用 | journal 数值已接；主动长 Run 取得输入/输出/cache；短 Run/尾部可缺数；不估算 Run cost |
| Retry / Queue / Cleanup | accepted/unknown、队列、迟到、崩溃、协议错误、取消收敛、进程树 | 共享 owner；单例 cancel/缺 Session/Steer 通过；完整故障矩阵未验 |
| Ready / Version / Platform | 安装与认证分离、版本/程序指纹、平台资格、目录/UI/迁移 | macOS arm64 Preview；其余三平台 NotQualified；schema 155、安装/成员参数等已接 |
| Steer / 附件（增补轴） | 同 Run/epoch、已接收/未知回执、终态竞态、排队、图片实际到模型 | 原生 steer 已接；同 Run 文本和路径读图到 image_url 已验；真实视觉理解未验 |
| Fast（范围决定） | 显式需求、原生 service tier 与模型不能混用 | User 明确不需要；不提供 Fast 映射；highspeed 仍是普通原生模型 |

“Host A/B”在前轮控制脚本指同一 Conversation 的两轮，不是两个原生 Session 的 A→B→A。
此次对照明确保留这项未验边界。

## 2. 全 19 款：System、Host/resume 与 compact

Bootstrap 是 Charter/身份/Memory Entrypoint；动态输入仍由共同 Builder 生成。
`first_payload` 表示首次向 user payload 加入 Bootstrap，并不等同于高权限 System。
“补发”只在已准入信号后为下一 eligible Core 输入推进 revision；不保证修复当前同轮上游自动重试。

| Runtime | System Prompt 投递 | Host / 精确恢复 | 当前 compact 机制 |
| --- | --- | --- | --- |
| **MiniMax Code** | `native_append`；Host 私有 `--append-system-prompt-file`，启动时读取 | ACP/Fleet，同 Camp/成员/Binding 可 warm；优先原生 resume，load 为广告能力；内容变化只换 Host | System 持续策略；不依赖 detector；manual/threshold/overflow+retry/cold 未验，执行台展示未接 |
| Codex | `native_append`；thread start/resume 的 `developerInstructions` | app-server/Fleet；`thread/resume` | 受保护指令层；原生 `contextCompaction` 可展示，不走 Bootstrap detector |
| Claude Code | `native_append`；同名 append 文件参数 | one-shot resumable；每 Run 进程，`--resume <id>` | 受保护 System；当前无压缩展示入口；与 MiniMax 相似的是投递位置，不是进程寿命 |
| Pi | `managed_system_prompt`；官方 `before_agent_start` hook | JSONL RPC/Fleet；精确 `switch_session` | System 持续；原生 compact 生命周期，不依赖 user 层补发 |
| DeepSeek Harness | `managed_system_prompt`；官方 Cordis systemPrompt 接缝，按 Session 绑定 | ACP/Fleet；resume；配置变更先回收占原生锁的 Host | System 每模型步重组；既有 manual/threshold/overflow+retry/失败/取消/cold 验收最完整的参照之一 |
| Grok Build | `native_append`；原生 `_meta.rules` | ACP/Fleet；resume | System rules＋`auto_compact_completed` 精确事件；既有下一输入补发仍启用 |
| OpenCode | `first_payload` | ACP/Fleet；按版本 resume/load | V1 原生 Plugin `session.compacted`；V2 ACP compaction metadata；完成后补发 |
| GitHub Copilot | `first_payload` | ACP/Fleet；load | 原生 `preCompact` Hook；是 imminent edge，不冒充 completed |
| Kiro | `first_payload` | ACP/Fleet；当前正常释放为 Stop，下一轮 load；不能承诺同 PID | `_kiro.dev/compaction/status` completed 后补发 |
| Qoder | `first_payload` | ACP/Fleet；resume/load 按广告能力 | `PostCompact` Hook 后补发 |
| CodeBuddy | `first_payload` | ACP/Fleet；load 前精确检查原生历史文件 | `SessionStart` 的压缩后边界；不是完整原生压缩进度 |
| Qwen Code | `first_payload` | ACP/Fleet；resume | `PostCompact` Hook 后补发 |
| TRAE CLI CN | `first_payload` | ACP/Fleet，同 Binding 续接；load | 当前 detector disabled，无已准入完成信号；不是已证明 Unsupported |
| Kimi Code | `first_payload` | ACP/Fleet；resume | 固定原生 started→completed 文本帧相关；best_effort，有 wire provenance 局限 |
| ZCode | `first_payload` | 官方 NDJSON app-server；接共享 Fleet，精确 resume | 原生 session.updated 的 completed/boundaryId；下一输入补发 |
| Antigravity | `first_payload` | one-shot resumable；`--conversation <id>` | 当前无合格补发信号，detector disabled |
| Cursor（未开放） | `first_payload` | ACP 实现保留；Host 复用不在当前承诺内 | detector disabled；缺真实 authenticated 全链路 |
| Cline（未开放） | `managed_system_prompt`；当前为 Host 私有原生文件 Rule，非旧 Hub | 官方 ACP/Fleet；3.0.70 load 实测通过，旧 3.0.3 不通过 | Rule 保留 System；3.0.70 普通 ACP buildConfig 仍未启用原生自动 compact |
| Command Code（未开放） | `managed_system_prompt`；官方 appendSystemPrompt Mod＋逐 Session 私有绑定 | 官方 ACP/Fleet；精确恢复前原生 catalog 核验 | System 持续；既有真实 manual、threshold、随后 cold 通过，不能扩大为 overflow 完整资格 |

MiniMax 不需要复制 DSH/Command 的插件门禁或另造“冻结配置”。启动文件内容已经是现有 Context 准备的字节；
普通下一轮可复用 Host。真正启动内容改变才按现有 digest 换 Host，再 exact resume 原 Session。
共享 ACP 在发生 Steer 后设置 `retire_after_steer`，故该轮之后换 Host；这与普通 warm 是两个场景。

额外发现：MiniMax 当前没有像 DSH/Grok/Cline/Command 一样接原生配置文件摘要到 Host 兼容键。
Rovai 成员启动配置/权限变化有既有 fence，但用户在原生 CLI 外部改凭据/Provider 后，原生是否自动刷新仍未验证；
不能将“model config ACK 已过”写成“凭据/Provider 热更新已过”。不在本次比较中另建监视器或冻结层。

## 3. 全 19 款：Command、Read、Write/Add/Edit 与 Diff

这里有五个独立层次：**执行副作用 → Action 终态/输出 → 文件路径行 → 原生 Diff → Run 的 Files Changed**。
Shell 执行 `printf > file` 只证明第一、二层。路径行没有 Diff 仍是有效操作；没有前态不能猜“新增”。
下表 ACP“标准 Diff”均指上游实际发出了可信完整状态才消费；并非每个工具/版本都会发送。

| Runtime | Command/输出来源 | Read / Write / Add 的观察 | Edit / Diff 与边界 |
| --- | --- | --- | --- |
| **MiniMax Code** | 标准 ACP＋`rawOutput.content`；`details.execution.exitCode` 判非零；六类输出控制测试通过 | 同调用原生路径含相对路径；成功 Write 的 Boolean `created` 区分 add/update；新建暂无结果 patch | 本次改用成功 `details.patch`；覆写/空文件/Edit 有真实补丁；排除编号预览与输入伪完整状态；失败不产生变化 |
| Codex | commandExecution 的 command/aggregatedOutput/status/exitCode | 结构化全 read 且唯一路径才成 Read；fileChange 明确 add/update/delete | terminal fileChange；Run 可用原生 whole-turn diff snapshot，覆盖范围有明确定义 |
| Claude Code | Bash tool_use/result 精确 ID 配对 | Read/Write 有路径；Write `type=update` 可确认更新；create 对空文件有假阳性，不能直接认 add | 成功 Edit 为 exact mutation 片段；Write 无内容 Diff；replace_all/NotebookEdit 不冒领 |
| Pi | tool_execution start/update/end，稳定 ID 与结果 | Read/Write 路径；Write 保守编辑、不猜新增 | 成功 Edit 的 `details.patch`；路径双 header/hunk 校验；Write 无 patch 不补造 |
| DeepSeek Harness | ACP＋官方 tools/result observer 补结构化 exit/signal/timeout | observer 原生 canonical path；Write `before:null` 明确 add，空文件为 update | 官方完整 before/after 转标准 Diff；缺失/超限 path-only；不读磁盘补偿 |
| OpenCode | ACP 文本结果、allowlist raw output | 标准路径；Write Boolean `metadata.exists` 与路径核对区分 add/update | 标准终态完整状态；原生元数据不足则路径回退 |
| GitHub Copilot | ACP 标准终态/嵌套 text | 标准唯一 location/raw path；没有显式前态不猜 add | 标准 Diff 支持，收到才显示；不能从 MCP 或普通文本推文件变化 |
| Kiro | ACP 标准终态 | 标准唯一路径；rooted-relative Diff 仅按同调用 location 严格纠正 | 标准 Diff，路径冲突拒绝；既有 2.21.1 文件矩阵通过 |
| Qoder | ACP 标准终态 | 稀疏 terminal 复用同调用先前 location | 标准 Diff，首次可信 kind 不被冲突终态覆盖；既有 1.1.28 文件矩阵 |
| CodeBuddy | ACP 标准终态 | 标准路径；既有新建只达到 path-only Write | 标准 Diff，有才展开；原生成功 envelope 也需遵守失败判定 |
| Qwen Code | ACP 标准终态 | 标准路径 | 标准 Diff；既有 0.23.0 留有 basename-only 路径边界，不猜后缀关联 |
| TRAE CLI CN | 原生 `Command` 字段窄适配＋ACP output | 标准路径/文件矩阵已有记录 | 标准 Diff；旧 0.120.52 nonzero 被标 completed 且无 exitCode 的缺口不能说已普遍修复 |
| Kimi Code | ACP Shell 的稳定 ID/command/output | 成功 Edit/Write 唯一 location；没事件不补造 | 标准 Diff 支持；整体 coverage 仍 run_level，不等于没有任何文件路径 |
| Grok Build | ACP 结构化工具；私有通知不推 Tool | 标准路径能力；旧 1.0.13 文件矩阵存在不稳定结果 | 标准 Diff 支持，不拿连接成功证明可重复文件验收 |
| ZCode | 原生 tool_call/result，同 ID；Shell exit/timeout 校验 | Read/Write/Edit 原生路径；不从 Shell git diff 推操作 | Edit 的完整原生 patch 经 header/hunk/counter 校验；Write 参数不是结果 Diff |
| Antigravity | stream-json terminal tool step；legacy text 回退 | 当前无合格单文件终态事实 | 无 Command 文件 Diff/Files Changed；不能从工具显示名猜 |
| Cursor（未开放） | ACP 标准消费代码，认证工具 smoke 不完整 | 协议可消费，不视为真实文件验证 | 无 authenticated 细粒度准入，私有扩展不补造 Activity |
| Cline（未开放） | run_commands 按原生 success；审批拒绝特殊配对 | 单文件 read_files、apply_patch/editor 路径；批量不猜唯一文件 | 成功 apply_patch/editor 的 reported mutation；允许模糊匹配，明确“补丁片段”，不拼完整状态 |
| Command Code（未开放） | ACP 稀疏终态配对；旧 BYOK nonzero 无可靠结构化 exit | read/edit_file 路径 | 成功单次 edit_file 为 reported mutation；过滤原生 proposed Diff，replace_all 不冒领 |

MiniMax 与 Pi 相近的是 **结果 patch 的来源**；MiniMax 覆写额外提供 patch 和 created，比 Pi Write 的路径观察更丰富。
它仍不等同于 DSH 的完整 before/after 或 Codex 的 whole-turn snapshot，也不按完整状态链抵消多次修改。
没有原生结果的删除/移动、通过 Shell 修改文件，均不因本次补验自动获得文件卡片。

### 本次实际文件验收

真实 mcode＋生产 Core＋确定性 loopback Provider，未使用收费模型或日常账号。
用真实 native `read/write/edit`，不是 Shell 替代。数据库 Evidence 和 camp snapshot 均读回；没有启动 Renderer。

| 用例 | 结果 |
| --- | --- |
| 绝对与相对 Read，中文/空格路径 | 均有 schema-2 typed read，文件路径准确，不产生 Files Changed |
| Write 新建（绝对/相对） | `changeKind=add`，一张文件卡；原生没有 patch，不编造计数 |
| Write 覆盖非空文件 | `update`，真实 patch `+1/-1` |
| Write 已有空文件 | `update`，真实 patch `+1/-0`，没有误标新增 |
| Edit 修改 40 行文件中间一行 | patch 保留真实 hunk 坐标，`+1/-1`，没有显示行号/省略号混入 |
| Edit 改回 | 本次操作单独 `+1/-1`，实际文件回到原文；不当完整文件净差异 |
| Edit 找不到旧文 | Tool failed，文件不变，没有成功文件操作或 Diff 卡；Run 可正常结束 |
| 相对路径 Edit | 结果 patch 的绝对 header 与输入相对 path 词法对齐，通过 |
| Core 重启读回 | 7 张文件卡、路径/计数/revision/文件 ID 均一致 |

共 **10 个文件场景＋1 个重开检查**。首个调查脚本曾用了引擎内部 `{path,edits}`，实际对模型公开的是
`{file_path,old_string,new_string}`，导致三条 Edit 参数校验失败；该轮不是编辑通过。修正夹具后独立取得
修复前真实错误投影，再用新 Core 复验。完整脱敏记录见[本轮证据](full-parity-2026-10-16.evidence.json)。

## 4. 全 19 款：权限、MCP、Skills 与数值来源

权限列为当前产品默认的原生值，不是所有支持选项。“原生 Skills”只表示走同一 Skills v2 来源体系，
不是再造 `.runtime/skills` 的旧受管投影；完整热更新/冲突资格仍需逐版本实测。
费用为可归属 Run cost 才入账，Context 是占用量，不能用 Session totals 填 Run。

| Runtime | 当前默认权限 | MCP 路线/同名策略 | Skills 原生发现声明 | Usage 主来源/边界 |
| --- | --- | --- | --- | --- |
| **MiniMax Code** | bypassPermissions＋Session default；另有 auto/default、plan | ACP Session，RovaiWins；echo/撤销控制验证 | Minimax group，DocumentationOnly | SQLite 精确定位 assistant journal；input/cache/output；尾部可缺失，无完整 Run cost |
| Codex | danger-full-access / never | 原生配置，NativeWinsSkip | Verified | app-server tokenUsage；Context 分开；价格估算只有既有明确准入模型才启用 |
| Claude Code | bypassPermissions | 私有原生 MCP 配置，RovaiWins | Verified | stream 逐调用＋terminal；已提供费用来源可用 |
| Pi | `{}`，无 Rovai 审批/sandbox | 产品明确不接 External MCP；不启动 Server | Verified | message_end 原生 usage，Context 数值 RPC；没有凭空估算费用 |
| DeepSeek Harness | danger-full-access / never | ACP scoped 参数，RovaiWins whole definition | Verified | 官方 committed observer；摘要调用须精确归属；缺 cache/cost 保持未知 |
| OpenCode | permission=allow | ACP Session，RovaiWins | Verified | 原生数据库/完成事件＋ACP gauge；按当前 native format 归属 |
| GitHub Copilot | allow_all=on | additional-mcp-config，RovaiWins | Verified | subscribed assistant.usage；不重复加 Session 终态累计 |
| Kiro | trust_all_tools=on | Host 私有 Agent 配置，RovaiWins | Verified | metadata 比例＋精确模型窗口；独立 Run token/used 仍有来源缺口 |
| Qoder | bypass_permissions | 原生 additive config，RovaiWins | Verified | 根 journal＋模型窗口；已观测 cache 不代表全部调用完整 |
| CodeBuddy | bypassPermissions | 原生 mcp-config，RovaiWins | Verified | 根 journal rawUsage＋ACP gauge；自定义模型可能缺窗口 |
| Qwen Code | approval_mode=yolo | 原生 additive config，RovaiWins | Verified | 私有原生 usage＋ACP gauge；缺失桶不算零 |
| TRAE CLI CN | bypass_permissions | ACP Session，RovaiWins | Verified | 原生 events.jsonl＋精确模型目录；prompt used 不加 response |
| Kimi Code | yolo | ACP Session，RovaiWins | Verified | 根 wire step.end.usage＋ACP gauge；缺 reasoning 不补猜 |
| Grok Build | bypassPermissions | 私有原生 MCP Plugin，NativeWinsSkip | Verified | turn_completed 原生 usage＋Context metadata；不重复累计 |
| ZCode | yolo | 原生运输桥内 scoped 投影，RovaiWins | Verified | 原生 turn/model-io 数值映射；缺字段保持未知 |
| Antigravity | accept-edits / sandbox off / skip on | 当前不接 External MCP | Verified | 精确根 step stream＋只读原生 SQLite；不是 Session result 累计 |
| Cursor（未开放） | agent / force | 当前未接，不等于上游永久无 MCP | DocumentationOnly | 当前无合格 Usage 来源，不能从普通文本推断 |
| Cline（未开放） | act / auto_approve=true | ACP 字段不消费，Host 私有 native config，RovaiWins | DocumentationOnly（有特定版本真实 Skill 记录） | 官方只读 Plugin 数值，观测失败不伪造；不复活退役 Hub |
| Command Code（未开放） | bypass | Host 私有 mcp.json，NativeWinsSkip | DocumentationOnly（有特定版本真实 Skill 记录） | prompt `_meta.usage`；Session 累计值不重复入账；reasoning/Run cost 有缺口 |

MiniMax 模型目录的具体区别：ACP 广告的完整 provider/model/variant ID 原样保存，通过
`session/set_config_option(model)` 核验，`thinkingEffort` 只取对应模型实际广告的选项。
Command 的自定义 BYOK 在普通 CLI 有目录，但所测 ACP 拒绝 set_model/set_config_option；OpenCode/Pi
有自定义模型切换正向证据。不能把“ACP 通用支持 set_model”当作 MiniMax 或 Command 的实现。

## 5. Steer、图片、完成与协作能力

| 项目 | MiniMax | 其他 Runtime 对照 |
| --- | --- | --- |
| 运行中输入 | `mcode/session/steer`，text/clientRequestId，精确 Turn/steered 回执 | 当前代码另有 Codex、Claude、Pi、CodeBuddy、Qwen、Grok、Kiro、ZCode、TRAE，共十种；其余九种不开放 Steer |
| 图片 Steer | 附件授权路径 → native read → Provider image_url，控制服务已验证 | Pi 可直接发原生 images[]；其余八个已接 Steer Runtime 同样走授权路径读图；能力受原生工具/模型限制 |
| 结束竞态 | 使用共同 delivery/Run/epoch；accepted/unknown 不盲目回放 | 各 Runtime receipt 不同；Claude 可处理受管执行后续消息，不承诺与每款原生 Turn 定义相同 |
| 队列/后台任务 | mcode 自带 queue/goal/delegation 不是 Rovai 的 Task/Mission/Peer | Rovai 协作统一由 bundled CLI/租约与持久消息调度；不能把原生子 Agent 算作新增 Rovai 队员 |
| Final / thinking | ACP prompt stopReason 为终态，thought 私有；send 子集与 Missing-Send 控制通过 | Codex turn completed、Claude result、Pi settled、ZCode 原生终态各有 owner；没有 final 就不能仅凭 stdout 恢复公开消息 |
| Search/Plan/Ask | 标准 kind/plan 通路；没有 MiniMax 专用 Web/file query 或 ask-user UI 准入 | DSH/Codex/Claude 等有窄的 typed search 来源；MiniMax glob/grep/web 工具不能仅凭名称宣称同等展示 |
| 当前内置 CLI | 每 Run 使用 bundled rovai；send 与 cold 后 lease 主路径通过 | DSH/Pi 有既有完整 operation 集验收；MiniMax 还没有当前全集、旧 lease/并发全矩阵证据 |

## 6. 尚需闭合的差异与本轮边界

按优先级继续同一接入任务：

1. **真实账号/模型 Golden Flow**：已有尝试在 `session/new` 返回 `Authentication required: Run mcode login and try again.`。
   本地合成 Provider 不替代此项；未改用户日常凭据或 Provider。
2. **Compact**：分别触发 manual、threshold、overflow＋automatic retry、失败/取消、compact 后 cold，核对
   System、记忆、Skill/MCP/权限与 Session。是否增加执行台展示单独评价，不为了打勾安装 detector。
3. **配置和能力刷新**：原生外部 Auth/Provider 改动、模型切换后 effort、原生 Skills 实际读取/更新/禁用/同名、
   相邻会话隔离；MCP 的 HTTP、冲突及并发/秘密/取消完整矩阵。
4. **运行生命周期**：同 Runtime 多 Session 切回、并发 Host、生产 LRU、Runtime/Core crash、协议失败、迟到事件、
   取消宽限后无副作用和旧 lease；不能用共享单测代替目标版本真实流程。
5. **输出/观测剩余项**：文件 UI 实际点击、超限 patch/多文件/删除移动的实际边界、Usage 短 Run/尾部/retry/compact
   对账、当前内置 CLI 正式全集。未知数值继续未知；图片只证明传输，不冒领视觉理解。
6. **平台**：其余 macOS x64/Windows x64/Linux x64 尚无 MiniMax 资格。本次不改其他 Runtime 的资格，Fast 按要求不接。

本次修复只使用现有字段、配对、文件投影与 patch 校验，没有增加配置冻结对象、进程池、恢复账本、磁盘快照、
Git 捕获或 Runtime 专属 UI。持久化格式沿现有 schema，File Change v8 记录新的来源准入，旧 Evidence 不回填。
控制服务主流程、文件补验、Rust owner/共享回归及文档门禁分开记录，不把测试项数相加为真实模型资格。


## 7. 本轮回归与证据清理

| 检查 | 结果 |
| --- | --- |
| 原生 mcode 控制主流程 | 23 checks / 15 Runs；14 succeeded、1 预期 cancelled |
| 原生文件补验 | 10 Runs＋Core 重开，11 checks；7 张文件卡保持一致 |
| ACP extended owners | 68 passed、2 ignored |
| Runtime Diff extended owners | 17 passed |
| Application 公开字段 owner | 1 passed |
| `pnpm test:rust:pr` | 473 passed、0 failed、1 ignored（Core lib 427、CLI 31、Host 4、Web 11） |
| 文档 | `docs:test` 10 passed；`docs:check` 和基于实现前 base 的 `docs:check:ci` 通过 |
| 格式与脚本 | `cargo fmt --check`、`node --check`、`git diff --check` 通过 |

首次默认回归发现前轮提交更新兼容性清单后漏同步 macOS source digest；已按最终文档字节修正并全量复验。
这没有扩大 MiniMax 或其他 Runtime 的资格，首次失败也保留在 JSON。四组临时实测均已退出，四个派生
Runtime Files Root 按现有 owner marker 校验清理；日常 App、原生账号与凭据未修改。
