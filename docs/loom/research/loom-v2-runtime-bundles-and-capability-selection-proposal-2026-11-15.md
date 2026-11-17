# LOOM V2：Pi / DSH 封包与 Skills/MCP/Rules/Hooks 能力勾选合同

> **最新边界（2026-11-15）**：产品 Runtime 选择器**只允许 Claude Code / Codex / DSH / Pi**，Pi 优先受管封包，DSH 可插拔并单独封包；Claude/Codex 保留原生外部 Adapter，Win11 不实际执行 Claude Code。ACP 是通信协议不是第五内核。以 [LOOM V2 MASTER](../LOOM-V2-MASTER-PLAN.md) 为今后施工主计划；本文件为**讨论合同，不是已安装插件或已跑通四能力的事实**。
> **Pi 扩展已选定、尚未安装**：[Pi Purge Extension 受管封包/实际激活/证据合同](../LOOM-V2-PI-PURGE-EXTENSION-PLAN.md)，固定源码 d0196ccfd773b0ed342bd2f25372aff65f1a4a53、v0.3.0；仅 Pi Runtime 有此 Extension，默认关闭，源码 session_start 会再次关掉，所以必须用可靠 Bridge/本次 RunReceipt 激活；其他三个 Runtime 不装 Pi Purge。专项 Schema：[Pi Purge Binding/Receipt](../loom-v2-pi-purge-extension.contract.schema.json)。
> **Persona 与长期记忆补充**：[agent-purge 源码研究 + PersonaRegistry / PromptComposer / MemoryScope / SecurityLab](LOOM-V2-PERSONA-MEMORY-AND-SECURITY-LAB.md)。Persona 是独立资产，不是 Skill/MCP/Rule/Hook 中的第五勾选项；其 Off/Append/受控 Replace 不得修改 Core 安全 Grant。特别禁止把第三方 DSH purge 的自动审批或沙箱上下文移除 Hook 直接封包进生产。

> DISCUSSION_PROPOSAL v0.1，2026-11-15；不是已经实施、测试通过或当前 v1.72 权威合同。与 [V2 架构与 Ports](loom-v2-universal-architecture-and-ports-proposal-2026-11-15.md) 配套。依据为用户认可的 27 页 PDF 第 12–17 页及本机锁定的 Pi、DSH、ROVAI、PiBot、MOVO 源码。

## 1. 内核选择：先封包 Pi，DSH 是可切换的第二 Runtime

**推荐实施策略**：产品唯一真源仍是 LOOM Core；Pi 作为第一条受管、内置、隔离子进程 Runtime，DSH 作为可选、独立 Host/Sidecar 的第二 Runtime。两者都不嵌入 Rust 进程或把 agent loop 复制到 Core。Device-only Node 在没有 Pi/DSH/Codex 时照样可工作。是否让 DSH 成为新 Bot 默认，取决于同模型/同能力/同权限、真实崩溃恢复与资源开销的对等实测。

| 维度 | Pi（本地 SHA ddaa0a03...） | DSH（本地 SHA 39163dd3...） |
|---|---|---|
| Rust 集成 | packages/coding-agent/docs/rpc.md 提供进程 JSONL、command ID、事件流、agent_settled；sdk.md 另供 Node 进程内 SDK | docs/architecture.md 提供受管 SDK / ACP Profile，profile/bundle/patch 有序组合 |
| Skills | docs/skills.md 支持 Agent Skills 和选择性资源扫描 | Core 提供能力清单，DSH 对应受管 Skills/Profile Loader |
| MCP | docs/mcp.md 支持 stdio 与 Streamable HTTP；extensions.md 允许 registerMcpServer | MCP 客户端、工具注册、Cordis 工具生命周期 |
| Rules | 受管 system/append prompt 或 Extension 注入，绝不能把 Rule 当作 OS 安全强制 | system prompt/provider/plugin 插槽；必须证明当次真正注入 |
| Hooks | Extensions 的 pi.on() session/tool 事件（同 Pi 进程的高权限代码） | Cordis tools/pre-execute、tools/post-execute 等，适配具体 Profile/插件 |
| 核心风险 | 原生 Extension 继承 Pi OS 权限；进程、依赖和资源扫描必须被受管配置收窄 | Profile/Bundle/plugin 版本与 Hook 兼容成本更高；Windows 沙箱可能仅 partial enforcement |

**不能把 Pi“没 MCP/Hook”作为换内核理由**；也不能把 DSH“插件多”直接推导成能更好地完成 LOOM 的多 Agent 任务。当前完整 130 例公平评测 NOT_RUN。

### 1.1 受管封包目录与进程边界（示意）

~~~
LOOM Desktop / Cloud
  Rust Core: Bots / Goals / Teams / Assignments / Capability Registry / Grants
  RuntimeSupervisor:
      pi-runtime/<version>/<digest>/  node + pi + launcher + licenses + manifest
      dsh-runtime/<version>/<digest>/ node + dsh + profile/bundle + manifest (optional)
  managed-data:
      pi/<botRunProfile>/ isolated home, sessions, caches
      dsh/<botRunProfile>/ isolated harness home and patch files
      capability-assets/<assetId+digest>/ reviewed files
  device-ports:
      Windows B / macOS C / Linux D (only lightweight Node required)
~~~

- 固定 exact version、依赖 lock、SHA256、架构与许可证；不能靠系统全局 npm 或用户原生 Pi/DSH Home 假装“已封包”。
- 复用已有 scripts/package-embedded-pi.mjs、loom-pi-launcher 和已有独立 Pi 回执，不重新发明打包器。打包源码/脚本存在不代表独立 Win/Linux 安装器已验收。
- Supervisor 负责启动、进程树退出、取消、超时、重启、异常回收、Host readiness、版本识别；运行端的不同内部事件由 Adapter 映射。
- 一个 RunAttempt 冻结 modelRef + runtime version + capability snapshot + grants；运行中切换引擎/模型需要新 Attempt，不能静默落在不同 Runtime。
- Provider 地址/密钥永远在 CredentialBroker/受限 secret reference，不能出现在 argv、UI catalog、公共日志、工具结果或 Bot Memory。Win11 不执行 Claude Code。

## 2. 现有 UI 不重画，四类勾选要真正生效

在原来的“创建/编辑助手”能力区保留四个分类：Skills / MCP / Rules / Hooks（Memory 是独立第五层）。用户可以选“只对这个 Bot 启用”或按授权使用项目/团队能力；下次运行生效，当前运行不被偷换。

### 2.1 用户可理解的展示

~~~
Hanzi  | Runtime: [Pi v0.xx] [DSH v...（已安装但当前未选）]
[✓] Skill 代码审查   来源：项目    已装载，未调用
[✓] MCP   GitHub     凭据：已绑定  已连接，最近工具调用 2 次
[✓] Rule  项目约定   已注入到本轮（不代表 OS 强制执行）
[✓] Hook  提交前检查 来源：用户    已加载，最近阻断 1 次
[ ] Hook  任意脚本   需要人工审阅 / 当前 Runtime 不支持
  状态详情：来源 / 版本与摘要 / 目标 OS / 适用范围 / 风险 / 为何未生效
~~~

不能只存一个 boolean。完整生命周期必须可读：
DISCOVERED（发现）→ INSPECTED（检查来源/风险）→ SELECTED（用户勾选）→ CONFIGURED（Core 有版本保存）→ PREPARED（冻结下次 Run Snapshot）→ LOADED（Runtime/Hook/MCP 实际装载）→ INVOKED（被实际调用或注入）→ EVIDENCED（可验证原始回执）。另有 UNSUPPORTED / FAILED / REVOKED / MISSING_CREDENTIAL。成功安装不等于 loaded；loaded 不等于 invoked；勾选绝不自动授予文件、终端、远程电脑权限。

### 2.2 资产 / 选择 / 实际快照三层

CapabilityManifest (immutable)：assetId、kind=skill|mcp|rule|hook|memory、version、contentDigest、origin/ref、trustLevel、platformTargets、runtimeTargets、requiredGrants、credentialRefSpecs、configSchemaRef、hookEvents、signature/license。

CapabilityBinding (mutable, versioned)：bindingId、assetId+digest、scope=user|workspace|project|bot|team、scopeId、enabled、configurationRefs、riskReviewDigest、expectedRevision。

EffectiveCapabilitySnapshot (per RunAttempt immutable)：snapshotId、botId、workspaceId、runtimeKind+version、resolvedManifestDigests、configRefs、grantRefs、unsupportedReasons、resolverVersion、createdAt、snapshotDigest。

优先级不是简单的最终覆盖：组织安全拒绝、资源 Grant 不足、本人显式禁用都不可由 Team 推荐项强行开启；同名不同来源/摘要不能偷偷合并。导入扫描来源可包括 Claude、Pi、DSH、项目目录，但“扫描到”不会自动安装/执行原生 Hook 或复制凭据。只读源的路径变化则 invalidated/needs-review。

### 2.3 四类具体语义

| 种类 | 真实加载证据 | 真实调用证据 | 安全线 |
|---|---|---|---|
| Skill | 目标 Runtime 真看到选中 Skill 的目录/指引+版本+LoadReceipt | 模型实际读取完整 Skill/支持文件或调用对应工具/脚本 | Skill 自带脚本也必须经过设备/终端 Grant |
| MCP | MCP 握手成功、server/tool catalog 可用、credentialRef 已结算 | 指定 toolCallId、参数 digest、审批与返回回执 | MCP server 不是无边界电脑权限 |
| Rule | 本次 Prompt/Policy 中准确注入文本 digest 与优先级 | 注入事件/使用范围回执；不谎称模型一定遵守 | Rule 不是资源授权或 OS sandbox |
| Hook | 某个准确原生生命周期事件的 Handler 已注册 | 触发+决策+副作用摘要、拒绝/异常完整回执 | Hook 不能放宽 Core 强制拒绝，不信任 Hook 应隔离进程 |
| Memory | Core 返回已授权 memoryRefs，提供给目标 Run | 使用的 ref 与回复/工具事件关联 | Core 真源，跨 Bot/tenant 访问受限 |

Hook 统一事件候选：run.before、model.before、tool.before、tool.after、run.after、approval.requested、run.failed。由各 Runtime Materializer 声明 native / adapted / unsupported，**不同事件语义绝不强行当 1:1**。真正的权限拒绝在 LOOM Core/DevicePort，不是用户写一个高权限 JS Hook 就能绕过。第三方可执行 Extension 与 Cordis Plugin 需要受管独立 Host 或容器/OS 边界，不能在产品核心进程获得所有凭据。

### 2.4 新增能力/新内核，UI 不需要重写

~~~
新增 Capability
  -> SourceScanner -> Manifest Inspector -> Policy/Review -> Capability Registry
  -> Bot/Team Binding -> Resolve + Freeze -> RuntimeMaterializer
  -> load + invoke receipts -> inspector displays truth
新增 Runtime
  -> RuntimeDescriptor + RuntimePort Adapter + CapabilityMaterializer
  -> shared tests: lifecycle / events / permission / 4 capabilities / crash
  -> register in Core catalog -> original UI immediately gets new runtime option
~~~

未来添加第三方 ACP Runtime 或第五种能力，只增加 Manifest、专用 loader、adapter 和统一验收；严禁把 Pi/DSH 的配置字段散落在 React 组件业务逻辑中。机器可读取的合同示例：loom-v2-runtime-capability-contract.schema.json（本轮仅草案）。

## 3. Pi vs DSH 对照测试，不由感觉换内核

沿用 PDF pp.13–14 的 130 个用例：代码编辑20、多文件重构20、长 Repo20、Skill10、MCP10、Rules10、Hook10、crash+resume10、approval rejection10、tool timeout/reconnect10。固定同一 DeepSeek V4.1 Flash / max、Prompt、仓库快照、模型档位、Tool Grant、能力集、硬件、网络与超时。指标记录 success/review、首次响应、Token/调用量、延迟、RSS、恢复/孤儿进程、真正 loaded/invoked/evidenced、权限拒绝、升级/回滚。

没有真实可重复的等价实验，不改变默认。若 DSH 在恢复/复杂插件/吞吐有明显稳定优势，新 Bot 默认可以改为 DSH，而旧 Pi Bot/运行保持原绑定；否则继续 Pi 默认、DSH 高级可选。无论哪一种，DevicePort 都不能受影响。

## 4. 实施时长：大致范围，不是进度或交付承诺

假设现有 UI 基本保留；1 名总集成/审查 + 3–5 路独占 Pi 工兵可以持续交付；Win11、本地 Bero Linux 沙箱可供隔离验证；真实 Win/macOS 测试设备与合法模型调用额度可用。模型工兵并行不会消除合同审查、全链路调试和跨平台权限测试时间。

| 累计时间（从批准 V2 合同施工起） | 目标 | 限制 |
|---|---|---|
| 第 1–2 周 | Domain/Port/Schema 定稿；一个 Bot、两个 Worker、一个 Runtime 真派工/回执 demo | 不是跨机可交付 |
| **第 4–6 周** | **第一版单用户可用**：沿用 UI，Pi 受管 Runtime、BotTeam/群聊任务 DAG、四能力真实勾选生效及回执、Artifact/Review、Cloud→Windows 基础 File/PTY E5 | macOS GUI、企业多人不在此承诺 |
| **第 8–12 周** | **个人日常版**：Linux Cloud、多 Windows、断线可恢复、DSH 第二 Runtime + 公平测试、macOS 基础 Node/PTY | 同机 E3 不可代替物理机 E5；DSH 胜负待验 |
| **第 12–20 周** | 完整跨平台体验：Mac/Win computer viewer/人工接管、OS 权限真实回归、E6 故障和更新回滚 | GUI、TCC、RDP/Wayland 最大不确定性 |
| **第 20–32 周** | 多用户与企业：workspace/tenant 资源隔离、共享 Bot、角色/配额/审计/攻防回归 | 不预先部署企业大单体服务 |

如果只需能在 UI 勾选、Pi Runtime 执行一个真实 Skill/MCP/Rule/Hook 的功能切片，可以单独在 **约 2–3 周** 交付演示版；四能力真正全面覆盖 Pi+DSH、持久/多设备安全与管理不是 2 周内的事。以上是估算，不是当前产品“已完成百分比”。

**关键路径**：先将 Bot/Team/Goal/Assignment、CapabilitySnapshot、RuntimePort 这些接口冻结，再让 Runtime/Capability/Coordinator/Device 工兵并行。不能继续在旧 AgentRun 冻结 CLI 的假设上改 W12，导致接入每一类能力都要重构。

## 5. Pi 工兵划分（真正开工前确认接口、避免重复开发）

- C0 Domain/Contract Owner：对象/SQL 迁移影子映射、Resolver snapshot、统一错误/事件合同。
- C1 Pi Bundle Owner：先复审已有封包脚本和回执，打通新 Core Port + Win/Linux package/probe/cancel/kill/recover。
- C2 Capability Owner：source inspector、manifest、scope、selection、materializer、Core receipts，首期四类 Pi 正负例。
- C3 Multi-agent Owner：Mikka routing + ACCP Claim/Lease/DAG/Review，BotTeam 多 Worker 并发、重复或迟到回执拒绝。
- C4 DSH Owner：隔离 DSH sidecar/Profile/Materializer；公平 130 例 bake-off，不能影响 Pi 版本先可用。
- C5 Device Owner：复用现有 R2/Device Node，解除 Run-CLI 耦合并连接 Artifact，真 Linux/Win E5。
- QA 独立：四能力真证据、Agent/设备掉线重连、跨 Bot 权限和真实 OS 行为；不能靠模拟“全部通过”。

## 6. 尚未冻结的取舍

- 第一版四能力的来源默认顺序（建议只读扫描 Claude/Pi/DSH/项目，但 Hook 不自动启用）。
- DSH 何时和 Pi 一起进入产品安装包，或先作为可选下载的受管运行包。
- 企业级 Capability Sharing 是否从首版开放（建议首版保留数据结构/授权边界，UI 不做复杂企业后台）。
- macOS 电脑远控与 GUI 是否纳入第一版（建议后置，不要延误 File/PTY/多 Agent）。
- 上述方案未修改现行 v1.72 的 canonical Contract。用户认可后要按 docs/README.md 与 docs/decisions/README.md 的治理规则正式推进。
