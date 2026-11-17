# LOOM 下一代架构：Mikka 式 Bot 工作台 × 可移动大脑 × 多电脑设备 × 插件能力（方案讨论稿 v0.9）

> **重要状态：DISCUSSION / PROPOSAL，非用户已确认的技术决定，也非实现授权。** 用户明确纠正：“我们还在探讨，你就开工了”。此前 `central-brain-hands-only-2026-11-15.md`、`single-brain-device-implementation-handoff-2026-11-15.md` 中的 **A 唯一 Harness / B-C 必须纯工具** 是一种候选部署模式，不是用户不可改变的硬约束；此前 Pi 工兵写出的 `--device-only` Rust 改动与 UI Hero 属未合并 WIP/阶段验证，不得以此锁死产品方向。本稿仅规划、只读研究、保存参考 Git 快照和交接，**不继续修改 LOOM 产品源码、安装服务、迁移数据或发布**。用户允许未来**大重构**，但仍要求先有充分方案与可复核验收，再进入实现。

## 0. 用户原意：先把“要什么”与“怎么做”分开

### 0.1 要什么（用户目标，而非固定技术手段）

1. **“像 Mikka 的 Bot”**：当前 LOOM 左中右、单聊/群聊、工作/资产/流程/电脑和整体 UI 大多已喜欢，继续打磨手感；聊天对象是有身份、有记忆、会安排事情、会告诉你“等你处理什么”的 Bot。用户换电脑、换设备、打开 Web 仍能找到**同一个 Bot 和工作进度**。不把 Mikka 代码/数据库整套移植。
2. **右侧 UI 原话要点**：右侧“工作空间”标题及 `工作 / 资产 / 流程 / 电脑` 四 Tab **整体下移约 1/3**；上方约 1/3 留给**当前对话助手的大头像**，眼睛柔和追随鼠标；右栏可拉宽/缩小。当前 `Inspector.tsx` 已有 Hero 雏形，继续做的是质感/响应/性能/身份联动，不是推翻现有 UI。
3. **品牌图三**：粉色头发、绿色眼睛、黑色猫耳与黄色内饰的用户提供形象，用于**浏览器 favicon 和页面左上 LOOM 品牌标志**。须去掉原深色背景，交付真透明 RGBA、白底/暗底检视及可选白底导出；页面大 Logo 可分层瞳孔随鼠标，**favicon 静态**。图片三并未存入 Windows 项目，不能把已有编织机器人标志冒称新 Logo；不能把所有助手的自选头像换成品牌图。
4. **电脑 B 的疑问**：云端 Agent 能不能像 **AgentDock / MindFS** 一样直接操作电脑 B 的文件、终端、浏览器、屏幕？**不应该必须**先在 B 装 DSH Host 才能调用 Pi/Codex。**但“B 也可装本地 Runner”并未被用户否决**，必须保留不同运行模式供比较。
5. **四类能力 + 记忆**：Skills、MCP、Rules、Hooks 能扫描、管理、选择、启用、实际生效；以 Claude 配置作为重要的**只读来源/初始导入参照**，不是默认在 LOOM 里执行 Claude，也不是把 Claude 全局目录当唯一运行真源。Pi/DSH/Codex 等原生兼容程度不同；记忆是独立的第五层。
6. **先一个人，未来企业**：先单用户/多项目/多设备；终极是 Linux 云端长期运行 LOOM，大量 Windows/macOS 电脑能注册、接入、执行，手机/另一台电脑登录继续用同一个 Bot；之后才讨论团队、组织、知识 RAG、权限与审计。用户允许评估 Pi 内核和 DSH，**尚未批准直接换掉 Pi**。

### 0.2 不把“参考方案”误当“用户硬约束”

- “A 云端只跑一个 Harness、B/C 仅常驻 daemon 不做决策”来自用户转述的**AI 给出的参考拓扑**，可作为 **Mode T（纯工具节点）** 优先试验，**不是**排斥 Mode R（本地 Runner）或 Mode H（混合）的法律条款。
- “同一个大脑”是**一个 Bot/任务协调与记忆的连续性**，**不要求只有一个 OS 进程、一个 AgentRun ID、一个远端 Workspace**。一个用户目标可以有多个子任务/Run；关键是中心计划、归属、依赖、权限和结果归档统一。
- “Full / Ask / Never”不是一条真假值，审批行为、文件/网络/屏幕授权范围、OS 沙箱强制是**不同维度**。
- “选择工作目录”是用户的**默认上下文与启动位置**，不自动等于跨目录读写授权；这句话**不矛盾**：UI 帮你选项目，执行端依授权决定真实可访问的范围。

## 1. 已经直接核对的来源和镜像（只读研究证据）

GitHub 参考放在 `_artifacts/reference-repos/`（LOOM `.gitignore` 忽略，不进产品 Git）；2026-11-15 通过 `git ls-remote origin/main` 验证四个用户指定的参考仓与远端相同。没有执行任何参考仓程序或安装其依赖。

| 参考 | 本机固定版本/路径 | 可学的轮子 | 不能照搬 |
|---|---|---|---|
| `Stonewuu/agenteam` | `agenteam`，`d12b50760b091d8783eca7bf8c11f113d063e4cb`，Apache-2.0 | 审批与资源授权分离、Workspace 路径约束、Docker/远端 Sandbox、企业角色、Skill/Plugin 生命周期 | Java/AgentScope 体系不是 LOOM Rust Core 的即插即用模块；它的“FULL_ACCESS”主要是审批策略，不是 OS 全盘权限 |
| `himovo/movo` | `movo`，`e16174acc4edeb30534d87d9f7f5ff8806854955`，**MOVO Community License** | DSH 官方 Host/Cordis 插件组合、Profile 隔离、能力安装、组织审批、沙箱/知识管理 | Community License 限制第三方多租户 SaaS、白标/OEM 与其前端 Logo；开源仓**不含其完整 Desktop 控制端**，只能借鉴思想或另行取得授权 |
| `yet-another-ai/deskfleet` | `deskfleet`，`098485a4c4024ff33fb37e8635e2b1b1bba857da`，Apache-2.0 | 中央注册/设备列表、daemon、WebRTC PTY/文件/桌面、设备会话与 Peer grant | 设备 daemon 可启动本地 ACP Agent；它证明 Mode R 可行，不意味着 A 已经拥有一个唯一的云端 Brain |
| `microsoft/UFO`（UFO³ Galaxy） | `ufo-galaxy`，`eae3c0a8d168c47cb10df0652e293e092eda1078`，MIT | 中央 DAG、设备能力/健康/负载 registry、任务/结果事件 | 设备端 HostAgent/AppAgent 可有 LLM；Galaxy 中 A 常主动连接设备 Server；UFO 自己的 API key 和注册确认不能误判为“没有鉴权” |
| **Mikka** | `mikka-current`，`d59c85cb321b2b466616960db49dea8f038c2384`；旧固定快照在父目录 `../_references/mikka`，`137334b1...`；AGPL-3.0 | **Bot / Chat / Task / Thread / Run 分离**，右栏 Bot 头像/工作/电脑，Factory 派工、Attention/Question 卡、云端/本地机器选择、daemon 电脑 broker | 公开代码的部分 UI 通过 `@ui-slot` 私有 overlay 注入；AGPL 网络交互义务与产品分发需法务评估；Mikka Bot 的 E2B 云电脑不是用户 Win11 B |
| **MindFS** | `mindfs-current`，`6768bc1e5180bea0c16b435bdc6e87c40c51602b`；旧快照父目录 `../_references/mindfs`，`965d90f...`；AGPL-3.0 | Go 远程工作站的 FS 根、命令执行（底层有 PTY，但**未证实完整远程交互式 PTY 的 stdin/resize 通道**）、Relay/本地服务、独立 Agent pool | 访问文件/终端可不运行 Agent CLI，但其“Agent 聊天”依旧要 Runtime；不能把它说成已经支持全平台原生桌面控制 |
| **DeepSeek Harness** | `deepseek-harness`，`39163dd30f703a79079e2d2446545cff3c453738`，MIT | Cordis 服务/事件/Plugin、Profile/Overlay、工具前后门禁、SDK/ACP/Headless 组合 | Plugin 是运行时内部扩展，不是远端 OS 权限；不能把 DSH Windows sandbox 的 partial 当成强隔离 |
| **Pi Agent（本机参考）** | 父目录 `../_references/pi-agent`，`ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba`，MIT；本机 CLI `0.85.1` | JSONL RPC、Agent Skills、TypeScript Extensions、`tool_call` 拦截、**原生 MCP extension/client**、子 Agent/自定义工具 | Extension 在 Pi 进程内拥有同等 OS 权限，**不是隔离插件**；参考 fork/本机安装能力需实测对齐，不能按旧印象说 Pi 没有 MCP |
| **PiBot / AgentDock** | PiBot 父目录 `../_references/pibot`；AgentDock 通过当前授权的本机 connector 实测文件/命令/任务接口 | 视觉/电脑工具的使用感、托管任务、Windows 实际操作 | ChatGPT AgentDock 的 connector 权限**不会自动移交给 LOOM Cloud**，需独立设备配对、凭据与本机授权 |

**源码锚点（复核时先读，不依赖二手总结）：**
- Mikka `docs/design/glossary.md:9-27,59-77`：Bot 聊天/派发，Agent 执行 Thread，右栏 Bot 身份；`components/nav/context-panel.tsx:72-125` 右栏 tab 与可拖动宽度；`components/nav/bot-overview.tsx:78-96,114-153` 电脑与 Bot 概览；`lib/coordinator/wake.ts:32-74` 事件唤醒；`lib/factory/automatic-dispatch.ts:156-247` 设备/模型选择与派工；`packages/daemon/src/device-gateway.ts:1-114` WSS 信号；`packages/daemon/src/computer/broker.mjs:11-90` 受控电脑授权；`lib/computer/permission.ts:1-11` 旧 ask/缺省→allow，**LOOM 不照搬**；`lib/profile/memory.ts` 与 `lib/attention/store.ts` 记忆/注意力。
- MindFS `server/internal/relay/wsconn.go`、`relay/services.go`、`commandexec/runner.go`、`fs/registry.go`、`agent/pool.go`：Relay、命令执行、FS 根与 Agent 会话是分离模块；**Shell 底层使用 PTY ≠ 已实现通用远端交互式 PTY**。
- AgenTeam `agenteam-server/src/main/java/com/stonewu/agenteam/model/execution/entity/ToolApprovalPolicy.java:3-31` 和 `service/workspace/WorkspacePaths.java:16-88`：审批不授予资源、根与真实路径检查。
- MOVO `services/chat-api/dsh/runtime-host/src/official-host/composition.mjs:37-115`（真正检查插件激活）、`overlay.mjs:9-85`、`code-permission-policy.mjs:1-20`、根 `LICENSE:1-35`。
- DeskFleet `agents/docs/architecture.md`、`apps/daemon/src/agents/acp.ts:120-146`、`apps/server/src/peers.rs:90-122`；UFO `galaxy/client/components/connection_manager.py:70-111`、`galaxy/client/device_manager.py`、`ufo/server/app.py:20-111`、`ufo/agents/agent/host_agent.py`。详见历史 `central-brain-hands-only-2026-11-15.md` 的已纠正源码核验。
- DSH 官方 `docs/architecture.zh.md:1-90`、`docs/cordis-primer.zh.md:1-52`、`docs/tool-execution-pipeline.zh.md:1-69`；Pi `packages/coding-agent/docs/extensions.md:1-86`、`docs/rpc.md:1-85`、`docs/skills.md:1-90`、`examples/sdk/14-codemode-mcp.ts:1-62`。
- LOOM 现有 `docs/architecture/cross-host-execution.md`、`docs/contracts/workspace-rpc-v1.md`、`docs/loom/ultimate-interface-contracts.md`；`crates/rovai-core/src/member_capability.rs:1-85` 已有四类选择；`crates/rovai-core/src/agent_runtime_adapter.rs:35-53` **目前是编译期 adapter registry，不是动态插件 ABI**；`crates/rovai-web/src/nodes.rs:2228-2235` 有“按 mission 返回已有 workspace”；`crates/rovai-core/src/mission_schema.sql:50-85` 保存 MissionWorkspace；`crates/loom-node/src/computer_provider.rs:1-33` 有原生输入/断线栅栏；`apps/desktop/src/renderer/src/loom-native/Inspector.tsx:91-117` 已有 Hero 雏形。

FusionSearch 已通过本机 `~/.claude/skills/fusionsearch` 调用：doctor 显示 8 源 up；多源原始结果在 `_artifacts/loom-architecture-20261115/fusion-{dsh-pi,device,platform}.json`。搜索结果有明显噪声（设备问题甚至混入 Medicare 页面），**不以搜索摘要覆盖上面的固定源码证据**。

## 2. 建议的用户心智模型：保留 LOOM 视觉，借 Mikka 的责任边界

- **Bot / 助手**：用户聊天的有名字、有头像、有长期记忆的“伙伴”；主助手可协调、解释、问你批准，**不是权限超级管理员**。用户换设备时身份不变。LOOM 现有 AgentProfile 不能直接粗暴改表；先定义 `BotIdentity` 的逻辑投影及现有 agentId 兼容映射，确定是否需要新表后再迁移。
- **对话 Chat**：人与 Bot/群 Bot 的交互；选择 Bot 不自动开启任务或扩大权限。
- **工作 Goal / Task**：Bot 把目标拆为可审阅的依赖图、等待你处理的审批/问题和成果；**任务状态、Run 结果、用户接受**三者独立。
- **Run / Worker**：一次真实 Agent 执行，可使用 Pi/DSH/Codex/Claude（Claude 当前仅可读发现，不执行）；一个 Goal 可含多个子 Run、不同设备或不同工作根。不要把“Bot”和“运行端”合成同一个对象。
- **Device**：可被 Bot 通过工具使用的电脑，或可运行本地 Harness 的机器；“电脑离线”不等于 Bot 消失。
- **Project / Workspace Root**：默认项目目录和额外根；路径永远属于某个 `deviceId`，不是 A 的本机路径。
- **Capability / Memory / Grant**：能力包、持久记忆、授权是三类对象；勾选能力 ≠ 已加载 ≠ 允许访问 B 的 C 盘。

Mikka 的 `Bot` 与 `Agent` 强分离、右栏“Bot 概览”及 Factory/Attention 模型值得学；但 **LOOM 不需要重建 Mikka 的 Postgres Factory 数据库**。映射现有 Core 的 Thread/Mission/Task/AgentRun/Artifact/Approval，新增必要的 Bot 与 Device/Capability 投影即可。

### 2.1 深读 Mikka 后，最值得学习的不是皮肤，而是这六个机制

1. **Bot/Agent/Run 三种身份各有自己的记录**：`lib/db/schema.ts` 分开 Bot、Agent、Run；`drizzle/20261027164502_computer_run_bindings.sql:1-13` 用两个外键把云电脑 Run 同时归属执行者和 Bot 所属者，**没有把 Bot 本身当运行进程**。LOOM 先记录 Bot→Goal→Step→Run 的关系；“谁派活/谁拥有成果/谁付款”可在多用户时延展，单用户不必现在复制 Mikka 的 Postgres DDL。
2. **可靠唤醒不是“模型一直在线轮询”**：`lib/coordinator/store.ts:66-108` 的 durable coordinator events + `lib/coordinator/wake-after-commit.ts:20-43` 的提交后唤醒 + `lib/run-recovery-due.ts` 的定时兜底，解决“用户发了消息/子任务结束但 Bot 没醒”和重试丢事件。LOOM 应先检查现有 Core outbox/事件/Run 回执，**只补缺的投递/恢复**，不要另建一套不可追溯的队列。
3. **“需要你”是单独的注意力层，不是每次都弹权限**：`lib/coordinator/triage.ts:10-56` 先规则处理用户消息，再把其他事件分成 `attention/result/background`；代码明确“模型分级不等于授予权限”。LOOM 右栏/聊天里可做“待你处理”卡，但 Core 的 Grant 仍独立强制。
4. **电脑是有租约的工具，不是永远被 Agent 占着**：`lib/computer/store.ts:157-209` 人类 takeover/handback 有约 5 分钟控制租约、epoch 增量；`packages/daemon/src/computer/{broker,proxy,driver}.mjs` 分 broker、代理与实际驱动。LOOM 已有 Computer v1 租约和 Node Provider，优先对齐缺的远端 AgentGrant，不照搬 Mikka `lib/computer/permission.ts:1-11` 的缺省/旧 ask→allow。
5. **一 Run 一机器的生命周期与 Bot 长期身份分离**：`drizzle/20261029011635_subagents_thread_machines.sql:18-36` 的 `thread_machines` 用 runId 关联 sandboxId、operationId 与状态，`bot_subagents` 的 `needs_you` 及追加事件日志独立。对 LOOM 的意义是“换电脑 Bot 不失忆、每次设备操作可重放/审计”，**不必复制 Mikka 的 E2B 沙箱**。
6. **公开 Mikka UI 并非官方全部源码**：`docs/ui-overlay.md:9-14,29-42` 公开 `@ui-slot` 契约，官方 Web/Desktop 会从私有 `mikka-hosted-ui` 注入 **51 个 slot**，包含收费 UI 组件。我们能学习交互模型和公开 props/调用链，但不能宣称已逆向私有组件，更不能直接移植 AGPL/收费品牌代码。LOOM 自己的 `loom-native` 是产品 UI 真源。

## 3. 候选架构：不是“只有一种 A/B/C”

```text
      手机 / 浏览器 / Windows/macOS LOOM UI
                 （同一个 Bot）
                       │
                 HTTPS / WSS
                       ▼
       ┌───────────────────────────────┐
       │ A：LOOM Core / Control Plane   │
       │ 身份、Bot、Chat、Goal/DAG       │
       │ 记忆、能力目录、Grant、审计     │
       │ Run/Artifact/用户验收唯一事实  │
       └───────────────┬───────────────┘
                       │ 运行时接口 RuntimePort
              ┌────────┴─────────┐
              │ Pi Host / DSH Host│  ← 选哪个“思考”与设备无关
              │ Codex/Claude适配 │
              └────────┬─────────┘
                       │ ToolRouter / DevicePort
                授权、请求ID、重连/回执
           ┌───────────┼───────────┐
           ▼           ▼           ▼
        Windows B    macOS C     Linux D
       LOOM Device  LOOM Device LOOM Device
        Files/PTY    Files/PTY    Files/PTY
        Browser      Browser      Browser
        Desktop      Desktop?     Desktop?
           │           │           │
     可选本地 Runner（Pi/DSH/Codex）≠ 必须安装
```

### 3.1 三种可共存模式（产品建议）

| 模式 | 设备端装什么 | A 做什么 | 适合场景 | 代价 |
|---|---|---|---|---|
| **T：Cloud Brain + Tool Node** | 轻量 daemon；**不要求**本地 Pi/DSH/Codex | 云端 Harness 规划，跨设备 DevicePort 调工具 | 手机发任务、换电脑仍用同 Bot、远程文件/终端/桌面 | 工具往返延迟、云模型可见部分数据、桌面授权复杂 |
| **R：Remote Runner** | daemon + **用户可选**本地 Pi/DSH/Codex | A 派有界子任务，B 本地 Agent 在指定工作根执行，结果回传 | 大仓库、本地账号、低延迟工具循环、隐私/带宽 | B 要装 Runtime、模型/插件版本/权限需本机维护 |
| **H：Hybrid** | 同一台设备可既提供工具又提供 Runner | A 对轻操作直调 B 工具，对长编码任务派 B Worker | 最接近 Mikka 的 Bot 派活和 AgentDock 的电脑操作体验 | 调度与权限模型更复杂，必须显示“谁在思考/哪里在动手” |

**建议先把 T 做成可验证的基础能力，同时保留已有 R1 本地 Runner 能力；H 是自然组合，不在一开始强制所有设备安装完整 DSH。** 这是候选优先级，不是用户已经签字的唯一部署拓扑。

### 3.2 中心“一个大脑”不等于“一个 Run”

**纠正上一轮过度推断**：LOOM `nodes.rs:2228-2235` 的“一个 mission 查回已有 Workspace”限制的是**当前 Mission 工作区绑定**，**不证明必须先把一条 AgentRun 改成可同时拥有 B/C 两个 worktree，才能实现一个 Bot 统筹多机**。至少两条路线：

- **路线 G（先验证，优先）**：一个 `Goal/TaskPlan` 是中心协调父对象，下面多个 `Step`（依赖 DAG）；每步可以各自有一个真实 Run/Workspace/Device，B/C 并行执行，父 Goal 聚合回执和用户验收。原 MissionWorkspace 1:1 约束可以先保留，避免破坏现有 Git 工作树/清理合同。要求 Core **真实持久父子关系、因果与授权**，不能只拿两个独立 camp 的脚本就冒充“统一任务”。
- **路线 M（有真实需求再做）**：同一 AgentRun 需要连续读取 B/C 多个根，新增有版本的 `RunDeviceScope` / `RunWorkspaceGrant`，ToolRouter 每次按设备/根准入；是否扩展 `mission_workspace` 为 1:N 要以真实需求和 DB 迁移成本评估。可以让 DevicePort 绑定多根，而不立即把 MissionGit 工作树强行合并。
- 两条路线可并存：**计划/验收父子层 G** + **逐工具跨根调用 M**。先完成 G+窄 DevicePort，再按用例证明 M 的必要性。不能从“单脑”偷换成“同一 Run 必须绑定两台设备”。

### 3.2a 主管与只读 Pi 对现有 LOOM 的源码纠偏（不能误以为“重造 Core”）

- **MissionWorkspace 数据库本身并非绝对 1:1**：`crates/rovai-core/src/mission_schema.sql:74-76` 的唯一键是 `(mission_id, execution_host_id, git_common_dir)`，允许同一 Mission 在不同 Host 有多条；实际单条限制主要来自 `crates/rovai-web/src/nodes.rs:2232` 的“任意已有 workspace 就短路”、`crates/rovai-core/src/execution_node.rs:701-716` 的 `LIMIT 1`、`application/mission.rs:952-955` 的清理 `.next()` 和 `mission_workspace.rs:1779-1801` 的 `first()`。因此 **不要先改表**；路线 M 若需要，先做按 host/workspace 的准备、发现、逐条清理和回滚兼容。
- **R2 现有授权可覆盖同 Mission 多个 ready workspace**：`workspace_rpc_authority.rs:22-63` 依 mission/camp、prepared token、状态核验；但 Run 级发现/附加根 Grant 与实际 API 短路仍不足。先设计只读可见范围与准入，再决定是否需要扩张 Run 单根冻结。**单个 Bot Goal 多 child Runs（路线 G）仍是更小、低风险的起点。**
- **远程 Node 配对/连接已经有真实现，但不能直接开公网**：`crates/rovai-web/src/nodes.rs:332-395,1595-1605` 有一次性配对、身份摘要和 Node 出站；`nodes.rs:2005-2033` 对 `/nodes/pair` / `/nodes/connect` 有 loopback gate。P7 必须设计可信 Cloud Gateway/代理与 TLS、Node 身份、用户授权、限速、吊销，不能只填 `public_origin` 就声称云端能用。
- **远端电脑的“人看/人控”与“模型自主控制”不是同一条路径**：`crates/rovai-web/src/lib.rs:260-277` 已有远端 Computer 节点 API；但 `computer_agent.rs:1418-1466` 的助手 Grant 绑定本地 Host deviceId，**尚无远端 nodeId 的模型授权路由**。DevicePort 的 AgentComputer 需要复用现有 Host 电脑租约/代次/回执，**不是**让模型直接调用 B 的原生鼠标 helper。
- **Windows 虚拟屏已有一部分安全语义**：`resources/computer/host_desktop.py:178-181,395-424` 以平台与屏幕 bounds 计算 deviceId，`computer_agent.rs:1443-1447` 对尺寸/设备不匹配拒绝；不应重复造“屏幕代次”。先实测 UU/RDP session 变化是否被现有 deviceId/epoch 完整覆盖，只有出现缺口再加 `displayGeneration`。
- **四能力已有 B7 冻结/物化，缺的主要是设备侧原生发现与实际回执**：`crates/rovai-core/src/member_capability.rs:1-85`、`crates/loom-node/src/mcp_environment.rs`；`crates/loom-protocol/src/lib.rs:76-101` Hello 尚无原生 Skill/MCP/Rule/Hook 清单；`crates/rovai-core/src/remote_execution.rs:110-114` 目前远端 Runner 只允许 Claude/Codex，**Pi/DSH 的远端 Runner 仍要适配**。不能把“已有能力库”说成完全没有，也不能把“配置选中”当实际运行加载。

### 3.3 分层与接口（待正式合同评审，不直接当作 wire 已实现）

**Control Plane / Core（保留）**：`BotProfile`、`Chat`、`Goal/Step`、`AgentRun`、`DeviceRegistry`、`WorkspaceBinding`、`Grant/Approval`、`CapabilityInventory`、`Memory`、`Artifact/Review`。沿用现有 SQLite、命令幂等、Run 冻结、R1/R2/B7/ComputerPort；**不造第二套任务数据库**。

**RuntimePort（薄适配器）**：`start / stream / toolCall / steer / approve / cancel / recover / health`。Pi RPC 与 DSH SDK/ACP/Host 各自有真正的状态语义；`prompt accepted` 不等于 Run 结束，`agent_end` 也未必等于最终 settled。Codex/Claude 保留原生适配器，不用“兼容层”偷改其设置。

**DevicePort（设备工具，不是 Agent Runtime）**：`FilePort`（list/read/write）、`TerminalPort`（固定命令→受管 PTY）、`BrowserPort`（受控 Profile）、`ComputerPort`（看屏/人控/Agent 控）、`LocalServicePort`（明确端口白名单）、`OptionalRunnerPort`。首期只做有界、可验的工具，不把现有 R2 `git.status` 偷偷扩成任意 Shell。

**建议请求 Envelope（示意，不是现有协议）**：
```text
toolRequest {
  requestId, parentGoalId, stepId, runId, attempt,
  actorId, deviceId, workspaceRootId, capabilityId,
  grantId, policyRevision, connectionGeneration,
  deadline, inputDigest, operation, boundedArgs
}
toolReceipt {
  requestId, deviceId, generation, seq,
  state: accepted|running|completed|denied|cancelled|unknown,
  outputDigest, archivedEvidenceRefs
}
```
Node 不接受模型传来的任意本机绝对路径/执行程序/授权字符串；它验证真实配对、Grant、当前 OS 用户、canonical root、工具白名单、重复请求、代次、取消。A 只保存逻辑 rootId；B/C 真实路径只在本机解释。

**Transport**：首期复用已有 Node 主动出站 WSS/TLS + Core ledger/heartbeat/replay；远程桌面高频帧再评估 DeskFleet 的 WebRTC/DTLS/TURN。数据通道可以 P2P，**授权和审计仍归 Core**。断线有副作用的请求保持 `unknown`，不换 requestId 自动重做。

### 3.4 Windows / macOS / Linux 的设备现实

- Windows 11 B：daemon/service 可在后台提供文件、终端；**桌面截图/输入需要交互用户会话 companion**。无实体显示器、UU 虚拟屏、RDP 切换会改变显示设备、分辨率、登录 session；不能用 Session 0 服务假装有可点击桌面。屏幕切换时递增 `displayGeneration`、撤销旧输入租约，重新枚举显示并提示；UAC/锁屏/安全桌面不绕过。
- macOS C：daemon/launchd 与登录用户进程分离；屏幕录制、辅助功能、自动化需要用户在系统权限面板授权；无授权时 Files/PTY 仍可用，ComputerPort 显示 `unavailable`。
- Linux A：云端 headless 服务不需要实体桌面；Linux D 若要图形控制，明确 X11/Wayland/XDG portal 的实际 provider 与用户授权，不能把 Windows 测试代替 Linux/Wayland 验收。
- 用户“换电脑继续用”依赖**中心 Bot/Chat/Memory/Goal/证据**与设备无关；设备离线/换机仅改变执行地点。不要把用户长期记忆和项目目录全同步到每个设备。

## 4. 内核选择：现在**不把 Pi 换成 DSH**，先做公平 Bake-off

### 4.1 已有可验证事实

- **Pi**：本机已跑通 DeepSeek V4.1 Flash / max 的 Pi RPC；`_references/pi-agent/packages/coding-agent/docs/rpc.md` 定义 JSONL、`agent_settled`；`docs/extensions.md` 的 ExtensionAPI 支持 `pi.on`、`registerTool`、`registerMcpServer`、`registerProvider`；`examples/sdk/14-codemode-mcp.ts` 展示内置 MCP 扩展。**Pi 并不是“只能写提示词、没 MCP/Hook”**。但 Extension 同进程权限高，插件隔离必须由 LOOM 外部实现。
- **DSH**：官方 `docs/architecture.zh.md` 定义 Cordis Plugin/Service/可逆注册、Profile/Overlay、SDK/ACP；`docs/tool-execution-pipeline.zh.md` 有 `tools/pre-execute`→单调守卫→审批→执行→`tools/post-execute`；`packages/sandbox/sandbox/README.zh.md:62` 明确 Windows ACL 属 **partial enforcement**，生态比“手写 agent-loop”成熟。MOVO 的 `composition.mjs` 证明可在产品中受管组装和核对插件加载；**不等于 DSH 在本机 LOOM 已经封包、验证远端 DevicePort 或跨平台强沙箱**。
- **Codex / Claude**：保留原生 RuntimeAdapter。用户此前明确 Claude 不运行，只有只读发现可做；真实模型测试只用用户指定的 DeepSeek V4.1 Flash / max，不隐式换模型。

### 4.2 建议决策

**短期产品默认继续 Pi，DSH 作为受管、可回滚的第二 Harness 候选，不做破坏性替换。** 原因：Pi 在现有 LOOM 已有实际链路和较低接入成本；DSH 生态/生命周期优势真实，但插件 ABI、版本锁、启动/内存、Windows/云端、授权和状态恢复尚未在 LOOM 等条件验证。将来若 DSH 胜出，可以**只切 RuntimePort 默认绑定**，Core 的 Bot/任务/设备/记忆/授权不需要随之迁移。

**评测门槛（同一个 DeepSeek V4.1 Flash/max、同提示、同工具、同数据、隔离根）：**
1. 启动/打包/升级/卸载/崩溃恢复，Win11 x64 与 Linux x64，后续 macOS arm64；进程/内存/冷启动。
2. 真实工具调用、并发与流、取消/重连/unknown、会话恢复与成本记录。
3. 四能力各 1 条真实激活 + 1 条失败：Skill 载入、MCP 连接与 tool、Rule 注入证据、Hook 阻断危险调用；**运行端各自提供实际加载回执**。
4. DevicePort：A 上的 Pi/DSH 分别经 Core 读取 B 上同一受控文件、执行固定命令、处理一次 Ask；不能用本机 cwd 冒充远端。
5. 安全：未信任插件不能读控制面 secrets；恶意 Hook/extension 不能越过 Core Grant；失败不会静默切到另一个模型或 Runtime。
6. 完整评分表记录 `pass/fail/unsupported/unknown`、实测延迟、内存、回滚成功率、版本 SHA；**没有等价实测前不改默认**。

## 5. 四能力管理 + 记忆：不造一套假“全端兼容”

### 5.1 统一目录、来源和实际生效分层

产品目录的候选 `CapabilityManifest`：
```text
id, type(skill|mcp|rule|hook|memory-provider|runtime-adapter|device-provider),
version, sha256, origin, license, trust, ownerScope,
supportedTargets[{runtime,os,mode:native|adapter|unsupported}],
requiredGrants[{device,root,action,network,secretRef,computer}],
configSchema, healthProbe, installReceipt, activationReceipt
```

**五层事实必须分开**：
`discovered`（扫描到）→ `inspected`（来源/内容/许可审过）→ `selected`（助手/项目选中）→ `materialized/loaded`（本次 Runtime 真正加载）→ `invoked`（真实调用且留证）。再加 `failed/unsupported/revoked`。UI 不能把“勾选”直接显示“运行成功”。

**来源扫描**：Claude 全局与项目 Skills、MCP 配置、Rules、Hooks 只读导入**元数据和内容摘要**，不得读取/复制 API Key 明文、自动执行 Hook、自动覆盖 Pi/DSH 原生配置；Pi/DSH/Codex 也各有 `SourceScanner`。同名不同来源/版本必须可区分。Claude 可当参考来源，但不是运行时唯一真源。支持“来源/版本/覆盖优先级/当前有效状态/为什么未生效”可解释界面。

**运行时物化**：Core 冻结本次 `EffectiveCapabilitySnapshot`（来源 hash、助手选择、设备范围、Runtime 支持矩阵）；RuntimeAdapter 只把它翻译成该端**确实支持**的加载方法，收 `loaded/unsupported/error` 回执。不能用提示词“你有 MCP”替代真正的工具连接。

### 5.2 四类的不同本质

- **Skills**：方法说明、资源、脚本；跨端可按 Agent Skills 格式复用部分内容，但脚本执行仍受 Node/Runtime Grant；不要复制未经审查的脚本到系统全局目录。
- **MCP**：外部 Server/Tool，带连接身份、OAuth/credentialRef、所在设备与工具权限；**一个 MCP Server 不等于一个已获授权的系统工具**。模型调用先走 Core/Runtime 适配的审批与日志。
- **Rules**：提示/工作约定，支持作用域和优先级；Pi 可通过 Extension `before_agent_start` 注入 Claude 规则，DSH 可用 Prompt/Plugin；**Rules 不是 OS 安全边界**。
- **Hooks**：真正可执行的生命周期回调；Claude 原生事件、Pi `tool_call`/session 事件、DSH Cordis `tools/pre-execute` 并不完全同名同语义。定义 LOOM 级有限事件集合 `beforeRun/beforeTool/afterTool/afterRun/onApproval`，各端映射表标 `native/adapted/unsupported`；高风险 Hook 在隔离宿主运行，不能默默把 Claude command Hook 当 Pi/DSH 同等安全。
- **Memory（独立第五层）**：`ChatEvent`（可追溯对话事实）、`BotMemory`（用户授权保留的长期偏好/目标）、`ProjectKnowledge`（项目文档/代码索引）、`RunEvidence`（工具和成果）分开。记忆有来源/可见范围/版本/撤销/删除与引用，检索后由 RuntimePort 注入**有权**的片段；不让 Pi/DSH 自己维护另一份不可见的产品记忆真源。

### 5.3 设备与插件扩展：学习 DSH，不重新实现 Cordis

**LOOM 外层扩展点**只定义 `RuntimeAdapter`、`DeviceProvider`、`CapabilitySource/Loader`、`MemoryProvider`、`UIContribution` 的版本化契约。DSH Cordis 插件仍在隔离的 DSH Host 内运行；Pi Extension 仍在隔离的 Pi Host 内运行。**不要把 Cordis 插件直接塞进 Rust Core，也不要自己再写一个完整 Agent Loop**。未知/第三方插件按进程/容器隔离，独立配置与可卸载版本，不能在控制面进程内共享所有密钥。

### 5.4 从 MOVO 真正值得借的企业运行层（已由主管复核源码）

- **受管 DSH 组装与“加载证明”**：`services/chat-api/dsh/runtime-host/src/official-host/composition.mjs:39-70,72-115` 用官方 appBoot/Cordis Profile、插件 reconcile、版本检查、`fiberPhase==='active'`；**装了插件 ≠ 插件真正活着**。LOOM 的 Capability Materializer 应记录同类 `installed/ready/loaded/invoked` 证据，而不是复制 MOVO Host 代码。
- **个人/组织 Skill 目录与环境就绪门**：`services/chat-api/app/dsh_runtime/profile/skills/catalog.py:19-60` 先合并个人/组织 Skill、去重、排除 disabled、运行环境不 ready 就不暴露，再按资源访问策略筛组织项。这恰好回答用户“为什么扫描到但不显示”：UI 必须显示**来源、被过滤原因、环境未就绪和本次生效状态**，不能悄悄消失。
- **控制面与插件的凭据隔离**：`app/dsh_runtime/tool_gateway/token.py:1-80` 生成带 tenant/user/profile/tool/scopes 的短期 HMAC 令牌（默认 900 秒）；`dsh/runtime-host/src/plugin-credential-relay.mjs:1-43` 让插件子运行时只见受控 relay，不拿父 Host 的原始服务 URL/凭据。LOOM 的 DevicePort 与第三方插件也应采用**窄令牌、短租约、不可越权代理**。
- **审批与沙箱不是同一字段**：`dsh/runtime-host/src/code-permission-policy.mjs:1-21` 分 `read-only/workspace-write/danger-full-access`、`user/auto_review`、`ask/never` 三轴；危险全权与自动审批不能组合。LOOM 可以在 UI 上呈现 Full/Ask/Never 的简化预设，但内部仍需明确实际 OS 边界和独立审查。
- **企业版能力与开源 Community 不能混写**：`app/product/resource_access.py:9-36` 明言 Community **没有人员级组织资源 ACL**，默认返回全部组织资源 ID，私有发行版才可能收窄。MOVO 的组织 Skill、知识、审计、sandbox-manager 容器很值得参考，但**不能**声称社区源码已经有完整企业多租户授权；未来 LOOM 多用户必须自己独立验收隔离。
- **不要宣称 MOVO 已把 Claude/Pi Hooks 全部无缝统一**：MOVO 实际常用 Cordis 事件与 DSH 工具桥；DSH 上游有 experimental hook-protocol/Claude/Codex 兼容组件，但不等于 MOVO 当前产品已加载所有 Hook。Pi/DSH 四能力的真加载矩阵必须按 LOOM 实测写。

## 6. 多根权限与 Full / Ask / Never（设备和云端真正执行）

至少分开三轴：**资源范围**（deviceId/rootId/文件读写/终端/浏览器/屏幕/服务）、**沙箱实际强制**（OS/容器/VM 的 full/partial/unavailable）、**审批策略**（ask/never/经明确选择的可信宽权限）。UI 可以有三种易懂预设，但 Core/Node 不只保存一个字符串。

| 用户预设 | 用户实际感受 | 真正后果 |
|---|---|---|
| **Never：不申请扩权** | “只做已经允许的事情，不来问我要更多权限” | 已有范围内的操作可继续；缺 Grant 的动作**拒绝**，不是全部禁止也不是全部允许 |
| **Ask：需要时问我（建议默认）** | “额外目录、写入、Shell、浏览器账号、鼠标键盘等要问” | Core 绑定准确 action digest + run/step/device/root + TTL + 用户确认；设备重验；超时/离线拒绝 |
| **Full：我信任这次执行** | “在我明确选择的设备/作用域/时限里减少询问” | 只扩大已明确授权的范围，不能凭“Full”超越 OS 账号权限或自动取得 macOS TCC/Windows 安全桌面；**云端默认不开** |

**工作目录 ≠ 安全授权**：`WorkspaceManager.tsx` 当前已能登记/设默认根，它只决定新工作的起点。新增 `DeviceRootGrant` 与 `RunGrant` 时，B 端按 canonical path + 文件身份、Windows reparse/junction/UNC/ADS、macOS symlink、Linux mount 检查真实操作目标。Shell 的子进程、MCP、Hook、浏览器下载、Git helper 可能绕过单纯的 path 字符串检查；真正要强拒绝必须有 OS 权限/容器/沙箱执行证据，不能宣传“提示词已限制”。

**授权建议**：一次审批卡展示“哪个 Bot / 哪个 Run / 哪台电脑 / 哪个目录 / 做什么 / 持续多久 / 是否可撤销”；敏感写入、外发网络、桌面输入可分开；本机有可见状态与一键撤销。Node 不需要理解“任务好坏”，但必须强制拒绝越权。

## 7. Mikka 式 UX（保留现有 LOOM，不另起前端）

- **左侧**：Bot 列表与群聊，当前助手旁蓝点/小编辑入口可直接编辑当前助手；状态只来自 Core，离线设备与 Bot 离线分开；不把每个 Run 冒充新 Bot。
- **中间**：自然聊天、任务摘要、Ask 卡、“等你处理”、派工/审查/返工/交接；Bot 可以有“我会在 B 读文件、在 C 打开浏览器”的可解释计划，用户能看每一步证据。
- **右侧**：当前对话 Bot 的大头像 Hero 占可见高约 28–33%（短窗自动压缩），其下“工作空间”标题与 `工作/资产/流程/电脑`，仅下面内容独立滚动。已有 `Inspector.tsx` Hero 源码、30/30 专项 Vitest 和 Web build exit0 是**局部基础**，不是完整视觉验收。
- **Logo**：图三抠图真透明（抗锯齿/发丝/猫耳边缘）；静态 favicon 16/32/48px，小图优先脸和眼；左上大 Logo 可分层眼球追随鼠标，遵守 reduced-motion/触屏静态。**品牌 Logo 与助手头像是两条资产链**，不覆盖 Hanzi/Linxi 的用户头像。
- **工作目录/设备**：默认根与额外根可见、可切换、可授权；UI 说“在 B 的项目 X 工作”，而不是云 A 上的 `C:\...`。跨根请求准确显示，不把已收藏目录当已授权。
- **手感**：三栏拖拽宽度持久化，双击复位，拖拽只改变 CSS 变量/轻量布局，虚拟化长列表、避免鼠标移动触发 Core 网络请求；可视区域/短高屏、RDP/UU、缩放/DPR、键盘焦点/reduced-motion 均验收。以真实 Chrome 截图与帧时指标，不凭“看起来流畅”报性能 PASS。
- **状态层**：真实任务进度、AgentRun、设备在线、屏幕是否可用、等待审批、候选待接受、已发布必须区分；不制造假的成功/屏幕/资产。

## 8. 后续 Pi 工兵可以照着执行的阶段计划（**待用户认可方案后才允许写产品代码**）

### P0：冻结、备份、恢复（主管 + 只读 Scout）

**目标**：保留当前喜欢的 UI 和已有数据，明确旧 WIP 是什么。**可写范围仅** `docs/loom/` 新方案/证据与 `_artifacts/`；不动 `crates/` / `apps/`。
- 工兵 A（只读）列当前 WIP、现有测试状态/10053、旧产品预览/数据根；B（只读）核查五仓许可/版本与 API；C（只读）核对当前四能力/Memory 的真实源；D（只读）输出 UI 差异与品牌素材来源。
- 主管保存 `git diff` 备份、untracked 文件清单、已运行进程身份和独立 data root；未经确认**不 reset/clean**，不碰生产 DSH/Octopus/用户凭据。用户对架构选项做最终选择前，**不提交/推送实现 WIP**。
- **Gate P0**：当前与目标差距表 + 备份可读 + 无生产副作用。

### P1：产品模型与合同先行（主管负责架构，Pi 只读设计审查）

**目标**：画清 Bot/Chat/Goal/Step/Run/Device/Root/Capability/Memory/Grant 的归属与迁移。**仅设计，不实现**。
- 交付：领域词典、C4 组件/时序图、DevicePort/RuntimePort 候选 IDL、G vs M 两条跨设备任务路线、权限矩阵、数据迁移与兼容/回滚计划、Mikka UI 用户旅程。
- 重点先评审 **是否真的需要改 `mission_workspace` 1:1**，还是用中心 Goal→多个 child Runs + DevicePort 就足够；不要因为一条旧测试失败把整个 Core 砸掉。
- **Gate P1**：源文件级证据、合同冲突清单、用户确认“模式 T/R/H 与 Pi/DSH 选型策略”。**通过后**才可进入写代码阶段。

### P2：Pi vs DSH 的最小对照 Spike（Pi 工兵两路，主管做安全/选型）

**建议白名单**：新 `runtime-port` 适配器文件和**隔离测试夹具**；不改全局 `~/.dsh`、`~/.pi`、`~/.claude`；只用 DeepSeek V4.1 Flash / max。两路工兵分别维护 Pi 和 DSH **互不重叠文件**；第三路只读 reviewer。
- Pi 适配：RPC `start/stream/tool/settled/cancel/recover`，Skill/MCP/Rule/Hook 各一真例，受管包版本/许可/卸载。
- DSH 适配：锁版本 SDK/ACP/Cordis Profile，插件 inventory/loaded receipt，工具 pre-execute 审批，Skill/MCP/Rule/Hook 各一真例，独立数据根。
- 主管做同模型同任务成本/时延/内存/安全/恢复表。**默认仍 Pi**；DSH 必须证明收益与迁移安全才能升级默认。
- **Gate P2**：真模型回执 + 四能力成功/拒绝 + 崩溃恢复/卸载回滚，不用模拟日志替代。

### P3：A 通过 DevicePort 调用一个 B（最小 Tool Node），再扩成 B/C

**建议白名单**：`loom-protocol` 新有界工具 envelope、`loom-node` device provider、`rovai-web`/`rovai-core` 受控路由、独立 fixture。**先复用 R2 list/read/git.status**，不要开任意 shell。
- 工兵 A：Node 能在没有任何 Agent CLI 时以 Tool Node 连接/认证/广告能力、拒绝误投 R1；先定位并修复现有 `54 pass / 1 fail / 2 ignored` 中 Windows 10053 失败。
- 工兵 B：Core ToolRouter/Grant/receipt，严格 requestId/epoch/generation/unknown；与 Node 文件 owner 分开，写入白名单不重叠。
- 工兵 C：独立 fixture：真实 A Pi（同 DeepSeek 模型）→ B Tool Node 的只读操作；然后 B/C 两节点，各自隔离 data root、不同设备身份；一个**真实父 Goal** 下两个 Step/Run 的因果/证据；可另测同一 AgentRun 多次 DevicePort 请求，**不要要求所有操作必须共用同一 Run**。
- 工兵 D：只读安全 reviewer，查目录逃逸、重放、断线、误投、权限升级。
- **Gate P3**：B/C 都无本地模型仍能由 A 调文件/固定工具；负例、断连恢复、用户撤销真实通过；“两独立 camp”只能算基础 plumbing，不算中心协调闭环。

### P4：Device 工具家族与 OS companion（并行按模块隔离）

- `FilePort`：read/list/write/move、root 选择、内容摘要/原子写、跨根 Ask，Windows reparse/UNC/ADS 与 POSIX symlink 测试。
- `TerminalPort`：固定命令→受管 Shell/PTY，进程树取消、输出限额、环境与网络授权、unknown 不重复副作用；区分“命令工具”与“任意终端”权限。
- `BrowserPort`：每设备受管浏览器 Profile、CDP/Playwright 类工具、登录交接/下载隔离；不能偷用用户默认浏览器 Cookies。
- `ComputerPort`：复用现有 LOOM Computer v1 的 view/human-control/agent-control 独立租约；Windows 交互会话 companion、RDP/UU 虚拟屏变更栅栏，macOS TCC、Linux Wayland provider 真实能力广告。无屏幕时 File/Terminal 不受影响。
- `LocalServicePort`：仅用户明确批准的 B 本机服务与端口，防内网代理/SSRF。
- **Gate P4**：每家族有真实正/反路径、撤销、回放、审计、真实 OS 强制；未实现的工具 UI 显示 unavailable。

### P5：能力目录、原生发现、插件与记忆（可并行，主管整合）

- 工兵 A：四端 `SourceScanner`，只读 Claude/Pi/DSH/Codex 配置，去秘密、来源冲突、版本摘要、真实 scan/error 状态。
- 工兵 B：`CapabilityManifest`、Run 冻结、Runtime-specific materialization/loaded/invoked receipt、Skill/MCP/Rule/Hook 映射表。
- 工兵 C：`MemoryProvider` + Core BotMemory/ProjectKnowledge/ChatEvent/RunEvidence 的范围与可删/可审计，不把用户记忆写进每个原生 CLI 全局目录。
- 工兵 D：插件安全/许可/版本/回滚 reviewer，检查不受信 Hook/MCP 的实际副作用和凭据流。
- **Gate P5**：四类每种跨 Pi/DSH 的支持/不支持均可解释；选中与真正执行可分辨；真实授权/撤销；没有静默复制凭据。

### P6：Mikka 式 UX 与品牌（**主管亲自做 UI**；Pi 只读研究和回归）

- 当前 `loom-native` 树上增量打磨右栏 Hero、蓝点编辑、默认/多根项目、三栏拖动、长列表虚拟化、工作/审批/结果卡；**保留现有整体布局与主题**。
- 图片三先在用户提供的合法源图到位后做透明 RGBA/小 favicon/分层眼睛；所有分辨率、深浅底、无动画降级和截图比对。
- **Gate P6**：真实 Chrome 1605/1440/1040/760/390 与短窗、DPR2、RDP/UU，三栏真实鼠标拖动并重开持久、滚动/交互性能量化；Bot 身份、工作上下文不丢；品牌图不覆盖助手头像。

### P7：单用户云端 Linux A + Win/macOS 多设备（先私有隔离，后生产）

- 主管先建**隔离的 Linux A** 与独立的 Win11 B / macOS C 测试用户或 VM，出站设备配对、设备本地确认、WSS/TLS、断连、升级/卸载、日志脱敏、数据备份/恢复；不能借现有真实生产 DSH/Octopus 进程冒充。
- 设备模式 T/R/H 分别验证；A 重启、B 换网络、C 离线、用户换电脑登录、旧 Grant 撤销、未知写入不自动重做；Mac TCC 和 Windows 虚拟屏真实验收。云端 A 不要求 Linux 图形桌面。
- **Gate P7**：一个真实 Bot/Goal 在 A 保存，能在 B/C 调工具/派 Run、断连后恢复和人工验收；登录新客户端不丢记忆/任务；没有实体机器和授权就标 NOT_RUN，不假报“云端已发布”。

### P8：企业/多用户（仅在 P7 单用户稳定后）

- 在现有 owner/scope 上显式迁移 `tenantId/workspaceId/memberId/role`，设备归属与跨成员分享、资源 ACL、组织 Skill/知识、审批责任链、审计导出、配额、密钥轮换和租户隔离；不提前让单用户产品背上复杂组织 UI。
- **Gate P8**：跨租户访问负例、共享资源撤销、组织角色变更、账单/审计可追溯；MOVO 受限代码不得被未经授权带入多租户 LOOM。

### 工兵统一任务模板（未来可直接套用）

```text
MODE: 先 scout 只读计划；主管审过后才 worker 写入
GOAL: <一个客观可验的子功能>
ROOT: C:/Users/echo/Downloads/claude/skill-cli/loom
READ: AGENTS.md / docs/README.md / 当前版本与合同 / 本方案 / 相关源码
WRITE_ALLOWLIST: <互不重叠的精确文件，默认空>
NO: 生产服务、真实凭据、用户数据、全局 CLI 配置、git reset/clean、部署、无审查 shell、二次派工
MODEL: oct-chat/deepseek-v4.1-flash，reasoning=max（研究/测试按用户允许）
DELIVER: RESULT + path:line EVIDENCE + CHECKS(PASS/FAIL/NOT_RUN) + BLOCKERS + STATUS
SUPERVISOR: 独立复跑最小真测、审安全/UX、批准或退回；Pi 的 ok=true 不算验收
```

## 9. 验收矩阵（先定义什么才叫“做完”）

| 层 | 必须实际证明 | 典型负例/失败保留 |
|---|---|---|
| **架构/迁移** | 旧 Bot/Chat/Run/Artifact/Memory 可读，合同版本/向前迁移/回滚计划可验证 | 老数据孤儿、重复 owner、重复运行、迁移中断 |
| **Runtime Pi/DSH** | 同 DeepSeek V4.1 Flash/max 真模型，工具、四能力、流、取消/恢复与版本锁 | 插件未加载、Hook 未触发、模型静默 fallback、unknown 被报成功 |
| **单用户跨设备** | A 一个 Bot Goal 的父子任务/Run 调 B/C，B/C 可无模型，结果/证据 A 归档，换电脑仍能查看 | 假 Node、错误设备、旧 socket、重放、断连、撤销、离线 |
| **多根/权限** | 默认根不自动扩权，Ask/Full/Never 分轴生效，Node 真拒绝越界 | ../、绝对路径、junction/symlink/UNC/ADS、MCP/Hook/Shell 绕过 |
| **文件/终端** | 实际文件字节 hash、PTY 进程树/取消/限额、非幂等写 unknown | 重试双写、输出截断不告知、子进程遗留 |
| **浏览器/电脑** | 真截图、真输入、授权租约、归还后拒绝；RDP/UU 显示切换代次 | 无屏/锁屏假图、过期控制、另一用户 session 注入 |
| **UI** | 实际鼠标拖栏、右栏 Hero 1/3、四 Tab 下移、图三品牌图、眼随鼠标、长列表性能 | 短窗遮挡、卡顿、焦点丢失、reduced-motion 仍动画 |
| **云端运维** | Linux A 重启、Win/macOS Node 升级/卸载、配对吊销、备份恢复 | 公网暴露 Node、日志泄密、未确认写入被重放 |
| **多用户未来** | tenant/ACL/RBAC 与审计、跨租户负例 | 私有数据被其他用户看到、共享凭据泄露 |

**完成判定分层**：源码存在 ≠ 构建 ≠ 单测 ≠ 隔离 Host ≠ 真实双 Node ≠ 真实 Win/macOS 设备 ≠ 云端生产。每阶段用 `PASS/FAIL/NOT_RUN/BLOCKED` 与日志路径单独登记，不能混写成一个“全部完成”。

## 10. 当前 WIP 与交接安全边界

- 现有 `Inspector.tsx` / `product.css` 两份 Hero WIP 和 `loom-node` 三份 `--device-only` WIP **保留但冻结**；旧 Node 单测日志 `_artifacts/loom-single-brain-20261115/h1-node-unit-test-resume.log` 为 **54 pass / 1 fail / 2 ignored**（Windows socket 10053）；旧双节点 Python fixture AST parse PASS，但 **T0–T7 NOT_RUN**。这些是历史实验，不代表本方案已批准。
- `docs/loom/discussion-handoff-deviceport-mikka-ux-2026-11-15.md` 已准确记录用户图一/图二/图三与 DevicePort 疑问；本稿把四个 GitHub 参考、最新 Mikka/MindFS/DSH 和可选部署模式统一成**新的讨论入口**。历史文档不删不伪造。
- 参考镜像、FusionSearch 原始证据、Pi 只读 Scout 结果与本轮 Git baseline 放在 `_artifacts/loom-architecture-20261115/`；**不提交/推送参考仓代码**。新方案文档可由用户审阅；产品架构/合同的正式变更仍需遵守 `docs/README.md`、`docs/decisions/README.md`、当前版本治理。
- **尚待最终设计确认的真实问题**：BotIdentity 与现有 AgentProfile 的兼容迁移；Goal/Step 是否新增表或复用 Task DAG；DevicePort 与 R2/ComputerPort 的版本关系；Pi/DSH 包装与许可证；Windows RDP/UU 图形提供者；第三方插件沙箱；未来多用户密钥与组织范围。它们不能通过给字段取新名字解决。

**阶段性结论（建议，不是拍板）**：**保留现在的 LOOM UI 和 Pi；以 Mikka 的 Bot 体验为产品中心，保留 LOOM Rust Core 事实与安全权威；新增 RuntimePort 与 DevicePort 两条独立通道；B/C 允许“仅工具节点”或“带本地 Runner”，由任务和用户选择；DSH 做可插拔候选并公平实测，不先替换 Pi；先单用户跨设备，后云端多机，再多用户企业。**
