# LOOM 验收书（2026-10-28）

> ⚠️ **唯一入口是 `MASTER-HANDOFF-2026-10-28.md`**。本文是验收判据的逐项展开，冲突时以 MASTER 为准。

> 每项必须有命令输出或截图作证据；工兵自报、旧二进制结果、未复跑的数字一律不算。
> 状态：✅ 已通过 ｜ ⛔ 未通过 ｜ ⏳ 未执行。

## 一、当前总判定：不予验收

原因：P4-fix / P5a / P5b 已落地并实测绿，但 **Astra 尚未对最终提交复审**（第二轮 BLOCK 的唯一项在复审后才删）；
无真实 Core 全链路；按钮从未被真点过；390px 未截图；全量回归未在 HEAD 复跑。

## 二、四层验收清单

### L1 编译与测试（bero，主管亲跑）

| # | 判据 | 命令 | 状态 |
|---|---|---|---|
| 1.1 | LOOM 子集全过 | `cargo test -p rovai-core --lib loom` | ✅ 51/0（`62f9555`，9.8s） |
| 1.2 | 全量仅允许基线 3 个环境失败 | `cargo test -p rovai-core --lib` | ⏳ 483/3 但在 `62f9555`，须在 HEAD `112a4f0` 复跑 |
| 1.3 | extended 矩阵对齐 223 | 同上含 extended | ✅ `db.rs:43188`、`db.rs:43947`（Astra 已确认） |
| 1.4 | TS 类型 | `pnpm typecheck` | ✅ 0 错 |
| 1.5 | 契约回归 | `pnpm exec vitest run packages/contracts/src/loom.test.ts` | ✅ 7/7 |
| 1.6 | UI 夹具 | bero `xvfb-run pnpm test:loom-workspace` | ✅ pass 1 / fail 0（13.8s）<br>⚠️ **必须加 `xvfb-run`**，裸跑报 `Missing X server` 假失败 |

### L2 领域不变量

| # | 判据 | 状态 |
|---|---|---|
| 2.1 | Task 状态不含执行态 | ✅ |
| 2.2 | 候选内容列不可改 | ✅ |
| 2.3 | review / verification 挡住 UPDATE、REPLACE（含显式 rowid）、直删 | ✅ `db_loom.rs:214`、`db_loom.rs:290`（+`OR rowid=NEW.rowid`） |
| 2.4 | 空验收标准不能被接受并放行 | ✅ `loom.rs:2270` 返回 `LOOM_ACCEPTANCE_CRITERIA_EMPTY`；驳回不受影响 |
| 2.5 | 重放必须比对 mission / task / candidate，不同即拒 | ✅ `loom.rs:2146`、`loom.rs:2603` |
| 2.6 | artifact_accepted 仅在 VERIFIED + ACCEPTED + 通过评审时冻结，两种到达顺序结果一致 | ✅（空标准路径已封） |
| 2.7 | VERIFIED + REJECTED 不放行；失败核验不放行 | ✅ |
| 2.8 | reviewer / executor 身份来自 Core，payload 不可伪造 | ✅ `application.rs:9564/9574` 无条件覆盖；`loom.rs:1776/2453` `#[serde(default)]`；TS 契约已删字段<br>⚠️ 夹带身份的**测试**未写，只有代码路径 |
| 2.9 | Rust 冻结规则与 TS `loomEvaluateDependency` 逐条等价 | ✅ |
| 2.10 | 旧库 0→173 可升级 | ✅ 静态 + 链式测试 |
| 2.11 | `evidenceIds` / `note` 可空性两端一致 | ⚠️ Rust 省略→默认空，TS 必填但可 null。存储格式一致，属**接受性分歧**，未写进文档前不算通过 |

### L3 端到端（真实 Core）

| # | 判据 | 状态 |
|---|---|---|
| 3.1 | 先 `cargo build -p rovai-core --bin rovai-core` 再跑 `pnpm test:loom-core` | ✅ A1 时（A3 后须复跑） |
| 3.2 | 导入 → 认领 → 交候选 → 评审 → 核验 → 下游放行，一条链跑通 | ⏳ P6 未动 |
| 3.3 | UI 按钮经真实 Core 写入并刷新 | ⏳ |
| 3.4 | payload 夹带 `reviewerId` / `executorId` 落库仍为可信身份 | ⏳ P5a 后新增，未验 |
| 3.5 | 临时目录外无写入、不碰日常 userData | ⏳ |

### L4 可见验收（UI）

| # | 判据 | 状态 |
|---|---|---|
| 4.1 | 仍是 Rovai 外壳，无新导航 / 页面 | ✅ |
| 4.2 | 编排：3 边、≥2 泳道、3 图例、无横溢 | ✅ 夹具 |
| 4.3 | 交付：核验 / 验收两个独立徽章 | ✅ 夹具 |
| 4.4 | 交付有接受 / 驳回 / 核验按钮 | ✅ 夹具断言 4 个按钮 + 文案 `['接受','驳回','通过核验','核验失败']`，初始无展开表单 |
| 4.5 | 按钮点击真的发出 RPC 且状态刷新 | ⛔ **没有任何测试点过按钮**；夹具无 `loom.review.record` / `loom.verification.record` 回包 |
| 4.6 | 1440 / 1040 截图无溢出、无截断 | ✅ 14 张（昼夜 × 两档） |
| 4.7 | 390px 截图无溢出、无截断 | ⛔ `@media(max-width:420px)` 规则已写，**从未被截图验证** |
| 4.8 | 用户手机走查确认「不毛胚」 | ⏳ P7 |

## 三、终判条件

全部满足才可宣布阶段二完成：

1. L1–L4 全 ✅，1.2 只剩基线 3 个环境失败且**在 HEAD 上复跑过**；
2. Astra 对最终提交（`112a4f0`）给出 **PASS**（当前只对 `b746d37` 判过 BLOCK）；
3. 真实 Core 上：领取 → 交候选 → 人工逐条验收 + 核验 → 下游 `artifact_accepted` 边自动放行；
   旧评审不能放行新候选；评审与核验写入后不可改；身份夹带被忽略；
4. UI 按钮在真实 Core 上真点过，写入后状态刷新正确；
5. 用户本人手机走查通过。

## 四、签字

| 角色 | 结论 | 日期 |
|---|---|---|
| Astra 终审（`d66f4cd`） | BLOCK：1×P1 + 3×P2 | 2026-10-28 |
| Astra 复审（`b746d37`） | BLOCK：仅 `loom.ts:309` 重复声明 | 2026-10-28 |
| — 该项修复 | 已在 `6525a23` 删除，**Astra 未复审** | 2026-10-28 |
| 主管 | 不予验收，暂停并交接 | 2026-10-28 |
| 用户 | 待走查 | — |
