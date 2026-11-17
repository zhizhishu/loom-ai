# LOOM 用户级产品接口与适配边界

> 本文记录 2026-11-13 实施的接口，而非另造控制面。实施状态与用户纠偏入口以根目录 `LOOM-IMPLEMENTATION.md` 为准。下文的 ACCP 指设计参照，不表示 LOOM 已兼容 ACCP 服务器或 wire protocol。

## 0. 2026-11-16 跨仓 Owner 与证据门（治理说明，非新 Wire Schema）

> 这里说明 LOOM V2 接口由谁拥有、如何验证，不修改已发布 v1.72，也不发明正式字段。任何新命令/JSON/错误码，必须进入本仓 `docs/contracts/`、`docs/architecture/`、`docs/decisions/` 的既有治理；实际功能与未通过门槛仍只看根目录 `LOOM-IMPLEMENTATION.md`。

| 交互层 | 唯一 Owner | 必须回执 | 当前真实范围 |
|---|---|---|---|
| 用户级 Skill/Hook/Rule/MCP 源本与宿主适配 | 项目外 `~/.claude` 各 Skill 源本、独立父仓 `skill-cli` 负责四端分发治理 | 登记目录/版本/适配支持和原生 doctor；LOOM 不能覆盖全局配置或复制用户密钥 | 同步完成 ≠ 本次 Run Loaded/Invoked |
| UI → Core | LOOM Core，UI 仅是经过认证的消费者 | 已持久化 Bot/Thread/Goal/配置版本，错误时保留指令身份 | 已有部分真实读写；正式 UI 全旅程未验 |
| Core → RuntimePort | LOOM Core 保存/冻结，Pi/Codex/DSH/Claude 各 Adapter 实际执行 | Run/Assistant/Assignment/Claim/Fence、冻结 Persona/能力/Workspace Grant 的关联，原生应用/拒绝和实际调用回执 | 双真实 Pi Worker、Codex 文件为单项；DSH 仅原生压缩专测 |
| Runtime/Tool Broker → DevicePort | Core Grant + 实际 Node/OS 负责 enforcement | 配对 Node 身份、资源范围、Lease/Fence、工具结果和未知副作用对账 | **E5 实际跨机未通过**；DE-BERO Host/Web 在线不等于 pairing |
| Artifact → Candidate → Review → Owner | LOOM Core Artifact/Review 与真实用户 | 不可变 hash/来源、PENDING 状态、Review 决定、用户接收和发布分别记录 | 真实 Artifact 有证，Owner Review=0 |

**四能力必须逐个验证**：`Discover → Inspect → Select → Configure → Freeze → Materialize → Loaded → Invoked → Evidenced`。Skill、MCP、Rule、Hook 分开；Memory/Persona 独立治理。UI “已保存”不等于原生 Runtime “已生效”；Pi Purge 是 Pi Extension、不是第五 Runtime，ACP 是协议、ACCP 是设计参考。

**所需语义清单，不是新增 wire 字段**：任何真实执行可追溯 Goal/Assignment/Run/Claim/Fence/权限快照、设备 Grant、原生加载与调用、不可变 Artifact SHA 与 Candidate/Owner 状态。精确字段名和服务形状仍由正式 Contract 拥有，不能把本段示例映射成已实现 API。

**负例验收**：旧 Fence 与错误 Bot/epoch 必须拒绝；没 Grant 不能写；原生 readOnly 不能报写入成功；未完成 Device pairing 不得显示为跨机任务已完成；PENDING 不得被脚本代用户签收。本轮仅补接口分治文档，未增加 Runtime/Device 功能。


## 1. 产品模型

用户面对 Assistant / Conversation / Work / Artifact / Computer。内部继续以唯一 Core 保存真实身份、成员关系、任务、运行、能力选择与人工决定。新 `loom-native` 前端不拥有另一份业务数据库。

- Assistant：长期身份、简短用途与风格、当前运行配置、能力选择、工作位置。
- Conversation：单聊或多助手协作。恰好一个有效主助手；主助手必须在参与者中。副助手不是低权限账户，只是本群中的其他参与者。
- Work：目标、任务、依赖与运行记录。一次 Run 结束不自动完成整项工作。
- Artifact：不可变内容/版本与来源。核验、审查、用户接受、发布分别记录。
- Computer：执行节点与准备好的工作区。远程进程执行与图形屏幕控制是两种不同能力。

## 2. 实际接口层

所有路径相对 `apps/desktop/src/renderer/src/loom-native/`。

| 接口 | 源码 owner | UI 不得自行推断 |
|---|---|---|
| Assistant identity / runtime | `assistant-service.ts` | 安装、模型可用性、原生权限枚举、更新版本 |
| Capability catalog / selection / import | `capability-service.ts` | 已保存即已装载、预览即实际执行、未知即未选中 |
| Room creation / roster / Lead / permission option | `room-service.ts` | 空聊天自动派工、成员关系即文件权限、未知请求结果可重新创建 |
| Execution target / device / workspace | `execution-service.ts` + 既有纯 controller | 设备列表读取失败即离线、本地路径即远端路径 |
| Conversation / task reads / send | `service.ts` + `useLoomData.ts` | 失败后清草稿、传输未知后重新生成命令身份 |
| Artifact version / acceptance | `artifact-service.ts` | 自动替用户接受、按时间猜 lineage |

这些接口消费已认证 `ThreadClient.request` 和宿主 `BusinessEnvironment` 的窄能力。Desktop IPC 与 Web HTTP 共享命令形状，传输实现仍由现有 Host adapter 拥有。迁移运行端时替换服务/宿主适配器，不改 UI 表单和工作状态含义。

### 精确操作合同

- `members.update {commandId, command:{agentId,expectedVersion,...identity}}`：仅更新用户选择的资料，头像另有 owner；读回 `members.get`。
- `members.runtime.set {commandId,command:{agentId,expectedVersion,adapterKind,model,permissions}}`：每助手配置，不改全局默认。
- `members.capabilityCatalog.get {agentId}` / `.set {agentId,expectedRevision,acknowledgeHighRisk,selections,reviewedHooks}`：保存选择，不能添加伪造的通用字段。
- `members.runProjection.preview {member,runtime}`：下一 Run 的配置预览；不是 Host 已应用回执。当前只支持 Codex/Claude 的已有入口。
- `skills.import.inspect {path}` → `.commit {commandId,command:{stagingToken,candidateName,expectedDigest,expectedSkillVersion,confirmUpdate}}` → 显式目录登记。只有检查到的精确版本可以提交，不能在确认后悄悄重新检查并换版本。
- `threads.create {commandId,name,workspace,memberAgentIds,defaultLeadAgentId,collaborationMode:'peer',activationState:'active'}`：创建可用会话，不发送任务。
- `threads.members.add` 使用当前 membershipGeneration；顺序添加时只能使用 Core 返回的新代次，不能自行加一猜测。
- `threads.changeDefaultLead` 使用 thread.version；不变更能力和权限。
- `action.approvals.resolve` 必须携带实际 approval 的 ID、version、optionId。当前标准选项包括 allow_once / allow_session / deny / cancel / other；**没有人为造出的 allow_always**。
- `members.executionTarget.get/save` 使用 memberId、expectedRevision、selection。`selection:null` 是本地；remote 必须携带真实 node/workspace/runtime 配置。

## 3. 四 Runtime 适配矩阵

| 产品选项 | 实际 AdapterKind | 本机配置 | 远程选择 | 统一能力预览 | 内置发布 |
|---|---|---|---|---|---|
| Claude Code | `claude-code-cli` | 依真实安装/默认/schema | 依节点 descriptor 与工作区 | 已有 Core 接口 | 不打包第三方 CLI |
| Codex | `codex-cli` | 同上 | 同上 | 已有 Core 接口 | 不打包第三方 CLI |
| DSH | `deepseek-harness` | 依真实安装/模型来源 | 当前不宣称支持 | 当前统一预览不支持 | 不打包第三方 CLI |
| Pi | `pi` | 依真实安装/独立受管包 | 当前不宣称完整支持 | 以实际 Core 接口支持矩阵为准 | 隔离候选已封包；旧 UI 元数据与发行门槛见下节 |

“产品选项”不是“本机已经安装”。安装缺失、路径不可用、未登录、无法探测需要分别呈现，不可以自动选择另一运行端或模型。

## 4. 内置 Pi 决策

采用 **可插拔的受管 Pi 子进程**作为目标，而不是把模型循环塞进 UI 或另外创建一套任务数据库。当前已有 Pi JSONL RPC 适配器是第一条复用路径。

建议后续包的 owner：

```text
LOOM Core 的 Run / 权限 / 事实
    → PiRuntimeAdapter
        → 受管 Node + 固定版本 Pi RPC entry
            → Pi 自己的模型 / 工具循环
```

本地参考包 `@earendil-works/pi-coding-agent@0.85.1` 的 manifest 声明 MIT，Node 最低版本 22.19；公开 RPC entry 位于 `dist/bundle/rpc-entry.js`。这是固定本地快照，不是上游最新版本声明。

早期 `AssistantRuntimePort` 的 `packaged:false` 是当时 UI/接口元数据，不能据此否定后来已验证的固定 Pi 隔离候选；实际包版本和闭包由 manifest 证明，正式发行另验。不得覆盖用户 Pi、复制账号或通过一个 UI 标志假称安装完成。依赖/许可证、独立 Home、工具权限、启停取消恢复和下载完整性必须分别核验。Pi Purge 为 Pi 侧可选扩展：当前原生适配 Off/Append，冻结的 Run/Bot/epoch 与 Persona/上游摘要必须一致；后续产品 Core 生成绑定及 UI 选择仍需要接线，不能把隔离测试 Binding 当成正式授权。

## 5. 能力与权限分层

Skill 是指南/资源；MCP 是外部工具连接；Rule 是指引；Hook 是可执行生命周期定义。四者不共用权限含义。

每次配置变化至少区分：用户草稿 → Core 保存版本 → 下一 Run 冻结 → 节点准备/实际应用 → 工具调用证据。没有对应回执时，界面只说“已保存，下次运行采用新选择”。

MCP 账号连接仍归现有 Host 配置；能力页分配已登记服务器，不自行读取/复制登录凭据。本轮新增能力库导入 Skill 和创建规则/命令 Hook，不扩展全局 MCP 配置接口。

Hook 保存定义不执行，也不自动批准。启用必须审阅精确正文摘要和成员/节点/工作区范围。定义或范围变化，旧审阅不能重用。首批简化创建表单输出 Claude native command-hook 格式；不能冒充多 Runtime 同等支持。

一次/持续允许由原生权限选项和保存到助手的权限配置分别表达。`allow_session` 是当前会话范围，不翻译成永久整机信任。配置高风险模式前显示实际选项和确认对话框。

## 6. 工作流、成果、电脑

ACCP 借鉴：任务责任、Run 身份、不可变上下文/候选、独立审查、人类接受和副作用审批。保留现有 Core 事务/版本/幂等 owner，不加第二调度器、消息总线或共享密码库。

Mikka 借鉴：用户只需讨论目标，主助手组织协作，右边关注需要人处理的工作和成果。协调者不是数据库，任务完成不能从助手一句话推导。

WorkMap 当前是**真实数据的只读关系视图**：依赖来自 `loom.dependencies.list`，候选版本来自 previousCandidateId，文件来自 evidenceIds。时间只用于展示，不产生边。没有假流程节点、没有拖动节点直接批准任务。

当前 Core 没有提供图形屏幕流/输入协议。本轮“电脑”仍诚实展示未连接；新工作位置配置确实接入节点和准备工作区，但不把进程调度冒充远程桌面。后续 Computer adapter 需单独的 screen subscription、input ownership、用户接管/归还和权限边界。

## 7. Prompt 变更

精确前后文本与版本归 `docs/versions/v1.72/model-context-change-loom-productization.md`。

本次把新 Run 的品牌/冗长 Mission 表达收敛，保留真实 CLI、用户授权、消息发布、渠道与候选接受边界；Charter revision26。新内置助手的用途改为实现/审查/研究/设计，既有用户资料不被 seed 覆盖。UI 提供显式职责模板，由用户选择保存，不能一键静默重写所有助手。

## 8. 接口验收与兼容原则

- 精确请求参数与返回类型单测；未知/拒绝/版本冲突不当成功。
- 读取页面不产生创建、派工、审批或外部工具调用。
- Group create 同一请求可用原 commandId 对账；模糊结果不更换请求身份。
- Hook/规则创建与启用分开，保存选择与实际生效分开。
- 数据错版本/读不到显示错误，不伪造空状态。
- 生产 UI、隔离 Core 写入测试、fixture tests 和真实模型运行分别标记。
- 计划内不等于交付。完整验收结果与当前缺口只汇总在根 [LOOM-IMPLEMENTATION.md](../../LOOM-IMPLEMENTATION.md)，本文件不维护第二份进度表。

## 9. 云端执行位置、企业扩展与能力真相

- **同一个 Bot / Core，三个部署模式**：T = Cloud Brain + 纯工具 Node（设备可无本地 CLI），R = 可选本地 Runner（明确四 Runtime 的实际适配与就绪），H = Hybrid（按任务选云端、设备工具或本地 Runner）。BotIdentity、Goal/Run、Artifact/Review、Grant 的事实归同一个 Core；设备只是执行地点或工具来源，UI 不持有第二真源。
- **Node 与授权不同层**：Node 在线、TLS 通、真实配对、工作区 Grant、工具可执行和远程屏幕控制分别要有回执。File/PTY/Browser/Computer 是独立 DevicePort 能力，屏幕 Provider/人工接管需要单独许可；断线后的未知副作用不换 requestId 无条件重试。
- **ACCP 借协作机制，不加新运行端**：Goal/Step → Claim/Lease/Fence → Run/Artifact → Independent Review → Owner Acceptance 分别持久记录；ACP 是协议，与 ACCP 不是同一事物。
- **未来企业化隔离（未实现，不得宣传为已交付）**：Tenant/Organization/User/Role/Resource/Permission/Quota/Audit，前提是实际的租户边界、权限拒绝、数据和凭据隔离，以及可测审计。参考 [AgenTeam/MOVO](LOOM-V2-REFERENCE-LOCK.md) 的思路；MOVO Community 代码不提供完整企业 ACL。
- 借鉴 [DeskFleet、MindFS、UFO³ Galaxy](LOOM-V2-REFERENCE-LOCK.md) 的设备目录、daemon、工具分离和多设备调度；不等于已经接入它们的线协议或可以直接操控任意用户电脑。规划历史保留在 [V2 设计基线](LOOM-V2-MASTER-PLAN.md)，未冻结细节在 [研究](research/loom-v2-universal-architecture-and-ports-proposal-2026-11-15.md)。
