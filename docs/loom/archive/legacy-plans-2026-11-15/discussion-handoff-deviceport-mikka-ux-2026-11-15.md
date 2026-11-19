# LOOM 方案讨论交接：Mikka 右侧头像工作台 + 云端直接控制电脑 B（2026-11-15）

> **状态：用户仍在思考/讨论方案，未批准本轮实现。** 本文是用户三张截图及 2026-11-15 纠偏的**待决提案**，不取代 `DESIGN.md`、当前 Architecture/Contracts 或已验收事实；不意味着 UI、品牌图、云端、远程图形控制已实现。本轮仅经 AgentDock 只读查看真实本机源码和项目资料，未启动 Agent Runtime、浏览器测试或修改生产配置。

## 0. 用户的明确纠偏（下轮不得遗漏）

1. **右侧工作空间**：截图二红色标出的“工作空间”标题和“工作 / 资产 / 流程 / 电脑”标签整体下移约右侧面板高度的 1/3；上方约 1/3 留给**当前对话的头像/群头像**，视觉上有活力，眼睛随鼠标移动。面板已能拉宽/放大，设计须兼顾 1440/窄屏与无实体屏幕/RDP/UU。
2. **Logo**：用户图片三（粉发、绿眼、黑色猫耳与黄色耳内装饰的二次元形象）是**页面左上角品牌标志及浏览器标签页 favicon 的指定视觉原型**；不要沿用当前“编织机器人”作为最终标志。原图深色背景应抠掉，优先交付真正透明 alpha、无白边的素材；在白底/暗底分别预览。若用户所说“白色底层”指白底导出，可额外生成白底版本，但不应以白色底图代替透明底。大图的眼睛随鼠标缓动，favicon 本身只能静态（浏览器标签页无法读取页面鼠标位置）。原图当前仅见于本轮聊天附件 **第 3 张**，尚未导入 Windows 项目；不能声称已生成或保存。
3. **多借 Mikka 的产品思路**，尤其“对话主助手/Bot 派发、右侧任务/电脑、需要人处理的事情、结果和验收”，而不是只抄外观。
4. **核心架构纠偏**：之前“云端 LOOM → 电脑 B 的 DSH Host/Pi/Codex”图过窄。电脑 B 应该**可以仅运行一个 Device Agent/Node（像 MindFS 的远程工作站、AgentDock 的电脑操作工具），即使 B 不装 DSH/Pi/Codex，也能让云端 Agent 远程操作 B 的文件、终端、浏览器、屏幕和授权的本地服务**。运行模型的地点与被操作设备的地点必须分开。
5. **本轮继续讨论、研究并交接**，不要趁机改 UI、模型配置、远端服务或强行选定唯一引擎。AgentDock 是当前授权的本机研究/操作入口；后续实施仍应从 AgentDock 读取实际工作树和隔离运行身份。

## 1. 真实源码与来源核对

本次本机只读快照：Mikka `137334b1dd89a668db65f7eecda588d2582e7b88`；MindFS `965d90f77b2f190a4f0689d0828bb2e92e62c229`。这不是公开仓库当前最新版本声明；后续更新或实施必须重新核对来源和代码变动。

| 来源 | 本机具体证据 | 可借鉴、不能误认 |
| --- | --- | --- |
| **LOOM 当前 UI** | `apps/desktop/src/renderer/src/loom-native/Inspector.tsx:89-111`：当前是顶端小标题、紧跟四标签、下面滚动内容；`Avatar.tsx` 使用已有 `MemberAvatar`，当前 `LoomMark` 是小机器人；`native.css` / `product.css` 负责布局与材料。 | 可在原 `loom-native` 树上加身份 Hero 和下移标签；**不要恢复旧 Rovai 壳**。不要改变右侧 Tab 与 Core 数据 owner。 |
| **LOOM 已有眼睛动效** | `apps/desktop/src/renderer/src/OpenBotAvatar.tsx:83-183`：`followPointer`、`mountAvatar`、`reducedMotion`、`useAvatarMotionEnabled` 已存在；`MemberAvatar.tsx` 复用该组件。 | 已有矢量 Bot 头像可随鼠标；**图片三是静态位图，不能把其 JPG 直接当可变眼睛矢量**。要保留原眼型/高光并独立提取瞳孔层，或者对品牌图做单独的分层动画，不要破坏原角色画风。 |
| **Mikka 产品定义** | `_references/mikka/docs/design/glossary.md`：Bot（对话/派工）与 Agent（真正执行）分离；右侧概览顶部是当前 Bot 头像/名字，下面显示其任务/电脑。`components/nav/context-panel.tsx` 与 `bot-overview.tsx` 组织视图。 | LOOM 的“主助手”应被看成协调者身份而不是权限超管；工作归任务，线程/Run 是执行过程。UI 不应把工作标题当助手身份。Mikka 官方 UI 有私有 overlay，公开源码**不能保证复刻最终像素**。 |
| **Mikka 派工/恢复** | `_references/mikka/lib/coordinator/wake.ts`、`lib/factory/questions/store.ts`、`lib/factory/automatic-dispatch.ts`；旧只读报告 `_artifacts/mikka-study/answer-m2-coord.md`。 | 事件收件箱、唤醒租约、问题卡与原 Session 续跑、独立审查/用户验收。需核查当前 main 与旧报告的差异；**不要复制另一套 Mikka DB/Factory 到 LOOM**。 |
| **Mikka 设备与屏幕** | `_references/mikka/packages/daemon/src/device-gateway.ts`：WebSocket ping/pong 与 work signal；`packages/daemon/src/computer/broker.mjs:40-52`：每 Run 的 computer token grant；`computer/proxy.mjs`：模型侧 request-only MCP；`computer/driver.mjs`：截图、点击、文字、键、滚轮等有限工具；`docs/design/cloud-computer-backend.md`：云端 E2B 电脑与本地设备分离。 | **设备通道、电脑工具、Agent Runtime 是三个不同层**。Mikka 的 `lib/computer/permission.ts:1-10` 把 absent/legacy ask 读为 allow，不能直接照抄到 LOOM 的默认 Ask/Never。云 E2B 机器不是用户 Windows B。 |
| **MindFS 远程工作站** | `_references/mindfs/README.zh.md`；`server/internal/relay/wsconn.go`、`relay/services.go`（仅允许 localhost/127.0.0.1/::1 作为本地服务转发目标）、`commandexec/runner.go`（本地 shell/PTY 进程）、`fs/registry.go`、`agent/pool.go`。 | 一个本地 Go 服务可提供文件、Shell、项目、Agent 会话和 Relay 远程入口；**访问本机文件和终端不需要 B 同时启动 DSH/Pi/Codex**，但通过 MindFS 发起“Agent 聊天”仍需相应 Agent CLI。MindFS 的 Relay 不等于已验证的通用桌面自动化/任意 MCP 宿主。 |
| **AgentDock 当前实际工具** | 本次通过 AgentDock `agentdock_context`/`workspace_context`、`exec_command`、`read_file`、`file_edit`、`task_manage` 等直接读写 Windows 项目。当前 `dynamic_mcp=[]`，不能宣称已经连接浏览器 MCP。 | ChatGPT 侧的授权 AgentDock 能控制 Windows 的命令、文件和任务，**本质是 Device Tool Provider，而不是一个 Agent 推理 Runtime**。但这份 connector 权限**不会自动继承到 LOOM Cloud**，需要用户另行授权的 DeviceBridge 或专用适配器，不能偷用 ChatGPT 会话 token。 |
| **DSH/MOVO/AgenTeam** | `docs/loom/engine-plugin-cloud-study-2026-11-15.md`；MOVO 固定 DSH Cordis 插件 Host；AgenTeam Java 企业治理。 | DSH 是 Harness，MOVO 企业层和插件治理；AgenTeam 组织/审批。**两者都不是用户 Win11 电脑 B 的现成通用控制驱动**。MOVO Community License、Mikka/MindFS AGPL 和 Mikka 私有 UI 限制具体代码复用。 |

## 2. 修正的三轴架构（讨论提案，优先级高于前次图示）

**此前误区：把“电脑 B 是任务执行地点”直接等同于“电脑 B 必须启动 DSH/Pi/Codex”。** 这不是必要条件。需要区分：

- **Brain / RuntimePort：** 谁负责模型推理、Agent 循环、上下文、Skill/Hook/MCP 生命周期？可以在云端、A、B 运行 DSH、Pi 或 Codex 等。
- **Hands / DevicePort：** 谁真正接触操作系统、文件、Shell、浏览器、窗口、进程和设备？电脑 B 可以只装一个受管 **LOOM Device Node**，不运行模型。
- **Control / Core：** 谁决定人、任务、审批、设备范围、资源 Grant、证据、审查和验收？仍由现有 LOOM Rust Core 唯一拥有。

~~~text
           手机 / 网页 / Desktop：LOOM UI
                         │
                 LOOM Core（唯一事实）
       任务 / 会话 / 能力 / 设备 / Grant / 审计
                         │
         ┌───────────────┴────────────────┐
         ▼                                ▼
    Brain / RuntimePort            Device / CapabilityPort
    云端或 A 或 B 的                 电脑 B 的受管 Node
    DSH / Pi / Codex                （可完全没有模型）
         │                                │
         │          Tool RPC             ├─ Files/Workspace
         └───────────────►────────────────┤─ Shell/Process
                                          ├─ Browser（本机受控 CDP）
                                          ├─ Computer（屏幕/输入/人工接管）
                                          ├─ Local Services（白名单端口）
                                          └─ MCP/Apps（可选，单独授权）
~~~

三种**正交的工作模式**：

1. **云端脑 + B 端手（新增重点）**：云端 DSH/Pi 等调用 B 上的文件/命令/浏览器/电脑工具，B 只需要 LOOM Device Node。适合手机交代工作、B 上有独有桌面软件或资料、希望不在 B 安装所有 Runtime 的场景。代价是屏幕图片/文件片段可能流向云模型、工具调用有往返延迟；必须显式告知用户。
2. **B 端脑 + B 端手（现有 R1 延伸）**：模型 CLI 和工具都在 B，云端只派任务/看进度。适合本地订阅凭据、超大仓库、频繁工具调用和低延迟任务；不是云端控制 B 的唯一模式。
3. **云端协调者 + B 端工兵 + B 端直接工具（混合）**：聊天协调者可直接让 B 做一个窄操作，也可派给 B 的 DSH/Pi/Codex 长任务。两种动作共享 Core 的授权与审计，但不共享“默认所有工具可用”。

**与现有合同的关系：** 保留 `docs/architecture/cross-host-execution.md` 的 R1（远端 Runtime）、R2（跨节点工作区工具）、B7（四类能力冻结），以及 `docs/loom/ultimate-interface-contracts.md` 的 ComputerPort。**R2 当前合同只允许有界 List/Read/固定 git.status；它不是已经支持任意 Shell/GUI 的通用远程工具总线。** 下一阶段如做 DevicePort v1，应该扩展受管 Node 的 Capability Provider 与独立工具家族合同/审计，而非悄悄把 R2 Run 改成无限制命令执行，也不新增第二套任务数据库。

### DevicePort 候选模块（只是接口建议）

- `DeviceRegistry/Pairing`：设备身份、用户本地批准、OS/显示/工具能力声明、出站加密连接、健康状态和重连代次。
- `FilePort`：只对已授权 root 做 list/read/write/move；B 侧真实路径解析，防止 symlink/junction/UNC/ADS 逃逸；跨根授权与文件写入单独批准。
- `TerminalPort`：受管命令与长 Shell 两个层级；严格区分固定命令/项目工作区与可信完整 Shell。进程树取消、输出限额、未知结果不重复执行。
- `BrowserPort`：受管浏览器 Profile、CDP 观察/点击/表单、登录交接；本地浏览器认证不自动泄露给云模型。
- `ComputerPort`：当前已存在的看屏、人工控制、助手控制三层租约；扩展到 B 必须保持屏幕会话、输入 owner、generation、seq、撤销栅栏；无交互桌面就标 unavailable。
- `LocalServicePort`：明确白名单的 B 端服务转发，需端口/来源/路径授权；不是开放任意内网代理。
- `McpPort/CapabilityLoader`：按本次 Run 的能力 manifest 在**有真实支持的节点/Runtime** 装载；不能因为云端有 DSH Plugin 就宣称 B 的原生 Hook/Skill 也可用。

### 安全与权限

**Full/Ask/Never 不能作为“某个进程的布尔开关”。** 要同时记录 `tool family + deviceId + root/service/desktop scope + action digest + sandbox enforcement + approval behavior + TTL + actor + runId`。

- **Never**：不申请额外权限；当前 Grant 外的操作拒绝，不意味着本根只读也不可做。
- **Ask**：默认，额外目录、外写、屏幕输入、受控服务、敏感操作产生准确动作审批；缺审批回执 fail closed。电脑 B 本地需要醒目显示“此设备正在被 LOOM 操作”与一键撤销。
- **Full**：可信个人设备上经用户明确选定、受设备 OS 账户实际权限约束的较宽访问；不是默认、不是多租户通用、不是云模型可永久控制 B。Windows 现有 DSH sandbox 只标 partial，不得宣传强读隔离。

**重要：Mikka 当前 `lib/computer/permission.ts` 对旧 ask/未设置策略默认 allow，属于 Mikka 自己的产品选择，LOOM 不照抄。** MindFS 远程 Relay 和 AgentDock 的本机高权限工具也不能等同于已经通过 LOOM 的用户批准。低风险操作可一次 Run 预授有限范围，敏感副作用逐动作批准；别把全部工具都加一次无差别云端往返。

## 3. UI 方案：右侧“有生命的身份 Hero + 工作台”（用户待确认）

**不要在这轮实施**。将现有 Inspector 的最上方布局改为三个明确区域：

~~~text
┌──────────────────────────────┐
│                         ⤢ ×  │  ← 现有关闭/展开/搜索等动作保留
│                              │
│      [当前助手的大头像]       │  ← 上方约 1/3，眼睛柔和追随鼠标
│          Hanzi               │
│      主助手 · 在线/忙碌       │  ← 状态必须来自 Core/Node，不伪造
│                              │
├──────────────────────────────┤
│ 工作空间       +   🔍         │
│ [工作] [资产] [流程] [电脑]   │  ← 整体下移，Tab 在 Hero 下
├──────────────────────────────┤
│ 本次对话  ▾       筛选 ▾     │
│                              │
│      实际工作/成果/流程       │  ← 只有这一块滚动
│                              │
└──────────────────────────────┘
~~~

- **选中对话决定 Hero 身份**，与 Mikka “右栏头像是 Bot，不是线程”一致。单聊用当前助手头像；群聊用主助手为主、其他成员小头像环绕/叠放，不能让头像变化改 Core 主助手身份或权限。左侧会话行的用户自选头像不被品牌图覆盖。
- **几何建议（未决定）**：常规高屏上 Hero 约右栏可见高度的 28–33%，例如 `clamp(168px, 30dvh, 300px)`；窗高较小时缩为紧凑模式，避免内容区仅剩几行。四 Tab 在 Hero 下，Tab 可 sticky，列表独立滚动；放大右栏时 Hero 横向增大但高度不无限膨胀。保持既有可拖动分栏宽度和响应式压缩。
- **交互**：鼠标进入面板时瞳孔缓动，约 ±4–8px 的微位移，requestAnimationFrame 节流、离开回正；尊重 `prefers-reduced-motion` 和现有头像动画开关，触屏/低电量静态；眼睛动不影响点击/焦点/Tab、不会因为鼠标移动触发 Core 读请求。
- **Brand vs Assistant**：左上角和 favicon 用图片三的 LOOM 品牌图；右侧 Hero 优先展示该对话真实助手头像（若用户给它设了图片三，可以使用同一资产），而不是把所有助手替换成同一个角色。无选中对话时可用 LOOM 品牌图占位。
- **资产制作分阶段**：先保留原图及许可证/使用权信息→抠掉深色背景、发丝/耳朵抗锯齿→透明 RGBA 主图 + 白/深底检视→favicon 专用小图（16/32/48/64，不做动画）→可动画眼部（眼白/瞳孔/高光分层、遮罩）→鼠标缓动/动效降级测试。单张扁平 JPG 无法天然保留遮挡关系，需要实际分层/修复，而非简单 CSS 整图移动。
- **测试门槛**：至少 1605/1440/1040/760/390 宽、短窗高、深浅色、DPR2、RDP/UU 虚拟屏幕、鼠标/键盘、触屏/reduced-motion、Hero 空/单/群/加载失败、四 Tab 切换与右栏放大、实际 Core 会话与工作上下文保持。

## 4. 对前次 DSH 结论的精确修正

前次 `engine-plugin-cloud-study-2026-11-15.md` 中“DSH 做首选内置 Harness、Pi 做轻量工兵、Core 做唯一事实中心”**作为引擎候选仍可讨论**；但**不能推出“B 必须有 DSH Host 才能控制 B”**。

更合适的阶段结论：

> **LOOM Core 是唯一协调与治理中心；RuntimePort 决定谁思考；DevicePort 决定谁动手。DSH、Pi、Codex 只是可插拔的 Brain/Worker，电脑 B 只需一个 Device Node 就可以被有权的云端 Agent 操作。**

这一调整并不要求把现有 R1/R2/B7 全部重写。先用现有 Node + ComputerPort 的窄工具证明“**云端脑 → B 端手，B 不启动本地 Agent Runtime**”，再讨论 DSH 是否应该成为默认内置引擎。DSH 与 Pi 选型需要从真实插件加载、工具转发、内存、费用、稳定性、故障恢复实测，而不是因为 MOVO 选择 DSH 就立刻跟随。

## 5. 单用户优先的下一轮决策与验收

1. **先定信息架构和交互原型（仅在用户批准后）**：确认右侧 1/3 Hero、头像身份、品牌图裁切/动效规则，保持 Mikka 式“聊天中协调、右侧做事/等待你”。
2. **再定 DevicePort v1 契约（需正式设计/合同审查）**：单 Owner、一台 Windows B、出站设备配对、三类最小动作 `file.read` / `terminal.fixed` / `computer.view`，B 不装 DSH/Pi/Codex；在云端受管 Brain 中实际调用 B。每种操作都有 deny/ask/expiry/撤销负例。
3. **扩展浏览器/人工接管与外写**：本机 CDP/桌面会话、浏览器登录人工交接、准确审批和撤销；不能直接用现有 R2 的 git.status 合同冒充完整工具。
4. **四能力与记忆**：按 Brain 位置与 Tool 位置分别 materialize；Memory/Rules 属于 Core/Runtime 上下文，MCP/Hook/Skill 的执行位置需声明；“已保存”不等于“已装载”。
5. **然后单用户 A+B/云端多设备，再企业**：用户设备配对/断连恢复/一键撤销/数据位置可见；真实需求出现后才增加组织/成员/RBAC/多租户。Mikka、MindFS、MOVO 许可已统一为 MIT，**架构、交互与业务代码都可复用**。

### 交接状态与禁止越界

- **本轮已做**：AgentDock 读取 LOOM 当前源码、Mikka 的术语/设备/云电脑/电脑工具源码、MindFS 的 Relay/Shell/文件代码与 README；记录截图需求和核心架构纠偏。
- **本轮未做**：未抠图、未将图片三复制到 Windows、未生成 favicon、未写 UI、未启动模型/服务、未验收 B 云端控制；未把本提案晋升为当前 Architecture/Contract。
- **下轮优先入口**：`TASK.md` → 本文 → `DESIGN.md` → `docs/loom/ultimate-interface-contracts.md` → `docs/architecture/cross-host-execution.md` → `docs/contracts/workspace-rpc-v1.md` → `docs/loom/engine-plugin-cloud-study-2026-11-15.md`。开始实施前用 AgentDock `workspace_context` 与 `git status` 重新读取，不能覆盖原有未提交 WIP；如需图片三原始像素，应从聊天附件或用户授权提供的本机原图取得，不能凭空生成/替换。

