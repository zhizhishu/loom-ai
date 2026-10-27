---
document_type: implementation-plan
version: v1.72
lifecycle: current
authority: reply-details-implementation
last_updated: 2026-10-21
---

# 回复详情实施记录

User 确认 B 方案，并授权实现、PR 合并 main、安装本机 App。当前合同为
[Thread Replies v1](../../contracts/thread-replies-v1.md)，UI 边界见
[回复详情](../../ui/components/conversation-workspace.md#回复详情)。

## 实现

- `read_model/replies.rs` 按 Thread 内单父关系读取完整链身份，复用回复索引和单页正文 hydration。
  Desktop/Web allowlist、Core 分发与 TypeScript DTO 同步。无迁移、无模型上下文变化。
- `ThreadReplyReader` 拥有最多 8 页缓存、请求合并、水位/代际校验与失效；页面只渲染 50 条。
- `ReplyDetails` 提供只读列表、双向分页、悬浮复制/定位、宽度调整及完整阅读。
  ThreadWorkspace 复用原文定位、结构化正文、附件与精确 Run 执行过程，关闭详情不卸载 Composer。
- 执行来源行采用 B 的 14px 内缩。普通回复块移入现有气泡，回复详情不重复回复块。

## 验证边界与 owner

新增 Rust owner `reply_pages_follow_only_scoped_parent_links_and_hydrate_one_page` 属于
`read_model::camp_open_slow_tests`：直接回复预览的已有 owner 只取一条子消息，不能证明完整后继、
分页、删除父节点穿透、循环终止与链遍历规模，因此新增一个复用原 SQLite fixture 的 owner。
修复前不存在端点，输入“孙回复 + 两个话题 + 删除父节点”不能返回完整且隔离的链。
该合同必须真实 SQLite 才能验证递归索引路径、事务与 hydration；不引入 Runtime 或真实用户数据。
最小命令：`cargo test -p rovai-core --features slow-tests --lib reply_pages_follow_only -- --nocapture`。

Renderer 请求生命周期由 `thread-reply-reader.test.ts` 拥有，覆盖闭合零读取、缓存、翻页、单飞行合并、
迟到响应、卸载、失效立即隐藏、错误/水位/Thread 校验与活动 Run 锚点刷新。界面 fixture 复用
`scripts/fixtures/run-presence`，`?replies=1` / `?replies=long` 提供双话题合批及长链场景。

## 验证结果

- `pnpm typecheck`、`pnpm test`（249 个 Vitest 文件 / 2832 项；Node 357 项通过、2 项平台跳过）、
  `cargo test --workspace`（474 项通过、1 项人工 Runtime 忽略）和 `pnpm build:desktop` 通过。
- 新增 SQLite owner 通过：增加 10,001 条无关消息后 VM 指令仅由 339 变成 340；
  10,005 个链节点为 430,383 条 VM 指令，正文仅 hydration 100 条。
  `CROSS JOIN` 固定逐父节点读取顺序，完整复合索引约束及 <1,000,000 指令预算防止退化为重复扫描。
- 扩大运行既有 `camp_open_slow_tests`：5 项通过，既有
  `camp_open_preserves_business_state_without_reading_event_history` 因 legacy Task timeline 断言失败；
  在未修改的基线 `c83ce4468` 单独执行同一 owner，复现同一行失败。此项不是本变更引入，未删改或跳过原测试。
- 生产 Renderer fixture 的浏览器验收覆盖：两个合批话题隔离、117 条消息按 50/50/17 分页及向前翻页、
  撤回刷新、Run 结束收敛、复制/原文定位、草稿保留、精确 Run 执行浮层及 Escape 关闭顺序、
  360px 最小宽度/最大比例/完整阅读、1280/1281px 断点、1440×920 Day/Night 与 1040×700 Night 无横向溢出。
  这些是模拟 transport 下的生产组件证据，不代表真实 Runtime 验证。
- Standards 审阅的焦点装饰、分隔线、个人路径 3 项已修复并复核；Spec 审阅的 Escape、正文语义及
  inspector/执行浮层顺序问题已修复并复核。详情与时间线共享正文分流，避免语义差异。
- 安装交接在 PR 合并后执行 `package:mac:daily`、隔离 App 验收和 `install:mac:daily`，保留当前会话进程。
  精确安装路径、备份、PID 及截图记录在 Thread 交付，不作为公共仓库内的机器事实。

## 原文定位回归修复

首次交付的定位验收遗漏长列表关闭侧栏后的布局竞争：焦点已经移动，但布局恢复会覆盖滚动；
完整阅读状态也未在关闭时清除。
定位现在先退出跟随最新消息和完整阅读，再等待历史挂载与布局提交，最后滚动公共时间线并聚焦原文。
Thread 切换及卸载使在途定位失效。`scripts/lib/reply-details.test.mjs` 复用生产 Renderer 夹具，
通过真实浏览器检查已加载/历史消息、分栏/完整阅读/窄窗口、减少动态效果、调整窗口后的可见几何、
草稿保留和迟到历史隔离；纳入 `pnpm test:run-presence-ui`。该验证不启动 Core 或 Runtime。

后续复现补齐“打开上方回复详情 → 手动滚动主会话 → 回到原文”：长正文在侧栏关闭后跨过
消息分组高度阈值，`usePublicMessageLayout` 的锚点恢复即使没有位置变化也会写入 `scrollTop`，
从而取消 Chromium 的平滑定位。原文定位现在持续持有滚动位置，直到原生滚动结束；期间暂停分组与侧栏
阅读锚点恢复和自动跟随。结束时按最新行高校准目标，再交回阅读位置；用户滚轮、触控、键盘或其他定位
会取消在途跳转，切换 Thread 仍使迟到响应失效。
回归使用项目 Electron 引擎、独立临时 profile 和生产 Renderer，覆盖滚到中间/底部、长正文阈值变化、
同 Run 消息实际重新分组；继续检查最终可见位置、窗口调整、草稿和迟到响应。失败保存截图及几何信息。

## 工作区

Work item: 回复链只读详情

Worktree: `$WORKTREE_ROOT/reply-chain-details/rovai-ai`（本机绝对路径仅保留在任务交接中）

Branch: `rovai/reply-chain-details`

Base: `origin/main` / `c83ce446804d5333aa5e7b6fb2b91f25071a491b`

Governance: none（无需主线先行）

Status: implementation complete（合并、安装与清理结果见 Thread 最终交接）

Handoff: PR 合并后进行隔离 App 验收、非终止安装，并按工作区合同完成清理。
