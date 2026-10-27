---
document_type: contract
contract: runtime-file-change-observation
version: v6
status: accepted
source_version: v1.64
last_updated: 2026-09-22
---

# Runtime File Change Observation v6

完整继承 [v5](runtime-file-change-observation-v5.md) 的 Runtime 准入、路径规范化、managed output 排除、
文件语义归约和授权读取。本版把 AgentRun Files Changed 从“终态后只生成一次”改为按来源水位失效与重算；
不新增文件事件流，也不重写既有 diff 算法。

## 精确来源水位

每个 `agentRunId + executionEpoch` 拥有 `fileFactsChangeSequence`。它直接复用本次有效 Evidence INSERT/UPDATE
取得的 Run `changeSequence`，不是第二套计数器。只有文件内容、文件操作、Runtime Diff、Run snapshot 或其可信
状态发生有效变化时推进；正文、运行 phase 和无关进度不推进。生命周期 operation 与独立 Run snapshot 都必须
更新同一 exact-epoch 水位。

每个 projection 保存 `sourceChangeSequence`、`revision`、最近尝试水位及安全错误码。缓存只在
`projection.sourceChangeSequence == fileFactsChangeSequence` 时有效；`complete` 与 `no_changes` 使用同一规则，
因此合法迟到事实可以推翻旧的 `no_changes`。

## 重算与发布

Projector 对单个 Run/epoch 读取一致来源快照和当前水位，复用既有 before/after、unified snapshot、exact mutation
与 operation history 归约。计算后在 Immediate transaction 中再次复核来源水位，并原子发布摘要、detail Blob
引用、`sourceChangeSequence`、`revision` 与错误状态；来源已变化时旧计算不得冒充最新结果。

重算按规范化 path 复用已有 `evidenceFileId`，只有新文件分配新 ID。固定 operation 展示 `sequence` 不能替代
文件事实的原始观测顺序；重复状态通知不增加 operation count。新 detail 替换旧 detail 后，旧 Blob 以
`file_change_projection` owner 和解除引用时间进入 [Run Process Detail Surface v42](run-process-detail-surface-v42.md)
定义的定向 GC。

来源读取或重算失败时保留上一份可读 projection，并把它公开为 `isStale=true`，同时记录待更新水位供下一次
维护或读取重试；不得清空成 `no_changes` 或把旧结果标成最新。启动/维护只扫描缺失或水位落后的 terminal Run，
不建立通用依赖图、全库重算或独立投影服务。

## Read Side 与 Renderer

卡片和 detail 均公开 projection `sourceChangeSequence`、`revision` 与 `isStale`。即使路径、文件数和统计未变，
detail 内容变化也必须刷新。Renderer 以 exact Run/epoch 和 projection revision 合并；较旧异步响应不得覆盖较新
卡片或 detail。已打开 Review 保留 Tab、展开状态、选中文件和滚动位置，只失效旧 detail 并原位重读，不卸载整张
卡片。失败时旧内容继续可读并允许重试。

## 历史与验收

历史 Evidence、Canonical Activity 和 projection 不回填；schema 1/2 detail 继续按既有兼容规则读取。验收至少覆盖：

- 已完成卡片在同 operation 的迟到 Diff 后标记 stale、重算并保留文件 ID；
- `no_changes` 在新权威 snapshot 到达后生成卡片；
- source 水位按 exact epoch 隔离，计算期间变化会阻止旧结果发布；
- 重算失败保留旧结果，成功替换后的 detail Blob 进入受限 GC；
- 文件列表、类型、增删统计、完整 Diff 与原始事实顺序不因生命周期合并退化。
