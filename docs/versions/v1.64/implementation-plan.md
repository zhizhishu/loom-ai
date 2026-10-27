---
document_type: implementation-plan
version: v1.64
lifecycle: historical
authority: version-implementation-plan
status: completed
last_updated: 2026-09-22
---

# v1.64 实施与验收

范围见[版本概览](README.md)，字段级行为见 [Run Process Detail Surface v41](../../contracts/run-process-detail-surface-v41.md)、
[Runtime File Change Observation v6](../../contracts/runtime-file-change-observation-v6.md)、
[Camp Open Projection v23](../../contracts/camp-open-projection-v23.md)、[Single Chat v7](../../contracts/single-chat-v7.md)
与 [File Preview v18](../../contracts/file-preview-v18.md)。

## Gate 0：基线与历史边界

- [x] 从 v1.63 current、data contract v1.63/schema 117 和 activity classifier current marker 复核现有结构。
- [x] 冻结历史 Evidence/Run/projection，不回填 operation identity、revision、change water 或文件 ID。
- [x] 明确无法可靠关联、独立文件事实和旧 in-flight operation 继续使用原写入路径。

## Gate 1：Operation 与正文生命周期

- [x] 新可靠 command/tool operation 以 stable `operationId` 原位 INSERT/UPDATE，同事务分配 revision、Run-wide
  change sequence 与 Run 水位。
- [x] 支持 terminal-only、迟到 started 补齐、重复 no-op 和终态冲突 `unsettled`，不改变取消/epoch 准入。
- [x] 公开 narration block 使用 revision/change sequence；transport delta 不形成独立持久行。
- [x] private thought/reasoning 在持久层和 Renderer live buffer 前丢弃，仅发布 content-free phase。

## Gate 2：内容所有权与定向回收

- [x] 输入与结果分别 inline/blob，读取时组合且不生成第三份 Blob；各自执行 64 MiB 边界和 explicit incomplete。
- [x] 新 lifecycle/result 与 file projection detail 使用持久 GC candidate；事务挂接解除，替换按 detach time 登记。
- [x] 宽限后动态发现并复核全部 Managed Blob 外键，在 Core 数据库互斥范围内 quarantine 文件、提交元数据删除，
  再清除 quarantine；重挂接和在途读取受保护。
- [x] 维护任务有界处理新 owner，不扫描历史无标记 Blob。

## Gate 3：Read Side 与 Renderer

- [x] Execution Window schema 2 分离 display sequence 和 change cursor；page/changes、Run 摘要与 live event 传递水位。
- [x] Renderer 以 stable Evidence ID + revision/change sequence 合并，拒绝回退版本，历史 refresh-ID 保持兼容。
- [x] 运行摘要只消费 `thinking/executing` phase，private text 不进入 React state；phase edge 保留公开正文边界。

## Gate 4：Files Changed 一致性

- [x] exact `agentRunId + executionEpoch` 保存文件事实水位；operation 与独立 Run snapshot 共用同一 change sequence。
- [x] complete/no_changes 都按 source water 失效；定向 recovery/read 重算，发布前复核水位。
- [x] 摘要、detail 引用、source water、projection revision 和错误状态原子发布；失败保留旧可读结果并标 stale。
- [x] 归约复用既有算法；同 path 重算复用稳定 file ID，替换 detail 进入受限 GC。
- [x] File Change Tab 原位同步新 card、失效旧 detail、拒绝旧 response，并保留选择、展开、滚动和 pane 状态。

## Gate 5：Migration 与文档

- [x] Migration 168 精确接受 v1.63/schema 117，升级为 v1.64/schema 118；fresh schema、逐步 migration、downgrade
  test helper 与 contract classifier 一致。
- [x] 更新当前 Version、Contracts、Architecture、UI、决定导航和索引；不新增数字 ADR 或专项 checker 例外。
- [x] 文档治理门禁通过。

## Gate 6：验证

- [x] `cargo fmt --all`
- [x] `cargo check -p rovai-core`
- [x] `cargo test -p rovai-core --no-run`
- [x] 生命周期、正文、GC、文件投影、迁移和执行窗口 owner tests（含 slow/extended feature）
- [x] `pnpm typecheck`
- [x] execution window、live buffer、file preview 定向 Vitest
- [x] `pnpm docs:test && pnpm docs:check && DOCS_BASE_REF=<main-base> pnpm docs:check:ci`
- [x] Workspace Rust 与前端完整门禁、macOS daily package verification
