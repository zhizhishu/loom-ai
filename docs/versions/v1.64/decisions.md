---
document_type: version-decisions
version: v1.64
lifecycle: historical
authority: decision-rationale
last_updated: 2026-09-22
---

# v1.64 版本决定

<a id="v1-64-d01"></a>
## V1.64-D01：可靠 Operation 使用一条可变生命周期记录和独立变更水位

- 状态：accepted
- 日期：2026-09-22
- 当前权威：Run Process Detail Surface v41 与 Execution Evidence 基础不变量

started、progress 与 terminal 每次追加完整 Evidence，会重复保存同一输入、放大 SQLite/Blob 占用，并让一次逻辑操作
在执行台出现多个需要再归约的物理事实。选择只对能从协议原生 ID、Core receipt 或 Adapter 封闭规则证明身份的新
operation 建立一条生命周期记录；展示 `sequence` 固定，行 `revision` 与 Run-wide `changeSequence` 在每次有效
修改时同事务递增。终态可以先建档，迟到 started 只补缺失，互斥终态收敛为 unsettled；没有可靠 identity 的事实
继续 append，历史不回填。

独立 change sequence 是这个选择的必要部分：记录原位更新时 `MAX(sequence)` 和行数都不变，若继续以它们作为游标，
终态后的补齐和冲突可能永远不可见。change sequence 只表示“当前记录发生过更新”，不保存每次通知版本，因此不构成
新的事件审计平台。拒绝保留 started/result 多行仅在 UI 合并，因为存储放大和重连漏读仍存在；拒绝逐通知 ledger，
因为本目标只需要当前权威状态和单调增量；也拒绝用标题、时间或路径相似性猜 operation identity。

私有 thought/reasoning 不再属于用户可见 Evidence。它们在持久化和 Renderer state 前丢弃，只派生 content-free
thinking/executing phase；公开正文仍以 block 生命周期保存。这样保留状态反馈和正文边界，同时不把模型私有推理
变成数据资产。历史已保存 thought 保持可读，避免用迁移伪装从未持有过。

<a id="v1-64-d02"></a>
## V1.64-D02：输入与结果分开持有，替换内容使用持久定向 GC

- 状态：accepted
- 日期：2026-09-22
- 当前权威：Run Process Detail Surface v41

可变行若每次把“旧输入 + 新结果”重新序列化成一个不可变 Blob，会在减小 SQLite 行数的同时持续留下失去引用的
大文件。选择让输入和结果分别 inline 或持有内容寻址 Blob；状态更新不重写输入，结果只有有效内容变化才替换，
详情读取在内存组合而不落第三份。64 MiB 上限分别作用于输入和结果，单项失败保存明确 incomplete，不改变执行结果。

仍可能发生结果补齐和 Files Changed detail 替换，因此新写入路径必须拥有回收责任。Blob 在权威引用提交前带持久
candidate，挂接后清除；解除引用时按当时的时间和封闭 owner 重新登记。宽限后在数据库互斥范围内动态复核全部
Managed Blob 外键，并通过 quarantine + 元数据事务防止文件先删、引用后挂或崩溃留下不可恢复状态。

拒绝直接启用旧的“按创建时间扫描全部无引用 Blob”实现，因为它先删文件、引用检查不完整且会扩大到历史存量；
拒绝只在内存排队，因为进程中断会永久泄漏；拒绝为本版建设分片 Blob 或通用 GC 服务，因为现有大小上限和 Core
维护入口足以闭合新 owner，范围应保持可审计。

<a id="v1-64-d03"></a>
## V1.64-D03：Files Changed 按 exact-epoch 来源水位失效并重算

- 状态：accepted
- 日期：2026-09-22
- 当前权威：Runtime File Change Observation v6 与 File Preview v18

旧 projector 把 `complete/no_changes` 当永久终态；生命周期行允许迟到结果和合法冲突后，后补 Runtime Diff 或文件事实
可以更新 Canonical Activity，却让 Files Changed 永久陈旧。选择让每个 `agentRunId + executionEpoch` 保存最近一次
影响文件事实的 Run change sequence，projection 保存已消费水位和 revision。两者不相等时只重算该 Run/epoch，
继续复用既有 Diff 归约和 stable file identity；发布前复核来源水位，摘要、detail 与版本同事务切换。

`no_changes` 使用同一规则，不能吞掉迟到事实。重算失败保留上一份可读结果并明确 stale；Renderer 用 projection
revision 拒绝旧响应，原位刷新已打开 Review 而不丢选择和滚动。替换下来的 detail Blob 归入 D02 的同一受限 GC。

拒绝在首次 terminal 后冻结来源并把所有迟到事实丢成独立记录，因为现有 Runtime/epoch 准入明确允许部分终态补齐；
拒绝建立通用依赖图或第二套文件事件流，因为文件事实水位可直接复用 Evidence change sequence；拒绝重写 Diff 算法，
因为问题位于投影生命周期与缓存一致性，不在文件语义归约本身。
