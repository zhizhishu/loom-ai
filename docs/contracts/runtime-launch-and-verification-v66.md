---
document_type: contract
name: Runtime Launch and Verification
version: v66
status: accepted
source_version: v1.72
last_updated: 2026-10-20
---

# Runtime Launch and Verification v66

继承 [v65](runtime-launch-and-verification-v65.md)。本版仅补齐 Qwen 的原生问卷工具排除策略；
Claude Code、Copilot、Kimi 与 MiniMax 的既有行为不变。

## Qwen ACP 启动禁用

Qwen 的托管 ACP Host 统一传入 `--exclude-tools=ask_user_question`，不改变 ACP 接入或其他工具。
新建、原生 Session 恢复与 Host 重建共用该启动构造；不写用户原生配置，不清空工具集合，
普通权限继续按已有 `approval_mode` 与自动审批规则处理。

策略作为 `nativeQuestionnairePolicy=exclude-ask-user-question-v1` 纳入 Qwen Host compatibility digest。
旧进程在下一次安全获取时按现有 Fleet 机制替换；不改变 Native Session binding digest，
不打断已经接受输入的在途 Run，不清除原生会话或历史。

意外收到问卷时，继续按 v65 的请求归属、分类、取消回执与终态规则处理。
不新增问卷作答、自动继续或重放机制。

## 验证范围

工具已禁用必须以原生 ACP 实际提供给模型的工具集合为证据，分别验证新建、复用与重建后的恢复；
普通工具执行、公开发送和原生会话绑定必须保留。参数字符串断言或上游源码不能代替行为验收。
本机版本和验证结果见 [Qwen 启动禁用增量](../versions/v1.72/native-questionnaire-verification.md#qwen-启动禁用增量2026-10-20)。
