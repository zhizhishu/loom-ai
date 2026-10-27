---
document_type: protocol-contract
contract: run-process-detail-surface-v41
authority: execution-evidence-lifecycle-and-change-cursor
status: accepted
version: 41
source_version: v1.64
last_updated: 2026-09-22
---

# Run Process Detail Surface v41

继承 [v40](run-process-detail-surface-v40.md) 的三位置执行台、进入规则、Run 导航、停止、折叠历史、
Delivery 队列和紧凑卡片。本版只替换新 Execution Evidence 的生命周期存储、增量游标和私有思考边界；
历史 Evidence 保持原样读取，不回填或重分类。

## Operation 生命周期记录

新进入 Core 且拥有可靠协议原生 ID、Core 调用/receipt 关联或 Adapter 封闭证明身份的 command/tool
operation，在同一 `agentRunId + executionEpoch` 内只保存一条生命周期记录：

- `id` 与 `sequence` 在首次出现时分配并保持稳定；`sequence` 只表示展示位置；
- `operationId` 是稳定关联身份；无法可靠关联、历史已开始的 operation 和独立事实继续走既有记录路径；
- `revision` 在该记录发生有效语义变化时递增；
- `changeSequence` 是 Run 内单调递增的变更序号，每次有效 INSERT/UPDATE 分配新值；
- 记录写入、`revision`、`changeSequence` 与 Run 的 `executionEvidenceChangeSequence` 在同一事务提交；
- 重复通知若没有增加或改变有效事实，不递增版本或水位。

终态可以先于 started 到达并创建记录。迟到 started 只能补足缺失输入与元数据，不能把 terminal phase
退回 started，也不能覆盖已经确认的结果。两个互斥终态都被原准入规则接受时，记录保留冲突证据，
Canonical Activity 使用 `outcome=unsettled`；不按最后到达者伪造确定结果。

公开正文仍以稳定 block 为一条可变记录，并使用同一 `revision + changeSequence` 协议；delta 只在内存运输，
定稿后才写入正文。`agent.thought.*`、`agent.reasoning.summary.*` 和原生 reasoning item 在持久化、临时文件、
日志与 Renderer 缓存之前丢弃。执行台只接收不含文本的瞬时 `thinking | executing` phase；历史已持久化思考仍按
旧数据兼容读取。

## 输入、结果与 Managed Blob

生命周期行把输入和结果作为两个独立内容部分持有。小内容分别内联；大内容分别使用
`inputBlobId` / `resultBlobId`，读取详情时按需组合，不再写入第三份“输入 + 结果”组合 Blob。输入不因状态变化
重写，结果只有在有效内容变化时才替换。

单个输入和单个结果各自沿用 64 MiB 上限。单项超限或不可读取时保存明确的 incomplete 状态、字节数和摘要，
同时保留已知执行事实；内容失败不等于 operation 失败，也不等于没有文件变化。

新路径写出的 replaceable Blob 先带持久 GC candidate 标记；权威引用事务成功后解除标记。引用被替换时，
以解除引用时间重新登记 candidate。Core 维护入口只回收这些明确归属新路径的候选；宽限期后，在删除前通过
SQLite schema 中全部 `managed_blob(id)` 外键做最终引用复核，并在同一进程数据库互斥范围内把文件先移出可读
命名空间再删除元数据。重新挂接、在途读取、事务回滚和进程中断都不得造成已引用内容被删除；历史无标记 Blob
不因本版进行全库清理。

## 执行窗口与实时合并

`agentRunExecution.page` 与 `agentRunExecution.changes` 使用 schema 2：

- page 仍按稳定 `sequence` 逆序分页，并返回 `throughChangeSequence`；
- changes 接收 `afterChangeSequence`，按 `changeSequence` 递增读取，返回
  `requestedAfterChangeSequence`、`nextAfterChangeSequence`、`throughChangeSequence`；
- `throughSequence` 仅用于展示位置范围，不再兼任更新游标；
- Camp Open 与 Single Chat Run 摘要公开 `executionEvidenceChangeSequence`；
  `executionEvidenceCount` 只保留原始行数口径，不再充当更新 revision；
- 实时 Evidence 事件携带稳定 Evidence ID、`revision` 与 `changeSequence`。Renderer 按稳定 ID 替换，拒绝
  较旧 revision/change response；历史无版本记录继续用既有 refresh-ID 兼容路径。

分页、折叠、选择、滚动和详情展开不因记录更新而重建整个执行卡。Runtime phase 事件只改变运行中摘要的
“思考中 / 执行中”，并作为匿名公开正文的内容边界；它不能携带或恢复思考文本。

## 验收

- started/completed、terminal-only、迟到 started、重复通知与终态冲突都只产生一个稳定 operation 行；
- 已终态记录的补齐可以从独立变更游标读到，记录数量和展示序号不变也不会漏更新；
- 输入与结果分别保存、分别执行 64 MiB 边界，详情读取不产生组合 Blob；
- 替换 Blob 可恢复、可重挂接，任何现存外键都会阻止回收；
- 新 reasoning/thought 文本在 SQLite、Managed Blob、Renderer live state 与日志中均不存在，只显示瞬时 phase；
- 历史 Evidence、旧 classifier 和旧无版本 wire 继续可读，不回填。
