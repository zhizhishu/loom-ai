---
document_type: protocol-contract
contract: camp-open-projection-v23
authority: camp-open-execution-change-watermark
status: accepted
version: 23
source_version: v1.64
last_updated: 2026-09-22
---

# Camp Open Projection v23

继承 [v22](camp-open-projection-v22.md) 的 Open schema 8、有界 Run 集合、空 Execution Evidence、零 Camp-wide
Evidence coverage 和读取复杂度。本版只为每个返回的 `AgentRunView` 增加必需、非负的
`executionEvidenceChangeSequence`。

该字段是 Run 内最近一次有效 Evidence INSERT/UPDATE 的单调水位，来源与记录更新同事务提交。Renderer 使用它
失效执行窗口缓存，并以 [Run Process Detail Surface v42](run-process-detail-surface-v42.md) 的 change cursor 增量读取。
`executionEvidenceCount` 继续表示原始持久行数，只用于计数和历史兼容；记录原位更新时它可以不变，因而不得再作为
revision 或刷新信号。

历史 Run 在 Migration 168 后可以保持水位 0，不回填；其初始 page 与旧 refresh-ID 兼容路径继续可读。Open 仍只
按已返回 Run 定向读取字段，不恢复 Camp-wide Evidence 扫描，也不读取 Blob 内容。

## 验收

- 新记录插入和现有记录有效更新都会提高 Run 水位，语义重复不提高；
- Camp Open/refresh 能在行数不变时触发目标 Run 的 changes 读取；
- 历史水位 0 的 Run 可正常打开，且无全表回填或跨 Camp 扫描。
