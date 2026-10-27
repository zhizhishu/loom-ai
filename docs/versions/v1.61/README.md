---
document_type: version-overview
version: v1.61
lifecycle: historical
authority: version-scope-and-status
design_status: confirmed
implementation_status: completed
model_context_change: true
last_updated: 2026-09-20
---

# Rovai-ai v1.61：Mission 全局发现、完成判断与默认接收提示

前置：[v1.60](../v1.60/README.md)。后续：[v1.62](../v1.62/README.md)。本版把 Mission 的 Agent read side 从“读取当前 Camp Mission”扩展为
“发现全部 Mission，并按内部 ID 读取任意 Mission”，同时保持修改只作用于当前公共 Mission；并让默认由
Default Lead 接收的公开消息在 Agent 自动上下文中显式呈现其冻结接收者，而不改写用户原文或路由。

## 目标

- 数据库关系、内部事件、Agent Mission 操作与模型上下文共用内部 `rvm_...` ID；`M-xxx` 只供 UI 展示。
- 增加轻量、数值倒序、基于游标的 `mission.list`；`mission.get` 接受可选内部 ID。
- `mission.get` 返回保存的结构化附件元数据和必填原路径，不访问文件系统或重算目录。
- 所有有效 AgentRun 都能读取全部 Mission；目标 Camp membership 不是 read ACL。
- `mission.update/status` 不增加目标选择器，跨 Mission 读取不切换当前目标或扩大写权限。
- 公共与 Single Chat Bootstrap 只补入口；CLI 精确 help 拥有单次调用教学，`cli-operations` 只补多步协调规则。
- 新生成的 Run Facts 与 Mission 引用继续直接使用 `rvm_...`，不增加 number，也不建立 ID 转换层。
- Mission 专属 Bootstrap 在定义缺失或过时时提示显式读取，并要求以完整 Mission 定义判断整体完成；
  已有有效定义时不机械读取，也不建立固定操作序列。
- 新 public batch 的 `RUN_INPUT` 与 `SHARED_CONVERSATION` 为 default-addressed 消息派生
  `@冻结接收者`；显式寻址、public-only、Single Chat、Camp Read/Search、Quote、FTS 与 Channel 不变。
- Formatter/Manifest 27 与 Profile 8 冻结 claim-time 接收者显示名和精确 payload；v26/Profile 7 继续 exact replay。

字段级协议见 [Mission v5](../../contracts/mission-v5.md)、
[Built-in Tool Transport v29](../../contracts/builtin-tool-transport-v29.md)与
[Single Chat v6](../../contracts/single-chat-v6.md)，默认接收投影见
[ContextManifest v27](../../contracts/context-manifest-evidence-v27.md)与
[Context Delivery Profile v8](../../contracts/context-delivery-profile-v8.md)。模型输入的完整前后对照见
[Mission 发现确认说明 revision 2](model-context-change-mission-discovery.md)、
[完成判断确认说明 revision 1](model-context-change-mission-completion.md)和
[默认队长接收提示 revision 1](model-context-change-default-lead-mention.md)，实施与验证见
[实施计划](implementation-plan.md)，高成本取舍见[版本决定](decisions.md)。

## 当前状态

模型上下文 revision 2 已由开发者确认。Core read side、catalog/CLI、Context 投影、Single Chat policy、
Migration 165/schema 115、Skill、Renderer 命令映射与当前权威文档已经同一版本实施。默认接收提示 revision 1
也已由开发者二次确认，并以 Formatter/Manifest 27、Profile 8 与 Migration 166/schema 116 完成实现。Rust 全量测试、
TypeScript/Vitest、文档治理、Skill、格式与编译检查均已完成，PR #437 的远端 gate 已通过。此处记录的是
仓库实现完成状态，不把未执行的安装包、第三方真实 Runtime 或真实渠道 Smoke 描述为发布资格。

后续完成判断增量已取得独立 revision 1 确认：只为 Mission 专属 Charter 增加按需读取完整定义与按完整
定义判断完成的提示，并把 Session Charter revision 轮换到 10；普通 Camp、Single Chat、动态 Context、
Manifest/Evidence schema、权限、状态、CLI 和调度不变。

数据契约随 Single Chat policy 约束从 v1.60/schema 114 迁移到 v1.61/schema 115。Migration 165 只重建
`agent_run` 的 policy-version 约束并保留既有行、索引、trigger 与外键；普通 Camp Run 仍固定 version 1，
历史 Single Chat version 1 保持可执行，新 Single Chat Run 使用 version 2。

Migration 166 只扩展 ContextManifest 的 v27/Profile 8 closed constraints，并在 `agent_run_input` 冻结
context version 与 nullable 的 claim-time 接收者显示名；既有输入回填 v26 marker，消息内容和 Delivery 不回写。

同日的执行卡读取链路收敛不改变 schema、RPC、分页或活动文本语义：Core 输入读取与有序
处理分离，`agentRunExecution.page/changes` 复用既有独立派发，Camp/执行窗口序列化移到数据库锁外；
Renderer 的消息发送、Camp 重命名与 Default Lead 变更后刷新统一进入既有 coordinator。

## 跨版本文档影响

| 范围 | 结论 | 证据或理由 |
| --- | --- | --- |
| Version lifecycle | 已更新 | v1.60 冻结为 historical；本概览、[实施计划](implementation-plan.md)与[版本索引](../README.md)建立唯一 current v1.61 |
| Decisions | 已更新 | [版本决定](decisions.md)记录统一内部 ID/global read seam、Single Chat policy 版本化与默认接收提示投影取舍 |
| Contracts | 已更新 | 发布 [Mission v5](../../contracts/mission-v5.md)、[Built-in Tool Transport v29](../../contracts/builtin-tool-transport-v29.md)、[Single Chat v6](../../contracts/single-chat-v6.md)、[ContextManifest v27](../../contracts/context-manifest-evidence-v27.md)与[Profile 8](../../contracts/context-delivery-profile-v8.md)；ContextManifest v27 继承 Mission-only Charter revision 10 |
| Architecture | 已更新 | Mission、Built-in Tool Runtime、Single Chat、Public Message Delivery 与基础不变量同步全局读、当前写、完整定义完成判断、默认接收投影和版本边界 |
| UI | 已更新 | 使命板继续显示 `M-xxx`；Built-in Activity 的精确命令映射新增 `rovai mission list`，无其他交互或视觉变化 |
| Runtime Activity | 确认无需更新 | 不改变 Canonical Runtime Activity 分类、证据来源或展示映射 |
| Runtime compatibility | 确认无需更新 | 不改变 Runtime Adapter 启动、模型、权限或平台资格；仅轮换 Rovai-owned Built-in capability |
| Documentation routing | 已更新 | 文档任务入口、合同索引、当前决定导航、三份确认说明和版本索引指向 v1.61 当前权威 |
| Root README | 确认无需更新 | Mission Agent 读取协议不改变项目定位、安装方式或公开 Runtime 支持范围 |
