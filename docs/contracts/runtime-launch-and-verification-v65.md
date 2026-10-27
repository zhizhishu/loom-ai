---
document_type: contract
name: Runtime Launch and Verification
version: v65
status: accepted
source_version: v1.72
last_updated: 2026-10-20
---

# Runtime Launch and Verification v65

继承 [v64](runtime-launch-and-verification-v64.md)。本版只调整 Claude Code、Copilot、Kimi、
Qwen 的原生问卷边界；MiniMax 的既有取消及不支持终态保持，不写用户原生配置来禁用工具。

## 原生问卷与执行审批

原生问卷是用户输入，不是执行授权。自动审批、`yolo`、权限绕过和“记住允许”不得选择答案、
提交空答案或确认用户意图。需要澄清时，Agent 通过现有 Thread 公开发送与真实用户回复继续；
Core 不自动改写问卷为用户消息，不注入答案，不重放已接受的任务。

Claude 正式新建和恢复统一禁用 `AskUserQuestion`。原只读条件成立时，与
`Edit,Write,NotebookEdit` 合并到同一个 `--disallowedTools`；普通模式仍保留这些写入工具。
可靠绑定当前 Session/Run 的意外 `can_use_tool / AskUserQuestion` 在普通 Approval 转换前返回
原生 `deny`，不给出 `updatedInput` 或允许项。普通工具的精确输入及 remembered-rule 校验不变。

Copilot 托管 ACP Host 启动（包括该入口的隔离模式）传入 `--no-ask-user`；`--no-custom-instructions`、
`--available-tools=` 保持仅用于隔离探测。该策略进入 Copilot 的 Host compatibility digest，
复用、冷恢复、Core 重启均遵循现有 Fleet 获取与淘汰流程；不改变 Native Session binding digest，
不清除历史，不打断已接受输入的在途 Run。

Kimi/Qwen 在当前 Host、Session、Prompt、Run 与工具调用身份校验后，进入同一适配器感知分类：

| 分类 | 证据与行为 |
| --- | --- |
| 普通权限 | 保留原 Action/Approval 及自动审批流程；标题含 Question、多个 allow_once 本身不是问卷证据 |
| 原生问卷 | Kimi 的精确 `AskUserQuestion` 身份及 `q0_opt_*`、`q0_skip`；Qwen 的 `toolCall._meta.toolName=ask_user_question`、`qwenInteractionKind=user_question`、问题与 Submit/Cancel 结构 |
| 已识别但损坏的问卷 | 已有上述可靠工具身份或 Qwen 专用元数据，但问题、选项或元数据冲突；仍取消并记录不支持，不回落执行授权 |

Kimi/Qwen 均返回 ACP `{"outcome":{"outcome":"cancelled"}}`，不选择选项、不提交 `answers`。
取消回执按 Prompt/request ID 去重。过期归属不更新当前 Prompt；日志区分客户端能力不足与用户拒绝。
已有 `questionnaire:` 检测和 MiniMax 观察语义继续保留，其他适配器不新增问卷推断。

## 取消回执与终态

问卷取消不直接结束 Run。当前 Prompt/Claude 单轮观察记录未承接问卷；原生错误与真实取消仍优先。
正常完成但存在未承接问卷时，以 `runtime_questionnaire_unsupported` 失败，不得被非空 final
或本轮已有效公开发送掩盖。已有消息、文件和工具效果保留，下一条真实用户输入可按既有会话恢复机制继续。
成功输出和 Missing-Send 仍由 [Publication v3](missing-send-recovery-publication-v3.md) 拥有；
本版不产生成功候选，也不新增恢复消息。

## 验证与范围

参数断言不能替代模型实际工具集合、原生取消回执与生产分派的行为证据。版本、协议形状、
新建/恢复、普通权限、自动审批、损坏/迟到/重复请求及后继输入分别记录在
[本轮验证记录](../versions/v1.72/native-questionnaire-verification.md)。
未验证的原生版本与平台不从参数或其他适配器结果推导支持。
