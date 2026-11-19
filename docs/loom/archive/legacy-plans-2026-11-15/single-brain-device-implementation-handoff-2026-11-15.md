# LOOM A 单脑 / B-C 纯手脚：分阶段实施交接（2026-11-15）

> **历史实施实验，不是本轮继续实施的授权。** 用户最新明确要求先讨论 Mikka 式 Bot、多设备模式、Pi/DSH 选型和详细计划。此处 Rust/UI WIP、测试失败与双节点脚本仍是可恢复的真实证据，但“B/C 必须纯 daemon”未获最终确定。新讨论主文：[architecture-discussion-master-plan-2026-11-15.md](../plans-2026-11-18/research/architecture-discussion-master-plan-2026-11-15.md)。

> **范围：单用户 / 多设备开发实例，非已发布云端服务。** 用户新轮已授权在本地项目内实施，要求研究后经 Pi Skill 多路工兵完成、主管负责安全/UX 验收、每一小阶段落盘。此前同日“仅讨论、未授权实施”的记录只适用于上一轮消息；此处为后续新阶段事实。严禁把开发预览、静态源码和真实 B/C 物理机器验收混为一谈。

## 当前冻结事实与架构边界

A＝**Rust Core + 一个 Agent Harness**：规划、记忆、分工、审查、证据和用户验收属于中心；B/C＝**没有 DSH/Pi/Codex/Claude 的轻量 Node**，只负责出站连接、确定性的设备工具执行、本地准入和回执。B/C 本地执行授权拒绝不算模型决策。详细技术与参考：[`central-brain-hands-only-2026-11-15.md`](central-brain-hands-only-2026-11-15.md)。

- **H0 研究完成（源码级，不是功能交付）**：`yet-another-ai/deskfleet` 固定 HEAD `098485a4c4024ff33fb37e8635e2b1b1bba857da`（Apache-2.0），它的中央 Rust 管理设备而本地 Daemon 仍会 spawn ACP Agents；WebRTC 主要承载 PTY/Files/Desktop 的点对点数据/媒体，不能照搬成云 A 单脑。 `microsoft/UFO` UFO3 Galaxy 固定 `eae3c0a8d168c47cb10df0652e293e092eda1078`（MIT），有中心 DAG/设备画像，但 A 的 ConnectionManager 主动拨设备服务器，B/UFO2 又有 HostAgent/AppAgent 自主 LLM，不符合 B/C 仅纯工具。
- **勘误**：只读 Pi UFO Scout 因 sparse checkout 未检出 `ufo/`、`aip/` 曾误判原仓缺失/无认证。主管扩展检出后亲查 `ufo/server/app.py` 的 API key、`aip/messages.py` 与注册确认心跳，已经在上述 H0 研究文档纠正。DeskFleet Scout 对 HTTP 管理白名单范围亦有遗漏，主管已校正。所有复制参考思想需合法和独立原创，未拷贝参考仓代码。
- **H1 Node hands-only：源码落地，实际 Rust 构建/测试仍进行中，不能标通过**。仅改 `crates/loom-node/src/lib.rs`、`session.rs`、`process_wire.rs`：新增 `--device-only`，不探测本机 Agent CLI、不起 Builtin bridge、空 R1/ProcessPipe 广告、误投 Start/Open 拒绝、仍保留认证出站/准备工作区/R2 WorkspaceRPC/按 Host 明确允许的 Computer v1。Pi 计划及实施 session `348742e7b9544e27a39da9c40cbd94ae`。代码和 4 类 unit regression 已由工兵写入，但测试尚需等待真编译完确认；`h1-node-worker-result.txt` 只是工兵自报，不是 Root 验收。
- **H2 A 模型→B/C 设备：尚未实现双节点 E2E**。现有 Core/R2 的 `loom.workspace.list/read/run/poll/cancel` 与 Node Workspacerpc 支持真实 AgentRun lease 和固定 `git.status`；R2 **不等于任意 Shell、任意文件路径或 GUI**。目前证据仍只到源码和旧单节点测试，真实双 Node fixture/断线负例和云 A 单 Harness 真实多设备执行未完成。Pi 只读报告 `h2-workspace-rpc-scout.txt`；两节点 fixture 的只读工兵计划进行中，不能提前当 PASS。
- **H4 右侧 UI：源码、单测、构建、隔离预览静态资源完成**。Pi 工兵同 session `679d9931d8ee4e9096d2c97efc63fed6` 只改 `loom-native/Inspector.tsx` 和 `product.css`；主管纠正标题与四 Tab **必须整体在 Hero 下**，选中助手真实 Avatar / 会话名在可缩短约上1/3，Existing OpenBotAvatar 引擎随鼠标动、遵守 reduced-motion。专项 Vitest **30/30**、`pnpm typecheck` **exit 0**、`pnpm build:web` **exit 0**，本轮 build 生成 `out/web`。
- **H4 已激活到用户的隔离预览（仅前端静态文件）**：`http://127.0.0.1:64851/`，Host PID `12944` 身份验证为 `kit/bin/loom-host.exe`，`kit` 和 `data` 均位于 `_artifacts/loom-ultimate-20261113/resume-01/preview/`。新 `index.html` SHA-256 `46f3f01923bf039179d2fe4d9a448c99c7d5745a8498fae04d8de24a6bf4376a`（与部署证据 JSON 一致）；真实的静态切换见下路径。第一次校验误把 Host 的 `__ROVAI_HOST_KIND__` 运行时插值与原 HTML 字节直接比较，已自动回滚；第二次按实际 `server` 插值校验，HTTP 首页/新 JS 和 CSS 均 200，新旧资源共存，Host PID、端口、Core 数据根未变，原 web 可回滚备份 `kit/web-backup-20261115-hero`。
- **H4 尚未完成**：用户聊天图三“粉发绿眼黑猫耳”透明抠图、左上 LOGO、favicon、眼睛分层、真实浏览器窗口细节视觉验收；现有源图未移入 Windows 项目。不要以静态构建成功谎称品牌素材已完成，也不要让用户普通 Hanzi/Linxi 头像全被品牌替换。
- **H5 生产云端/设备安装**：未做。没有真实云 A 和独立 B/C 物理主机的授权状态/节点凭据/后台常驻安装验收，不能声称“已部署双设备”或“已发布”。

## 可恢复证据与当前运行状态

- 统一根：`_artifacts/loom-single-brain-20261115/`。
- 研究：`source-deskfleet-scout.txt`、`source-ufo3-scout.txt`，源码根 `_artifacts/reference-repos/deskfleet`、`ufo-galaxy`（均浅克隆且在忽略目录）。
- H1 Rust 实验：`h1-node-worker-result.txt`、`h1-node-unit-test.log`（只有 test 进程正常结束后才会落盘，未结束前不是失败证据）；`h1-rustfmt-check.log` 目前第一次在 Rust 编译锁上耗时150s退出，没有产生格式结果，不能计 PASS/FAIL。
- H4 UI：`ui-typecheck.log`（0）、`ui-web-build.log`（0）、`ui-preview-static-deploy.json`（ok）；静态文件部署时读取 Host 逻辑 `crates/rovai-web/src/lib.rs:801-857`，验证插值后的 `index.html` 及 JS/CSS。旧静态资源保留供现有浏览器标签页延迟加载，不能删除备份。用户刷新浏览器可看到新 Hero；`127.0.0.1` 是 Windows 本机地址，不是手机外网入口。
- 原有 WIP 始终保留，不用 `git reset`/`clean`，不改生产 DSH/Octopus 进程、不上传凭据、不操作用户日常客户端目录。未提交/推送代码，不将服务打包或注册系统自启动。

## 下一阶段接手时的严格次序

1. 重新读取根 `AGENTS.md`、`TASK.md`、本文件与合同；用 `git status --short` 对账已有 WIP。
2. 取 `cargo test --offline -p loom-node --lib` 真结果；Rust 很慢，不能把运行中当 PASS。若编译失败，由同一 Pi Node session 精确修复最小范围；若成功，再做受控真实 `--device-only` 配对/误投/恢复的 E2E。
3. Pi H2 worker 首轮计划审查后，才按独立测试文件边界授权实现双 Node fixture；不可复制旧测试中有本地 CLI 的 B，却宣称 B/C 都纯手脚。
4. 对 R2 仅限已经准入的工作区进行 list/read/git.status，强制校验 Run/epoch/workspace/owner/replay/grant；旧 `ListDir/ReadFile` 带绝对 root 的 ServerMessage 是**管理层历史工具**，不能误当成已实现按本次 AgentRun 细粒度授权的 DevicePort。
5. 最后再扩大浏览器、PTY、Computer 和授权矩阵；真实独立设备和云 A 验收只在用户指定实际设备/网络/权限后标完成。图三 LOGO 应在取得源图并完成真实 alpha/眼部分层后另行发布。

## 11:41 +08 主管复核：后续运行结果纠正（以本段为当前状态）

本节晚于上面的“仍在进行中”，请以此为准。用户本轮主动要求停在进度与架构交接说明，不要为了赶进度把单元测试/两节点 E2E 混报成功。

- **H1 已确实完成 Rust 编译并执行单测，但尚未验收：** `_artifacts/loom-single-brain-20261115/h1-node-unit-test-resume.log` 显示 `cargo test --offline -p loom-node --lib` 编译结束，**54 passed、1 failed、2 ignored**。失败为新加的 `session::device_only_tests::misrouted_start_and_pipe_commands_are_refused_without_spawning`，在 `session.rs:1850` 收到 Windows TCP socket error **10053** 而 panic；是 fake WebSocket 测试的链路收尾表现还是实际 R1 拒绝边界问题，**当前未定位，不能销项**。其余 device-only 广告与单独 refusal 单测通过。Node lib 有少量 warnings。单独 `h1-rustfmt-standalone.log` 有格式 diff，尚非格式门全绿；`git diff --check` exit0（只有 CRLF 提示）。
- **H2 双节点测试脚手架现在已写入，但没有运行：** Pi 工兵 `947770cca3ef4da3b351f53793136e77` 第二轮完成 `_artifacts/loom-single-brain-20261115/twin_node_fixture.py`（750 行）和 `r2_twin_node_cases.py`（333 行），总管执行了两个文件 `ast.parse`，都仅 **语法通过**。没有编译出 H1 后的固定 Host/Node/CLI 三件套，也没有实际运行双节点配对、WorkspaceRPC、重连、取消、文件字节归档。任何 `T0–T7` 状态全部 **NOT_RUN**，不能算 PASS。
- **严格拓扑与产品缺口：** 已发现现有 `crates/rovai-web/src/nodes.rs:2232` 对同一 mission 只保留一个 remote `mission_workspace`，而 camp↔mission 1:1。因而**同一 AgentRun 同时分派 B/C 两个不同远端工作区不成立**。工兵采用 Plan A 仅作为验证脚手架：**两个 camp、两个 A-local Runs** 分别连 B 和 C。它不证明用户指定的“一个 A 脑拆任务，B/C 只是手脚，真正多机并行”的产品闭环，**该差距未消除**。必须先设计并决定最小多 Workspace 授权关系，不能靠换测试标题伪称已经实现。
- **H4 现状未变：** 右栏 Hero 前端单测30/30、TypeScript/Web build exit0；隔离预览 `127.0.0.1:64851` Host PID 与数据根验真、HTTP新HTML/JS/CSS成功。只是用户 Windows 本机的预览 Web 静态替换；无品牌图三资源/真实 UI 完整视觉验收，也不代表远端 Node 功能投产。
- **运行/安全状态：** 最新 `git status --short` 仅有五个修改源码（Node 三份、UI 两份）以及当前/历史文档 WIP，未提交/推送；两份双节点测试处于项目忽略的 `_artifacts`，必须靠上述路径恢复。当前并无这轮仍在运行的 Cargo 编译，Pi 此次 H1/H2 已标 completed（指工兵响应完成，**非测试验收**）；AgentDock 任务仍 `active`，阶段 `integrate`，`accept`/`handoff` 尚 pending。旧 AgentDock 命令 session `session-47df36785c254fdce3e9211e` 是其他长跑会话，**未擅自结束**。真实生产 PC、用户 DSH/Octopus、登录凭据与系统自启动未操作。

**后续仅按严格主线继续：** 先把 H1 的 10053 单测失败定位/修正并测绿；再用**双 Node 都为 hands-only** 的固定编译产物真正跑 A→B/C 的白名单工具闭环与全部负例；接着解决 **同一 A Run / DAG 下多远端工作区的准入与调度**，并独立验收。浏览器/桌面/PTY/长驻安装、外网与品牌 Logo 都不作为“多机单脑已交付”的替代证据。

## 验收原则

工兵 `ok=true`、源码存在、Rust 单元测试、UI 静态 build、隔离预览和物理云多设备是不同层次。只有对应可重跑证据明确通过才能标记；没有运行的测试写 `NOT_RUN`。用户只看最终结果，因此阶段证据留在这里，不强迫用户阅读中间日志。
