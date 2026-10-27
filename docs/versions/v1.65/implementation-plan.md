---
document_type: implementation-plan
version: v1.65
lifecycle: current
authority: version-implementation-plan
status: completed
last_updated: 2026-09-22
---

# v1.65 实施与验收

范围见[版本概览](README.md)，字段级协议见
[Camp Permanent Deletion v4](../../contracts/camp-permanent-deletion-v4.md)，组件边界见
[Camp 永久删除架构](../../architecture/camp-deletion.md)。

## Gate 1：受理与原子准入 cutover

- [x] `camps.delete` 对所有 Runtime 状态只执行 User/exact-version、abortive settlement、Mission Workspace 处置与 Camp
  Deletion Intent，返回 `accepted + operationId`，不等待外部 I/O。
- [x] Fleet admission gate 覆盖数据库受理事务；accepted 在释放 gate 前安装 tombstone，rejected 不污染 Fleet。
- [x] Domain Command、Delivery/Automation claim、Channel、Camp open/read/search/history、Mission、文件预览、Runtime dispatch
  与 terminal callback 共用删除 fence；Starting commit 重新检查 tombstone。
- [x] Desktop Main/Web Host 在 Core 接受后才 best-effort 释放预览，Renderer 以本地 tombstone 过滤所有迟到导航 snapshot。

## Gate 2：持久恢复与阶段交接

- [x] 首个删除 command ID 同时作为 Camp marker、receipt 和 cleanup journal 的 correlation ID；同 command replay 与不同
  command 重复删除均返回同一 operation。
- [x] accepted receipt 排除于 Camp event 聚合删除，删库后仍可 replay；可变 retry checkpoint 不写入 receipt。
- [x] Runtime cleanup target 从既有 Run 的 `id + execution_epoch + adapter_kind` 恢复；未确认隔离不前进。
- [x] `camp_delete_cleanup` journal 与 Camp 聚合删除、唯一 `camp.deleted` 在同一事务；删库后 journal 独立续跑。
- [x] 明确 cleanup 的 Mission Worktree/branch 复用既有 worker 和双检查点；retain 从删除 ownership 中移除。
- [x] Mission 准备的迟到写回正向确认 Camp 存活且未删除，并以 `state + generation + preparation_token` CAS；后台聚合删除
  与破坏性 Git cleanup 共用 Workspace 生命周期 gate，前台受理不等待该 gate。
- [x] deletion-owned Mission 行保留至 journal 最终事务；accepted receipt 已承诺 Workspace cleanup 时，空 owner 集合
  fail closed，不得误写完成。
- [x] 完成时清除资源 identity、路径、错误和 retry 诊断，所有承诺资源完成后才写 `camp.deletion_completed`。

## Gate 3：失败、重试与界面

- [x] 同一 coordinator 用通知快路、维护 tick、小批量和对象级退避恢复 Camp marker 与 cleanup journal；一个失败对象不阻塞
  后续对象。
- [x] 自动恢复耗尽后只投影 `operationId + attentionRevision`；用户 retry 继续原 operation，并恢复 deletion-owned Mission
  cleanup，不创建新任务。
- [x] 正常 accepted 后关闭确认、离开 Camp、移出列表；无阶段、进度、成功提示或删除任务区。
- [x] 用户介入只显示局部持久通知“删除未完成，请重试。”；不使用全局错误横幅，重启后可重新提醒但同 revision 不反复弹出。
- [x] 导航刷新和预览释放失败不改变 accepted；删除提交错误仍在原 Dialog/局部入口呈现。

## Gate 4：Migration 与 SQL

- [x] Migration 169 从精确 v1.64/schema 118 升至 v1.65/schema 119，只扩展 `camp` 与现有 cleanup journal 的
  marker/retry/attention 字段，不新建删除 operation 表。
- [x] 所有当前 schema 的 Camp Run 归属改为互斥 `UNION ALL`：batch 用 `agent_run.camp_id`，其余用
  `camp_turn.camp_id`；历史 migration fixture 保留无 camp_id 路径。
- [x] 增加 `agent_run(camp_id, id) WHERE camp_id IS NOT NULL`，未盲目增加其他外键索引；聚合删除仍单事务、保留引用
  解除顺序与外键。
- [x] 合成执行计划由 batch 分支 `SCAN agent_run` 收敛为 `SEARCH agent_run USING INDEX agent_run_camp_delete_idx
  (camp_id=?)`；非 batch 分支继续使用 CampTurn Camp 索引与 Run CampTurn 索引。

## Gate 5：性能证据

本地未签名打包 App、隔离 `userData` 的 8 次真实 Renderer → IPC → Core → 本地 tombstone 样本中，从点击“删除”到
Dialog 关闭且 Camp 行消失为 p50 16.47ms、p95 112.60ms，低于 p95 ≤ 250ms 的验收门槛。原始样本为
112.60、106.12、112.59、16.47、13.84、10.89、106.36、13.03ms；测量由
`ROVAI_SIDEBAR_ACCEPT_SCOPE=deletion-latency pnpm accept:sidebar-ui` 可重复执行。

隔离 Core、8 个无真实 Runtime Host Camp 的请求样本（毫秒）：

| 指标 | p50 | p95 | 样本 |
| --- | ---: | ---: | --- |
| accept request | 2.32 | 5.46 | 3.41, 3.00, 5.95, 2.03, 1.43, 1.12, 5.46, 2.32 |
| runtime_stop | 0 | 0 | 2, 0, 0, 0, 0, 0, 0, 0 |
| database | 4 | 11 | 12, 11, 5, 4, 3, 4, 9, 3 |
| cleanup | 12 | 51 | 8, 12, 10, 12, 51, 103, 6, 19 |

该样本不含 Warm/Running Host，只作为请求与空停机基线。真实 Host 的停机时延必须继续由结构化
`runtime_stop_ms` 观察，不能用该结果宣称全状态 p95。

合成 SQLite 数据：100,000 Run、10,000 Turn、80% non-batch、每方案 250 次：

| 查询 | 计划关键点 | p50 | p95 |
| --- | --- | ---: | ---: |
| 旧 `COALESCE + LEFT JOIN` | `SCAN agent_run` + CampTurn PK lookup | 24.684ms | 25.342ms |
| `UNION ALL`，无新索引 | batch scan + indexed non-batch join | 5.753ms | 6.310ms |
| `UNION ALL` + 部分索引 | indexed batch search + indexed non-batch join | 0.587ms | 0.828ms |

基准全部使用一次性隔离数据，不连接日常 App 数据库。后续真实库量级验证必须退出 App 并使用 SQLite Backup API
产生一致副本，不能复制单个主文件遗漏 WAL。

## Gate 6：验证记录

- [x] `cargo check --workspace --all-targets`
- [x] `pnpm typecheck`
- [x] receipt/operation 跨聚合删除、Runtime Fleet accepted/rejected cutover、cleanup journal recovery 定向 Rust 回归；Fleet
  状态矩阵显式覆盖 no Host、Warm、Starting、两种 Running、Stopping 与 hostless 异常 entry，慢停机样本的受理均不等待
  shutdown
- [x] 前移到 v1.64 主线后的 Vitest 212 个文件、2188 项通过，包括 stale Navigation snapshot 不复现已 accepted Camp
- [x] 隔离 `scripts/smoke-core.mjs` 完成 accepted → `camp.deleted` → `camp.deletion_completed`
- [x] 本地打包 App 的 8 次点击确认到列表移除验收通过：p50 16.47ms、p95 112.60ms，门槛 p95 ≤ 250ms
- [x] 默认 Rust workspace 409 项通过（另有 1 项手工 Runtime smoke 按设计忽略），并通过 cleanup handoff 扩展回归
- [x] P1 follow-up 的真实 Git 并发回归在准备校验处受控暂停，穿过正式 accepted receipt、cleanup handoff 与 Camp 聚合
  删除，证明迟到准备返回 `None`、owner/checkpoint 保留、破坏性 cleanup 等待生命周期 gate，且 journal 只在双检查点后完成
- [x] Desktop Renderer 与 Web/Host 删除契约通过；v1.64 execution page/changes cursor 的 Host 集成 fixture 同步到当前合同；文档普通及 diff-aware 治理、Impeccable 静态 detector 与最终
  diff 检查通过

全仓 Vitest 并发运行时，evaluation report 的 5 秒用例曾因负载超时，单独重跑 13/13 通过。Host/Web 全套中另有一条
Chrome 多标签草稿隔离验收稳定失败；在改动前的 `828251f9` 隔离 worktree 同样复现，因此记录为既有基线缺陷，不作为
本版删除实现的回归，也未在本版越界修改。

## Rust 测试准入记录

新增 `camp_deletion` owner 只覆盖无法由既有聚合测试表达的新协议：accepted receipt/operation 在 Camp 聚合删除后仍可
replay，以及 bounded retry delay。Runtime Fleet 既有模块内 owner 扩展 admission gate 的 accepted/rejected 原子性；
同一 owner 的状态矩阵证明 Runtime 状态不改变受理同步边界。attachment cleanup 既有 extended owner 扩展
Authority/default output/View 的恢复。其余准入入口优先扩展原 owner 或由编译、Host/Renderer 集成测试覆盖，不为每个入口
复制一套 deletion fixture。

P1 follow-up 新增 `late_mission_preparation_cannot_erase_camp_deletion_cleanup_owner`，唯一拥有“真实 Mission Git 校验已在途，
Camp 随后 accepted 并完成聚合删除”的并发 seam。修复前该输入把 Workspace 从 `cleanup_pending + operationId` 写回
`ready + NULL`，随后 journal 把空 owner 集合误报为 completed；现有 SQL、Git 或 cleanup journal 单测都不能覆盖跨模块的
gate、持久 handoff 与真实文件清理顺序。该 owner 还受控清空一次关联 ID，单独证明已承诺 cleanup 的空集合会
fail closed；因此使用隔离数据库和临时 Git 仓库进入 `slow-tests`。最小验证命令为：

```bash
cargo test -p rovai-core --features slow-tests --lib \
  application::tests::late_mission_preparation_cannot_erase_camp_deletion_cleanup_owner \
  -- --exact --nocapture
```
