---
document_type: protocol-contract
contract: missing-send-recovery-publication-v3
authority: successful-agentrun-missing-send-publication
status: accepted
version: 3
last_updated: 2026-10-17
---

# Missing-Send Recovery Publication v3 Contract

继承 [v2](missing-send-recovery-publication-v2.md) 的发布资格、候选边界、恢复抑制及幂等规则。
本版区分原生成功完成、已提交的公开发送和最终正文，替代 v1 对每个成功 Run 必须非空 `finalOutput` 的要求。

## 已发送但没有第二份 final

共享 ACP 路径在匹配的 `end_turn` 且没有原生 error 时，可使用本 Run/epoch 已提交的有效公开发送满足
输出要求。空 final 另须确认活动 Prompt 没有尚未终结的原生工具或不支持的问卷；Core 原有
Action、Approval、输入投递、取消和版本栅栏继续在终态事务中校验。原生错误、取消、未知 StopReason
或挂起不能因为此前成功发送而变为成功。

Core 在同一成功事务中重查消息及 `command.result` receipt：Thread、作者、Run、execution epoch、
操作名、accepted 状态、消息实体和回执 `messageId` 必须一致。撤回/墓碑消息、其他 Run/epoch、
失败的发送或仅声称已发送的文字不满足条件。Single Chat 仍要求自己的非空 final。
当前产品尚无 send intent 分类，所以有效公开进度消息也属于 accepted send；本合同不推断“最终答案”。

`agent_run.succeed.finalOutput` 仍是必传字符串；上述情况允许空白。没有正文时 `finalOutputDigest`
为 null，不生成空消息、第二条自动 final 或 Missing-Send 候选，不拿公开正文伪造原生 final。
非空候选仍只在原生可靠成功边界产生，既有零发送恢复照常工作。

若已发送后原生仍失败，保留已提交消息和失败状态，公开摘要为“消息已发送，但运行结束校验失败”，
继续保留原错误分类及详情，且不得自动重放带有已提交副作用的整轮。

## 问卷与执行审批

原生 `session/request_permission` 的 `questionnaire:` option ID 是用户答案，不是执行授权。
在创建普通 Approval 或进入 bypass 分支前取消该请求；legacy approve/deny 也返回 cancelled，
不自动选择任何 allow_once 答案。该保护不关闭命令、文件或 MCP 的正常审批，不改变用户原生 CLI 配置。
MiniMax 0.6.12 尚无已确认的官方 ACP 局部配置覆盖入口；这个兜底不等于工具清单已经默认移除问卷。
