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
| C4a | A6 手机走查 | 用户真机 390px | 用户明确说「可以」；无横向溢出、字体不方块 |
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

## 附录：A9 用户决定

（待填）
