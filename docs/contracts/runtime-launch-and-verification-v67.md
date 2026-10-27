---
document_type: contract
name: Runtime Launch and Verification
version: v67
status: accepted
source_version: v1.72
last_updated: 2026-10-20
---

# Runtime Launch and Verification v67

继承 [v66](runtime-launch-and-verification-v66.md)。本版仅补齐 ZCode 与 OpenCode V2 的原生
问卷工具禁用；其他适配器、普通审批、问卷兜底和 Run 终态保持原状。

## ZCode 会话工具限制

托管原生 `session/create` 与 `session/resume` 统一传入
`toolDenylist: ["AskUserQuestion"]`，包括不同权限模式与重建 Host 后的精确恢复。
`askUserQuestionAutoResolutionEnabled=false` 继续保留，但它不是禁用工具的证据。
只排除问卷，不排除 `ExitPlanMode` 或整条 `interaction/requestUserInput`。
不修改用户原生配置，也不把仅适用于其他运行模式的 CLI 参数用作 app-server 禁用手段。

## OpenCode V2 权限规则

在既有 V2 全局、build 和 plan 有序规则末尾加入
`{"action":"question","resource":"*","effect":"deny"}`，由原生工具过滤移除 `question`。
一般 allow/ask/deny、Shell 与 Skill 的允许例外，以及用户配置中的其他字段保持。
V1 配置不变；自定义 Agent、子 Agent 与受信任插件仍遵守原生规则，不宣称这些路径的工具集合已统一禁用。
原生无表单取消／文本降级保留，不新增问卷接管或自动继续机制。

## Host 与原会话

ZCode、OpenCode V2 的 Host compatibility 分别包含
`nativeQuestionnairePolicy=deny-ask-user-question-v1` 与 `deny-question-v1`。
策略不进入 Native Session binding digest；旧 Host 在下一次安全获取时沿 Fleet 流程替换，
新建、恢复和后继输入使用同一策略，已接受输入的在途 Run 不被强行打断，会话与历史不清除。

## 验证边界

以实际模型请求的工具集合证明禁用，另验证普通工具效果、公开发送、同会话后继输入与 Core 重启恢复。
确定性 owner 覆盖配置合并、权限模式、原生创建／恢复参数和 Host 摘要；真实原生版本、平台与
未验证范围记录在 [v1.72 验证记录](../versions/v1.72/native-questionnaire-verification.md#zcodeopencode-v2-禁用增量2026-10-20)。
