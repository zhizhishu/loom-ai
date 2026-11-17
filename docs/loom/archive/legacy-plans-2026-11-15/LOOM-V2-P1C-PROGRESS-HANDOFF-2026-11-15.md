# LOOM V2 · P1-C 阶段进度与接手交接（2026-11-15）

> **Latest independently verified increment (2026-11-16):** [Real upstream execution and delivery acceptance](../../LOOM-LIVE-ACCEPTANCE-2026-11-16.md). This supersedes older claims that E4 is entirely fake-provider-only or that no candidate was pushed; it does not sign off full E4-E7. User has explicitly re-authorized current implementation.


## 【最高优先级续建指令｜2026-11-16｜只在 4–6 周单用户可用版完成后向用户做常规汇报】

> **用户最新明确要求**：不要每跑一会儿就找用户讲话、展示局部测试或宣布阶段完成。总指挥应在每次实际获得执行环境的工作轮次里连续开展研发，主动派发 Pi Skill 工兵、使用 Base Skill 路由、自己解决普通错误并复测；**不要因一个任务、一个 Worker 或一组测试通过就停止本轮施工**。正常进度只记入本机任务/日志/交接，**仅在达到下述完整用户可用验收时主动向用户报告成果**。
>
> **现实执行边界**：这是交接与沟通纪律，不是“ChatGPT/AgentDock 已具有无限时长、离线不断运行”的证明。单次会话/工具调用/计划任务都有生命周期；一轮结束、电脑不可用或权限不足时必须留下真实断点和下一次可执行命令，不得声称仍在施工、偷偷创建常驻进程或绕过宿主 Job。已有按小时条件续建任务只代表尝试续建，**不保证每小时可连上 Windows，更不能保证 4–6 周内如期完成或完成后必定能主动发出通知**。用户需要授权的高风险边界不能因为“别打扰”就被跳过。

### 何为“4–6 周版本完成”（唯一常规回报触发门）

以 [LOOM V2 总蓝图 P0–P14](../../LOOM-V2-MASTER-PLAN.md) 及原 27 页 PDF 的**单用户可用版**定义为准；不能靠局部 E3、假 Provider、测试覆盖数、截图或 Worker 自报代替。至少提供以下**用户可以亲手操作并有真实证据的闭环**：

1. **Mikka 原生三栏工作台**：用户在 UI 创建/编辑长期 Bot，安排主助手和副助手，拉入群聊；能指定默认工作目录并按显式授权访问其他目录，不要求用户研究命令行。
2. **四运行端和四能力的诚实产品入口**：Pi、DSH、Codex、Claude 有对应可发现/选择/说明与实际支持矩阵（包括 Win11 Claude 当前禁执行的明确状态）；Skill / MCP / Rule / Hook 可配置、冻结、加载及调用，并用真实回执区分“选中/加载/真正调用/不支持”，不能靠同一套 Claude 全局配置冒充四端全部生效。
3. **真正派工和交付**：用户在 Mikka 交给一个 Goal，Core 在**单一权威库**内调度至少两个独立 Worker、记录 claim/lease/fence/Run、实际运行受控工具/工作区；成果落成能打开的真实 Artifact，验证结果和失败/重试可追溯，不能靠模拟模型回复宣称已完成。
4. **真正的用户审批**：在 UI 可以查看待审核产物、批准/拒绝/要求返工；Owner Review 身份、授权和技术验证分开，工兵不得代用户自动批准。
5. **设备和恢复的可用性**：按原单用户范围跑通过至少独立实体的跨设备/Device-only 工作与失联、重启、过期租约恢复，用户能延续 Bot/Goal/成果；必须有 E5/E6 真实验收，不能用同机双进程冒充跨设备。
6. **交付门禁**：E4 真实受管 Runtime/工具调用、E5 跨设备、E6 故障恢复、E7 可运行版本及必要的安全/回滚/观测证据均实测通过；已知的关键 UI、Core、文档门禁失败要有明确结论。**不把 P14 企业多用户完整实现和完整 macOS GUI 作为此单用户版本的伪前提**，但未来兼容边界必须保留。

**最终才汇报**：给用户实际可用的启动入口、操作步骤、真实验证报告（命令、退出码、产物路径/设备、关键负例）、仍不支持的能力清单。未满足时维持 **IN_PROGRESS / NOT_VERIFIED**，不以“完成 80% / 已准备好交接”诱导用户验收。

### 执行与沟通纪律（总管 / 后续 Agent / Pi 工兵）

- **持续推进而非分段聊天**：每次连接本机就先读 `AGENTS.md`、`docs/README.md`、`TASK.md`、`PROJECT_CONTEXT.md`、本交接和 `docs/development/local-workflow.md`，检查 WIP 与真实设备；直接走当前最短阻塞链，从现有证据继续，不重复研究/返工已经签收的部分。
- **内部自行解决**：编译失败、超时、测试红灯、工兵返工、接线冲突等常规障碍由总管查因、拆解、并行修复、复测；可以使用 Base Skill 路由和多路 GLM/DeepSeek Pi Skill 工兵，但必须有独占文件白名单、主助手独立验收，不以工兵 `ok` 当产品通过。**阶段 checkpoint 写文件，不向用户发送普通进度提醒**。
- **唯一可提前打扰用户的例外**：必须立即取得新的授权才能安全继续的操作（生产用户数据库/迁移、真实密钥、五处历史 WIP、全局 Pi/Claude/DSH/Codex 配置、真实 64851 Host、远端部署/推送或删除），或者存在继续会造成用户数据/设备损害的安全事件。先停在**相应安全边界**并说明所需最小决定，其他独立工作可以继续；禁止以“永远不停”为由越权。
- **每轮结束不是产品完成**：若本轮时间/工具额度届满或设备断连，必须把完成项、失败及原因、回归结果、下一条命令和负责工兵写入 `TASK.md`/`LOG.md`/`PROJECT_CONTEXT.md` 与本交接，AgentDock 主任务保持 ACTIVE。不得在普通聊天中刷阶段播报，也不得把 ACTIVE 误当作长期自动执行。
- **当前起点（以最新证据重新核对为准）**：已完成本机 fake Provider 下 Core + 两 Pi 并发→两 Artifact/Candidate 的隔离 E3；Mikka V2 事实面板测试已通过，但可信 Host capability declaration、真实模型/工具、用户在 UI 中亲自审批、实体跨设备与重启恢复、可发布版本还没有完整正式签收；预览 64851 曾消失，原因未证实。上一轮旧状态在下面按时间快照阅读，不得覆盖这条最高优先级施工/汇报指令。

---

## 【2026-11-16 03:28 UTC · CI-A 本机候选门禁落盘｜未推送、未在 GitHub 跑过】

- 新增候选 `.github/workflows/loom-v2-e3-windows.yml`（SHA256 `9f395271eab41a29b74811ae427fa622b72368d449b5d4014a343cf574371c92`）及 `scripts/lib/loom-v2-e3-workflow-contract.test.mjs`（SHA256 `9bff2ed420aab373d7933838c2b956d415f641d0acfb7ccacdd09be9ec10478d`），均仅在本机未追踪工作树：没有新建/提交/推送 GitHub 分支，没有远端 PR/Actions 运行/Bero 操作，不等于 CI 已通过。
- Windows 2022 E3-only `workflow_dispatch`/PR，禁 push/release，`contents:read`、checkout 不留凭据；固定 Node24.14.1、pnpm11.20.0、Rust1.97.1 MSVC，fresh Host+native Pi launcher/Web、Pi 0.85.1 沙箱打包、正式 Host Bearer→双 Pi FileGuard→Mikka Electron 实际自动化指针审批脚本；TAP 严格1/1、0skip，带 SHA/假 Provider 标志，只有成功且无凭据样式输出才上传3日证据。
- **本机新验证**：契约 Node **4/4 PASS exit0**（首轮因新增测试使用无效 JS `(?m)` 正则报错，已修 `/m` 后复测）；候选 YAML PyYAML 解析 11 steps；PowerShell AST 8/8 `run` 语法通过；既有本机 Pi 0.85.1 Bundle `--verify` exit0，tree SHA `5692cc77a900ec7fccc8b6e9dcc6648b8ec42d81e83b627cd06c21fd0707c871`；`git diff --check` exit0。DeepSeek Pi只读审查指出 E6 表述/Host新鲜度/Pi传递依赖问题，Root改成 E6 `NOT_RUN`、将 fresh 证据明确归属 CI build step、manifest 记录 Pi/Host SHA，并新增6,679个 node_modules 文件SHA闭包 `b4909d7f7cd8698626bc91a3eb5f265bbd297d6e8a89687f04c7a5293f9a27ee` 的远端 fail-closed 校验（GitHub 尚未实跑）；GLM只读审查超时中断，无有效验收。
- **未过/续建**：GitHub clean Windows/MSVC、Pi npm transitive 依赖可复现性、Electron Runner 显示/CDP、真正远端 E3 均未跑；旧本机 E3 仍有效但不是这个 workflow 的成功证明。E4真实 Provider/四Runtime四能力、E5实体跨机、E6全面故障、E7发布和真人 Owner 审批仍 OPEN。必须重新检查并获得 Root 独占租约、审严格可外传文件白名单与 GitHub 权限，另获远端推送批准后再尝试 V2 独立 PR；不要把计划/静态测试冒充已上线。五处旧 WIP/生产 DB/真实64851/全局配置/用户凭据未动。

## 【2026-11-16 · 正式 Host＋双真实 Pi＋Bearer Web API 单链 E3 通过｜不等于产品完工】

- **新独立纵贯测试**：`scripts/lib/loom-v2-official-host-real-pi-review.test.mjs`（DeepSeek Pi Skill 工兵 `142286a3d7b446598b50043837342a20` 按唯一新增文件白名单交付；Root 审核并只修非法 fixture Tag），使用正式 `rovai-host.exe` 在 Windows 产品准备的受保护隔离 Core SQLite；两个真实受管 Pi 0.85.1 分别经 FileGuard `write` 与本地脚本假 Provider 产出两份独立文件，Host 本地可信管道登记 Claim/Fence/双 SHA256 Artifact/双 pending Candidate，初始 Review 为 0。随后正式 Host Web **Bearer protocolVersion 5** 认证的 HTTP API 读取两件真实 Pi 产物，显式 fixture Owner 意图只接受 A，B 保持 pending；未认证 401、过时协议 409、五种生产者 RPC 禁止远端调用 400；同 commandId 幂等重放、新 commandId 重复审批拒绝 `LOOM_REVIEW_EXISTS`；logout 使 token 失效，Host 从同一 SQLite 重启仍一 accepted、一 pending、一 Review。这是**正式 Host API＋双真 Pi 的单次 E3 链**，不是原 QA nonce 代理。

- **真实回执及红灯**：首跑 `session-c0e13f5bae0ce2c3ec0b1a30` **0/1 exit1**：`mission.invalid_tag`（只缩短新测试 fixture 标签）；修复后 `session-f091cfeb449906f14d46cb89` **1/1 PASS exit0**，再次验证并落 TAP `session-6fb1bf0070d06e00ffbe5b4b` **1/1 PASS、0skip、exit0**。命令：`node --test --test-force-exit --test-timeout=600000 scripts/lib/loom-v2-official-host-real-pi-review.test.mjs`。`node --check`、`git diff --check` **exit0**；本轮复验 Mikka Vitest **67/67**、`pnpm typecheck` **exit0**。长期证据：`_artifacts/loom-v2-automation-20261116/official-host-real-pi-review-e3-tap-20261116.txt` 和 `official-host-real-pi-review-e3-manifest-20261116.json`。

- **证据身份及禁区**：新增测试 SHA256 `8971143ff6d51654439b5c7692464546e4abec801056fa4ff75f3ba641f2627a`，实际运行 Host **历史缓存** SHA256 `f99e968d4d28f465de1047b5fbca2e1d06eee2cc2ddbfbaa676170ec34a0f491`，真实 Pi 可执行文件 SHA256 `589ddf44aa38f596fbd2f9aa5b0edf5e4533da23344d8ea555dae623e08d9151`。当前源码 fresh Host 编译仍未验；Windows protected root 由产品 prepare，但 ACL 未另行审计。原五处 WIP 的 SHA256+字节 5/5 一致；64851 无监听且未重启；不碰生产 DB、真实 Key、全局配置、远端。已受理 GLM 只读安全审查 `7b3261c916ad4cb7a52ae06c42940bdb`，工兵自报不是验收凭证。

- **未过 Gate／下一次**：此测试使用 scripted loopback fake Provider，**没有真正商业模型 E4**，也**没有正式 Host 与原 Mikka Electron UI 的真实用户点击**：`reviewerId=local_user` 仅由隔离 Host 注入；UI 的 QA Electron 指针链仍是另一条独立 E3 证据。下一阻塞链：用正式 Host Bearer 授权把双真 Pi Artifact 接到生产 React/Mikka Electron 用户可操作界面（先隔离自动化再人工授权操作），补同一链身份/Grant/失联负例；随后 fresh Host build、四 Runtime 四能力 Loaded/Invoked、物理 E5、恢复 E6、发布 E7。**4–6 周版 IN_PROGRESS；E4–E7 NOT_VERIFIED。**

## 【2026-11-16 · 正式 Host Web Bearer／Owner Review 事实门新增】

- 2026-11-16 00:33 UTC，新建独立 `scripts/lib/loom-v2-official-host-web-review.test.mjs`：在 Windows protected 临时 Core SQLite 上，经**正式 rovai-host Web API**（不是 QA nonce 代理）用本地 Host pipe 先种入两份**合成** Artifact/Candidate，实际 `/api/v1/login` protocolVersion 5 验证 Bearer；无票证 401、未准入生产者 RPC 400、归档 HTTP 预览不产生审批、显式 `loom.review.record` 仅批准 A、B pending、相同 commandId 重放只留一条 Review、登出失效 401、真实 Host 停机重启后仍留 A accepted/B pending。Root 实跑 `node --test --test-force-exit --test-timeout=360000 scripts/lib/loom-v2-official-host-web-review.test.mjs` **1/1 PASS，0skip，exit0**，实际测试约30.9秒；`node --check` 与 `git diff --check` exit0。证据 `_artifacts/loom-v2-automation-20261116/official-host-web-auth/official-host-web-raw-tap.txt` 和 `e3-manifest.json`。本次使用**历史缓存 `rovai-host.exe` SHA256 f99e968d...**，尝试按当前源码 fresh `cargo build -p rovai-host --locked --bin rovai-host -j2` **720秒超时**，不能标记 fresh Host 已过。此新增用例未运行 Pi/模型、未由人点击 Mikka UI；与此前真双 Pi+QA Electron 单链分别是独立 E3 证据，**不可拼成正式 Host→双 Pi→真实用户 UI 端到端验收**。E4 真商业 Provider/四端四能力、实体 E5、全面 E6、可发布 E7 仍 OPEN。五处 WIP SHA256+字节 5/5 原样，64851 无监听且未重启；生产 DB、全局配置、凭据和远端未触碰。下一步应采用受控编译产物在同一正式 Host 认证链接真实双 Pi FileGuard 成果，并做用户界面身份/审阅负例，不重做已签 E3。

## 【2026-11-16 · 新纵贯实证：同一隔离 Core SQLite 的双真实 Pi → 生产 React ArtifactView → Electron 真实指针审批】

- **本轮从原先“两条各自独立的 E3”推进为单次完整 QA 沙箱纵贯链**。新增 `scripts/lib/loom-v2-qa-scripted-pi-provider.mjs` 和 `scripts/lib/loom-v2-guarded-pi-electron-review.test.mjs`，不改变生产 Core/Runtime 或五处旧 WIP。一个受 Windows protected data-root 保护的隔离 Core SQLite 创建 Mission、双 Task/Claim/Fence；两个真实 Pi 0.85.1 进程各自使用不同的本机 scripted loopback Provider，通过 FileGuard 真执行 1 次 `write` 工具，留下两个独立真实工具回执和文件。Core 自算两份 Artifact SHA256、保存两份 Candidate，初态 **2 pending / 0 Review**。同一 Mission 的产物随后通过 QA nonce 限制的 `127.0.0.1:0` 临时代理进入**现有生产 React `ArtifactView`**；Electron `sendInputEvent` 真实鼠标打开归档文本、选择接受/勾单一标准/填理由/提交，Core 留下 **1 Review / A accepted / B pending**；同一 SQLite 真停机重启后结果保持。归档正文与 Pi 实际文件字节一致，且 UI 等待的可见文本来自 Core `loom.artifact.preview`，不再硬写合成 fixture 的标题。
- **独立拒绝门**：在 Electron 启动前，以错误 nonce、跨 Mission ID、未列白名单 RPC 进行三个真实本机 HTTP 请求，均必须返回 **403**，且 Core Review 数仍 **0**；UI 预览/打开动作也不能自动审批。审阅人 `local_user` 是此隔离 Core 的 Host 注入测试身份，不代表远端人类身份链已签收。DeepSeek/GLM Pi Skill 只读研究与风险审查已完成；最终代码和真实命令由 Root 独立执行，未把工兵自报算验收。
- **Root 真回归**：`node --test --test-force-exit --test-concurrency=1 --test-timeout=540000 scripts/lib/loom-v2-owner-review-electron-core.test.mjs scripts/lib/loom-v2-guarded-pi-electron-review.test.mjs` → **2/2 PASS、0 skip、exit0**，AgentDock `session-1810f23ee37421d033dae616`；此前单独跑新链 **1/1 PASS exit0**，AgentDock `session-8a14c15441e8e5cf3be404a4`。受测 Core 可执行文件 SHA256 `64d5e469b558e72bbf365ce7ede1f529195973fcec49943255566d61c509ee9d`，没有启动生产用户 Core。两份唯一证据目录：`_artifacts/loom-v2-automation-20261116/guarded-pi-electron-5fa3eb18-8286-4a63-bb18-cd71e1991c1b/`（`report.json`、`e3-manifest.json`）和 `electron-real-core-ffaa11fa-9674-4fe2-8376-35296332cb79/`。新测试、既有 fixture `main.cjs` 使用 Core 动态归档/Task 身份而不是硬编码旧文件。
- **失败不掩盖**：本轮首次运行旧 Electron 测试真实 **exit1**，原因是无人值守 Windows 显示表面 `capturePage` 报 `Current display surface not available for capture`，但此前真实指针、提交、Core Review 断言已完成。现对截图采取**显式可缺失**记录，最终两条 PASS 报告均标记 `screenshotCaptured=false, screenshotFailure=display_capture_unavailable`，**不宣称有可验收截图/实人 UI 验收**。原历史证据不覆盖，新文件存 2026-11-16 唯一目录。
- **严格余项**：此处模型是 `SCRIPTED_LOOPBACK_ONLY`（fake Provider，`realExternalProvider=false`）；QA nonce 代理不是正式 Host 认证/授权通道，Electron 鼠标是自动化指针而非用户本人批准；这只新增 **E3 端到端沙箱证据**，不等于 E4 真商业 Provider/四 Runtime 四能力的实际 Loaded+Invoked、E5 实体跨设备、E6 完整掉线恢复或 E7 可发布版本。下一条最短关键链：把同一链通过**正式产品 Host** 的用户身份/权限与审批 API（不用临时代理）接入原 Mikka UI，再做受控真 Provider/真实设备和失联负例。未经新授权依旧禁止动生产 DB、五旧 WIP、64851、全局配置、远端发布。

## 【2026-11-16 · 双链 E3 纵贯新验收：双真 Pi 成果→Mikka 审阅服务；真实 Electron 指针→真实 Core】

- **A 真实 Pi+Core+生产 Mikka 审阅数据层（隔离 E3）**：只修改非保护测试 `scripts/loom-v2-core-authorized-receipt.real-pi.test.mjs`，在受保护的独立 Windows Core SQLite 上，两套真 Pi 0.85.1 实际通过 FileGuard 调用 `write`，Host 重新算两份文件 SHA256、登记双 Claim/Fence/Artifact/Candidate；最初 2 个 pending / 0 Review。测试临时打包的是**现有生产** `loom-native/artifact-service.ts`，真实 Core `loom.artifact.preview` 读取两份原文，不自动审批；仅**显式 fixture Owner 意图**在读过两份内容后审批 A、B 仍 pending。Core 自己注入 `reviewerId=local_user`，相同冻结 `commandId` 再发送返回 `replayed:true`、仍只有 1 Review；同一个 SQLite 真实进程重启后 1 accepted / 1 pending、正文可读保持一致。**Provider 仍为 127.0.0.1 scripted fake，不是真实商业模型；此用例没有 Electron 鼠标输入/真正人类点击。**
- **B 真实 Electron 指针+现有生产 React `ArtifactView`+真实 Core（隔离 E3）**：新增 `scripts/lib/loom-v2-owner-review-electron-core.test.mjs` 与 `scripts/fixtures/loom-real-core-review/{index.html,renderer.tsx,main.cjs,preload.cjs}`，Windows 隔离 Electron `userData`、隔离 HOME/XDG/MCP/Skill Library + protected Core data-root，使用一次性 nonce + `127.0.0.1:0` 测试代理，只转发当前 Mission 白名单方法到真实 Core。Electron `sendInputEvent` **实际鼠标输入**依次打开成果、勾接受/标准、填写理由、提交；预览先检查 0 Review，提交后 Core 持久化 1 Review、A accepted/B pending、`local_user` 由 Host 注入；同库重启结果不变。截图和 JSON 报告存 `_artifacts/loom-v2-automation-20261115/electron-real-core/`。**这一用例的输入是两份合成 fixture 文件，未在同一 Electron 用例运行 Pi；这是自动化指针，不代表用户本人已点击/签收。**
- **Root 最终独立验证**：两套集成测试顺序合跑 `node --test --test-force-exit --test-concurrency=1 --test-timeout=420000 scripts/loom-v2-core-authorized-receipt.real-pi.test.mjs scripts/lib/loom-v2-owner-review-electron-core.test.mjs` **3/3 PASS、0 skip、exit0**；Guarded Core receipt 负例 **31/31 PASS exit0**，Mikka facts/Panel/Review Vitest **67/67 PASS exit0**，`pnpm typecheck` **exit0**，`git diff --check` **exit0**。TAP：`_artifacts/loom-v2-automation-20261115/combined-pi-core-electron-review-final-tap.txt`；源码、Core二进制、截图及安全摘要：`_artifacts/loom-v2-automation-20261115/electron-real-core-review-e3-manifest.json`。Electron 首三轮真实红灯（未放行 `preferences.tasks.get`、Windows stdin 不能可靠送回 RPC）；更正为限时 nonce 回环测试代理后最终真绿，失败证据未覆盖。
- **边界与下一闸**：这是**两个各自真实 E3 的拼接证据，不是单次真实 Pi→正式 Host→Mikka Electron 体验的完整产品闭环**；临时测试代理不是正式产品 Host 授权通道，`local_user` 的测试身份不等于远端用户身份/权限全部通过。正式 Mikka UI 真用户操作、四 Runtime 和 Skill/MCP/Rule/Hook 的逐端 Loaded/Invoked、真实商业 Provider E4、独立物理设备 E5、全面失联恢复 E6、可发布 E7 **仍 OPEN**。下一步将两种已验证路径在一个正式 Host 授权场景合并，并做真实角色/权限、失联与负例；不把本轮脚本通过算 4–6 周版完成。原五 WIP 原 SHA256+字节 **5/5 unchanged**，64851 **0 listener**，未启动/修改旧 Host，也没触用户生产 DB、全局配置、凭据、Bero/GitHub。

## 【2026-11-16 · 本轮真实 Core×Mikka 审批服务纵贯补证｜仍非用户点击验收】

- **Root 新增且仅新增非保护测试文件**：`scripts/lib/loom-v2-owner-review-core-ui.test.mjs`。自动验收通道启动 Windows protected 独立 Core data-root（单一真实 SQLite、独立 HOME/TMP/Skill Library/MCP），由当前 `target/debug/rovai-core.exe` 执行实际 RPC；测试临时 bundle 编译**生产 `loom-native/artifact-service.ts`**，不是虚构另一份审阅逻辑。建立一 Mission、两 Task/Claim/Fence 与两**合成测试文件**的真实 Host SHA256 Artifact / pending Candidate，严格区分历史另一测试的「两真实 Pi FileGuard 写文件」；**本次并未跑真实 Pi，也未由用户亲自点击 Mikka UI**。
- **显式 Review 回执真实落库**：打开两件归档正文都不自动审批；对第一候选调用生产 `prepareArtifactReviewAttempt` + `sendArtifactReviewAttempt` 才允许 Core `loom.review.record`。Core 独立拒绝未满足验收标准 `LOOM_REVIEW_CRITERIA_INCOMPLETE`、第二个新命令再次审批 `LOOM_REVIEW_EXISTS`；未知 artifact 预览显示 error 而非假 unavailable。模拟第一次回执在 Core **已提交**后丢失，UI 服务诚实返回 unknown；**仅重发相同冻结 commandId/payload** 得 Core `replayed:true`，可信 `reviewerId=local_user` 由 Host 注入；两次请求只留 **1 条 Review / 1 accepted**，另一候选仍 pending。停机并从同一 SQLite 重启后状态保持。
- **Root 真测试**：新增文件最终加负例后的 `node --test --test-force-exit --test-timeout=420000 scripts/lib/loom-v2-owner-review-core-ui.test.mjs` → **1/1 PASS、0 skip、exit0**，原始 `_artifacts/loom-v2-automation-20261115/owner-review-real-core-final-tap.txt`；此前新增测试 + 旧 Core/Pi Guard 集成 4 文件顺序跑 → **38/38 PASS、0 skip、exit0**（合并测试发生在新增末次负例之前，不能冒称该集合覆盖后加断言），原始 `owner-review-plus-guarded-pi-tap.txt`。旧 `artifact-review-safety.test.ts` **25/25 Vitest PASS exit0**，`pnpm typecheck` **exit0**（`owner-review-typecheck.txt`）；`node --check`、`git diff --check` exit0。DeepSeek/GLM Pi Skill **仅只读审查**，没有把工兵自报当验收。
- **事实限制和后续施工**：这是 Mikka **生产数据服务→真实隔离 Core** 的 E3 审阅联动证据，尚缺同一个真正 Pi 运行结果在用户实际 Electron 界面点击/审批的完整闭环；实在的商业 Provider / 四 Runtime 四能力 Loaded+Invoked E4、物理实体跨设备 E5、掉线/崩溃 E6 全门、可发布 E7 均 **NOT_VERIFIED / NOT_RUN**。原五 WIP SHA256 与字节长度独立再核 **5/5 不变**；64851 **0 listener**、旧 Host 下线原因未知且未重启，用户生产 DB/全局配置/凭据/远端没有触碰。**下一次请先复核总管租约与受管会话，再接真实用户 UI 点击批准，并核 Core 认证身份/权限；不要重做此 E3 服务测试或宣布 4–6 周版完成。**

## 【2026-11-16 · 最新隔离 Core + 双受管 Pi 文件工具到待审成果接线｜Root 实测】

- **新的真实纵贯增量，不是产品完工**：Root 新增 `scripts/loom-v2-core-authorized-receipt.mjs`、`.test.mjs` 与 `.real-pi.test.mjs`。隔离受保护 Windows Core data-root 的**同一个真实 SQLite**先创建 Mission/Plan、两独立 Task 与两 Claim/Fence；两个**真实 Pi 0.85.1 进程**各自使用独立本机 scripted fake Provider，通过预先加载且验证的 FileGuard 真执行 `write` 工具，在隔离工作区写各自产物。桥先核 Core Claim + Fence/expiry/Run 身份、Guard self-test 与 allow/toolCallId/relPath、实际文件 SHA256；再由真实 Core `loom.artifact.register` 重新计算两个 Host 文件哈希，提交两个 `loom.candidate.record`。两者均 **unverified/pending**、Review 列表空，**不自动验收**。同一 Core 停止并从**原 SQLite 重启**后，两 Claim、两 Artifact、两 Candidate 和零 Review 均恢复；Core loom.artifact.preview 在待审阶段及重启后均从不可变归档返回两份 Pi 真正写出的精确文本与 SHA256，**Core API 可读不等于用户已经在 Mikka UI 亲手打开或接受**；证据是 E3 局部恢复而非跨设备 E5/故障恢复 E6 全门。
- **Root 真测试**：`node --test --test-force-exit --test-timeout=420000 scripts/loom-v2-core-authorized-receipt.test.mjs scripts/loom-v2-core-authorized-receipt.real-pi.test.mjs scripts/loom-v2-core-pi-integration.test.mjs` → **37/37 PASS、exit0、0 skip**；Mikka V2 UI facts+panel 聚焦 `pnpm exec vitest run apps/desktop/src/renderer/src/loom-native/V2BotStatusPanel.test.tsx apps/desktop/src/renderer/src/loom-native/v2-run-service.test.ts` → **42/42 PASS、exit0**；`pnpm typecheck` exit0。原始 TAP/Vitest: `_artifacts/loom-v2-automation-20261115/core-guarded-dual-pi-tap.txt` / `ui-focused-vitest.txt`，源码/二进制哈希与保护清单 `source-and-safety-manifest.json`。被测 Core executable SHA256 `64D5E469B558E72BBF365CE7EDE1F529195973FCEC49943255566D61C509EE9D`，此前另一 Root 已从本树 fresh build；本轮仅在隔离 root 执行，没有重新编译、打开日常 DB 或变更发布版本。
- **真实回归红灯与修复**：第一轮联合验收 **32/33 PASS，1 FAIL**：旧 `resolveUiBundleFacts` 在新 Core 真支持 `loom.bundles.getMany` 后，把 Core `LoomArtifactsListResult={artifacts:[...]}` 当裸数组，导致 `undefined !== 2`；Root 在非保护文件 `scripts/loom-v2-core-pi-integration.mjs` 只兼容真实 typed wrapper 或历史裸数组，且严格验证数量/错误，不把未知异常降级成功；增加正反例后重跑 **37/37 PASS**。新增桥包含错误回执不可重播、错代/失效租约拒绝、Provider 身份不得伪造、路径/Guard 双回执、产物字节 Hash 不一致拒绝等负例。
- **硬边界**：本轮有 DeepSeek/GLM Pi Skill 独立只读审查；其文本不作为代码交付，所有新代码与测试由 Root 亲自写入及复验。**mockProvider=true、realExternalProvider=false、realCommercialModelQualified=false、osSandbox=false**，临时脚本 Core client 可模拟；新桥尚非生产 Host 受控入口，尚未接用户真实 Mikka UI 点击审批。最终 E4 真实 Provider/四 Runtime+四能力、E5 独立实体、E6 跨故障恢复、E7 可发布、真实 UI 用户 OwnerReview **NOT_VERIFIED**，没有用户通知或上线行为。
- **保全**：五处原 WIP SHA256/字节数与固定基线 **5/5 相同**，64851 **0 listener**（原因仍未证实，未重启），日常用户 DB/全局 Pi/DSH/Claude/Codex/真实账号/远端均未碰。下一段：把当前 Guard-Run/Claim/Fence/Artifact 真回执接入**正式 Runtime Host 授权/任务分发**，在隔离用户界面实点 Owner Review 并验证 Core 角色/审批回执；再按总蓝图继续其他 Runtime/四能力、实体 Device/E5、E6/E7；绝不因这批 E3 绿灯标 4–6 周完成。

## 【2026-11-16 受管 Pi 文件工具纵贯薄切片真回归｜24/24 通过】
- **最终安全收口**：AgentDock `session-3239daa5a8beba1484b34345` 真核五 WIP SHA256 **5/5 unchanged**、64851 **0 listener**、`git diff --check exit0`、`pnpm typecheck exit0`；24/24 证据已写入四个 Mindkit/交接文档。Root 对 DeepSeek Pi `0395b48b98454122a995e1c805bed016` 签 `approved:accepted`，不是工兵自称成功。已存在 `ArtifactView.tsx` / `artifact-service.ts` 的用户 Review 交互与 `loom.review.record` 写入代码，但尚无当前安全新 Runner 产物穿过真实 Mikka 点击、Core 身份到持久回执的端到端验收，依然 OPEN。
- Root 真正验收了独立受管运行入口 `scripts/loom-v2-runtime-execution.mjs`、Pi 原生 `scripts/loom-v2-runtime-file-guard.ts`、两份安全测试（`loom-v2-runtime-execution.test.mjs`、DeepSeek 工兵新写 `loom-v2-runtime-safety.test.mjs`）。命令 `node --test --test-force-exit --test-timeout=420000 scripts/loom-v2-runtime-execution.test.mjs scripts/loom-v2-runtime-safety.test.mjs` → **24 tests, 24 pass, 0 fail, 0 skipped, exit0**，AgentDock `session-7c45ddfe8c4ce0ec633a71ce`。真实 Pi 0.85.1 在独立工作区 + 本机 loopback fake Provider 下，按显式 Grant 使用 read/write，Host 只登记指定产物路径并复核 SHA256；未提供真实商业模型、用户生产密钥、跨设备或 Owner 审批。
- **Root 修真实失败**：跑测序列 8/14 → 10/14 → 13/14 → 24/24。修复 Windows 目录跳转拒绝原因优先级、拒绝 agentDir 和 sandboxRoot 相同、旧测试对过滤凭据的误期待与错误码；最关键发现 **Pi 的被拦截工具仍会发 tool_execution_start/end 且 isError=true**，不能把所有事件都当磁盘 IO，也不能简单丢弃。Root 新增 `reconcileGuardedExecutions`，只有 Guard 日志确实 block + 相同 toolCallId + Pi End/ToolResult 双错误 + `LOOM guard blocked` 标记双证时才计为 `deniedAttempts`；没有可信双证则拒绝整次 Run。它仍在 `summarizeGuard` 校验所有实际允许执行均有 guard allow，绝不绕过授权。
- `runAuthorizedExecution` 只信明示的 workspace/allowedTools/expiry/env reference；Guard 不可用时 prompt 前失败，断线/超时状态 `unknown_outcome` 不可重放。**OS 沙箱、并发 TOCTOU 物理强制以及后端模型真实性均不声称已验证**；真实 Provider E4、用户 UI OwnerReview、4 Runtime/Skill-MCP-Rule-Hook 实际 Loaded/Invoked、独立实体 E5、长期恢复 E6、正式 E7 全部 `NOT_VERIFIED`。下一任接单一 Core RunAttempt+Claim Fence 绑定这条 Runner，并让 Mikka 真实用户审批才能提高产品 Gate。
- 原五 WIP 哈希仍完整，64851 无监听而未知退出，未动用户 DB/全局账号设置/远端；双 AgentDock 主任务继续 ACTIVE，本次通过的 24 个**聚焦用例并不意味着 4–6 周产品完成**。

## 【2026-11-16 本轮安全续建新增验收｜最终版本尚未完成】
- AgentDock Windows 真实连上本机；原五处受保护 WIP SHA256 **5/5 与基线相同**；64851 当前无 LISTENING、原 PID12944 不存在，未擅自恢复；不触生产数据库、全局 Pi/DSH/Claude/Codex 配置、用户凭据、远端。
- Root 在非 WIP 的 `v2-run-service.ts` / `V2BotStatusPanel.tsx` 实施 **Host 原始 waitReason → Mikka waiting 行状态可读**，仅等待中显示，成功/运行中不显示旧残留原因。新增 `V2BotStatusPanel.test.tsx` 正负例、调整旧服务测试期望。首轮 Vitest 30/31 fail1 为原精确回执期望缺新字段，修复后 **31/31 PASS**，`pnpm typecheck` 和 `git diff --check` **exit0**（`session-a1f11f23d93b850e9da29678`）。未进行真实 UI 人工审核交互验收。
- Root 真实复跑 `node --test --test-force-exit --test-timeout=420000 scripts/loom-v2-core-pi-integration.test.mjs` → **4/4 PASS exit0**（`session-0eb4bb293e66acd8109d266f`，55 秒）。一个隔离 Core SQLite 与两真 Pi Worker、两 Host Artifact/Candidate，全部来自本机 **fake Provider**、旧预构建 Core；不把 E3 当 E4。
- 并行产品工作有 `scripts/loom-v2-runtime-execution.mjs`、`loom-v2-runtime-file-guard.ts`、`loom-v2-runtime-execution.test.mjs` 新源文件，仍需 Root 实证和安全审查。已通过 Base 路由使用 DeepSeek Pi Skill 工兵 `0395b48b98454122a995e1c805bed016` 审核新安全测试微计划，仅批准在互斥白名单新增 `scripts/loom-v2-runtime-safety.test.mjs`，尚未以 Worker 自报代替测试。
- **下一真正产品 Gate**：受管 Pi guard 的拒绝/授权与真实工具执行证据→同库 Core→Mikka 真用户 Owner Review；四运行端和四能力 Loaded/Invoked、跨实体设备 E5、失联恢复 E6、可发布 E7均 **NOT_VERIFIED**。4–6 周单用户完成标准不降级，不向用户例行汇报此阶段。

## 【本轮后续复核｜Mikka V2 事实面板已装配、单元测试 30/30】

- 当前工作树 `apps/desktop/src/renderer/src/loom-native/LoomApp.tsx` **已存在** `V2BotStatusPanel` import 和 `readV2RunFacts` 调用（约 21–22、122、280 行），说明非WIP `LoomApp` 侧已有实际挂载入口；本轮 Root 未改原 `Inspector.tsx` 与 `product.css`，也未把其他工兵 WIP 归为自己交付。
- Root 对 `V2BotStatusPanel.test.tsx` + `v2-run-service.test.ts` 合并重测：**30/30 PASS、exit0**（`session-7d0fd782b10f13f5cc82549f`）；`pnpm typecheck` **exit0**（`session-89a5cc94675a38457dd11da6`）。此前同组曾 **25/30 FAIL5**，以本次新复测结果为准。
- `LoomApp.tsx` 真实传入 `declaration:null`，因此 Claims API 在 Host 尚无可信能力声明时诚实显示 `not_declared`，**不假报无人认领**；真实 UI 浏览器点击/物理设备、完整 E4 产品闭环仍未验收。


## 【本轮最新成果｜2026-11-15 · Core + 双 Pi Worker 隔离 E3 通过】

- **Root 真验收**：新增 `scripts/loom-v2-core-pi-integration.mjs` 与 `scripts/loom-v2-core-pi-integration.test.mjs`。执行 `node --test --test-force-exit --test-timeout=420000 scripts/loom-v2-core-pi-integration.test.mjs` → **4/4 PASS、exit0**（`session-f75806bc661eafa0fc333b02`）。同一个真实 Core SQLite 隔离 Mission 创建两个 Task、真实双 Claim / Fence，独立两个真实 Pi0.85.1 并发对本机 fake Provider 执行，Core 对两份产物做 Host SHA256 登记并保存 Candidate，两个 Task 均 **in_review**，候选 `pending/unverified`，Review 0 条，不自作审批。
- 首轮 Core ready 超时；第二轮到达 UI 汇总方法但缓存 Core 不支持 `loom.bundles.getMany`；Root 指挥工兵收敛：只在**明确 unsupported method**时从 Core 真实 `claims/candidates/artifacts` 读回，并将 `uiFacts.bundleProjectionObserved=false,source=core_list_calls,reason=cached_binary_unsupported`，其它 RPC 错误仍拒绝。第三轮 4/4 PASS，不冒称 UI 汇总已验。
- **严格范围**：测试使用已有 `target/debug/rovai-core.exe`（缓存预构建，非冷构建），本机 `127.0.0.1` fake Provider，`realExternalProvider=false`；没有商业模型、真实用户凭据、生产数据库迁移、真实 UI 用户审批、跨设备/发布。E3 **隔离薄切片**通过，E4/E5/E6/E7 与完整 4–6 周产品仍 **NOT_DONE**。
- **仍存在**：已出现的 `V2BotStatusPanel` 回归合并跑 **25/30 PASS、5 FAIL**，原 `v2-run-service` 自身 **17/17 PASS**；组件尚未入 Mikka 用户界面，`V2HostDeclaration` 的真实生产者仍缺。之前旧 `scripts/lib/loom-v2-two-pi-core-delivery.test.mjs` 复跑 **exit1 Core ready timeout**。本批不碰用户五处原WIP，也不擅自恢复未知原因退出的 `64851` Host。


## 【本轮新里程碑：E3隔离实Core双Pi双Artifact+Owner门控已真验收】

- Root新建并实测 `../../scripts/lib/loom-v2-two-pi-core-delivery.test.mjs`，Node test **1/1 PASS exit0 约62.8s**。同一个独占隔离Core SQLite持有Goal/Mission、A/B独立认领两份fence、C依赖待完成；Core停止期间两个真Pi 0.85.1在各自127.0.0.1:0本机假Provider并发真实settle、不同System Prompt哈希；Core从**原SQLite根重启**后核验原claim，Host按文件真实sha256登记2个Artifact，提交2个Candidate后都pending，模拟fixture Owner明确只接受A、B继续pending、C因未技术验证仍阻断。读回SQL 2 claims/2 artifacts/2 candidates/1 review，`scope=E3-sandbox-only`、`mockProvider=true`、`realExternalProvider=false`、`ownerReviewUiApproved=false`；不能宣称E4真实模型/工具/当前产品GUI已能操作。
- **首轮失败保留**：Core常驻同时跑两个Pi曾造成2个Pi run failed/临时目录EBUSY，未确认根因；Root改为Core claim持久→停止→双Pi→同库Core重新开再提交，实测通过，展示durable recovery而非宣称常驻调度成熟。`ROVAI_CORE_BIN`指向私有从`target/debug/rovai-core.exe`复制的`_artifacts/loom-v2-20261115/evidence/rovai-core-e3-prewarm.exe`（SHA256 `31C6B04F06AAEB6603F0A2F9057A8385049E2421BF2561B05064D1DEA90730B4`，非当前代码fresh rebuild），最新`cargo build` warm在800s超时并未通过，不能掩盖。
- 新UI工兵已有两文件 `apps/desktop/src/renderer/src/loom-native/V2BotStatusPanel.tsx`+`.test.tsx`，Root在非WIP `LoomApp.tsx`增加 rail“运行与成果”入口，复用只读`readV2RunFacts`及旧ArtifactView；Root实际复测新组件13/13+旧服务17/17合计 **30/30 PASS exit0**；测试先因fixture缺candidateId导致2条失败，Root补真实fixture身份后恢复，全仓 `pnpm typecheck` **exit0**，真人浏览器/用户审批真实交互仍待签，尚未发布预览。Core v235 migration勘察警告任何新Core启动真实用户旧v1.72 DB可能自动升级，**本轮完全没有连接生产迁移**。
- 下一道真正产品门：Host声明与claims真实读、Mikka审批真正由用户动作触发、能长期常驻的安全Pi Runtime+真实模型/工具（E4）、Capability四种物化、Windows Device与跨设备恢复；P0–P14蓝图保持不降级。

> **最新安全纠偏（本轮末尾只读现场）**：本轮最初 64851 确为 LISTENING PID12944，但后续 `netstat`/`tasklist` 复核**无监听、PID12944已退出**。旧段落仍记录原先时点的真实观察，不再代表当前进程状态。Root 没有针对该 PID 调用 stop/kill/restart，也没有触碰 `loom-host.exe` 的预览 `kit`/`data`；退出原因 **UNKNOWN，须单独排查**。不得把运行时健康伪称通过，也不要在未授权情况下擅自重启。

## 【当日续建最新增量 · 双真实 Pi Worker 已在假 Provider 并发通过】

- **Core Wire E2E 最终真实回执**：隔离命令中只给本进程PATH追加 `target/gcc16/mingw64/bin`，并限 `CARGO_BUILD_JOBS=2`，执行 `node --test scripts/lib/loom-core-e2e.test.mjs`：第一条真实 Core Plan/Task/Dependency 持久化 **PASS**（46.6s），第二条全新空 Cargo Target 冷构建 600s **`spawnSync cargo ETIMEDOUT`**、未进入 Delivery/Review 业务断言；总 **1/2 PASS exit1**。因此 **Core Wire E2E未签收，E3/E4未完成**。这是冷编译耗时阻断，非发现业务逻辑断言失败；不得把adapter15/15推导为E4。预览 64851 原 Host 也已下线且原因未知，本轮不继续再做一轮高负载编译。

> 此节优先于下方 07:12 历史快照。Root AgentDock 原 `tsk_a21d75f405171f22` ACTIVE，续建任务 `tsk_593db6a79b233dc1`。本轮**没有产品发布**，27页总蓝图 P0–P14 无调整。

- **新增两个文件**：`../../scripts/loom-v2-two-worker-loopback.mjs`、`../../scripts/loom-v2-two-worker-loopback.test.mjs`。Root 实跑 `node --test --test-force-exit --test-timeout=420000 scripts/loom-v2-two-worker-loopback.test.mjs` → **7/7 PASS，exit0**（真实两个同时运行的 Pi0.85.1 RPC进程，双独立 Profile + 双不同127.0.0.1随机端口假 Provider，各自 `agent_settled` / provider 请求与不同 Session ID，Off/Append 实际系统提示词 digest 不同，工具关闭；teardown 全部 sockets 和临时文件退出/清除）。明确 `mockProvider=true`、`realExternalProvider=false`、`coreIntegrated=false`；这是 P1-C 对“真双 Worker runtime”的增量证据，**不是 Core 持久化指派/Artifact/Owner Review/Product E4**。
- **旧测试新鲜复验**：managed Pi RPC **18/18 PASS exit0**；UI Facts Vitest **17/17 PASS exit0**，新 JS syntax check exit0。
- **Core 测试实测而非超时假设**：第一次 `cargo test -p rovai-core --locked --lib v2_coordinator_adapter` 实际因 `t14` 的 Rust E0382（envelope 已 move）**exit1**。Root 只修新增 adapter 的 t14 `vec![envelope.clone()]`；更关键修正 t10“伪造回执”测试前的合法 seq 1/2，使其确实走到 replay `Mismatch` 而非先因 sequence gap 失败。`rustfmt --check --edition 2024` **exit0**。本机私有 `target/gcc16/mingw64/bin/gcc.exe`(16.2)与 `dlltool.exe` 实际存在，用进程私有 PATH 重跑 `cargo test -p rovai-core --locked --lib v2_coordinator_adapter -- --nocapture`，**15/15 PASS exit0**，5m58s（其余636测试filtered）。`t10` 确实验证 replay mismatch，`t12` 拒绝 Owner Review，`t13` immutable SQL UPDATE/REPLACE/DELETE拒绝。**仅签收模块内存SQLite测试，不等于生产CoreDB迁移或E4产品闭环**。
- **保留的不变量**：原五 WIP SHA256 重核5/5 unchanged；64851 listener PID12944；`git diff --check` 及 `mindfile_guard.py verify .` exit0；无全局 Pi/Claude/Codex/DSH 配置变化，无用户DB变更，无 Bero/GH push。`MIGRATION_SQL` 仍只在隔离测试使用，未进 Core 真实 migration。Node 旧 Core Wire E2E 0/2 暂无新绿灯；真实外部模型、E4全链、E5/E6/E7 仍 NOT_RUN。


> **状态：P1-A / P1-B Root ACCEPTED；P1-C 四路源码已落盘，三路独立签收，Core 编译通过但 Rust 目标测试未签收；产品全闭环尚未完成。** 此文是可恢复现场快照，不是新总蓝图，也不是暂停指令。目标仍是用户要求的 4–6 周可用 LOOM。既有 27 页研究对应的 [P0–P14 总计划](../../LOOM-V2-MASTER-PLAN.md) 权威不变，禁止以本交接偷换为八步或宣布整阶段 100%。

## 工作现场与边界

- Windows 本机总管根：`C:/Users/echo/Downloads/claude/skill-cli`；LOOM 产品 Git 根：`C:/Users/echo/Downloads/claude/skill-cli/loom`；AgentDock 主任务：`tsk_a21d75f405171f22`（ACTIVE）；Pi Skill 实时板：`http://127.0.0.1:8767`（仅本机）。四路 Pi Skill 数据根：父项目 `_artifacts/loom-v2-20261115/worker-data`。
- 历史批次入口：[P1-A Root 验收](LOOM-V2-P1A-ACCEPTANCE-HANDOFF-2026-11-15.md)、[P1-B Root 验收](../../LOOM-V2-P1B-ACCEPTANCE-HANDOFF-2026-11-15.md)；当前产品 UI 仍用用户认可的 `loom-native` Mikka 三栏/可拖动大小与群聊交互，不回滚旧 Shell。
- 用户原五处未提交 WIP（`Inspector.tsx`、`product.css`、`crates/loom-node/src/lib.rs`、`process_wire.rs`、`session.rs`）**2026-11-15 本次复核 SHA256 5/5 未变**，基线见父项目 `_artifacts/loom-v2-20261115/evidence/original-five-wip-sha256.json`。64851 原监听仍在（PID 12944）。不得把这五处更改一并格式化、重置、提交、或覆盖。未修改日常用户 DB、全局 Pi/DSH/Claude/Codex 模型配置、远程 Bero/GitHub/生产镜像。
- 当前 Git 工作树存在历史多人 WIP/历史文档更改与本轮大量新文件；**没有发起 commit/PR/push、没有执行产品发布，也没有触发用户 DB 迁移**。原 v1.72 发布规范仍有效。

## 已经可独立复验的结果

| 范围 / 文件 | Root 真结果 | 能证明与不能证明 |
|---|---|---|
| P1-A/P1-B Rust：`crates/loom-protocol/src/v2_domain.rs`、`v2_coordinator.rs`、`v2_capability.rs`、`v2_coordinator_replay.rs` | `cargo test -p loom-protocol --locked --lib` **76/76 PASS** | 纯领域/Coordinator/Capability/回放；不是持久化执行器 |
| P1-B Bridge/Stager/Capability/Hook 四套 Node 测试 | **78/78 PASS**，详见 P1-B 验收 | 固定源码、安全 staging 和 mock extension；不是实际外部模型 |
| P1-C 受管 Pi RPC：`scripts/loom-v2-managed-pi-rpc.mjs` + `.test.mjs` | `node --test --test-force-exit --test-timeout=10000 scripts/loom-v2-managed-pi-rpc.test.mjs` **18/18 PASS**（AgentDock `session-67dcf4844f02fb1437972318`） | 严格钉死 Pi 0.85.1、沙箱/源码 digest、JSONL ID 关联、超时失败关停、allowlist；测试中先发现伪 `run_command` 协议，再按真实 Pi 修正为 `type=prompt` + **仅 `/purge ...`** |
| P1-C 真实双 Pi 进程 | 父项目私有脚本 `_artifacts/loom-v2-20261115/p1b-sandbox/p1c-managed-rpc-smoke.mjs` 真跑 exit0（AgentDock `session-a2c53d43eaac40a85c546bc6`）；A loaded+append+activated，B loaded+off，sessionId 不同，均 messageCount=0 | **真正的两个受管 Pi RPC 进程**，不能直接推论两个 Worker 真执行/产物生成 |
| P1-C 本机假 Provider：`scripts/loom-v2-pi-loopback-provider.mjs` + `.test.mjs` | `node --test --test-force-exit --test-timeout=420000 scripts/loom-v2-pi-loopback-provider.test.mjs` **7/7 PASS**（AgentDock `session-46911c71f65f269403504141`）；`127.0.0.1:0` 自动端口，仅 dummy key；Off 与 Append 分别真实 Pi 发起 OpenAI SSE 请求，捕获不同 System Prompt SHA256，收到真实 `agent_settled` 与固定答复 | **只确认本机 fake Provider PromptSeen=true**；外部真实模型、真实用户 Provider PromptSeen **NOT_RUN** |
| P1-C UI 事实投影：`apps/desktop/src/renderer/src/loom-native/v2-run-service.ts` + `.test.ts` | `pnpm exec vitest run apps/desktop/src/renderer/src/loom-native/v2-run-service.test.ts` **17/17 PASS**（AgentDock `session-c67a50fb3468531654666c3f`）；`pnpm typecheck` **exit0**（AgentDock `session-e71b9f865a5435abb66230be`） | 真 Claim/候选/核验/Review/验收各自有事实态，缺接口返回 unavailable；**尚未接进用户实际视图**，不宣称 UI 功能已上线 |
| P1-C 同库 Coordinator Event：`crates/rovai-core/src/loom/v2_coordinator_adapter.rs` | Root 在 `crates/rovai-core/src/loom.rs` 加入模块注册；`rustfmt --check --edition 2024 ...` **PASS**；`cargo check -p rovai-core --locked --lib` **exit0**（AgentDock `session-fdb1b9a5f3cceabfb2ab1752`，仅非阻断 warnings） | 新模块在 Core 源码中**可编译**，定义 append-only SQL + IMMEDIATE 事务 + replay 校验；**`MIGRATION_SQL` 尚未接生产 migration，15 条 Core 单元测试仍未跑完，不准签 DB Gate** |
| 原 WIP/仓库安全 | 5/5 SHA unchanged；原 64851 listener 仍在；`git diff --check` exit0，Core Adapter rustfmt exit0，`mindfile_guard.py verify .` exit0 | 不等于业务发布/跨主机验收通过 |

按以上**不同测试集**累计 76 + 78 + 18 + 17 + 7 = **196 条聚焦测试通过**；这些测试覆盖的对象不等于 196 个端到端场景，也**不得**换算为“P0–P14 已完成百分比”。Core Adapter 的 15 条测试**不包含在 196 里**。

## 未过 Gate、失败原因和严禁误判的界线

1. **Core DB 独立测试未通过门槛（NOT_SIGNED）**：`cargo test -p rovai-core --locked --lib v2_coordinator_adapter` 在 Windows Core 大单体测试构建中因 300 秒耗时上限超时，未拿到 15/15 结果；不能因 `cargo check` exit0 就当测试通过。下一任用受控、隔离目标目录/已确认 C 编译链处理，必要时增加适当的编译时间，记录 exit code 与具体测试总数；避免多套并发 cargo 争夺锁。
2. **原既有 Core Wire E2E 负例**：`node --test scripts/lib/loom-core-e2e.test.mjs` **0/2 PASS、exit1**：第一个隔离 Core 启动超过约 65 秒 ready timeout（最后日志 `runtime_search_ready`）；第二个测试尝试在全新 `CARGO_TARGET_DIR` 下编译，Windows GNU 环境缺 `gcc.exe`、`dlltool.exe`，`ring`/Windows Sys 依赖构建失败。当前已用缓存 `cargo check` 编译通过，但不能对这个真实集成负例报绿。先补齐**私有、受控开发工具链**，不去修改全局 Rust 配置；再排查启动超时是否为功能故障。
3. **主执行闭环未打通**：还没有通过单一 Core SQLite 正式建立 V2 Goal/Assignment/RunAttempt/lease/fence/Artifact/Review 的实跑录入、持久恢复与 UI 呈现；严禁第二个影子生产 DB、假 CLI RuntimeInstallation、由 UI 在无 Receipt 时显示成功。Adapter 只定义 SQL，Core 原 `loom.review` 仍是 Owner Authority。
4. **受管 Pi 守卫**：真实 Pi 0.85.1 RPC **没有** `run_command`，Root 已真查到 `Unknown command: run_command`；必须只用 `type=prompt` 的 allowlisted `/purge` 扩展命令，禁止让该监督入口发普通模型提示词。模型请求只允许由**另一条经过授权的真实 Run 路径**执行。Pi Purge `strict` 有覆盖 AGENTS/Skills 风险，生产默认不设 strict。
5. **下游质量门未验**：对外商业模型/真实工具调用、Skill/MCP/Rule/Hook 四能力 loaded/invoked、至少两 Worker 分工与成果审核、W12 可信 Device-only 身份（不伪装本机 CLI）、Linux↔独立实体 Windows 的 E5、断线 E6、生产 E7/发布均 **NOT_RUN**。历史 `pnpm docs:check` 还有 v1.72 两份原有确认元数据不全，不能伪造历史批准或擅自消掉它。

## Pi Skill 工兵归档 / AgentDock 现场

- 受管 Pi RPC：DeepSeek Worker `f877c0d91e6d4dcfa77236d36c7cf225` —— Root 在修正 `run_command`→`prompt` 并做 18 条聚焦测试 + 2 Bot 真运行后 **ACCEPTED**。
- UI Facts：DeepSeek Worker `5f2ddf8be33c4f72b64320fb86f31e30` —— Root 17 条 Vitest + 全仓 TypeScript check 后 **ACCEPTED**。
- Loopback Provider：GLM Worker `a6f84648cdb540fe8289572877b86e01` —— Root 用**真实 Pi** 连本机假 Provider 7/7 后 **ACCEPTED**。
- Core SQLite：GLM Worker `34bd1a5f82c642bfb5f638e5e75547ef` —— 文件已交付、rustfmt 和 `cargo check` PASS，**15 条 targeted Rust tests 待执行/Root 未签收**。模块注册已做，但**SQL migration 没做**。不将 Worker 自报等同于验收。
- Root 任务 `tsk_a21d75f405171f22` 继续 **ACTIVE**。别重复已经过的 P1-A/P1-B 四路合同或重做 Pi Bundle、不要重开只读 Scout 来“开发”；Pi Skill 工具权限在创建会话时冻结，写入时用新 `--agent worker --tools file,write`（明确独占白名单）。

## 接手顺序（具体可执行）

1. **先修 Core 测试环境并拿到真实 15/15 或完整失败清单**。只读确认原五 WIP SHA、64851 listener、当前 `git status`；读 `AGENTS.md` → `docs/README.md` → `docs/development/local-workflow.md` → 本文；使用受控编译链，不用生产数据复测。
2. **冻结单一 Core 写入契约**：代码位置 `crates/rovai-core/src/loom/v2_coordinator_adapter.rs`。验证 SQLite 外键/触发器/幂等/错代 fence/Owner Review 不可伪造，再考虑 additive migration（**只在隔离 fixture 试**，获 Root 审核前不进入真实 DB startup）。检查与既有 `loom.control`/ `loom.claims.list`、Candidate/Review 的数据主权冲突。
3. **接 Runner 与 Core**：复用 `scripts/loom-v2-managed-pi-rpc.mjs` 真管理 Pi 进程、锁定 Pi 包和 Extension 文件；每 Bot 单独 Profile，明确 Core RunAttempt/owner/lease/credential/device 的冻结快照与类型化回执。当前 Node 监督器无用户普通 prompt 接口，不能绕开安全边界直接冒充完成。
4. **落实最小真正 E4**：隔离 Core Mission → Goal → 主 Bot 指派**两个 Worker** → 真 Run/工具/工作区（先走 fake Provider + 受控工具）→ Artifact Candidate → 核验 → Owner Review → UI 从 Core 读真实状态；任何一道未通过就报 NOT_RUN/FAILED。然后在保留审批与 Grant 的前提下，另跑真实 Provider 资格门，绝不从本机假 Provider 推断商业模型已验。
5. **再接原 UI 和跨设备**：UI 服务 `v2-run-service.ts` 只读事实投影接用户认可的 Mikka 三栏，不碰五处旧 WIP；再完成旧 W12A/B/C DeviceInvocation 身份 / Node WS Transport / typed Artifact Receipt（原问题依旧在），后跑实体 Windows/Linux E5 和断线 E6。按主计划继续 P0–P14；不把一次 demo 当全产品结束。
6. **下一次交接**：只更新 `TASK.md`、`LOG.md`、`PROJECT_CONTEXT.md` 置顶 + 本文真实证据；不要重写完整规划 PDF。Root 分阶段 Review，每次留下命令、exit、测试数、文件路径、没跑的 Gate。不得无指令部署到 Bero 或 GitHub。

### 快速复核命令（从 `loom/` 根运行；自动验收只用隔离目录）

```powershell
git status --short
cargo test -p loom-protocol --locked --lib
node --test scripts/loom-pi-purge-bridge.test.mjs scripts/loom-v2-pi-purge-stage.test.mjs scripts/loom-v2-capability-plan.test.mjs scripts/loom-v2-pi-purge-hook.test.mjs
node --test --test-force-exit --test-timeout=10000 scripts/loom-v2-managed-pi-rpc.test.mjs
node --test --test-force-exit --test-timeout=420000 scripts/loom-v2-pi-loopback-provider.test.mjs
pnpm exec vitest run apps/desktop/src/renderer/src/loom-native/v2-run-service.test.ts
pnpm typecheck
cargo check -p rovai-core --locked --lib
# Important: the following targeted Core test has NOT passed and requires controlled compiler/time budget:
cargo test -p rovai-core --locked --lib v2_coordinator_adapter
```

**结论：已经实现了真正 Pi Extension 的 Provider 端可观察变化、双受管 Pi、可编译 Core 事件适配、UI 事实接口；尚未完成产品的统一 Core→双 Worker→Artifact→Owner Review→UI 闭环。下一任必须继续施工，而不是从架构研究重启，也不能将这份交接当作发布许可。**
