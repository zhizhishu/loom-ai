---
document_type: protocol-contract
contract: team-templates-v1
status: accepted
version: 1
source_version: v1.72
last_updated: 2026-10-25
---

# Team Templates v1

Team 是 User 维护的具名创建预设，不拥有已创建 Thread 的成员关系。上下文见
[Native Session Bootstrap v6](native-session-bootstrap-v6.md)，组件边界见
[Team 管理架构](../architecture/team-management.md)。

## 数据与操作

`Team = { id, name, memberAgentIds, defaultLeadAgentId, guidance, version }`。
名称去除首尾空白后为 1–80 个 Unicode scalar；成员为 1–100 个不重复 ID；队长必须在成员中。
指引去除首尾空白、保留内部换行，最多 10000 个 Unicode scalar，空字符串合法。

- `teams.list {}` 返回按创建时间和 ID 排序的 Team 数组。
- `teams.save { commandId, command: { teamId, expectedVersion, name, memberAgentIds, defaultLeadAgentId, guidance } }`：新增时前两项为 `null`，服务端生成 ID；编辑提供原版本。成功返回持久回执 `team.saved`，payload 含 `team`。
- `teams.delete { commandId, command: { teamId, expectedVersion } }`：成功回执 `team.deleted`，payload 含 `teamId`。相同命令重试回放原回执，不能再创建或删除一次。
- 保存、删除仅允许 User；版本过时或 Team 已删除返回 `team.conflict`。新增成员与新队长必须当前在场；原有不可用成员保留展示并阻止使用该 Team 创建。

Desktop IPC 和已认证 Web User 操作使用同一 Core 事务与命令回执；不向 Agent 内置工具开放 Team 编辑。
应用层成功后发布 `teams.changed`，删除同时发布创建偏好失效事件。
Web 既有 SSE 失效流仅为该事件附加 `teamsChanged: true`；Renderer 在此标记或 `resync`
时重读团队列表，不因其他 Thread 的消息、运行输出或通知变化重读，不运输 Team 正文。

## 创建与独立默认配置

`threads.create` 可带 `team: { teamId, expectedVersion }`。创建事务读取并复验该版本，使用 Team 的权威
成员和队长覆盖请求中的旧副本，再执行现有成员准入；Team 缺失为 `team.unavailable`、版本变化为
`team.conflict`。非空指引与 Thread 在同一事务写入不可编辑的启动材料；任何失败整体回滚。
无 `team` 的历史调用、Custom 与 Mission 创建维持原行为；序列化省略空 Team 字段以保留旧幂等摘要。

共享创建偏好存储以下四项：

```json
{
  "newConversationDefaults": { "memberAgentIds": ["agent_1"], "defaultLeadAgentId": "agent_1" },
  "newConversationTeamId": null,
  "newConversationDefaultsRequireConfirmation": false,
  "oneClickNewConversationEnabled": false
}
```

`newConversationDefaults` 可为 `null`，始终代表独立的 Custom 配置。非空 Team ID 只选择创建来源，
不覆盖 Custom。`preferences.newConversation.setTeam {teamId, enableOneClick?}` 原子选择 Team 或 Custom；
可选 `enableOneClick: true` 只在所选来源可用时开启。`setDefaults` 保存并选中 Custom，保留原开启行为。
`invalidate { expectedTeamId, expectedDefaults }` 同时比较两个字段，拒绝旧客户端失效通知覆盖新选择。
调用方必须从判断失效的同一份偏好快照取得两者；Desktop IPC、Web 与 Host 包装层原样传递，
不得从后来观察到的状态补齐其中一个字段。
来源仍相同时，Core 在同一事务内复验当前所选名册是否不可用；已恢复可用则忽略失效通知，
不覆盖 User 对同一 Team 修复后的重新确认。该复验也适用于独立 Custom 名册。
删除当前默认 Team 同事务清空 Team ID、关闭一键创建、保留 Custom；已有 Thread 不变。

Main 本机展示偏好 schema 升为 7；保留主线 schema 6 的语言偏好，旧 schema 1–6 的默认配置迁移为 Custom，不自动创建 Team。
Core 首次读取旧 `new-conversation-preferences.json` 时导入 SQLite singleton，保留原文件；数据库已有值
后不再导入，Desktop legacy initialize 也不能覆盖。损坏旧文件显式报错，不以空默认值覆盖它。

Migration 213 / projection schema 163 创建 `team`、`creation_preferences`、`thread_team_bootstrap`，并
扩展 Bootstrap v6 准入。沿用 data contract v1.72；失败事务回滚，旧输入与运行绑定不重写。

Migration 214 / projection schema 164 将 Team 和 Thread 启动材料的指引上限扩大至 10000，
两张表原数据、不可变触发器及外键保留；升级失败原子回滚。已有 Thread 原文不变，不触发补发。
确认与兼容边界见 [长度上限 R1](../versions/v1.72/model-context-change-team-guidance-limit.md)。
