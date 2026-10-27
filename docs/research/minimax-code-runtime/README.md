---
document_type: research-report
authority: observed-minimax-code-runtime-integration
status: in_progress
last_updated: 2026-10-18
---

# MiniMax Code ACP 接入与对照

对象为 `@minimax-ai/code` 的 `mcode`，不是 mmx-cli。实施基线为
`3979e32ec4834ce5fc02cd72309bbd7b5cd800c6`，调查安装为 0.6.12（macOS arm64）。
User 在 Thread seq6 授权实施下表方案，并要求完成后重新比较；seq4 明确不接 Fast。

User seq8 后的[全部 19 Runtime 完整对照](full-parity-2026-10-16.md)补齐 System/compact、原生
Read/Write/Add/Edit/Diff、权限、Skills/MCP、数值与当前产品状态。原生文件补验发现并修复预览误当完整状态、
相对 Read 丢路径与 Write 创建标志遗漏；[新增证据](full-parity-2026-10-16.evidence.json)与下方前轮证据分别记账。
下面的 Shell 写文件不是原生 Write/Edit 验收；A/B 是同一 Conversation 两轮，不是跨原生 Session A→B→A。

## 2026-10-18 Linux x64 准入

[目标主机完整验收](linux-qualification-2026-10-18.md)闭合 14 个能力轴，Linux x64 晋升 Qualified，
绑定[独立证据](../../../qualification/runtime-platform/linux-x64-minimax-code-v1.json)摘要。
官方 0.6.12 / Node 24.21.0 / 真实 Sub2API gpt-6.1-sol、生产容量/TTL、全部 30 个 CLI 操作和 Linux
浏览器分别记账；修复纯工具调用与压缩换代的 Usage 漏采。原生管理命令取消、相同请求重试、部分
统计与 plan/bypass 的边界均在报告披露，不外推其他平台或所有发行版 Runtime 执行。

## 2026-10-18 Windows x64 完整目标机验证

官方 mcode 0.6.12 在 Windows 10 x64 经真实 sub2api 模型与分开记账的受控 Provider 完成
十四轴和九个 Golden Flows。修复私有 Bootstrap 目录 ACL、原生 Usage 的 Windows cwd 匹配、
模型可见 Skill 路径；Windows 行为 Qualified，绑定[独立证据](../../../qualification/runtime-platform/windows-x64-minimax-code-v1.json)。
30 分钟真实 idle、压缩后能力/取消、当前 29 项 CLI 和打包 App 退出恢复均有记录。
具体批次、失败纠正和上游限制见[Windows 报告](windows-qualification-2026-10-18.md)，不继承给其他平台。

## 2026-10-18 macOS Intel 平台验收确认

User seq43 确认将 macOS Intel 标记验收通过，Core 的 `minimax-code-cli × macos-x64` 为 Qualified。
[独立记录](../../../qualification/runtime-platform/macos-x64-minimax-code-v1.json)绑定确认消息与摘要；
本次没有重跑 Intel 模型会话，也未取得其 CLI 版本或逐项日志。macOS arm64 仍为 Preview，
该批次时 Windows/Linux 仍为 NotQualified；两平台后续结论见上方独立记录。以下历史批次和能力矩阵按各自实际测试范围读取。

## 2026-10-17 问卷取消的产品修复

User seq37 授权后的[产品修复](questionnaire-policy-2026-10-17.md)新增
`runtime_questionnaire_unsupported` 与“未提交答案、发新消息继续”的公开提示；非空结束文字
和已发送消息都不能掩盖未承接问卷。17 项控制场景与两轮真实 LLM 已验证，
[本轮证据](questionnaire-policy-2026-10-17.evidence.json)单独记录，不覆盖以下历史批次。
保留原生错误/取消优先级、普通审批及后继 Session，不隐藏工具、不改日常配置、不自动续跑。

## 2026-10-17 问卷取消与续接复核

User seq35 改按“暂不支持原生问答、明确取消、不代答”验证，结果见
[取消与续接报告](questionnaire-cancellation-2026-10-17.md)及
[脱敏证据](questionnaire-cancellation-2026-10-17.evidence.json)。官方 0.6.12 的控制服务矩阵与真实
开发 App 均观察到问卷 dismissed、没有用户答案，失败后新指令沿同一 Session 正常完成。
当前问卷 Run 仍失败，不能自动转为普通 Thread 提问，也没有隐藏工具。
按此方向，不再把上游局部关闭开关作为本轮阻塞项；此前候选未安装、用户原生配置未改。
其他 Runtime 分别记录取消、skipped、禁自动解答或未发现统一禁用，不能合称“已全部关闭”。

## 2026-10-17 批复修复

共享 ACP 的已发送空 final 结束规则、问卷审批防代答和 MiniMax 有界 Usage 尾读见
[修复与剩余缺口](review-fixes-2026-10-17.md)。ask_user 默认工具移除仍缺官方局部入口，
产品默认未改；不扩大 Preview 资格范围。

User seq23 的[继续修复记录](continuation-2026-10-17.md)补充七行上游局部开关候选、
五项源码隔离验证和官方 0.6.12 最新开发包的三轮真实模型验收。候选未替换安装版，
问卷默认隐藏仍未正式交付；不把公开源码 0.6.5 的结果外推到 npm 0.6.12。

## 最新真实验收（User seq10/11）

[真实模型与开发 App 验收](live-acceptance-2026-10-16.md)及[脱敏证据](live-acceptance-2026-10-16.evidence.json)
补齐官方账号、Sub2API、真实图片理解、原生文件界面、手动 compact 后冷恢复、MCP 与 Skill 更新。
仍保持 Preview；官方额度后来返回不足，留给 User 的隔离开发 App 使用已验证的 Sub2API。
下文为前轮控制服务记录，认证缺口和“下一步”按最新报告读取。

User seq17 的[配置刷新、自动压缩与 Ask-user 复核](followup-2026-10-16.md)进一步证明：
当前 Core 路径中地址/Key 下一 Run 热刷新不更换 Host/Session；真实 threshold 自动压缩及随后连续性通过。
原生 ask_user 当前问卷被 dismiss 并导致 Run 缺少最终输出，建议默认关闭，产品默认尚未修改。
该复核修正“缺配置摘要需优先补齐”的判断，不扩大成全部刷新或完整压缩故障资格。

## 实施前 Parity Matrix

参照共享 ACP 的 Kimi/DSH 生命周期、Claude 启动文件和 Codex 的精确恢复。
`Verified` 必须注明真实模型或脚本模型范围；表中待验项不构成 First-Class 资格。

| 能力轴 | Rovai 行为与上游能力 | 接入策略 | 实施前证据 | 差异 |
| --- | --- | --- | --- | --- |
| Auth / Provider / Model | 原生登录/BYOK；ACP model、thinkingEffort | 读取原生来源，按广告目录选模与校验 | 官方源码、0.6.12 握手；真实模型待验 | model 值包含 provider/model/variant，不拆成猜测的模型名 |
| Host / Fleet / LRU | 驻留 ACP Host | 共享 Fleet，在同 Camp/成员/Binding 内复用 | 实际 CLI＋本地模型服务：同 PID 连续两轮 | 启动系统提示真实改变时替换 Host |
| Native Session | 精确 session/resume，也有 session/load | 共享 continuation、replay quarantine 和失败分类 | 实际 CLI＋本地模型服务：新进程恢复原 ID，历史保留 | 不使用最近 Session；不因 Bootstrap/Run 摘要换 Session |
| Bootstrap / Context | --append-system-prompt-file 高权限注入 | 既有 native_append，启动前写私有文件，Host 生命周期持有 | 实际 CLI：每轮系统层一份；修改文件不热更新，重启+resume 生效 | 沿现有 Run 冻结；不改变 section、格式或选择规则 |
| Compaction | 原生系统提示独立于消息历史 | 验证 native_system_prompt_preserved | 源码；manual/auto/overflow 待验 | 不为完成清单另建 detector |
| Skills | 原生多生态目录；Rovai 平台/工具箱索引 | 只读发现原生来源，沿现有四类来源规则 | 官方来源与目录待实测 | 不新增项目投影 |
| External MCP | ACP session mcpServers | 共享投影，同名 ACP Session 优先 | 上游源码；调用与恢复待验 | 保留原生 builtin/plugin 的上游边界 |
| Tool / Action / Output | 结构化工具状态、rawInput/rawOutput、Diff | 共享 ACP 配对、权限和活动归约 | 上游源码；真实工具待验 | 后台命令必须验证终态和清理 |
| Narration / Final | ACP chunks 与 prompt stopReason | 共享 final/Missing-Send；公开发送走 rovai CLI | 本地模型服务 end_turn；公开发送待验 | final 不自动作为公开消息 |
| Permissions / Workspace | default/auto/bypassPermissions；default/plan mode | 原生 config/mode RPC；共享审批与授权 | 官方源码；allow/deny/cancel 待验 | permissionMode 为 process scope，现有 Fleet 已隔离 |
| Built-in CLI | 工具子进程调用 bundled rovai | 共享逐 Run lease，不新增 MCP 运输 | 待产品验收 | 无新增运输 |
| Usage / Cache / Cost | ACP Context gauge；原生 assistant journal 有 token/cache/cost | 共享数值归约；精确 Session 的只读 journal baseline | 脚本模型 journal 已观察，归属/去重待验 | 不把 Session 累计费用记作本 Run |
| Retry / Queue / Cancel | ACP cancel、原生队列与后台任务 | 共享取消、停止和进程树回收 | active Steer 接受、idle Steer 拒绝已实测 | accepted/unknown 不自动重发 |
| Ready / Version / Platform | mcode 安装、ACP 初始化 | 共享发现和延迟验证，逐平台证据准入 | macOS arm64 控制面已测 | 不外推 Windows/macOS x64/Linux 资格 |
| Steer / 附件 | mcode/session/steer(text, clientRequestId) | 共享 Run/epoch 门禁与附件路径 | 脚本模型下一请求收到插话；图片待验 | 无原生 Steer image block，与现有路径读图方式对齐 |
| Fast | 用户明确排除 | 不提供 Fast 控件或 highspeed 映射 | User seq4 | 用户指定范围 |

## 输入与恢复边界

只为新 Adapter 交付现有完整 Bootstrap 和 Dynamic Context，既有 Runtime 的模型可见
字节、选择结果、证据结构以及 Formatter/Manifest/Profile 版本轴不变。
同 Run 恢复既有准备字节，新 Run 按当前 ContextService 组装；系统提示内容不成为
Native Session 恢复资格。仅原生进程实际读取的启动内容参与该 Host 的兼容判断。

## 来源

- [官方仓库](https://github.com/MiniMax-AI/minimax-code)
- [启动系统提示](https://github.com/MiniMax-AI/minimax-code/blob/9a935605956c4500e9cb415f29258e2887e97817/packages/tui/src/cli/system-prompt-options.ts)
- [ACP 与 Steer 扩展](https://github.com/MiniMax-AI/minimax-code/blob/9a935605956c4500e9cb415f29258e2887e97817/packages/tui/src/acp/extensions.ts)
- [接入 Checklist](../../development/runtime-integration-checklist.md)

## 初始实施与验收结果（2026-10-16 快照）

以下保留初始批次及当时未验项；当前 Linux 资格以上方 2026-10-18 独立记录为准。

已接入 `mcode acp`、目录/安装/成员参数、Skill group、MCP、共享 Host/Fleet、精确恢复、
Bootstrap、Steer、审批/取消、Action 输出及数值 Usage。Migration 205 将 v1.72 schema 154
升级为 155；没有改动已有 Session 数据。代码位于独立分支 `rovai/minimax-code-acp`。

**当前为 macOS arm64 Preview，正式 First-Class 接入尚未完成。** 其余平台 NotQualified，
所有平台均无 qualification evidence revision。没有合并或安装日常 App。

证据分为三类，不能互相替代：

1. 真实安装的 **mcode 0.6.12**、当前生产 Core 与确定性本地模型服务：覆盖实际协议、工具进程、
   数据库、MCP 与生命周期；模型只按脚本返回工具调用，不证明模型理解或自主行为。
2. Rust/TypeScript 回归：覆盖模型选项、Native Session 错误分类、Steer 回执、审批配对、Usage
   归属与迁移安全，不能替代真实 Runtime 验收。
3. 真实账户尝试：隔离复制原生配置后，`session/new` 返回
   `Authentication required: Run mcode login and try again.`，尚未完成真实模型生成。

控制验收共 **23 项通过**，15 个 Run 中 14 个成功、1 个按预期取消。逐项结果及二进制摘要见[脱敏证据](verification-2026-10-16.json)。重跑入口为
[`scripts/smoke-minimax-runtime.mjs`](../../../scripts/smoke-minimax-runtime.mjs)。

| 能力轴 | Runtime evidence | Rovai implementation | 已验证范围与剩余工作 |
| --- | --- | --- | --- |
| Auth / Provider / Model | Verified（本地 BYOK）；真实账户 NotObserved | Implemented | 原生 default、catalog/config ACK；真实登录和凭据/Provider 刷新仍待验 |
| Host / Fleet / LRU | Verified（控制服务） | Implemented | 普通 A/B 同 PID；Core 重启换 PID；完整并发、LRU 故障矩阵待验 |
| Native Session | Verified（控制服务） | Implemented | warm/cold 同 Binding 与原生 ID；精确缺失 Session 替换通过；不使用最近 Session |
| Bootstrap / Context | Verified（控制服务） | Implemented | 主模型每次请求系统层一份 Charter，Dynamic Context 在 user；启动文件更新边界有原生控制实验 |
| Compaction continuity | DocumentationOnly | Implemented（原生 System 持续策略） | manual、threshold、overflow+retry 及压缩后冷恢复均未完成产品验收 |
| Skills | DocumentationOnly | Implemented（沿共享来源发现） | 受管索引/原生项目 Skills 的实际读取、增删及相邻会话隔离待验 |
| External MCP | Verified（控制服务） | Implemented | 分配后实际 echo 调用；取消分配后 Tool 消失，Native Session 保持；同名/并发/故障完整矩阵待验 |
| Tool / Action / Output | Verified（控制服务） | Implemented | stdout、stderr、混合、空、非零、100 KB 输出；审批 ID 差异已适配 |
| Narration / Final | Verified（控制服务） | Implemented | prompt end_turn、工具后 final、零发送恢复和有发送去重；真实模型边界待验 |
| Permissions / Workspace | Verified（控制服务） | Implemented | allow/deny 各一次；取消等待命令及子进程清理；原生目录限制和完整权限矩阵待验 |
| Built-in CLI | Verified（send 子集） | Implemented | 实际 bundled `rovai send --public-only --input-file`，新 Run/冷恢复均有效；正式 operation 全集未测 |
| Usage / Cache / Cost | Verified（数值 journal 子集） | Implemented（部分字段） | 精确 Session、baseline、去重；观察到 input=100/cacheRead=20/output=5；短 Run/尾部可能缺数，Run cost 不估算 |
| Retry / Queue / Cancel | Verified（控制服务子集） | Implemented | 同 Run Steer、allow/deny、cancel 子进程退出；完整 crash/timeout/retry/late-event 矩阵待验 |
| Ready / Version / Platform | Verified（macOS arm64 0.6.12 控制面） | Implemented | 可发现/配置并实际执行；只设 Preview，不代表认证或跨平台资格 |
| 图片 Steer | Verified（控制服务传输） | Implemented | 授权路径进入插话，native read 后真实请求出现 image_url；尚无真实模型视觉理解证明 |
| Fast | User 明确排除 | Disabled | User 明确排除；原生 highspeed 仍可作为普通模型，不做 Fast 映射 |

### 与其他智能体的实现后对照

| 对比项 | MiniMax Code | 其他已接 Runtime |
| --- | --- | --- |
| 接入运输 | 官方 ACP，增加窄范围原生字段适配 | Kimi/Qwen/Grok 等复用 ACP；Codex app-server、Claude stream-json、Pi JSONL RPC 各自有运输 |
| System / Freeze | 启动 append 文件；复用现有准备字节和 Host digest | 接近 Claude 原生 append；Codex 使用其 developer/system 接口。没有新增冻结对象 |
| Host / Resume | 普通后继同 Host；真正启动内容改变时新 Host，精确恢复同一 Session | 沿既有 Fleet/continuation；不因 Run 摘要、时间或历史长度换 Session |
| 插话后 Host | 沿共享 ACP `retire_after_steer`；后继新 Host、同 Session | 这项共有策略同样适用于相关 ACP Runtime；普通 warm reuse 不代表插话后仍留 Host |
| Steer 方法 | `mcode/session/steer` 返回 Turn 与 `steered` | Codex/Pi/各 ACP 扩展有各自回执；均服从同一活跃 Run、epoch 和输入归属门禁 |
| 图片 Steer | 授权文件路径 → native read → 模型图像内容 | Pi 直接发送原生 `images[]`；Codex、Claude、CodeBuddy、Qwen、Grok、Kiro、ZCode、TRAE 同样走授权路径读取，能否理解依赖原生工具和所选模型 |
| 模型参数 | opaque provider/model/variant ID；`set_config_option`；thinkingEffort 按模型广告 | 不假定所有 ACP 都支持 `set_model`，也不把一款模型的 effort 复制给全部模型 |
| 审批与输出 | permission ID 与 tool-call ID 不同；工具输入是 JSON 字符串；正文在 rawOutput.content | 对齐共享 Action 前先精确配对；未知/歧义不按相似命令猜测。其他 ACP 的已有字段规则保持 |
| Workspace roots | 0.6.12 明确拒绝 additionalDirectories，省略该扩展 | 部分 ACP 接受该扩展。Core 附件授权仍保留，不能宣称 MiniMax 因此有额外目录沙箱 |
| Usage | 原生 SQLite 定位精确 journal，读取 token/cache；异步采样可能不完整 | 有正式逐调用 Usage 的 Runtime 更直接；MiniMax 不用 Session 总计或价格推算填满缺值 |
| Fast | 不接 | 与模型目录独立；其他 Runtime 的 Fast 能力不移植到 MiniMax |
| 成熟度 | Preview；真实账户与完整 checklist 待验 | 不能与已经取得对应版本/平台完整资格的 Runtime 等量宣称 |

本分支共有十种产品 Steer 接线：此前九种加 MiniMax。这个数量是代码支持范围；其中 MiniMax
只有本次真实 CLI＋脚本模型证据，不把它算作新增的真实 LLM 完整验收。

### 实际发现并修复的差异

- 原生目录包含当前版本无法选择的候选 variant；某候选配置失败时保留其他目录，并在正式显式选模时校验 ACK。
- `additionalDirectories` 会使 MiniMax new/resume 直接失败；仅对该 Adapter 省略。
- 审批 `perm_*` 与模型工具 `call-*` 不同；按同 Session/Prompt、完整输入和名称的唯一匹配关联，
  保存确切 alias 后处理稀疏终态。歧义拒绝，跨 Session/Prompt 不匹配。
- 原生输出位于 `rawOutput.content`，退出码位于 `details.execution.exitCode`；按明确字段读取，
  私有 details、路径及 native stderr 不投影为公开输出。
- 自定义图片 Provider 必须在原生配置声明图像能力；控制测试补齐 `--support-image` 后，
  native read 的图片实际到达模型请求。只收到授权路径不等于已经发送图像。

### 验证与下一步

普通 Rust library 回归 **427 通过、1 ignored、0 失败**；extended native 组 **64 通过、1 ignored**。
迁移回滚/历史源收敛、精确 RPC 错误、Steer 归属、权限配对和公开输出 owner 均通过；
Frontend 相关 **37 项**及 typecheck 通过。具体命令、阶段和证据范围见 JSON；测试数量不合并计算。

完整收口仍需先完成 `mcode login` 或原生 BYOK 配置，再运行真实模型 Golden Flows，以及上表的
压缩、Skills、完整 CLI/故障/平台矩阵。保留原生版本、全部失败尝试和当前 Preview reason，
不以控制服务通过替代 First-Class。未改动日常 MiniMax 的凭据或 Provider 配置。
