---
document_type: research-report
authority: observed-runtime-evidence
status: completed
last_updated: 2026-10-14
---

# Steer 清单：按 Rovai 当前接入通道复测（2026-10-14）

**当前分支已接入并复测通过六种：Codex、Claude Code、Pi、CodeBuddy、Qwen Code、Grok Build。
另有 Kiro、ZCode 在现有接入通道上实测支持同轮插话，但 Rovai 尚未补接。**

按 User seq28（`bb7d8c40-1c3e-4980-b959-4777fd527f4b`）纠正上一份清单的范围：
只判断 Rovai 正在使用的通道和引擎，不再用 Kimi REST、Copilot SDK、OpenCode HTTP 的结果说明 ACP 可用。
十五种 Runtime 全部重新调用真实 LLM；Cursor、Cline、Command Code 按要求排除。
基线 `44ca038df8591f8207f48f821053db01620b6f1e`，分支 `rovai/mission/064`。
逐次回执、消费事件、版本、失败和摘要见[结构化证据](steer-current-transport-2026-10-14.evidence.json)。

## 完整清单

“已接入”指当前代码分支，不代表已发布或安装到日常 App。“通道支持、待接入”也不计入当前产品可用数量。

| Runtime | 本机实测版本 | Rovai 当前接入通道 | 本轮真实 LLM 结果 | 当前产品 Steer |
| --- | --- | --- | --- | --- |
| Codex | 0.162.1 | app-server JSON-RPC | `turn/steer` 同轮消费；仅一次 turn.started；错误目标拒绝 | **已接入、通过** |
| Claude Code | 2.1.287 | Stream JSON stdin | 追加 user 消息，首个 result 前 replay UUID 匹配，原执行采用更正；使用 sub2api | **已接入、通过** |
| Pi | 1.1.0 | `--mode rpc` | `steer` 消费后采用更正；仅一次 agent_start，未消费队列为空 | **已接入、通过** |
| CodeBuddy | 2.133.1 | `--acp` | 补充 `session/prompt` 加入原工作；补充回执与原 Prompt 终态分别关联 | **已接入、通过** |
| Qwen Code | 0.25.0 | `--acp` | `craft/drainMidTurnQueue` 拉取更正，原 Prompt 完成时采用更正 | **已接入、通过** |
| Grok Build | 1.0.50 | `agent --no-leader stdio`，ACP | `_x.ai/interject` 接收后，原 Prompt 继续并采用更正 | **已接入、通过** |
| Kiro | 2.21.1，默认 v2 引擎 | `kiro-cli acp` | **`_session/steer` 同轮通过**；有匹配 messageId 的 queued / injected 事件 | **通道支持，Rovai 待接入** |
| ZCode App | App 3.14.5；捆绑内核 0.16.9 | 官方捆绑 app-server；Rovai 内部桥接 | **`v4/command` 的 `guide` 同轮通过**；targetTurnId 一致 | **通道支持，Rovai 待接入** |
| Kimi Code | 2.1.1 | `kimi acp` | 并发 Prompt 被拒绝：`turn.agent_busy`；原工作继续 | 当前通道未验证支持 |
| GitHub Copilot | ACP 后端 1.0.83；启动器 1.0.91 | `--acp --stdio --no-auto-update` | 第二条 Prompt **中止原执行后另开执行**；不是同轮 Steer | 当前通道未验证支持 |
| OpenCode | 2.0.25 | `opencode acp` | 并发 Prompt 被拒绝：`Session already has an active ACP prompt` | 当前通道未验证支持 |
| DeepSeek Harness | 0.2.1-alpha.1；ACP 自报 0.0.1 | 官方 `dsh --profile acp` | 并发 Prompt 被拒绝：`a prompt is already in flight` | 当前通道未验证支持 |
| TRAE CLI CN | 0.120.52 | `traecli acp serve` | 并发 Prompt 被拒绝：`another session is currently executing Prompt` | 当前通道未验证支持 |
| Qoder | 1.1.65 | `qodercli --acp` | 先输出原结果并结束原 Prompt，再执行补充消息；**排到下一轮** | 当前通道未验证支持 |
| Antigravity | 1.3.5 | Stream JSON stdin | 保持 stdin 开放追加消息仍分别产生两个完整 result；**排到下一轮** | 当前通道未验证支持 |
| Cursor | — | — | 用户指定排除，未测 | 本轮不作判断 |
| Cline | — | — | 用户指定排除，未测 | 本轮不作判断 |
| Command Code | — | — | 用户指定排除，未测 | 本轮不作判断 |

这轮新增的可接入结论是 **Kiro 的现有 ACP 扩展**；ZCode 也不需要更换运输通道。
当前开关仍只有 [steer.rs](../../../crates/rovai-core/src/steer.rs) 中的六种，产品规则由
[Message Delivery v14](../../contracts/message-delivery-v14.md)拥有。本轮只补核验和清单，没有开放新 Runtime。

## 两个待接入项的直接证据

**Kiro：此前只测试并发 Prompt 会漏判。** 普通 `session/prompt` 在忙碌时确实拒绝，但这不等于 ACP 没有插话方法。
[官方 ACP 迁移文档](https://kiro.dev/docs/cli/v3/acp-migration/)说明 `_session/steer` 沿用已有方法名。
本机安装包的 v2 ACP dispatch 确实包含该方法；只带 sessionId 的无模型请求返回缺少 `message` 字段，确认实际 schema。
随后仍用当前默认 v2 ACP，传入 `{sessionId, message}`，没有切换 V3、安装新版或改用交互 CLI。

`kiro-acp-steer-02` 先到达真实工具等待边界，补充请求返回 `{queued:true}`；
`AgentExecutionUserMessageQueued` 和 `AgentExecutionSteeringInjected` 携带相同 messageId，
随后原始 Prompt 以 `end_turn` 完成并采用 `STEER_028_成功`。模型还自行输出了一段处理说明，
因此这里只判定同轮消费成立，不宣称严格只输出指定字串。Rovai 尚未处理这个扩展的投递、消费回执和清队列边界。

**ZCode：同一官方内核有 guide，当前桥接尚未使用。** Rovai 实际启动 App 捆绑的 `zcode.cjs app-server`，
不是第三方 ACP 包。探针使用同一官方入口和仓库的 owner 包装；`requestedDelivery=guide` 后出现
`turn.steerQueued → turn.steerDrained → turn.completed`，只有一次 turn.started，targetTurnId 始终为原 turn。
最终输出 `STEER_028_成功`。通用命令回执的 delivery 虽为 queue，实际消费由关联事件证明。
当前 [ZCode 桥接](../../../crates/rovai-core/src/zcode/transport.rs)只发送 `startNow`，并拒绝忙碌 Session 的第二个普通 Prompt。
本轮没有将内核探针包装成完整 Rovai 产品验收。

## 官方资料与实际入口的交叉核对

资料检索于 2026-10-14。上游 main 和在线文档可能比安装版新；支持结论以表中版本的真实行为为准。
没有发现某方法的文档或初始化广告，不能单独作为“不支持”的证明，Kiro 就是反例。

| 核验项 | 资料与本轮判断 |
| --- | --- |
| Kimi ACP | [官方 PR #2514](https://github.com/MoonshotAI/kimi-code/pull/2514)提出 `_session/steering`；GitHub API 确认它已关闭且未合并。安装版 ACP 实测忙碌拒绝，不能拿该提案或 SDK/REST 结果算支持 |
| Qwen ACP | [官方适配器源码](https://github.com/QwenLM/qwen-code/blob/main/packages/qwen-live/src/adaptor/acp-adaptor.ts)明确区分并发 Prompt 的抢占与 `craft/drainMidTurnQueue` 的中途消费；Rovai 和本轮正向探针使用后者 |
| DeepSeek Harness | [官方 ACP Session 实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/src/session.ts)及安装包都有单一 in-flight Prompt 检查。网上另一个有 steering 扩展的第三方 ACP 包不是 Rovai 接入的 `@deepseek-ai/dsh-acp`，不纳入支持证据 |
| Copilot ACP | 按 [官方 ACP server 文档](https://docs.github.com/en/copilot/reference/copilot-cli-reference/acp-server)核对当前入口；SDK immediate 和交互 CLI 的 Steer 不进入此清单。实测用原生日志识别中止与新 interaction |
| OpenCode ACP | [官方 ACP 文档](https://docs.opencode.ai/docs/acp/)对应现有命令。安装版 ACP handler 在已有活跃 Prompt 时直接拒绝；HTTP delivery 参数不属于本轮通道 |
| Qoder ACP | [官方 ACP 文档](https://docs.qoder.com/cli/acp)对应 `--acp`。安装版 `promptRunning` 分支只加入 pendingMessages，`finally` 才取下一条；实际先后两个 end_turn 与此一致。IDE 的 Steer 按钮不是 ACP 支持证明 |
| CodeBuddy ACP | [官方 ACP 文档](https://www.codebuddy.ai/docs/cli/acp)确认入口；本轮读取了搜索索引中的官方正文，直接页面抓取失败，因此同轮语义由本机真实协议记录证明 |
| Grok ACP | [官方文档](https://docs.x.ai/build/overview)区分 ACP、交互和 headless 使用方式；具体 `_x.ai/interject` 的消费行为由本机 1.0.50 实测证明 |
| TRAE ACP | [官方 ACP 文档](https://docs.trae.cn/cli_agent-client-protocol)确认 `acp serve`。结论只适用于本机 CN 0.120.52，不外推为所有后续版本 |
| Claude Code | [官方 CLI 参数](https://code.claude.com/docs/en/cli-reference)对应 Stream JSON；本轮沿用 sub2api 配置，实际模型为 gpt-6.1-sol。没有测试第三方 Claude ACP 包 |
| Pi | [官方 RPC 命令](https://raw.githubusercontent.com/badlogic/pi-mono/main/packages/coding-agent/docs/rpc-commands.md)区分 steer 与 follow_up；本轮使用原生 RPC steer |
| Antigravity | [官方 headless 文档](https://www.antigravity.google/docs/cli/headless/)说明 stdin 每条 Prompt 执行完整一轮并各自发 result；两次真实探针与此一致 |

ZCode 以安装的官方 App 内核与版本化事件为依据。Codex 使用现有 app-server 的 `turn/steer`，
并检查 expectedTurnId 与返回的原 turnId；没有借用另一种 Codex ACP adapter 的能力。

## 测试方法、反例与保留失败

每次真实测试使用独立空工作区和新的会话。模型读取并运行受控 `hold.py`；脚本实际写出 ready，
且原请求仍活跃时才发送更正，然后由探针创建 release。检查真实消费和原执行的终态，不靠“写 stdin 成功”或最后包含更正文案判断。
本轮十五种 Runtime 共 **21 次真实 LLM 尝试**：8 次同轮正向、5 次忙碌拒绝、3 次后继排队、
1 次取消替换、4 次未到达测试边界。另有一次 Kiro schema 发现请求，不调用模型，不计入 21 次。
同一 Runtime 的正反例分别保留，不能按尝试数计算支持 Runtime 的数量。

| Case | 观察或失败原因 |
| --- | --- |
| codebuddy-acp-01、grok-acp-01 | 测试器把 ACP 的完整命令字符串当作单个可执行文件名，终端启动失败，未提交插话。修正 shell 参数解析后，02 均通过；这是探针失败，不是 Runtime 不支持 |
| copilot-acp-01、copilot-acp-02 | 模型先尝试列目录／清理标记，超出探针最初的权限白名单，原请求提前结束。03 明确标记由外部测试器管理后到达真实等待边界；两次失败保留 |
| copilot-acp-03 | ACP 回执都写 end_turn，最终也有更正，但原生日志包含 `abort: user_initiated`；两条 user.message 的 interactionId 不同、delivery 均为 idle。判定取消替换，不能算同轮成功 |
| kiro-acp-01 | 普通并发 Prompt 被拒绝；后续针对同通道 `_session/steer` 的正向结果修正了对 Kiro 的总体结论 |
| kimi-acp-01、opencode-acp-01、dsh-acp-01、trae-acp-01 | 工具边界后明确拒绝补充 Prompt，原 Prompt 继续结束；没有换用其他传输重试 |
| qoder-acp-01 | 原结果 ORIGINAL_028 与原 Prompt 的 end_turn 在先，更正及第二个 end_turn 在后，判定排队 |
| antigravity-current-01、antigravity-current-02 | 两个 SUCCESS result 分别输出原结果、更正，num_turns 为 1、2。01 的复用脚本误写版本 1.3.3，原生服务日志证明实际为 1.3.5；02 改为启动前读取版本，并冻结执行文件前后摘要后复测 |

Grok 的 `{status:queued}` 和 Kiro 的 `{queued:true}` 都只是接收回执，不能据字面判作下一轮；
它们后续确实在原执行中消费。相反，Copilot 的 `end_turn` 也掩盖了内部中止，须看关联执行证据。

## 产品边界与隔离

本轮是沿现有通道的文字探针，不是重跑整个 Rovai Core、UI 或附件验收。
六种已接入 Runtime 的既有[产品验收](steer-five-runtimes-2026-10-14.md)及其引用的 Codex 验收继续有效；
此前 Qwen 普通后继执行的一次超时、完整上下文语义 Gate 未运行等缺项没有改成通过。
Kiro、ZCode 尚需在正式适配器中处理来源回执、目标执行、结束竞态、取消、unknown 不重发、附件和多队员投递。

测试使用现有账号和模型配置，不是统一模型的质量对比。支持路径重定向的 Runtime 使用私有配置副本；
TRAE、Antigravity 使用其平台拥有的原生认证／会话存储，仅创建本轮返回的新会话，不声称完整隔离原生存储。
Antigravity 当前产品会在首条输入后关闭 stdin；本轮仅在相同 Stream JSON 通道上保持打开以检查是否能插话。
没有启动或重启日常 Rovai App、改写用户配置、安装 Runtime、修改模型上下文或生产代码。

ZCode 的 owner 清理报告仍为 `pendingGroups=0, signalFailed=true, confirmed=false`，不能写成清理验收通过。
探针功能证据与此分开记录。结束时另外检查本轮工作区对应的可见进程；结果写入结构化证据。
公开文件只导出白名单字段和摘要，不包含认证副本、完整原生日志或环境变量。

本轮只修改研究报告和文档索引，检查入口为 `pnpm docs:test`、`pnpm docs:check`、
`DOCS_BASE_REF=44ca038df8591f8207f48f821053db01620b6f1e pnpm docs:check:ci`，以及证据断言和探针语法检查。
结果：文档测试 10/10、两项文档治理、21 次尝试的证据断言和探针语法检查均通过；生产源码摘要与基线一致。
上下文 Builder、Formatter、RUN_INPUT 和提示词均无改动，故本轮没有新的前后文案差异。
