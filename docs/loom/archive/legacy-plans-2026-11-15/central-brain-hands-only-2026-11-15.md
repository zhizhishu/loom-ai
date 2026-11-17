# LOOM：A 单一 Brain，B/C 纯设备手脚——研究与实施交接（2026-11-15）

> **历史候选方案，非当前冻结架构。** 用户随后明确纠正：这是 AI 给出的参考拓扑，仍在讨论；不能以“违反/不违反”排斥 B/C 本地 Runner，也不能在最终方案获认可前继续写产品代码。当前讨论入口为 [架构选项与工兵计划](../../research/architecture-discussion-master-plan-2026-11-15.md) 和 [用户易读版](architecture-discussion-plain-language-2026-11-15.md)。下文原始技术研究/阶段证据保留作历史，不应当成用户最终签署的合同。

> 状态：**用户本轮明确要求先深研，再用 pi-skill 工兵实施，阶段性交接只汇报真实结果。** 本文不是已发布合同/云生产验收。所有代码与验收依旧受仓库 `AGENTS.md`、`DESIGN.md`、Core/Node/Computer/Workspace RPC 当前合同约束。**请勿将下文拟实施项目提前写成完成。**

## 一、用户严格定义

- **A 云端**：单个 Agent Harness（选型独立于设备控制），负责唯一模型推理、规划、记忆、任务拆解/依赖、能力分配、派工、审查、结果汇总。现有 Rust Core 仍唯一记录真实任务/Run/证据/授权/审批；Core 本身不是第二个推理 Harness。
- **B/C 设备**：每台只有**常驻出站 daemon**，主动通过已配对/认证的 WSS 连接 A；设备提供文件、进程/受控 Shell、浏览器/桌面等实际能力，接收**有上下文/范围/期限的确定性 Tool 命令**，本地强制执行权限与取消、回传结果/证据/状态。B/C **不安装/不启动 DSH、Pi、Claude、Codex，不调用模型、不规划、不选任务、不自主重试有副作用的操作、不做业务验收**。
- **权限与安全执行 ≠ 模型决策**。B/C 本地拒绝未经授权操作、截断输出或停止进程，是必须的确定性强制策略，而不是擅自决定下一步任务。
- B/C 的“无人值守”是受管节点保持连接的能力，不意味着默认全盘权限；用户授予本轮研究和项目内开发权限，不等于批准将常驻服务装入真实 B/C 或开放公网。

## 二、新增两个参考项目的真实边界

### DeskFleet：协议、终端、媒体值得借；并非天然 A 单脑

- 本次浅克隆固定 `yet-another-ai/deskfleet` HEAD `098485a4c4024ff33fb37e8635e2b1b1bba857da`；仓库根 `LICENSE` 为 Apache-2.0。来源：`_artifacts/reference-repos/deskfleet/`（忽略目录，不复制该仓源码进入产品）。
- `agents/docs/architecture.md`、`README.md` 明确：中央 Rust Actix Web + PostgreSQL 维护用户、设备/共享目录、注册、信令、历史；B/C TS daemon 保存执行事实/本机 SQLite，Node SEA/ Electron 运行；原生 Rust napi-rs 提供 PTY、图形、输入、WebRTC；客户端和设备**直接** WebRTC 数据/媒体通道，TURN 只是可选中继。
- **不完全符合严格定义**：其常见 Agent Session 是设备 daemon 在本机启动和管理 ACP Agent 进程，中央 Rust Server 本身**不**充当唯一 LLM Brain；WebRTC data peer 也不是自动等价于“Cloud Harness 已获 B/C 工具授权”。
- 可借鉴：出站设备登记/状态、身份绑定、信令和断线代次、按用途授权的短期 peer grant、无显示屏 PTY/文件能力仍可用、桌面媒体单独能力检测、借用户已有账户身份许可而非传递任意 Node token。需要时为桌面图像引入 P2P/TURN，但**首期直接复用 LOOM 现有 WSS Node 连接，不移植 WebRTC 整套技术栈**。
- 需要额外小心：`agents/docs/webrtc-security.md` 表明服务端可信并负责 DTLS 指纹绑定、TURN/Peer 授权与有限控制面；“TLS/P2P”本身并不赋予业务操作授权，也不能将 Team 多用户模型无差别搬进单用户 LOOM。

### DeskFleet 源码补验（区分中心管理与设备 Harness）

Root 已独立重读 `apps/server/src/search.rs:1`（源文件开头明确「中心负责 read models，execution 在 daemon」）、`agents/docs/agent-sessions.md:1-24`（daemon 持久管理 Agent Session、provider process 和对话 journal）、`apps/daemon/src/agents/acp.ts:120-146`（在设备上 `spawn(launch.command,...)` 启动 ACP 进程），故 **DeskFleet 自身不满足“A 唯一 Harness、B/C 不装 Agent”**。但 `apps/daemon/src/terminals.ts` 与 `crates/native/src/terminal.rs` 等终端/文件/桌面子系统可以独立借鉴设计。

服务端 `apps/server/src/peers.rs:90-122` 根据 `agent/terminal/desktop/files/ports/mux` 用途签发 `PeerAuthorization`，包含 `actor`、`target_machine`、`actions`、`issued_at` 和最长24小时的 `expires_at`。LOOM 应保留自己更严格的 Core/Node Scope、短期租约、撤销，而不是照抄24小时授权。WebRTC 数据/媒体通道负责真实字节；`apps/server/src/api.rs:282-345` 的 HTTP `MANAGEMENT` **并不只包括终端**，还有 provider/session/catalog/schedule/MCP 等管理方法，它是允许方法白名单，而不是任意代理或文件传输。Scout 原话“HTTP 只做 terminalList/Dial/Hangup”漏掉其他枚举，本交接以这份直接源码复核为准。

### UFO³ Galaxy：中央 DAG、设备画像值得借；默认设备 Agent 仍可能自主推理

- 本次浅克隆固定 `microsoft/UFO` HEAD `eae3c0a8d168c47cb10df0652e293e092eda1078`；根 `LICENSE` 是 MIT。源码 `_artifacts/reference-repos/ufo-galaxy/`。
- 官方 `documents/docs/galaxy/overview.md` 与 `galaxy/client/constellation_client.py`、`galaxy/client/device_manager.py` 定义：ConstellationAgent 负责在 A 拆分 DAG；ConstellationClient/DeviceManager 持有设备 registry（能力、连接、状态/负载），通过 WebSocket AIP 与 Agent Server 转发 TASK、COMMAND_RESULTS、TASK_END、心跳；中心 Orchestrator 调度依赖与并发。
- **不完全符合严格定义**：Galaxy 的 Windows UFO² `HostAgent/AppAgent` 和 Linux Agent 可在 B/C 各自做应用级/模型驱动执行，远多于“不含模型的确定性 daemon”。要借它的**DeviceRegistry / DAG / 事件/设备能力**概念，而不照搬本地多层 Agent。
- 协议对接应保持现有 LOOM Core 的 Task/Mission/Run 与证据模型为唯一事实，不导入另一套星座编辑器数据库，也不直接复制 AIP 或 Python UI。

### UFO³ 源码补验与稀疏检出纠正（总管独立复核）

> 只读 Pi 工兵首次在稀疏检出的参考副本上把 `ufo/` 与 `aip/` 错判成“原仓缺失”，并进一步把整个项目误判“无认证”。**该判断不成立，不得移入实施验收。** 总管用本地 `git ls-tree -r HEAD --name-only` 核对原仓确有 `ufo/` 173 个文件、`aip/` 25 个文件，再扩展本地忽略参考克隆的 sparse-checkout，实际读到 `ufo/server/app.py`、`ufo/agents/agent/host_agent.py`、`ufo/agents/agent/app_agent.py`、`ufo/client/client.py`、`aip/messages.py`、`aip/protocol/registration.py`、`ufo/server/ws/handler.py`。并未执行其服务或依赖。

- `ufo/server/app.py:20-52,79-111` 有 `--api-key`、随机 key、WebSocket `/ws?token=` 的 `secrets.compare_digest` 验证，`ufo/server/ws/handler.py:22-51,112-169` 将身份/target 与连接绑定，处理重复 ID 防覆盖。因此**不能把 UFO 全系统写成“无认证”**；但 URL 查询参数中的令牌、默认 `ws://`、设备注册与租户/权限隔离的范围仍需实际安全审查。
- `aip/protocol/registration.py:158-173` 的 **注册确认本来就是** `ServerMessageType.HEARTBEAT + TaskStatus.OK`；`galaxy/client/components/connection_manager.py:193-265` 等待 Heartbeat 才视为成功，属协议约定，**不能凭文档“REGISTER_CONFIRMATION”字符串推定实现必然死锁**。
- `aip/messages.py` 明确定义 `ClientMessageType`、`COMMAND_RESULTS` 与 `TaskStatus(str, Enum)`，因此先前“`aip` 缺失/类型一定不兼容”的推断不成立。需区分**消息类型有定义**和**Galaxy DeviceManager 的进度分支实际消费**，后者仍要逐段核验。
- `ufo/agents/agent/host_agent.py` 导入 `ufo.llm` 并构造 HostAgent/AppAgent；`ufo/agents/agent/app_agent.py` 也导入 OpenAI 和 Agent Prompter，直接证明**默认 B 设备不只是确定性工具 daemon**，它会运行本地 Agent 逻辑。严格 LOOM B/C 纯手脚模式不能照搬。
- **连接方向是实质架构差别**：`galaxy/client/components/connection_manager.py:70-111` 为 A 侧 `transport.connect(device_info.server_url)`，也就是 **A 向每个设备 UFO Server 主动拨号**；`ufo/client/websocket.py:62-121` 则是另一个本地 Client 连 UFO Server（默认与设备同机）。**它不是用户要求的 B/C 无入站端口、主动连回统一云 A 的部署拓扑。** LOOM 继续沿用现有 Node 主动连接 A 的 WSS，不直接搬 UFO 的 server_URL 网络信任边界。

### 与已有参考的融合判断

- **Mikka**：Bot/Task/Thread/Run 的责任划分、右侧助手身份/工作台；本机 daemon 实现有限电脑 MCP broker，**但缺省/旧 ask→allow 不照搬**。现有角色/任务账本归 LOOM Core。
- **MindFS**：轻量独立工作站、文件/Shell、出站 Relay/本地服务，无 Agent 也可用工具；不等于已有通用桌面自动化。
- **AgentDock**：当前通过用户授权可直接读取/编辑本机 Windows 文件、命令等，证明设备工具层与模型 Harness 解耦；**不能**把现有 ChatGPT 连接凭证偷渡给 LOOM。
- **DSH/Pi**：仅存在于 A 的 Harness/Worker 执行位置。严格拓扑**无需**先让 B/C 安装 DSH ；选 A 只跑哪个 Harness 是独立兼容和功能决策。研发 Pi Skill 工兵只用于当前开发，不代表发布后 B/C 装 Pi。
- **MOVO/AgenTeam**：研究权限/插件/企业模型，当前不移植其运行环境、闭源 Desktop 或受限社区代码。

## 三、选定的实施锚点（小阶段，不破坏现有功能）

```text
       手机/网页/PC：LOOM native UI
                    │
        A：Rust Core + 唯一 Brain Harness
    持久 Task/Run/DAG/Memory/Grant/证据
                    │
         受认证配对、出站 WSS
          ┌─────────┴──────────┐
          │                    │
   B：LOOM Device Node  C：LOOM Device Node
   无模型/CLI/Harness    无模型/CLI/Harness
   文件/工具/桌面         文件/工具/桌面
   只执行确定性指令      只执行确定性指令
          └─────────┬──────────┘
            回执/证据/状态/取消
                    ▼
               Core 统一归档
```

**不得重做已实现基础：** `crates/loom-node/src/lib.rs` / `session.rs` 已有配对、单向主动连接、代次/reconnect/heartbeat、可信 Hello、R1 Runtime 与 R2 Workspace RPC、远端 Computer v1；`crates/rovai-web/src/computer/node_provider.rs` 复用 Host 电脑租约。R2 目前只支持授权范围 List/Read/固定 git.status；本轮若新增“设备纯工具”必须闭集接口、显式设备权限，不能偷偷把工作区 Run 开成任意命令。Core/Agent 身份、工作根准备/授权必须由既有合同驱动。

### 增量阶段建议及客观完成条件

| 阶段 | 交付可验目标 | 未证明不宣称 |
| --- | --- | --- |
| H0 研究/接口 | 两仓精确源码与差异、A 单 Brain/B-C Hands 合同、授权负例、生命周期、独立交接 | docs 不代表实现 |
| H1 Node hands-only | B/C `loom-node` 可在**不运行/探测任何 Agent CLI**状态连接 A；Hello 不广告 Runtime/ProcessPipe；即使恶意误派 R1 Start/Open 也不能 spawn；Workspace/Computer 保持有限工具可用 | Rust 单元测试不等于真实 B/C |
| H2 A 调用 B/C | A 唯一 Pi/DSH Harness 真实通过 Core 受控 RPC 调用 B/C 两个逻辑 Node 的固定 File/Read/Tool，并收实际结果；分别测试乱序、重复、断连、撤销、错误恢复 | 两个本机独立 Node 不是两台物理机器 |
| H3 Tool Families | File/Process/固定 Shell/Browser/Computer 分类能力和单次 Grant；敏感动作取回人工批准；无屏幕情况下 File/Shell 仍工作 | 不声称任意 Shell、任意浏览器或虚拟屏都已实现 |
| H4 产品 UI | 右侧上 1/3 真实当前对话动态头像，下面「工作/资产/流程/电脑」；短高屏响应，动效尊重 reduced-motion，旧 Task 上下文不丢 | 图片三静态位图需要原始像素分层和透明抠图才可替换品牌 |
| H5 发布 | 受管启动/卸载脚本和回滚，真实设备 B/C 配对并从 A 单 Harness 操作真实文件/浏览器/屏幕（需用户指定实际设备和真实远端授权），核准后再正式发布 | 本机开发 preview/本机 twin-process ≠ 云端公网交付 |

## 四、权限、结果及失败必须保持的边界

- `actor + runId/attempt + deviceId + toolId + scope + digest + deadline + nonce + source-generation` 在 Core 准入；Node 重验已配对 owner、请求身份/期限/范围、版本和操作白名单。Node 仅保存本地幂等、执行状态、凭据和设备事实；无模型配置、无自主 Task 规划。
- **Never**＝不弹审批，缺权限拒绝；**Ask**＝超出当前授权准确请求用户；**Full**＝特定受信设备、已授权的 scope 内自动动作。审批与 OS 沙箱强制隔离是两轴；Windows DSH ACL 的 partial 不保证读隔离。
- 设备离线是 `offline`，但它已经完成的、可能有副作用的操作必须保留 `unknown` 直到同一 Request 回放或明确证明；重连不可换 requestId 盲目重做。客户端取消/撤销不能只隐藏 UI。
- 图形控制必须独立于文件/终端的能力广告：RDP/UU 无真实交互 desktop 时显示 `unavailable`，不是整机离线；不做无名指针注入。
- 生产上 A 的安全边界是用户授权、密钥存储、网络 TLS、节点 credential、授权审核和日志隐私；此轮没有用户授权的真实 B/C 生产部署，**不得启动真实跨公网服务或修改日常系统级自启动**。

## 五、阶段性交接规则

每个 H 阶段以 `_artifacts/loom-single-brain-20261115/` 为证据根留源码 SHA、受管 Pi Session id、准确可再运行命令、构建测试输出、人工验收决定、真实 blocker。变更只在 LOOM 根，参考仓库严格只读；不清洗旧 WIP，保留 `TASK.md` 最新入口。Pi 工兵只做文件边界确定、可测试的子任务；主控负责安全/架构/UI 最终选择、独立复核与接受/退回。不要把工兵 `ok=true` 写成发布成功。

**用户要看最终结果**：此文仅作中间接力与恢复凭证；最终用户汇报精确已做到的层级和不能完成的物理设备/Logo/云端条件。
