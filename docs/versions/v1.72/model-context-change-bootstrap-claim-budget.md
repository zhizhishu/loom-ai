---
document_type: model-context-change
version: v1.72
change_id: bootstrap-claim-budget
revision: 1
confirmation_status: confirmed
confirmed_revision: 1
confirmed_by: User
confirmed_at: 2026-10-14
confirmation_message_id: a5582ebd-b926-4993-88d5-c83d9d3e3623
authority: proposed-model-input-change-statement
implementation_status: implemented
review_baseline: 7a40768ccded50af6e4ec062d355f17e6efc3337
last_updated: 2026-10-14
---

# Bootstrap 与 claim 容量一致性：R1

User 在已阅读消息 `58a31901-7d8a-4741-a635-494ced2e094d` 的完整流程、冻结时点、
补发／新 Session 预算及单条超限说明后，于上述消息明确要求实施并 PR 合入 main，
强调可用性优先、简洁有效。本说明记录该已确认方案，不再要求重复授权。

## 变更前

已恢复 Session 只要有旧 Bootstrap 摘要，领取阶段就可能不预留启动内容；实际组包重新读取当前
Memory 等内容时才发现摘要变化。整批已冻结，完整输入超限而失败，本可分批的消息无法处理。

## 变更后

| 位置 | 变更前 | 变更后 |
| --- | --- | --- |
| claim Bootstrap 判断 | 旧摘要非空即认为无需预留，未比较当前内容 | 在 claim 事务读取一次当前启动内容，冻结为本 Run 的快照 |
| 启动内容 | 在 Runtime 准备阶段读取当前 Charter、身份、平台 Skill 索引和 Memory 索引 | 本次使用 claim 时的相同四段内容；后续编辑在下一 Run 生效 |
| 同包容量 | 判定需要时保守预留 128 KiB，否则 0 | 按冻结 Bootstrap 的实际 UTF-8 长度及完整 redelivery wrapper 预留；覆盖补发与新 Session |
| 独立系统层 | Bootstrap 正常不占 dynamic payload 预算 | 保持；支持同包补发或已有 pending requirement 时计入可能补发的完整大小 |
| 必需上下文 | claim 计算后，组包可能重新读取不同长度的区段 | 本 Run 冻结协作投影、Run Facts、workspace、additional Skills 与 RUN_INPUT；按可能包含的完整区段预算 |
| 可选 Tasks | 不够时丢弃可选 Tasks | 保持优先级；使用 claim 时选择结果，不重新扩充 |
| 消息选择 | FIFO 最大完整前缀，但预算可能漏算 Bootstrap | 继续使用同一 FIFO selector，加入完整上下文预算；未选消息保持 waiting |
| 单条超限 | 明确失败、完整消息不截断 | 保持，不能用拆碎一条消息或无限重试规避 |
| 原子性 | Run、AgentRunInput、claimed Delivery 同事务 | 增加本 Run 快照一起提交；rollback 不留下已领取消息 |
| 领取后组包 | 本次输入已冻结，超限无法重拆 | 使用冻结快照；最终真实字节检查仍保留，不新增退回队列或自动重播 |

模型文本仍为现有完整 section：

```text
Bootstrap: SESSION_CHARTER → MEMBER_IDENTITY → ROVAI_PLATFORM_SKILLS → MEMORY_ENTRYPOINT?
Dynamic: COLLABORATION_STATE? → SELF_ACTIVE_TASKS? → RUN_FACTS → WORKSPACE? → ROVAI_ADDITIONAL_SKILLS → RUN_INPUT
RUN_INPUT: {"messages":[<现有完整、按顺序的消息投影>]}
```

没有新模型可见字段、提示或消息摘要。协作／workspace 的发送仍由 accepted marker 与实际
Session 判断；预算覆盖可能发送它们的较大输入。Bootstrap 的预留不等于每轮重发：
仍由摘要、delivery mode、pending redelivery 及原 accepted-input 门禁决定实际投递。
RunInput skill link、引用与附件投影使用现有正式 serializer，冻结选择结果，不剪裁正文。

## 明确不变

默认完整 payload 上限 256 KiB，显式模型配置继续覆盖；Bootstrap 上限和外部 Runtime 限额不放大。
单聊、历史非 batch 及已领取的旧版本 Run 保持原路由。Native Session ID 优先恢复，不因格式
或 Memory 变化重建。accepted／unknown 输入不重播；有效 accepted ACK 才推进水位。
用户主动续做的来源输入仍作为一个原子集合，不能为了容量拆分已冻结来源 Run。
Memory 快照只冻结发现索引，后续 `memory read` 继续校验实时生命周期和访问权限。

## 二次确认

实际确认：User 消息 `a5582ebd-b926-4993-88d5-c83d9d3e3623` 引用方案
`58a31901-7d8a-4741-a635-494ced2e094d`，要求“那就这么改吧，改完pr到main merge”，
并要求可用性优先、简洁有效。此次确认覆盖相同 Run 快照、完整预算及 claim 前选批；
本说明不将后续实现细节冒充为用户逐项指定的要求。

实现审核澄清了现有 Mission 边界：其实际目录和当前 branch 必须先由原 workspace owner
准备与观察，才能计入真实预算。该准备异步发生在 SQLite claim 事务之外，普通会话不等它；
准备结果带 workspace ID／generation／preparation token／路径，在 claim 事务重新核验。
过期结果保持消息 waiting；已知配置错误和准备失败各自落为可见失败，不能阻塞其他 lane。
不引入估算 padding、路径截断或 managed branch 代替实际 branch。
已冻结 Skill 链接在准备时继续做现有可用性检查；失效只移除链接，不扩张输入或改变消息正文。

## 版本、存储与兼容

新 public Manifest／Formatter 36，Profile 13，Run Facts 9；非 batch 保持 35／12／6。
Bootstrap 文本格式 5、Charter 22、Redelivery 2、Binding compatibility 保持。
Migration 198 从 schema 147 升级至 148，增加每 Run 唯一的 claim 上下文快照，扩展新版本
准入，不改写历史正文、Manifest、Bootstrap 或 accepted 摘要。快照只保存实际恢复需要的内容，
不增加平行证明摘要。新 Run 必须带快照；历史 Run 不回填、不重新 claim。
同一 Run 后续 Binding 更换继续使用该 Run 的启动内容；每个 Binding 的既有证据与 ACK 独立。

## 验证与验收

扩展既有容量选择与 Context owner，使用隔离 SQLite／Skill 目录：

- 先建立有 accepted 摘要的旧 Session，再加入进入本队员索引的 Memory；多个大消息按完整输入拆批。
- claim 后再修改 Memory、身份、协作及可选上下文，当前 Run 字节仍受冻结预算约束；下一 Run 看到新内容。
- 正常续聊、新 Session、待补发以及 claim 后产生的补发均容纳完整 Bootstrap；独立系统层不扣普通 Bootstrap。
- 精确边界、UTF-8、单条超限、续做原子性、事务回滚和重启后复用；不产生丢消息或自动重播。
- 当前升级与历史冻结输入保留；本地定向 Rust 测试、workspace check／默认测试、文档门禁及 PR CI。

真实验收只使用独立 data-dir／Skill Library，冻结前后相同输入和明确预算；不访问日常数据库。
通用语义 Gate 按现有 12 Case 目录检查可运行条件，未执行项目如实登记，不以 fixture 代替模型结果。

## 实施记录

Worktree：`/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-bootstrap-claim-budget`。
分支：`rovai/bootstrap-claim-budget`。基线见 Front Matter；最终代码 `2cf6f692`。
代码与专项验收已完成；worktree 在 PR 合并并核对 main 后清理，不触碰日常 Core 或数据。

### 验证结果

真实对照与原始报告摘要见 [验收索引](bootstrap-claim-budget-verification.json)。
可重复入口为 `scripts/smoke-bootstrap-claim-budget.mjs`；基线和候选分别使用独立 data-dir、
Skill Library、MCP、project 与 runtime cache。实际 Runtime 为 OpenCode v2.0.25，观察模型为
`sub2api/gpt-6.1-sol`。先完成预热，再在原 Session 活跃期间新增 Memory 并排入两条各含
120,000 字节中文填充的消息，成员启动身份包含 36,000 字节填充。

- 基线：两条消息一起冻结，随后因 `context_payload_too_large` 失败，复现原问题。
- 候选：两个 Run 各领取一条、均成功，真实模型写出的两个文件内容正确；Session ID 和绑定 generation 保持。
- 两轮测试准备失败的报告仍保留：第一轮在 ACK 前检查接受摘要；第二轮 Memory 检索键超长。
  修正测试准备后运行第三轮；没有修改验收条件或将前两轮记成产品通过。

| 检查 | 结果 |
| --- | --- |
| 默认 Rust workspace | 471 passed、1 ignored（既有手工 Runtime smoke），0 failed |
| Rust 编译与格式 | `cargo check --workspace`、`cargo fmt --all --check` 通过 |
| FIFO / claim owner | `cargo test -p rovai-core --features slow-tests delivery_queue::tests::`：26 passed |
| Context materializer owner | `context::slow_tests::`：45 passed；最终投影与 Mission facts `context::tests::`：8 passed |
| Migration owner | `routing_upgrade_preserves_frozen_evidence_and_rolls_back_atomically`：1 passed，含 Migration 198 来源格式拒绝、rollback 与历史证据保留 |
| Mission preparation / deletion race | `late_mission_preparation_cannot_erase_camp_deletion_cleanup_owner`：1 passed |
| TypeScript / Vitest | `pnpm typecheck`；243 个文件、2668 项测试通过 |
| 文档 | `pnpm docs:test` 10 passed；`pnpm docs:check:ci` 通过 |
| 完整真实语义 Gate | `not_run`：缺固定 Judge 配置，DEMO-101–112 未运行；专项对照不代替完整 Gate |

默认测试第一轮的三处 Mission fixture 仍假设无准备结果就能领取；现在显式提供 workspace owner 的
测试结果后领取，保留原投影、cleanup 与执行状态断言，最终全量通过。真实 Git 准备与删除竞态仍由
原 application owner 验证，没有以 fixture 模拟替代真实专项。

### Rust 测试准入

唯一新增独立 owner 为 `changed_bootstrap_splits_before_claim_and_materializes_the_frozen_snapshot`。
它拥有“accepted Session → 新 Memory → claim 分批 → 冻结组包与恢复 → 下一 Run 更新”的跨事务回归。
修复前两条可分别处理的大消息同批冻结后超限；已有 selector 边界测试只计算单次容量，不经过持久化、
Bootstrap ACK 和恢复，不能证明这些状态一致，因此需要隔离 SQLite 与 Skill 目录，使用上述队列命令验证。
该 owner 同时检查独立系统层不会被普通 Bootstrap 挤占；其余 Skill、迁移和 Mission 条件均扩展既有 owner。

### Standards

`2cf6f692` 代码复审通过：实际 WORKSPACE 准备与事务外 Git 边界保持；migration 所需替换片段逐一检查，
来源格式变化和 receipt 写失败都回滚。无剩余代码问题。完整 12 Case Gate 的证据缺口单列保留。

### Spec

`2cf6f692` 复审通过：恢复使用冻结身份；Mission 实际目录与 branch 参与完整预算；重复 Skill 引用按
已验证来源的精确路径收缩，保留每条消息的冻结 alias，不增加链接。已核对真实前后对照报告与产物断言。

两轴最终代码问题均为 0；Standards 仍保留完整语义 Gate 未运行的验证限制。
