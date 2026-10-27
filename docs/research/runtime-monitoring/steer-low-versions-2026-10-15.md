---
document_type: research-report
authority: observed-runtime-evidence
status: completed-with-qualified-boundaries
last_updated: 2026-10-15
---

# Steer 低版本隔离验证

范围：User seq36（`108ef253-fba1-4a58-b059-d82a1a11f2f3`），macOS arm64。
生产代码基线为 `44953f685781fad7c6be50dd0608cf7448009f04`；本轮没有修改 Runtime、Adapter、
消息结构、动态上下文、提示词或任何版本门槛。新增的是验收工具和本报告。

**六种 Runtime 找到了更低的完整链路通过版本。Codex、Kiro 的候选原生能力通过，但当前接线不兼容；
TRAE 的低版本通道通过，产品仍待适配。** 这不是九个“已确认最低版本”。

[逐次结构化证据](steer-low-versions-2026-10-15.evidence.json)保存版本、官方包摘要、实际模型、
回执关联、case 结果、失败与作废记录。原有新版通过证据仍见[上一轮清单](steer-minimum-versions-2026-10-15.md)。

## 结果清单

“完整通过”指本轮当前 Core／Adapter 的三个独立同轮场景，加停止、续接和结束边界场景通过；
不代表穷尽竞态、附件类型或所有历史版本。模型与环境条件见后文。

| 智能体 | 本轮低版本结果 | 当前 Rovai 接线 | 版本边界与限制 |
| --- | --- | --- | --- |
| **Pi** | **0.99.0 完整通过** | 原生 RPC `steer`，3/3 | 0.87.0 无 `disposition`；0.99.0 的必要字段与实测吻合 |
| **Qwen Code** | **0.18.4 完整通过，有配置条件** | ACP 结构化 `items/content`，3/3 | 0.18.3 只读旧 `messages` 字符串；0.18.4 需旧版支持的鉴权配置 |
| **Grok Build** | **1.0.14 完整通过**；1.0.13 同轮与边界补测通过，但有失败记录 | ACP `_x.ai/interject`，两个版本均 3/3 同轮 | 不把 1.0.13 定义为不支持；首次停止续接出现 Internal error，未锁定稳定最低版本 |
| **Claude Code** | **2.1.83 完整通过，sub2api** | Stream JSON 追加 user＋回显，3/3；另有原生 3/3 | 2.1.81 官方包缺当前结束状态事件；1.0.108／109 不满足启动要求 |
| **CodeBuddy** | **2.109.1 完整通过**；2.111.0 也通过 | 保持 ACP 并发 `session/prompt`，各 3/3 | 更低候选遇到服务端 400／429；最低版本未锁定。2.132.0 有连续输入异常 |
| **ZCode** | **App 3.12.2／内核 0.16.5 完整通过** | 官方 App Server `v4/command → sendText → guide`，3/3 | App 3.14.1／内核 0.16.9 也有三次有效通过；更早 3.11.2 下载受阻 |
| **Codex** | **0.99.0、0.100.0 原生各 3/3，并通过原生边界验证** | **两个候选均不兼容当前完整接线** | 0.99.0 不接受 `--listen`；0.100.0 缺当前 `runtimeWorkspaceRoots` 能力。原有完整通过值仍为 0.162.1 |
| **Kiro CLI** | **v2 2.7.0 原生 3/3** | **2.7.0 不兼容当前回执／消费事件解析** | 2.6.0 无方法；2.7.0 有旧事件但无当前依赖的消息 ID。原有完整通过值仍为 2.21.1 |
| **TRAE CLI CN** | **0.207.1、0.208.1 通道各 3/3，边界与连续输入通过** | **产品待适配** | 0.207.1 是本轮最早通道正例；0.120.52 至此之间的完整发布边界未覆盖 |

Cursor、Cline、Command Code 继续排除。当前通道无正例的 Qoder、Kimi、OpenCode、DeepSeek Harness、
Copilot、Antigravity 不属于此次降低已支持版本的范围；本轮没有改变它们的既有结论。

## 验证方式与证据强度

采用“自动验收”通道。每次 Core、SQLite、Skills、MCP、cache、原生 Home 和项目目录相互隔离；
没有安装这些旧版到日常路径，也没有重启日常 App。历史可执行文件固定到 Runtime 启动配置，
并核对解析后的真实入口、报告版本和摘要，不能仅靠发现用的环境变量选择历史版本。

生产 Core SHA-256：`7443a1776c3a10d08f5dad35f3691313802ae7a5380d9ba956bed6751fc6facc`。
普通运行与 Steer 都调用既有 Builder／Formatter；每条 Steer 的 Context Manifest 只引用该条新消息。
本轮检查到同一 Run 中的 initial＋两条 Steer，未增加后继 Run，且最终文件采用第二条更正。

| 阶段 | 本轮实际检查 | 不能扩大解释的部分 |
| --- | --- | --- |
| 官方包／启动 | 来源、架构、摘要、精确入口、生产必传参数、现有准入与握手 | 参数齐全不等于模型与结束协议兼容；Node 或签名条件单列 |
| 同轮消费 | 独立 Thread 重复三次；原任务进入真实可控工具等待后发送 A、B，最终为 B；Core Run 和逐消息输入关联 | 不能仅凭模型说收到；也不把相同 Session 自动等同同一原生轮 |
| 回执 | Core 的输入状态、消息引用与 native ID；Codex 原轮 ID；Claude UUID 在首次 result 前；Kiro/TRAE 原生事件时间线 | Kiro 旧事件缺 ID，故原生成功不能覆盖当前解析要求 |
| 结束／错误目标 | 工具释放附近投递；完成后使用失效目标。Codex 另测旧 turn 指向活跃后继轮的拒绝；TRAE 测无活跃轮和错误 Session | 这是有限的边界样本，不是所有调度时序的原子性证明 |
| 停止／普通续接 | 第一处工具等待时停止；第一条已消费、第二处等待时再停止；同一 Thread 普通任务成功且无旧写入副作用 | Core 证据包含停止时输入状态；副作用检查不能单独证明模型内部历史已删除 |
| 完整载荷 | 使用生产 Core 的实际动态上下文与 `RUN_INPUT`，保留原 Adapter | 原生小文本结果单列；本轮没有重跑所有附件类型或 UI 场景 |

失效目标在产品层按现有规则转为**一次普通投递**，证据显示 `requested_mode=start`。
这不等同于原生拒绝，也没有将结果未知的原生投递自动重发。Kiro 的未知结果保留为未知。

最初 Qwen 两组、Codex 一组测试被自动发现回退到本机新版；三组已标为**作废，不计入低版本结果**。
修正验收工具后，用固定路径完整重跑。Pi 两组逐一核对确实使用 0.99.0。
另有早期 Pi 探针使用了不存在的探针参数、Codex 参数探针读取了默认配置、旧 Node 启动兼容问题；
这些探针均不作为产品负例。有效的参数负例已在隔离 Home 重测。

## 候选版本逐项说明

### Pi 0.99.0／0.87.0

使用官方 `@earendil-works/pi-coding-agent` 包。0.99.0 三次同轮均通过；两条补充输入关联正确，
结束边界、两种停止时点、普通续接均通过。无模型探针对比确认：0.87.0 的 `steer` 成功响应没有
`data.disposition`，0.99.0 返回 `queued`；两者 `clear_queue` 都返回被清除的精确测试输入。

因此 0.87.0 **明确不满足当前 Steer 回执要求**，不能因它已有 `steer`／`clear_queue` 就降低门槛。
0.99.0 的字段边界也有[官方发布记录](https://pi.dev/changelog/releases/0.99.0)支持。
未逐一跑 0.88–0.98 的 LLM；这部分不是本轮的逐版本运行证据。

### Qwen Code 0.18.4／0.18.3

0.18.4 在本机新版原生配置的 `openai-responses` 鉴权类型下启动报错。隔离副本改用本机已有的
`openai` Chat Completions 配置与 `gpt-5.6-sol` 后，当前 Adapter 三次同轮、全部边界与续接通过。
只改了隔离原生模型配置；仍用 ACP 和结构化 `items/content`，没有改成旧字符串格式。
所以这是**带原生配置条件的当前接线通过**，不能宣传为任意新版配置可直接降级。

对两个官方发布包做无模型代码核对：0.18.3 的 drain 消费者只读取 `messages` 字符串数组，
传当前 `items` 会得到空列表；0.18.4 的解析器支持结构化条目。没有为了让 0.18.3 通过而修改 wire shape。
官方源码：[0.18.3](https://github.com/QwenLM/qwen-code/blob/v0.18.3/packages/cli/src/acp-integration/session/Session.ts)、
[0.18.4](https://github.com/QwenLM/qwen-code/blob/v0.18.4/packages/cli/src/acp-integration/session/Session.ts)。
此负例是发布包解析逻辑证据，没有额外消耗 LLM。

### Codex 0.99.0／0.100.0／0.98.0

三个官方 macOS arm64 原包在本机直接运行被 OS 杀死。保留原包，对独立测试副本做本机 ad-hoc 签名后可运行；
原始与测试副本 SHA 分别记录。测试没有修改程序逻辑，但不能把重签副本称为“官方原包未经处理直接通过”。

隔离配置采用中等推理强度；旧客户端使用本机 ChatGPT 账号调用 `gpt-6.1-sol` 时被模型服务拒绝，
改为本机已有 sub2api Responses 配置后完成验证。该环境失败没有计入 Steer 不支持。

| 版本 | 原生结果 | 当前接线结果 |
| --- | --- | --- |
| 0.98.0 | 无模型 `turn/steer` 返回未知方法；作为专用接口负对照 | 当前 `--listen` 也不支持 |
| 0.99.0 | 用版本原生 `app-server` 启动，3/3；A/B 返回原 turn ID，首次原轮结束前采用 B；错误 ID、迟到、停止、后继隔离通过 | 当前启动必传 `--listen stdio://` 被拒绝；未移除该参数来冒充产品通过 |
| 0.100.0 | `app-server --listen stdio://`，同样 3/3 及边界通过 | 生产准入拒绝：缺 `workspace.additional_roots` 对应的 `runtimeWorkspaceRoots` schema；没有绕过准入 |

[0.99.0 官方发布记录](https://github.com/openai/codex/releases/tag/rust-v0.99.0)证明专用方法的发布点，
但不能证明整个当前 Rovai 接线从该版本就兼容。当前完整通过版本仍沿用 0.162.1；更低完整边界未锁定。

### Grok Build 1.0.14／1.0.13

1.0.14：3/3 同轮、停止前后两种消费状态、普通续接、结束边界均通过。
1.0.13：3/3 同轮通过；首次“部分消费后停止，再启动普通任务”返回原生 ACP `-32603 Internal error`。
同场景新 fixture 复查通过，随后补齐结束边界也通过。未定位该原生错误的根因，不能确定是 Steer 回归或模型／服务问题。

因此 1.0.13 不是“不支持”，也不被包装成一次无异常的完整验收。建议以本轮无该异常的 **1.0.14**
作为后续能力门槛评估候选；最低版本仍未穷尽。本轮未继续试 1.0.0。
[官方 changelog](https://x.ai/changelog/build)记录 1.0.14 的 interjection 原子投递修复；
一次普通成功或一次有限竞态样本都不能替代该异常路径修复的覆盖证明。

### Kiro CLI v2 2.7.0／2.6.0

2.6.0 的 `_session/steer` 在无模型握手后返回 `-32601 Method not found`。
2.7.0 在**真实活跃工具等待**期间三次都返回 `{queued:true}`，发出 `steering_queued`、
`steering_consumed`，随后原 `session/prompt` 回复包含更正要求并 `end_turn`。
这纠正了此前 idle 探针超时不能判断活跃轮能力的问题；[2.7 官方发布记录](https://kiro.dev/changelog/cli/2-7/)与实测一致。

然而，2.7.0 事件按 payload 文本关联，没有当前 Adapter 依赖的消息 ID，以及
`AgentExecutionUserMessageQueued`／`AgentExecutionSteeringInjected` 事件。
完整 Core 尝试留下 `delivery_unknown`，没有取得消费确认，也没有在 fixture 上限内成功结束。
结论为**原生能力通过，但当前接线不兼容**，不是把 2.7.0 判成不支持插话。
当前解析的必需字段已缺失，未继续把该版本的完整停止／续接列为通过。2.7.0–2.21.1 的事件变化边界尚未定位。

### Claude Code：1.0.108／109 → 2.1.83

保持 Stream JSON、追加 user 与输入回显，Provider 为 **sub2api**。历史 JS 包使用隔离入口选择
Node 22.0.0；入口只选择 Node，不删减当前参数。Node 26 启动旧 JS 的兼容异常不算 Steer 负例。

| 检查点 | 观察 | 证据类型 |
| --- | --- | --- |
| 1.0.86 | 缺 `--include-partial-messages`，也缺当前 bootstrap 文件参数 | 无模型参数／发布包 |
| 1.0.108、1.0.109 | 有 partial 参数，仍拒绝 `--append-system-prompt-file` | 无模型实际参数检查 |
| 2.0.32 → 2.0.33 | 后者开始具备 bootstrap 文件参数；2.0.33 的当前准入仍缺 `session.no_persistence` | 实际发布版本抽样、Core 预检 |
| 2.1.37 → 2.1.38 | 后者具备选定配置可能需要的 `--effort`；不能仅凭此确定完整下限 | 发布包核对 |
| 2.1.38 | 模型目录查询超时 | Core 预检；暂时性失败，不作为 Steer 负例 |
| 2.1.50、2.1.52 | 在本轮隔离配置下，原生鉴权检查返回 `loggedIn:false / authMethod:none` | Core 预检；环境受阻，没有调用 LLM，不作为 Steer 负例 |
| 2.1.53 | 预检通过，真实执行却缺 result 后完整 idle 状态，报 `runtime_stream_incompatible` | 真实 Core；普通续接同样失败 |
| 2.1.70、2.1.77、2.1.81 | 发布包没有当前使用的 session-state 事件开关／事件 | 无模型包核对 |
| **2.1.83** | 所有当前参数、结束状态、三次同轮及边界通过 | 真实 Core＋另三次原生探针 |
| 2.1.84、2.1.86 | 2.1.84 包具备状态事件；2.1.86 先行三次 Core 同轮通过 | 包核对／较新正向样本；未用它替代 2.1.83 边界验证 |

2.1.83 的三次原生探针均确认：两条输入 UUID 回显在首次 `result` 之前、首次 result 已采用 B、
只产生一次 result，然后收到 idle。没有切换 Hook／SDK，也没有取消原轮再替换。
完整 Core 的三次则额外验证真实 RUN_INPUT 和输入账本。

本轮最早完整通过值为 **2.1.83**。紧邻的已发布包 2.1.81 缺必要结束事件；官方 npm 清单中没有 2.1.82。
未把二分当作所有更高版本兼容的证明。包版本与摘要以
[官方 npm 元数据](https://registry.npmjs.org/@anthropic-ai/claude-code)及本报告证据为准。

### CodeBuddy：2.60.0 → 2.109.1，以及 2.132.0 异常

当前通道始终为 ACP 并发 `session/prompt`，未切到 Stream JSON 或新版专用接口。
按[官方 npm 实际发布版本](https://registry.npmjs.org/@tencent-ai/codebuddy-code)取样：
2.60.0 当前实际启动拒绝 `--plugin-dir`；随后版本包检查将参数出现边界缩至 **2.76.0 缺失／2.77.0 存在**。
该参数用于现有接线，不能删除来让旧版通过。

2.77.0 的真实请求先遇到 400；更换隔离测试模型后以及 2.81.0、2.92.0、2.100.2、2.106.2、
2.108.1、2.108.2、2.109.0 的后续尝试主要遇到 429（服务端可用账号限流），都未到工具边界。
2.109.0 在其他测试完成后再试仍为 429。**这些是环境受阻，不是不支持 Steer。**
不能把它们与正例做成一个兼容性二分结论；本轮只取得最早已测完整通过值。

**2.109.1 与 2.111.0 各自三个完整同轮场景和全部边界通过**。
2.132.0 初次三个场景中只有两个符合最终结果；第三个 Run 的两条输入都显示 accepted，
但最终文件为 A 而不是 B，最后回复也报告 A。它的停止与结束边界另组通过。
该异常证明“回执 accepted”不足以单独确认最后一条已正确生效；未把它删除或归为版本单调兼容。

### ZCode：必须同时记录 App 与内核

仅运行官方 App 内捆绑 App Server，不启动 GUI；保持当前 `requestedDelivery:"guide"`。

| App | 实际内核 | 内核 SHA-256 | 结果 |
| --- | --- | --- | --- |
| 3.12.2 | 0.16.5 | `da61b0663336a65f7cce3dec223678794ccaa58158e304fc0d97b695434a8f01` | 3/3 同轮＋全部边界通过 |
| 3.14.1 | 0.16.9 | `500ae84fa2cb8dd74c1264e5f3d3709c004c59b58899f1b0c3e205137a0ef466` | 初次 2/3；第三次在插话前原任务失败，新 fixture 单项复查通过；边界通过 |
| 3.11.2 | 未取得 | 未取得 | 官方 manifest 存在，其 ZIP 与 DMG 链接均 404；不能判成不支持 |

3.14.1 合计是 **3 次有效通过／4 次尝试**，不写成初次 3/3。
两个已下载包均按官方 manifest 校验摘要；App 与内核映射没有靠版本号推测。
当前最早完整正例为 **3.12.2／0.16.5**。更早版本受包可获得性限制；这不证明 3.12.2 是功能首发。
来源：[官方发布页](https://zcode.z.ai/cn/changelog?page=2)、
[3.12.2 manifest](https://cdn-zcode.z.ai/zcode/electron/releases/3.12.2/macos-arm64/latest.yml)、
[3.14.1 manifest](https://cdn-zcode.z.ai/zcode/electron/releases/3.14.1/macos-arm64/latest.yml)。

### TRAE CLI CN：0.207.1／0.208.1

从[官方安装脚本](https://trae.cn/trae-cli/install_v2.sh)指向的 CN 发布源确认历史 manifest，
下载其中实际列出的 macOS arm64 产物并校验 SHA-256。成功确认的公开稳定 manifest 为
0.207.1、0.208.1、0.209.1；不能把其他 URL 的 404 当作完整历史版本目录。
没有按数字算出一个假定存在的二分中点。

保持 CN ACP 和全局参数顺序：`--config disable_auto_upgrade=true --permission-mode default acp serve`，
沿用现有企业登录，实际选择模型 `glm-5.3/high`。0.207.1、0.208.1 各三次原生同轮更正生效，
接受回执为 `outcome:injected`，在原 `session/prompt` 结束前返回。另分别通过连续两条更正最终采用 B、
两种停止时点及普通续接无旧副作用、工具释放边界插话；无活跃轮返回 `-32600`，错误 Session 返回 `-32002`。

这两个版本均为**通道通过**；当前 Rovai 没有完成 TRAE Steer 产品投递适配，故完整链路明确为“未适配／未验证”。
协议只含 Session 目标，没有 Codex 式 `expectedTurnId`，产品适配仍需遵守现有活跃执行绑定。
本轮最早通道正例是 **0.207.1**，0.120.52 至 0.207.1 的完整历史边界仍未知。
来源：[0.207.1 manifest](https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/releases/0.207.1/manifest.json)、
[0.208.1 manifest](https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/releases/0.208.1/manifest.json)。

## 模型、环境与复现

| Runtime | 实际模型／提供方或已确认的选择 |
| --- | --- |
| Pi | `sub2api / gpt-6.1-sol`，Core 原生模型观察值确认 |
| Qwen | 旧鉴权配置 `openai / gpt-5.6-sol`，本机既有 sub2api Chat Completions 路由 |
| Codex | 原生有效测试 `sub2api / gpt-6.1-sol`、medium；ChatGPT 账号初次被模型服务拒绝 |
| Claude | `sub2api / gpt-6.1-sol`，Core 观察值与原生 init 一致；Node 22.0.0 |
| Grok Build | `gpt-6.1-sol`，本机既有自定义 Provider；Core 观察值确认 |
| CodeBuddy | `gpt-6.1-sol`，本机既有自定义 Provider；旧版受阻另试 `gpt-5.6-sol`，仍限流 |
| ZCode | `new-provider/gpt-6.1-sol`，本机既有自定义 Provider；Core 观察值确认 |
| Kiro | 官方原生登录，选择 `auto`；服务端最终子模型未披露，不猜测具体模型 |
| TRAE CN | 现有企业登录、`glm-5.3/high`；原生 session 模型选择确认 |

可复现工具：[probe-steer-version.mjs](../../../scripts/probe-steer-version.mjs)，使用方式见
[测试指南](../../development/testing.md#用户-steer-的-runtime-验收)。每次新建私有 fixture，
分别运行 `positive`、`boundaries`；预检失败保留为失败，不移除必要参数或强制越过能力准入。
本轮源码与证据校验记录在交付附件的验证记录中。凭据、原生日志、完整模型目录与日常配置不进入交付附件。

本轮只提供候选证据。若后续调整兼容门槛，应单独评估 Steer 能力；不能为了约束插话而禁止原本可用的普通任务，
也不能用调低数字代替 Codex／Kiro 的接线兼容处理。
