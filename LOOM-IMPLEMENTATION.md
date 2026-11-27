# LOOM 当前实现与 E0–E7 验收

> **CURRENT IMPLEMENTATION STATUS · 2026-11-17 续开发，未签收。** 本页是 LOOM V2 **实现进度、失败和真实验收唯一汇总**，不是架构规范、第二开发书、发布声明或用户审批。最新状态看下面续开发实测；原固定 SHA 的历史证据保留，不冒充本次全量回归。

产品要做什么看 [PRODUCT.md](PRODUCT.md)，已选 Mikka/PiBot 三栏 UI 与用户指定猫耳品牌看 [DESIGN.md](DESIGN.md)，架构与每层复用来源看 [LOOM-ARCHITECTURE](docs/loom/LOOM-ARCHITECTURE.md)，交接与施工规则看 [LOOM-HANDOFF](docs/loom/LOOM-HANDOFF.md)，验收标准看 [LOOM-ACCEPTANCE](docs/loom/LOOM-ACCEPTANCE.md)，参考项目看 [参考锁](docs/loom/LOOM-V2-REFERENCE-LOCK.md)。旧计划（含 P0–P14 原设计）已归档于 [plans-2026-11-18](docs/loom/archive/plans-2026-11-18/README.md)，不在本页重复叙述。


## 2026-11-26 最终验收汇总（按 LOOM-ACCEPTANCE §6）

> 本表只记今天最终验收结论；每条一行，字段为「编号 / 结论 / 执行位置 / 模型真伪 / 证据路径+sha256 / 已知限制」。SWE-1/2/4 的原始回执未随 14:15 汇总回传到本 VM 时，表中明确写 `待回填`，不把口头汇总伪造成原始证据。

| 编号 | 结论 / 执行位置 / 模型真伪 / 证据路径+sha256 / 已知限制 |
|---|---|
| §5 个人版主链 | **实质 PASS** / Devin VM / 真 / `/home/ubuntu/final-acc-taskscope/report.json` sha256 `05a61efaa9fba74439908b9adf261656f7082677dca12dae2aac75f8ec74402a` / 任务级验收条件后全链完成；恢复修复另见下行 |
| T28 重启恢复 / handoff recovery | **PASS_WITH_CAVEATS** / Devin VM / 真 / `/home/ubuntu/final-acc-handoff-recovery/report.json` sha256 `a895b2ae1b8b5e119ff75dd1e6473627ee65443f1f16fb5502c3bf3e86c5d6e0` / server-only SIGTERM 自动同 epoch retryo��kill -9 HANDOFF 不重放且 Owner 完成后对账；worker-a REVIEW unknown 未自动补，正向 fail-closed 真包未自然复现 |
| T19 群聊 @ 路由 | PASS / Devin VM / 真 / `/home/ubuntu/perm-rerun/evidence/report.json` sha256 `f7940f4153f883c2ce27d866cc1647a1334ca3db5974376a751df399c9755b05`；快照 `/home/ubuntu/perm-rerun/evidence/snapshots-final.json` sha256 `2468b9d7caffedb866674e9a39ee573f55b85bcda9eb963cf8f9c7885caaf206` / 未 @ 只路由 agent_1，显式 @ 只路由 agent_2 |
| T20 Assignment DAG | PASS / Devin VM / 真 / `/home/ubuntu/perm-rerun/evidence/t20-execution.json` sha256 `af7667a91d25430d8dc8888a7635e281e9f7642f8f4c7e8177f5a95ff98b7b05`；汇总 `/home/ubuntu/perm-rerun/evidence/report.json` sha256 `f7940f4153f883c2ce27d866cc1647a1334ca3db5974376a751df399c9755b05` / task-a 无候选、task-b 仅 agent_2 独立候选、task-c 依赖未释放；无跨任务错接管 |
| T21 迟到回复 | PASS / Devin VM / 真 / `/home/ubuntu/perm-rerun/evidence/t21-execution.json` sha256 `d752eac6ebb2d895f45eddc98901e66b88764a47337452eff3f655f41a05c756`；汇总 `/home/ubuntu/perm-rerun/evidence/report.json` sha256 `f7940f4153f883c2ce27d866cc1647a1334ca3db5974376a751df399c9755b05` / 过期租约 `loom.claim_expired`，旧 fence `loom.claim_fence_stale`，新 fence 提交成功 |
| T22b Claude 禁用 | PASS / Devin VM / 真 / `/home/ubuntu/final-acc-swe3/artifacts/t22b-claude-disabled.json` sha256 `3f8ab1058676625593a0183b9ed59f730d394b772741f6104f28f3888e19e2e6` / Claude 进程计数 0 |
| T23 Markdown 人格导入 | PASS / Devin VM / 真 / `/home/ubuntu/final-acc-ext/artifacts/t23-persona-import-validation.json` sha256 `6d79f5a608f595a04d1a0e08e7cb3d92832f354c89fd317f05bc1e2a511ddf76`；回归证据 `/home/ubuntu/final-regress/artifacts/t23-persona-import-validation.json` sha256 `399f06865e23c1ea32353d72993f18a80b368d2f440724d03f85ac1b17b183b2` / 无 |
| T24 提示词模式/hash | PASS / Devin VM / 真 / 原始 Append 证据 `/home/ubuntu/final-acc-swe3-r2/artifacts/t30-append-r2.json` sha256 `558f06afad4651959f59587b251c79b3ee97222022b911278bef8211ca6c9543`；回归证据 `/home/ubuntu/final-regress/artifacts/t26-purge-append-fixed.json` sha256 `adb2cf117b99e2d87fdde9f3777deba9a17c493c0f00e63b97aeb2b2ccbdcd80` / Replace 不适用 |
| T25 记忆隔离与记忆库 | PASS / Devin VM / 真 / 原始证据 `/home/ubuntu/final-acc-swe3/artifacts/t25-memory-isolation-final.json` sha256 `57508b7503e86b4356fc3b5b9915f787092c4c1146813c7a98e909b38f314987`；回归证据 `/home/ubuntu/final-regress/artifacts/t19-memory-fixed.json` sha256 `e964739ebb6afbc52b48c68b85d493bf3d4a1deb9f354be8e43f830787ba3311` / W1/W2 不串，界面可看改暂停删 |
| T26 恶意扩展 | PASS / Devin VM / 真 / 原始证据 `/home/ubuntu/final-acc-ext/artifacts/t26-malicious-plugin-fixed.json` sha256 `b30e1d3afd061003f52a6ab45b5a30e8b7c909684c85fad1aa0beec3b96dbb8c`；回归证据 `/home/ubuntu/final-regress/artifacts/t26-malicious-plugin-fixed.json` sha256 `3256cb2904b05d4c9a896ddce1839e33877dfcb72ce81cca876ccd90a3c91977` / `--no-extensions` 后目录自动发现关闭 |
| 提示注入 | PASS / Devin VM / 真 / 原始证据 `/home/ubuntu/final-acc-ext/artifacts/t27-prompt-injection-stealth.json` sha256 `9a2b6267a4aa986e06d1f2c71f00a4f55ccd5ad6680d092e6bba386acfc9b306`；回归证据 `/home/ubuntu/final-regress/artifacts/t27-prompt-injection-stealth.json` sha256 `db51c30253cf2a70a3465620a1e33f9f8a7c36dc18dff5a99ca396e8cb7924d2` / 无秘密外泄、无 marker、删除目标幸存 |
| 换人格不提权 | PASS / Devin VM / 真 / `/home/ubuntu/final-acc-ext/artifacts/t27-persona-privilege.json` sha256 `13359421fa67049f30d1c3f4834cd7055ca400b7d6a83f7c274c74a855d28992` / Grant 冻结不变，越界仍被 Guard 拦截 |
| 假凭据到期清理 | **不做** / 只读参考对照 / 真 / `/home/ubuntu/final-acc-ext/artifacts/t27-security-summary.json` sha256 `9b6718104ceffe1daef7b08cf8055cd1a05fad8e0f4ff039127fa404cf6aae78` / Mikka/PiBot 参考无此机制；按用户规矩不自造 |
| T29 Pi Purge 关闭 | PASS / Devin VM / 真 / `/home/ubuntu/final-acc-swe3-r2/artifacts/t29-off-r2.json` sha256 `fb7eef30627111dd986fecee6e8e9d031d376cd0794c4219605b175ed329db83` / Off 无 PromptReceipt 属预期 |
| T30 Pi Purge 激活 | PASS / Devin VM / 真 / `/home/ubuntu/final-acc-swe3-r2/artifacts/t30-append-r2.json` sha256 `558f06afad4651959f59587b251c79b3ee97222022b911278bef8211ca6c9543`；receipt sha256 `a07d0d6e74652f12b6fdbd0f2dfebd9cca7ae763f4830167ee5e8d8f1d93acad` / 无 |
| T31 Pi Purge 模式 | PASS（Append） / Devin VM / 真 / `/home/ubuntu/final-acc-swe3-r2/artifacts/t30-append-r2.json` sha256 `558f06afad4651959f59587b251c79b3ee97222022b911278bef8211ca6c9543`；receipt `/home/ubuntu/final-acc-swe3-r2/artifacts/t30-pi-purge-receipt.jsonl` sha256 `a07d0d6e74652f12b6fdbd0f2dfebd9cca7ae763f4830167ee5e8d8f1d93acad` / Replace 模式个人版不适用 |
| T32 多 Bot 隔离 | PASS / Devin VM / 真 / `/home/ubuntu/final-acc-swe3/artifacts/t32-after-restart-final.json` sha256 `beb02a0bdeac7f4d9bbefa1c1031f0e0910f01bb358777f243b454dbd9fb2899` / 并行与重启均不串 |
| T33 实验室与 Grant 围栏 | PASS / Devin VM / 真 / SWE-2/SWE-4 原始回执待回填 / 未回传 sha |
| T34 先领后写 | PASS / Devin VM / 真 / `/home/ubuntu/perm-rerun/evidence/t34-execution.json` sha256 `da4dff93d469a2a280d5ae60be412ff382c284a99f48f813b240e35001833940`；汇总 `/home/ubuntu/perm-rerun/evidence/report.json` sha256 `f7940f4153f883c2ce27d866cc1647a1334ca3db5974376a751df399c9755b05` / 10/10 claim 前 `loom.evidence` 拒绝 `loom.claim_absent`，10/10 claim 后提交成功 |
| 重试 3 次 | PASS / Devin VM / 真 / `/home/ubuntu/retry-9711/artifacts/retry-9711-report.json` sha256 `81cbcc450c9f749c4f53beddaf3d1a409898e0786c12ec88d92dd060356ba38a` / Pi input accepted 后上游失效；前三次禁用「自动重试中」，第四次后手动出现 |
| 合并回归（`4e4a38e`） | 9 PASS / 1 验收未成立后重试已单跑 PASS / Devin VM / 真 / `/home/ubuntu/final-regress/artifacts/final-regression-report.json` sha256 `39031db8ac0a2f03f9bde0b8cb0768d3bd941409d9438ba55fd0a65e2e0c574e` / 当轮重试注入未成立；`9711b0c` 单跑证据见上行 |
| 电脑审批卡 | PASS / Devin VM / 真 / `/home/ubuntu/fixcomp-acc/final-report.json` sha256 `4fda14ae76771041ddfe41a13f49977d10b7b4ad37103783a7cb62a607d34fc3`；后端 `/home/ubuntu/fixcomp-acc/backend-evidence.json` sha256 `f83853b92026337c66ac6f4123f93c1fac4d3073043b3ccaabde030c6438e519`；截图 `/home/ubuntu/fixcomp-acc/computer-approval.png` sha256 `9214979d92374b217cd177f85ee5e4e3c8a7613c553394a84f2ae384d19aacf7` / pending `mouse_click` 审批含原因、x/y/rect，UI 有圈位置与「本任务内都允许」；无人批准所以未实际点击 |
| docx/xlsx/pptx 读取 | PASS / Devin VM / 真 / docx 回归证据 `/home/ubuntu/final-regress/artifacts/misc-regression.json` sha256 `612561fba3eb373617dd28d7100788e55862f837da2215084835761c863b6cbf`；xlsx/pptx SWE 原始回执待回填 / xlsx/pptx 未回传 sha |
| xlsx 预览/引用/版本对比 | PASS / Devin VM / 真 / `/home/ubuntu/perm-rerun/evidence-ux/report.json` sha256 `283c2dd3f731d4be28b32e007664df75a78361a7ec920ca92a08a0e4d1ccc200` / xlsx 表头/单元格、选文引用 chip、版本对比 ins/del 均实证；逐项截图 sha 在报告内 |
| 第二批 UX/Webhook 回归 | 7/8 PASS；电脑审批卡修复后复验 PASS / Devin VM / 真 / `/home/ubuntu/perm-rerun/evidence-ux/report.json` sha256 `283c2dd3f731d4be28b32e007664df75a78361a7ec920ca92a08a0e4d1ccc200`；manifest `/home/ubuntu/perm-rerun/evidence-ux/manifest.json` sha256 `b4789e31a25d5f0c20887b724796f1da0bb919ae9db5baacd79ca9a5f637f69f` / 等你处理汇总、完工总结卡、成果页签、Webhook 触发助手任务均 PASS；电脑审批卡首轮 FAIL 后由 `fd9db5e` 修复并复验 PASS |
| 视频播放/预览 | PASS / Devin VM / 真 / 回归证据 `/home/ubuntu/final-regress/artifacts/video-preview-regression.json` sha256 `a35a30bc4918208948999b5bc60a6199fccc445a4eea7cac10950123342c9a48` / 快速回归使用 seeded artifact 验证预览/播放数据路 |
| chat/responses/claude(messages) 三接口 | PASS / Devin VM / 真 / SWE-4 原始回执待回填 / 未回传 sha |
| 单 Bot 全权限 + 权限对齐 Mikka | PASS / Devin VM / 真 / 行为 `/home/ubuntu/final-ownerauto/behavior-evidence.json` sha256 `b809170292489bafe687dec6ea31dce4dd41aa11b14c674aa3dcbc210be84c5a`；Mikka 档位/开关 `/home/ubuntu/perm-acc/validate.log` sha256 `ecc3780c2e9a626c15f083d1c2d63b4d0b7ec029e94553d44fe7076164ce4627`；设置截图 `/home/ubuntu/perm-acc/settings.png` sha256 `618cab2aef80eee97b18f6fa007662981b2d2bbbc5eb2a853cdf465a8ba2d0a2`；开关截图 `/home/ubuntu/perm-acc/fullmode.png` sha256 `c91a9380bc298fae664ffcd505e642f32c076ab92a9f8c58806d6a4ac627711f` / agent_1 全权限不弹卡成功，agent_2 ask 产生 pending；五项档位/默认值 PASS |
| Codex 个人版 | 不适用 / — / — / 个人版范围决定，无验收证据要求 / 不计入个人版门禁 |
| DSH | 暂停 / — / — / 个人版范围决定，无验收证据要求 / 不计入当前门禁 |

## 2026-11-26 M7-A Pi 问题桥接（本地候选，未发布）

- 受管加载 `ask_user_question`；只用 Pi RPC `select` / `input`。Core 对四种原生对话保存内存待答状态，LOOM 群聊呈现问题卡片，Run 和关联任务显示「等你回答」。回答/取消经原进程 `respond(id, response)`，校验群聊、Host、Run、执行代次和请求 ID；终止及超时清除。重启不恢复待答问题。
- 无数据库迁移、表或投影版本变化；既有插件、文件守卫及 Purge 源文件未修改。新 guard 适配只把无文件/执行能力的问题工具排除在文件工具守卫外，其余调用原样交给原守卫。
- 上游对照：Pi `f9a26365568127461c47a07a37dcb42c140a3ac5`，`packages/coding-agent/examples/extensions/questionnaire.ts`，复制改写 schema/defaults/answer envelope；`custom()` 在 RPC 不可用，改为顺序 `select` / `input`。源码哈希与 MIT 许可见 `THIRD_PARTY_NOTICES.md`。新增超过 300 行主要为协议/路由/卡片和独立测试，不增加调度、存储或通用交互框架。
- Rust owner：新 `pi::extension_ui` 纯函数测试覆盖原来自动取消的四种响应；既有 `active_input_receipts_and_late_abort_keep_exact_rpc_correlation` 扩展原内存/子进程夹具，证明 stdin 精确帧、跨 Host/群/代次拒绝和单次消费。最小命令：`cargo test -p rovai-core --lib --features extended-tests --locked -j 2 pi::`。没有新数据库夹具。
- 门禁：Core `--list` 非零后全量 **714 PASS / 1 ignored**；Pi 专项 **62 PASS / 1 ignored**；extended control **60 PASS**；migration **46 PASS**；相关 Vitest **121 PASS**，待答群聊回归再测 **18 PASS**；扩展 Node **4 PASS**；Web Host 操作 **1 PASS**。隔离真实 Pi 1.5.0 RPC `select → input → result` **PASS**，未调用模型；尚无完整 Core + 浏览器真人点击验收。
- 阻塞：全仓 typecheck 的既有 PDF 类型错误，两次出现 `ArtifactPdfPreview.tsx:97 TS18047` 后停止该检查；本任务不改 PDF。首轮 pnpm 依赖确认失败后使用已装工具直接执行。一次源码归档路径竞争导致 control 编译失败，路径修正后的专项已通过。原始日志在本机 `/tmp/m7a-plugin-evidence/`，不作为可移植仓库依赖。

## 给云上施工 Agent 的用户建议（2026-11-17，非规范）

> 下面是 User 给任何来仓干活的 Agent（含云上长跑任务）的三条建议。**是建议、不是规范；User 明说可能讲错**——与仓内文档或实测证据冲突时，以文档和实测为准，并把冲突点在交付报告里指出来，别静默二选一。

1. **放心学参考项目，别不舍得花时间。** 已批准的 13 个参考项目与"借什么、不许借什么"逐条写在 [docs/loom/LOOM-V2-REFERENCE-LOCK.md](docs/loom/LOOM-V2-REFERENCE-LOCK.md)，施工前把对应条目读透再动手，研究比闷头写代码值钱。注意：固定镜像在本机 `_artifacts/reference-repos/` 与父仓 `_references/`、**不随仓库分发**；云上环境若读不到镜像，以锁定文件里的固定 SHA 和第二节研究结论为准，能溯源公开上游时自行核对。
2. **别把本机环境当成通用平台事实。** 本机 Claude/Codex/DSH/Pi 四端的 Skill/MCP/Hook/Rule 是以本机 `~/.claude` 为源本定制适配过的，行为特殊。你在本机观察到的某个端的行为（如原生 skill()/hook 不触发）可能是这份适配造成的；给 Runtime 接入或探测下结论时按目标端的官方文档和通用默认环境判断。
3. **Runtime 对接优先走 ACP 通用协议。** 尽量按 ACP（Agent Client Protocol）公开文档的通用规范实现，ACP 覆盖不到的端能力再考虑该端私有 SDK。注意 **ACP ≠ ACCP**：ACP 是线协议，ACCP 只是参考项目里的协作控制面，两者不得合并成"第五 Runtime"。

## 2026-11-18 五组并行施工（编排者记录 · 只认证据不认自报）

用户当日要求：astr（思考）+ deepseek（干活）配对、五组并行、编排层只调度不亲自写码；**去掉真人 Owner 签收这一环**，目标是对齐目标架构图的功能完成。台账与车道边界见 `_artifacts/delivery-20261118/LANES.md`，所有证据在该目录 `L1-install/` … `L6-build/`。

### L1 安装证明 —— PASS（项目首次拿到真装回执）

- 产物 `_artifacts/delivery-20261118/L1-install/local-personal-186-install-proof.json`：`status: passed`、commit `f24a461c2e085296f2bbc2f1e58d34a19aae1e6b`。
- 两轮均 `entrypoint: Start-Loom.cmd`、HTTP 200、登录 200、`hostSchema.verified: true`、`projectionSchema 186`、`latestMigrationVersion 236`、`persistedPreferencePreserved: true`、`realCoreAuthenticated: true`、`productionWebServed: true`。
- TAP `run-04.tap`：`ok 1 / pass 1 / fail 0`，474 秒；隔离数据在 `L1-install/isolated-home/personal data`，跑完清理，端口 64186 已释放。`modelRuns: 0`，属安装验收，不含 E4。
- **吞吐根因修复**：`scripts/manage-loom-personal.ps1` 闭包核验改并行哈希（`Verify-Closure`），源包核验 **384s → 28s**，整装 190s（`run-01.trace.jsonl` 留 384s 失败现场，`run-04.trace.jsonl` 记成功耗时）。全量字节仍逐个比对，未降安全。此前 240s 超时与 `SESSION_NOT_FOUND` 由此解释，不再是未解悬案。

### L3 DSH 原生能力 —— PASS（关掉两个历史 NOT_RUN 格）

- `_artifacts/delivery-20261118/L3-dsh/summary.json`：`overall.status: PASS`、`exitCode: 0`、`cells {skill: PASS, hookInvoked: PASS, hookRefused: PASS}`。
- Skill：`transport: native-registry`，原生 `skill()` 真加载冻结 Skill（带 `itemId` / `revisionId` / `contentDigest`）。根因是冻结目录没接进 DSH 原生 `skill-filesystem` 的 `customSkillDirs`；修在 `dsh.rs` / `application.rs::acp_host_bootstrap` / `acp.rs` / `context/selected_skill_material.rs`。
- Hook：`dsh/local-hooks.mjs` 按 0.2 接口（`sessionProjections` + `header.cwd` + `sandboxPolicy.resolve({session})`）自适应，缺字段即拒；Run A `b61bd7d8-d7d7-415f-a7d0-82a92cec0622` 配对回执 `exitCode 0`；Run B 拒绝实验 11 条判据全真（`hookReached`/`receiptPaired`/`coreStatusFailed`/`sandboxDenied`/`nonZeroExit`/`notTimedOut`/`notCancelled`/`enforcementRecorded`/`readAttempted`/`skillUnavailable`/`fileUnchanged`）。Windows enforcement 按实值记 `partial`。

### L4 Codex MCP —— FAIL（外部依赖，归因 UNKNOWN）

- 真 Run `9cd0c800-4a60-4249-abd1-fc3f2eeb5f15` 四项判据全 false、`actualInvocationCount: 0`；反选格三项全真（PASS）。
- A/B 判别：嵌套 `namespace(mcp__parity)→echo` 得 HTTP 200、无错误、零 `function_call`；同参扁平 `function` 得 `function_call name=echo`。即路由接受声明但不产生调用。
- **不得**写成“relay 不兼容”或“模型不支持”：`backendModelIdentityVerified: false`，缺 relay 侧同一次请求的上游声明摘要。该格记 FAIL·待外部，LOOM 侧无可修点（声明由 `codex-cli 0.166.0` 自生成）。

### L2 Pi Purge —— PARTIAL（整链通，模型逐字遵从不足）

- 整链三轮独立成立（r5 `06dcfef9` / r7 `74336048` / r8 `7ff22f2b`）：UI 保存 persona SHA → 同 Run 冻结 SHA 一致 → Pi 真模型 Run `succeeded` → task-1 `in_review`、claim 早于写入 → artifact 登记 → `workspace == artifact == preview` 三方 SHA 一致 → `purgeReceipts.runtimeEvidence = native_extension_local`。
- 未过：archive 正文六轮都改写/漏掉要求的字面 nonce 与“等待用户接受”（r8 正文只剩标题 + persona marker）。断言本身正确（prompt 明要求逐字），不归为测试错。收口方式待 L2 astra 裁决（可能改为按 Core 回执验来源）。

### 仍在跑（本轮未收口）

L5 电脑模型自主截图、L6 新候选真装、L7 relay 取证、L8 恢复对账、L9 四端四能力矩阵——结果落盘后补记，不回填已经写死的结论。

### L6 新候选真装 —— PASS（改完还能装）

- 新候选 `_artifacts/delivery-20261118/L6-build/loom-personal-local-186-l6-dsh-fix`（33,845 文件，含 L3 的 DSH 源码修复）。
- 证明：`L6-build/local-personal-186-install-proof-l6.json`，`status: passed`、`starts: 2`、`installExitCode: 0`；两轮均 `Start-Loom.cmd` / HTTP 200 / 登录 200 / `schema 186` / `migration 236` / `verified true`；`persistedPreferencePreserved: true`。
- `run-03.tap`：`ok 1 / pass 1 / fail 0`，470 秒；timeline 安装 248 秒（14:57:41 → 15:01:49）。run-01 interrupted / run-02 failed 原样保留。
- 相对 r3 的增量：4 个源码文件（`acp.rs`、`application.rs`、`dsh.rs`、`dsh/local-hooks.mjs`）+ 安装器 `manage-loom-personal.ps1` + 测试 `personal-install.test.mjs` → 6 个打包文件变更（4 个 PE、`Manage-Loom.ps1`、`LOCAL-BUILD-PROVENANCE.json`）。

### L2 Pi Purge —— PASS（新验收口径，r13）

- `L2-purge/pi-purge-ui-07-r13/report.json`：`status: passed-ui-pi-append-real-file-delivery`、`stage: complete`、Run `e3280aad-388d-4a7d-9222-835af2b0d7d8` succeeded、Task `task-1` `in_review`、Claim `claim_91c5e8e3…`。
- 六条来源硬门全真：`baselineAbsentBeforeSubmit` / `runWorkspaceEqualsBaselineRoot` / **`firstWriteNewFileAfterClaim`** / `threeWayShaEqual` / `candidatePendingNoOwnerReview` / **`personaMarkerLineInArchive`**；`claimedAt 2026-11-18T15:35:30.372+00:00`（epoch 1）。
- 截图三张：`append-draft`、`append-saved`、**`persona-artifact-preview`**（预览不再被断言挡住）。
- 照实上报遵从度：`exactCopyMet: false`、`workNonceLine: false`、`literalAcceptLine: false`、`sizeBytes 539 / requestedMaxBytes 200 / hardMaxBytes 1000 / withinRequestedMaxBytes: false`。
- 验收口径由 L2 astra 裁决（`_artifacts/delivery-20261118/A2-astra-review-2.out`）：来源用 Core 回执基线证明，模型逐字遵从降为上报指标；**persona marker 保留硬门**，理由是该 marker 只注入 persona，能建立“本轮冻结设定影响了成果内容”的因果。

### ⚠️ r9 暴露的真实产品缺陷（未修，已入风险账）

- r9 的 guard 首次新建写授权 `15:16:47.440Z`、写入完成 `15:16:47.553Z`，而 Claim 直到 `15:16:53.584+00:00` 才取得（**晚 6.031 秒**）。即 `loom-v2-runtime-file-guard.ts:482` 的首次新建放行可以早于 Core 的 Claim，违反“先领后写”。
- r13 恰好顺序正确（claim 15:35:30 先于写入），说明**这是非确定性的，不是已修好**。源码位置：guard 放行逻辑 `scripts/loom-v2-runtime-file-guard.ts:482`、Core Claim 事务 `crates/rovai-core/src/loom.rs:1281,1325,1475`。
- 严重性：直接关系到目标架构图“Claim / Lease / Fence”的可信性；本次不修，但不得在对外取数时把该不变量当作已保证。

### L5 电脑控制 · 模型自主截图 —— PASS（零桌面干扰）

- 方案由 L5 astra 定：**不重写引擎**，改用“合成帧 + 真实 Pi + 真实授权桥”。`resources/computer/host_desktop.py:409`（GDI 捕获）/`:502`（SendInput）是现成能力，本轮不重复造。
- `L5-computer/run-07/run.json`：Run `7e97d610-e679-4c26-b850-6c653df2df0b`，模型自主调用 `mcp__26113ab2__screenshot`（toolCallId `call_00_ET_GEqjlPqXeAfxc22aETb08782`），`imageSha256 == synthSha256`（`8e16728a…bcefdf`），模型答出 `5KV7TW` 且等于 `expectedCodeSha256`，`otherChannelHits: []`（没有走文件/终端/网络作弊），`fourLinksAgree: true`。
- 桌面纪律：`desktopPolicy {capture: synthetic fixture only, screen_api_called: false, fullscreen_window: false, pointer_or_keyboard_injected: false}`、`windows_left_behind: 0`、端口 64710/64711 已关。
- 明确未测：**物理点击/输入**（故意不做，本轮授权为 `view` 且 fixture 拒绝输入）、`host_desktop.py` 的 GDI 真截屏本轮未调用。不得把此格当成“模型能操真实桌面”。
- 上一轮 `permission_blocked` 分类已更正为 `pi_installation_missing`（根因：`installations` 无 pi 项就 `next(...)` → StopIteration），原报告保留。

### L10 人格 / 长期记忆 —— NOT PASS（发现真实隔离缺陷）

- 结论（`A5`… 不，来源 `5193d2a3` 的 astra 报告）：人格三格应拆开算 —— Pi 人格保存与冻结有实证（`agent_profile.rs:477-493,3166-3185`、`agent_run.effective_config_json → $.runtime.piPurge`）；Prompt 合成有局部实证（`context/claim.rs:22-80`、`context.rs:3490-3558`，Pi 扩展回执 `providerPromptSeen:false`）；**跨 Run 记忆未过隔离验收**。
- **关键缺口**：`Companion` 表示“这个 Bot 的记忆”，不表示“这个 Bot 在这个 Workspace 的记忆”。同一 Core、同一 `agent_id` 从 W1 换到 W2，按现有代码仍能读到 W1 记录（`memory_tool.rs:129-167`、`memory.rs:2900-2965,3014-3039`、`memory_retrieval.rs:273-305`）。这是按代码推断的预期缺口，不是已观测泄漏；换空库或同时换 Bot 都会掩盖它。
- 未验收原因：下一次 Run 的入口只是 ID/Kind/检索键，不是正文（`context.rs:3963-4009`）；既有 smoke 验的是写入后重启 + 管理侧 `memory.get` 读回，不是模型在被授权的 Run 里自主 `memory.search` 命中随机标记。

### L11 Pi · Skill + Rule 两格 —— PASS（一轮双正反）

- `L11-pi-caps/summary.json`：`rule: PASS`、`skill: PASS`，两格 marker 都是 `{a: true, b: false}`（正选 Run 命中、反选 Run 消失），`missing: []`。
- Run A `0803f8bf-3f5b-4a8b-9686-64d862f00db0`、Run B `56d7ba92-75a6-431a-baed-352f3d0f1aa7`；Pi 0.85.1，Core SHA `9e123dd8…d6332c`。
- Skill 用了**原生 session 读取回执**（`nativeRead.source: pi_native_session_read`）+ 冻结材料路径 `runtime/skills/0803f8bf…/skills/l11-pi-skill-dbf86f53/SKILL.md`；Rule 用 `context_manifest.bootstrap_evidence_id → managed_blob` 重算哈希。

### L9 四端 × 四能力矩阵（首次成表）

矩阵来源：`9887c248` 的 astra 报告（逐格带 file:line）。本机 16 格中 **7 格有真实 Run 正向回执**：Pi·MCP、Pi·Skill（L11）、Pi·Rule（L11）、DSH·Skill、DSH·MCP、DSH·Rule、DSH·Hook；Codex·Skill/Rule 为历史 Run PASS；Codex·MCP 正选 FAIL 反选 PASS；Claude 整行 BLOCKED（准入策略）；Pi·Hook 与 Codex·Hook 为 BLOCKED（本地 Hook 执行范围只接受 DSH，`local_hook.rs:153`）。

**关键发现（产品承诺与代码不一致）**：文档口径说“Win11 本机不执行 Claude Code”，但准入代码给的结果相反 —— `platform.rs:59` 只映射 Windows x64、不分 Win10/11；Claude 命中 `agent_runtime_adapter.rs:911` 的 Windows 兜底返回 `qualified`；`application.rs:2521` 无 blocker；`v2_domain.rs:43` 的 discovery-only 只是注释。即：**若产品承诺“任何入口都阻止 Win11 启 Claude”，当前准入链有实现缺口**；若只是“本机约定不跑”，则需改成显式配置而非宣称强制。

### L8 恢复对账 / L12 先领后写 —— 未完成（已收工）

- L8（E6-B）：已备到 `fixture-ready → core-started → runtime-configured → mission-ready`（隔离 root、nonce `E6BEE5AFB9C2BE24289`、lease 45s、effectHold 45000ms），**未执行故障注入与重启对账**。仍记 `NOT_RUN`。
- L12（先领后写修复）：执行手开工前**主动停手**并交回设计取舍 —— 方案 (b) 需 Core 侧新桥（`application.rs` + `bin/rovai.rs` + `builtin_tool_transport.rs`），在 `pi/**` 内拿不到 Claim 权威面（`loom.rs:1269-1304` 要求独占可变 DB）。它给了两个选项：A 扩白名单走 Core 私有 IPC；B 让 Pi 侧成为 Core SQLite 第二写者（架构决定，需批准）。**未改任何代码**。

## 2026-11-18 新聊天真实续接（尚无新版签收）

本机 AgentDock 已复用原 `loom` 工作树与交接入口，未重做架构。HEAD `f24a461`，当前分支领先 origin 8 提交，原有 WIP 保留。以完整 33,844 文件 186/236 候选运行 `scripts/lib/personal-install.test.mjs` 的独立真实安装测试（`session-daf4347801e9480c98b35f2a`），当前等待原回执；`local-personal-186-install-proof.json` 尚未生成，不能宣称安装、登录、重启成功。运行路径是自动验收新隔离目录，不是升级现有应用。

回归中 `dsh-host.test.mjs` 7 个测试明确 PASS；与之同时运行的 `loom-choice-pick.test.mjs` 因 Electron 夹具被 45 秒守护终止而 FAIL（整体 7 PASS / 1 FAIL，未获得真实页面模型运行），保留 `_artifacts/delivery-20261117/resume-05/choice-pick-ui/` 中的失败证据。已对两个脚本执行 `node --check`、对现有 Git 改动执行 `git diff --check`，均 exit0，不能代替以上失败的实际验收。

本机 base、pi-skill、mindkit、huashu-design、komari-ssh、berobox 已识别；Pi Skill doctor `0.5.7` 对模型目录报告一处 Gemini 上下文大小漂移，未改用户配置。DE-BERO 经 Komari 真命令确认 Docker 29.9.0，根盘只余 270M、100% 已满，当前不宜提交新大型构建；本机 64851 与 64852 HTTP 连接实际拒绝，旧“64852 仍在线”仅是历史状态。相关操作与未决事项见根目录 `TASK.md` 最新节。

## 2026-11-18 交接收口补记

用户要求此聊天停止施工并本机交接，完整入口是 `docs/loom/archive/plans-2026-11-18/mindkit-handoff-2026-11-13.md` 顶部新节。实际新版隔离安装测试第一次240秒在全包核验阶段超时；延长真包测试预算至子流程600秒/全程900秒后，第二轮 AgentDock session `session-1c06f5d45a931f857a5f95d8` 及只读 DB 观察 `session-ae06c2e730a0d333743b505d` 在交接时均返回 `SESSION_NOT_FOUND`。无新隔离安装目录、无 SQLite、无 `resume-06/local-personal-186-install-proof.json`，**未验收安装或启动**。本地33844文件候选已组装但尚未交付，旧915ffa1/64852仍运行。下次以重新确认实时状态和实际安装、登录、重启、DB186/236为第一步；Pi Purge 模型/成果与 DSH 原生Hook等未通过项不变。

## 2026-11-18 本机真实续建（个人版仍未签收）

- **DSH 版本纠正**：用户独立 `.dsh-020rc2` 环境的 `@deepseek-ai/dsh` 和 Hook protocol 均是 **0.2.0-rc.2**；全局 PATH 上旧 `dsh --version` 才是 0.1.5-rc.2。未改用户配置。重新从匿名 npm 官方锁生成独立干净 DSH 0.2，`resume-06/dsh020-candidate-r2` 全部 **534 包 / 25,262 清单文件**闭包校验通过，独立 `dsh.cmd --version` 真机返回 0.2.0-rc.2；对应许可证来源在 `resources/dsh-runtime/license-sources.json`，其中 brotli/dfa 的同作者 MIT 来源仍须正式发行前复核其特定版权声明。原 0.1.5 DSH 包只属历史证据。
- **Hook 异步编号缺陷已修**：`crates/rovai-core/src/dsh/local-hooks.mjs` 把每次调用编号在异步工作目录等待前冻结；新增同一 root Session 两个并发 read 的 handlerId/原生双回执回归，旧代码明确失败、新代码 **DSH 7/7 PASS**。独立私有 Hook executor 仍为旧 **0.1.5-rc.2** 受限子进程，不冒称主 DSH 0.2 的原生 Hook 已实际触发；真 Windows 私有执行器 **5/5 PASS**（目录内写、越界拒绝、只读拒绝、取消排空、冻结文件篡改拒绝），Windows 只报告 partial。
- **新版实际本机构建与候选**：`resume-06/personal-186-local-build.json` 的 Windows GNU Host/Core/Server/CLI 四程序同源编译 exit0，实际 PE 8MiB 栈，目标 schema186/receipt236；生产 Web 来源固定于 `resume-05/personal-186-web-proof.json`。复用单独验证过的 Pi0.85.1 和未变更的 Windows computer 组件（160 文件，Python3.14.10 / Pillow13.0.0）。`resume-06/loom-personal-local-186-f24a461-r3` 已组装 **33,844 文件**与精确候选 manifest，来源为本地 HEAD f24a461 加受控未提交修复，**不是 GitHub E3 / 正式发行**。测试安装须用隔离目录与新数据；现有 64852 上的 915ffa1 暂不替换。
- **安装与 CI 门禁**：现有原安装脚本追加可选的 DSH 0.2 版本、文件、Node、manifest/完整树校验及受限环境绑定；保留显式用户外部程序路径。完整 `scripts/lib/personal-install.test.mjs` **12 PASS / 0 FAIL / 1 真包启动跳过**；E3 工作流合同 **13/13 PASS**。候选真机新装/登录/数据保持尚须独立验收，不能因为本地组包完成就报可用。
- **Pi Purge 真实 UI 第06轮 FAIL**：`resume-05/pi-purge-ui-06/report.json` 实际停在隔离 Host `runtime.product.check` 的 90 秒客户端超时，**无模型 Run / 无 Task / 无 Artifact**；测试脚本已将客户端等待修正为120秒，以覆盖 Core 自身90秒检查和3秒收口，但修正后尚未再次真实验收。此前 Pi CLI 参数、抛错、回执修复的7条实进程检查通过不等于这条界面链通过。
- **仍欠最终完成项**：186 新版从原安装器真实独立启动/重启与数据库升级保留、Pi Purge 从 UI 到模型 Artifact、DSH 原生 Hook 正反例、模型自主截图和 Codex 实际 MCP 调用。候选/测试数据与用户账户隔离；没有代用户接受、推送或合并。

## 2026-11-17 续开发实测（未签收）

### 最新结果：双任务返工已跑通，个人版收尾继续

- **真实工作已从页面走完**：`resume-05/current-ui-versioned-03/report.json` 使用 `1a4fd53` 的同源 Host、生产 Web 与实际 schema 185 / receipt 235。页面创建工作、模型拆成两项任务、明确批准范围与独立审查，两项都经历首稿、要求修改、原路径返工，最后两份新稿都通过审查并可在页面打开。四份新旧归档均校验通过。另以只读 SQLite 核对 12 个 Run 全成功、4 Candidate、4 Artifact、2 REQUEST_CHANGES + 2 PASS、10 派发全部 SETTLED；Candidate 仍 PENDING，Owner Review 为 0。
- **连接设置可直接填写**：`915ffa1` 把连接信息改成名称和值的输入框，值默认隐藏；需要时才展开原文编辑。重复名称、未填完的名称、放弃修改、离开提示与版本冲突均保留保护。实际 Electron 10 项通过，桌面/手机日夜四张截图已查看；助手服务 24 项、类型检查与生产 Web 构建通过。证据为 `resume-05/connection-fields-integration.json` 与 `runtime-settings-ui/run-iqGOSF/screenshots/report.json`。Pi 文件权限的界面文字简化，保存值及 Core 权限边界未改变。
- **安装包里的电脑操作已实测**：此前 `1a4fd53` 的本机验证包 6956 个文件，经真正的 Start-Loom.cmd 启动、重启与数据库版本核对。专用自建 Windows 窗口上的手动授权、查看、点击、输入、归还、断开共 9 项通过；助手独立授权、包内 MCP stdio、真实截图/点击/输入、重复请求拒绝、撤销后旧连接拒绝和 Core 配置清理共 12 项通过。见 `resume-05/computer-personal-current-summary.json`。这两组工具链实际执行，但模型 Run 数为 0；模型自行选择截图仍另验。
- **新的完整 Windows 包已构建、下载和安装**：`915ffa1` 的 E3 `44237548866` 已成功；下载后的 6955 个文件逐一核对，原 Install-Loom.cmd 已实际安装至 `%LOCALAPPDATA%\Programs\LOOM-Personal`，原 Start-Loom.cmd 首次启动的 HTTP 200 与实际数据库 schema 185 已确认。下载包在 `C:\Users\echo\Downloads\LOOM-Personal-Candidate-20261117`，证据 `resume-05/personal-final-package.json` 和 `personal-final-installation.json`。首次自动化会话退出后子进程被回收；已改为保持正常启动窗口和受管长会话，另一次独立检查确认服务仍在运行、HTTP 200、数据库 185。安装包可独立双击启动；本次自动打开的实例由该开发会话保活。该包不包含本节仍在修的 Pi/Hook。旧 E3 `44234714818`、`44235243723` 路径失败保留；真实 Win32 8.3 TEMP/TMP 路径回归 2 项通过、0 跳过。
- **Pi 三处接线缺陷已修，真实交付复验继续**：`de0c224` 补全既有八类操作的 Core 参数合同，并按真实 Pi 0.85.1 SDK 的行为把失败改为抛出错误；`bc6e287` 保留 CLI 已验证、脱敏后的机器回执，修正普通 CLI 输出被原生桥误判为无效结果。真实 CLI 进程经本地 IPC 的 7 条成功/拒绝路径通过；未改旧 CLI 仍复现原错误，普通 CLI 输出未变。两项 Rust owner 通过，新 CLI 为 8 MiB 栈。证据见 `pi-cli-machine-receipt-green.json`、`pi-cli-machine-receipt-build-v2.json`。03/04 的模型流程均失败并保留；05 在界面选择启用方式阶段超时、Run 为 0，正在修验收脚本的就绪等待和定位，不计模型通过。
- **本地 DSH 自动动作已合入主线**：`4ec09f8` / `f24a461` 提供逐项确认、真实范围检查、逐次运行冻结和配对执行回执；切换到非 DSH 的 Run 不受遗留勾选影响。DE-BERO 四项真实 Rust owner 通过，涵盖 236 迁移不自动授权、旧成果保留、审阅与回执边界、Pi/Codex/Claude 切换兼容；Root 独立核对 Git 源码与实测文件哈希。合并后前端 51 项、Node 19 项、数据库版本检查 4 项、类型检查及生产 Web 构建通过。证据为 `local-hook-01/root-source-r4-review.json`、`bero-r5-status-02.json`、`personal-186-web-proof.json`。真实原生 Hook Run 尚未通过，继续验证。
- **干净 DSH 已通过实际限制检查**：全局改装的 DSH 会绕过限制，现使用固定官方版本 0.1.5-rc.2 的独立完整运行包，真实空目录安装为 515 包 / 24021 文件。实际原生工具在目录内写入、拒绝本次目录外写入、只读拒绝写入、取消后排空共 4 项通过；Windows 如实报告 partial，不声称完整操作系统隔离。Core 原生模型目录已 READY。独立 Hook 执行包也已接入安装与完整性核对。模型截图与真实 Hook 正反例继续，零模型的限制测试不代替它们。
- **新候选在本机继续构建**：当前 `f24a461` 之后的修改尚未推送。自动审批两次拒绝 GitHub 原推送命令，核对历史明确授权、公开仓库及 ADMIN 归属后仍要求当前明确授权；没有改用其他通道发布。`github-push-auto-review.json` 保留拒绝依据。继续使用同源本地 GNU 构建和原安装器升级，不把本地包写成 GitHub E3 包。已安装的 `915ffa1` 仍是上述已通过 E3 的版本。Codex 实际 MCP 调用仍失败，Windows Claude 保留既有准入限制。

以下保留此前修复与失败记录；与上面重复的状态以上面最新证据为准。

**2026-11-17 本轮个人版收尾（以下新证据优先）**：c399 的 Windows E3 `44158565571` 已通过；本节修复与该旧包分开记录，新源码候选须另行构建验证。

- **真实返工卡点已修，整链复验继续**：`web-refresh-ui-04` 暴露同路径新内容被 Core 拒绝登记，Worker 改用新文件名又被审核要求原路径，A 任务耗尽返工次数。现按 Task/生产 Run/作者/SHA 保留同路径的不可变版本，旧 Candidate 继续指向旧归档；schema 185 / receipt 235 迁移不改历史记录。18 项针对性 Rust、68 项验收脚本与真实旧 SQLite 只读迁移核对通过，来源见 `resume-05/artifact-version-core-build.json`。整链要求两项任务最新稿都通过独立审查、原路径返工、旧归档仍可读，不能用一项任务成功代表整体通过。
- **成果界面与连接入口已修**：持续更新时不再漏文件，同一工作刷新不清掉控制表单草稿；最新版先显示，历史版保留，卡住直接显示原因。实际 Electron 29 项交互与 10 张桌面/手机日夜截图通过，见 `_artifacts/loom-v2-user-authorized-20261115/ui/run-kI0HTs/screenshots/report.json`。原连接配置编辑器已接回新壳，四运行端入口、保存后读回、草稿保留、冲突处理和桌面/手机日夜布局等 8 项通过，见 `resume-05/runtime-settings-ui/run-TcZkwH/screenshots/report.json`。两组使用生产界面和合成传输，不代替真实模型链；类型检查与生产 Web 构建已通过。
- **安装与电脑运行包已补齐**：`resume-05/personal-install-live.json` 用当前安装器配 c399 实包，实际安装、原 Start-Loom.cmd 启动、登录、重启后身份/助手/偏好保持通过。程序与个人数据分开，跨数据格式降级拒绝，启动前核对完整文件清单；缺管理脚本时明确报包不完整。原候选遗漏的 helper/bridge/Python/Pillow 已加入固定版本、哈希和许可证打包；当前电脑授权 Rust 27/27、包内 Python 43/43（另 1 项非 Windows 适用项跳过）、专用测试窗口截图/点击/输入/停止 4/4 通过。页面授权与助手真实桥接仍在验证，不能把本机 helper 成功当作整段已通过。
- **运行端结果按实际记录**：`resume-05/dsh-diagnostic-03/evidence.json` 的 Rule、MCP、原生 read 读取冻结 Skill 与反选新 Run 通过；原生 Skill 注册表仍未验证，Hook 仍 NOT_RUN。健康失败诊断修复的两条远端测试通过，见 `dsh-health-regression.json`。`resume-05/codex-capabilities-02/evidence.json` 的原生读取冻结 Skill、Rule 与反选通过；原生 MCP 目录和首轮工具声明存在，但模型实际调用为 0，MCP 不通过。Windows Claude 保持既有准入边界。旧受管接线写入的安全拒绝保留，不绕过。

**测试入口纠正**：`current-ui-versioned-01` 已停止并作废。Host 静态内嵌 Core，旁置新 Core.exe 不会替换 Host 内部实现，该轮实测库仍为 schema 184。新编译 Host 在 `current-ui-versioned-02` 已通过实际数据库 185/235 检查，但发现本机 GNU 构建主线程栈只有 2 MiB；该轮在打开 UI 前停止。现已将项目 build.rs 的既有 Windows 8 MiB 设置补齐到 GNU 与 MSVC，四个二进制重链 exit 0，PE 实读均为 8388608，见 `computer-current-host-build.json`。新增入口缺管理脚本拒绝、双工具链栈检查以及 11 项 workflow 契约回归通过。正式再跑前同时检查二进制、实际库版本和生产 Web 来源；只复用经核验未变的 Pi 运行包。新增 Host 版本与 Lead 失败提前结束检查 24/24 通过，见 `host-schema-lead-guard-result.json`。旧失败原样保留，脚本不代用户接受成果；同源候选须从本轮提交重新构建。

- 已推送 `50c998f`（容器健康探针）、`9dcbd86`（原生接力范围 UI 与候选下载核验）、`ab22407`（调度尾项结算及显式受限 Pi 工作流工具）。当前未提交修复继续保留，不等于上述提交已经包含全部后续改动。
- 本机新 Core/Host 编译完成，生产 Web 构建与类型检查完成。DE-BERO 对固定 `ab22407` 曾为 **631 passed / 5 failed / 1 ignored**，原失败保留于 `bero-core-final.json`；后续限定修复经 `resume-02/full-r2-device-observe.json` 复核为 **636 passed / 0 failed / 1 ignored**，Web Node 专项 **22/22**。这是带记录补丁的工作树验收，不伪称原 `ab22407` 已自动变绿；原 SHA Windows E3 仍失败，无最终候选包。
- 真实模型首次服务旅程曾因尾项调度未结算和错误使用可变工作区校验旧归档而失败；旧失败保留于 `_artifacts/delivery-20261116/live-lead-01/`。后续修复已由下述 `ui-07` 的同次正式 UI 旅程及独立归档复核验证，旧失败仍原样保留。
- **节点回归已取回终态**：`resume-03/bero-regression-readback.json` 确认同一限定补丁全套执行退出 0：Core 636/0/1、Web Node 22/22、Linux B1–B6 六个真实二进制进程级验收全部 exit 0。它们涵盖配对/拒绝、恢复、能力、shim、执行主机和文件，不替代当前另跑的商用模型 DevicePort 跨物理主机闭环。
- **正式 UI 同次真实旅程已通过**：`resume-02/ui-07/report.json` 证明页面创建并启动工作、模型 Lead 建两个任务、页面明确批准范围与独立 reviewer、两 Worker 首稿与返工、真实归档预览；`supervisor-verification.json` 另以只读 SQLite + 原始归档独立核对 **13 Run 全成功、4 Claim、4 Artifact/4 Candidate、REQUEST_CHANGES 2 + PASS 2、10 dispatch 全 SETTLED、重复派发 0、批准前 Worker 0**。四份归档 SHA 与字节完整，Candidate 全 PENDING，**Owner Review 0**。真实截图已检查；早期 `ui-01` 至 `ui-06` 失败原样保留。测试模型配置由隔离 setup 准备，不冒称用户从空白安装完成全部配置。
- Windows Node 真配对已证实。跨机验收首次因脚本标签非法而失败，修正后到达文件读取并暴露 Linux Host 用本机 Path 解释 Windows 根路径的缺陷；修复保留设备端路径围栏，尚待回归。证据：`bero-mission-readback.json`、`cross-workspace-valid.json`。不把 pairing 当作完整 Grant/Artifact/执行中恢复通过。

- **现代 DevicePort 真实跨机与运行中恢复已通过**：`resume-02/device-model-05/report.json` 和 `supervisor-verification.json`。Windows 本地商用模型在真实 Run 内通过已授权 Workspace RPC 读取 DE-BERO 的 device-only Node；同一 Run 在 online generation 1/2 各完成一次读取，掉线期间保持运行，重连后同一 Node 执行 `git.status` 并再次读取。主管从只读 SQLite、4 条真实 completed RPC 和原始归档独立核对：两次远端读取与源文件及 116 字节归档 SHA 完全一致，Candidate PENDING、Owner Review 0。模型凭据未发到远端；这是本地 Runtime + 远端 DevicePort，**不是远端模型推理，也不是 UI 发起的跨机用例**。本轮的旧失败（属主、回执误判、新隧道 DNS 尚未就绪）全部保留。

### 本批集成提交与当前阻断（resume-04）

- **已独立提交并推送 `b9b5f82`（40 文件）**：正式 UI 接力、现代 DevicePort 恢复、迁移修复、缓存代次和跨 OS 预览。源码核对、提交范围与测试回执分别在 `resume-04/integration-commit.json`、`tested-source-verification.json`。原 WIP、私有配置和其他研究没有打包混入。
- 第二视角指出的预览缓存目录拼接与客户端限额问题已修；主管复跑 DE-BERO Web 全库 **132 passed / 0 failed / 0 ignored**，原生 UI **322/322**、辅助验收 **107/107** 和类型检查通过。独立安全复核仅批准该两处，不冒充完整产品安全认证。
- **DSH 真实 relay 模型、Rule、MCP 和反选负例通过**：`resume-02/dsh-07/supervisor-verification.json` 独立核对原 Run 的持久 Bootstrap 原文/哈希与回复；原失败报告未覆盖。`dsh-08` 使用正式证据读取器，在运行期间捕获了选中 Skill 的冻结正文与版本，但原生 `skill()` 未加载它，Skill 仍不通过；Hook 尚无已验证传输。55 项路由/证据单测通过不能替代这两格实测。
- `b9b5f82` Windows E3 在全库门得到 **645 passed / 11 failed / 8 ignored**，没有生成个人版包。正修测试目录创建前置和 Windows 路径夹具；产品权限检查和原断言未关闭。两份 v1.72 模型上下文变更的真实人工确认仍缺失，未伪造确认字段。
- 原生 DSH Skill 接线改写的工具请求被安全检查拦截，未重试或绕过；诊断与上游原生 Provider 接口依据留在 `resume-04/dsh-skill-native-conclusion.json`。这部分未实现、未验收，不能用已有文件物化替代原生加载。

本批主要证据目录 `_artifacts/delivery-20261117/`；已通过 UI、Core 与跨机复测位于 `resume-02/`，继续施工位于 `resume-03/`。当前剩余是四端实际支持矩阵、同源候选和完整门禁；扩大 Web 全库曾得 117 PASS / 13 FAIL；限定测试前置/契约黄金值/夹具语法修复后，已从 DE-BERO 取回 **130 passed / 0 failed / 0 ignored、容器 exit 0**（`resume-04/bero-web-final.json`）。原生 UI 全量 **24 文件 / 322 测试通过**（`resume-03/native-ui-full.log`）。这些是当前带记录补丁的回归，不把旧 Git SHA 的 CI 失败改写为成功。以下 2026-11-16 的 E0–E7 表及固定 SHA 分项作为历史基线保留；本节新失败与实测优先，**不代表正式发布或最终签收**。

## 2026-11-16 历史交付位置

LOOM V2 已有 Windows 隔离预览、双真实 Core→Pi Worker、Codex 原生文件 Artifact、DSH 原生压缩、正式 Web 的两份待审结果和 GHCR→DE-BERO 隔离 Host/Web 镜像；**尚未通过完整四端能力矩阵、真实设备配对与跨机任务、运行中断线恢复、真人 Owner 验收或正式发行**。最近一次只读巡检未见日常 `64851` 监听，原因未知；本轮文档收口不更改或替换原服务与用户数据。当前已发布版本指针仍是 `v1.72`，V2 开发分支不自动切版。

## E0–E7 核验表

| Gate | 已确认的实证范围 | 尚未通过 / 不可冒称 |
|---|---|---|
| **E0 · 初始设计/合同** | 产品边界、V2 阶段蓝图与首批设计合同已建立 | 设计蓝图不等于全部 V2 正式 IDL 和数据迁移冻结 |
| **E1 · Core 与 UI** | 新 Core/协调器/Adapter、`loom-native` 工作台、能力/任务只读投影有实际实现 | 旧用户数据到 V2 的完整迁移与产品所有闭环尚未验收 |
| **E2 · 基线测试** | 此前有 Rust **76/76**、Node **78/78**、UI **67/67** 通过的阶段基线 | 此处不是对每次新改动重新跑过的全量通过声明 |
| **E3 · Windows/Linux 隔离候选** | Windows E3 [#43864920990](https://github.com/zhizhishu/loom-ai/actions/runs/43864920990)、Linux 容器 [#43864912038](https://github.com/zhizhishu/loom-ai/actions/runs/43864912038) 对 `e4a0aea` 均 **success**；`8310fcd` 预览包 **6786 文件 SHA256 一致**；旧 `7ee4fdf` E3 亦通过 | E3 主要是候选构建/模拟 Provider，非正式 Release；Linux debug Host/Web **未封包 Pi**，不代表四 Runtime 已可用 |
| **E4 · 真实模型/多 Worker** | 旧 `7ee4fdf` Pi Purge 单 Run 通过；`8310fcd` 同 Mission **两个真实 Core→Pi→DeepSeek/max Worker**，执行前 Claim/Fence、108/147 字节 Artifact、错误 Fence 拒绝、人格隔离及两份 PENDING Candidate；`6150aed` Core→原生 Codex `workspace-write`→78 字节 Artifact 通过 | **部分通过**：Candidate 由受信 Host 录入，不是自动 Lead 审查返工；正式 Web 只读查看，未从 UI 点击启动整链；DSH 原生压缩不等于 Core→DSH，Windows Claude 仅发现，四端四能力尚未全验 |
| **E5 · 跨机** | GHCR 固定 digest 镜像已在 DE-BERO 真实拉取并以 uid 10001、本机回环运行，实际认证、Mission 写入读回、未认证 API 401、受控退出和同卷重启持久化通过 | **未通过**：镜像不含 Pi；没有 Windows Node 真配对、授权跨机工作区/工具任务、Artifact 回传及失联恢复 |
| **E6 · 恢复/副作用** | 已完成 Pi Artifact 恢复 **3/3**；DE-BERO Host/Web 同卷重启后 Mission/Thread 与登录数据保持 | **部分通过**：已完成成果与 Host 存活性，不代表执行途中断线、旧 Lease/Fence、未知副作用及跨机续执 |
| **E7 · 用户验收/发行** | Windows 候选和 Linux debug 镜像已出；正式 Web 能读两份真实 Artifact 并显示 Review 控件，Candidate 仍为 PENDING；[PR #17](https://github.com/zhizhishu/loom-ai/pull/17) 为 Draft | **未通过**：Owner Review=0、尚无正式 Release、日常升级/回滚及真人签收；自动化鼠标不代用户接受 |

## 跨仓接口与个人版门禁分项（2026-11-16；基于既有证据，非新运行）

> 以下 PASS 仅指固定源码或原生专项的**单切片**；本轮更新计划和接口文档，没有再次启动模型/设备。FAIL / NOT_RUN 不得折算成整体百分比，用户 Owner 仍未签收。

| 验收切片 | 状态 | 证据及不应扩大的边界 |
|---|---|---|
| E4-A 双 Pi Worker、执行前 Claim/Fence、108/147 字节真实 Artifact | **PASS** | `8310fcd`，`_artifacts/loom-personal-delivery-20261116/dual-supervisor-verification.json`；Candidate=PENDING |
| E4-B Core→Codex 原生 workspace-write 真实文件 | **PASS** | `6150aed`，`codex-supervisor-verification.json`；不等于 Codex 全场景可写 |
| E4-C DSH 原生压缩和故障专项 | **PASS（原生专项）** | `dsh-supervisor-verification.json`，`CoreIntegrated=false` |
| E4-D 生产 Web 已有 Artifact 的正文和 Review 控件展示 | **PASS（只读展示）** | `production-ui-verification.json`；不含 UI 发起真实 Run 和 Owner 接收 |
| E4-E Lead 自动拆 Goal / 从正式 UI 发起全旅程 / 自动返工 | **NOT_RUN** | 两个 Host 受信启动 Worker 不能替代此项 |
| E4-F 四 Runtime × 四能力完整 Loaded/Invoked/Evidenced | **NOT_RUN（完整矩阵）** | Pi/Codex/DSH 分项不代表全部 16 格；Windows Claude 仍不执行 |
| E5-A DE-BERO Linux Host/Web 登录与 Mission 持久化 | **PASS（分项）** | `e4a0aea`，`bero-container-supervisor-verification.json`；镜像无 Pi |
| E5-B Device Node 真 pairing、Grant、跨机工具、Artifact 回传 | **NOT_RUN** | TLS/登录不能当配对 |
| E6-A 已完成 Artifact 与 Host 重新启动持久化 | **PASS（分项）** | 已有 3/3 已完成 Pi 成果恢复和 Linux 重启证据 |
| E6-B 执行途中掉线、旧 Fence、未知副作用对账 | **NOT_RUN** | 完成后能读不代表中断时安全恢复 |
| E7 Owner 真人 Review、正式 Release、升级与回滚 | **NOT_RUN** | Owner Review=0；不以脚本代签 |
| 旧 v1.72 通用文档 CI 人工确认 | **FAIL（历史已知）** | 两份 `model-context-change-loom-*` 缺真实 `confirmed_*`；不得自动造批准 |

今后每条验收至少绑定 **Git SHA、实际 Runner/Runtime、Run/Grant/Fence、原生结果、Artifact SHA、PENDING/Review 状态、负例与退出码**。正式字段/错误码只能在既有 Contract 内冻结；不能因为这份治理附注出现某词，就宣称新字段/新功能已实现。


## 2026-11-16 最新分项实测（固定源码 `6150aed` → `8310fcd` → `e4a0aea`）

> 以下结果取自本机 `_artifacts/loom-personal-delivery-20261116/` 的**主管复核 JSON**及相应 GitHub SHA；与后面的 `7ee4fdf` 历史单 Run 记录分开保留。原始会话/凭据不上传 Git。

| 验收切片 | 实际证明 | 未证明 |
|---|---|---|
| **双 Pi Worker** · `8310fcd` | `dual-supervisor-verification.json`：同一 Mission 两个 Core 创建的真实 Run，`deepseek-v4.1-flash/max`，两个 Claim **都早于 Prompt/文件写入**，14.8 秒执行重叠，108/147 字节独立 Artifact；错误 Fence 被拒、人格隔离，两份 Candidate **PENDING**，Owner Review=0 | Candidate 由受信 Host 提交，非自动 Lead 规划与审查返工 |
| **Core→Codex 文件** · `6150aed` | `codex-supervisor-verification.json`：真实原生 `workspace-write`（无网络），78 字节真实 Artifact、输入标记、Run succeeded，权限冻结与有效回读一致 | 只是一个真实文件任务，不等于全机权限或四能力可用 |
| **DSH 原生压缩** | `dsh-supervisor-verification.json`：压力触发、溢出自动重试、usage、取消/失败不破坏状态、冷启动恢复六类检查通过 | `CoreIntegrated=false`，不能冒充 Core→DSH |
| **正式 Host/Web 待审 UI** · `8310fcd` | `production-ui-verification.json`：真实 Bearer 登录，两个已生成的实际 Artifact 可预览正文和 Persona/nonce，Review 控件可操作，未认证 API 被拒 | **只读查看**，不包含 UI 发起模型任务，未代用户点击接受 |
| **候选构建与实机 Linux** · `e4a0aea` | Windows E3 [#43864920990](https://github.com/zhizhishu/loom-ai/actions/runs/43864920990) 与 Linux 镜像 [#43864912038](https://github.com/zhizhishu/loom-ai/actions/runs/43864912038) completed success；`download-verification-8310.json` 证明 6786 文件闭包完整；`bero-container-supervisor-verification.json` 证明 DE-BERO 按 digest 拉取、登录/真实 Mission、同卷重启保持 | Host/Web debug 镜像无 Pi；没有设备 pairing、跨机工具；同 SHA 通用 [CI #43864920977](https://github.com/zhizhishu/loom-ai/actions/runs/43864920977) 仍失败 |

**实际镜像不可变引用**：`ghcr.io/zhizhishu/loom-ai-server-candidate@sha256:82a58638f459ef679f68315c03d96b9abfaf044ff4d0e64d4981421d6674cee0`。仅作为已部署的 **Host/Web candidate**，不是全功能个人版发行包。
## `7ee4fdf` 阶段：Pi Purge 与真实上游原始实证（历史记录）

| 交付 | 实际结果 | 边界与证据 |
|---|---|---|
| 本地架构图 | 已原位写入 `LOOM-V2-MASTER-PLAN.md` 的 B 节，Pi Purge 独立列入 4–6 周范围 | 产品目标图，不是所有功能已交付的状态图 |
| 原生上游协议 | DeepSeek V4.1 Flash/max 的 Chat、Responses、Anthropic **3/3** 真实请求通过 | 是三个协议通道，不是四个 Core Runtime 已完成；`provider-matrix-results.json` |
| 受管 Pi Purge 原生适配 | 新 `scripts/loom-v2-pi-purge-extension.ts` 与对应测试；固定原版 v0.3.0/SHA，Off/Append，按运行身份校验，重启后重新激活、拒绝漂移 | **78/78** 适配/桥/原钩子/stage 回归通过（含回执失败时不应用 Persona）；原有模拟桥仍明确模拟 |
| Pi Purge 真模型效果 | 早期原生三协议 Append + Chat Off **4/4**；本轮另完成真实 Core Append 与 Off/冻结控制各一例 | 早期 4/4 使用测试 Binding；本轮 Core 自建 Binding 证据单列下行，不能把几种不同验收相加为全产品完成 |
| Codex 权限事实修复 | 无模型请求的原生探针复现：workspace-write 请求返回 readOnly；已新增线程绑定/发 Prompt 前拒绝不一致的补丁 | 不修改原生权限、不强行开启写入；Bero 同提交的纯策略与进程边界回归 **2/2**，GitHub Windows 同一策略回归亦通过 |
| 可选扩展候选封包 | 保留上游 LICENSE/源码/SHA；默认 Off；`7ee4fdf` 下载包包含正确的 `runtime/extensions/pi-purge` 布局并通过全闭包哈希校验 | 不复制真实 Persona/账号/会话；不等于正式安装或日常升级 |
| Mindkit | TASK/PROJECT_CONTEXT 只留当前工作流与稳定约定，旧原字节与哈希归档；写入门/完整性检查通过 | 只写 LOOM 子项目，不写父 skill-cli 或全局默认 |
| **本轮 Pi Purge 接线与隔离闭环已验** | 助手服务 UI 34/34、原生78/78、新增 Rust 库测试1/1；Core 保存/冻结 Persona、真实新会话激活和 applied 回执、真实文件、Artifact 及 PENDING Candidate 均已核验 | Mindkit 本次冲刺 **5/5（100%）**；不是全个人版。UI自动测试/E3与真模型Core API切片分别记账，未冒充同一次真实UI点击旅程；TypeScript/Web构建属于此前同源码已通过记录 |

先前源码已分两次提交并推送：`d666c51`（适配器/权限回读/候选包）和 `5fc9142`（回执不可写时拒绝应用）。两次提交各自的完整 Windows E3 均通过；此前 `5fc9142` 本机 **78/78 + 新隔离目录真模型4/4**，GitHub run `43835826323` 的固定源码编译、Codex 策略回读回归、正式 Host/Electron E3、含隐藏依赖的 **6786 文件下载后闭包校验**全部通过，证明文件已取回本机。通用 CI 仍因既有 v1.72 真实人工确认元数据缺失而红；没有伪造批准或把 E3 写成完整 E4/E7。

上述早期原生增量的原始结果在 `_artifacts/loom-purge-next-20261116/`，不再新建交接书。`provider-matrix-results.json`、`purge-live-results.json`、`purge-unit-final.log`、`codex-policy-probe.json` 是相互独立的证据；本轮过程保存了实际失败与 Root 修正，不以工兵自报代替结果。

### 本次闭环收口证据（固定源码 7ee4fdf）

现有认证通过正常 Pi Skill 环境引用复用；未提取、外发或替换日常凭据。主管只读核对隔离 SQLite、原生 Pi 会话和实际文件：Append 的 Persona 随机标记未出现在用户消息中，却进入真实 **122 字节**成果；原生模型记录为 `deepseek-v4.1-flash`、思考档位 `max`。Artifact/归档预览/Candidate 哈希均为 `73cb63c2fe89bf117bcc6187769e804a53c74d94e75c8e0a04a2ded002e7f2aa`；Candidate 为 PENDING/UNVERIFIED，Owner Review 为 0。另一个独立 Off 用例在运行中保存 Append，数据库确认当前 Run 仍冻结 Off，成果无 Persona 标记，Candidate 同样待审。

原始证据与主管复核在 `_artifacts/loom-purge-ui-core-20261116/`：`supervisor-verification.json`、`off-freeze-verification.json`、`real-artifact-recovery.json`、`download-verification.json`；Rust/UI/Node 日志分别为 `rust-purge-resume.log`、`ui-resume.log`、`native-resume.log`。Host 配置目录可能在恢复启动时清理，激活及 applied 原始回执保存在归档的 `live-evidence-r2.private.json`，不声称重启后又读到了已清理原文件。原始会话与私有报告不随公开 PR 上传。

保留失败边界：首次在 `runtime.product.check` 超时，未创建 Run；编译结束后同命令、同安全门、全新隔离根重试通过，不能据此断言超时根因。补充 Host Rust 过滤命中 **0 测试**，不记作回归通过。本轮 Claim 为完成后取得、Artifact/Candidate 由受信本地 Host 验收入口提交；不代证执行前租约、自动 Lead 派工或用户最终认可。既有 7 个受保护文件哈希及日常监听归属未变。

## 下一段执行工作流（旧 P0 双 Worker 已实测，继续完成用户旅程）

**当前链路**：助手选择 Persona/Purge → Core 校验并冻结 Run Binding → 原生 Pi 激活 → 真实模型与授权工具 → Artifact/Candidate → 用户 Review。

| 顺序 | 实施位置 | 下一项必须实际出现的结果 |
|---|---|---|
| 1 | Lead 自动规划 / Review 返工 | 在已通过的两个真实 Worker 及执行前 Claim/Fence 之上，证明 Lead 可以按用户 Goal 自动拆分、分配、拒绝及重新派工，不重复做已完成的受信 Host 双 Worker 测试 |
| 2 | 同一次正式 UI 用户旅程 | 从助手/能力/Persona 保存→真实 Core Run→两个 Artifact→用户 Review；补 Pi Purge 无 Guard、错 Bot、旧 epoch/Applied 回执失败反馈 |
| 3 | 四端 × 四能力 | Pi/Codex/DSH/Claude 按平台实际支持，分别验证 Skill/MCP/Rule/Hook 选择→冻结→装载→调用→证据；DSH 单独压缩与 Codex 单文件已通过，不能代替整矩阵 |
| 4 | 真设备与恢复 | DE-BERO Host/Web 已部署；继续 Windows Node pairing、Grant、真实跨机工具回执、Artifact 回传、断线与旧 Fence/未知副作用 |
| 5 | 个人版发行收口 | 安装迁移与 dry-run、升级/回滚、日常实例状态确认、真人 Owner 审阅；完整 E7 未通过前不得标 100% |

## 阻塞和独立待验（不重复创建交接）

- **Codex 实效已补单切片**：先前 workspace-write 请求被原生回报 readOnly 的失败历史保留；`6150aed` 经独立受控 unelevated 原生沙箱得到真实 `workspace-write`，写入 78 字节并归档。尚不能推广到任意主机或完整四能力。
- **协作下个缺口**：`8310fcd` 双真实 Worker、执行前 Claim/Fence、两份独立 Candidate 已核验；仍欠自动 Lead 规划/返工、从正式 UI 启动的完整操作链、四端四能力实际 Load/Invoke 证据。
- **Purge 配置与反例**：当前通过用例显式使用 Core workspace 文件 Grant；Append 与无 Grant 的原生权限组合仍是运行时拒绝，配置期反馈待补。只读审查提出激活回执缺专属代次、Core 未将 applied 回执作为强制门禁的风险，尚未完成相关故障反例；不以本次正向通过消除此风险。
- **DSH/跨机恢复**：DSH 原生 0.1.5-rc.2 的自动压力压缩、溢出重试、用量、取消/失败隔离及冷恢复 **六类通过**；`CoreIntegrated=false`。跨机配对/工作区 Grant/真实工具任务与运行中故障恢复依然缺证。
- **治理门禁**：Windows E3 与 Linux 容器对 `e4a0aea` 均通过；通用 [CI #43864920977](https://github.com/zhizhishu/loom-ai/actions/runs/43864920977) **failure**，两份旧 v1.72 `model-context-change-loom-{productization,run-bundle}.md` 缺真实人工确认元数据，不得伪造 `confirmed_*` 消红。
- **发布边界**：GitHub 候选与 GHCR Linux debug Host/Web **不等于正式 Release**，镜像不含 Pi。最近 64851 监听缺失原因未明，不因文档整理启动替换日常进程；User Owner 必须亲自审阅。

## 证据、历史与更新规则

- 真实模型及恢复原始记录：[LOOM-LIVE-ACCEPTANCE-2026-11-16.md](docs/loom/archive/plans-2026-11-18/LOOM-LIVE-ACCEPTANCE-2026-11-16.md)；本机隔离证据位于 `_artifacts/loom-live-resume-20261116/`，包括 `real-pi-file-artifact-summary.json`、`real-artifact-recovery.json`、`codex-native-summary.json`、`fixed-package-local-verification.json`、`bero-tls-admission.json`；含私有数据的文件不可随 PR 上传。
- 早期 P0–P7 产品化阶段、旧施工/交接和实验纪录已 [归档](docs/loom/archive/legacy-plans-2026-11-15/README.md)，其中 [旧版实施全文](docs/loom/archive/legacy-plans-2026-11-15/LOOM-IMPLEMENTATION-history-2026-11-13.md) 只用于来源追溯。
- 后续**只更新本页当前状态及证据链接**；产品边界归 PRODUCT、UI 归 DESIGN、接口归 productization-interfaces、参考 SHA 归 REFERENCE-LOCK。不要再开新的“总交接”“最新计划”“进度看板”抢占权威。
