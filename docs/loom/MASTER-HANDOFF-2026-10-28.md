# LOOM 主交接书（2026-10-28，给下一位接手 Agent）

> **这份是唯一入口。** 其余 `docs/loom/*.md` 是历史与原始计划，冲突时以本文为准。
> 本文所有数字都是主管在 bero / 本机亲跑出来的，不是工兵自报。跑不出来的不要信。

---

## 0. 三十秒版

LOOM 是 **Rovai AI 的产品分支**（`murray17/rovai-ai`，MIT 快照 `4ea9cac` 为底座），在 Rovai 之上补 ACCP 式的
**编排 / 证据 / 验收** 能力，并在 Mission 详情里加「编排」「交付」两个 tab 与一张 archify 流程图。

- 仓库 `zhizhishu/loom-ai`（公开，属主自有），分支 `main`，HEAD = `edb0624`，工作区干净、已推送
- 本机 `C:/Users/echo/Downloads/claude/skill-cli/loom`；远程 Linux 盒子 bero `/root/sandbox/projects/loom`
- **本机 Windows 编不了 Rust**，所有 cargo 构建与测试必须在 bero 上跑
- 阶段一（契约 + 三表投影 + 只读 RPC + 导入写路径 + 端到端 + UI 8 场景）**已关闭**
- 阶段二已落地：认领 fence、候选提交、人工验收、证据核验、依赖冻结放行、UI 读写按钮
- **当前判定：不予验收**。卡在五件事上，见 §7

---

## 1. 硬边界（越了就是错）

1. 上游 `murray17/rovai-ai` **只读**：不提 PR、不提 Issue、不开分支、不 push。
2. UI 只改 Mission 下「编排 / 交付」两个 tab。**不新开页面、不加导航、不换视觉世界**。
3. 所有 cargo 构建/测试在 bero 上（`export PATH="$HOME/.cargo/bin:$PATH"`）。
4. 验收进程一律**临时 userData**，禁止指向日常 Electron `userData`。
5. `skill-cli` 仓库里**禁止 `git add -A`**（会卷进 `_references/`、`_backups/` 大文件）。
6. 动冻结文件（`loom.rs` / `db_loom.rs` / `db.rs` / `loom.ts`）之前先让 Astra 审完当前切片，**审计期间不许改被审文件**。

---

## 2. 现在真能做到什么（可复现，命令 + 预期）

| 能力 | 命令 | 预期 |
|---|---|---|
| LOOM 领域测试 | bero `cargo test -p rovai-core --lib loom` | **51 passed / 0 failed**（≈10s） |
| 全量 lib（schema 173） | bero `cargo test -p rovai-core --lib` | **483 passed / 3 failed / 1 ignored**（≈300s） |
| TS 类型 | `pnpm typecheck` | 0 错 |
| 契约回归 | `pnpm exec vitest run packages/contracts/src/loom.test.ts` | 7/7 |
| UI 夹具（20 张截图） | bero `xvfb-run pnpm test:loom-workspace`；本机 `ROVAI_KEEP_LOOM_WORKSPACE_FIXTURE=1 pnpm test:loom-workspace` | pass 1 / fail 0 |
| 完整 App 实时预览 | `http://127.0.0.1:54093`（`scripts/fixtures/loom-workspace/full-app.config.mjs`） | 可点 tab、**按钮真会改状态**（内存态） |

那 3 个失败是**基线环境失败**（`database_admission` 的 `IdentityChanged{stage:Revalidation}`），与 LOOM 无关，在 `33f6ded` 上同样复现。**不许"修掉"它们充绿。**

---

## 3. 现在做不到什么（诚实清单，别当 bug 也别当完成）

1. **`artifact_accepted` 边在"只有评审、没有核验"时故意不放行。** 这是设计：TS 求值器要求「已核验 + 已验收 + 评审满足全部标准」，Rust 跟着等核验，避免存储说放行、线协议说阻塞。
2. **证据是"声称"而非"可核验"。** `evidenceIds` 只是字符串数组，没有产物实体、不校验存在性、没有 hash 对账。这是整套里最需要补的诚实性缺口（见 §5-1）。
3. **认领状态对用户不可见。** TS 侧 `LoomClaim` 类型**零消费**，也没有 `loom.claims.list`。谁能看到"谁占着任务、租约何时到期"？没人。
4. **没有任何事件推送。** grep 证实 `loom` 不进 event / notification 通道。两个 tab 只在进入时读一次 + 写操作后自己 reload；别人在别处改了，这边不知道。
5. **单用户假设。** `CURRENT_USER_ID` 是单值；多用户/多人并行验收没做。
6. **按钮从未被点击测试覆盖。** 夹具只断言「有 4 个按钮 + 文案对 + 初始无表单」，`renderer.tsx` 里也没有 `loom.review.record` / `loom.verification.record` 回包（`loom-workspace` 那套）。写入路径是**只有门、没验门后通不通**。
7. **全量回归没在 HEAD 上跑过。** 483/3 那次跑在 `62f9555`。
8. **P6 真实 Core 全链路一步没动。** 身份夹带验证（payload 塞 `reviewerId: "someone_else"`，落库必须是 `local_user`）也没验。
9. **手机真人走查没做。** 390 截图现在有了（20 张里 6 张），但没人真机看过。
10. **宽屏信息密度低。** 1440 下内容只占左边约 800px，右侧大留白——「毛胚感」的主要来源。

---

## 4. 架构现状（事实清点）

### 4.1 分层

```
┌ 事实源 ─────────────────────────────────────────────┐
│ SQLite 投影  7 张表  schema 173（= 迁移 223 − 50）   │
│   loom_plan / loom_task / loom_dependency           │
│   loom_claim / loom_candidate                       │
│   loom_review / loom_verification                   │
└────────────────┬────────────────────────────────────┘
                 │ 单事务写入 + 三层触发器不可变
┌ 领域层 ────────┴────────────────────────────────────┐
│ crates/rovai-core/src/loom.rs      5761 行          │
│   12 个 RPC · 32 个 LOOM_* 错误码                   │
│   db_loom.rs 1104 行（建表 + 不可变触发器）          │
└────────────────┬────────────────────────────────────┘
                 │ 身份由 Host 注入，不信任 payload
┌ 线协议 ────────┴────────────────────────────────────┐
│ packages/contracts/src/loom.ts     584 行           │
│   4 个求值器：loomLatestCandidate /                 │
│   loomReviewSatisfiesCriteria /                     │
│   loomEvaluateDependency / loomTaskReady            │
│   + DAG 校验（环 / 自依赖 / 悬空边 / 跨计划边）       │
└────────────────┬────────────────────────────────────┘
┌ 呈现层 ────────┴────────────────────────────────────┐
│ LoomWorkspace.tsx 588 行（活动 / 编排 / 交付 三 tab）│
│   LoomFlow：按依赖深度分泳道的 SVG 贝塞尔流程图       │
│   DeliveryReview：双轴徽章 + 4 个写按钮 + 逐条标准表单│
│ loom-workspace.css 154 行（全走主题 token）          │
└─────────────────────────────────────────────────────┘
```

### 4.2 12 个 RPC

| RPC | 类型 | 作用 |
|---|---|---|
| `loom.plan.import` | 写 | 导入计划（标准快照 + 任务 + 依赖） |
| `loom.plan.get` | 读 | 读计划与标准快照 |
| `loom.tasks.list` | 读 | 任务列表 |
| `loom.dependencies.list` | 读 | 依赖边（含冻结溯源） |
| `loom.task.release` | 写 | draft → ready |
| `loom.claim.acquire` | 写 | 原子认领（lease + fence 单调 + 幂等） |
| `loom.candidate.record` | 写 | 交候选（提交端 fence 校验：claimId + fenceGeneration + agentRunId）→ ready→in_review |
| `loom.candidates.list` | 读 | 候选列表 |
| `loom.review.record` | 写 | 人工验收（逐条标准 + 推进任务 + 冻结边） |
| `loom.reviews.list` | 读 | 评审列表 |
| `loom.verification.record` | 写 | 证据核验（证据轴，与验收轴独立） |
| `loom.verifications.list` | 读 | 核验列表 |

**没有** `loom.claims.list`、`loom.plan.update`、`loom.task.cancel`、`loom.dependency.add`。

### 4.3 四条核心不变量（已实现且有测试）

1. **Task.status 永不承载执行态**。执行态在 `loom_claim`（lease + fence）与 `loom_candidate`。状态机只有 `draft → ready → in_review → done/ready`。
2. **候选内容不可变**：`content_hash`、`evidence_ids_json`、`acceptance_criteria_version` 等被 BEFORE UPDATE 触发器冻结；只有判定列（verification/acceptance status）可改。
3. **评审与核验写入后不可改**：三层拦截——`UPDATE` 触发器、`INSERT OR REPLACE` 触发器（**含显式 rowid 冲突**）、直接 `DELETE` 触发器。
4. **依赖释放即冻结**：`task_done` 边在任务 DONE 时冻结；`artifact_accepted` 边**只在候选 VERIFIED + ACCEPTED + 存在 accepted 评审**时冻结——「谁后到谁放行」。冻结后带 `resolution`（时间 / 上游修订 / candidateId / reviewId），不随上游修订升级。

### 4.4 双轴设计（最容易搞错的地方）

核验（verification）与验收（acceptance）是**两条独立的人工轴**，绝不合并成一个状态：

- 核验 = 证据够不够硬（`unverified / verified / failed`）
- 验收 = 人要还是要（`pending / accepted / rejected`）
- `artifact_accepted` 边要**两轴都好**才放行
- UI 上是两个各看各状态的徽章，不是一个大状态

---

## 5. 架构还差什么（按优先级，带依据）

### 🔴 P0：证据链实体化

**现状**：`loom_candidate.evidence_ids_json` 是字符串数组，`loom_verification.evidence_ids_json` 同理。没有产物表、没有 hash 对账、不校验引用是否指向真实文件。

**后果**：所谓"证据"只能证明"某人声明了这些 ID"，不能证明"这些产物存在且没被换过"。整套验收的诚实性压在这上面，这是**最大的一处空心**。

**该做什么**：产物表（id / hash / 大小 / 来源 run）+ 写入时校验存在性 + 核验时 hash 对账。做了这条，`artifact_accepted` 才有实体支撑。

### 🔴 P1：认领状态投影 + `loom.claims.list`

**现状**：`LoomClaim` 在 TS 侧零消费；RPC 只有 `claim.acquire`，没有读。

**后果**：UI 无法显示"这个任务被谁占着、租约什么时候到期、fence 到第几代"。ACCP 要求执行态可观测，这条现在是空的。

### 🟠 P2：事件推送

**现状**：grep 证实 LOOM 不进 event / notification 通道。

**后果**：多窗口 / 多端场景下视图会陈旧；当前靠"进入 tab 读一次 + 写后 reload"糊过去。
**该做什么**：LOOM 写成功后投递一条失效事件，让两个 tab 订阅。

### 🟠 P3：Attempt（重试/返工）成档

**现状**：只有 `loom_candidate.previous_candidate_id` 单链，能看出返工顺序，但没有"这次尝试为什么失败、消耗了什么"。

**后果**：ACCP 的 Attempt 语义缺失。返工成本不可统计，无法回答"这个任务试了几次"。

### 🟡 P4：ContextSnapshot（输入冻结）

**现状**：候选只有 `content_hash` + `evidence_ids`。没有"做这件事时用的是哪一版输入"。

**后果**：无法复现、无法判定"上游改了导致这次该重做"。

### 🟡 P5：审批流未接

**现状**：Rovai 自带 Approval 概念，LOOM 完全没接。人工验收是终判，但"执行前要不要审批"这条链没打通。

### 🟡 P6：并发与多用户

**现状**：身份恒为 `CURRENT_USER_ID` 单值；`claim` 有 lease/fence 但只服务单机单用户语义。

### 🟢 P7：UI 侧未做

- 编排图**只读**：不能拖、不能加任务、不能取消、不能改依赖
- 交付**无过滤/分页**：`candidates.list` 全量返回
- 无 `plan.update`：计划改版只能重新 import（且会撞 `LOOM_PLAN_EXISTS`）
- 宽屏右侧大片留白（信息密度）

---

## 6. 优点 / 缺点

### 优点（都是可验证的，不是口号）

1. **双轴真的独立**，不是嘴上说——`verification_status` 与 `acceptance_status` 是两个列、两个徽章、两条写入路径、两组测试。
2. **不可变靠数据库触发器落地**，不靠代码自觉：UPDATE、`INSERT OR REPLACE`（**含显式 rowid 冲突**）、直接 DELETE 三层都拦。
3. **冻结有溯源**：释放那一刻的时间、上游修订、candidateId、reviewId 全记下，之后不随上游改版漂移。
4. **幂等是真幂等**：`commandId` 重放返回原记录，而且**比对 mission/task/candidate**——拿旧 commandId 换目标会被 `LOOM_*_REPLAY_CONFLICT` 拒掉。
5. **身份由 Host 注入**：`reviewer_id` / `executor_id` 在 dispatch 层被 `CURRENT_USER_ID` 无条件覆盖，payload 里塞什么都不算。
6. **错误码稳定**：32 个 `LOOM_*` 常量，不是自由文本，前端可以分支。
7. **单事务**：写评审 + 改候选验收轴 + 推进任务 + 冻结依赖边，四件事一个事务，要么全成要么全退。
8. **Rust 与 TS 求值结论对齐**，连空标准这种边界都对齐了（`[].all()` 恒真 vs `criteria.length === 0 → false`）。
9. **迁移链有链式测试 + `downgrade_for_test`**，不是"改了就完事"。
10. **UI 保持 Rovai 视觉世界**，只加两个 tab，没另起门户。
11. **夹具用真组件树 + 真样式表**，不是截图比对工具；断言读的是实时 DOM。

### 缺点 / 技术债（一条不藏）

1. **证据是裸字符串**（§5-P0，最重）。
2. **TS 契约有 3 个零消费导出**：`LoomClaim`、`LoomReviewResult`、`LoomReviewSubmission`——**看起来有，其实没人用**，下一个 agent 容易被骗。
3. **TS 契约曾有两处重复 `interface` 声明**（`LoomReviewRecordInput`、`LoomReviewRecordReceipt`）。TS 会**静默合并**，所以删了一处字段还是必填——这是 Astra 判 BLOCK 的唯一原因。现已删除，但**同类陷阱还会再犯**。
4. **截图链路曾经整片造假**（详见 §8-坑5）。已修，但结论要重建。
5. **按钮零点击测试**（§3-6）。
6. **全量回归未在 HEAD 复跑**（§3-7）。
7. **`evidenceIds` / `note` 可空性两端不一致**：Rust `#[serde(default)]` 允许省略，TS 必填但可 null。存储格式一致，属"Rust 更宽松"的**接受性分歧**，没写进验收书前不算通过。
8. **验收标准版本取自 `plan.acceptanceCriteria` 而非 `candidate.acceptanceCriteria`**：正常情况相同，**计划改版后会稳定撞 `LOOM_ACCEPTANCE_CRITERIA_VERSION_MISMATCH`**。属设计决定，需产品拍板。
9. **迁移每加一号要动 10 处**（见 §8-坑6），极脆弱。
10. **单用户单机假设**，多用户要重构。
11. **宽屏信息密度低**，视觉上仍是"未打磨完"的观感。
12. **夹具 loom 数据与真 Core 行为可能漂移**（fixture drift）：夹具里 `基准 aaaaaaaaaaaa`、按需返回，真 Core 是另一套。已有一处实证：`candidateId` 为 UUID 时 UI 标签逻辑与夹具短 ID 表现不同。

---

## 7. 距离"可验收"还差五步（严格按序）

1. **Astra 复审**（15 分钟）。第二轮 BLOCK 的唯一项是 TS 重复声明，**已在复审之后删除**，它还没看过修好的版本。只给它这一处，≤300 字，第一行 PASS/BLOCK。
2. **HEAD 上复跑全量回归**（10 分钟）。判据：只剩基线 3 个环境失败。
3. **按钮点击测试**（1–2 小时）。给 `loom-workspace` 夹具补 `loom.review.record` / `loom.verification.record` 回包，断言：点接受 → 出现逐条标准表单 → 全勾 + 填理由 → 提交 → 徽章变「已验收」、按钮消失、表单收起。
4. **P6 真实 Core 全链路**（半天到一天）。导入 → 认领 → 交候选 → 评审 → 核验 → 下游 `artifact_accepted` 边自动放行；**外加**：payload 夹带假身份落库必须仍是 `local_user`；断言临时目录外无写入。
5. **P7 用户手机走查**（半天 + 用户时间）。截图已有 6 张 390px，缺真机确认。

五步全过 + 用户点头，才能宣布阶段二完成。之后才轮到 §5 的架构补口。

---

## 8. 会咬人的坑（14 条，都是真踩过的）

1. **bero 上跑 UI 夹具必须 `xvfb-run`**。裸 `pnpm test:loom-workspace` 报 `Missing X server or $DISPLAY` → `null !== 0`，是**假失败**，别误判成代码坏了。
2. **改 TS 契约前 `grep -n 'export interface <Name>'` 确认只声明一份**。重复声明会被静默合并，删一处字段仍然必填。
3. **工兵 `ok:true` / 自报完成 ≠ 验收**。本轮 7 次工兵交付里 4 次有编译错或全红套件，全是主管在 bero 复跑才发现的。
4. **旧 Core 二进制 = 测了个寂寞**。`pnpm core:build:debug` 在 linux-x64 上**不产出新二进制**，会让测试"绿得莫名其妙"。必须 `cargo build -p rovai-core --bin rovai-core`。
5. **截图会整片撒谎**。`main.cjs` 原来写 `show: process.platform === 'linux'`——Windows 上窗口隐藏，Electron 不出合成帧，`capturePage()` 返回**上一帧**，14 张图整体错位一格（标 `delivery` 的拍的是编排）。**DOM 断言一直是对的，只有 PNG 撒谎**。已修：`show: true` + 截图前丢一帧 + 截图前滚回顶部。**任何"我看了截图"的结论，先确认图里内容与文件名对得上。**
6. **加迁移要动 10 处**：`vNNN: bool` 标志 → `admits()` 新首臂 → `EXISTS(...)` 列 + `row.get(N)?` → 常量 `CURRENT_PROJECTION_SCHEMA_VERSION` → `classify_database_contract` 白名单 → **两处** `migration_step!`（缩进 16 / 12）→ 上一步终态放宽成 `Current | SupportedMigrationSource(schema==N)` → `downgrade_for_test` → 链式测试 → db.rs 两处 extended 矩阵。**`schema = 迁移号 − 50`**。漏一处就是整条链建库全炸或测试假绿。
7. **审计期间不许改被审文件**。改了 Astra 会 STUCK 或审到旧内容。
8. **一次只给 Astra 一个切片**，≤1200 字。它贵、慢（单次 3–60 分钟）、只读。
9. **`skill-cli` 仓库禁止 `git add -A`**（`_references/`、`_backups/` 会被卷进去）。
10. **1440 下编排可用宽度约 804px**：`列数 × min-width + (列数−1) × gap ≤ 804`，超了就横溢。
11. **截图里方块字是缺 CJK 字体**（bero 已装 `fonts-noto-cjk`），不是 CSS 问题。
12. **夹具有两套**：`scripts/fixtures/loom-workspace`（LOOM 专项验收）与 `scripts/fixtures/mission-board`（完整 App 外壳 / 实时预览）。改错那个等于白改。
13. **验收进程一律临时 userData**，禁止指向日常 Electron `userData`。
14. **上游只读**：不提 PR / Issue / 分支。

---

## 9. 分工建议（上一轮验证过的模式）

| 角色 | 模型 | 该做什么 | 绝不该做 |
|---|---|---|---|
| 主管（主线程） | 当前会话模型 | 契约、迁移、白名单、bero 编译测试、合并、验收、独立复跑 | 把工兵自报当验收 |
| Astra | `oct-response/gpt-6-astra` | 计划与终审，**只读** | 写码、派工 |
| Pi 工兵 | `oct-chat/deepseek-v4.1-flash` | 1–3 个文件的有界实现，交 diff | 碰契约、碰迁移链、嵌套派工 |

派工四判据全 ✅ 才派：客观可判 / 做法已定 / 无需预测涟漪 / 失败便宜。
**怎么修、要不要改架构、安不安全，永不外包。**

---

## 10. 证据与文件位置

- **主交接书**（本文）：`docs/loom/handoff-resume-2026-10-28.md` 的前身已并入这里
- 详细历史（好与不好如实写、认知陷阱）：`docs/loom/handoff-2026-10-28.md`（294 行）
- 原始计划与坑清单：`docs/loom/handoff-next-2026-10-28.md`
- 验收书（L1–L4 逐项 + 当前判定）：`docs/loom/acceptance-2026-10-28.md`
- 进度报告：`docs/loom/progress-2026-10-28.md`
- 控制面进度表：`docs/loom/control-plane.md`
- 截图（20 张，1440 / 1040 / 390 × 昼夜 + 2 张 200%）：`skill-cli/_artifacts/loom-ui-review-2026-10-28/`
- Astra 第一轮 BLOCK 原文：`~/.pi-skill/projects/c-users-echo-downloads-claude-skill-cli-loom/runs/1c9c84cd30304d37a969de3de75e9eb8/`
- Astra 第二轮 BLOCK 原文：`.../runs/8414f0e059aa400995d630b388c7be89/`
- 派工任务原文：`skill-cli/_artifacts/tmp/`
- 项目看板：`skill-cli/TASK.md`；里程碑：`skill-cli/LOG.md`

---

## 11. 遗留进程（归属已确认）

- 本机 DSH job `bash-58`：`http://127.0.0.1:54093`（完整 App 实时预览），**正用于人工走查，先留着**。
- bero 上 `/tmp/loom-vite.pid`（54092）、`/tmp/loom-web.pid`（54093）记录的进程，如仍存活可清。

清理属高风险动作，**逐次确认后再动**；归属不明的一律不动。
