# LOOM 完整工作空间：接口与兼容边界

> 用户已批准的产品目标：一个以 Mikka 体验为中心、内置 Pi Agent、连接本机与云端执行环境的多 Agent 工作空间。用户只需要创建助手、选择能力、组建群聊并提出目标；系统负责协作、执行、电脑控制、成果追踪和人工验收。
>
> 本文件固定接口职责，不把接口存在当作功能已发布。各阶段的运行证据、失败和剩余项由 [实施计划](../../ultimate-workspace-plan.md) 与根 `TASK.md` 记录。不得再把「电脑」「流程图」「资产图」排除出产品目标。

## 1. 一套产品，两种运行位置，一个事实核心

桌面和浏览器共享 `loom-native` 产品组件与 typed services；会话、任务、Run、成员关系、能力选择、审批和不可变成果仍由现有 Rust Core 唯一管理。Pi 模型循环和外部 CLI 不获得另一个 LOOM 任务数据库。执行位置与执行引擎正交：一个助手选择一个 Runtime，再选择具备该 Runtime 的本机/远端 Node 与工作区。

分为三个接口边界：

- **产品服务**：Assistant、Room、Work、Artifact、Capability；现有 Core 版本化命令、CAS 与 commandId 去重继续拥有写入。
- **Host 服务**：原生配置发现、屏幕订阅/输入、助手电脑授权；必须使用当前 Host 的认证与 origin/Host 边界，不允许浏览器直接访问任意进程/文件。
- **Runtime / Node**：进程生命周期、协议协商、能力载入、真实输出。原生账号仍在选择的执行位置，不能把本机路径或凭据自动解释成远端可用。

## 2. RuntimePort 与四端准入

产品 Runtime 类型仅为 Claude Code、Codex CLI、DSH、Pi；Pi 同一类型可来自系统安装或 LOOM 内置受管包，来源不同，不创造第五种助手身份。

| 行为 | 权威 | 失败语义 |
|---|---|---|
| discover | Host/Node 的安装与路径探测 | 发现程序不代表登录/模型可用 |
| inspect/probe | 运行端声明与真实协议握手 | unsupported / unavailable / auth-required 分开，不自动换运行端 |
| configure | 助手版本化配置与执行环境 | 不改主机全局默认，不在读取时保存 |
| start | Core 冻结的工作区、能力、模型与权限 | 未满足准入就不派发；不重新抽取正在运行任务的配置 |
| update/stream | 原生协议标准化为现有事件 | accepted 不等于 completed；中断不伪装成功 |
| permission | 原生 optionId、范围、版本 | 没有持久选项就不伪造“始终允许” |
| cancel/recover | 已持有 Run/attempt 身份的 Core | 不重放结果未知的外部工具作用；恢复保留原冻结输入 |
| shutdown | 受管进程组与回收回执 | timeout / unconfirmed 不能标为空进程树 |

实际入口包括 `assistant-service.ts`、`runtime-setup-service.ts`、`execution-service.ts`、Core Runtime catalog 与各原生适配器。

### 内置 Pi

- `scripts/package-embedded-pi.mjs` 从明确给定的本机固定版本安装生成 Node + Pi 完整依赖闭包 + 原生 launcher + 许可与 SHA-256 清单。
- 保留包的物理嵌套依赖布局，不能只按包名去重不同版本。
- manifest 必须显式覆盖 launcher、Node、entry；不接受未登记代码文件、逃逸路径或用户配置。
- `loom-pi-launcher` 非 informational 模式要求独立的 Pi config 根；不静默继承用户日常 Pi Home。
- Core 的嵌入包发现与验证只认精确 manifest/文件，不下载、不安装、不借用任意全局 Node。
- 内置引擎不代表自带模型额度或账号。模型供应商、认证和费用必须在 UI 明示。

## 3. ACP 扩展不是把四端强改成一种协议

LOOM 的产品接口应与传输独立。新增通用 ACP Runtime 时实现同一产品生命周期，但必须协商并记录对方实际协议版本和能力，不得通过 UI 的“ACP”标签猜测支持。

当前源码 `crates/rovai-core/src/acp.rs` 发送 protocolVersion=1，并只接受版本1；这不能被文档写成已经支持 ACP v2。原生 Claude/Codex/DSH/Pi 的已有路径继续使用适合它们的协议。后续 v2 适配要单独实现生命周期差异和回归，不能仅改版本数字。

必须覆盖：initialize/能力协商、认证方法、session/new、按能力支持的恢复、prompt/事件更新、权限请求/取消、终态与连接断开。未声明的能力保持 unsupported；原生未知事件保留诊断，不能推导成完成。

官方依据（2026-11-14 核查，精确实现仍由锁定依赖和实测决定）：
- [ACP v1 overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx)
- [ACP initialization/version negotiation](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/initialization.mdx)
- [ACP v2 lifecycle migration](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v2/migration.mdx)

ACCP 参考项目的正式名称是 **Agent Collaboration Control Plane**（本地参考 README 已核），不是四个交付原则词的缩写。LOOM借鉴其任务、确定上下文、证据和人工验收的控制面设计；ACP（Agent Client Protocol）则是另一项 Agent 通信协议。本页不宣称已兼容 ACCP 服务端 API。

## 4. 能力发现、勾选和生效

`NativeCatalogPort` 只读发现当前 Host 允许的客户端与项目根：运行端、Skills、MCP、Rules、Hooks。目录、配置文件、作用域与来源摘要均要保留。用户对一个候选执行导入时，必须携带 sourceId、expectedDigest 和目标配置版本，后端重读验证内容一致。

四类能力不能有同一个生效含义：

| 类别 | 用户动作 | 运行语义 |
|---|---|---|
| Skill | 检查/导入/分配 | 资源与方法，受管不可变版本；不等于增加电脑权限 |
| MCP | 发现/添加/启用/分配 | 真正连接与工具目录；配置中的秘密不得通过预览、错误或 argv 泄漏 |
| Rules | 审阅/选择 | 项目与助手指引；不是 OS 沙箱，不能冒充强制权限 |
| Hooks | 审阅正文/范围后启用 | 原生生命周期行为；格式/事件/信任必须逐端适配 |

四种事实必须明确显示：已发现、已保存、下一 Run 配置、实际载入/调用。任何缺凭据、端不支持或加载失败都应显示原因，不能伪造成已生效。

Pi MCP 采用受管显式扩展：只装载 Core 冻结的选定服务器，stdio 和 Streamable HTTP 都受超时、大小与取消约束；重定向不得带凭据跨源。MCP 文档及扩展摘要进入 warm-host 兼容身份，防止另一组选择误用旧进程。无 MCP 选择保留原兼容结构。

## 5. RoomPort / WorkPort

普通群聊创建不启动模型。单聊/群聊可以先有成员再配置运行端；一个有效主助手必须属于当前名册。加成员用 membershipGeneration，换主助手用 thread.version，权限独立。

“共同完成工作”是独立、可理解的产品动作：名称、目标、成员、主助手、工作区。`missions.create` 创建可追踪工作后，读取 `missions.get` 核对对应身份。只有用户勾选“创建后开始执行”才发送 `missions.start`；它不是额外发一条重复的聊天消息。

模糊创建结果保留原 commandId 和草稿并锁定修改；已创建但开始失败保留同一 mission/thread 和 start commandId，可先打开工作，不重新创建副本。创建、开始、代理运行完成、用户接受、发布仍然是不同状态。

## 6. 流程图与资产图

流程图来自真实 Task、dependencies、claim/dispatch/Run、审查与阻塞。资产图来自 Artifact、Candidate.previousCandidateId、evidenceIds、对应审查和用户决定。不能从时间靠近猜版本血缘，不能从模型一句“完成”改业务状态。

节点点击回到对应真实工作/文件/版本，选择与聊天上下文保持。未来图编辑只是一种用户输入方式：所有写入走相同 Core 命令、版本和权限，不在前端另存一套可变流程。

## 7. ComputerPort：查看、人类控制、助手控制三层权限

### 用户看屏 / 手动接管

当前 Host 端路由：`computer/status`、`view`、`frame`、`control`、`control/heartbeat`、`control/release`、`input`、`view/stop`。进入页面只检查能力，不自动截图。用户显式允许后返回本次 view；输入需另一个有效 control lease。

Host 绑定 session、device、generation、seq、deadman 和总TTL。输入串行、过期拒绝、未知结果不重放。退出页面、隐藏、退出登录或主动归还停止发送，Host 再独立执行租约到期；前端按钮状态不能代替 Host 拒绝。

`resources/computer/host_desktop.py` 是封闭 stdin JSON 接口：Windows GDI/SendInput 或 Linux X11/XTest。只有截图、点击/移动、滚轮、明确按键、受限文本和释放；不接受任意命令、文件、URL、剪贴板或脚本。

### 助手操作

这是另一个授权，不因用户自己看屏就授予模型。

- 用户经 `computer/agents/grant` 选择 assistantId、deviceId、view/control、精确 MCP configDigest，确认后最长5分钟。
- Host 为该助手创建并绑定临时电脑 MCP，私有 token 仅从私有文件进入桥进程；UI/argv/公共定义没有 token 值。
- 模型只有 screenshot/mouse_click/key/text/wheel 五个工具，不能绕到浏览器的通用认证接口。
- 私有 RPC `/api/v1/computer-agent/rpc` 使用独立窄 token；不是持有 token 就能调用全部 Core。
- 每次调用重新验证会话、授权、设备、有效期、唯一请求ID；截图完成后再次核对权限，退出后不交付像素。
- 撤销需要证明物理输入栅栏，并关闭/清理对应临时MCP；清理未确认就显示 unconfirmed，不假报成功。
- 目前只接当前 Host 的本地执行目标；远端电脑必须另做 Node/Computer provider 身份传输，不能把云端 loopback 指向本机。

UI 必须提醒：桌面截图可能发送到所选模型；授权不自动启动任务、不修改永久工具权限。

## 8. 本机 / 云端与发布边界

Node 负责本机事实：实际可用 Runtime、准备好的工作区、设备身份、屏幕能力。中心只路由已配对节点，不扫描任意远端目录、不自动把日常凭据上传云端。无图形桌面的 Linux 节点仍可执行 CLI，但不能假装有电脑画面。

新 Core 发布必须有新旧二进制身份、独立数据根、启动配置、数据兼容、回滚和真实页面/API证据。优先侧向发布新的受控实例，保留正在使用且环境未完全确定的旧实例；不为“切新版”猜 HOME 或强杀用户会话。

## 9. 证明清单

- 架构/API 单测只是第一层；Windows/Linux 构建是第二层；真实 Host 请求是第三层；真实原生 Agent/电脑输入是第四层；正式发布另计。
- 封包必须运行包内 Node/launcher 的版本与 get_state，不能只验证目录。
- 电脑要在自有测试窗口证明截图、点击、文字与撤回，不能在用户未知焦点盲输。
- MCP要真实 stdio/HTTP握手、调用、取消、拒绝重定向；不能用只检查函数存在的测试代替。
- 一条完整工作还需真实多Agent派工→独立审查→返工→可打开成果→测试用户接受，没跑到就不标完整体验完成。
