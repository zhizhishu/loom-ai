---
document_type: architecture
authority: cross-host-execution
last_updated: 2026-11-05
---

# 跨主机执行

本架构说明一个 Core 控制其他节点执行、以及同一 AgentRun 调用其他节点工作区的职责边界。A/B 是本次控制与执行角色，不固定为云端或某一操作系统；交换角色时仍须各自完成身份、版本、权限和平台准入。字段、错误、幂等及输出边界由 [Workspace RPC v1](../contracts/workspace-rpc-v1.md)、[Built-in Tool Transport v45](../contracts/builtin-tool-transport-v45.md)和[受管进程合同](../contracts/managed-runtime-process-v2.md)拥有。

## Core 保留唯一业务权威

Core 拥有成员/Thread/Mission、AgentRun/claim、工作区授权、所选能力、Runtime lease、任务和证据关系。Node 提供真实安装目录、可执行文件身份、prepare 事实、原生进程及其 I/O，不拥有另一套成员、任务或执行决策数据库。

真实消息经既有 DeliveryQueue 和 Run 创建链入队。Run 创建事务必须同时冻结本次 execution target、成员选择 revision、工作区 generation/token，以及本次能力 source；不能先创建本机 Run 再异步改变目标。已有 Run 的 target/source 不能被当前成员设置覆盖；新 Run 才读取新选择。取 Run/claim/lease 之后继续重验当前权限、取消和 membership 状态，不把冻结快照当永久授权。

Node catalog 中的 installation identity 绑定实际 executable 内容与 OS file identity，真实启动再次核验。WS connection generation、workspace generation、Run execution epoch、native process epoch 和 bundle attempt 是不同轴，不能互相替代。远端 process key 是明确的 node/process/epoch 身份，不能伪装为 A 的本机 PID 或 Windows Job。

## 三条相互独立的执行关系

| 关系 | 负责的工作 | 权威和生命周期 |
| --- | --- | --- |
| R1：远端 Runtime | Core 选定远端安装和工作区，复用既有 native driver，通过 raw process pipe 交付原生 stdin/stdout/stderr | Core 管真实 Run/lease；Node 管实际原生进程树。driver仍解析原生协议，不新增另一个 agent 思考循环 |
| R2：逐工具工作区调用 | 当前 agent在同一推理循环连续 list/read/受控run；父Run保留原执行位置 | 当前 Built-in身份→Core授权/journal→Node prepared事实/固定工具→同一caller结果。不是整Run迁移 |
| B7：所选能力交付 | 将本Run已选 Skill、MCP、规则和hooks实际源内容固定并按原生Runtime物化 | Core原有目录/绑定仍是选取真源，bundle是不可变执行证据，不是新能力库 |

R2必须用独立的 A 本地真实 agent会话证明“调用 B 而父Run不迁移”。R1 中的 B 远端 agent调用同一个 workspace CLI 只能证明组合调用入口，不能替代该验收。

Native driver保留原生Session、工具事件、Steer和结束语义。raw pipe只替换进程运输边界，不把stdout文本猜成成功，不用Node的另一个wrapper重新实现原生会话。单次Start/B4 shim保持其原边界，不能冒充持续原生Session或新的真实Run授权。

## 本机事实、私有路径和字节

B的工作区必须经真实PrepareWorktree成功登记，并在使用时重验source/worktree/common-dir及OS身份。caller cwd、路径字符串或WS重连不能建立授权。旧工作树可同ID幂等重新证明，冲突不能靠reset/delete用户内容解决。

A/B各自的绝对路径只对所属主机有意义。远端安装、worktree、run_tmp和归档路径必须带明确所属关系；路径文本相同不等于同一个文件。MCP cwd只按已实现的原生映射准入，不能把A绝对目录原样当B目录。

R2的完整单次read和有界run保留输出通过实际字节返回A。A独立计算hash、在明确trusted data_dir下使用私有storage持久化，再将receipt CAS写入原请求行。部分offset读取不构成文件snapshot，Node自报hash不替代A字节校验。任务证据必须通过显式archive locator绑定原任务/Run/claim，并读取A的实际归档复核；不能调用本机artifact_register去打开形似B路径的A文件。

当前R2上限为单次1MiB。16MiB头像、任意Run tmp文件、远端send.files/avatarFile不因此获得透明跨机文件能力。没有实现并验证的方向必须明确拒绝，不能静默回退到另一主机读同名路径。

## 能力独立选择与原生边界

Skill、MCP、规则和hooks各自可选，互不推断为依赖；未选择的可选项不进入该Run的bundle。现有Bootstrap所需的平台Skill是原有固定依赖，必须与可选工具箱项明确区分。规则需实际进入既有additive instruction；Skill使用真实源文件，MCP不能用脱敏预览配置替代可执行配置。

bundle复用原Bootstrap renderer，不创造新模型可见section；只对已定义的skill-index root做受控B侧定位。每个Run冻结内容，重试不重新读取当前目录。既有原生全局/受管配置仍由原生Runtime拥有；成员取消选择不会自动删除那些独立配置。

当前Claude支持已验证的原生instructions/MCP/hooks参数；Codex instructions/MCP可交付，选中hooks仍在缺乏原生定义信任注册时明确拒绝，不能添加信任绕过参数。带凭据的MCP/env/header和未实现路径映射继续受明确准入限制，不借“远程控制”扩大秘密运输或权限。

B7模型上下文变更、技术复核与人工确认事实保留在[原变更记录](../versions/v1.72/model-context-change-loom-run-bundle.md)。当前会话授权持续实施，不等于用户已另行阅读该文件；confirmed_*未获真实依据时保持原值。

## Unknown、控制链和进程树

传输断开不等于原生进程退出，leader退出不等于树空，缺少取消回执不等于已停止。Core与Node分别在发送/spawn前持久保留身份；未确认执行结果保持unknown，不自动重新运行。重连只恢复已有process/request的运输和重放，不能用新Start或新request遮盖旧未知状态。

Core对当前Run/lease的取消、撤销和membership失效产生明确控制；Node只对其持有的真实process boundary确认终态。Windows使用原子Job admission和实际树清理，远端key不暴露伪本机Job/PID。Linux/Darwin必须有对应原生证据后才能声称平台支持；Windows结果不能覆盖它们。

R2的连接代数检查必须与实际发送/接受事件保持同一fence。过期socket不得更新当前请求或退掉新连接；当前认证连接可在Hub重启后重建新的连接代数，但不能改变原Run、scope、deadline或request identity。

## 当前实现与验证边界

已落盘的实现包括真实Run目标/source冻结、R1 typed remote process/raw pipe、B7不可变bundle、R2可信Core入口和Node工作区执行器、私有字节归档及有界CLI。它们使用同一Core、同一现有native driver和独立Node，而不是模拟owner的替代执行器。CodexHost的专用长寿命远端路径正在本轮统一接线，不能以Claude路径代证。

当前Windows进程边界、B7原生CLI投递、R2协议/journal/private-storage owner和Node生产crate check已有分项证据。全体当前Core/Web/native helper构建、真实A+B的正反角色业务、A本地同Run R2、active取消、断线恢复与最终产物链仍需各自实际结果；模块PASS不等于已部署或整体E通过。Linux/Darwin原生矩阵、完整ACP Client FS/Terminal和未实现文件方向均不扩张声明。

理由见 [V1.72-D68](../versions/v1.72/decisions.md#v1-72-d68)，实施记录见[LOOM集成交接](../loom/integration-handoff-2026-11-04.md)与[R2实施证据](../loom/workspace-rpc-v1-implementation-2026-11-04.md)。这些记录与人工治理门禁分别记账，不通过改写确认字段来消除实际未满足项。
