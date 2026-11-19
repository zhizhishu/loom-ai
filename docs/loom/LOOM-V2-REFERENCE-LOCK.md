# LOOM V2：参考项目固定版本、借鉴边界与索引

> **REFERENCE_INDEX / 固定源码身份与借鉴边界。** 镜像原位只读，不自动更新。此页不维护实施状态；用户后来批准的受管 Pi Purge 适配/隔离封包与真实验证看 [当前实施](../../LOOM-IMPLEMENTATION.md)，不能用旧研究时点的“未运行”覆盖实测。
> 所有 40 位 SHA 是通过本机 git rev-parse HEAD 验证的**本地快照**，不是宣称远端 main 最新。未来每次工兵参考必须用下面 pinned commit；URL 只用于溯源，不替代本地源码证据。
> 总入口 [LOOM V2 MASTER](LOOM-V2-MASTER-PLAN.md)，原始 27 页 PDF《LOOM 深度架构研究与正式开工计划》是用户认可的架构主蓝图；其原文件在当前 ChatGPT 对话附件中，**本地未发现同名 PDF 路径，不能假称已复制到 Windows**。本地 [原 2026-11-15 深度讨论](research/architecture-discussion-master-plan-2026-11-15.md) 作为带源码依据的研究补充而非施工主计划。

## 一、参考镜像锁定清单与本地目录

| 参考 | 本机相对路径（相对 LOOM root） | HEAD SHA-1（40 位） | 借鉴重点 |
|---|---|---|---|
| **Mikka** | _artifacts/reference-repos/mikka-current | d59c85cb321b2b466616960db49dea8f038c2384 | 长期 Bot/Coordinator/群聊分配/任务委托/Attention/人机接管 |
| **MindFS** | _artifacts/reference-repos/mindfs-current | 6768bc1e5180bea0c16b435bdc6e87c40c51602b | File/Terminal/Relay 设备工具与 Agent Runtime 区分 |
| **DSH** | _artifacts/reference-repos/deepseek-harness | 39163dd30f703a79079e2d2446545cff3c453738 | Cordis 组件、Profiles/Bundles/SDK/ACP、Tool Hooks/沙箱/审批 |
| **AgenTeam** | _artifacts/reference-repos/agenteam | d12b50760b091d8783eca7bf8c11f113d063e4cb | 企业 AI 员工/团队/岗位/资源/能力管理 |
| **MOVO** | _artifacts/reference-repos/movo | e16174acc4edeb30534d87d9f7f5ff8806854955 | 企业控制面、管理员/配额/审计、DSH Host 受管组合与生效证据 |
| **DeskFleet** | _artifacts/reference-repos/deskfleet | 098485a4c4024ff33fb37e8635e2b1b1bba857da | daemon/ACP Agent 分层、native WebRTC/PTy/File/Desktop、人类接管 |
| **UFO³ Galaxy** | _artifacts/reference-repos/ufo-galaxy | eae3c0a8d168c47cb10df0652e293e092eda1078 | Constellation/DAG 任务计划、设备 Registry/Manager、调度解耦 |
| **Pi** | ../_references/pi-agent | ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba | 薄 JSONL RPC、Agent Skills、原生 MCP、Extension/Hooks，优先受管封包 |
| **PiBot** | ../_references/pibot | 8b9f3d7ab62e407ce635bb1150bc96c58dc36dc4 | 长期 Bot、每 Bot 能力配置/技能来源、中心服务、多客户端连续性 |
| **ACCP** | ../_references/accp | 77f05778e194b3dca04cc14851c2b8e1aafdce65 | Task DAG、context snapshot、claim/lease/fencing、交接/审查/候选结果 |
| **ROVAI** | ../_references/rovai-ai | f5f4cb26feaba2d09ee5a6e0d73ac53371a2e246 | 当前项目 UI / Team/Thread/Mission/Artifact 的实用体验与数据迁移素材 |
| **agent-purge（跨端参考）** | _artifacts/reference-repos/agent-purge-current | **5881e309c5d2bca3eb0cc4125d75f8b573ae5aa0** | Persona Markdown、按四 Runtime 适配、Off/Append/Replace/Strict 观察、可逆备份；**DSH Approval/Sandbox Hook 逻辑不得直接进入生产** |
| **Pi Purge（本轮选定 Pi 扩展）** | _artifacts/reference-repos/pi-purge-current | **d0196ccfd773b0ed342bd2f25372aff65f1a4a53** | 版本 **0.3.0**、MIT、Pi before_agent_start、Off/Append/Replace/Fallback/Strict；只作为可选受管 Pi Extension，不是第五 Runtime/能力；当前实现/验证只看根实施表 |

**AgentDock** 是已经接入的 Windows 机器控制工具，属于设备/电脑能力和研究辅助，并没有将它误写为一个上述固定 Git 镜像。**Claude Code、Codex CLI** 是产品承诺的另两种 Runtime Adapter；本页不为它们捏造未核实的本地上游 SHA，Adapter 必须在目标平台真实探测。

### 2026-11-18 · 直接复用优先（个人版施工口径）

**用户纠偏：参考项目默认直接采用，不是只取思路。** 默认优先直接采用固定版本的上游源码、原生包、SDK、服务端、扩展和协议；只有现成模块在具体 API、Core 事实归属、授权或平台上确实不适用，才实现**最薄的 LOOM 适配层**。禁止为了“架构纯净”重写已经成熟的 Agent Loop、RPC、ACP、Hooks、设备传输或任务算法。已有 LOOM 代码若功能等价，先比较和移除重复实现，不另起第二套数据库或调度真源。

| 优先复用目标 | 上游可直接使用的具体入口 | LOOM 只负责 |
|---|---|---|
| **本轮立即优先：Pi / DSH / Pi Purge** | Pi 原生受管包与 JSONL RPC、DSH 官方 Host / Cordis / ACP / Profile / Hook、Pi Purge 原生 `extensions/pi-purge.ts` | 固定包版本、隔离启动、Bot/Run 选择与权限冻结、原生加载/调用回执；不要自写 Agent Loop 或仿制 Purge |
| **直接试用：DeskFleet / MindFS** | DeskFleet daemon、ACP Agent 与文件/PTY/桌面通道；MindFS 文件/终端/Relay 组件 | 与已有 DevicePort 对接、独立设备配对、Grant/Lease、人类接管、撤销和 OS 边界；先跑受限集成验收，再决定是否需补充代码 |
| **复用现成机制：Mikka / PiBot / ACCP** | Mikka 的群聊路由、事件唤醒；PiBot 每 Bot 会话与能力管理；ACCP 的 DAG/claim/lease/fencing/review 实现 | 对照既有 Rust Core，优先移植兼容的算法或可独立组件；不得同时运行第二套业务调度/数据库，不能把 UI 私有 overlay 当已公开 |
| **按需直接集成：ROVAI / UFO³ / agent-purge** | 原有 Rovai 核心与页面、UFO³ 任务/设备模块、agent-purge 人格解析/恢复模块 | 保持已选 loom-native、Core 唯一授权和本机用户数据；不引入 agent-purge 中绕过审批/沙箱的 Hook |
| **企业版再用：AgenTeam / MOVO** | 组织/岗位/配额模块及 MOVO 的 DSH 组合服务 | 个人版不先造企业控制面；MOVO 代码许可已统一为 MIT，可直接复用 |

**已查本地根 LICENSE/NOTICE（固定快照）：** 全部参考快照许可已统一为 MIT，包括 Pi、DSH、UFO³、ROVAI、agent-purge、Pi Purge、ACCP、DeskFleet、AgenTeam、Mikka、PiBot、MindFS、MOVO。代码可直接复制、修改、集成与分发，保留原版权与 NOTICE 即可；不再有源码提供义务、用途限制或逐项法务评估。

**验收口径：** 写清原始上游路径/版本、LOOM 集成位置、可复用的实际函数或进程、授权边界及原生测试；不能只交“研究摘要”，不能把包存在当作功能已被模型调用。当前落地状态仍统一记在 [LOOM-IMPLEMENTATION.md](../../LOOM-IMPLEMENTATION.md)，本索引不制造完成率。

## 二、每个项目必须交付什么研究，不得越界借错层

### Mikka → Bot 体验、群聊路由与唤醒
源：lib/coordinator/group-routing.ts、group-turns.ts、group-factory.ts、wake-after-commit.ts、docs/design/glossary.md。
结论：群聊不是广播给每个 Bot；长期 Bot 身份与短期 Thread/Agent 执行分离；Coordinator 用事件恢复。**不照搬整个数据库或 Mikka 的私有 UI 覆盖层**。

### ROVAI + PiBot → 原有 UX 与可持续 Bot 身份
ROVAI 源：docs/architecture/team-management.md、docs/contracts/team-templates-v2.md、docs/architecture/missions.md、crates/rovai-core/src/collaboration.rs。
PiBot 源：docs/bot-sessions.md、center-server/README.md、docs/bot-management-learning.md。
结论：保留用户已经熟悉的 Team/群聊/主副 Agent 视觉；旧 Team 是模板不直接等于新持久 BotTeam；每 Bot 的能力/会话/来源/记忆须有明确 owner；不能让单 Session FIFO 限制多个工兵同时执行。

### ACCP → 多 Agent 施工控制面（不是 ACP）
源：docs/architecture.md、docs/collaboration-flow.md、internal/bridge/bridge.go、internal/controlplane/tasks_execution.go。
结论：Goal/Step/Assignment/Claim/Lease/ContextSnapshot/Artifact/独立 Review。**ACCP = Agent Collaboration Control Plane；ACP = Agent Client Protocol**，一个是控制面借鉴，一个是可能的线协议。不要把这两者合并成第五 Runtime。

### AgenTeam + MOVO → 企业产品能力与治理
AgenTeam 现有 Java Team/Agent/Approval 管理源码；MOVO 现有 services/admin-api/app/position_roles/service.py、core/quota_policy.py、services/chat-api/dsh/runtime-host/src/official-host/composition.mjs。
结论：AgenTeam 借用户可配置的“AI 员工/团队/资源”，MOVO 借组织/岗位/配额/企业级 DSH 插件合成、真实活性检查与 secret broker。**MOVO 社区公开代码不应被宣传为已包含全部私有企业 ACL。**

### DeskFleet + MindFS + UFO + AgentDock → 多设备执行/控制
DeskFleet 源：agents/docs/architecture.md、apps/daemon/src/agents/acp.ts；UFO 源：galaxy/agents/constellation_agent.py、galaxy/constellation/orchestrator/orchestrator.py、galaxy/client/device_manager.py。
结论：机器能力独立于 Agent CLI。设备加入、Heartbeat、File/PTY、Browser/Computer、人工接管、故障恢复与授权分别验证；不把“电脑在线”当“可操控屏幕”。AgentDock 为本机现成行为参照，不能把它的开放控制权直接当 LOOM 新设备的默认权限。

### Pi + DSH → Runtime，只有这两套优先考虑受管封包
Pi：packages/coding-agent/docs/rpc.md、mcp.md、extensions.md、skills.md；DSH：docs/architecture.md、tool-execution-pipeline.md、capability-seams.md。严格比较启动/进程/模型/插件/会话恢复；Pi **有原生 MCP** 和 Extension/Hooks，不得用过期假设作选型。

### ZiChuanLan/agent-purge → Persona/Prompt 合成与可逆性（不是新 Runtime）
- URL: https://github.com/ZiChuanLan/agent-purge ，MIT，已固定本机 HEAD **5881e309c5d2bca3eb0cc4125d75f8b573ae5aa0**。本轮只 git clone 研究，**没执行 package、npm、CLI、install、Hook、shim 或 slash**。
- 源码锚点：lib/personas.mjs（Markdown+frontmatter、选择/版本），lib/activation.mjs（按宿主作用范围），lib/extension.mjs（Pi before_agent_start），lib/dsh.mjs（Cordis Profile/Patch），backends/index.mjs（Codex/Claude 启动参数），lib/restore.mjs（可逆恢复），matrix.json、docs/reference/compatibility.md（作者在特定版本隔离请求体的观察）。
- **借鉴**：一份人设跨执行端、Off/Append/受控 Replace、每 Bot 不同人格、运行内可观测、配置变更可恢复；转为 **PersonaRegistry + PromptComposer + MemoryScope + 安全实验室**，与 Skill/MCP/Rule/Hook 统一选择页面并列；不劫持全局 CLI Home/PATH/项目 AGENTS.md。
- **严重风险（已经从本地源码核对）**：当前 lib/dsh.mjs 会剔除 approval:policy / sandbox:policy contexts，并通过 approval/request 触发器自动允许某些工具审批；**不照搬插件，实现窄范围人格适配器且 Core Grant 一律不可被人格改变**。strict 可能让项目 AGENTS/Skills/其他扩展说明消失；不保证 Provider 安全限制消失。详情与未来 T23–T28：[人格/记忆/安全实验方案](research/LOOM-V2-PERSONA-MEMORY-AND-SECURITY-LAB.md)，Schema [六对象](loom-v2-persona-memory-contract.schema.json)。

### ZiChuanLan/pi-purge → Pi 受管系统提示词扩展（已选为产品候选 Extension）
- 固定源码 https://github.com/ZiChuanLan/pi-purge ，commit **d0196ccfd773b0ed342bd2f25372aff65f1a4a53**，v0.3.0，LICENSE MIT；README 的附加用途/署名说明须在分发时单独审查。Node>=22.19.0，Pi peer>=0.80.0<2；本地 Pi 固定 1.0.4 理论版本匹配，但**未运行兼容性测试**。
- 实证源码：extensions/pi-purge.ts（session_start 关闭、before_agent_start 替换、registerCommand purge）；README.zh-CN.md、package.json 与 LICENSE。默认 disabled + mode strict；PI_PURGE_SOURCE 仅控制文件来源，不自动开启；Fallback 是第四种开启模式，别丢掉。
- **LOOM 要借**：原版 Pi 内核完整保留、Pi Purge 可选封包、每 Bot Persona Binding、下一 Run 显式激活、真实 Prompt/RunReceipt；Normal Off/Append，Strict 仅建议隔离 Lab；旧项目 Rules/Skills 不能被静默清除。没有自带长期记忆、多 Agent Coordinator、Core 权限。
- 详细合同：[LOOM V2 Pi Purge Extension Plan](LOOM-V2-PI-PURGE-EXTENSION-PLAN.md)。本轮只读研究仓库，不执行 pi install/npm/plugin，不把其内部示例 Persona 自动传播到其它 Bot。

## 三、研究输出与引用规范

每个施工工兵在 READ FIRST 中锁：
1. 对应上游参考项目**完整 40 位 HEAD + 文件路径/功能锚点**；
2. 归属边界：研究机制还是打算复制实现？复制必须独立评估 License/Notice/Security；
3. 适配的 LOOM V2 Port/Capability/Device 具体 ID；
4. 样例负例、独立 Worker 写权限与回滚规则；
5. 与现行 v1.72 相冲突的旧 API 仅作为迁移参考，不用旧语义覆盖新 Bot/Run/Device 解耦原则。

提示：许可已统一为 MIT，代码导入和打包按 MIT 处理。保留对应版权声明与第三方依赖 NOTICE 即可，不需要再逐项判定复用方式或用途冲突。只有涉及**第三方商标与品牌素材**时才需要单独处理。

## 四、目录放置与禁止自动清理的资产

- 原地保留上述全部参考镜像与固定 HEAD；今后如升级，另建 worktree / lock rev 和差异报告，不能直接在参考目录上 git pull 后把出处冲掉。
- 原 LOOM 当前开发代码与 _artifacts/loom-execution-20261115 的 E3/编译/协议证据原封不动。
- 历史执行计划只做归档和顶部退役声明，见 [历史计划索引](archive/legacy-plans-2026-11-15/README.md)，不删除以便今后能追溯曾试过的错误路径。
- 正式开工前验证未来 DE-BERO 当前 df、镜像/服务状态及 GitHub Remote 权限；**这一轮不登陆、不推送、不构建、不修改云端**。
