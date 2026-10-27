---
document_type: version-overview
version: v1.65
lifecycle: historical
authority: version-scope-and-status
design_status: confirmed
implementation_status: completed
model_context_change: false
last_updated: 2026-09-22
---

# Rovai-ai v1.65：可靠异步 Camp 删除与聚合 SQL 收敛

前置：[v1.64](../v1.64/README.md)。后续：[v1.66](../v1.66/README.md)。本版把 Camp 永久删除改为所有 Runtime 状态共用的可靠异步流程：确认请求只完成
原子准入 cutover 并返回 accepted，后台依次确认 Runtime 隔离、删除业务聚合和清理受管资源。实现不新增删除任务表，
而是在删库前由 Camp Deletion Intent 恢复、删库时原子交给既有 attachment cleanup journal，删库后继续由既有资源
owner 完成。

## 目标与边界

- absent、Warm、Starting、Running、Stopping 与异常 Runtime 都快速受理，前台不等待停机、SQLite 或文件系统。
- 接受事务同时关闭新执行准入、结算活跃业务并安装 Fleet tombstone；旧 Starting/lease/callback 不能重新驻留或写回。
- Camp marker、accepted receipt 与既有 cleanup journal 形成唯一阶段交接；重启、响应丢失和重复删除都续接同一 operation。
- Camp 聚合删除与 cleanup handoff 同事务，`camp.deleted` 只表示业务聚合已删；`camp.deletion_completed` 只在所有承诺
  的附件、输出、Published View 与可选 Mission Workspace 清理完成后产生。
- 用户只看到 accepted 后 Camp 消失；正常过程无阶段 UI、成功 Toast 或任务区。自动恢复耗尽时只提供
  “删除未完成，请重试。”的局部入口。
- Renderer tombstone 过滤受理前发出的迟到导航响应；预览释放和导航刷新都退出受理关键路径。
- Run 归属改为 batch/non-batch 互斥 `UNION ALL`，并只按执行计划增加 `agent_run(camp_id, id)` 部分索引；不借机
  重构数据模型。
- 删除仍只拥有 Rovai 管理的 Camp 资源。外部 Source Ref、用户项目目录、Runtime 原生 Home 和选择 retain 的 Mission
  Worktree/branch 不删除。

字段与恢复协议见 [Camp Permanent Deletion v4](../../contracts/camp-permanent-deletion-v4.md)，组件职责见
[Camp 永久删除架构](../../architecture/camp-deletion.md)，取舍理由见[版本决定](decisions.md)，实施证据见
[实施与验收](implementation-plan.md)。

## 当前状态

Core、Desktop、Web、Renderer、Migration 169 与聚合 SQL 已完成实现；工作区编译、TypeScript、Core 全量单元测试、
扩展测试编译、关键 Runtime Fleet、receipt/handoff、cleanup recovery、Renderer stale-navigation 回归、Desktop/Web
删除契约、隔离 smoke、文档治理与静态 UI 检查均已通过。本版实现状态为 completed。

Migration 169 只接受完整 `v1.64 / schema 118` 来源，升级为 `Data Contract v1.65 / projection schema 119`。新增字段
附着于既有 `camp` 和 `camp_attachment_view_operation`；没有 `camp_deletion_operation` 表、通用工作流平台或文件任务
队列。

## 性能基线

本地未签名打包 App、隔离 `userData` 的 8 次真实点击中，从确认删除到 Dialog 关闭且 Camp 行消失的 p50 为 16.47ms、
p95 为 112.60ms，满足本版 p95 ≤ 250ms 的前台门槛。

隔离 Core 的 8 Camp 合成受理样本中，请求 `accept` p50 为 2.32ms、p95 为 5.46ms；无真实 Runtime Host 的后台样本
`runtime_stop` p50/p95 为 0/0ms、`database` 为 4/11ms、`cleanup` 为 12/51ms。该数据只证明受理路径和无 Host 基线，
不外推真实 Runtime 停机时长。

100,000 Run/10,000 Turn 的合成 SQLite 数据上，250 次目标归属查询由旧 `COALESCE + LEFT JOIN` 的
24.684/25.342ms（p50/p95）降至互斥 `UNION ALL` 无新索引的 5.753/6.310ms，再降至增加
`agent_run(camp_id, id)` 部分索引后的 0.587/0.828ms。该基准未读取或修改日常数据库；最终证据与执行计划记录在
[实施计划](implementation-plan.md)。

## 跨版本文档影响

| 范围 | 结论 | 证据或理由 |
| --- | --- | --- |
| Version lifecycle | 已更新 | v1.64 冻结为 historical；本概览、[实施计划](implementation-plan.md)、[版本决定](decisions.md)与[版本索引](../README.md)建立唯一 current v1.65 |
| Decisions | 已更新 | [V1.65-D01](decisions.md#v1-65-d01)记录 Camp→journal 阶段交接且不新增删除表；[V1.65-D02](decisions.md#v1-65-d02)记录内部恢复丰富、外部交互最小的取舍，并同步当前决定导航 |
| Contracts | 已更新 | 发布当前 [Camp Permanent Deletion v4](../../contracts/camp-permanent-deletion-v4.md)，v3 降为历史；命令、receipt、fence、恢复、UI 与 SQL 验收均封闭定义 |
| Architecture | 已更新 | 新增[Camp 永久删除架构](../../architecture/camp-deletion.md)，并同步基础不变量、Camp Attachments、File Preview 与架构索引 |
| UI | 已更新 | [App Shell 与统一侧栏](../../ui/components/app-shell-navigation.md)固定 accepted 后立即移除、迟到响应过滤和唯一重试通知；不新增阶段或任务区 |
| Runtime Activity | 确认无需更新 | 删除只消费精确 Run/epoch/adapter cleanup 身份，不改变 Canonical Runtime Activity、Evidence 分类或展示映射 |
| Runtime compatibility | 确认无需更新 | 不改变 Adapter 协议、Runtime 版本、安装发现或平台资格；仅复用既有 stop/isolation 控制面 |
| Documentation routing | 已更新 | 文档任务入口、合同索引、架构索引、当前决定导航与版本指针均路由到 v4/v1.65 |
| Root README | 确认无需更新 | 项目定位与常青支持范围不变；本次只改变 Camp 删除实现与交互契约 |
