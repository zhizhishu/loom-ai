---
document_type: contract
contract: scheduled-automation-v2
status: accepted
target_version: v1.59
last_updated: 2026-09-15
---

# Scheduled Automation v2

继承 [v1](scheduled-automation-v1.md)，增加 Owner Host 配置的可空时间上限。原有定义读取、Agent CLI、
调度、结果、通知与状态机不变。

`automations.configureTimeLimit` 使用既有 Domain Command envelope：

```json
{
  "commandId": "unique-command-id",
  "command": { "automationId": "automation-id", "expectedVersion": 3, "timeoutSeconds": null }
}
```

仅 User actor 准入；此方法不加入 Agent CLI 或 Renderer/Web 命令目录。`timeoutSeconds` 必须存在，为
60–86400 的整数或明确 `null`。未知定义、版本冲突、非法时长和活跃 occurrence 分别拒绝；不修改正在运行的
快照。策略实际改变时增加定义 version，保留 `nextRunAt`；同值不增加版本。幂等回放返回原结果。

成功返回 `automationId`、`automationVersion`、`timeoutSeconds`。Host 绑定使用返回版本，并在 Owner 的
eval status 中显示本次绑定的时间策略。普通定义更新保留该策略；删除 Automation 时随定义删除。

Migration 155 将 v1.59/schema 104 原位升级至 schema 105，为定义增加可空 `runtime_timeout_seconds`，
既有定义默认 3600 秒，历史 occurrence 的 `timeout_at` 与执行图保持原值。新 occurrence 领取时冻结
`timeout_at = acceptedAt + timeoutSeconds`；策略为 null 时冻结 null，同时创建无时间截止的 Core CampTurn
budget schema 2。没有该策略的普通任务仍沿用原有时限。

无时间上限仅移除 elapsed timeout。需要人工交互、手动停止、重启中断、精确 CampTurn 取消及唯一结果结算
仍按 v1 处理。Core 只对非空 `timeout_at` 判断超时，已结束或已失败的结果不能被后续回调复活。
