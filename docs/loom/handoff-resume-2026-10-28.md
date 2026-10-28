# LOOM 交接书（暂停点，2026-10-28 深夜）

> ⚠️ **唯一入口是 `MASTER-HANDOFF-2026-10-28.md`**。本文是它的前身，保留作为**逐行 diff 与「缺什么」的详细展开**；
> 两份冲突时以 MASTER 为准。

> 本文是**暂停交接**：本轮做到哪、diff 是什么、还缺什么、距离收工差几步。
> 阅读顺序：本文 → `docs/loom/acceptance-2026-10-28.md`（怎么算完）→ `docs/loom/progress-2026-10-28.md`（进度）→ `docs/loom/handoff-next-2026-10-28.md`（原计划）。

## 一、一句话状态

`d66f4cd` 被 Astra 终审 BLOCK 的五项**已全部修完并在 bero 实测绿**；P5b（交付 tab 操作按钮）已落地并通过 Electron 夹具。
**但 Astra 还没对最终提交复审**，P6（真实 Core 全链路）、P7（手机走查）没动，全量回归没在最终提交上复跑。
**当前判定仍是：不予验收。**

- 仓库：`zhizhishu/loom-ai`，分支 `main`，HEAD = `112a4f0`，工作区干净（已 push）
- 本机：`C:/Users/echo/Downloads/claude/skill-cli/loom`
- bero：`/root/sandbox/projects/loom`

## 二、本轮四个提交

| 提交 | 内容 |
|---|---|
| `62f9555` | P4-fix：修 Astra BLOCK 五项（空标准、rowid、重放目标、矩阵、测试） |
| `b746d37` | P5a：身份由 Core 注入，客户端不再传 reviewerId / executorId |
| `6525a23` | P5b：交付 tab 上按钮（接受/驳回/核验）+ 逐条标准表单 + 夹具与 mock |
| `112a4f0` | 三份文档（progress / handoff-next / acceptance） |

`git diff --stat d66f4cd..HEAD`：

```
 apps/desktop/src/renderer/src/LoomWorkspace.tsx  | 177 +++++++++++++-
 apps/desktop/src/renderer/src/loom-workspace.css |  22 ++
 crates/rovai-core/src/application.rs             |  10 +-
 crates/rovai-core/src/db.rs                      |   4 +-
 crates/rovai-core/src/db_loom.rs                 |   2 +
 crates/rovai-core/src/loom.rs                    | 291 +++++++++++++++++++
 docs/loom/acceptance-2026-10-28.md               |  72 ++++++
 docs/loom/handoff-next-2026-10-28.md             |  67 ++++++
 docs/loom/progress-2026-10-28.md                 |  71 ++++++
 packages/contracts/src/loom.ts                   |  29 +--
 scripts/fixtures/loom-workspace/main.cjs         |  11 +-
 scripts/fixtures/loom-workspace/renderer.tsx     |   9 +-
 12 files changed, 727 insertions(+), 38 deletions(-)
```

## 三、真实 diff（生产代码，测试部分略，见 `loom.rs` 尾部 224 行新增测试）

### 3.1 `crates/rovai-core/src/db_loom.rs` — P2 rowid 绕过

```diff
@@ -211,6 +211,7 @@ fn review_sql() -> String {
                 WHERE review_id=NEW.review_id
                    OR candidate_id=NEW.candidate_id
                    OR command_id=NEW.command_id
+                   OR rowid=NEW.rowid
             )
             BEGIN SELECT RAISE(ABORT, 'a recorded LOOM review is immutable'); END;
@@ -286,6 +287,7 @@ fn verification_sql() -> String {
                 WHERE verification_id=NEW.verification_id
                    OR candidate_id=NEW.candidate_id
                    OR command_id=NEW.command_id
+                   OR rowid=NEW.rowid
             )
             BEGIN SELECT RAISE(ABORT, 'a recorded LOOM verification is immutable'); END;
```

理由：`TEXT PRIMARY KEY` 不等于 rowid。显式 `INSERT OR REPLACE ... (rowid, ...)` 命中同一 rowid 时，原触发器三条业务键都不冲突，替换就过了。

### 3.2 `crates/rovai-core/src/db.rs` — P2 extended 矩阵

```diff
@@ -43185,7 +43185,7 @@ mod tests {
-        let current = migration_state_through(221);
+        let current = migration_state_through(223);
@@ -43944,7 +43944,7 @@ mod tests {
-        assert_eq!(state, migration_state_through(221));
+        assert_eq!(state, migration_state_through(223));
```

### 3.3 `crates/rovai-core/src/loom.rs` — 三个新错误码

```diff
@@ -493,6 +493,9 @@
 const LOOM_VERIFICATION_EXISTS: &str = "LOOM_VERIFICATION_EXISTS";
+const LOOM_REVIEW_REPLAY_CONFLICT: &str = "LOOM_REVIEW_REPLAY_CONFLICT";
+const LOOM_VERIFICATION_REPLAY_CONFLICT: &str = "LOOM_VERIFICATION_REPLAY_CONFLICT";
+const LOOM_ACCEPTANCE_CRITERIA_EMPTY: &str = "LOOM_ACCEPTANCE_CRITERIA_EMPTY";
```

### 3.4 `loom.rs` — P1 空验收标准不得被接受

```diff
@@ -2231,7 +2264,18 @@ pub fn review_record(
     let snapshot = criteria_snapshot(&acceptance_criteria_json, &candidate_version, "task")?;
+    if snapshot.criteria.is_empty() && verdict == LoomReviewVerdict::Accepted {
+        return Err(LoomCommandError::rejection(
+            LOOM_ACCEPTANCE_CRITERIA_EMPTY,
+            format!(
+                "candidate {candidate_id} has no acceptance criteria; an accepted review requires at least one criterion"
+            ),
+        )
+        .into());
+    }
     let mut expected: Vec<&str> = snapshot
```

理由：空标准下 `[].all()` 恒真，Rust 会放行；TS `loom.ts` 的 `loomReviewSatisfiesCriteria` 对空标准直接 `return false`。两端必须同结论。**驳回不受影响**（不需要"全部满足"）。

### 3.5 `loom.rs` — P2 评审重放必须比对目标

```diff
@@ -2121,6 +2127,33 @@ pub fn review_record(
         )?;
+        // A replayed submission must target the same mission, task, and candidate.
+        let replay_task_id: String = transaction.query_row(
+            "SELECT task_id FROM loom_review WHERE review_id=?1",
+            [&review_id], |row| row.get(0),
+        )?;
+        let original_mission: Option<String> = transaction
+            .query_row(
+                "SELECT mission_id FROM loom_plan WHERE plan_id=?1",
+                [&plan_id], |row| row.get::<_, String>(0),
+            )
+            .optional()?;
+        if original_mission.as_deref() != Some(mission_id.as_str())
+            || replay_task_id != task_id
+            || review.candidate_id != candidate_id
+        {
+            return Err(LoomCommandError::rejection(
+                LOOM_REVIEW_REPLAY_CONFLICT,
+                format!("command {command_id} was recorded for a different mission/task/candidate"),
+            ).into());
+        }
```

### 3.6 `loom.rs` — P2 核验重放必须比对目标（同构）

```diff
@@ -2540,6 +2586,31 @@ pub fn verification_record(
+        let replay_task_id: String = transaction.query_row(
+            "SELECT task_id FROM loom_verification WHERE verification_id=?1",
+            [&verification_id], |row| row.get(0),
+        )?;
+        let original_mission: Option<String> = transaction
+            .query_row(
+                "SELECT mission_id FROM loom_plan WHERE plan_id=?1",
+                [&plan_id], |row| row.get::<_, String>(0),
+            ).optional()?;
+        if original_mission.as_deref() != Some(mission_id.as_str())
+            || replay_task_id != task_id
+            || verification.candidate_id != candidate_id
+        {
+            return Err(LoomCommandError::rejection(
+                LOOM_VERIFICATION_REPLAY_CONFLICT,
+                format!("command {command_id} was recorded for a different mission/task/candidate"),
+            ).into());
+        }
```

### 3.7 `loom.rs` — P5a 两个入参的身份字段改为可省略

```diff
@@ -1768,6 +1771,9 @@ pub struct LoomReviewRecordInput {
     pub criteria_results: Vec<LoomAcceptanceCriterionResult>,
+    /// Injected by the Host from the trusted identity; clients must not send this field.
+    /// The dispatch layer overwrites whatever the payload carries with CURRENT_USER_ID.
+    #[serde(default)]
     pub reviewer_id: String,
@@ -2405,6 +2449,8 @@ pub struct LoomVerificationRecordInput {
     pub method: String,
+    /// Injected by the Host from the trusted identity; clients must not send this field.
+    #[serde(default)]
     pub executor_id: String,
```

### 3.8 `crates/rovai-core/src/application.rs` — P5a 无条件覆盖身份

```diff
             "loom.verification.record" => {
-                let input: rovai_core::loom::LoomVerificationRecordInput =
+                let mut input: rovai_core::loom::LoomVerificationRecordInput =
                     serde_json::from_value(request.params.clone())?;
+                // The executor identity is always injected from the trusted Host, never
+                // trusted from the payload.
+                input.executor_id = CURRENT_USER_ID.to_string();
                 let mut database = self.database.lock().await;
             "loom.review.record" => {
-                let input: rovai_core::loom::LoomReviewRecordInput =
+                let mut input: rovai_core::loom::LoomReviewRecordInput =
                     serde_json::from_value(request.params.clone())?;
+                // The reviewer identity is always injected from the trusted Host, never
+                // trusted from the payload.
+                input.reviewer_id = CURRENT_USER_ID.to_string();
```

### 3.9 `packages/contracts/src/loom.ts` — 删掉客户端身份字段，并删掉重复声明

```diff
@@ -255,7 +255,8 @@ export interface LoomVerificationRecordInput {
   method: string
-  executorId: string
+  // executorId is injected by Core from the trusted Host identity.
+  // Clients must not send this field; any value is overwritten.
@@ -285,7 +286,8 @@ export interface LoomReviewRecordInput {
   criteriaResults: LoomAcceptanceCriterionResult[]
-  reviewerId: string
+  // reviewerId is injected by Core from the trusted Host identity.
+  // Clients must not send this field; any value is overwritten.
@@ -303,27 +305,8 @@
-/** 验收提交入参：Owner 对一个 Candidate 的终判。 */
-export interface LoomReviewRecordInput {      // ← 第二份重复声明，TS 会合并，reviewerId 又被要求必填
-  ...
-  reviewerId: string
-}
+// (second LoomReviewRecordInput declaration removed — merged with the canonical one above;
+//  reviewerId is injected by Core, not sent by clients.)
```

> ⚠️ 这个重复声明是 Astra 第二轮 BLOCK 的唯一原因。`loom.ts` 里 `LoomReviewRecordInput` 原本**声明了两次**，TS 接口合并后 `reviewerId` 仍然必填。删掉第二份才真的删掉这个字段。教训：改 TS 契约要 `grep 'interface X'` 确认只有一份。

### 3.10 `LoomWorkspace.tsx` — P5b 按钮（摘要，完整见提交 `6525a23`）

新增/改动要点：
- `import type { ... LoomVerification }`；新 state `verifications`
- `DeliveryReview` 签名扩为 `{ candidates, reviews, verifications, plan, missionId, onRefresh }`
- 新增 `DeliveryDraft`：`{ candidateId, verdict, reason, satisfied: readonly string[] }`，勾选按 `criterionId` 记，不依赖下标
- `recordReview()`：调 `loom.review.record`，入参含 `commandId: crypto.randomUUID()`、`acceptanceCriteriaVersion`、`criteriaResults`，**不含 reviewerId**
- `recordVerification()`：调 `loom.verification.record`，入参含 `method: 'manual'`、`result`，**不含 executorId**
- 卡片按钮：`reviewable = review === undefined` → 接受/驳回；`verifiable = verificationStatus === 'unverified'` → 通过核验/核验失败
- 逐条标准表单 `.loom-review-form`：`canSubmit` 要求 reason 非空，且 accepted 时所有 criterionId 全勾
- `reload()` 用 `useCallback` 重读 6 个投影，作为 `onRefresh` 传入
- 核验记录用独立 class `.loom-candidate-verification`，不污染 `.loom-candidate-review` 的条数断言

```ts
// 接受必须逐条全勾；驳回只要求写明理由。reviewerId 由 Core 从可信身份注入，客户端不发。
const canSubmit = draft !== null && draft.reason.trim() !== ''
  && (draft.verdict === 'rejected' || criteria.every(c => draft.satisfied.includes(c.criterionId)))
```

### 3.11 `loom-workspace.css` — 22 行，全走主题 token

```css
.loom-delivery-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 10px; }
.loom-delivery-actions button { padding: 5px 10px; border: 1px solid var(--line); border-radius: 6px; ... }
.loom-delivery-actions button:focus-visible { outline: 2px solid var(--focus); outline-offset: 1px; }
.loom-delivery-actions .loom-btn-accept { border-color: color-mix(in srgb, var(--success) 38%, var(--line)); ... }
.loom-delivery-actions .loom-btn-reject { ... var(--danger) ... }
.loom-delivery-actions .loom-btn-verify { ... var(--info) ... }
.loom-review-form { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--line); }
@media(max-width:420px) { .loom-candidate-header { flex-direction: column; align-items: flex-start; gap: 6px; } }
```

无硬编码颜色、无动画、有 focus-visible。

### 3.12 夹具 — 断言从"没有控件"翻成"有这 4 个控件"

```diff
-    controls: [...document.querySelectorAll('.loom-delivery-context button')].map(b => b.innerText),
+    controls: document.querySelectorAll('.loom-delivery-actions button').length,
+    actionLabels: [...document.querySelectorAll('.loom-delivery-actions button')].map(b => b.innerText),
+    reviewForm: document.querySelector('.loom-review-form') === null,
-  assert.deepEqual(review.controls, [], 'Delivery section offered acceptance controls without a write path')
+  assert.ok(review.controls >= 2, 'Delivery section must offer acceptance and verification actions')
+  assert.deepEqual(review.actionLabels, ['接受', '驳回', '通过核验', '核验失败'])
+  assert.equal(review.reviewForm, true, 'Delivery section expanded the review form before any user intent')
```

`renderer.tsx` 补 `LoomVerification` mock（candidate-1 已核验）+ `'loom.verifications.list'` 回包。

## 四、实测证据（主管亲跑，非工兵自报）

| 项 | 命令 | 结果 |
|---|---|---|
| LOOM 子集 | bero `cargo test -p rovai-core --lib loom` | **51 passed / 0 failed**（9.8s） |
| 全量 lib | bero `cargo test -p rovai-core --lib` | **483 passed / 3 failed / 1 ignored**（300s） |
| TS 类型 | `pnpm typecheck` | 0 错 |
| 契约回归 | `pnpm exec vitest run packages/contracts/src/loom.test.ts` | 7/7 |
| UI 夹具 | bero `xvfb-run pnpm test:loom-workspace` | **pass 1 / fail 0**（13.8s），14 张截图 |

3 个失败仍是基线 `database_admission` 的 `IdentityChanged{stage:Revalidation}`，与本轮改动无关。

> ⚠️ **bero 上跑 UI 夹具必须加 `xvfb-run`**。裸 `pnpm test:loom-workspace` 会报 `Missing X server or $DISPLAY` 然后 `null !== 0` 假失败。这一条原交接书里没写，本轮踩了一次。

## 五、还缺什么（按优先级）

### ✅ 已补：截图证据曾经整片造假（`c7b8eae` 修）

`scripts/fixtures/loom-workspace/main.cjs` 原本写 `show: process.platform === 'linux'`。
Windows 上窗口是隐藏的，Electron **不为隐藏窗口产出合成帧**，`capturePage()` 会返回**上一帧**——
于是 14 张 PNG 整体错位一格：标 `delivery` 的拍的是编排，标 `plan` 的拍的是活动。
**DOM 断言读实时 DOM 所以一直是对的，只有 PNG 撒谎。**

修法三条：`show: true`、截图前先丢一帧（`await capturePage(); settle(120); writeFileSync(capturePage())`）、
截图前把 `.loom-delivery` / `.mission-activity-document` 滚回顶部（否则留下滚动测试的 180px 位置，标题被切）。

**教训**：任何"我看了截图"的结论，先确认截图里的内容与文件名对得上。上一轮 B2/B3 的视觉结论都建立在可能错位的图上。
另外顺手补了 390×844 移动端（P7 的截图半边，此前**从没截过**），并把 `候选 candidate-1` 被切成 `候选 date-1`、
`核验结论 · manual` 漏英文两个观感问题修掉。

### ⛔ 缺 1：Astra 对最终提交的复审

Astra 第二轮复审（session `8414f0e059aa400995d630b388c7be89`）判 **BLOCK**，唯一理由就是 `loom.ts:309` 那份重复声明。
**那份声明是在复审之后才删的**（提交 `6525a23`）。所以 Astra 还没看过修好的版本。

- 其他四项 Astra 已明确 PASS（空标准 `loom.rs:2270`、rowid `db_loom.rs:214/290`、重放 `loom.rs:2146/2603`、矩阵 `db.rs:43188/43947`）
- 下一步：派 Astra 只审这一处（一份重复声明是否真的消失、字段是否真的不必填），≤300 字

### ⛔ 缺 2：全量回归没在最终提交上复跑

483/3 那次跑的是 `62f9555`（P4-fix）。`b746d37`、`6525a23`、`112a4f0` 之后没再跑全量。
LOOM 子集和 typecheck 跑过了，但按验收书 1.2 必须在 **HEAD** 上跑一次。

### ⛔ 缺 3：P6 真实 Core 全链路

完全没动。要验的是：导入 → 认领 → 交候选 → 评审 → 核验 → 下游 `artifact_accepted` 边自动放行。
- 必须先 `cargo build -p rovai-core --bin rovai-core`（**不能用 `pnpm core:build:debug`**，linux-x64 不支持，会让旧二进制假绿）
- 现在还多一条要验：**身份注入**。payload 里夹带 `reviewerId: "someone_else"` 落库必须是 `local_user`
- 断言临时目录外无写入、不碰日常 userData

### ⛔ 缺 4：P7 390px 手机走查

夹具只出了 1440/1040 两档截图。`@media(max-width:420px)` 规则写了但**从没被截图验证过**。
用户手机走查完全没做。

### ⛔ 缺 5：按钮从没被"真点过"

夹具只断言按钮存在 + 文案对。**没有一条测试点击按钮**。
而且 `renderer.tsx` 里没有 `loom.review.record` / `loom.verification.record` 的回包——
真点了会走到 `errors.push(method)` 那条路径。所以 UI 写入路径目前是**只有入口、没有闭环验证**。

### ⚠️ 缺 6：工兵提出的设计遗留

派 P5b 工兵时它主动报了三条，第一条我已修，后两条没处理：

1. ~~夹具缺 verifications 回包~~ → 已补
2. 验收标准版本从 `plan.acceptanceCriteria` 取，而非 `candidate.acceptanceCriteria`。
   计划一旦改版（plan 版本 ≠ 候选钉住版本），Core 会报 `review_criteria_mismatch`。
   **正常情况两者相同，但改版后就稳定报销。** 工兵建议改成以候选为准，我判断这是设计决定，没擅改。
3. `crypto.randomUUID()` 在 Electron renderer 的可用性未实测（理论可用，`file://` 属 secure context）。

### ⚠️ 缺 7：`evidenceIds` / `note` 可空性只做了单侧

Rust 侧 `LoomAcceptanceCriterionResult` 用 `#[serde(default)]` 允许省略，TS 侧 `evidenceIds: string[]` / `note: string | null` 要求必填（但可 null）。
**这是"Rust 更宽松、存储格式一致"的接受性分歧，没有写进验收书，也没有对齐。** 原计划第 5 条要求"定下来"，实际上只是我口头接受。

## 六、距离收工还差几步

原计划 7 步，已完成 5 步：

```
[x] 1. P4-fix        → 62f9555，bero 51/0
[x] 2. P5a           → b746d37，bero 51/0，typecheck 绿
[x] 3. schema 173 全量回归 → 483/3（但在 62f9555 上，需在 HEAD 复跑）
[x] 4. P5b           → 6525a23，xvfb-run 夹具 pass 1/0
[ ] 5. P6 真实 Core 全链路        ← 一步没动，最重
[ ] 6. P7 移动端 390px + 用户走查  ← 一步没动
[ ] 7. 收尾（TASK.md / LOG.md / control-plane.md + 清理进程）
```

加上新暴露的：

```
[ ] 8. Astra 复审最终提交（一份重复声明）
[ ] 9. 按钮真点击测试（补 mock 回包 + 断言点击后状态变更）
[ ] 10. 验收标准版本来源改以 candidate 为准（设计决定，需用户拍板）
```

**乐观估计**：缺 1、2、9 是小时级（各一轮工具调用）；缺 3 是半天到一天（要 build Core + 写端到端链 + 断言无侧写）；缺 4 的截图半天、用户走查看用户时间。

## 七、接手最容易踩的四件事

1. ** bero 上跑 UI 夹具忘加 `xvfb-run`** → 假失败 `null !== 0`，会误判成代码坏了。
2. **改 TS 契约只改一处** → `loom.ts` 里 `LoomReviewRecordInput` 曾声明两次，TS 静默合并。改完必须 `grep -n 'export interface <Name>'`。
3. **把工兵 `ok:true` 当验收** → 本轮 7 次工兵交付里，4 次有编译错或全红套件，都是主管在 bero 上复跑才发现的。
4. **拿旧 Core 二进制跑新测试** → `pnpm core:build:debug` 在 linux-x64 上不产出新二进制，测试会"绿得莫名其妙"。必须 `cargo build -p rovai-core --bin rovai-core`。

## 八、遗留进程（归属已确认，可清）

- 本机 DSH job `bash-58`：`pnpm exec vite --config scripts/fixtures/loom-workspace/full-app.config.mjs`，仍在跑，是本会话早前起的全 App 预览。
- bero 上 `/tmp/loom-vite.pid`、`/tmp/loom-web.pid` 记录的进程（如果还活着）。

清理属于 §9 高风险动作，需逐次确认后再动。归属不明的进程一律不动。

## 九、证据位置

- Astra 第二轮复审原文：`~/.pi-skill/projects/c-users-echo-downloads-claude-skill-cli-loom/runs/8414f0e059aa400995d630b388c7be89/`
- Astra 第一轮（BLOCK 五项来源）：`.../runs/1c9c84cd30304d37a969de3de75e9eb8/`
- P5b 工兵交付原文：`.../runs/d1cabdc83bcc4733ac91bfa4d76e1c33/`
- 派工任务原文：`skill-cli/_artifacts/tmp/`（`astra-p4fix-audit.md`、`worker-p5b.md`）
- 截图：bero `/tmp/rovai-loom-workspace-test-*/screenshots/`（14 张，1440/1040 两档 × 昼夜）
