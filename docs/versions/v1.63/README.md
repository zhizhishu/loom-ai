---
document_type: version-overview
version: v1.63
lifecycle: historical
authority: version-scope-and-status
design_status: confirmed
implementation_status: completed
model_context_change: true
last_updated: 2026-09-22
---

# Rovai-ai v1.63：Task 单一正文与读取投影收敛

前置：[v1.62](../v1.62/README.md)。后续：[v1.64](../v1.64/README.md)。本版把 Task scope 与 requirements 收敛到单一
`description`，让历史结构化要求继续可读但不再扩散到当前输入、输出、UI 和 Agent 教学；同时以新合同身份
发布 Task CLI family index 和更小的 `task get` Agent projection。

## 目标与范围

- Durable Task v4 删除当前 `acceptanceCriteria` / `clearAcceptanceCriteria` surface，`description`
  上限统一为 16000。
- Migration 167 将 data contract 切到 v1.63 / projection schema 117，保留旧数据库列与历史正文；新建固定
  写空数组，读取确定性合成，实际编辑正文时与旧列原子收敛。
- `team.get_task` stdout 固定为七个基础字段，并至多携带一个与当前状态匹配的说明；Core canonical result、
  receipt 与授权仍由各自边界拥有。
- CLI 增加只列四项 operation 的 `rovai task --help`；精确参数继续读取子命令 help。
- Tool catalog、Desktop/Web 输入、Renderer、Qualification 当前投影和 bundled `cli-operations` Skill 使用同一
  单正文语义。
- Built-in Transport/CLI/capability 原子轮换到 v31，Agent Output wire 轮换到 4，Session Charter 轮换到
  revision 12；Bootstrap、Formatter、ContextManifest、Profile、IPC、Envelope 与 receipt 不变。
- Host Web v3 将 HTTP 登录与 Session `protocolVersion` 轮换到 3，明确拒绝带旧 Task 字段的当前请求和
  reconciliation payload，不保留只读 legacy decoder，且不把拒绝解释为旧命令未提交。

字段级规范见 [Durable Task v4](../../contracts/durable-task-v4.md)、
[Built-in Tool Transport v31](../../contracts/builtin-tool-transport-v31.md)和
[Host Web v3](../../contracts/host-web-v3.md)。实施与验证见[实施计划](implementation-plan.md)，取舍见
[版本决定](decisions.md)，模型输入的完整前后文本与确认记录见
[模型上下文变更](model-context-change.md)。

## 实施状态

Core、数据库迁移、read model、Tool/CLI、Agent output、Desktop UI、Host reconciliation、测量投影、Skill 与
当前权威文档已同步完成。旧 Task 数据不做批量改写；当前读取每次从原始两列合成，只有用户实际提交不同正文
时才在同一 CAS 更新中清空旧列。当前输入收到旧字段时 fail closed。

自动化验收覆盖合成与编辑转换、16000 边界、旧字段拒绝、状态专属 get projection、family help、Migration
167、Renderer/type contract、Skill 与文档治理。最终 PR 与远端 required checks 作为合入 `main` 的发布门槛。

## 跨版本文档影响

| 范围 | 结论 | 证据或理由 |
| --- | --- | --- |
| Version lifecycle | 已更新 | v1.62 冻结为 historical；本概览、[实施计划](implementation-plan.md)和[版本索引](../README.md)建立唯一 current v1.63 |
| Decisions | 已更新 | [版本决定](decisions.md)记录单一正文与历史只读合成、版本化 clean break 及旧 reconciliation payload 明确拒绝 |
| Contracts | 已更新 | 发布 [Durable Task v4](../../contracts/durable-task-v4.md)、[Built-in Tool Transport v31](../../contracts/builtin-tool-transport-v31.md)和 [Host Web v3](../../contracts/host-web-v3.md)，Agent Output wire 为 4，Session Charter 为 revision 12 |
| Architecture | 已更新 | [基础不变量](../../architecture/foundational-invariants.md)和 [Built-in Tool Runtime](../../architecture/builtin-tool-runtime.md)同步单正文、精简 get、Task family help 与版本边界；统一 Host 指向 Host Web v3 |
| UI | 已更新 | [Camp 会话工作区](../../ui/components/conversation-workspace.md)删除验收条件数量、列表和第二输入，只保留“责任范围与要求”正文与状态说明 |
| Runtime Activity | 确认无需更新 | 不改变 Canonical Runtime Activity 分类、证据来源或展示映射；只收敛 Task operation 的当前字段投影 |
| Runtime compatibility | 确认无需更新 | 不改变 Runtime Adapter、模型、权限或平台资格；Rovai-owned capability 与 Native Binding 按合同轮换 |
| Documentation routing | 已更新 | 文档任务入口、合同索引、当前决定、架构入口和版本索引均指向 v1.63 当前权威 |
| Root README | 确认无需更新 | Task 字段与帮助路由收敛不改变项目定位、安装方式或公开 Runtime 支持范围 |
