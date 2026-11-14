---
document_type: protocol-contract
contract: workspace-rpc-v1
authority: workspace-rpc
status: accepted
version: 1
source_version: v1.72
last_updated: 2026-11-05
---

# Workspace RPC v1

本合同定义同一 AgentRun 会话对另一节点已准备工作区的连续 list、read、受控 run。Core A 保留身份、授权和结果账本权威；R2 不迁移父 Run。调用 Runtime 可以在本机或远端，均复用同一个已认证 Built-in Tool 入口。

[Built-in Tool Transport v45](builtin-tool-transport-v45.md)拥有 CLI、IPC、Agent-facing 投影和版本准入。旧一次性 Start、R1 Runtime process pipe、B4 shim 与 R2 是不同协议边界；不能用旧 run credential 自造当前 AgentRun scope。

## 请求、可信 dispatch 与所有者

外部 WorkspaceRequest 的唯一字段为 version、requestId、workspaceId、timeoutMs、operation。所有 DTO 拒绝未知字段。

| 字段 | 类型与约束 |
| --- | --- |
| version | u32，固定 1 |
| requestId | Wire 非空 ASCII 字母数字及 _ . -，最多 128；Builtin 入口由 Core 生成 wrpc_64hex |
| workspaceId | 非空受限标识，最多 128 |
| timeoutMs | u64，1..300000 |
| operation | 闭集 List / Read / Run；不允许任意 RPC 方法 |

CallerScope 只能由已认证 Built-in lease 对应的实际 AgentRun 和当前 Core 数据构造。它包含 runId、attempt、sessionId、memberId、missionId，其中：

- runId 为真实 agent_run.id；attempt 是 checked u32 的真实 execution_epoch，且大于零。它不是 bundle attempt，也不是远端 process epoch。
- sessionId 为真实 conversation.id；memberId 为 conversation.agent_id；camp 来自该 conversation。
- AgentRun 必须处于 running/waiting、execution epoch 匹配、没有 cancel_requested_at；成员在同 camp 中 active 且没有 leave_requested_at。
- 目标 mission_workspace 必须属于同 camp 和 mission、处于 ready、带 preparation token；owner execution_node 未撤销。
- mission、workspace generation、owner node 变化使旧请求操作权限失效。每次 dispatch、poll、cancel、归档发布都按现有权威重验。

Dispatch 固定 request、scope、ownerNodeId、policyRevision、acceptedAtUnixMs、deadlineUnixMs 和 requestDigest。policyRevision 对应持久 workspace generation；deadline 由 A 在首次准入时计算，重试和重连不延长。

管理员 token、Node token、payload 自报身份、任意 cwd 或旧 B4 shim token 都不能作为当前 agent scope。

## B 侧工作区事实与工具政策

Node 的 WorkspaceAuthority 只在真实 PrepareWorktree 成功后记录 workspaceId、canonical source、worktree、common-dir 和相关 OS identity。PrepareWorktree request ID 使用持久 workspace ID。旧工作区必须同 ID 幂等重新证明真实 prepare 后才能获得本地准入；不得 reset/delete 旧工作树解决冲突。

authority.admit 在使用时重验固定事实。不允许从 Open.cwd、Dispatch.path、WS 重连或另一个路径字符串注册工作区。事实 revision 与 Core 授权 policy revision 分开，WS generation 不是 workspace generation。

已认证 Core Dispatch 提供本次 scope 与授权政策；Node 只从准备事实与本机固定 ToolRegistry 构造 WorkspacePolicy。当前工具为 git.status，使用本机探测的 native Git executable、固定 argv、空外部 args、最小环境和受准入的 executable 内容/OS identity。Git 工作树路径显式固定，不能由仓库 core.worktree 或较深 cwd 将检查转向别处。缺少 native Git 时拒绝 run，list/read 仍可用。

工作区 cwd 约束不是操作系统沙箱。固定 Git argv 仍可能触发仓库原生配置中的 clean filter 等内部 helper，因而不能声称 git.status 对任意仓库绝不会创建子进程；这些实际后代必须受同一原生进程树边界控制。允许该固定工具不等于禁止 Git 的内部 helper，也不增加 wire 上任意程序、环境变量、外部 credential 或 shell 权限。隔离验收可用明确标注的仓内 filter 证明 active 取消，不能将其当成生产新增工具。

## 操作与字节边界

| 操作 | 输入 | 结果 |
| --- | --- | --- |
| list | 相对 path，可空表示根；limit 1..200 | entries{name,kind=file/directory}，truncated |
| read | 非空相对 path；offset u64；maxBytes 1..1048576 | base64 data、相同 offset、truncated |
| run | toolId；有界 args；相对 cwd，可空 | 有序 stdout/stderr 事件、exitCode、outputBytes、omittedBytes |

相对路径使用 /；拒绝绝对路径、盘符/UNC、反斜线、空组件、. / .. 组件和 NUL。Node 在已准备根下重新解析并核对链接边界，不信任 A 提供绝对 root。

Wire 上 args 最多 128 项，每项最多 8192 bytes，总计最多 32768 bytes；当前 Builtin git.status 政策将外部 args 限为零项。每个 Output chunk 最多 16384 raw bytes，stdout/stderr 合计保留最多 1048576 bytes；省略量必须产生 OutputTruncated，不能静默丢弃。base64 是 wire/journal 的无损字节格式，Agent-facing UTF-8 投影由 Transport v45 定义。

单次 read 是一次有界读取的实际字节。offset 分片之间没有稳定文件版本或 snapshot 保证；不能拼接多次 read 后宣称原子文件快照。

## 持久准入、幂等与状态

Core 使用 migration 230 的三个表：workspace_rpc_requests、workspace_rpc_events、workspace_rpc_audit。schema_matches 比较 SQLite 实际解析的列、约束和索引，不接受只有同名表的弱 schema。

requestId 全局唯一并绑定完整原 scope、request digest、workspace、owner 和政策。相同内容的重复请求只返回原状态；不同内容冲突，外来 owner 不能读取。Core 在发送前使用 IMMEDIATE transaction 持久化并再次检查当前授权；Node 在任何 spawn 前先持久化本地去重记录。

Core 状态为 queued、dispatched、running、cancelRequested、completed、failed、cancelled、unknown。unknown 保留执行资格已占用的事实；可接收同一次执行的迟到确定终态，不能自动重新 spawn。输出缓存或 replay buffer 淘汰不能删除幂等身份。

Core 每 Run 最多 32 个未决请求、每 Node 最多 128 个未决请求；每请求最多保留 512 个事件并预留终态位置。Node 账本也有独立容量上限，满时拒绝新请求而不是忘记旧执行。

accepted/running 与 completed 必须来自实际 Node 事件。A/B 重启、断线、提交成功但回执丢失、spawn 是否成功不明、取消未确认，均不得推导成功或安全未执行。

## 流、重连、取消与 fence

WorkspaceEvent 包含 version、requestId、runId、attempt、ownerNodeId、requestDigest、seq 和 body。body 的 discriminator 为 kind，允许 accepted、output、outputTruncated、completed、failed、cancelled、unknown。

Core 验证认证 Node、当前连接 generation、完整请求关联和连续 seq。相同 seq 仅允许相同 canonical hash；旧 socket generation、跳号、冲突和错误 owner 全部拒绝。Hub 在队列容量等待之外取得 permit，然后在锁内重验连接代次并发送，避免检查与发送跨代。

连接 generation 可因 Hub 进程重启重新从 1 开始；只有当前已认证连接事实允许 journal 重新绑定。恢复入口只产生 Replay 和保留的 Cancel 控制，绝不产生 Dispatch。从未标记发送的 queued 请求不经恢复路径发出。原 request、digest、scope 与 deadline 保持不变。

Cancel/Replay 绑定 version、requestId、runId、attempt 和 requestDigest；Replay 另含 afterSeq，Cancel 另含 user/deadline cause。cancel 精确作用一个请求；取消父 Runtime、结束 Run 或授权失效时，维护入口发出对应请求取消。Node 只有在原生进程边界确认停止后才给 cancelled；断线或回执缺失仍保留 cancelRequested/unknown。

Windows run 使用真实原子 Job admission 和进程树边界。leader 退出不代表树空。其他平台同样必须有真实平台验收后才能声称支持该平台 run；源码可编译或 Windows 结果不能代替 Linux/Darwin 原生验收。

## Core 实际字节归档

归档接收 Core 明确传入的 trusted data_dir，不能从 payload、B 的绝对路径或 Database 文件父目录猜测授权。

满足以下条件才产生归档：

- read 已完成，单次 offset=0、truncated=false、实际 bytes 不超过 1 MiB；
- run 已完成，stdout/stderr 按 seq 重建，各自归档实际保留的字节，总保留量不超过 1 MiB。原输出有省略时，receipt.truncated=true。

每个 WorkspaceArchiveReceipt 字段：

| 字段 | 合同 |
| --- | --- |
| version | 固定 1 |
| archiveId | Core 生成的 wrpc_archive_ 加 64 位小写十六进制摘要 |
| requestId | 同一原请求 |
| kind | read / stdout / stderr |
| sha256 | A 从实际接收字节计算的 64 位小写十六进制 SHA-256 |
| sizeBytes | 实际保留字节数，0..1048576 |
| truncated | read 必为 false；run 表示原始总输出曾被截断 |

文件仅位于 data_dir/workspace-rpc-archives/v1 的私有 storage，名字来自 Core 派生 ID。使用私有权限准入、同目录临时写入、持久化、禁止覆盖的发布和重新打开后的 hash/size 复核。已有内容损坏时拒绝，不静默修复成成功。重复 poll 必须重新验证实际文件。

receipt 保存在原 workspace_rpc_requests 行的 archive_receipts_json，默认 []；最多两个。VerifiedArchiveSet 只能由实际文件步骤构造；发布时在 IMMEDIATE transaction 内重新校验原 scope、完整事件摘要与期望旧 receipt，执行 CAS。落盘失败不能写成功 receipt。崩溃后未登记的相同内容可验证后幂等登记，不重跑 Node 命令。

该 receipt 本身是 R2 结果归档凭据，不自动等于 loom_artifact 或任务 evidence。接入 LOOM 的 adapter 必须另行绑定真实任务/Run/claim 和持久 archive locator，并通过受控 archive bytes 入口验证 A 上实际内容；禁止调用本地 artifact_register 去读取形同 B 路径的 A 文件。

## 诊断、状态投影与验收

审计只保存关联标识、摘要、状态、授权决定和字节/截断计数；raw argv、文件正文、环境变量和凭据不进入普通日志。授权的 journal/replay 与私有 archive 才保存结果内容。

五个 Builtin 操作共享有界状态投影，最多 256 个事件一页。deliveryError 是闭集投递故障码，不改变原状态，不制造终态。poll/cancel 请求 ID 必须符合 wrpc_64hex；既有真实 owner 验证仍是读取的权威。

本合同是必须满足的语义，技术接受不等于人工治理字段或端到端验收完成。模块 owner、实际生产 crate 编译、真实 native helper 与 A+B 正反角色业务分别记证据。最低实际闭环为同一真实 AgentRun 连续 list/read/git.status、请求重试不重跑、owner/node/旧 socket 拒绝、取消与原文件字节归档；只能使用真实 Core enqueue/claim/lease，不得用测试伪 owner 宣称通过。当前进度见[实施与验收](../loom/workspace-rpc-v1-implementation-2026-11-04.md)。
