---
document_type: research-report
authority: observed-runtime-evidence
status: completed
last_updated: 2026-10-14
---

# Claude Code、Pi、CodeBuddy、Qwen Code、Grok Build 的 Steer 扩展

User 在消息 `cdabb3b0-53c6-4f19-be8c-8fd6dfb4e19b` 要求接入这五种 Runtime，并授权真实模型测试；
Claude 使用现有 sub2api 配置。实施基线为 `82352292da8a47df71e08f0d2c264d70ea1b2b32`，
继续使用 `rovai/mission/064`。加上此前 Codex，产品共开放六种 Runtime 的用户插话。
Agent 消息、其他 Runtime 的普通队列和原 UI 交互规则保持不变。

## 实现与实测口径

本轮直接启动真实 Rovai Core，公开用户消息经正常发送 RPC、Delivery、动态上下文和各 Runtime 到达模型，
并读取工作区实际文件、逐输入回执和 Run 终态。不是仅调用原生协议的可行性探针。
macOS 26.6 / arm64；每次尝试使用新的绝对临时根目录、独立 Core data、Skill Library、MCP、cache、
工作区及目标 Runtime 的私有配置副本。原生密钥不进入报告或证据包。未安装、重启日常 App。

| Runtime | 版本 | 实际运输与接收证据 | 产品实测 |
| --- | --- | --- | --- |
| Claude Code | 2.1.287 | Stream JSON user；匹配原生 replay UUID，result 可补证；不把 stdin flush 当接受 | 文字、纯附件、多次输入、多队员混合投递和取消通过；使用 sub2api，原生配置模型 gpt-6.1-sol |
| Pi | 1.1.0 | 原生 steer；匹配 user message_start 才确认消费，精确 clear_queue 结果证明未消费 | 文字、纯附件、多次输入、多队员混合投递和取消通过 |
| CodeBuddy | 2.133.1 | 补充 session/prompt 独立关联；提前 end_turn 不结束原 Run | 文字、纯附件、多次输入、多队员混合投递和取消通过 |
| Qwen Code | 0.25.0 | craft/drainMidTurnQueue 回调拉取当前输入，不发送并发 session/prompt | 分开验收同轮文字与纯附件、多队员混合投递、取消，全部通过；一次普通后继长场景超时，保留失败 |
| Grok Build | 1.0.50 | _x.ai/interject；原生扩展结果有额外 result 层，以相关 queued 回执确认 | 文字、纯附件、多次输入、多队员混合投递和取消通过 |

普通与多队员场景要求：活跃目标同一个 Run 中先接文字，再接纯附件，各输入 Manifest 只含自身消息；
普通 waiting 消息单独执行；同一多队员消息对活跃支持者插话、忙碌 OpenCode 排队、空闲支持者直接执行。
取消场景在真实工具等待期间提交插话再取消，验证指定副作用文件不存在、没有后继 Run、来源不回 waiting。

最终成功证据：Claude 01、Pi 01、CodeBuddy 03、Grok 02 各完整执行六个 Run；Qwen 04 的同轮输入
一个 Run 成功，Qwen 05 的混合场景四个 Run 成功。五种 Runtime 各有独立的 cancel 01，均只有
一个取消 Run，没有副作用或后继。附件实测使用文本文件，未把此结果扩大为图片或音视频的模型理解验证。
当前支持的是代码分支能力，尚未安装或发布到日常 App。

## 回执与结束边界

[Message Delivery v14](../../contracts/message-delivery-v14.md)拥有当前合同。CodeBuddy、Qwen 和 Grok
在当前 Prompt 出现实际模型或工具活动时确认初始输入，才能在执行中接受 Steer；目录 metadata 不计入。
Qwen 的未拉取输入留在当前 Host 的内存运输队列，正文和持久恢复仍归现有 CampMessage/Manifest。

CodeBuddy 和 Grok 没有原生 expectedTurnId，不能声称和 Codex 的原子目标校验相同。
Rovai 检查 Run/epoch、Session/Prompt、取消 fence，并回收发生过插话的 Host；迟到输入不会进入可复用的
后继 Host。Pi 使用过 steer 的 Host 同样回收，避免残留原生队列跨执行；Native Session 仍按原逻辑精确恢复。
未知响应、传输中断和超时不自动重发，不凭错误文本判断未接收。非 Codex Runtime 暂无只读补证入口。

## 上下文前后对照

本次扩展不修改任何模型可见文案或上下文版本。以下每项的变更前后紧邻记录。

- Builder/Formatter：**前**为共同 DynamicInputContext Builder/Formatter；**后**相同，没有适配器专用上下文构建。
- RUN_INPUT：**前**仅含本次投递来源；**后**相同，多次插话与普通队列的来源分别验证。
- historyHint：**前**为已确认 R3 的四种单句；**后**逐字保持，不增加 Steer 指导或标签。
- 事实和执行环境：**前**刷新动态事实，冻结执行身份、配置、Bootstrap；**后**相同。
- 存储/版本：**前**复用 CampMessage/Delivery/Manifest，public 37/14/10；**后**相同，无 Migration 或新消息身份。

此前 R3 的完整对照仍见[原报告](../../versions/v1.72/model-context-change-steer-shared-input.md)。
此前未运行的 12 Case 语义 Gate 不在本轮被宣称通过，本轮不声称提升模型质量。

## 失败记录与限制

- Qwen 01：初始输入仍等原 Prompt 结束才 ACK，运行中无法进入 Steer；修复为只认当前 Prompt 的实际活动。
- Grok 01：原生扩展响应的双层 result 解析错误，收到输入但保留 unknown；修正解析后重测通过，未重发该未知输入。
- Qwen 02：两个插话文件已生成，等待 Run 终态超时。Qwen 03 的插话 Run 成功，普通后继已接受但 600 秒内未结束，原生记录另观察到模型读取错误拼写的路径；根因未确定，不把这些尝试写成全场景通过。04/05 分开复测插话与混合路由通过，不覆盖普通后继的这次失败。
- CodeBuddy 01：首场景通过，混合场景的原生日志出现模型响应超时及自动重试。
- CodeBuddy 02：测试在原 Run 完成、普通队列尚未创建后继 Run 的间隙提前判定结束；补充后继 Run 数量条件，03 重测通过。

后续成功不覆盖前述失败。原生登录、模型和网络服务沿用用户实际环境，本轮不声明其他平台或最低版本兼容。
共 17 次真实产品尝试：11 通过、6 失败；成功覆盖上述功能，失败全部留档。每次报告的冻结 Core
SHA-256、原始 JSON 和结果分类见[验收索引](../../versions/v1.72/steer-five-runtimes-verification.json)。
较早成功尝试使用当时冻结的候选二进制；后续生产修正只涉及 ACP 的初始 ACK、Grok 扩展响应、
有界写入和 Qwen callback ID，未改写 Claude/Pi 成功后的生产路径。Qwen 04/05 使用最终二进制。

本轮自动回归：默认 Rust workspace 471 通过、1 既有 ignored；ACP 68 通过/2 ignored、Pi 24 通过/1 ignored、
Claude 45 通过/1 ignored；最终 active_input 3 项及原 Codex Steer Host owner 1 项通过，定向组之间有重叠。
`cargo check`、`cargo fmt --all --check`、脚本语法、文档 10 项及带基线治理通过；未重跑完整 extended 集。
