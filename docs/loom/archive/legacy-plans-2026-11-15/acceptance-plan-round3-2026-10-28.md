# LOOM 第三轮验收计划（2026-10-28 起）

> 配套 plan-round3-2026-10-28.md。主助手只按本表判，**工兵自报、ok:true、截图文件名都不算证据**。
> 每条证据必须是主助手在 bero（或 GitHub Actions）亲跑的原始输出，并记 commit hash。

## 0. 通用判据

- 证据 = 命令 + commit hash + 原始输出尾部 + 时间。缺一条 = 未验。
- 全量 Rust 只允许基线 3 个环境失败（database_admission / IdentityChanged{stage:Revalidation}），不许改掉它们充绿；第 4 个失败即 FAIL。
- 截图结论先核对图内内容与文件名一致（MASTER 坑 5）。
- 审计期间被审文件有任何改动 → 该次审计作废重来。
- 白名单外有改动 → 该交付直接 FAIL，退回。

## 1. 阶段 A 验收表

| 编号 | 项 | 命令 / 动作 | PASS 判据 |
|---|---|---|---|
| A1 | Astra 复审 TS 重复声明 | Astra 只读审 loom.ts | 第一行 PASS；且 grep -n 'export interface LoomReviewRecordInput'、LoomReviewRecordReceipt 各只 1 处 |
| A2 | HEAD 全量回归 | bero cargo test -p rovai-core --lib | 失败恰为基线 3 个；LOOM 子集 --lib loom 51/0（或更多且 0 失败） |
| A2b | 前端回归 | pnpm typecheck；pnpm exec vitest run packages/contracts/src/loom.test.ts | 0 错；7/7 及以上 |
| A3 | 按钮点击 | bero xvfb-run pnpm test:loom-workspace | 断言覆盖：点接受 → 出逐条标准表单 → 漏勾或缺理由时提交被拦 → 全勾+理由提交 → 「已验收」徽章、按钮消失、表单收起；核验通过/失败各一条；回包参数断言 candidateId 正确、**不含可信的 reviewerId** |
| A4 | 真实 Core 全链路 | bero 先 cargo build -p rovai-core --bin rovai-core，再 pnpm test:loom-core | 导入 → 认领 → 交候选 → 评审 → 核验 → 下游 artifact_accepted 边自动放行；payload 塞 reviewerId:"someone_else" 落库仍为 local_user；临时 userData 之外零写入；只评审不核验时边不放行 |
| A5 | CI 第二证人 | push 后看 Actions | workflow 绿；日志无密钥；只在 zhizhishu/loom-ai 触发 |
| A6 | 手机走查 | 用户真机 390px | 用户明确说「可以」；无横向溢出、字体不方块 |
| A7 | 审计终审 | Astra 审 A3+A4 合并 diff | 第一行 PASS |
| A8 | 收尾回归 | A3/A4 合入后 bero 重跑 A2 + A2b | 同 A2、A2b 判据，commit 为合入后的新 hash |
| A9 | 分歧拍板 | 用户书面决定 evidenceIds/note 可空性、验收标准版本来源 | 决定写进本文件附录；若决定改代码，转阶段 B 单列一步 |

阶段 A 通过 = A1–A9 全 PASS + 用户点头 → 宣布阶段二完成。A5 已获授权，必须实跑，不可跳过。

## 2. 阶段 B 验收表

| 编号 | 项 | PASS 判据 |
|---|---|---|
| B1 | 证据实体化 | 迁移 224 / schema 174 链式测试过；引用不存在产物 → 稳定 LOOM_* 错误码；hash 不符 → 核验失败；产物行不可改（触发器三层拦） |
| B2 | 认领可见 | loom.claims.list 有 Rust 测试 + TS 契约测试；UI 节点显示占用者、租约到期、fence 代数；租约过期显示为过期 |
| B3 | 零消费导出 | LoomClaim / LoomReviewResult / LoomReviewSubmission 每个要么有调用方要么已删；typecheck 0 错 |
| B4 | 宽屏密度 | 1440 截图右侧留白明显收窄；768/390 不回退；仍是 Rovai token |
| B5 | 回归 | 每步后 A2/A2b 重跑仍满足 |

## 3. 一票否决

- 碰了上游 murray17/rovai-ai（PR / Issue / 分支 / push）。
- 新开页面、加导航、换视觉体系。
- 验收进程指向日常 Electron userData。
- skill-cli 仓库 git add -A。
- 超出授权的动作：碰上游、动本机进程、未经点头开阶段 B。
- 把工兵自报写进验收结论。

## 4. 记录格式（每项一行写进 TASK.md）

[A3] PASS | commit abc1234 | bero xvfb-run pnpm test:loom-workspace | pass 1 fail 0 | 2026-10-xx hh:mm CST | 证据：_artifacts/...
