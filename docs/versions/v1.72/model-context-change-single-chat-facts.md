---
document_type: model-context-change
version: v1.72
change_id: single-chat-facts
revision: 1
confirmation_status: confirmed
confirmed_revision: 1
confirmed_by: User
confirmed_at: 2026-10-18
authority: confirmed-model-input-change-statement
implementation_baseline: 92736d707c9162133a93b7720ae826e7dad90e8a
implementation_status: implemented
last_updated: 2026-10-18
---

# Single Chat 固定事实精简：R1

## 二次确认

User 在当前 Thread 的 sequence 3（消息 `7d39d211-c9d3-4b16-9888-a01eca836ead`）明确要求：
“那你删除吧。另外看看单聊那方便还可以优化的”。这授权准备删除方案和继续调查单聊优化。
上一轮已展示删除对象、字段用途、每轮 235 字节收益与权限/路由不变的结论；当时尚未提供本文件的
完整版本、迁移与验证说明。本 R1 依照[模型上下文治理](../../development/model-context-change-governance.md)
完成确认：User 随后在 sequence 5（消息 `e76e72a0-f68f-4914-ba32-00b0bceaa0fc`）明确回复
“没问题，先处理这个然后pr到main”，确认实施本 R1；sequence 6 又明确要求“merge”，授权合并该变更。

本轮按 R1 实施第 1～6 节；第 7 节是额外调查结果，不进入 R1 的实施范围。

## 1. 问题与范围

新单聊每轮在 `RUN_FACTS.singleChat` 中发送七个常量。它们没有本轮特有值，内容已由专用
[Charter](../../../crates/rovai-core/resources/charter-rovai-single-chat.md)及
[Guidance](../../../crates/rovai-core/resources/single-chat-guidance-v3.json)说明。

[Context builder](../../../crates/rovai-core/src/context.rs)只负责生成这份模型投影；
[SingleChatService](../../../crates/rovai-core/src/single_chat.rs)从持久 AgentRun 读取
`response_delivery`、`operation_policy` 和 `operation_policy_version` 执行工具授权，
[Runtime terminal](../../../crates/rovai-core/src/runtime.rs)按冻结目标、epoch、取消状态及会话状态校验私有输出。
这些控制路径不读取模型可见的 `singleChat` JSON。

R1 删除模型输入中的整个 `singleChat` 属性及其七个子字段，不增加替代标记。

## 变更前

当前新 Single Chat 输入的完整 Run Facts 业务形状如下。新单聊使用独立 Turn，既不投递 Mission、Task
或 Session continuity facts，也不进入已退役的 Gather/A2A 预算分支。

```ts
type SingleChatRunFacts = {
  attachmentOutputRoot: string;
  singleChat: {
    kind: "single_chat";
    visibility: "principal_only";
    responseDelivery: "single_chat_message";
    operationPolicy: "single_chat_v1";
    threadPublicationAllowed: false;
    memberDispatchAllowed: false;
    memoryMutationAllowed: false;
  };
  externalEffect?: {
    state: "unsettled";
    requiredAction: "reconcile_before_repeat";
  };
};
```

`attachmentOutputRoot` 必有，值来自当前 Thread 的附件输出根。`singleChat` 只在单聊出现且必有。
`externalEffect` 仅在当前 Conversation 存在 unknown Action execution 时出现，否则省略，不输出 `null`。
其他历史输入和遗留 invocation 的已有 facts 不在本次清理范围。

没有未结算外部效果时的完整区段为：

```text
[RUN_FACTS]
{"attachmentOutputRoot":"<原附件输出根>","singleChat":{"kind":"single_chat","visibility":"principal_only","responseDelivery":"single_chat_message","operationPolicy":"single_chat_v1","threadPublicationAllowed":false,"memberDispatchAllowed":false,"memoryMutationAllowed":false}}
[/RUN_FACTS]
```

## 变更后

```ts
type SingleChatRunFacts = {
  attachmentOutputRoot: string;
  externalEffect?: {
    state: "unsettled";
    requiredAction: "reconcile_before_repeat";
  };
};
```

两个保留字段的来源、值及省略条件完全相同。`singleChat` 整个属性省略，不输出 `{}`、`false`、
`null`、`mode` 或新的文字说明。删除共用序列化结构内仅服务该投影的 `ConversationModeFact`、
`conversation_mode` 字段和构建分支；业务层冻结的同名/近似字段不删除。

没有未结算外部效果时：

```text
[RUN_FACTS]
{"attachmentOutputRoot":"<原附件输出根>"}
[/RUN_FACTS]
```

存在未结算外部效果时：

```text
[RUN_FACTS]
{"attachmentOutputRoot":"<原附件输出根>","externalEffect":{"state":"unsettled","requiredAction":"reconcile_before_repeat"}}
[/RUN_FACTS]
```

按当前 compact JSON 序列化，移除该属性及其分隔逗号精确减少 **235 UTF-8 字节/新单聊输入**。
不把字节数当作 Token 数，也不据此声称模型质量已经改善。

## 明确不变

- 专用 Single Chat Charter、Member Identity、无 Memory 的 Bootstrap，以及四句 `SINGLE_CHAT_GUIDANCE`
  保持原字节；`CURRENT_INPUT` 仍为最后一个区段。其余区段名称、顺序和发送条件保持。
- 公屏 batch 的初始输入及 Steer 字节不变；其他 non-batch invocation 原本不输出 `singleChat`，其模型字节保持。
- `SHARED_THREAD` 的增量水位、最近消息选择、引用闭包、遗漏记录及每条正文/总历史上限保持。
  payload 总字节预算保持；减去 235 字节会使极端预算边缘可能少裁剪一条可选历史，这是既有预算算法的自然结果。
- `COLLABORATION_STATE` 的选择与按变化投递、Workspace、附件路径与授权、Skills/MCP 配置保持。
- Rovai 工具仍只允许 `thread.search`、`thread.read`、`single_chat.history`、`mission.list/get`；
  当前 Thread 范围和冻结读取上界不变。此白名单不代替 Runtime 原生工具权限。
- 回复保持私有；无公屏发布、队员派发或 Memory 写入。Charter 对文件/Git/配置/外部系统修改的明确请求要求保持。
- `runFactRefs` 不减少新的引用项：当前该数组没有 `singleChat`/`conversation_mode` 引用。
  最终输入 Blob、Manifest 来源、实际投递及 accepted ACK 继续按既有 owner 留证。

## 4. 版本、迁移与兼容

以下数值以本文件声明的 baseline 为准；这是现有序列化版本的推进，不新增版本轴。

| 项目 | 当前 | R1 候选 |
| --- | --- | --- |
| non-batch Formatter / ContextManifest | 41 / 41 | 42 / 42 |
| non-batch Run Facts schema | 12 | 13 |
| non-batch Delivery Profile | 16 | 16 |
| public Formatter / Manifest / Facts / Profile | 40 / 40 / 11 / 15 | 保持 |
| Charter / Bootstrap Formatter / Binding compatibility | 24 / 5 / 16 | 保持 |
| Single Chat operation policy / version | `single_chat_v1` / 2 | 保持 |
| 数据库 projection schema / migration receipt | 157 / 最新 207 | 158 / 新增 208 |

数据库仅扩展现有 Manifest/Formatter/Facts 版本准入及其 Profile 16 配对，保留旧分支、业务行、索引、触发器、
Blob 引用与 migration receipts；不删除 AgentRun 上的策略和输出目标。新 non-batch 物化使用 42/13，
旧已物化输入直接复用原 Blob，不从当前 builder 重建。未物化输入按现有路径首次生成新版本。

迁移必须事务化并验证失败回滚、升级后重开和旧行保留。应用降级沿用现有 schema 准入规则，不声称旧二进制可直接
打开升级后的数据库。已有 Native Session 不轮换、不重放旧业务消息；accepted/unknown Delivery 不因本次变化重发。

## 5. 文档与实施位置

实现修改集中在 `context.rs` 的 facts/序列化、`context_contract.rs` 的既有版本常量和数据库准入 owner；
保留历史输入读取。对应更新当前 Run Facts、ContextManifest、Single Chat 合同以及其 Architecture/索引路由，
纠正仍将现行模型字段称为 `conversationMode` 的导航；Profile 数值与语义保持。

| 文档范围 | 结论 |
| --- | --- |
| Version lifecycle | 保持 v1.72 current；本文件记录待确认及后续实施状态 |
| Version Decision | 局部可逆投影调整，不新增决定或数字 ADR |
| Architecture | 确认后更新单聊 Context 与 Run Facts 边界 |
| Contract | 确认后明确新非 batch 版本配对、字段省略与旧输入恢复 |
| Documentation routing | 确认后链接新的当前合同；当前只添加提案入口 |
| UI | 无 Renderer 变化 |
| Runtime Activity | 无用户执行过程展示变化 |
| Runtime compatibility | 不轮换 Native Binding；新增内部持久版本准入 |
| Root README | 产品功能未变，无需更新 |

## 验证

遵循 [Rust owner 准入规则](../../development/testing.md#rust-测试准入与退役门槛)，优先扩展以下既有测试，
不为字段删除新增平行 Rust 测试函数：

| Owner | 必须保留/增加的判定 |
| --- | --- |
| `single_chat_contract_bytes_and_dynamic_section_order_are_exact` | facts 无 `singleChat`；Charter/Guidance 字节保持；Guidance 在 CURRENT_INPUT 前；无 A2A/Task 段 |
| `single_chat_materializes_conversation_input_with_a_memory_free_bootstrap` | 新输入持久版本配对正确；附件根及 externalEffect 语义保持；同一输入重读逐字一致；仍无 Memory 访问 |
| `single_chat_public_delta_includes_the_target_agents_own_public_message` | 历史窗口与目标 Agent 自己的公屏输出纳入规则保持 |
| `built_in_policy_is_closed_and_runtime_loss_cancels_only_the_reply` | 禁止发布、派发、写 Memory；五项允许操作与作用域保持 |
| `successful_final_is_private_and_a_cancelled_run_cannot_append_late_output` | 私有终态及取消/迟到输出 fence 保持 |
| 现有数据库迁移/输入快照恢复 owner | 42/13/16 准入；错误配对拒绝；旧 41/12/16 Blob 原字节恢复；回滚与行保留 |

最低成本定向命令：

```sh
cargo test -p rovai-core --lib single_chat_contract_bytes_and_dynamic_section_order_are_exact
cargo test -p rovai-core --features slow-tests --lib single_chat_
cargo test -p rovai-core --lib built_in_policy_is_closed_and_runtime_loss_cancels_only_the_reply
cargo test -p rovai-core --lib successful_final_is_private_and_a_cancelled_run_cannot_append_late_output
pnpm docs:test
pnpm docs:check
DOCS_BASE_REF=92736d707c9162133a93b7720ae826e7dad90e8a pnpm docs:check:ci
```

数据库定向命令由最终选中的现有 migration owner 明确记录，不能用新字段快照通过代替迁移验证。
上述 Rust 命令为实施后的计划，本次提案阶段不声明已通过。

按[上下文 Gate](../../development/evaluation.md#上下文改动-gate)冻结当前 suite 2.12.0 的
DEMO-101～DEMO-112、scoring-v2.10，基线与候选各一次，`maxParallelCases=2`，campaign
`wallSeconds=14400`，最多两次尝试并保留失败证据。模型、程序路径、权限与 Judge 在实际运行前按同一
可用环境冻结；没有固定 Judge 或真实 Runtime 就记录证据不足，不虚报 Gate 通过。

通用集不能替代私有路径验收。另在隔离 Core/CLI 中对基线和候选执行同一四组单聊场景：普通问答私有输出；
请求发布/派发/记忆写入不能越过 policy；缺失先前单聊信息按需调用 history；热续接及压缩补投后仍按单聊回复。
每组最多 300 秒，合计最多 2,400 秒；通过条件为请求得到正确回应、输出目标与读取证据正确、无新增越界副作用。
所有真实运行遵循[本地隔离流程](../../development/local-workflow.md)，不使用日常数据库或 Electron userData。

## 7. 额外调查：不在 R1 实施范围

### 优先处理：避免暴露无法完成的官方 Skill 流程

`prepare_additional_skills` 按成员配置构建 Toolbox 索引，没有 Single Chat 模式过滤。
配置了 `member-studio` 时，它可进入单聊；其创建阶段要求 `rovai member create`，而当前单聊白名单拒绝该操作。
`review-duo` 和 `grill-duo-with-docs` 的流程也要求 `rovai send`。旧 `filter_single_chat_skill_exposure`
只过滤旧 official bundled 的 `cli-operations` 与 `memory-stewardship`，并不负责新的 Additional Skills 索引。

建议单独审查官方 Toolbox 的单聊适用范围，并在生成索引的 owner 过滤确实依赖不可用操作的流程。
不能靠删除警告、扩大权限或按第三方 Skill 的同名字符串误过滤来解决。
本项会改变 Skill 选择，需要独立完整前后对照；本 R1 不包含它。

### 收益最大但会改变取材方式：自动公屏历史

单聊仍走 non-batch 自动历史选择：最近消息窗口上限 15 条、每条正文上限 2,000 字符、总历史上限
24,000 字符，并保留最多 3 条引用链。具体选择取决于单聊自己的 accepted public watermark，
不是每轮都重新发送满额历史。

可评估改为明确引用加按需 `rovai thread read/search`，从而减少无关公屏内容。但这会影响“刚才他们讨论的方案”
等请求的取材与检索，需要设计私有冻结上界内的发现提示和读取规则，并单独确认；不能直接套用公屏 live read 规则。

### 收益较小：Guidance 与协作信息

现有四句 Guidance 共 377 字节（含区段标记与空行），内容都能在 Charter 找到；逐轮提示仍有恢复价值。
后续可评估将四句压缩成更短的提醒，本 R1 保留原字节。

`COLLABORATION_STATE` 还包含默认 Lead 角色；单聊不派发协作，但 peers 的姓名/角色可帮助理解公屏引用。
而且该段只在需要 Bootstrap 或内容变化时发送，不应把它估算成每轮固定开销；优先级低于前两项。

## 8. 提案阶段记录（实施前）

- 独立分支：`codex/single-chat-context-simplification`。
- 当前只提交提案与当前版本入口，没有修改实现、Schema、当前合同或启动真实 Runtime。
- `pnpm docs:test`：10 项通过。
- `DOCS_BASE_REF=92736d707c9162133a93b7720ae826e7dad90e8a node scripts/check-doc-decisions.mjs --require-base`：通过，包含文档链接及历史冻结检查。
- `pnpm docs:check` 与同 base 的 `pnpm docs:check:ci`：在版本检查阶段因本提案尚缺确认状态、确认 revision、确认人和确认日期四项而失败；没有其他版本检查错误。保持 `pending`，不填写虚假确认来满足门禁。
- `git diff --check`：通过。Rust、真实单聊与语义 Gate 尚未运行。

## 9. 实施与验证记录（2026-10-18）

### 实际实现与兼容

已按 R1 删除完整 `RUN_FACTS.singleChat`，每次新单聊输入减少 **235 个 UTF-8 字节**，不是 Token 数。
新 non-batch 版本为 Formatter/Manifest **42**、Facts **13**、Profile **16**；public 保持 **40/11/15**。
Charter **24**、Bootstrap **5** 与 Binding compatibility **16** 保持，未改权限、输出路由或历史选择算法。
共享 TypeScript `ContextManifestView` 补齐已支持的 Formatter **36～42**、Profile **13～16** 枚举；
这是读模型类型对齐，不改变 Core 输出或界面行为。

Migration **208** 完成 schema **157 → 158**，保留已有约束分支、索引、业务行、旧输入 Blob 及投递证据。
既有 Rust owner 增加错误版本配对拒绝、事务回滚后外键恢复、旧 41/12 输入逐字读取及 reopen 检查，
没有增加平行 Rust 测试函数。当前合同和导航已更新为 [Manifest v42](../../contracts/context-manifest-evidence-v42.md)、
[Run Facts v10](../../contracts/run-facts-v10.md)、[Single Chat v9](../../contracts/single-chat-v9.md)。

### 确定性检查

- `pnpm test:rust:pr` 复验通过：**474 passed、1 个手工测试 ignored**。首次执行的进程组取消测试失败，
  单独复验及完整 PR 集复验均通过；保留首次失败观察和两次复验日志。
- `cargo check --workspace`、`cargo fmt --all --check`、`git diff --check` 通过。
- `pnpm typecheck` 通过；现有 TypeScript context contract fixture 的 Vitest 定向测试 1 项通过。
- `cargo test -p rovai-core --features slow-tests --lib single_chat_ -- --nocapture`：8 项通过；
  `cargo test -p rovai-core --features slow-tests --lib single_chat::tests:: -- --nocapture`：9 项通过。
  上述是实际执行命令，补齐了提案中个别定向命令遗漏的 `--features slow-tests`，未将零测试执行算作通过。
- 完整 `context::slow_tests::` 为 **43 passed / 2 failed**。失败的
  `attachment_only_current_input_is_empty_and_reuses_stable_camp_attachment_paths` 与
  `claimed_legacy_batch_keeps_its_format_after_context_upgrades` 均在未改基线 `92736d70` 复现：
  公屏版本期待值已落后于实际 40/11，本次未改这些公屏 fixture。
- 完整 `db::tests::` 首次为 **88 passed / 6 failed**。其中两个当前 migration receipt fixture 已从 207
  对齐至 208；`current_migration_state_admission_matrix` 与
  `database_contract_preflight_admits_current_and_rejects_future_store` 定向复验各 1 项通过。
  剩余 v103/v104/v105/v107 Runtime catalog 迁移测试的旧 Skill group CHECK 失败均在 `92736d70` 复现。
  不将这次完整 DB 命令记作通过。
- `pnpm docs:test` 10 项通过，`pnpm docs:check` 及以 `92736d70` 为 base 的 `pnpm docs:check:ci` 通过。

### 真实私有路径

基线与候选分别使用独立 Core 数据库、Skill Library、MCP 配置与工作目录，均为 Codex CLI、
`gpt-6.1-sol`、medium；未使用日常数据库或 Electron userData。两侧各四次真实 Turn 完成：
普通私有回复、禁止公屏发布/派发/Memory 写入、显式 `single_chat.history` 检索、同会话热续接。
无新增公屏消息、非私有 AgentRun 或 Memory revision。

候选随后直接打开基线验收数据库：schema 157 → 158 成功，四条旧 Manifest 与四份旧输入 Blob 的哈希逐一不变，
accepted Delivery 状态/ID、原生 Session、Binding ID/generation/compatibility digest 保持。
升级后的真实私有回复成功，新输入为 42/13/16，旧输入仍保持原字节。

**覆盖限制：**未强制制造原生私有历史缺失，history 是显式请求；未观察到原生 compaction，
因此压缩后的补投场景未通过真实验收。私有 probe 的整体 `partial` 状态原样保留，不提升成全场景通过。

### 通用 Gate：未通过

冻结 suite **2.12.0**、DEMO-101～112、scoring **2.10.0**，每侧一次、最多并行两项；
三位 Runtime 队员使用相同显式模型与权限。`judge: null`，不具备语义质量与关键协作项的完整证据。

| 尝试 | 合同检查 | 实际任务结果 | 结论 |
| --- | --- | --- | --- |
| 01 | 基线通过；候选因当前 migration receipt fixture 失败 | 基线硬性验收 11/12；候选 12 项未运行 | `degraded`；失败和缺失证据保留 |
| 02 | 基线、候选均通过 | 基线硬性验收 12/12；候选 10/12 | `degraded`；acceptance failed、regression detected、evaluation incomplete |

第二次候选 DEMO-104 的功能、回归和文件边界检查通过，但协作派发 **7 次超过上限 6**，触发预算失败；
DEMO-105 的交付产物字段未满足 `REQ-DELIVERY`。报告保留两项 `candidate_hard_failure` 和一项
`boundary.a2a` regression；没有因公屏模型合同未改而忽略这些失败，也不能凭这份小样本证明因果或非劣性。
24 个 slot 均完成；67 项规则通过、2 项失败；`evaluationFailures` 为空，语义/质量/协作缺口共 108 条。
12 对耗时均未触发冻结的退化阈值，统一 Token/费用 receipt 不可用，不据此声明质量或成本提升。

两次尝试达到上限后停止，没有更改标准或删除失败。第二次 Core 二进制摘要与第一次相同：
`2f950a3dcd208ccff589bc13deefab9956026b7a8a1187836a52a58aa55d5b3a`；两次之间仅修正测试 fixture。
后续文档收口及 TypeScript 版本枚举不改变已执行的 Core 源码或二进制。PR 的 CI 与通用 Gate 分开报告，
不能把 CI 通过表述为通用 Gate 通过。

### 证据与交付

PR：[#791](https://github.com/murray17/rovai-ai/pull/791)。完整本地证据归档位置为
`/Users/murray.xue/.rovai/archives/single-chat-facts-20261018-merge-791`，包含两次 Gate 报告、冻结计划、
原始确认稿、源码/二进制摘要、真实私有 probe、升级前数据库、实现 diff 和测试日志。
报告中的原始绝对路径仅说明执行位置，任务目录清理后不再是可执行入口。

已静态核对 campaign `index.html`、两次 `report.html`/JSON、每个 slot 及 regression、gap、failure、resource。
浏览器策略拒绝本地 `file:` URL，因而使用本地 HTML 文本解析和原 JSON 读取，没有声称浏览器打开成功或绕过策略。
