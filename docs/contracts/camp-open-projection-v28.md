---
document_type: protocol-contract
contract: camp-open-projection-v28
authority: run-model-display-projection
status: accepted
version: 28
source_version: v1.72
last_updated: 2026-10-13
---

# Camp Open Projection v28

继承 [v27](camp-open-projection-v27.md) 的启动公开消息边界与有界读取规则。
Snapshot / Open 共用的 `AgentRunView.runtimeModel` 补齐模型展示信息，不升现有 schema。

- 非空记录包含 `adapterKind`、`modelId` 和 `reasoningEffort`，与公开消息的来源 Run 模型投影复用同一函数。
- `explicit` 使用 Run 冻结的 model ID 与已记录强度；`runtime_default` 使用首个可信观察，尚无观察时
  `modelId` 为 null。没有有效冻结记录时整个字段为 null，不读取队员当前配置作为回退。
- 强度只投影对应适配器的展示选项：Claude Code 的 `effort`、Pi 的 `thinking_level`、其他适配器的
  `reasoning_effort`。未记录时为 null，不推断默认强度。其余配置、环境变量与凭据不进入 View。
- 新 Renderer 兼容旧 Host 的 `{ modelId }`：保留已记录 ID，无 ID 时显示智能体默认；不猜测适配器或强度。
  旧 Host 的 null 保持模型未记录。旧读取方可以忽略新增字段。

读取仍是现有有界 Run 查询，仅补读冻结的适配器与模型选择列，不增加查询、历史消息 hydration、
事件日志访问、业务写入或数据库迁移。模型观察继续沿用现有 invalidation / refresh 路径。

验证扩展现有 `camp_open_preserves_business_state_without_reading_event_history`，核对 Snapshot / Open
均传递显式模型与默认观察的展示字段；选项、缺值与不投影其他字段的矩阵仍由 `message_model` 纯函数 owner 负责。
