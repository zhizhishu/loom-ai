# LOOM 任务交接书（最新，2026-10-28）

> ⚠️ **本文已被暂停交接书取代**：`docs/loom/handoff-resume-2026-10-28.md`。
> 下方第 1–4 步（P4-fix / P5a / 全量回归 / P5b）**已完成**，重开时从第 5 步（P6）继续，
> 但必须先补做 resume 书里的"缺 1 Astra 复审"和"缺 2 HEAD 上复跑全量回归"。
> 本文保留作为**原始计划与坑清单**参考。

> 接手前先读：docs/loom/progress-2026-10-28.md（进度）→ 本文（怎么干）→ docs/loom/acceptance-2026-10-28.md（怎么算完）。历史细节见 docs/loom/handoff-2026-10-28.md。

## 一、边界（不可越）

- 仓库 zhizhishu/loom-ai，分支 main；本机 C:/Users/echo/Downloads/claude/skill-cli/loom；bero 上 /root/sandbox/projects/loom。
- 上游 murray17/rovai-ai 只读：不提 PR / Issue / 分支。
- UI 只改 Mission 下「编排 / 交付」两个 tab，不新开页面、不加导航，保持 Rovai 视觉世界。
- 本机 Windows 编不了 Rust，所有 cargo 构建与测试在 bero 上跑（export PATH=$HOME/.cargo/bin:$PATH）。
- 验收进程一律临时 userData，禁止碰日常 Electron userData。

## 二、分工

| 角色 | 模型 | 做 | 不做 |
|---|---|---|---|
| 主管（主线程） | 当前会话 | 契约、迁移、白名单、bero 编译测试、合并、验收 | 把工兵自报当验收 |
| Astra | oct-response/gpt-6-astra | 计划与终审，只读 | 写码、派工 |
| Pi 工兵 | oct-chat/deepseek-v4.1-flash | 1–3 个文件的有界实现，交 diff | 碰契约、碰迁移链 |

## 三、下一步顺序（严格按序）

### 1. P4-fix：修 Astra 终审（主管亲做，动冻结文件）
1. P1：review_record 接受前拒绝空验收标准（或 plan.import 即拒），与 TS loom.ts:400 对齐；补「先核验后评审」「先评审后核验」两条空标准反例测试。
2. P2：两张不可变表补显式 rowid 冲突拦截（BEFORE INSERT 检查 rowid 已存在即 ABORT），补测试。
3. P2：review_record / verification_record 重放分支比对 mission/task/candidate，不同返回冲突错误码，补测试。
4. P2：db.rs:42612、db.rs:43188 的 extended 矩阵改为 through223。
5. 定 evidenceIds / note 可空性，Rust 与 TS 一侧对齐。
6. bero：cargo test -p rovai-core --lib loom 全过 → 提交 → 停手 → 派 Astra 只复审这五处（≤600 字，第一行 PASS/BLOCK）。

### 2. P5a：身份由 Core 注入
- 从 LoomReviewRecordInput / LoomVerificationRecordInput 删 reviewerId / executorId；在 application.rs dispatch 处用 CURRENT_USER_ID（约 1772 行）注入；TS 契约同步删字段。
- 补测试：payload 夹带身份字段被拒或被忽略，落库身份恒为可信身份。

### 3. schema 173 全量回归
- bero cargo test -p rovai-core --lib；只允许基线 33f6ded 可复现的 3 个 database_admission IdentityChanged{stage:Revalidation} 失败。

### 4. P5b：交付 tab 操作按钮
- 接受 / 驳回（loom.review.record，逐条标准勾选）、核验（loom.verification.record）；提交后刷新候选与评审；错误码转中文提示。
- 夹具从 controls===[] 改为断言预期控件与调用参数（不含身份字段）。

### 5. P6：真实 Core 全链路
- 先 cargo build -p rovai-core --bin rovai-core（**不要用 pnpm core:build:debug**，linux-x64 不支持且会让旧二进制假绿）。
- 跑导入 → 认领 → 交候选 → 评审 → 核验 → 下游 artifact_accepted 边放行；断言临时目录外无写入。

### 6. P7：移动端
- 夹具加 390px 截图断言；bero 预览让用户手机走查。

### 7. 收尾
- 更新 skill-cli/TASK.md、skill-cli/LOG.md、docs/loom/control-plane.md。
- 只清理本轮确认归属的进程：本机 DSH job bash-58（vite full-app 预览）；bero 上 /tmp/loom-vite.pid、/tmp/loom-web.pid 记录的进程。归属不明一律不动。

## 四、会咬人的坑

1. 加迁移必改：vNNN 标志、admits 首臂、EXISTS 列与 row.get(N)、常量、classify_database_contract 白名单、两处 migration_step!（缩进 16 / 12）、上一步终态放宽为 Current | SupportedMigrationSource、downgrade_for_test、链式测试、extended 矩阵。schema = migration − 50。
2. 审计期间不许改被审文件；一次只给 Astra 一个切片。
3. 工兵 ok:true 不算验收，主管必须在 bero 复跑。
4. 1440 下编排可用宽约 804px：列数 × min-width + (列数−1) × gap ≤ 804。
5. 截图方块字是缺字体（已装 fonts-noto-cjk），不是 CSS。
6. 夹具有两套：scripts/fixtures/loom-workspace 与 scripts/fixtures/mission-board，改对那一个。
7. skill-cli 仓库里别 git add -A（会卷进 _references/、_backups/ 大文件）。

## 五、证据位置

- Astra 终审原文：~/.pi-skill/projects/c-users-echo-downloads-claude-skill-cli-loom/runs/1c9c84cd30304d37a969de3de75e9eb8/
- 截图：bero /root/loom-shots、/tmp/rovai-loom-workspace-test-*
- 派工任务原文：skill-cli/_artifacts/tmp/
