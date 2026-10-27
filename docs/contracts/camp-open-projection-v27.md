---
document_type: protocol-contract
contract: camp-open-projection-v27
authority: conversation-run-start-boundary
status: accepted
version: 27
source_version: v1.72
last_updated: 2026-10-13
---

# Camp Open Projection v27

继承 [v26](camp-open-projection-v26.md) 的分页、用户目录、回复预览、只读与资源边界。
Snapshot / Open 的共同 `AgentRunView` 增加可空字段 `publicTailSequenceAtStart`，不升现有 schema。

该字段直接投影 `agent_run.current_public_tail_sequence`：Core 领取本次 Run 输入时冻结的公开消息末尾
sequence。它不是最后一条输入的 sequence，不随后续消息、输入受理、执行轮次或重新进入会话变化。
已有 batch Run 使用持久化值；历史缺值返回 null。旧读取方可忽略新字段，前端兼容字段缺失。

读取复用现有有界 Run 查询的单列，不新增查询、消息 hydration、事件日志扫描、业务写入或持久副本。
消息分页不影响该值，不要求锚点消息处于当前加载窗口。输入 ID、`anchorMessageId`、输入摘要和模型
上下文保持原语义；展示位置由 [Run Process Detail Surface v53](run-process-detail-surface-v53.md) 定义。

验证扩展既有 Camp Open 分页 owner：后续消息把启动边界挤出首屏后仍返回原 sequence，
历史 Run 返回 null，Snapshot 与 Open 共享字段和 wire 名称；不新增独立数据库 fixture。
