---
document_type: implementation-record
version: v1.72
last_updated: 2026-10-12
---

# 异步执行收尾与停止后继续

范围为用户确认的第 1–4 项：正文定稿及 Usage 移出同步关键路径；第 3、4 项仅验收已有停止／继续。
第 5、6 项不实施，不增加强制放行、自动重试、空闲超时或结果对账。CLI 原生 turn_end 不足以确认
Core 收到了 ACP prompt response，本改动不宣称已定位或彻底修复报告中的完成回包缺失。

分支 `rovai/async-run-finalization`，初始基线 `7973c7ffd1b0a360dea02c936458fb69f591c11e`（评审修订已合入 main `cc33bc149`），worktree 为
`/Users/murray.xue/.codex/worktrees/async-run-finalization/rovai-ai`。无前置治理分支、无模型输入变化。

## 测试归属

- 扩展既有 `execution_text::slow_tests::text_blocks_preserve_interleaving_live_reads_and_shutdown_without_fragment_writes`：
  注入定稿失败，命令成功、回执幂等、后台退避后持久化正文。旧实现会在提交后返回错误。
- 扩展既有 Usage 分批 owner 与累计 checkpoint owner：终态后刷盘失败恢复、迟到数据去重及跨 epoch 基线。
- 扩展既有 `codex_native_terminal_controls_host_independently_of_business_delivery`：持有 Usage 刷盘锁，
  仍完成终态与后继 lease。旧实现会等待该锁；进程边界由原 owner 保留。
- 新增扩展层 `async_usage_migration_preserves_checkpoints_and_rolls_back_with_receipt`：旧 schema 升级、
  receipt 失败回滚、数据保留与重开。现有旧版本迁移测试不拥有新增 trigger/receipt 的原子边界，纯函数不足以验证。
- `node scripts/smoke-stop-continue.mjs`：独立 Core/Skill Library/MCP/Home，合成 Copilot ACP 子进程
  留存正文但不返回完成回包，并忽略取消通知。通过公开 RPC 停止，确认进程清理后继续，新 Run 成功。
  SQLite 只读取证，无重启、查库修状态或强制放行。

最小 Rust 命令：`cargo test -p rovai-core --features slow-tests --lib text_blocks_preserve_interleaving`、
`cargo test -p rovai-core --features slow-tests --lib monitoring::tests`、
`cargo test -p rovai-core --features slow-tests --lib codex_native_terminal_controls_host`、
`cargo test -p rovai-core --features extended-tests --lib async_usage_migration`。
Smoke 前执行 `cargo build -p rovai-core --bins`。没有删除原 owner；原生尾读 owner 改为确定性的迟到采样，
保留历史偏移、重复调用、文件截断与后继 prompt 基线断言。

## 验证结果

- `pnpm test:rust:pr`：465 passed、1 ignored，默认 workspace 门禁通过。
- `cargo check --workspace`、`cargo fmt --all --check`、`pnpm typecheck`：通过。
- `pnpm test`：242 个 Vitest 文件、2,639 个断言通过；Node 阶段 339 passed、2 skipped；文档及 Skill 门禁通过。
- `--features slow-tests --lib usage`：17 passed，含新迁移、原生 reader；`monitoring::tests`：13 passed。
- 文本故障注入 owner：1 passed；占用 Usage 锁的原生终态／后继 lease owner：1 passed。
- `member_environment::tests`：3 passed；当前／未来数据版本准入 owner：1 passed。
- 停止／继续 Smoke：通过。Core 已记录正文，但 input 未 accepted；停止确认旧进程消失后，
  继续产生一条新 prompt，新 Run succeeded/accepted。旧 Run cancelled 与旧 delivery_unknown 保持原值。
- `DOCS_BASE_REF=7973c7ffd1b0a360dea02c936458fb69f591c11e pnpm docs:check:ci`：通过。

验收修正旧假设：合成 Runtime 使用公开检查和
成员配置命令，不依赖旧辅助函数将所有成员就绪状态限定为 ready。没有修改生产停止／继续策略。

本地 journal 的早期/尾部统计可能缺失，短于 4 秒周期的 Run 可能没有这些统计；正常 wire 上报仍会
后台保存。本次没有复现原报告的 route/owner 竞态，不宣称自动消除了完成回包缺失。

## PR #713 评审修订

- 正常退出：writer fence 和最终取消事务之后，监督器给正文一次最多 1s、受现有 hard deadline 约束的
  落盘机会；阻塞工作线程执行 I/O，忽略后台退避。失败只记日志；复用既有 400ms 后显示的安全退出弹窗。
- 渠道：已有 console 与首次发现的终态 console 都检查正文块是否仍为 streaming，未定稿保持
  terminal_pending；定稿后再保存 immutable snapshot，原有事件和 watchdog 负责后续刷新。
- 与 main 的合并保留队员 CLI 启动环境迁移 193/schema 143，本 PR 的 Usage 迁移顺延为 194/schema 144，
  当前 Version Decision 顺延为 D36；不复活已退役的环境快照和 hydrate 流程。

复用测试 owner，不新增 Rust test 函数：

- `channel::tests::terminal_execution_console_recovers_after_completed_request_and_restart` 在现有
  terminal_pending/restart 夹具内暂停正文维护，跨过 quiet window，先断言未封存，再执行维护并重开，
  最终快照包含完整 Blob 正文。旧实现会提前 terminal_sealed。最低命令同名 `--features extended-tests --lib`。
- 既有 execution_text owner 增加已过期 shutdown budget 不写入、未到普通重试时间仍能末次落盘的断言。
- 复用 `scripts/smoke-stop-continue.mjs --shutdown-text`（内存正文）及 `--shutdown-text --spooled`
  （超过 64 KiB 的临时文件正文）。真实 Core + 合成 ACP，公开 RPC 正常关闭，等待自然退出，重新启动，
  通过公开 Evidence content 读取完整 interrupted 正文。只读取 SQLite；没有手工调用维护函数、改库或
  借助强杀制造成功。原来的无重启停止→继续仍由默认参数单独验收。

评审修订验证：

- 退出验收在修订前构建失败：正常 shutdown/reopen 后正文内容为 `""`，证明它覆盖生产退出链路。
- 渠道延迟定稿／重开 owner、正文退出预算／退避 owner、Usage 迁移 owner、当前 schema 准入 owner：通过。
- main 环境迁移与配置 owner：4 passed；Codex 原生终态不等待 Usage 锁 owner：1 passed。
- `pnpm typecheck`、`pnpm test`：通过；242 个 Vitest 文件、2,639 个断言；Node 339 passed、2 skipped。

- 修复后真实 Core 正常退出／重开：512 字节内存正文、160,000 字节 spool 正文均完整保留；
  关闭耗时分别 38ms、56ms（单次夹具观察，不作为性能承诺）。1s 为上限，不固定等待。
- 默认停止→继续 Smoke：通过，无 App 重启、无数据库修复；旧 Run/input 状态保持不变。
- 文档治理与格式检查：通过。

- 修订后 `pnpm test:rust:pr`：465 passed、1 ignored；`cargo check --workspace` 与 `cargo fmt --all --check`：通过。

Status：ready；Next：PR #713 等待仓库 CI/review 后合入。
