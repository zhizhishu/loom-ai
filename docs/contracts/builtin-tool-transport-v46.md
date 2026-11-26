---
document_type: protocol-contract
contract: builtin-tool-transport-v46
authority: builtin-tool-transport
status: accepted
version: 46
source_version: v1.72
last_updated: 2026-11-26
---

# Built-in Tool Transport v46

继承 [v45](builtin-tool-transport-v45.md) 的输入来源、IPC、授权、完整结果交付、幂等、Workspace RPC 与既有操作语义。本版增加一个受管学习写入操作；其余 Transport 规则不变。

Transport/CLI 为 **46**，capability 为 **builtin_cli.transport.v46**，Agent Output 为 **15**。IPC 保持 **3**，Envelope 保持 **2**。CLI、Core 与远端 Node 的 helper 准入必须配套；版本不匹配在执行业务前拒绝。

## 新操作与命令

| Canonical operation | CLI |
| --- | --- |
| loom.skill_suggest | rovai loom skill-suggest |

该操作在唯一 catalog、CLI identity、managed `rovai_loom` 操作表、Agent output projection 和 Built-in execution evidence projection 中共同注册。当前 canonical 操作共 45 个。

`loom.skill_suggest` 只接受 `name`、`description`、`instructions`、`rationale` 四个模型输入字段。`campId`、`agentId`、`agentRunId`、`commandId`、Mission 或其他身份字段一律由 authenticated Run/Core 注入，模型填写即拒绝。它把一个可复用流程写成私有、待复审（`stale`）的 Library Skill；事实保存在现有 Skill 与 learned metadata 列中，不新增迁移、Job 表或自动学习循环。相同 Skill 名称只能由同一 authoring assistant 更新，锁定或归属其他助手时拒绝。

成功输出是闭合 Agent-facing projection：新建/更新返回 `skillId`、`revisionId`、`updated`、`unchanged=false`、`state=stale`、`enabled`、`message`；相同内容重放返回 `skillId`、`unchanged=true`、当前 learned state（已复审可为 `active`）与 `message`，不把已复审技能降回待复审。不符合 schema 时沿既有 `output_contract_mismatch` 分支。

## 边界

`loom.skill_suggest` 不授权 bash、MCP、任意 CLI、文件写或自动 review 管线。`workspace_workflow` 的受管 `rovai_loom` 工具因此可到达十个 `loom.*` 操作；文件授权、claim gate 与 `loom.evidence` 路径策略仍由既有 grant/guard 拥有。该操作本身不改写 write grant，也不替代用户复审/分配。

旧操作的输入/输出、历史 Envelope、成功结果和摘要不重写。历史 v45 合同保持；v46 只改变当前命令集合和该新操作的字段/输出语义。
