# LOOM V2 本轮续建：授权、UI 责任与可恢复证据

> **Latest independently verified increment (2026-11-16):** [Real upstream execution and delivery acceptance](../../LOOM-LIVE-ACCEPTANCE-2026-11-16.md). This supersedes older claims that E4 is entirely fake-provider-only or that no candidate was pushed; it does not sign off full E4-E7. User has explicitly re-authorized current implementation.


## 【2026-11-16 · 用户最终品牌决定｜原上传图锁定｜本机 Base/Pi 优先】

![用户指定的 LOOM 品牌标识（本机可用工作副本）](../../assets/loom-brand-user-approved-256.webp)

- **用户明确最终拍板**：**上图就是 LOOM 品牌**，不是“临时图”、不是“待讨论方案”；任何开发者或工兵**不得再质疑、换成自创 Logo 或把旧机器人当默认品牌**。用户认可整体 Mikka/LOOM 三栏 UI，不要求重做布局。上一轮助手错误声称“无法写入本地”、还否定过用户图片；事实是 AgentDock 有本地写文件权限，必须直接落盘、尊重用户决定。
- **素材已实际放入 Windows 本地仓库**：`docs/loom/assets/loom-brand-user-approved-256.webp`，真实校验为 WebP、256 × 256、5,026 字节、SHA256 `9bd461c1f5a44ebb0452297de50f5d713026bc7c417a7eba7ec0d67f14558d7a`。它是本轮用户原图的**缩放/压缩工作副本，非逐字节原图**。原上传的 `DA3A8DC1-579B-44C7-8C1B-A9082072277A.png` 规格 1254 × 1254 / 1,797,701 字节 / SHA256 `eff1aa63e7bdb3ebc5b1a58c3048bfa051553078a159f337c45cbe67f8a71d04`；不准把小图混称原 PNG 或悄悄换其它视觉素材。当前插图有实际文件可以打开。
- **后续最小品牌替换工单（尚未改 UI）**：① Web `apps/web/public/loom-favicon.svg` + `apps/web/index.html` 的 tab 图标；② Desktop `apps/desktop/src/renderer/public/loom-favicon.svg` + `apps/desktop/src/renderer/index.html` 的 tab 图标；③ `apps/desktop/src/renderer/src/loom-native/Avatar.tsx` 的 `LoomMark` 左侧品牌机器人（`apps/web/src/WebLogin.tsx` 也复用此标识）。全部用**用户这张同图**，不引入另一卡通脸；保持现有尺寸、三栏布局、深浅色、点击与键盘交互。用户自行设置的个人助手头像 `MemberAvatar.avatarRef` 不得无差别覆盖。根仓库源码**尚未替换以上图标**，实时 64851 预览也没有热改；不能拿“已交接”冒充“已上线”。
- **开发方式用户要求生效**：先调 AgentDock `agentdock_context`/`workspace_context`，按任务从 `C:/Users/echo/.claude/skills/base/SKILL.md` 读路由并用 `python C:/Users/echo/.claude/tools/base_skill_cli.py route`，再实际用已有的 `agent-browser-cli` / `computer-control` / `fast-context` / `ast-grep` 等匹配工具。小且可验的任务交 `pi-skill 0.5.7` 托管 `run`（在 AgentDock 中 `exec_command(async)`），不再造临时浏览器工具、不用失效的 `start` 伪后台；每轮最多2–3个互斥短工单，Scout/Reviewer只读，Worker先出方案再由 Root 批准文件白名单、最后 Root 独立实测并 `approve`。完整执行约束见 [唯一总计划 K 章](../../LOOM-V2-MASTER-PLAN.md#k-用户品牌标识与本机-basepi-技能开发合同2026-11-16)。
- **本轮实际动作**：Base Skill 真读/真路由，Pi Scout `a85580b2b5194ad5a98f7ca3b667e762` 完成只读源码定位（Web/Desktop 两套 favicon + `LoomMark`），Root 核对源码路径；原上传角色图的轻量品牌副本确已转入 Windows 项目。没有新品牌设计、没有改 UI 代码、没有中止现用 64851、没有推送 GitHub/Bero、没有触碰日常 DB/旧五处 WIP/全局凭据。下一次实现品牌视觉时以此图和这里的验收标准为唯一准绳，不重新征求风格意见。

## 【2026-11-16 03:28 UTC · CI-A 本机候选门禁落盘｜未推送、未在 GitHub 跑过】

- 新增候选 `.github/workflows/loom-v2-e3-windows.yml`（SHA256 `9f395271eab41a29b74811ae427fa622b72368d449b5d4014a343cf574371c92`）及 `scripts/lib/loom-v2-e3-workflow-contract.test.mjs`（SHA256 `9bff2ed420aab373d7933838c2b956d415f641d0acfb7ccacdd09be9ec10478d`），均仅在本机未追踪工作树：没有新建/提交/推送 GitHub 分支，没有远端 PR/Actions 运行/Bero 操作，不等于 CI 已通过。
- Windows 2022 E3-only `workflow_dispatch`/PR，禁 push/release，`contents:read`、checkout 不留凭据；固定 Node24.14.1、pnpm11.20.0、Rust1.97.1 MSVC，fresh Host+native Pi launcher/Web、Pi 0.85.1 沙箱打包、正式 Host Bearer→双 Pi FileGuard→Mikka Electron 实际自动化指针审批脚本；TAP 严格1/1、0skip，带 SHA/假 Provider 标志，只有成功且无凭据样式输出才上传3日证据。
- **本机新验证**：契约 Node **4/4 PASS exit0**（首轮因新增测试使用无效 JS `(?m)` 正则报错，已修 `/m` 后复测）；候选 YAML PyYAML 解析 11 steps；PowerShell AST 8/8 `run` 语法通过；既有本机 Pi 0.85.1 Bundle `--verify` exit0，tree SHA `5692cc77a900ec7fccc8b6e9dcc6648b8ec42d81e83b627cd06c21fd0707c871`；`git diff --check` exit0。DeepSeek Pi只读审查指出 E6 表述/Host新鲜度/Pi传递依赖问题，Root改成 E6 `NOT_RUN`、将 fresh 证据明确归属 CI build step、manifest 记录 Pi/Host SHA，并新增6,679个 node_modules 文件SHA闭包 `b4909d7f7cd8698626bc91a3eb5f265bbd297d6e8a89687f04c7a5293f9a27ee` 的远端 fail-closed 校验（GitHub 尚未实跑）；GLM只读审查超时中断，无有效验收。
- **未过/续建**：GitHub clean Windows/MSVC、Pi npm transitive 依赖可复现性、Electron Runner 显示/CDP、真正远端 E3 均未跑；旧本机 E3 仍有效但不是这个 workflow 的成功证明。E4真实 Provider/四Runtime四能力、E5实体跨机、E6全面故障、E7发布和真人 Owner 审批仍 OPEN。必须重新检查并获得 Root 独占租约、审严格可外传文件白名单与 GitHub 权限，另获远端推送批准后再尝试 V2 独立 PR；不要把计划/静态测试冒充已上线。五处旧 WIP/生产 DB/真实64851/全局配置/用户凭据未动。



## 【2026-11-16 UTC · 用户确认：GitHub/Bero 云端优先，停止无效重复编译】

- **已纳入唯一总计划**：[LOOM-V2-MASTER-PLAN.md §J](../../LOOM-V2-MASTER-PLAN.md#j-githubbero-优先的施工及验收路线2026-11-16)。后续不是默认全在用户 Win11 编译：GitHub Actions Windows Runner 做固定 commit 的 Host/Web+受管双 Pi+生产 Mikka Electron **隔离 E3** 清洁构建/自动回归；Bero（资源/源代码传输核查后）做 Linux Core、重型回归和云端设备协议；用户 Windows 只保留短增量、Windows DACL/Device、本机 UI 实际可用性与最终真实用户验收。此为**执行策略已写入**，非“现有 GitHub workflow 已接 V2 E3”或“已经推送/部署”。
- **下一项可执行任务 CI-A**：先从本机大量未提交变更审出严格白名单与独立 V2 分支，不得 `git add -A`、不得 main/Release；为 GitHub Windows 2022 新建 V2-only 的 PR/手动测试流程，固定受管 Pi 0.85.1 与 Windows 编译工具链，调用 `scripts/lib/loom-v2-official-host-electron-review.test.mjs`，保存 commit+Host/Pi SHA、完整测试日志、E3真值（scripted Provider，fixture UI 自动点击非真人）与清理情况；不触碰当前 v1.72。接着 CI-B 验证 Bero 实时可用空间/容器/权限，用固定 SHA 在隔离目录进行 Linux Rust 回归；Bero 无准入即用 GitHub Linux Runner，不绕过以前的拒绝。
- **Pi 派工变更**：Root 每次只开最多 **2–3 条短、互斥、可验收** 工单（2–4分钟目标），Base Skill 路由、Pi Skill 受管执行，单个 Worker 不改总计划/共享 UI；遇超时、跑错方向或重复构建直接收缩范围。Root 亲自监督 Mikka UI/Owner Review，不要求用户中途决定阶段或普通故障。严格记录当前与旧测试差异，不造阶段百分比。
- **当前真实基线和权限**：本轮此前已由Root在本机签过 E3 1/1正式Host+双真Pi+生产Web/Mikka Electron CDP 审核、fresh Host 和 fresh Web 构建；`E4` 真模型/四运行端四能力、`E5` 实体跨机、`E6` 故障、`E7` 发布**仍未签**。本轮**仅更改计划**，没有执行 GitHub push/Bero 同步、没有触碰用户 DB、64851、旧五处 WIP、全局秘密配置或远端服务。下次操作必须先重新取得独占 Root 租约，再按总计划 J4 检查外传/发布权限。
- **计划文档校验（不得造绿）**：`git diff --check` exit0、原五处受保护 WIP SHA+bytes 5/5 一致，总计划 A–J 与本交接链接存在。但全仓 `pnpm docs:check`（AgentDock `session-b3af9ad4cd1e9ecf89bec0ef`）exit1，报 **两处未改动 v1.72 model-context-change 文档** 的 `confirmed_revision/confirmation_status/confirmed_at` 门禁；`pnpm docs:test`（`session-298237d4dc4fd2743c3da96b`）exit1，至少有现存未改动 `.github/workflows/ci.yml` 包含 `push:` 与测试期望冲突。单独 `pnpm docs:check:decisions` 持续占用约一个 CPU 核心，Root 在约 1 分钟后仅定点停止**本次启动的** checker 进程，exit15，**不得记为 PASS**。上述红灯单独留下一轮治理，不为了写一份施工计划而顺手修改旧版本决定或 CI；本轮计划和用户数据仍保持安全边界。

## 【2026-11-16 UTC · 用户要求 Pi 工兵加速｜Root 真实执行证据】

- AgentDock 加速任务 `tsk_ecd6d3d32bcdfa73`；先核上一 Root lease 已释放后 CAS 取得限时独占租约。通过 Base 路由和 Pi Skill 0.5.7 受管 `batch --parallel 4` 真派四路只读工兵（正式 Host→Mikka Electron、生产 Core→Pi/E4、Windows Host fresh build、Mikka UX 复核），宿主 session `session-fad88b32c045a29f6373d815`；初始 Pi list 真实看到4个独立 Pi RPC 正在执行。未使用无法保活的 `start`；工兵自报不等于 Root 验收。
- Root 亲自实跑 `node --test --test-force-exit --test-timeout=180000 scripts/lib/loom-run-status-ui.test.mjs`，AgentDock `session-21c9e1be945e2278a9a78491` **1/1 PASS exit0**，隔离 Electron 真实指针27个交互、10张截图（1440/1040/760/390深浅模式）；Root亲自查看 `_artifacts/loom-v2-user-authorized-20261115/ui/run-aifPiw/screenshots/` 的1440昼、390夜和390夜unknown审批画面，正常阅读与恢复路径无明显横溢。该fixture `realCore:false,realModel:false`，不是E4产品验收。Root后续全仓 `pnpm typecheck` AgentDock `session-5c6bf64f366a634d0f5fd750` **exit0**。
- Root只读核实本机无 cargo/rustc 和 rovai/electron 活进程，以**进程私有 MinGW16 PATH**编译当前源码 `cargo build -p rovai-host --locked --bin rovai-host -j2`，AgentDock `session-db035887a621f5b6c3a43cbd` **exit0、Finished dev 29.55s**。fresh `target/debug/rovai-host.exe` SHA256=`c95133283690d5bd34f91396d6a4028340a51fbdeedc54d1e57f2832ce88c0bf`、191819577 bytes（旧缓存 `f99e968d...` 不同）。此前720秒timeout是历史红灯，但本轮fresh Host构建已成功；没动用户DB/64851/远端或正式迁移。
- 新构建二进制在**受保护隔离Core SQLite**复跑正式 Host Web Bearer v5 审阅认证 `scripts/lib/loom-v2-official-host-web-review.test.mjs`，AgentDock `session-f3e069d10b3e8e66a323cae4` **1/1 PASS exit0、约38.2s**，实测401/400安全拒绝、命令幂等和重启持久。但本用例是synthetic两件产物，Pi/外部模型/真人UI都没跑。随后**同一个 fresh Host** 复跑 `scripts/lib/loom-v2-official-host-real-pi-review.test.mjs`，AgentDock `session-bc3a767b07d87406b89ce7fc` **1/1 PASS exit0、约51.1s**，两真实 Pi0.85.1 FileGuard write、双Artifact/双pending Candidate、正式 Web Bearer v5 仅 A accepted/B pending、401/400/409和重启同库一致；本例仍 scripted fake Provider / 无真人 UI，E4仍未通过。
- **最新补证（覆盖此前“合链仍缺”历史状态）**：Pi Skill DeepSeek 写工兵 `b28b16f0c63e40edaaaa18c1d1e4a278` 唯一新增 `scripts/lib/loom-v2-official-host-electron-review.test.mjs`，经Root实读、`node --check`、实际两轮测后正式 `accepted`。第一次 AgentDock `session-7bcc3d30e773c3c3926158f1` **0/1 exit1**，已真实走到UI点击验收/记录，只是新测试错误假定Review带 `taskId` 字段（实际用 `candidateId` 关联），Root只修该单文件错误断言；第二次 `session-4ee960501e03201559aed2a8` **1/1 PASS、0skip、exit0、约58.1s**。此时**一次**真实 E3 集成包含当轮fresh官方 Host、同一隔离SQLite、2独立Pi0.85.1 FileGuard write、Core双Artifact/双pending Candidate、正式Host Bearer v5、真实生产Web `LoomApp` 在隔离Electron中用实际CDP鼠标开A正文/打勾/填理由/提交、Core1 accepted/B pending、错权限401/400、重复审核拒绝、Host同库重启和旧Bearer失效。`qaNonceTransport:false`、`fixtureProxy:false`、`actualElectronPointerInput:true`、`screenshotCaptured:true`（截图在临时fixture中按测试清理，未长期保留）；**非真人点击** `humanClickedUI:false`、**模拟Provider** `mockProvider:true,realExternalProvider:false`。对源码有Root独立实际构建记录，不依赖脚本自己固定的 `hostFreshBuild:NOT_VERIFIED` 文本。新单文件SHA256 `a6a8f66954d1160cdcd50472f6b1f2eb5e4ef756101ff93fa59f17408f07045d`。`pnpm build:web` session `session-8310733c433019479ff6a869` 本轮 exit0，Vite564模块，`out/web/index.html` SHA256 `e0c284f0e76fc98c91de4dfce35da1316e067f669bc5ab66260455df8fb62811`。本轮4并发Scout批次总结果**2/4交付并被Root accepted，2/4模型420s超时已returned**；真实经验应以2–3条短互斥工单并行，不虚报工兵加速倍率。**E3单链已通过，仍非可用版**：E4外部真实模型/四Runtime四能力Loaded/Invoked、E5独立物理设备、E6全面故障恢复、E7发行均OPEN；正式安装和真人UI接受亦未签。原五WIP SHA+bytes 5/5 unchanged，日常DB、64851、全局配置、用户凭据、远端未触碰。

## 【2026-11-16 · 正式 Host＋双真实 Pi＋Bearer Web API 单链 E3 通过｜不等于产品完工】

- **新独立纵贯测试**：`scripts/lib/loom-v2-official-host-real-pi-review.test.mjs`（DeepSeek Pi Skill 工兵 `142286a3d7b446598b50043837342a20` 按唯一新增文件白名单交付；Root 审核并只修非法 fixture Tag），使用正式 `rovai-host.exe` 在 Windows 产品准备的受保护隔离 Core SQLite；两个真实受管 Pi 0.85.1 分别经 FileGuard `write` 与本地脚本假 Provider 产出两份独立文件，Host 本地可信管道登记 Claim/Fence/双 SHA256 Artifact/双 pending Candidate，初始 Review 为 0。随后正式 Host Web **Bearer protocolVersion 5** 认证的 HTTP API 读取两件真实 Pi 产物，显式 fixture Owner 意图只接受 A，B 保持 pending；未认证 401、过时协议 409、五种生产者 RPC 禁止远端调用 400；同 commandId 幂等重放、新 commandId 重复审批拒绝 `LOOM_REVIEW_EXISTS`；logout 使 token 失效，Host 从同一 SQLite 重启仍一 accepted、一 pending、一 Review。这是**正式 Host API＋双真 Pi 的单次 E3 链**，不是原 QA nonce 代理。

- **真实回执及红灯**：首跑 `session-c0e13f5bae0ce2c3ec0b1a30` **0/1 exit1**：`mission.invalid_tag`（只缩短新测试 fixture 标签）；修复后 `session-f091cfeb449906f14d46cb89` **1/1 PASS exit0**，再次验证并落 TAP `session-6fb1bf0070d06e00ffbe5b4b` **1/1 PASS、0skip、exit0**。命令：`node --test --test-force-exit --test-timeout=600000 scripts/lib/loom-v2-official-host-real-pi-review.test.mjs`。`node --check`、`git diff --check` **exit0**；本轮复验 Mikka Vitest **67/67**、`pnpm typecheck` **exit0**。长期证据：`_artifacts/loom-v2-automation-20261116/official-host-real-pi-review-e3-tap-20261116.txt` 和 `official-host-real-pi-review-e3-manifest-20261116.json`。

- **证据身份及禁区**：新增测试 SHA256 `8971143ff6d51654439b5c7692464546e4abec801056fa4ff75f3ba641f2627a`，实际运行 Host **历史缓存** SHA256 `f99e968d4d28f465de1047b5fbca2e1d06eee2cc2ddbfbaa676170ec34a0f491`，真实 Pi 可执行文件 SHA256 `589ddf44aa38f596fbd2f9aa5b0edf5e4533da23344d8ea555dae623e08d9151`。当前源码 fresh Host 编译仍未验；Windows protected root 由产品 prepare，但 ACL 未另行审计。原五处 WIP 的 SHA256+字节 5/5 一致；64851 无监听且未重启；不碰生产 DB、真实 Key、全局配置、远端。已受理 GLM 只读安全审查 `7b3261c916ad4cb7a52ae06c42940bdb`，工兵自报不是验收凭证。

- **未过 Gate／下一次**：此测试使用 scripted loopback fake Provider，**没有真正商业模型 E4**，也**没有正式 Host 与原 Mikka Electron UI 的真实用户点击**：`reviewerId=local_user` 仅由隔离 Host 注入；UI 的 QA Electron 指针链仍是另一条独立 E3 证据。下一阻塞链：用正式 Host Bearer 授权把双真 Pi Artifact 接到生产 React/Mikka Electron 用户可操作界面（先隔离自动化再人工授权操作），补同一链身份/Grant/失联负例；随后 fresh Host build、四 Runtime 四能力 Loaded/Invoked、物理 E5、恢复 E6、发布 E7。**4–6 周版 IN_PROGRESS；E4–E7 NOT_VERIFIED。**

## 【2026-11-16 · 正式 Host Web E3 auth / Core 同库审阅新增】

- 2026-11-16 00:33 UTC，新建独立 `scripts/lib/loom-v2-official-host-web-review.test.mjs`：在 Windows protected 临时 Core SQLite 上，经**正式 rovai-host Web API**（不是 QA nonce 代理）用本地 Host pipe 先种入两份**合成** Artifact/Candidate，实际 `/api/v1/login` protocolVersion 5 验证 Bearer；无票证 401、未准入生产者 RPC 400、归档 HTTP 预览不产生审批、显式 `loom.review.record` 仅批准 A、B pending、相同 commandId 重放只留一条 Review、登出失效 401、真实 Host 停机重启后仍留 A accepted/B pending。Root 实跑 `node --test --test-force-exit --test-timeout=360000 scripts/lib/loom-v2-official-host-web-review.test.mjs` **1/1 PASS，0skip，exit0**，实际测试约30.9秒；`node --check` 与 `git diff --check` exit0。证据 `_artifacts/loom-v2-automation-20261116/official-host-web-auth/official-host-web-raw-tap.txt` 和 `e3-manifest.json`。本次使用**历史缓存 `rovai-host.exe` SHA256 f99e968d...**，尝试按当前源码 fresh `cargo build -p rovai-host --locked --bin rovai-host -j2` **720秒超时**，不能标记 fresh Host 已过。此新增用例未运行 Pi/模型、未由人点击 Mikka UI；与此前真双 Pi+QA Electron 单链分别是独立 E3 证据，**不可拼成正式 Host→双 Pi→真实用户 UI 端到端验收**。E4 真商业 Provider/四端四能力、实体 E5、全面 E6、可发布 E7 仍 OPEN。五处 WIP SHA256+字节 5/5 原样，64851 无监听且未重启；生产 DB、全局配置、凭据和远端未触碰。下一步应采用受控编译产物在同一正式 Host 认证链接真实双 Pi FileGuard 成果，并做用户界面身份/审阅负例，不重做已签 E3。


## 【2026-11-16 · 单链纵贯 E3 新验收与真实限制】

- 已通过一个**单次**自动验收方案：2 个实际受管 Pi0.85.1 分别用 FileGuard `write` 工具产出独立文件 → 同一独立 Windows protected Core SQLite 的双 Claim/Fence/Artifact/Candidate → 现有生产 React `ArtifactView` 的隔离 Electron 真鼠标打开 Pi 原文并提交一次 Owner Review → Core 重启仍 1 accepted/1 pending。QA nonce+Mission RPC 代理仅限隔离测试，三个实际未授权请求 403，Core 提交前无 Review；不是生产 Host 授权，也不是用户真人 UI 点击。
- Root 顺序回归 2/2 PASS 0skip exit0，`session-1810f23ee37421d033dae616`；历史首次 screenshot capture 因显示表面不可用 exit1，如实记录修为 `screenshotCaptured=false` 而非伪造图像。新证据 `_artifacts/loom-v2-automation-20261116/guarded-pi-electron-5fa3eb18-8286-4a63-bb18-cd71e1991c1b/`，原证据不覆盖。假 Provider `realExternalProvider=false`，真实模型 E4、四 Runtime/四能力、实体 E5、完整 E6、E7 **仍未签**。
- 下一次别重复此 E3；核对独占总管租约后，改为通过正式 Host 的身份和授权把同一 Pi 成果推送原 Mikka UI，验证撤权/错代/重放及人类实际审批；原五 WIP/生产 DB/64851/全局模型配置/远端保护不变。

状态：IN_PROGRESS。最终目标仍是原定 4–6 周单用户可用版，不因局部测试通过而缩小范围或宣布完工。总蓝图沿用 `LOOM-V2-MASTER-PLAN.md`，历史基线沿用 `LOOM-V2-P1C-PROGRESS-HANDOFF-2026-11-15.md`。

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

## 本轮用户明确授权

用户要求：普通错误由总管自行排查，继续通过 Base Skill 路由和 Pi Skill 并行开发；进度写在电脑上的交接文件，不逐阶段询问或播报。UI 风格已定，但顺手程度由总管本人监督、实际检查与验收，不能仅凭工兵自报或构建成功签收。

本轮已经重新连接工作区，读取项目规则、Base/Pi Skill、本地隔离流程、DESIGN 与当前源文件；已通过 Mindfile 写入边界检查。四路真实 Pi Skill 分别负责 Runtime、Host 能力声明、单库 Core 集成和只读 UX/安全审查。前三路先交只读微计划，Root 审查后按互斥白名单写入；UI 组件、布局和最终交互由 Root 自己处理。

## Root UI 验收责任

保留现有 Mikka 三栏、配色、动态头像和工作/资产/流程/电脑结构，不重新发散设计。重点检查：切换工作时不串状态、刷新不闪空、失败有重试、草稿不丢、结果未知不重复提交、键盘焦点和小屏布局、成果能打开并保持版本归属。研发诊断放在可展开详情里，不把一页术语和永久写死的测试阶段文案当成产品体验。模型执行、技术核验、独立审查、用户接受分别显示；不新增假的批准或百分比。

## 已实际保全的基线

`_artifacts/loom-v2-user-authorized-20261115/baseline-manifest.json` 保存了本轮编辑前的 UI/事实服务与记忆文件备份摘要。原五处受保护 WIP 已逐一核对，5/5 与此前 SHA 基线相同。本轮首次只读检查原预览端口仍无监听；不据此猜测原因或擅自启动旧数据服务。

## 操作边界

开发与验证使用项目内独立 fixture、Profile、数据库、Skill Library 和 MCP 根；不改全局 Pi/DSH/Claude/Codex 设置，不复制用户账号文件，不读取或打印密钥。真实模型验证只通过用户已批准的模型通道及显式受管授权；不自动替用户接受成果。原五处 WIP、真实用户 DB、旧日常服务和远端发布保持保护。普通开发授权不解释为任意提权或绕过 OS/Host 生命周期。

受管命令仅在实际工具会话内执行。本记录不会把 ACTIVE 状态、已有定时任务或正在排队的工兵当成离线持续运行保证。

## 最新实施与验收

尚在本轮施工，测试结果按后续真实命令及回执追加。之前 E3 的 fake Provider、缓存 Core 和模拟 Owner 限制继续保留；没有新证据前 E4–E7 不签收。

## Root 本轮实测增量（2026-11-15T19:03:24.403657+00:00）

- 原生 Core 已在当前工作树真实 fresh build 成功：`cargo build -p rovai-core --locked --bin rovai-core -j 2`，仅进程级私有 MinGW PATH，exit0，116.42s。旧文件先备份；新 SHA `64d5e469b558e72bbf365ce7ede1f529195973fcec49943255566d61c509ee9d`，冻结副本在 `_artifacts/loom-v2-user-authorized-20261115/build-current/rovai-core.exe`，对应 build manifest。**只构建，没有用新 Core 打开真实用户库、替换旧 Host 或执行生产迁移。**
- A Runtime/Pi guard 经 Root 两轮退回（自检/环境/未知结果）与独立安全审查后，最终 27/27 真测试通过，固定源码 SHA 前后相同。包含真实 Pi 下越界读写、硬链接拒绝、受控新文件写读、超时 unknown，取消时序和事件保留有单元反例；10 项独立 safety 用例属于另一 Root 的贡献，不冒认。原生文件守卫不是 OS 沙箱，仍只限隔离自有工作区；无商业模型/产品 E4 结论。A 会话已正式 accepted。
- Root 亲自重做运行/成果信息层级（保留既定 Mikka 视觉）：成果先于诊断、技术核验/评审/用户接受分开；慢 Host 的同工作刷新合并、不被轮询饿死；跨工作旧回执隔离；成果正文使用同身份的新事实；待确认验收冻结 commandId/payload，重开恢复且不自动写；未发送草稿关闭后保留、明确取消才丢弃；焦点返回和主题跟随。**早期真 Electron 14 交互+8截图已验；新增26交互+10图仍等最终服务稳定后重跑，不沿用旧绿灯。**
- B 验收幂等服务曾37/37通过，但 Root 随后发现嵌套冻结、清理状态、receipt完整性与不可变身份缺口并退回；当前TypeScript发现mock类型/unknown缩窄错误，B正在修，不能签最终 UI。
- C 原生Core派发：第一轮缺独立reviewer，第二轮已真实产生Run但错误把 AgentConversation UUID 等同群聊 Thread，仍12/13。已退回按真实snapshot/Delivery映射修身份，不删跨线程保护，不fake RunID。
- E新增只读微计划会话 `964f417f811245eb9e2ec9f36ec436a5`，研究 Windows 下现有生产Core→PiHost链最小隔离验证；不会沿用macOS-only脚本、复制用户Pi账号配置、打开旧64851数据。先loopback/dummy key，Root批准再写两文件。
- 总目标保持 ACTIVE，E4/E5/E6/E7仍未签。现有按小时续建安排为防多Root并发暂未启用；当前只有实际受管会话代表在执行。下一Root先检查租约与文件所有权，不能按文档ACTIVE猜测仍在后台工作。

### 生产 Pi 权限审查纠偏

Root 逐字核对随包 Pi0.85.1 的 `node_modules/@earendil-works/pi-coding-agent/dist/cli/args.js`：`--approve` 在205–209行只设置 `projectTrustOverride=true`，307–308行说明为本次信任项目本地文件；**不是“自动批准所有工具调用”**。只读审查工兵此前扩大解释已撤回，未经实跑的越权负例不记为实际成功。生产Host当前缺少本文 A独立Runner的路径守卫，仍需按真实源码/实际负例单独接线与验收；不能拿独立27测试代替Core权限证据。

同源 builtin helper 已实际编译：`cargo build -p rovai-core --locked --bin rovai -j 2`，exit0/62.05s，SHA `2554da544af0a069c7180c7053fbd6505fc1cc1864a86cc7afae011da2816102`，冻结在 `build-current/rovai.exe`。此前错误地假设另有rovai-cli crate导致assertion失败，未运行编译/未改变用户环境；已按实际Cargo bin路径修正。

- C 原生派发第四轮 Root 真实 **14/14 PASS** /57s，前后源码 SHA 一致并正式 accepted。已用同事务 ThreadSnapshot 的 camp绑定证明真正Run归属，而非将AgentConversation UUID错误等同群聊Thread。未配置Runtime的队列/阻塞是明确结果，不冒称模型执行或E4；全部3轮失败保留。

## 【2026-11-16 · 最新隔离 Core + 双受管 Pi 文件工具到待审成果接线｜Root 实测】

- **新的真实纵贯增量，不是产品完工**：Root 新增 `scripts/loom-v2-core-authorized-receipt.mjs`、`.test.mjs` 与 `.real-pi.test.mjs`。隔离受保护 Windows Core data-root 的**同一个真实 SQLite**先创建 Mission/Plan、两独立 Task 与两 Claim/Fence；两个**真实 Pi 0.85.1 进程**各自使用独立本机 scripted fake Provider，通过预先加载且验证的 FileGuard 真执行 `write` 工具，在隔离工作区写各自产物。桥先核 Core Claim + Fence/expiry/Run 身份、Guard self-test 与 allow/toolCallId/relPath、实际文件 SHA256；再由真实 Core `loom.artifact.register` 重新计算两个 Host 文件哈希，提交两个 `loom.candidate.record`。两者均 **unverified/pending**、Review 列表空，**不自动验收**。同一 Core 停止并从**原 SQLite 重启**后，两 Claim、两 Artifact、两 Candidate 和零 Review 均恢复；Core loom.artifact.preview 在待审阶段及重启后均从不可变归档返回两份 Pi 真正写出的精确文本与 SHA256，**Core API 可读不等于用户已经在 Mikka UI 亲手打开或接受**；证据是 E3 局部恢复而非跨设备 E5/故障恢复 E6 全门。
- **Root 真测试**：`node --test --test-force-exit --test-timeout=420000 scripts/loom-v2-core-authorized-receipt.test.mjs scripts/loom-v2-core-authorized-receipt.real-pi.test.mjs scripts/loom-v2-core-pi-integration.test.mjs` → **37/37 PASS、exit0、0 skip**；Mikka V2 UI facts+panel 聚焦 `pnpm exec vitest run apps/desktop/src/renderer/src/loom-native/V2BotStatusPanel.test.tsx apps/desktop/src/renderer/src/loom-native/v2-run-service.test.ts` → **42/42 PASS、exit0**；`pnpm typecheck` exit0。原始 TAP/Vitest: `_artifacts/loom-v2-automation-20261115/core-guarded-dual-pi-tap.txt` / `ui-focused-vitest.txt`，源码/二进制哈希与保护清单 `source-and-safety-manifest.json`。被测 Core executable SHA256 `64D5E469B558E72BBF365CE7EDE1F529195973FCEC49943255566D61C509EE9D`，此前另一 Root 已从本树 fresh build；本轮仅在隔离 root 执行，没有重新编译、打开日常 DB 或变更发布版本。
- **真实回归红灯与修复**：第一轮联合验收 **32/33 PASS，1 FAIL**：旧 `resolveUiBundleFacts` 在新 Core 真支持 `loom.bundles.getMany` 后，把 Core `LoomArtifactsListResult={artifacts:[...]}` 当裸数组，导致 `undefined !== 2`；Root 在非保护文件 `scripts/loom-v2-core-pi-integration.mjs` 只兼容真实 typed wrapper 或历史裸数组，且严格验证数量/错误，不把未知异常降级成功；增加正反例后重跑 **37/37 PASS**。新增桥包含错误回执不可重播、错代/失效租约拒绝、Provider 身份不得伪造、路径/Guard 双回执、产物字节 Hash 不一致拒绝等负例。
- **硬边界**：本轮有 DeepSeek/GLM Pi Skill 独立只读审查；其文本不作为代码交付，所有新代码与测试由 Root 亲自写入及复验。**mockProvider=true、realExternalProvider=false、realCommercialModelQualified=false、osSandbox=false**，临时脚本 Core client 可模拟；新桥尚非生产 Host 受控入口，尚未接用户真实 Mikka UI 点击审批。最终 E4 真实 Provider/四 Runtime+四能力、E5 独立实体、E6 跨故障恢复、E7 可发布、真实 UI 用户 OwnerReview **NOT_VERIFIED**，没有用户通知或上线行为。
- **保全**：五处原 WIP SHA256/字节数与固定基线 **5/5 相同**，64851 **0 listener**（原因仍未证实，未重启），日常用户 DB/全局 Pi/DSH/Claude/Codex/真实账号/远端均未碰。下一段：把当前 Guard-Run/Claim/Fence/Artifact 真回执接入**正式 Runtime Host 授权/任务分发**，在隔离用户界面实点 Owner Review 并验证 Core 角色/审批回执；再按总蓝图继续其他 Runtime/四能力、实体 Device/E5、E6/E7；绝不因这批 E3 绿灯标 4–6 周完成。

