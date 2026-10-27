---
document_type: protocol-contract
contract: message-delivery
version: 14
status: accepted
authority: public-message-delivery-route-reconciliation
source_version: v1.72
last_updated: 2026-10-14
---

# Message Delivery v14

继承 [v13](message-delivery-v13.md)，扩展现有 Runtime 的用户 Steer 运输，不改变消息、Delivery、
Manifest、公开 RPC、模型上下文和数据库结构。Agent 消息仍使用普通投递。

| Adapter | 投递和接收证据 |
| --- | --- |
| Codex | `turn/steer`，使用原生 `expectedTurnId`，沿用 v13 |
| Claude Code | 同一 Run/epoch 的 Stream JSON user；原生 replay UUID 或 result 的 user_message_uuids 确认该输入，stdin flush 不作为接受 |
| Pi | 同一 Host owner 的原生 `steer`；queued 只表示待消费，匹配 payload 的 user message_start 才确认消费；正常结束后精确从 clear_queue 取回的未消费输入可回普通队列 |
| CodeBuddy | 同一活跃 Prompt 的补充 `session/prompt`；补充请求的 end_turn 只确认该输入，不能结束原 Prompt 或 Run |
| Qwen Code | 同一 Session/Prompt 的 `craft/drainMidTurnQueue` 回调；仅返回本次已准备的 Steer，保留普通 waiting 队列；回调响应成功写入后确认，未被拉取的来源可回普通队列 |
| Grok Build | 同一活跃 Session/Prompt 的 `_x.ai/interject`，以相关响应中的 result.status=queued 确认 |

所有入口绑定已捕获的 Run/epoch，并在发送处检查 owner、活跃状态和取消 fence。其他 Adapter 忙碌时
保留普通队列。CodeBuddy、Qwen、Grok 的初始输入在当前 Prompt 出现模型文本、思考或工具活动时
确认已接受；目录更新、历史 replay、普通 user echo 和无关 metadata 不构成证据。

CodeBuddy/Grok 没有与 Codex 等价的原生 expectedTurnId，不能声称消除了原生结束竞态。
Rovai 在活跃 owner 内发送；相关响应晚于目标结束时保留未知；发生过这类注入的 Host 在原执行结束后
回收，不进入 warm pool。Pi 使用过 steer 的 Host 也回收，避免原生空闲队列进入后继执行。
逻辑 Native Session 的精确恢复沿用现有适配器，不改变 Conversation 身份。

未写入、未拉取或精确清除未消费队列的证据可以判为 not_accepted。传输中断、超时、内部错误、
不认识的响应、无法关联的结束回执仍为 delivery_unknown；不得自动重发。取消或失败不自动开新轮。
新的原生回执不会复活已结束的 Run。`runtimeInputs.reconcile` 仍只提供已有 Codex 的原 turn 正向核对；
其余 Adapter 暂无只读补证入口，未知必须保持未知。

Builder、Formatter、RUN_INPUT 和 historyHint 均沿用已确认 R3；无新的提示词、Steer 标签、正文副本、
Schema/Migration 或上下文版本号。
