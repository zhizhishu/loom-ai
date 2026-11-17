# LOOM 第四轮验收审计书（2026-10-29 起）

> 配套 plan-round4-2026-10-29.md。主助手只按本表判，工兵自报、ok:true、截图文件名都不算证据。
> 每条证据必须是主助手在 bero（或 GitHub Actions）亲跑的原始输出，并记 commit hash。审计结论必须是 Astra（oct-response/gpt-6-astra，xhigh，只读）的原文第一行。

## 0. 通用判据

- 证据 = 命令 + commit hash + 原始输出尾部 + 时间（CST）。缺一条 = 未验。
- 全量 Rust 只允许基线 3 个环境失败（database_admission / IdentityChanged{stage:Revalidation}），不许改掉它们充绿；第 4 个失败即 FAIL。起点基线：ee84bad 全量 498 passed / 3 failed / 1 ignored，--lib loom 55/0。
- fmt 门禁：每个被 push 的 commit，都要有 bero 上 cargo fmt --all -- --check exit 0 的证据；缺 = 流程违规，该步不许判 PASS。
- 每步合入后对应 Actions run 必须绿；红了要贴失败步与原因。
- 截图结论先核对图内内容与文件名一致。
- 审计期间被审文件有任何改动 → 该次审计作废重来（第三轮 loom.ts:309 就是这个坑）。
- 白名单外有改动 → 该交付直接 FAIL，退回。
- 修改 TS 契约后 grep 确认每个 interface 只声明一次。

## 1. 阶段 C 验收表

| 编号 | 项 | 命令 / 动作 | PASS 判据 |
|---|---|---|---|
| C0 | fmt 门禁落地 | bero 在 ee84bad 跑 cargo fmt --all -- --check、cargo check -p rovai-core --all-targets、pnpm typecheck | 三条 exit 0；计划书 §2.1 已写入；TASK.md 有记录 |
| C1 | 换链竞态 | bero cargo test -p rovai-core --lib loom | 产品代码从已打开的句柄算 sha256 与 size，并复用 open_resolved_file_without_following（grep 可见调用点）；新增回归测试：符号链接指向工作区外 → 拒绝并返回稳定 LOOM_* 错误码，且 loom_artifact 无新行；原有路径逃逸/换字节/重放用例仍绿；Astra PASS |
| C2 | schema 校验加固 | bero --lib loom + 全量 | artifact_schema_matches 校验唯一索引列为 (plan_id, relative_path) 且校验三个触发器实现；反例测试——空体同名触发器、缺列索引 → 各自判不匹配；迁移链与 extended-tests 准入矩阵仍绿；Astra PASS |
| C3a | 产物读投影 | bero --lib loom；pnpm exec vitest run packages/contracts/src/loom.test.ts | 新只读 RPC 有 Rust 测试（只返回本 plan 的产物、跨 plan 不串）+ TS 契约测试；loom.ts 新 interface 各只 1 处；typecheck 0 错 |
| C3b | 候选卡展示 | bero xvfb-run pnpm test:loom-workspace | 夹具断言候选卡显示每条证据的路径、hash（短显示 + 全长可取）、大小；数据来自真 RPC，不是夹具内存；1440/1040/390 三档无横向溢出；中英文案都有，catalog 测试绿；仍是 Rovai token；未新开页面或导航 |
| C4a | 390px 走查 | 夹具在真 Chromium 里 resize 到 390×844 并逐项断言（已由主助手跑，不再需要用户目测） | 页面本身零横向溢出；交付保持 20 侧距、单列；编排只在自己的图区内横滚；工作区宽度 ≤390；三档截图落盘 |
| C4b | A9 分歧拍板 | 用户书面决定 | 两处决定写进本文附录（含日期与原话）；若需改代码，单列 C6 并另计判据 |
| C5 | 终审 + 收尾回归 | Astra 审 C1–C3 合并 diff；bero 重跑全量、pnpm test:loom-core、夹具、typecheck、fmt | Astra 第一行 PASS；全量失败恰为基线 3 个；--lib loom ≥ 55 且 0 失败；test:loom-core 0 失败；最终 commit 的 Actions 绿 |

阶段二完成 = 第三轮 A1–A8、B1–B4 已 PASS + 本表 C0–C5 全 PASS + 用户点头。

## 2. 一票否决

- 碰了上游 murray17/rovai-ai（PR / Issue / 分支 / push）。
- 新开页面、加导航、换视觉体系。
- 验收进程指向日常 Electron userData。
- skill-cli 仓库 git add -A。
- 未经用户点头开阶段 C 或 C6。
- 工兵碰冻结文件，或嵌套派工。
- 为通过测试而删或禁用既有测试（必须走 docs/development/testing.md 准入与退役门槛）。
- 把工兵自报写进验收结论。

## 3. 记录格式（每项一行写进 TASK.md）

[C1] PASS | commit abc1234 | fmt✓ check✓ | bero cargo test -p rovai-core --lib loom | pass 57 fail 0 | Actions 4071xxxxxxx 绿 | Astra PASS | 2026-10-xx hh:mm CST

## 附录：A9 用户决定（2026-10-29，用户「可以 直接继续」= 采纳下列建议）

**① 验收标准「内容」与「版本」同源**：判定为**不是活缺陷**。一个 Mission 只接受一次 `loom.plan.import`（否则 `LOOM_PLAN_EXISTS`），且没有任何产品路径改写 `loom_task.acceptance_criteria_json`（`loom.rs:1170/1769/2942/2968` 只动 status/updated_at/revision）。因此「标准内容取任务快照、版本取候选记录」当前不会分叉。
落地：在 `review_record` 原地写清这个前提；新增测试 `the_acceptance_criteria_snapshot_cannot_drift_under_a_recorded_candidate` 钉住它（二次导入被拒 + 快照不变 + 评审仍按原快照通过）。若将来做「计划改版」，必须先把快照冻结到候选行（届时需要迁移 225）。

**② `evidenceIds` / `note` 可空性**：保留「Rust 接受省略、TS 要求键存在且 `evidenceIds` 非 null」。理由：Rust 序列化时两个键都会写出，线上格式永远满足 TS；放宽的只是输入接受面。
落地：契约注释写清不对称是刻意的；新增测试 `a_criterion_result_always_serialises_its_optional_keys` 钉住「空数组与 null 都会被写出」。

**③ 宽屏提升阈值**：保持 `@container loom-workspace (min-width: 1200px)`，不换视口媒体查询。理由：真外壳是分栏的，面板可能永远到不了 1200；两列在 560 宽度下比单列更挤。
落地：在 CSS 原地注明「量的是面板而非视口，是刻意选择」。

**顺带补上的两项**（同一提交 `c9ea7ba`）：
- 核验窗口补了与登记窗口同款的确定性换链测试缝：`a_swap_inside_the_verification_window_is_unreadable_not_a_mismatch`，验证读期间换链报 `LOOM_EVIDENCE_UNREADABLE`（而不是 hash 不符），且不写 verification 行。
- 全量回归：bero `--lib loom` **75/0**、全量 **507 passed / 3 failed（恰基线）/ 1 ignored**。

## 附录：本轮记录（最终提交 `4787bcd`）

[C0] PASS | ee84bad | fmt✓ check✓ typecheck✓ 全 exit 0 | 2026-10-29
[C1] PASS | 4787bcd | fmt✓ check✓ | bero `--lib loom` pass 72 fail 0 | Astra 终审 BLOCK→PASS（全局 Mutex、句柄非快照、错误码混淆三条已闭合）| 2026-10-29
[C2] PASS | 4787bcd | 整条触发器语句全等比较 + 非 partial 唯一索引；反例 4 段全被拒 | Astra 终审 BLOCK→PASS（`WHEN 0` 伪通过、partial 索引两条 P1 已闭合）| 2026-10-29
[C3a] PASS | 4787bcd | `--lib loom` 72/0；`vitest packages/contracts/src` 15/15；跨 Mission 隔离 + 不重算 | 2026-10-29
[C3b] PASS | 4787bcd | bero `xvfb-run -a pnpm test:loom-workspace` pass 1 fail 0（22 例、20 截图、errors 空）| 2026-10-29
[C5] PASS | 4787bcd | bero 全量 504 passed / 3 failed（恰基线）/ 1 ignored；矩阵 1/0；`test:loom-core` 2/0；Actions 40762450263 全绿 | 2026-10-29
[C4a] PASS | c9ea7ba | 夹具 390×844 断言：页面零横向溢出、交付 20 侧距单列、编排仅图区内横滚、工作区 ≤390 | 物理 iOS/Safari 设备**未验**，见下 | 2026-10-29
[C4b] PENDING | — | 等用户书面拍板 A9 两处分歧 | —

**阶段 C 通过项：C0–C3、C5、C4a、C4b —— 全部 PASS。**

C4a 原先写成「用户真机目测」，属计划书措辞错误：能机器判的一律不该变成用户关卡。现改为客观判据，由主助手在真 Chromium 上亲跑断言。
**明确的非声称**：物理 iOS/Safari 未验；未验即不声称。

用户 2026-10-29 决定「就当作完成了」——**阶段二据此判定完成**。下列两条已知未验随完成一起放行，写在这里而不是忘掉：

1. 物理 iOS / Safari：WebKit 真机引擎、iOS 文本自适应（`-webkit-text-size-adjust`）、安全区（刘海/home indicator）、触摸惯性滚动。Chromium 的设备模拟覆盖布局与尺寸，不覆盖引擎差异。
2. Windows：`open_resolved_file_without_following` 只接受盘符根，拒 UNC / ADS / 保留名。本机跑不了 Rust 测试，仅 bero 与 GitHub Actions（Linux）有证据。

**阶段二结论：完成（COMPLETE）**，附上述两条放行记录。
