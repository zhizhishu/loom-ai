---
document_type: research-report
authority: observed-runtime-evidence
status: completed
last_updated: 2026-10-14
---

# Steer 完整实测清单（2026-10-14）

> User seq28 已纠正清单范围。当前支持结论请读[按 Rovai 实际通道重测的清单](steer-current-transport-2026-10-14.md)。
> 下文保留 seq26 的跨通道历史记录；Kimi REST、Copilot SDK、OpenCode HTTP 不再作为当前 ACP 支持证据。
> Kiro 后续已补测其现有 ACP 的 `_session/steer` 并通过，不能继续按下表的普通 Prompt 负例判断其整个 ACP 能力。

**Rovai 当前分支已接入六种 Runtime；另有四种的原生 Steer 本次实测通过，尚未接入 Rovai。**
十五种纳入核验，Cursor、Cline、Command Code 按用户要求排除。不能把“当前 ACP 入口拒绝插话”
写成“这个智能体没有 Steer”：Kimi、Copilot、OpenCode 换用其原生接口后均取得了正向证据。

用户消息 `8715914b-298a-4e47-8004-da00e207950a` 要求补测其他 Runtime 并给出完整清单。
本轮基线 `040980b71642bb34075c3ec2621a8dc97908ca7f`，继续 `rovai/mission/064`；只补原生能力测试和报告，
没有把新发现的四种原生路径直接开放为产品能力。逐次尝试见[结构化证据](steer-complete-2026-10-14.evidence.json)。

## 完整清单

“已接入”指当前代码分支，不代表已安装或发布到日常 App。“未接入”时，Rovai 仍按原逻辑在忙碌时排队、空闲时开始执行。

| Runtime | 本机实测版本 | 原生实测结论 | Rovai 用户 Steer |
| --- | --- | --- | --- |
| Codex | 0.162.1 | `turn/steer` 同轮通过；错误目标及结束后明确拒绝 | **已接入，产品实测通过** |
| Claude Code | 2.1.287 | 同一 Stream JSON 执行追加用户消息；使用 sub2api | **已接入，产品实测通过** |
| Pi | 1.1.0 | 原生 `steer` 消费后采用更正 | **已接入，产品实测通过** |
| CodeBuddy | 2.133.1 | 补充 `session/prompt` 加入当前工作；单独关联补充回执 | **已接入，产品实测通过** |
| Qwen Code | 0.25.0 | `craft/drainMidTurnQueue` 拉取更正；并发 prompt 则会取消原轮 | **已接入，插话场景通过**；此前普通后继有一次超时，保留失败 |
| Grok Build | 1.0.50 | `_x.ai/interject` 接收更正并继续 | **已接入，产品实测通过** |
| Kimi Code | 2.1.1 | **原生 REST Steer 通过**；一次 `turn.started`，更正进入原轮；当前 ACP 忙碌拒绝 | 未接入该原生路径 |
| GitHub Copilot | 实际禁用更新入口 1.0.83；启动器 1.0.91 | **原生 SDK immediate 通过**，同一 interaction；ACP 会中止原工作后处理新消息 | 未接入该原生路径 |
| ZCode App | App 3.14.5；官方捆绑内核 0.16.9 | **原生 guide 通过**；同一 turn 的 steerQueued → steerDrained → 更正输出 | 未接入该原生路径 |
| OpenCode | 2.0.25 | **原生 HTTP `delivery=steer` 通过**；只有一次 execution；当前 ACP 忙碌拒绝 | 未接入该原生路径 |
| DeepSeek Harness | 0.2.1-alpha.1；ACP 自报 0.0.1 | 当前 ACP 拒绝执行中的第二条 prompt，原轮继续输出原标记 | 未接入；当前入口未验证出同轮插话 |
| Kiro | 2.21.1 | 当前 ACP 返回 `Prompt already in progress`，原轮继续 | 未接入；当前入口未验证出同轮插话 |
| TRAE CLI CN | 0.120.52 | 当前 ACP 返回 `another session is currently executing Prompt`，原轮继续 | 未接入；当前入口未验证出同轮插话 |
| Qoder | 1.1.65 | 先完成原消息，再处理补充消息，是普通排队 | 未接入；当前入口未验证出同轮插话 |
| Antigravity | 1.3.3 | 保持 Stream JSON stdin 开放追加消息，仍先后产生两个 result，是普通排队 | 未接入；当前入口未验证出同轮插话 |
| Cursor | — | 用户指定排除，未测 | 不在本次范围 |
| Cline | — | 用户指定排除，未测 | 不在本次范围 |
| Command Code | — | 用户指定排除，未测 | 不在本次范围 |

前六种复用同日已经完成的[Codex 产品验收](steer-2026-10-14.md)和[五种 Runtime 产品验收](steer-five-runtimes-2026-10-14.md)，
本轮没有重复跑这六种。此前覆盖文字、文本附件及纯附件、多次输入、多队员混合投递和取消，失败记录继续有效。
目前能力开关仍由 [steer.rs](../../../crates/rovai-core/src/steer.rs) 中的六项名单和
[Message Delivery v14](../../contracts/message-delivery-v14.md)拥有。

## 四条新增正向证据

所有正向探针先等待真实工具实际进入受控等待，再提交更正，随后释放工具。仅凭请求返回成功、
stdin 写入成功或最后包含更正文字都不算同轮通过；同时检查原生执行身份、消费事件、终态和是否发生中止。

| Runtime / Case | 消费及执行证据 | 实际结果与边界 |
| --- | --- | --- |
| Kimi / kimi-rest-02 | 补充 prompt 先入队，再通过 `prompts:steer` 选中；出现 `prompt.steered`，消息 origin 为 `inTurn:true`；只有一次 turn.started / turn.ended | 输出 `STEER_026_成功`，完成原因 completed；结束后再次 steer 返回 `40402 / no active prompt to steer into` |
| Copilot / copilot-sdk-03 | `session.send(mode=immediate)`；补充 user.message 的 delivery 为 steering，前后 interactionId 一致，无 abort，最后才 session.idle | 输出“已采用补充要求。”；原生 assistant.turn 从 0 到 1 是工具循环步骤，不能把每个 assistant.turn 当作新的用户执行 |
| ZCode / zcode-native-01 | `v4/command sendText requestedDelivery=guide`；steerQueued 和 steerDrained 的 targetTurnId 与原 turn 一致，仅一次 turn.started | 原 turn.completed 输出 `STEER_026_成功`；命令通用回执的 delivery 写成 queue，实际 guide 消费由后续关联事件证明 |
| OpenCode / opencode-http-01 | `POST /api/session/{id}/prompt`，delivery 为 steer；enqueued / delivered 对应同一 input ID；仅一次 session.execution.started / succeeded | 工具结束后输出 `STEER_026_成功`，消息记录只有最终 idle，原生 inbox 为空；没有先输出 ORIGINAL_026 |

Kimi 使用当前安装的 Node 版 2.1.1 原生 REST 服务，不套用旧 Python CLI 的 Wire 协议。
[官方 REST 文档](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/server-api.md)用于发现入口，
实际请求以安装服务生成的 OpenAPI 为准，模型显式使用原有 `sub2api/gpt-6.1-sol`。

Copilot 按[官方 SDK steering/queueing 说明](https://github.com/github/copilot-sdk/blob/main/docs/features/steering-and-queueing.md)
使用 immediate，真实后端为禁用自动更新后的 1.0.83，协议版本 3，原生模型回报 claude-opus-5。
session journal 的 copilotVersion 却是 0.0.0，故不拿该字段替代实际入口版本。
广播权限和工具调用按[官方 RPC 定义](https://raw.githubusercontent.com/github/copilot-sdk/main/nodejs/src/generated/rpc.ts)回复；
该源码帮助构造探针，不能据此宣称安装版与上游 main 完全等价。

ZCode 使用已安装 App 的官方捆绑脚本，不以 PATH 中的独立 CLI 代替 App 内核。
OpenCode 2.0.25 的实际 OpenAPI 明确列出 delivery 的 steer/queue 枚举，本轮直接按该版本接口执行，
不把旧版 `/prompt_async` 文档当成当前协议。两种原生入口及相关证据的 SHA-256 都在结构化记录中。

## 反例与失败全部保留

本轮九种 Runtime 共 **15 次尝试**：4 次原生同轮插话正向；7 次明确观察到受测入口拒绝、排队或中止替换；
另 4 次失败或证据不足。后者不计作“Runtime 不支持”，后续成功也不覆盖此前失败。

| Case | 观察与判定 |
| --- | --- |
| kimi-rest-01 | 创建会话未使默认模型生效，原生 `model.not_configured / Model not set`，未到工具边界；属于探针配置失败。02 在 prompt 显式传模型后通过 |
| copilot-sdk-01 | 模型已请求 hold，但探针只处理旧式回调，没有回复广播 permission.requested，卡在权限阶段；修正探针后复测 |
| copilot-sdk-02 | 同一 interaction 已消费 steering，但模型最终返回内容过滤结果；只能证明投递，不能算预期输出通过。03 使用自然中文要求后通过 |
| kiro-acp-01 | 首轮拒绝原测试写法，没有执行等待工具，未提交插话；02 允许先检查脚本后到达真实边界，第二条 prompt 被明确拒绝 |
| copilot-acp-01 | 最后虽有更正标记，但原生日志包含 `abort / user_initiated`，随后开始另一个 interaction；不能冒充同轮插话 |
| opencode-acp-01 | 并发 prompt 返回 -32603 / Session already has an active ACP prompt；只约束 ACP，HTTP 正向证据另列 |
| dsh-acp-01、kiro-acp-02、trae-acp-01 | 实际工具边界后分别返回 -32602、-32603、-32602，原请求继续完成并输出原标记 |
| qoder-acp-01 | 原请求先 end_turn 并输出 ORIGINAL_026，之后补充请求 end_turn 并输出更正；是后继消息 |
| antigravity-stream-01 | 运行中写入第二条 NDJSON，之后两个 SUCCESS result 分别输出原标记、更正标记，num_turns 为 1、2；是后继消息 |

## 范围、隔离与后续接入边界

测试平台为 macOS 26.6 arm64，只声明表中实测版本。本轮新增四种正向仅验证了一条文字更正，
尚未完成 Rovai 的附件、多次输入、多队员、取消、结束竞态、断线 unknown 和后继执行隔离验收。
Kiro、TRAE、DeepSeek Harness 的结论限定于当前 ACP，Qoder 和 Antigravity 的结论限定于本次持续输入方式；
未穷举它们的交互 UI 或未公开接口。

全部工作区使用逐次独立临时目录；支持原生路径重定向的 Runtime 使用私有配置副本。
TRAE 仍使用平台拥有的原生认证/Session 存储。Antigravity 虽设置了候选 app-data 环境变量，实测并未隔离其 CLI 存储，
实际复用了系统钥匙串，在 `.gemini/antigravity-cli` 新建了返回的测试会话；报告明确保留这个限制，
不声称这两种实现了完整原生配置隔离。未读取其他会话正文、覆盖用户配置、操作日常 Rovai 数据或安装、重启日常 App。
报告和导出只含白名单证据，不包含复制的认证信息、完整原生日志或配置。

所有探针进程已结束。ZCode owner 清理报告为 pendingGroups=0、signalFailed=true、confirmed=false，
因此其自动清理确认不能写成通过；功能性消费和输出证据单独成立。这也是正式接入前需要复核的一项。

新发现的 Kimi、Copilot、OpenCode 路径需要扩展或替换当前 ACP 运输；ZCode 可在现有官方内核运输上补 guide。
接入时仍需遵守现有 Run/epoch、取消 fence、逐来源回执和 unknown 不自动重发规则，不能只把能力开关改成 true。

本轮**没有上下文或提示词改动**：共同 Builder、Formatter、RUN_INPUT、R3 historyHint 和 37/14/10 版本均保持原样，
也没有新消息身份或存储结构。因此没有新增前后文案差异；此前[紧邻前后对比](../../versions/v1.72/model-context-change-steer-shared-input.md)
继续有效。完整 12 Case 上下文语义 Gate 的未测状态不变。本轮只修改研究证据及索引；文档测试 10/10、docs:check、带基线的 docs:check:ci 及证据断言通过，不重复宣称 Rust 或产品回归。
