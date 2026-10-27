---
document_type: contract
contract: durable-task-v4
status: accepted
target_version: v1.63
last_updated: 2026-09-21
---

# Durable Task v4

本合同继承 [v3](durable-task-v3.md) 的 authority、状态机、Camp-wide read、显式 owner、容量、CAS、
terminal 不可变与 Task-linked Run 准入，只收敛 Task 责任正文、当前输入和读取投影。v3 自 v1.63 起为
historical，不是当前 Runtime、CLI、Host 或恢复兼容入口。

## 单一责任正文

当前 Task 只有一个对外责任正文 `description`，其含义为 Task scope and requirements，长度为
0–16000 个字符。`acceptanceCriteria` 与 `clearAcceptanceCriteria` 不再是当前 create/update 输入、
Task 对象、Renderer、CLI、Tool schema、Agent stdout 或测量投影的一部分；闭合输入收到旧字段时明确拒绝。

SQLite 保留 `acceptance_criteria_json` 作为历史数据容器，新建 Task 固定写入空数组。读取历史 Task 时，
Core 每次只从原始 `description` 与历史数组合成公开正文，不回写数据库、不增加版本，也不对已经合成的
正文再次拼接。合成规则为：忽略纯空白历史项并保留其余顺序；只有历史项时输出
`补充要求：\n- …`；两部分都有时用一个空行连接；没有有效历史项时原样返回正文。

## Create 与 update

`team.create_task` 只接受 `title`、`description` 和显式当前 CampMember `assigneeAgentId`，Camp 继续由
当前 AgentRun 绑定；Host `tasks.create` 继续显式携带同一 Camp 的 `campId`。User 或当前 Default Lead 的
既有创建 authority、初态 `pending`、不发送消息且不启动工作的边界不变。

`team.update_task` 继续要求调用者刚读取的 `expectedVersion`。User/Lead 可修改非终态 Task 的 title、
description、assignment 和状态；普通当前 Assignee 仍只能修改自己的执行状态与匹配的
`blockedReason` 或 `completionSummary`。冲突必须重读后重新决定，不自动代填最新版本，也不得通过新建
Task 绕过。

历史 Task 的正文更新在同一个 version-CAS 事务中遵守：

- 未提交 `description` 时，原始正文与历史数组都不变；
- 提交值与当前合成正文相同时，不转换存储，也不因正文产生版本变化；
- 提交不同正文时，把该完整值写入 `description` 并原子清空历史数组；
- 显式空正文同时清空两部分；title、状态、负责人和状态说明的独立更新不触碰历史数组。

## Read 与 Agent output

当前 UI/read model 的 Task 对象包含合成后的 `description`，不包含历史数组。`team.list_tasks` 继续返回
紧凑摘要；需要正文和当前 version 时使用 `team.get_task`。

Core canonical get result 可保留授权、审计和生命周期所需的当前 Task 字段，但 Agent stdout 固定为七个
基础字段：`taskId`、`title`、`description`、`status`、`assigneeAgentId`、`version`、
`availableActions`。只在当前状态匹配时再返回一个说明字段：`blockedReason`、`completionSummary` 或
`cancelReason`；`pending` 与 `in_progress` 不返回状态说明。Agent projection 不透传 Camp、创建者、时间或
关闭审计字段。

`availableActions` 仍只是 advisory metadata，真实 authority 与字段级 mutation 继续由 Core 在调用时
执行。旧 Task 数据在当前读取中可见，但旧 create/update payload（包括 Host command reconciliation）不
提供 legacy decoder；它们作为不兼容输入拒绝。
