---
document_type: model-context-change
version: v1.72
change_id: input-snapshot-simplification
revision: 1
confirmation_status: confirmed
confirmed_revision: 1
confirmed_by: User
confirmed_at: 2026-10-12
authority: confirmed-model-input-change-statement
implementation_baseline: 07ca89ec5f9dea8c27bf15602bc076c7cf200f73
implementation_status: implemented
last_updated: 2026-10-12
---

# 输入快照与内部摘要精简

## 二次确认

User 在当前 Codex 会话阅读第 2、3、4 项的影响说明后明确回复“确认，那你执行完PR吧”，
随后要求“12345一起做”。本文件在上下文实现修改前记录该直接授权及字段级实施细化；
不声称 User 曾阅读本文件，不把本记录解释成另一轮授权。实施范围保持已经确认的模型输入、
历史查看、补发、原生恢复和命令结果查询功能，不增加指纹、风险分类、重试或结果对账系统。

## 变更前

ContextManifest 保存最终 Dynamic Context Blob，同时重复保存 Profile JSON、Run Facts 正文、
Self Active Task 与 A2A 生成证据、Additional Skills section，以及下列独立校验摘要：

```text
context_delivery_profile_digest
shared_message_evidence_digest
run_fact_digest
attachment_digest
skill_exposure_digest
current_input_skill_resolution_digest
mcp_exposure_digest / mcp_projection_digest
self_active_task_evidence_digest
a2a_guidance_evidence_digest
rendered_payload_digest
```

读取冻结输入时逐项重算这些摘要、验证生成版本组合和中间材料，再读取已经保存的最终输入。
工具结果 Envelope 1 带必填 receipt；Catalog 带 catalogDigest，参与进程兼容摘要。
Domain Command 结果通过 request_digest/version 比较原请求。

## 变更后

模型可见 section、JSON、文本、顺序、消息选择、预算、附件、Skills 和工具业务输出保持原样。
ContextManifest 以最终 Dynamic Context Blob 与实际 Bootstrap 材料为输入来源；保留 Run/Binding
归属、来源 ID、历史边界、附件定位、实际 Skill/MCP 恢复材料和发送条件。
生成过程的上述独立摘要与重复 Profile/Run Facts/Task/A2A/Additional Skills 正文不再写入新快照，
读取最终输入不再依赖这些额外证明。旧行、Blob 引用和原字节保留；旧证据列仅供历史读取。

```text
Run + source IDs + necessary selection/attachment metadata
    -> stored final Dynamic Context bytes
    + separately delivered Bootstrap bytes
    -> existing Runtime delivery
```

通用 Blob 的内容地址继续用于文件定位和复用，直接复用该层已经计算的摘要，不在 Context 层再算一份。
章程、协作信息、工作目录的变化比较继续决定是否补发；它们不参与原生 Session 恢复资格。
同一 Run 已准备的输入保持冻结；accepted/unknown 输入不因本次简化自动重放。

工具协议使用现有版本轴升级到 Transport/CLI 38、IPC 3、Envelope 2。Envelope 的完整形状为：

```json
{"contractVersion":2,"ok":true,"operation":"thread.message.send","requestId":"<uuid>","result":{}}
```

失败时用 error 替代 result；error 的 code/message/recovery/details 与原协议一致。
Catalog 保留 contractVersion/operations 或单工具描述，不包含 catalogDigest；目录在进程内复用。
正式 CLI 的 operation-specific stdout 不变。旧 IPC 版本在执行业务前拒绝，避免返回格式错配后重复执行。

命令结果保留 commandId、commandType、status、code、payload、resultEntity、recordedAt，
不再输出或生成 requestDigest/requestDigestVersion。同一 ID 在原类型、发起方和 Camp/来源 Run
归属内返回首次结果；内容改变不再报摘要冲突，新操作使用新 ID。Web 原结果查询和手工重试保持。

## 明确不变

- Native Session 继续按当前 Conversation、队员和 CLI 类型尝试恢复，不读取旧快照证明历史有效。
- 保留请求关联、JSON/字段结构、授权和去重；目录/结果摘要不替代这些功能。
- 保留消息、项目文件、数据库历史结果和用户可见输入正文。
- 正常数据库打开使用当前版本、迁移完成状态和必要表结构；历史迁移来源识别仍在升级路径。
- Usage 派生结构失败由统计模块报告，不阻断业务事务或整个数据库。

## 版本、迁移与兼容

Formatter/Profile 与 RunInput 的模型格式版本不变；存储精简通过同一次数据库迁移放宽退役证据列，
保留已存在值和所有引用，不重建旧输入、不添加新的冻结格式版本轴。
当前 ContextManifest、Built-in Transport、Domain Command Result 与数据库准入规范同步更新。
新存储不写入虚假空摘要，旧客户端不能误认为新结果仍经过 receipt 验证。

## 验证

复用现有 Context owner 验证新旧输入原字节恢复、消息选择和补发条件；扩展既有数据库 owner 验证
历史行保留、重开、缺失核心结构拒绝、等价 SQL 表达可打开及 Usage 损坏不影响业务。
工具 owner 验证无摘要结果、真实字段错误、目录帮助复用及 IPC 版本拒绝。
命令 owner 验证成功/受理/拒绝均可查询、同 ID 只执行一次、跨归属不能取得原结果。
运行定向测试、默认 Rust PR 回归、Node/TypeScript 与文档门禁；模型可见正文未改变，不调用真实模型。

## 工作记录

- Worktree：`context-tool-simplification/rovai-ai`
- Branch：`codex/context-tool-simplification`
- Base：`07ca89ec5f9dea8c27bf15602bc076c7cf200f73`
- 同步主线：`d41778bfcc71d0223e70cbbdd442c3e500eb3559`。
- Governance：本次 PR 一并更新；无单独主线文档先行要求。
- Status：ready，等待 PR 评审。
- Validation：默认 Rust 460 项通过、1 项既有人工测试忽略；Vitest 2645 项、Node 339 项通过，
  另有 2 项平台跳过；typecheck、Desktop/Web 构建、真实 CLI 文件输入 IPC 与通用文档门禁通过。
  Context、迁移、命令归属和恢复定向回归通过。完整慢测首轮 1329 通过、25 失败、8 忽略；其中
  22 项已修正或独立复跑通过，剩余 3 项 CampOpen 的 event_log 读取拒绝在未修改的上述 main
  同样复现。没有禁用测试，也不宣称完整慢测通过；详见[实施记录](implementation-plan.md#内部实现减重2026-10-12)。
