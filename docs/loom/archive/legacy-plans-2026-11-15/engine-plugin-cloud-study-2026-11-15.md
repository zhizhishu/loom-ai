# LOOM：DSH / Pi 内核、插件生态与云端控制 B 设备研究（2026-11-15）

> **定位：调研和架构建议，不是已交付运行时或云端功能。** 先单用户/多设备，后组织/多用户。沿用现有 Rust Core、R1/R2/B7 和 Native/ComputerPort，不另建第二套任务、权限、记忆或进程账本。用户当前禁止执行 Claude；所有本轮 Pi 工兵请求只使用 `oct-chat/deepseek-v4.1-flash`、`max`。尚未启动任何 DSH/MOVO/AgenTeam 服务、安装仓库依赖或改生产配置。

## 一、来源与冻结版本

仅为参考，不将参考仓库 git 历史/前端资产复制到 LOOM 可发布包：

| 来源 | 本机路径（相对 LOOM） | 参考 HEAD | 许可证及风险 |
| --- | --- | --- | --- |
| Stonewuu/agenteam | `_artifacts/reference-repos/agenteam/` | `d12b50760b091d8783eca7bf8c11f113d063e4cb` | Apache-2.0；Java/AgentScope 2.0，后端 Java 模块不能无成本移植到 Rust |
| himovo/movo | `_artifacts/reference-repos/movo/` | `e16174acc4edeb30534d87d9f7f5ff8806854955` | **MOVO Community License，非原版 Apache-2.0**；未经书面许可限制多租户 SaaS、白标/OEM 平台销售和 MOVO 前端品牌修改；未来 LOOM 要做独立产品，**只研究思想，不直接复制其前端或业务源码** |
| DeepSeek Harness | 既有本机 DSH 安装 + 上游文档 | 当前本机现有安装及官方 docs；MOVO Host 锁 `0.2.2-rc.2` | 上游 MIT；插件接口尚有不稳定性，接入应锁版本并通过兼容门禁 |
| 现有 LOOM | `docs/architecture/cross-host-execution.md`、`docs/contracts/workspace-rpc-v1.md`、`docs/loom/ultimate-interface-contracts.md` | 本次调研前开发分支 `65fcb852...` | Core 已有跨节点 R1、R2、B7、ComputerPort 和内置 Pi 规划；禁止重建已有业务事实 |

克隆时使用 shallow + partial，不启动来自仓库的程序。AgenTeam/MOVO 的其他依赖许可需在实际复用前重新核查。两个参考仓库均位于现有 `_artifacts/` 忽略目录，默认不推到 LOOM GitHub。

## 二、源码研究的实际发现

### AgenTeam：企业层与隔离方案可借鉴，运行时不直接适配

- `agenteam-server/src/main/java/com/stonewu/agenteam/model/execution/entity/ToolApprovalPolicy.java:6-28`：`DEFAULT / AUTO_APPROVE / FULL_ACCESS` 是**是否逐次审批**，类注释明确“不授予资源访问权限”。独立于文件隔离。
- `.../service/execution/RunApprovalService.java:123+`：使用 AgentScope 暂停/继续语义、持久化审批与 Run 生命周期约束；借鉴**审批绑定同一次调用、超时/撤销可追查**。
- `.../service/agent/ExecutionGuardMiddleware.java:33+`：父子 Agent 共享执行步数/并发限额，调用前检查领取资格。借鉴执行资源预算与 Run 有效性。
- `.../service/workspace/WorkspacePaths.java:17-89`：仅接受逻辑目录 `inputs/tool-results/work/outputs`，写仅允许 `work/outputs`，拒绝目录跳转/符号链接/系统设备名；这部分服务端二次验证非常值得借鉴。
- `.../service/workspace/WorkspaceAccessService.java:24-90`：保存过的成果不绕开之后的资源撤权；按当前 Run/Lease/来源再次验权。
- `.../service/project/DockerProjectCommandExecutor.java:42+` 和 `.../service/sandbox/RemoteSandboxExecutor.java:37+`：Docker 与远端执行器是独立后端，并非简单切换 cwd。
- `.../service/environment/EnvironmentTerminalProcess.java:35-36`：本机只建立受管命令/协议桥，真正终端 runner 在已隔离容器中。
- `.../service/permission/EnterpriseAuthorizationService.java`、`.../service/permission/ResourceAuthorizationService.java`、`.../service/enterprise/EnterpriseProvisioningService.java`：组织角色及资源授权分层。单用户阶段不急于做组织角色，但能力资产须预留 owner/scope/version。
- `.../service/skill/SkillImportService.java`、`.../service/plugin/JavaPluginManagementService.java`：技能/插件生命周期与资源授权由平台管理，独立于底层 AgentScope 运行时。

**不直接抄：** AgenTeam 使用 Spring/Java AgentScope 和 Linux Docker 执行容器；仓库中未发现可直接拿来控制用户 Win11 电脑 B 的通用原生设备 Agent。Windows Junction/reparse point、UNC、ADS、桌面会话与沙箱需单独实现和验收。它适合做“企业产品逻辑/隔离策略”的参考，不适合替换 LOOM Rust Core 或接管四端原生 Runtime。

### MOVO：真正把 DSH 作为 Agent Runtime，但治理仍属于产品

- `services/chat-api/dsh/runtime-host/package.json`：显式固定 `@deepseek-ai/dsh` 及大量 DSH 官方包 `0.2.2-rc.2`。
- `.../src/official-host/composition.mjs:37-115`：通过 DSH `appBoot.boot()` 构建 managed Profile，使用 `pluginManager` 安装/核对插件；声明 enabled 不等于插件实际激活（逐条校验 fiber phase）。
- `.../src/official-host/overlay.mjs:9-85`：用户/企业功能通过 Cordis plugin rows 和 preset 装配（Tool、Skill、Web、存储、Workspace、Plugin Inventory），而非重新造模型推理循环。
- `.../src/askai-model-gateway-plugin.mjs`、`askai-tool-bridge-plugin.mjs`、`askai-skill-provider.mjs`：模型、工具、Skill 以服务/适配器注入 DSH。Plugin 需要真实的生命周期、版本、载入与事件证明。
- `.../src/code-permission-policy.mjs:1-19`：沙箱 `read-only/workspace-write/danger-full-access` 与审批 `ask/never` **分两轴**；`danger-full-access` 默认 `never` 并不代表“禁止操作”。
- `apps/user-web/src/components/code/CodePermissionPicker.vue`：产品上向用户呈现 `ask/auto/full/custom` 四档，而不是直接展示底层每一个服务开关。
- `services/chat-api/app/governance/approval_runtime.py:25+`：一动作一票（带 actor、expires、roles），独立于 DSH 插件与内核。
- `services/sandbox-manager/app/task_containers.py:48-95`：合成脚本单独容器与有界输出/限并发/可回收；`plugin_runtimes.py:50-145`：每隔离键独立容器/存储、只读 rootfs、降权、cap drop、PID/CPU/RAM 限额、独立内网与 egress proxy。**可借鉴隔离架构，不等于 Win11 原生沙箱已经这样实现。**
- `SANDBOX_CONTAINERS.md`：隔离容器为可选部署档，未启用时沿用旧路径；MCP/Skill 跨边界仍要对工具副作用审计。
- **源码与文档边界不一致（固定 e16174a... 的静态阅读，不代表已复现生产漏洞）**：services/sandbox-egress/proxy.py:20-25 的 _allowed_destination() 对 is_private 返回放行，不是《SANDBOX_CONTAINERS.md》声称的拒绝所有私网；services/sandbox-manager/app/jobs.py:79-97 依赖 HTTP_PROXY，docker_engine.py:108-113 建立的 outbound network 设置 Internal=False，因此不能光靠代理配置宣称已经限制直连出网。docker-compose.yml:232-248 的 deployment-observer 同样挂载了 Docker Socket，文档的“只有 manager 持有 Socket”也不足为真。LOOM 应在隔离环境实测直连/私网/代理绕过，实施最小 Docker Socket 接触面。
- **MCP 与脚本审批要各自证明**：services/chat-api/tests/dsh_runtime/test_mcp_approval_policy.py:7-21 对旧 approvalRequired 标志设置 destructiveHint 仍断言逐次 MCP 审批为 false；services/chat-api/app/execution_isolation/script_approval_policy.py:5-7 将脚本审批交给独立能力策略而非每次弹窗。这不代表没有其他治理，但说明不能因 UI 选择 Ask 就宣称四类工具的所有副作用都获逐次人工许可。
- `README.zh-CN.md`：**MOVO Desktop（本地 Code Agent、浏览器 Agent、终端、Git）是闭源单独分发的产品**，社区仓库不含其源码，因此不能据此声称“已经找到完整的云端操控电脑 B 实现”。

**许可证关键：** MOVO Community License 在其 LICENSE 中明确第三方多租户 SaaS、OEM/白标和 MOVO 前端商标版权三类限制。即使它允许内部商业部署与后端集成，LOOM 将来独立云服务仍应坚持独立原创控制面；如需复用具体 MOVO 代码必须先取得匹配的授权并核对义务。

### DSH 官方的关键事实

- 官方上游 MIT，Cordis “一切皆 Plugin”，通过 `ctx.<service>` 和事件接缝协作；应在稳定服务/Hook 层扩展，而不是改 agent-loop。
- 官方 `permission-presets` 把 **sandbox/mode** 与 **approval/policy** 组合为一次 UI 选择；默认一般为 `workspace-write+ask`，`danger-full-access+never` 是另一组合。
- 官方 `user-approval` 中 **`never` 是“不询问，凡需要升级审批的操作一律拒绝”**，并非“从此所有操作自动执行”。`full` 能绕过原本就无需申请的沙箱限制，两者组合才决定行为。
- DSH Windows ACL 后端公开声明 **`enforcement: partial`**：主要限制写/删，**读取文件范围并未在 Windows 上被强限制**；额外 Windows roots 对 read/write/edit 的生效路径和 PowerShell/shell 也不同。不得把“已经设置 workspace-write”宣传成任意读文件都被隔离。
- Plugin Manager 安装/启用变更可能影响同 Profile 的其他 Session；高信任插件与低信任插件应分 Profile/进程或容器，不能让陌生可执行 Hook 运行在所有 Session 共享的控制进程里。
- 目前 MOVO 固定了一个 DSH 预发行版本；LOOM 必须自有兼容测试/回滚，而不能追 upstream main 自动更新。

## 三、明确选型：**DSH 做内置通用 Harness 首选；Pi 做轻量独立 Worker；Core 继续是产品唯一事实中心**

不要二选一替换现有系统：

| 范围 | 选择 | 理由 |
| --- | --- | --- |
| Agent 如何推理/循环、插件、Skill/MCP/Hook 执行 | **DSH Host（首选内置 Engine / 可选 RuntimePort adapter）** | 与单用户后续云端、插件化/企业治理一致；复用 Cordis、Profile、Session、权限/审批机制 |
| 小范围确定任务、并行工兵、本机 Pi 原生 RPC | **Pi Host/Worker（长期保留）** | 当前已能在本机真实运行 DeepSeek V4.1 Flash / max；简单轻量、会话成熟，用户已有 Pi Skill |
| 现有 Codex 等原生 CLI | **保留独立 NativeRuntimeAdapter** | 不要为了“统一”强制重写原生协议或擅自拷贝 Runtime 的私有配置 |
| 任务/助手/群聊/工作/候选/证据/权限/审批/记忆权威 | **Rust LOOM Core（保持）** | 已有持久 Run/claim、R1/R2/B7、ComputerPort；不能出现 DSH、Pi、Cloud 各一份业务账本 |
| 内置 DSH 插件和 UI 扩展 | **隔离的插件宿主 + LOOM CapabilityPort** | DSH 原生资产可直接在 DSH 中运行；其他端只有明确映射才显示“可用”，不虚构兼容 |

**关键策略：先引入一个锁版本、无默认全局配置继承、独立 userData、可卸载/回滚的 DSH sidecar，实测通过再把它提升为新任务首选。现阶段不能宣称已嵌入或替代现有 Pi。** 内置引擎不自带模型额度或凭据，保持本次仅 DeepSeek V4.1 Flash / max 的实测要求，不自动 fallback。

## 四、云端控制 Windows B：按现有 R1 / R2 / B7 补齐，不造第二个 Device 系统

用户希望云端手机/网页发起工作，自己的 Win11 电脑 B（可能只有 UU/RDP 虚拟显示）实际执行。最合理的是 **云端控制面 + B 端本地受管执行面**：

```text
手机/浏览器 LOOM Web（单 Owner）
            │ HTTPS + 已认证会话
            ▼
Cloud LOOM Core（任务/助手/能力/Grant/Approval/Event/Artifact）
            │ 已配对 Node 的出站 WSS/TLS 信道；命令带 runId, epoch, requestDigest
            ▼
Windows B 的 LOOM Node（本地安装事实、工作根ID、会话/进程/租约）
            ├── RuntimePort：DSH Sidecar（默认候选） / Pi Worker / 原生 Codex
            ├── Tool/WorkspacePort：已准备的项目根、受控读写/命令
            ├── Capability Loader：四类能力的版本化物化/装载回执
            ├── ComputerPort：独立屏幕浏览/人控/Agent控租约（当前用户 Session）
            └── 本地密钥库/文件、可选沙箱隔离
```

- **现有事实不可重复发明**：LOOM `docs/architecture/cross-host-execution.md` 已定义 R1（远端原生进程）、R2（同 Run 跨节点受控工作区工具）、B7（本次选中能力冻结）；`workspace-rpc-v1.md` 已有 bounded List/Read/Run、request 去重、撤销和重连 Unknown 规则。新增云端应补真实 **A↔B E2E** 与设备身份/权限准入，不再另起工作区数据库。
- **Windows B 主动连接云端**，从云端签发有限生命期设备绑定/任务身份；不开放 B 上任意终端或电脑控制的公网监听；Cloud 在设备离线时显示离线，不凭空完成或自动重复写入。
- **路径只由 B 的 Node 校验和解析**，Cloud 存 `nodeId/workspaceId` 和 grant，不把“选择了文件夹”当跨目录操作系统隔离；对于本机可信模式，可允许用户操作所有本来有权的文件，但必须明确显示当前是“可信未隔离”。
- **远端电脑控制不是模型能调用任意 Shell**：屏幕查看、人类接管、模型控制分别授权。模型控制以指定 Assistant/Device/Session 5 分钟租约/撤回/输入栅栏延伸现有 ComputerPort；不与 R1/R2 重复。Service Session 0 无法替代 Win11 实际登录的交互桌面；用户会话/U​​U/RDP 没有活跃桌面时，屏幕类功能应明确 unavailable，不能静默更换屏幕驱动。
- **运行位置两种**：代码/本地文件任务优先把 DSH/Pi Run 放 B；云上知识研究可放 Cloud sandbox，需操作 B 时经 R2 的窄工具，不将 B 全盘挂载云端。
- **安全强度两级**：本机用户信任的 Native 模式偏自由，但不标“严格沙箱”；需要拒绝越界的云/企业任务使用单独低权限账号、文件 ACL、可复查的沙箱可用性/限制，或 Linux 容器/VM 的受限挂载和受控网络。

## 五、用户看到的 “Full / Ask / Never” 不能简单映射成一个 boolean

实际上至少有三条独立维度：

1. **访问范围**（B 上哪些 Workspace 根/文件/外部域名/设备能力）：read、write、terminal、MCP、computer 不同 grant；只由 B 和对应工具的事实执法。
2. **沙箱强度**（谁负责强制文件/进程效果）：`read-only`、`workspace-write`、`danger-full-access`，并给 `full/partial/unavailable` 的真实执行端报告。
3. **升级审批**：`ask` 要等用户允许“一次准确动作”；`never` 自动拒绝所有需要升级批准的动作；自动评审（可选）是另一条明确的决策链，不能代替用户跨目录授权。

LOOM 可以向用户提供三个常用 **预设**：

| 用户界面 | 内部意图（不暴露所有术语） | 执行边界 |
| --- | --- | --- |
| **Never / 不允许越界** | 本次任务不申请扩权；范围之外的访问拒绝 | 对应 `approval=never` + 明确 sandbox/grants；已允许范围内的低风险操作仍可运行 |
| **Ask / 需要时问我（默认）** | 主目录正常工作；访问额外根、高风险工具时一次一问 | `sandbox=workspace-write` + `approval=ask`；每次审批绑定具体 toolArgs digest/expiry |
| **Full / 信任执行** | 用户明确授予可信本机 Run 高权限、在限定范围/时长内减少询问 | 可能对应 DSH `danger-full-access + never`，**会绕过文件沙箱且继承进程的 OS 能力**；不能在未受控云端/B 上无提示地默认开启 |

这里的 `never` 不等于“永远无需询问且允许所有命令”。最重要的是产品应展示 **本次到底是什么范围、哪种沙箱、哪些原生 Runtime 有真实强制、谁批准的**。Windows DSH 仅写限制时，不可把“禁止读取 C”显示为“强隔离通过”。对 Shell、MCP、Hook、子进程的副作用也不能只依赖 UI 和 prompt。

## 六、扩展化：LOOM 统一 **资产和治理**，DSH 原生 Plugin 负责 DSH 的运行

引入轻量 **CapabilityManifest v1**（只是产品契约，不重写 DSH Plugin ABI）：

```text
id, version, sha256, provenance, license, trustLevel
type = skill | mcp | rule | hook | memory-provider | runtime-adapter | ui-extension
scope = user | device | project | assistant | run          （单用户先落地）
targets = [{runtime: dsh|pi|codex, support: native|adapter|unsupported}]
requires = [runtime ABI, dependencies]
grants = [filesystem roots read/write, shell, network, secrets refs, computer view/control]
configSchema, upgradePolicy, healthProbe, activationReceipt
```

插件流程：**发现 → 检查来源和许可证 → 安装(包 digest 固定) → 选择作用域 → 显式启用 → 创建 Run 前冻结 Profile/能力 hash → Runtime 真正加载回执 → 实际使用审计 → 撤销/回滚**。只有 `loaded` 和 `invoked` 可以对用户报“生效”，不能把 `discovered` 显示成“支持”。

- **Skill**：`SKILL.md` + 资源包与依赖；可在 DSH/Pi 映射读取，但不授予更多文件权限。执行型 Skill 的依赖在独立环境准备，包可读写分离。
- **MCP**：Server/Tool ID、授权域、env/credentialRef、cwd/Node、网络端点与运行状态；外部工具可能写远端系统，另外做 tool policy/approval。
- **Rules**：原文、作用域、优先级、版本，由 RuntimePort 编译为“原生支持的上下文注入”，不声称 Rules 是强制安全护栏。
- **Hooks**：映射 `beforeRun / beforeTool / afterTool / afterRun / onApproval` 等 LOOM 语义；真实 Cordis Hook 只在 DSH 的受控插件 Host 生效，Codex/Pi 不支持的事件必须显示 `unsupported`，不能盲目复制 Claude 的原生 Hook 命令执行。
- **Memory**（第五层，不与 Skill 混合）：`conversationEvent`（事实日志）、`memoryItem`（长效摘要/用户授予的记忆）、`knowledgeSource`（RAG 外部资料）独立，按 `user/project/assistant` 作用域、来源、版本和删除/撤回记录管理。由 `MemoryProvider` 在有权的运行前/运行中检索，明确显示引用，不往四端隐秘改写全局记忆文件。
- **插件自己不能无审查升级自己的权限**：Plugin 安装/启用/升级属于 Owner 管理行为，不能因模型可调用一个普通 MCP 就绕过；高风险插件按 Profile 隔离，安装前预览依赖与脚本，升级须验证/可回滚。
- **单用户优先**：一个 Owner / 多设备 / 多项目 / 多助手 / 多能力版本；先不做租户隔离、复杂 RBAC 与商业计费。表和事件标注 `ownerId`，未来需要组织再引入 `organizationId/memberId` 与显式迁移，不在 v1 空造完整企业数据库。

## 七、优先级：四个有验收的阶段，而不是一次大换发动机

1. **本机候选 DSH Sidecar + 插件样板**：不碰现有 Pi/Rust Core；以固定 DSH 发行包、独立数据根启动，接上 RuntimePort。只用 DeepSeek V4.1 Flash/max 做一条只读会话；真实证明 `Skill→load→call`、`MCP→connect→tool`、`Rule→context`、`Hook→pretool deny`，不得改用户全局 DSH settings。保留 Pi 工兵作对照，失败回退应是显式选择，不自动换模型。
2. **单用户能力资产中心 + Policy**：四类资源导入、版本/来源、目标 Runtime 的实际生效/拒绝事实；基本 `Ask/Never/Full` UI、动作级审批审计和回滚；不做多人组织/收费。
3. **云端一人多设备，真实 Windows B E2E**：从现有 Node/R1/R2/B7/ComputerPort 接入设备配对和出站通道，实测离线/重连/撤销/unknown/同 Run 跨根；B 原生沙箱按实际 partial/full 报告，虚拟屏幕有真实用户会话才显示远程桌面。阶段完成后才可叫“云端控制电脑 B”。
4. **企业模式**：组织、成员、资源 RBAC、审计导出、知识 RAG/脱敏、配额、跨域审批与独立部署。按真实多用户需求逐步展开。这里可以借鉴 AgenTeam 的关系约束与 MOVO 的清晰产品边界，但不能复制 MOVO 受限许可代码做第三方多租户 SaaS。

### 最低 E2E 准入证据

- 每个能力必须记录 `discovered / configured / materialized / loaded / invoked / failed`，至少 1 条真实动作和负例，不再用“扫描到文件”宣称生效。
- Policy 行为矩阵：本根读/写、A→B 显式附加根、未授权 C 的拒绝、junction/symlink/UNC、Shell/MCP/Hook 旁路、高权限显式选择、撤销后的真实阻断；完整做不到就标 `partial/unavailable`。
- Runtime：DSH/Pi/Codex 各自独立 `start/stream/steer/approval/cancel/unknown/recover`，跨主机执行绝不依靠猜的 stdout 终态；此前 Codex 原生工具被策略阻断、DSH 临时配置缺凭据是已知实测阻塞，不用新架构文字掩盖。
- 远端：只允许签名/有界请求，B 配对和本机授权，断连不重复未知写入；人工屏幕输入与 Agent 控制独立租约；用户选哪个模型就调用哪个模型，绝不隐式跨供应商回退。

## 八、结论与当前限制

**推荐“LOOM Core（控制面） + 内置可插拔 DSH Host（主 Harness 候选） + Pi Worker（轻量派工、可靠工具） + Native Codex Adapter + Node B（实际 OS/进程/文件/屏幕事实）”**。这条路线最大程度复用现有 Core 和 DSH 官方插件生态，同时避免只为了企业化而自建模型推理循环，且不早早把用户拖进多租户产品复杂度。

**本文件不是「已经封包 DSH」「已经云端遥控 B」「四种能力全端可用」「Windows 强隔离成功」的声明。** 在把候选提升为产品默认之前，必须完成版本锁/安装许可复核、真实一条模型 Run/插件加载及卸载、沙箱拒绝与云端双节点 E2E。尤其保留 MOVO 许可证限制，不直接抄受限代码。

主要官方参考：
- https://github.com/Stonewuu/agenteam
- https://github.com/himovo/movo
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cordis-primer.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/permission-presets.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/approval.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sandbox/sandbox-windows-acl/README.md
- https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/plugin-manager/README.md

Pi 工兵只读报告及本地人工复核范围：`_artifacts/research-agenteam-movo-20261115/{agenteam-governance,agenteam-sandbox,movo-harness,movo-security}.answer.md`；四个工兵均返回 completed；其中两名各有一次 read/grep 工具错误，不能把工兵结论当作运行时验收，关键安全边界已按固定 SHA 的真实代码人工交叉核对。