# LOOM 用户级产品接口与适配边界

> 本文记录 2026-11-13 实施的接口，而非另造控制面。实施状态与用户纠偏入口以根目录 `LOOM-IMPLEMENTATION.md` 为准。下文的 ACCP 指设计参照，不表示 LOOM 已兼容 ACCP 服务器或 wire protocol。

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
| Pi | `pi` | 依真实安装 | 当前不宣称支持 | 当前统一预览不支持 | `packaged:false`，见下节 |

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

本次已设置 `AssistantRuntimePort` 的 transport/embedded 类型，Pi 标记 **packaged:false**。没有偷偷安装、下载、覆盖用户 Pi，也没有把该选项显示成已内置。真正交付打包版需：锁定实际依赖完整性与许可证、独立配置/会话根、无凭据自动迁移、工具审批语义对齐、Windows/Linux 启停取消恢复测试、模型账单/认证清晰、打包产物验证。不能用“有 SDK”替代这些门槛。

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
- 计划内不等于交付。完整验收记录与当前缺口在根目录阶段文件和证据目录。
