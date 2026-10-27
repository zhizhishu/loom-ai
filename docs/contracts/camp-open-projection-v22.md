---
document_type: protocol-contract
contract: camp-open-projection-v22
authority: camp-open-and-execution-window-read-boundaries
status: accepted
version: 22
source_version: v1.62
last_updated: 2026-09-20
---

# Camp Open Projection v22

继承 [v21](camp-open-projection-v21.md) 的 Snapshot 34、Data Contract 99、当前 Delivery 集合、零写入读取边界、
执行窗口、连续缓存和虚拟滚动。本版将 Camp Open wire 升级为 schema 8，只移除未被产品
消费的 Camp-wide 原始 Execution Evidence 精确 coverage；持久化、Evidence 身份、执行详情分页与
数据库合同均不变。

## 有界 Run 投影

`camps.open` 继续返回最多 96 个 `AgentRunView`：全部非终态 Run 优先，然后补足最近终态
Run。这些 View 保留标题、状态、时间、Agent、purpose/触发关系及
`executionEvidenceCount`，因此当前执行卡和历史 Run 标题不受本次改动影响。

`agentRuns[].executionEvidenceCount` 仍是该返回 Run 的持久原始 Evidence 行数，通过
`agent_run_id` 索引定向计数。它不是用户可见逻辑操作数，也不因展示窗口排除
`reasoning_summary` 而改变口径。Renderer 可继续把它作为对应 Run 详情变化与 revision 信号。

## Evidence coverage 边界

Open schema 8 仍返回空 `executionEvidence` 集合，但不再返回
`coverage.executionEvidence`。首屏不使用、也不精确计算“当前 Camp 全部 Run 的全部原始
Evidence 行数”。其他 coverage 字段保持原口径；其中 `coverage.agentRuns` 仍明确有界 Run
集合是否完整。

不得将最多 96 个返回 Run 的 `executionEvidenceCount` 求和后冒充 Camp-wide 总数，也不得用
`0` 或伪造的 `complete=true` 保留旧字段。需要执行详情时，只对用户当前可见、聚焦或展开的
Run 调用 `agentRunExecution.page/changes`；其既有 event allowlist 和 `kind <> 'reasoning_summary'`
展示过滤保持不变。

## 读取复杂度

Camp Open 不得为生成 coverage 从 `agent_run_execution_evidence` 全表扫描、再关联 Run 和 Camp。
与目标 Camp 无关的 Event 或 Evidence 历史增长，不得使打开目标 Camp 的 SQL VM 工作量随其规模增长。
每个已返回 Run 的原始计数可以使用现有 `(agent_run_id, sequence)` 路径定向读取。

## 验收

- Open 序列化结果使用 schema 8，`coverage` 中不存在 `executionEvidence`；
- `executionEvidence` 仍为空，最多 96 个 Run 的元数据与各自原始 `executionEvidenceCount` 保留；
- 另一 Camp 从 1,000 增长到 100,000 条 Evidence 时，目标 Camp Open 的投影不变且 SQL VM 工作量不随规模增长；
- 执行窗口继续在 SQL 准入层排除 `reasoning_summary`，不为本次 Open 修复重定义原始计数；
- v21 的当前 Delivery 集合与 v20 的零写入、启动恢复和文本重试 owner 保持不变。
