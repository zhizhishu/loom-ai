---
document_type: protocol-contract
contract: message-delivery
version: 15
status: accepted
authority: public-message-delivery-route-reconciliation
source_version: v1.72
last_updated: 2026-10-14
---

# Message Delivery v15

继承 [v14](message-delivery-v14.md)，增加 Kiro CLI 与 ZCode 的用户 Steer。产品支持范围为
Codex、Claude Code、Pi、CodeBuddy、Qwen Code、Grok Build、Kiro CLI、ZCode。其他队员继续普通投递。

## Kiro CLI

使用当前默认 v2 ACP 的 `_session/steer`，参数为同一 Session 的 `message`。`queued:true` 仅说明
排队，不能确认消费。Host 在活跃 Run/epoch/Prompt 下关联 `AgentExecutionUserMessageQueued` 的
原生 messageId 与正文，再由同 ID、同正文的 `AgentExecutionSteeringInjected` 确认该输入。
2.21.1 通知会裁去正文首尾空白；仅回执比较使用该规则，发送的 Builder 字节不变。
初始输入以原 Prompt 的模型/工具活动确认，目录、历史和用户回显不能充当接受证据。

## ZCode

沿用官方 bundled app-server 与现有内部 facade，通过 `v4/command` 的 `sendText`、
`requestedDelivery:guide` 注入。原输入和其 terminal owner 保持不变；内部请求捕获 expectedInputId。
在当前 Session、原 input/turn 内，关联 `turn.steerQueued` 的 inputId/pendingInputId、原文与 guide
类型；只有 `turn.steerDrained` 的 targetTurnId、pendingInputIds、queryIds、drainedInputs 均匹配时
确认消费。普通 command 的 `delivery:queue` 不是消费回执，不能结束原 Prompt。

发送与取消在 facade 内串行过门，等待消费时释放门，取消不会被等待阻塞。目标变化且尚未写入时
可回普通队列；写入后发生拒绝、不匹配、超时或终态而无消费证据，保持未知，不自动重发。
原生 guide 退成新 Turn 时关闭 Host；原 Turn 结束仍有待消费 guide 时停止原生前台，防止其自动进入后继。

## 共同结束边界

两者都没有等价于 Codex `expectedTurnId` 的原生原子投递条件，不宣称消除了上游结束竞态。
发生 Steer 的 Host 在执行后退出复用，已有 Session 仍按正常精确恢复规则续接。
取消 fence 后的回执不能重新接受输入；失败与取消不自动开始新轮。
Kiro/ZCode 没有本次新增的只读补证入口，未知结果仍需保持未知。

多队员、附件、纯附件、权限和资源选择继续使用共同路径。Builder、Formatter、RUN_INPUT、
historyHint、消息存储、数据库 Schema 与模型提示词均无变化；不增加插话标签或指导。
