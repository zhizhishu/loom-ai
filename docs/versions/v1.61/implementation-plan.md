---
document_type: implementation-plan
version: v1.61
lifecycle: historical
authority: version-implementation-plan
status: completed
last_updated: 2026-09-20
---

# v1.61 实施与验收

范围见[版本概览](README.md)，模型输入边界见
[Mission 发现确认说明 revision 2](model-context-change-mission-discovery.md)、
[完成判断确认说明 revision 1](model-context-change-mission-completion.md)与
[默认队长接收提示 revision 1](model-context-change-default-lead-mention.md)。

## Gate 0：确认与当前权威

- [x] 以当前 `main` 调查 Mission v4、Built-in v28、public/Single Chat Charter、Context 与数据库约束。
- [x] 开发者阅读完整方案后确认 revision 1，并明确要求完成 PR 后合并到 `main`；随后确认 revision 2 的内部 ID 方案。
- [x] 发布 Mission v5、Built-in v29、Single Chat v6 及版本决定，更新长期 Architecture 和文档路由。
- [x] 开发者二次确认默认队长接收提示 revision 1，并授权实现、PR 与合并 `main`。

## Gate 1：Mission read side 与标识

- [x] 数据库、内部事件、Agent Mission 操作与模型上下文共用内部 `rvm_...` ID；UI 继续从 number 显示 `M-xxx`。
- [x] 实现轻量 `mission.list` 查询、四状态筛选、标题/精确 ID 查询、20/50 上限和筛选绑定游标。
- [x] 扩展 `mission.get` 的可选 selector；省略时只解析认证 Run 当前 Camp，显式 miss 不回退。
- [x] 返回有序结构化附件，保留保存的元数据/路径，不扫描或重检源文件。
- [x] `mission.update/status` 仍只写当前公共 Mission，成功结果直接返回内部 ID。

## Gate 2：认证、Single Chat 与 Context

- [x] 所有 Mission read 复用有效 Run/epoch/lease/Binding 身份，不复用目标 Camp mutation gate。
- [x] Single Chat policy version 2 只增加 `mission.list/get`；version 1 历史 Run 仍使用旧 allowlist。
- [x] Migration 165/schema 115 原子扩展 AgentRun policy-version 约束，普通 Camp version 1 不变。
- [x] public 与 Single Chat Charter 使用确认后的最小入口文案，Session Charter revision 升至 9。
- [x] 新 Run Facts/旧 Formatter 新生成 Mission 引用继续使用内部 `rvm_...`；历史冻结字节不改写。
- [x] public Formatter/Manifest 27 与 Profile 8 只在 Agent 自动上下文派生 default-recipient Mention；
  `camp_message`、Structured Content、Delivery、读取/搜索、Quote、Channel 与 Single Chat 不变。
- [x] Migration 166/schema 116 冻结每个 AgentRunInput 的 context version 与 claim-time 接收者显示名；
  迁移前已 claim 的输入保持 v26/Profile 7，v27 恢复复用 exact payload。

## Gate 3：CLI、Skill 与封闭协议

- [x] Transport/CLI/capability 轮换为 v29，operation catalog 增至 26 项；IPC/Envelope/receipt 不变。
- [x] 根 help、generated exact help、flags、闭合输入/输出 schema、golden projection、错误恢复与 Evidence 支持新协议。
- [x] `cli-operations` 只补“已知 ID 直接 get、查找才 list、读取不切换、当前写”的协调规则。
- [x] Single Chat 继续排除完整 `cli-operations` Skill，不扩大其他 Built-in 权限。

## Gate 4：验证与合并

- [x] Rust 定向与全量测试覆盖 ID、列表/游标、附件、授权、Context、policy migration 和 CLI 契约。
- [x] TypeScript、文档/Skill 治理、格式与 diff 检查通过。
- [x] 分支保持一条功能提交并推送；PR #437 的远端 gate 通过，最终合并与 `origin/main` 祖先验证由本次交付收尾执行。
- [x] 默认接收投影覆盖 default/explicit/public-only、附件-only、Unicode 空白、非法目标、改名冻结、
  历史 v26 未物化 Run 与 v166 迁移；相关 Core、slow、TypeScript 与文档门禁通过。

## Gate 5：Mission 完成判断增量

- [x] 开发者在完整 Mission 定义可见后确认完成实现、PR 和 `main` 合并；独立变更说明冻结 revision 1。
- [x] Mission 专属 Charter 增加按需读取与完整定义完成判断，普通 Camp 与 Single Chat 正文不变。
- [x] Session Charter revision 从 9 轮换到 10；Bootstrap/Formatter/Manifest/Run Facts/Built-in 与 schema 均不变。
- [x] Mission 定向 Rust、格式、TypeScript/Node、文档治理与远端 required check 通过；合入后执行祖先验证。

## 2026-09-20 执行卡读取链路简化

- 修改前 Core 输入循环直接等待普通请求，后到的执行窗口请求连处理都无法开始；修改后输入循环只分派，
  有序语义由单一 FIFO worker 接管，`agentRunExecution.page/changes` 复用既有独立任务集合。
  `camps.enter/open` 保持有序、不可合并且不提前宣称完成，没有引入优先级调度器、只读连接或新 RPC。
- `camps.enter/open` 与执行窗口读取在完成数据库工作后立即释放 guard，JSON 序列化和无内容日志位于锁外。
  Core 日志按同一 request ID 记录到达、处理开始、拿锁等待、读取/活动文本处理、序列化和响应完成；
  Renderer 另以 Camp/Run 身份记录冷请求发出与页面完成首帧绘制，不采集输出内容。
- Renderer 删除消息发送、Camp 重命名与 Default Lead 变更后绕过 coordinator 的直接 `camps.open` 写回，
  统一为一个在途读取加至多一次 dirty trailing refresh；Camp 切换与 high-water fence 继续拒绝迟到结果。
- 新 slow test 在一个不持数据库锁的有序请求中注入受控 3 秒屏障，并要求冷 page 在屏障释放前返回。
  修复前 page 继承完整等待，修复后立即进入普通归属校验。共享数据库 mutex 仍是明确保留边界，不把该场景误报为数据库隔离已完成。

## Rust 测试准入记录

新增测试拥有既有 owner 无法证明的事务/协议边界：Mission service 的内部 ID、数值分页与筛选绑定游标；
Migration 165 的 exact v1.60/schema 114 来源、DDL 重建及 current admission；Single Chat policy v2 的新读白名单。
它们分别防止字符串排序/游标串用、Charter 已放开但数据库拒绝新 Run，以及私聊读权限只改文案未改 Core。
完成判断增量不新增平行 fixture，而是扩展既有 Session Charter 唯一 golden owner，加入 Mission 三条追加内容、
普通 Camp 排除与 Single Chat 逐字不变断言；最小验证命令为
`cargo test -p rovai-core --features slow-tests --lib context::slow_tests::session_charter_publishes_one_cli_only_builtin_contract -- --exact`。
默认接收提示新增 owner 证明投影只作用于正确的 default-addressed 消息、claim-time 显示名与 context version
不可漂移，以及 Migration 166 从 exact v1.61/schema 115 升级而不改写消息；纯 renderer 单测无法证明这些事务边界。
执行卡新增的 slow test 使用仅测试编译的受控屏障占住有序 worker、不持数据库锁，以验证冷
`agentRunExecution.page` 不继承无关的 3 秒等待；既有分类单测不能证明真实 ingress/worker/response 接线。
删除测试为零。

## 实施收口

- `cargo test -p rovai-core --lib -- --test-threads=4`：841 passed、0 failed、6 ignored。
- `cargo test -p rovai-core --bin rovai -- --test-threads=4`：28 passed、0 failed。
- `cargo check --workspace --all-targets` 与 `cargo fmt --all -- --check` 通过。
- `pnpm typecheck`、`pnpm docs:test`、`pnpm docs:check`、diff-aware 文档治理与 Skill 检查通过。
- 完整 Vitest 运行有 2 个负载敏感的 `evaluation-host` 超时，其余 2,151 项通过；该文件隔离复跑 4/4 通过，
  PR #437 的 TypeScript/Vitest gate 完整通过。
- 产品契约指纹已同步 v1.61/schema 116/Built-in 29，并由独立测试验证；Built-in catalog 本次不变。
