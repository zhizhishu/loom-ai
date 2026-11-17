# LOOM Mikka-first 实施阶段交接 — 2026-11-15

> **历史归档 / EVIDENCE_ONLY / 不再作为 Core V2 施工指令。** 用户最新要求「本轮只整理架构、不开工」，后续唯一入口：[LOOM V2 总计划](../../LOOM-V2-MASTER-PLAN.md)。此文件原始正文与当时测试结论仅作历史证据；原字节 SHA256 快照在 [历史归档](README.md)。**不得依据下文旧“已授权开工/唯一入口”重新派工**。

> **当前状态：IN_PROGRESS · 实施获用户最新授权 · P0/P1/P2 三阶段完成，P3 最小真实链路局部 E3 PASS。** 请勿把此文档当作全部产品完成/已部署。项目 root：`C:\Users\echo\Downloads\claude\skill-cli\loom`。主任务：AgentDock `tsk_407c504cc8494d6d`；进度可视化 HTML：`docs/loom/loom-mikka-first-progress-2026-11-15.html`。用户明确优先可用、可多 Pi 工兵、可重构与隔离编译；Windows 11 不运行 Claude Code；原 64851 服务和既有 WIP 须保留。

## 1. 从这四处进入

1. `PROJECT_ID.md → AGENTS.md → docs/README.md → docs/versions/README.md` 先认清仓库与当前版本权威；进入具体任务再读对应 Contract / `DESIGN.md`。
2. `TASK.md` 顶部“最新执行授权”，`PROJECT_CONTEXT.md` 顶部，再读 `LOG.md` 首个 2026-11-15 里程碑。
3. `docs/loom/loom-mikka-first-execution-plan-2026-11-15.md`（工程版）、`loom-mikka-first-worker-orders-2026-11-15.md`（工兵精确 allowlist）、`loom-mikka-first-acceptance-2026-11-15.md`（T0–T22）、`loom-mikka-first-plain-language-2026-11-15.md`（用户版）。
4. `docs/loom/loom-mikka-first-execution-board-2026-11-15.md` 和同名 `progress-2026-11-15.html`（阶段快照/视觉化，非 live control plane）。真值：原始日志、PI run status、Git diff、设备回执，不用主观“完成率”。

## 本轮本机参考 Git 镜像实证（9 个 pinned HEAD）

本次只读执行 `git -C <reference repo> rev-parse HEAD`，在 `_artifacts/loom-execution-20261115/reference-heads-verified.json` 保存了九个仓库的**本机当前固定 HEAD**；其 manifest SHA256 为 `030321DC2FBEA0770F3EC48CDDE8CAE14667FC67CC7D7AB9FA52CF6A64ED7FDB`。记录是**本机快照验证**，不声称与远端 `main` 此刻一致、没有自动 `fetch/pull`、不会覆盖参考源码。Mikka `d59c85cb...`，MindFS `6768bc1e...`，AgenTeam `d12b5076...`，MOVO `e16174ac...`，DeskFleet `098485a4...`，UFO³ `eae3c0a8...`，DSH `39163dd3...`，Pi `ddaa0a03...`，PiBot `8b9f3d7a...`；完整 40 位 SHA 见 manifest，源码锚点在 `architecture-discussion-master-plan-2026-11-15.md`。

## 2. 保全事实和受保护区域

| 对象 | 事实 |
|---|---|
| 项目 Git | `rovai/loom-b6-b9-integration-20261104`，HEAD `65fcb85265fe208c43d7999b320fc7302ece67fa` |
| 主工作树五 WIP | `apps/desktop/src/renderer/src/loom-native/Inspector.tsx`、`product.css`、`crates/loom-node/src/{lib.rs,process_wire.rs,session.rs}`；没有将本轮工兵源码 cherry-pick/merge 进主仓 |
| Baseline 备份 | `_artifacts/loom-execution-20261115/baseline-five-wip-files/` 为 **逐文件原字节**；`baseline-five-wip.patch` 原 PowerShell 输出换行在 `git apply` 无法直接用，不要依赖；另有 `baseline-untracked-docs/` 共 7 份旧交接 |
| 运行服务 | 最后复核 `127.0.0.1:64851` reachable=true，未重启/替换；本轮测试用随机 loopback，隔离数据/临时进程并退出 |
| 原始品牌图 | 图片三未存在已核对本机资产中，不能声称透明 alpha Logo 或 favicon 已实现 |
| 模型渠道 | Pi Skill 本机原配置 `oct-chat/deepseek-v4.1-flash`/max 已真实运行；doctor 的模型目录 drift 保留；从未暴露或输出 API Key；Win11 未运行 Claude Code |

## 3. 真正完成的东西、证据等级

| 条目 | 结果 | 证据路径/解释 |
|---|---|---|
| 五份正式方案+Mindkit | PASS / 文档 | `docs/loom/loom-mikka-first-{execution-plan,worker-orders,acceptance,plain-language,execution-board}-2026-11-15.md`，本交接和 HTML 静态进度 |
| Pi 三 Scout | COMPLETED | Device `a1248983965948ef838ac3c912e2a454`；Runtime `c18b96e648a64162bb33db17ffd66920`；UI `e9b3389e886a4c908cc0769d581e880a` |
| W10 Node 工兵 | DONE_AWAITING_APPROVAL | PI `408797af3b71482dafd1473c1d91b0d2`，`worktrees/node` 中仅改 `session.rs` fake_server 测试 close/flush/drain；不是 10053 最终修复证明 |
| W11 Protocol 工兵 | DONE_AWAITING_APPROVAL / E2 PASS | PI `f3618c224e99477282f5a965f627cf53`；`worktrees/proto/crates/loom-protocol/src/device_grant.rs` (~1250 行) + `lib.rs` 模块登记一行；全部 33/33 Rust lib tests 通过；`device_grant.rs` 内首句 `UNWIRED_PROPOSAL`，目前**不属于运行时授权事实** |
| Supervisor Git 只读工具 | E1+binary BUILD PASS / 新 E2 NOT_RUN | `worktrees/node/crates/loom-node/src/workspace_rpc_wire.rs`、`workspace_authority_tests.rs`、`crates/rovai-core/src/workspace_rpc_authority.rs`：复用 R2，固定 Git 只读三工具 `git.status`、`git.log`、`git.diff.stat`；禁止任意 `shell.exec`。新 Rust 测试未跑到断言，未签 E2 |
| 新 Node 二进制 | BUILD PASS | `_artifacts/loom-execution-20261115/builds/loom-node-device-only.exe`；SHA256 `B9FC8D0963B8A2130D44AF1E86ECCFF735DC089D8D484F5D90A69CAB8E8B9138`；原 build log `node-build.log` |
| **真实 Device-only FilePort** | **E3 PASS** | `_artifacts/loom-execution-20261115/pure_device_fixture.py` 真独立 Host/Node 两进程；`pure-device-runs/3d1ec28e1a214fc5827c11a678b4c795/pure/evidence/e3-proof.json`：真实 WS pairing、HTTP file list、read 44B、`../outside` 拒绝、`clis=[]`、`activeRunCount=0` |
| 旧预编译 Node 库测试 | HISTORICAL E2 55/0/2 | `node-prebuilt-full-baseline.log`；旧 binary Nov 14，与当前候选新源不同，不能用来替代新源 PASS |
| 新 Node lib test | NOT_RUN (bounded timeout) | `node-10053-repro.log`：大量 Rust `rovai-core` dev compile 被 AgentDock 超时中断；无断言结果，10053 历史偶发仍未归档 |
| 文档门禁 | FAIL / 既有治理缺口 | `docs-check.log`：两份 v1.72 model-context-change 文档缺 confirmation；不伪造 confirmed |
| Bero Cloud build | BLOCKED | Komari 真实 `df -h /` 显示 196GB 已用 100%，free 0；Docker 已装但不得删除他人镜像数据或强行部署 |
| Cloud Linux A ↔ 物理 Win B | **E5 NOT_RUN** | 现有 E3 是**同一 Windows 设备的两个进程**，不是网络跨物理设备；且没有 Bot/AgentRun |
| Bot→AgentRun→Receipt→Artifact/Review | **NOT_RUN** | 此业务领域闭环仍需 Core Router + Device Grant 真接线 |
| Computer/Browser/Mac/Linux/Logo | **NOT_RUN / 部分 blocked** | 不以已有代码或审查报告充当真跨设备/UX 验收 |

注意：即使两个进程运行在一台机器，E3 也是真实 socket +真实磁盘，不是 mock；但不得称 E5。

## 4. 运行和恢复工兵环境（不覆盖主工作区）

- **Node 写入专属**：`_artifacts/loom-execution-20261115/worktrees/node` detached Git worktree，已继承历史 Node 三 WIP 的逐文件字节；Supervisor 额外改动三处 Git/R2 相关文件。不要对该 worktree 执行 `git reset --hard` 或 `git clean -fd`，历史 WIP 是工兵基底。
- **协议写入专属**：`_artifacts/loom-execution-20261115/worktrees/proto` detached Git worktree，只有 `crates/loom-protocol/src/device_grant.rs` 和 `lib.rs` 是新增源码。其 1250 行可供抽取裁剪，必须在 W12 集成前由主管评估是否过度设计。
- **Pi Skill**：`python C:\Users\echo\.claude\skills\pi-skill\pi_skill_cli.py status --root '<exact worktree>' --session-id '<exact ID>'`，仅在适当工作区查看状态；回执现在已经完成，不能谎称后台有持续工兵。新工兵必须在独占目录/分支开始，`--tools file,write`（需要命令由主管 AgentDock 执行），模型 `oct-chat/deepseek-v4.1-flash`，`--reasoning max`，严格文件 allowlist。
- **主控唯一 owner**：AgentDock `tsk_407c504cc8494d6d`，按 checkpoint 推进，不要标 final review complete 直到所有终态有证据。

## 5. 下一批具体接力，快速可用为先

### W12 Core Integrator — 原先两文件范围已实证不充分，转 W12A/B/C

**2026-11-15 新事实（W12 Scout/Worker 已完成）**：原先限制在 `remote_artifact.rs`/`application.rs` 的安全实现不可行，因为 Run frozen target 非空 CLI installation + 远端 evidence transport 依赖 `remote_runtime_services.workspace_transport()`，与 E3 Web `nodes.rs::workspace_files` 使用不同通道。工兵以 `STATUS: STUCK` 结束，没有修改 `application.rs`，只留下 `worktrees/core/remote_artifact.rs` 安全加固候选，**未构建、未测试、未 merge**。不允许通过伪造 installationId 或绕过 freeze_run_target 解决。**立即改派** [W12 DeviceInvocation 独立身份 / 传输桥接 / Core 集成三工单](loom-mikka-first-device-invocation-seam-2026-11-15.md)，先冻结跨模块接口，再在隔离工作区并行实施并严谨测试。以下原 W12 思路保留作历史参考，不能直接让工兵套用。

1. 在第三独立 Git worktree 划定 `crates/rovai-web/src/nodes.rs` / `workspace_rpc.rs` 等 **唯一写 owner**；先只读现有 2 条真路径：`nodes.rs:2339` 的 `workspace_files` Web→Node remote FS（E3 已证），和 R2 `workspace_rpc.rs` 的受控工具 dispatch + 回执。不要重做 WebSocket 或建立第二个 Coordinator DB。
2. 设计最小 `Bot Goal/RunAttempt → DevicePort tool → Receipt → Evidence/Artifact`：先一个安全只读 File（承接 E3）和一个受限只读 Git 工具；Core business owner 需校验来自**真实登录 Session**、Mission workspace、设备在线、Grant 代次、固定命令版本，**设备端复验 Grant**；模型话语或请求体自报授权无效。
3. 待 W12 真 Core integration 测试通过，再把 `worktrees/proto` 的 `DeviceGrant` 内容*审查后选择性接入*；不要因为 33/33 E2 就将它当安全 boundary，先最小字段再扩。
4. 用隔离 DB、stub Runtime 或本机 Pi 工兵真调用跑 E4，验证失败/取消/断线 `unknown_outcome` 无自动重试；使 Artifact/Review 可从 Core 查询回证据。直接跑 T2/T4 分项，并保留原 64851 未切换。

### W13 物理跨机 — E5 必过（W12 之后）
- Bero 确认剩余磁盘空间后才放隔离镜像/仓库；**当前 0 free，必须另选资源或由主人对 Bero 存储先行治理**。绝不自动 `docker prune`/删旧镜像/删生产卷。
- Linux A 跑 LOOM Core/Cloud Pi，Win B 只跑签名 `loom-device`，无 Pi/DSH/Codex/Claude；出站 WSS/TLS，用户本地配对；以网络、实际设备 ID、真实 Root、Grant/Receipt、Artifact ID 完成验收，不拿本机两个进程冒充。
- macOS C, Linux D, screen TCC/RDP/Wayland 是后续增量，不阻塞首个 A↔B FilePort/Artifact。

### 并行 W20/W21/W31
- Pi/DSH 同模型且同权限隔离实验，由不同工兵 owner；不能因为 DSH Cordis 看起来高级就强换 Pi，Pi 仍可默认。凭据取本机 Pi 已配置的受管通道（无需输出 Key），Win Claude Code 禁用。
- UI 只改 Hero/眼动/右栏 Tab 下移、resize；用户图三尚未从本地找到，不虚构制作完成；未来要使用原始粉发绿眼猫耳图作为真 alpha 左上品牌 logo/favicon，Bot 身份独立。

## 6. 禁止误用的“通过”

- `E2 33/33 protocol` ≠ Grant 可从云端发到设备且能撤销。
- `cargo build Node exit0` ≠ 新增 Git 工具的行为测试通过。
- `E3 same-host device-only` ≠ `T2/T4 E5` 或 Bot→Artifact 用户可用。
- `Bero Docker 存在` ≠ 当前能编译或服务器已部署。
- `用户给所有权限` ≠ 将 API Key 打进 argv、日志或 Git；也不允许 Windows Claude Code 实际运行。
- `右上 Hero 旧 WIP` ≠ 用户指定的图三抠透明、眼动头像已进入当前 64851 页面。

## 7. 恢复时用的一条安全证据检查

```powershell
# 本 Windows 项目根执行，只读检查
git status --short --untracked-files=no
Get-Content docs\loom\loom-mikka-first-execution-board-2026-11-15.md -TotalCount 30
Get-Content _artifacts\loom-execution-20261115\protocol-full-tests.log -Tail 8
Get-Content _artifacts\loom-execution-20261115\pure-device-runs\3d1ec28e1a214fc5827c11a678b4c795\pure\evidence\e3-proof.json
Test-NetConnection 127.0.0.1 -Port 64851 -InformationLevel Quiet
```

恢复顺序：先核对 Host service、五 WIP 的 hash、worktree diff，再执行下一步；已有 Pi worker 已结束，不能按旧 session "running" 重新推断。不要在现有数据根跑 E2E；`pure_device_fixture.py` 每次自动开独立 run 目录并只关闭它创建的子进程。

**阶段结果**：本轮已经交付了**真实可工作的无模型 Node FilePort 基础链**（E3）和本机可复核协议候选、静态进度板、Mindkit 工兵交接；**未交付完整跨物理机多 Bot 产品**。这才是本轮下一接手人应当承认的准确边界。
