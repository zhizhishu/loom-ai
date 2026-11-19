# LOOM V2：Pi Purge 受管扩展接入方案（架构交接）

> **用户确认：Pi Purge 是 Pi Runtime 的可选扩展，不是第五个 Agent 内核。**
> **2026-11-16 用户已批准纳入 4–6 周个人可用开发范围。** 本页保留五模式的原始设计；当前受管适配的已实现范围为 Off/Append，原生三协议实测、闭包与待补 Core/UI 接线统一看 [当前实施](../../../../LOOM-IMPLEMENTATION.md)。不再从下文历史“本轮未执行”推断现在仍未开工；详细结果不复制成另一份开发书。
> 入口：[V2 总计划](LOOM-V2-MASTER-PLAN.md) · [Pi Purge 机器 Schema（2 对象草案）](../../loom-v2-pi-purge-extension.contract.schema.json) · [Persona/Memory](research/LOOM-V2-PERSONA-MEMORY-AND-SECURITY-LAB.md) · [Runtime/四能力](research/loom-v2-runtime-bundles-and-capability-selection-proposal-2026-11-15.md) · [参考锁](../../LOOM-V2-REFERENCE-LOCK.md) · [未来 180 分钟计划](../legacy-plans-2026-11-15/LOOM-V2-3H-FAST-TRACK.md)。

## 1. 真实上游来源与兼容事实

- 来源：ZiChuanLan/pi-purge — https://github.com/ZiChuanLan/pi-purge 。本机只读参考镜像：_artifacts/reference-repos/pi-purge-current。
- HEAD：**d0196ccfd773b0ed342bd2f25372aff65f1a4a53**；package 版本 **0.3.0**；LICENSE：MIT；Node >=22.19.0；声明 Pi peer：@earendil-works/pi-coding-agent >=0.80.0 <2。
- 真正阅读过的源码：extensions/pi-purge.ts、package.json、README.zh-CN.md、LICENSE。官方 Pi 本地参考 ../_references/pi-agent HEAD ddaa0a0341a84b073a087a3d89b9b9e7fbdaf6ba、package **1.0.4**：版本落入 peer 范围，但**未实测 Pi 1.0.4 + pi-purge 0.3.0 一起执行**，不可称“兼容 PASS”。
- 真实 Extension 使用 session_start、before_agent_start、registerCommand("purge")；它不创建自己的完整 Agent Loop，不是独立 Runner，也不提供长期记忆。GitHub README 声称无持久写入及自带测试，本轮**没有运行第三方代码或其测试**。
- 参考仓库 README 还包含额外的使用/署名/地区声明；将来实际分发前应分别核查 LICENSE、README、NOTICE/归属与合规边界，不只看 “MIT” 一个词。

## 2. 产品架构：原 UI + Core V2 + Pi 内核 + 可选 Pi Purge

~~~text
              现有 LOOM UI（配色/三栏/群聊保留）
        助手 / BotTeam / 任务 / 人格 / 四能力勾选
                          │
                    LOOM Core V2
         ┌────────────────┼────────────────────┐
         │                │                    │
 BotIdentity / Goal   PersonaRegistry    CapabilityRegistry
 Mikka Coordinator    PromptComposer     Skill/MCP/Rule/Hook
 ACCP Assignment      MemoryScope        Core Policy / Grant
         │                │                    │
         └────────────────┼────────────────────┘
                          │
                     RuntimePort
         ┌────────────────┼─────────────────┐
         │                │                 │
   Pi Runtime        DSH Runtime       Codex / Claude
   （优先封包）       （可插拔）         （Native Adapter）
         │                │                 │
  原版 Pi Agent Loop   各端 Persona Adapter（非 Pi Purge）
  Pi JSONL RPC / SDK
         │
    Pi Extension Host
         ├─ Pi Purge [可选/版本固定]
         │    └─ Persona 的 off / append / replace / fallback / strict
         └─ 受管 Skill / MCP / Rules / Hooks 适配
         │
     Tool Broker / DevicePort → Windows / Mac / Linux
         │
     Artifact / Evidence / Review / Memory Checkpoint
~~~

**长期 Bot 不等于 Pi 进程；Pi Purge 不等于 Bot 人格数据库。** 一个 Bot 可以派多个 Worker；每个 RunAttempt 有冻结的 PersonaBinding/PromptSnapshot/CapabilitySnapshot/Grant。不同 Bot 和并发 Pi Session 不得共享易变的 purge 状态。换用 DSH、Codex、Claude Code 时，BotId、长期记忆和 Persona 资产仍属于 Core；**Pi Purge 不会被伪装成这些引擎的通用插件**。

## 3. Pi Purge v0.3.0 源码对应的全部模式

| 模式 | 原扩展实际行为 | LOOM V2 产品建议 |
|---|---|---|
| **Off** | enabled=false 时完全不碰 Pi Prompt | **默认不启用** |
| **Append** | Persona 放在前面，保留整个原版 Pi 系统提示词 | 普通开发/工作首选 |
| **Replace** | 去除匹配的 Pi 身份行与宿主文档段，其余工具/项目上下文保留；锚点没匹配时退化 Append | 高级选项；必须给用户看实际匹配/差异 |
| **Fallback** | 内嵌示例时不修改 Prompt；指定外部 Persona 文件时按 Replace | “装着备用”模式；不得误报已修改 |
| **Strict** | Persona 加工作目录，去掉原宿主系统提示词；同时失去 AGENTS.md、Skills/其他 Extension 指引段 | 建议放在**隔离 Prompt/Security Lab**，不当生产任务默认 |

**最容易踩坑的源码事实**：原版内部默认 mode="strict"，但 enabled=false；每次 session_start 都会重置为关闭。PI_PURGE_SOURCE 只设置 Persona 文件初始来源，**不会自动打开**。所以“文件打包进 Pi”“设置环境变量”甚至“UI 已勾选”均不代表运行时生效。Strict 下 Pi 的 tool schema 仍随 API tools 参数发送，但模型失去 Skills/工作规范指引，不代表行为等价。

Pi 原版本来就不要求每次 Tool Call 人工确认（官方 security.md）；Pi Purge 的目的只是改变**可控的宿主 Prompt**。无论 Append/Replace/Strict，都**不解除 Provider 政策**，不增加文件、终端、MCP、设备权限。资源授权仍由 LOOM Core/受管沙箱/DevicePort 在真正执行边界实施。

## 4. 怎样做到用户“勾选后真的生效”，而不改 Pi Agent Loop

在原来的“编辑助手”折叠区，Pi 内核时增加：

~~~text
Hanzi · Runtime: Pi (受管)
  人格     [架构师 ▾] [预览差异]
  Pi Purge [☐ 启用，默认关闭]
  模式     [Append ▾] / Replace / Fallback / Strict (仅隔离实验)
  记忆     [Bot 长期 / 项目 / 本次 / Lab]
  四能力   [Skill ☑] [MCP ☑] [Rule ☑] [Hook ☑]
  状态     未选择 / 已打包 / 已加载 / 已启用 / 本轮已应用 / 不支持/失败
~~~

**四段责任边界**：

1. **Bundle**：在已有 scripts/package-embedded-pi.mjs 和 crates/loom-pi-launcher 的受管 Pi Bundle 中，增加一个**可选、固定 SHA、带许可证**的 Extension，不能要求用户自行全局 pi install、不能自动升级，也不能从任意 URL 执行新 Hook。
2. **Binding**：Core 保存 PiPurgeBinding（BotId、Pi ExtensionVersion/SourceCommit、enabled、mode、PersonaId+digest、revision、scope）；下次 RunAttempt 冻结有效 Prompt、MemoryScope、能力、权限。用户切换人格/模式，不会改变已经运行的 Attempt。
3. **Activation**：下一轮先实测原生 RPC/SDK 是否能在 session_start 之后、第一条模型请求之前可靠运行 purge mode/source/on 并取得回执。**不能把用户聊天中包含 “/purge” 当作受信控制命令**。若 CLI/RPC 不支持自动激活，维护**极小的 LOOM Bridge**，仅在受管 Extension Host 内从已验证的 Run Snapshot 读取源/模式/启用位，必要时用 Pi SDK 的受支持 Prompt API；不要 Fork 整套 Agent Loop。PromptComposer 与各 Extension 的 before_agent_start 写入顺序要有唯一 Owner，防止 Rules/Skills/记忆段被后来的扩展覆写。
4. **Evidence**：真实 Loader 和 before_agent_start 变更回执，按 RunAttempt 保存 requestedMode、actualMode、sourceDigest、PiVersion、pluginDigest、有效 Prompt hash、锚点替换/退化原因。只有证据才显示 “已生效”；如果只能证明组装而无法观察 Provider 实际收到，则显示 “已组装/未核验接收”，而非假 PASS。

**建议数据合同**（仅规划，具体字段在 P1 冻结）：

~~~text
PiPurgeBinding {
  botId, extensionId:"pi-purge", sourceCommit, extensionVersion, digest,
  enabled, mode:off|append|replace|fallback|strict,
  personaContentRef, personaDigest, scope, revision
}
PiPurgeApplyReceipt {
  runAttemptId, piVersion, extensionVersion, extensionDigest,
  modeRequested, modeActual, activatedAfterSessionStart,
  sourcePersonaDigest, promptApplied, effectivePromptDigest,
  identitySegmentRemoved?, docsSegmentRemoved?, warnings[],
  observedAt, evidenceRefs[]
}
~~~

Extension 只有 Pi 本地生命周期状态，**不得接管 Memory/Goal/Team 的权威持久化**。来源文件必须受控，固定 hash，不允许不可信用户指定任意真实秘密文件路径。每 Run 的生效状态属于 effective Persona/PromptSnapshot 的子证据，不产生第五类 Capability。

## 5. 未来工兵拆分与真实验收（这轮没有开始）

| 归属 PDF 阶段 | 工兵 / 实际验收 |
|---|---|
| **P0 Reference Lock** | Git SHA/0.3.0/许可证锁；真实 Node/Pi 兼容预检；参考文件只读，记录升级 diff |
| **P1 Contract Freeze** | PiPurgeBinding / ApplyReceipt / prompt hash / Off/Fallback/Strict 语义、Core vs Extension 边界 |
| **P3 RuntimePort** | 复用原 Pi Bundle；只加可选扩展，证明 Off 同原生、session_start 重置、新 Attempt 真激活 |
| **P4 Runtime Bake-off** | 同条件模型/工具下对比 Off/Append/Replace/Fallback/Strict；工具不越权；锚点失配诚实退化 |
| **P8 多 Agent** | 两 Bot 两 Pi Sessions 不串人格/记忆；断线后从 Core Binding 恢复而非信插件会话状态 |
| **P9 Persona/Capability** | UI 选中→受管源文件→真 before_agent_start→PromptReceipt；四能力仍能各自 Load/Invoke |
| **P12 UI Preservation** | 原助手编辑面板加折叠配置，不重画；DSH/Codex/Claude 不显示“已安装 Pi Purge” |

**专项验收 T29–T33**：T29 关闭态 Pi Prompt/工具回归；T30 用户勾选→后继 Run 真激活与收据；T31 四模式 + Off、Fallback、锚点失配；T32 多 Bot 隔离与恢复；T33 Strict 的隔离 Lab/未经授权工具拒绝与 Hook 排序负例。分别标 E0–E7；源码存在、测试脚本存在、弹窗消失不等于全部通过。

**三小时优先级**：先保证 Bot/Worker/Runtime/四能力基本闭环；若有空间，仅尝试 **Off/Append 的一条 Pi Purge 真证据**。完整 5 模式、Cloud/Win、多 Agent 故障恢复及长期记忆校验仍属后续 Gate。

## 6. 和 agent-purge 的关系

- [agent-purge](research/LOOM-V2-PERSONA-MEMORY-AND-SECURITY-LAB.md) 仍是**跨四 Runtime 的 Persona/Memory 管理参考**，不是 Pi 扩展。它的 DSH Hook 存在修改审批/沙箱上下文及自动允许审批的风险，不得直接复制进受管 DSH。
- **pi-purge** 是 Pi 侧一个实际存在的 TypeScript Extension。普通用户选了 Pi 才可能启用；其他 Runtime 通过 Core PersonaAdapter/PromptComposer。
- **本轮没有**使用 pi purge、没有触发工具执行、没有测试它的版本组合、没有修改当前 LOOM 产品运行环境；它是未来 P1–P3 的受管 Extension 工单，而不是“已完成新功能”。
