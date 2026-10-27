---
document_type: protocol-contract
contract: run-process-detail-surface-v52
authority: conversation-run-presence-surface
status: accepted
version: 52
source_version: v1.72
last_updated: 2026-10-13
---

# Run Process Detail Surface v52

继承 [v51](run-process-detail-surface-v51.md) 的位置、单行原文推进、4.8 秒高亮、菜单、停止、
重试与读取恢复。本次修正输入受理回执晚于实际活动时的会话执行行预览；Desktop 与 Web 共用规则，
不按 Runtime 名称分支。

## 当前执行活动与启动反馈

- 失败、停止请求和等待仍优先显示各自反馈；排队不创建执行行。
- running 且 `waitReason=runtime_initializing` 时，只使用 `agentRunId` 与当前 Run 相同、
  `executionEpoch` 与当前执行轮次精确相同的 Evidence 投影正文和工具。
  已有非空公开正文或工具活动时，直接显示最新活动，不等待输入受理回执。
- 旧轮次、缺失轮次、未来轮次或其他 Run 的 Evidence 不能覆盖连接状态；空白正文和原生阶段
  元数据也不能充当可见活动。没有合格活动时，继续显示“正在连接智能体…”。
- Core 按已有输入受理事实清除初始化状态后，沿用原有活动投影；无可见内容时显示合法原生思考
  短标题或“正在处理你的请求…”。受理回执晚到不能把已有活动退回空内容提示。
- 同一 Run 发布公开消息后只移动执行行锚点，当前活动继续展示；远程重新读取或恢复连接时，
  同样按当前 Run 与轮次选择内容。新轮次确实仍在初始化时保留连接反馈。

输入受理和可见活动是不同事实：部分 ACP Runtime 到 prompt 完成才确认输入，不能把此回执
当作所有智能体开始工作的时间。这里只消费已有 Run / Evidence 字段，不提前确认输入、不改写
交付水位、恢复隔离、Runtime 生命周期或数据库结构；不按耗时或 Token 数猜测阶段，不展示思考正文。

## 验收

扩展既有预览 owner，覆盖无活动初始化、同轮次正文／工具先于回执、空白与原生阶段元数据、
旧／缺失／未来轮次和其他 Run 的隔离，以及停止／失败／等待优先级。
扩展生产组件浏览器夹具，验证当前工具跨越晚到回执持续可见。
完整 Web 验证经过隔离 Host 的 HTTP/SSE，检查先有活动再发公开消息、晚到回执、慢读取、
窄窗口及断线恢复；合成 Runtime 证据与真实模型测试分开记录。
