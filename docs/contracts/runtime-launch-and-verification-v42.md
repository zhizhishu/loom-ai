---
document_type: contract
name: Runtime Launch and Verification
version: v42
status: accepted
source_version: v1.61
last_updated: 2026-09-19
---

# Runtime Launch and Verification v42

继承 [v41](runtime-launch-and-verification-v41.md) 的 Runtime 查找环境、身份、检查、目录、启动、恢复、
权限、证据与公开 failure 边界。本版只增加通用 ACP JSON-RPC Provider detail 白名单；不增加 Adapter
专用分支、公开 wire 字段或 Migration。

## ACP Provider detail 白名单

所有复用通用 ACP Host 的 Runtime 使用同一条错误规则。匹配 ACP request 的 JSON-RPC error 继续保留安全的
数字 `error.code` 与顶层 `error.message`。Host 还可以从精确路径 `error.data.error` 提取 Provider detail，
但仅在该值为 JSON string 时接受；对象、数组、数字、布尔值、null、其他 `error.data` 路径及完整原始对象
一律忽略。

白名单字符串在进入诊断、输入 disposition 或 `RuntimeFailureView` 前必须经过统一公开 Runtime 错误清洗：
删除 ANSI 与不允许的控制字符，排除 Prompt、用户正文和 Tool input/output 标签行，脱敏凭据与本机路径，
并应用既有行数和字符上限。清洗结果为空或与顶层 message 相同时不重复追加。存在独立 detail 时，诊断顺序为
数字 code、顶层 message、清洗后的 Provider detail；原始 `error.data` 不持久化，也不交给 Renderer。

该规则对 OpenCode、Copilot、Kiro、Qoder、CodeBuddy、Qwen、TRAE、Kimi、Grok、DeepSeek Harness 及其他
复用通用 ACP Host 的当前或后续 Adapter 一致生效。Adapter 不得自行增加未记录的 `error.data` 路径。

## 分类、重试与历史

统一高价值错误分类器把 `quota limit` 与既有 quota 表达一起归为 `runtime_quota_exceeded`。Provider 分类仍不能
覆盖 Core 的输入安全：已接受输入的失败禁止重放；未接受输入也只能按既有人工修复与重试入口处理。

已有 AgentRun 不回填 Provider detail。历史记录若只持久化了数字 code 与顶层 message，读取时保持原样；
不能从当前 Runtime、stderr 或相邻 Session 猜测当时的 `error.data`。

## 验证边界

最低回归由现有 owner 扩展完成：纯解析矩阵证明仅接受字符串 `error.data.error`，合成 ACP 进程证明 detail
穿过 matching Prompt completion 且不改变 accepted/not-accepted 判定，统一 Runtime failure 分类矩阵证明
`personal quota limit` 产生稳定 quota code。测试不启动真实 Runtime、日常 Core 或用户账号。
