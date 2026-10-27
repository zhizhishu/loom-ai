---
document_type: version-overview
version: v1.64
lifecycle: historical
authority: version-scope-and-status
design_status: confirmed
implementation_status: completed
model_context_change: false
last_updated: 2026-09-22
---

# Rovai-ai v1.64：Execution Evidence 生命周期减重与可恢复投影

前置：[v1.63](../v1.63/README.md)。后续：[v1.65](../v1.65/README.md)。本版把新 command/tool Execution Evidence 从 started/result 多行改为统一
Operation 生命周期记录，以独立变更水位保证原位更新可见；私有思考只保留不含正文的瞬时运行 phase。输入、结果和
Files Changed detail 使用可恢复的受限 Blob 回收，文件变化投影在合法迟到事实到达后按 exact Run/epoch 水位失效
重算。历史数据保持原样，不回填。

## 目标与边界

- 可靠关联的新 operation 使用一条稳定 Evidence：`sequence` 固定展示位置，`revision` 表示记录版本，
  `changeSequence` 表示 Run 内有效变更顺序；重复通知不推进版本。
- terminal-only 可以建档；迟到 started 只补缺失事实且不回退终态；冲突终态保留为 `unsettled`。
- 公开正文 block 使用同一 revision/change 协议；thought/reasoning 在持久化、临时文件、日志与 Renderer 缓存前
  丢弃，只通过 `thinking | executing` 瞬时 phase 提供状态反馈。
- 生命周期输入与结果分别内联或持有 Blob，不写组合副本；单项沿用 64 MiB 上限，超限明确标为 incomplete，
  不反向改变 operation 或文件变化结论。
- 只对新 replaceable-content 路径登记持久 GC candidate。宽限期从解除引用开始，删除前复核所有 Managed Blob
  外键并保护同进程在途读取；不借本版扫描清理历史 Blob。
- Files Changed 继续复用既有 Diff 归约；projection 按 `agentRunId + executionEpoch` 的文件事实水位失效，
  `complete` 和 `no_changes` 都可更新，稳定复用 `evidenceFileId`。
- 重算摘要、detail、来源水位和 revision 原子发布；失败保留上一份可读结果并标为 stale，旧 detail 替换后进入
  同一受限 GC。
- Renderer 按稳定 Evidence ID / projection revision 合并，拒绝旧异步响应；刷新不卸载 Run 卡或 File Change Tab，
  保留选择、展开和滚动位置。
- 无可靠 operation 关联的独立事实继续沿用原路径；Runtime 准入、取消/epoch fence、Canonical classifier、
  Diff 算法、历史数据和 Agent-facing context 不扩张。

字段级合同见 [Run Process Detail Surface v41](../../contracts/run-process-detail-surface-v41.md)、
[Runtime File Change Observation v6](../../contracts/runtime-file-change-observation-v6.md)、
[Camp Open Projection v23](../../contracts/camp-open-projection-v23.md)、
[Single Chat v7](../../contracts/single-chat-v7.md)与 [File Preview v18](../../contracts/file-preview-v18.md)。
组件边界见 [Execution Evidence 不变量](../../architecture/foundational-invariants.md#evidence-canonical-activity)、
[Runtime File Change Observation](../../architecture/runtime-file-change-observation.md)和
[Camp Open Read Path](../../architecture/camp-open-read-path.md)。实施与验证见[实施计划](implementation-plan.md)，
长期取舍见[版本决定](decisions.md)。

## 实施状态

实现与验证均已完成：Migration 168 将 data contract 从 `v1.63/schema 117` 升级到 `v1.64/schema 118`，新增 Run 变更水位、
Operation 生命周期字段、exact-epoch 文件事实水位、projection 版本和定向 GC candidate 元数据。Core、Read Side、
Desktop contracts 与 Renderer 已切换到新协议；历史字段保持 NULL/0，不执行回填。

自动化验收覆盖生命周期乱序/重复/冲突、独立增量游标、私有思考零持久化、Blob 重挂接与全外键保护、Files Changed
stale/no_changes 重算、稳定文件身份、旧异步响应拒绝、Migration 167/168 顺序升级及 TypeScript/Rust 全量回归；
文档治理、静态检查和 macOS arm64 daily package verification 同时通过。完整门禁见[实施计划](implementation-plan.md)。

## 数据与兼容性

- Migration 168 只接受精确 `v1.63/schema 117` 来源并原位升级；旧链继续先执行 Migration 167，不建立旁路。
- 历史 Evidence 不获得 `operationId/revision/changeSequence`，历史 Run 水位保持 0；读取保留旧分页和 refresh-ID
  兼容，但所有新写入从第一条记录起使用 change protocol。
- 新生命周期大内容写 `inputBlobId/resultBlobId`；旧 `contentBlobId` 继续只解释历史或独立记录。
- 新 Files Changed detail 使用 schema 3；历史 schema 1/2 继续读取，不重算、不改写 ID。
- data contract 版本与产品版本同为 v1.64；classifier marker 不轮换，既有 Activity 版本继续冻结。

## 跨版本文档影响

| 范围 | 结论 | 证据或理由 |
| --- | --- | --- |
| Version lifecycle | 已更新 | v1.63 冻结为 historical；本概览、[实施计划](implementation-plan.md)与[版本索引](../README.md)建立唯一 current v1.64 |
| Decisions | 已更新 | [版本决定](decisions.md)记录统一 Operation 生命周期、分离内容引用与定向 GC、按来源水位重算 Files Changed 三项高成本取舍 |
| Contracts | 已更新 | 发布当前 [Run Process Detail Surface v41](../../contracts/run-process-detail-surface-v41.md)、[Runtime File Change Observation v6](../../contracts/runtime-file-change-observation-v6.md)、[Camp Open Projection v23](../../contracts/camp-open-projection-v23.md)、[Single Chat v7](../../contracts/single-chat-v7.md)与 [File Preview v18](../../contracts/file-preview-v18.md) |
| Architecture | 已更新 | [Evidence 不变量](../../architecture/foundational-invariants.md#evidence-canonical-activity)、[Runtime File Change Observation](../../architecture/runtime-file-change-observation.md)与[Camp Open Read Path](../../architecture/camp-open-read-path.md)明确 lifecycle、change cursor、GC 和 projection owner |
| UI | 已更新 | [Camp 会话工作区](../../ui/components/conversation-workspace.md)增加私有思考 phase 与稳定 revision 合并；[文件预览区](../../ui/components/file-preview.md)增加 Files Changed 原位刷新、旧响应 fence 与状态保留 |
| Runtime Activity | 已更新 | 当前 Activity 不变量明确 operation row 可变而原始来源准入不变；classifier/Registry 词汇未轮换，无法可靠关联仍保留独立 Evidence |
| Runtime compatibility | 确认无需更新 | 不改变任何 Runtime 的版本资格、协议字段准入或平台支持结论；变化位于 Core 归约、存储和 Read Side |
| Documentation routing | 已更新 | 合同索引、架构索引日期、当前决定导航和版本索引均指向 v1.64 当前权威 |
| Root README | 确认无需更新 | 证据内部存储和刷新协议不改变项目定位、安装入口或公开 Runtime 支持范围 |
