---
document_type: implementation-plan
authority: implementation-evidence
last_updated: 2026-11-04
---

# LOOM 持续会话：受管进程管道 v1

状态：用户已授权持续实现；主管完成源代码技术审查。当前为实现中的运输层工作包，未把新文件存在记为接线或端到端通过。

## 复用与权威

A 继续使用 Rovai 现有 Claude、Codex、ACP driver、RuntimeFleet、NativeSession、Input ACK、权限和 AgentRun 终态。B 只拥有受管子进程、标准输入/输出、有界重放和进程树清理；不安装第二套 Core/产品 SQLite，不新造另一套 agent 协议。

已有 seam：Core `managed_process.rs` 的 stdio/wait/termination，`claude.rs` 的 stream-json，`codex.rs` 的 app-server，`acp.rs` 的 boxed stdio；Core 新 `remote_process.rs` 承载 typed RemoteProcessLauncher。Windows 原子 Job 与私有存储复用新 `rovai-process-boundary` / `rovai-private-storage` 小 crate。

本工作包不增加模型 Bootstrap 段、不重写模型输入、不放宽 native permission。选择资产仍归 B7/B8 冻结运行包；R1 真实 AgentRun/claim/task 绑定归 Core；R2 单工具请求保持独立。

## 身份和启动

- RemoteProcessKey = nodeId + processId + processEpoch，与 AgentRunOwner = agentRunId + executionEpoch 分离。
- member、logical session、workspace、controller generation 固定；可复用 native Host 的新 Run 输入携带新的真实 AgentRunOwner。
- 只有 A 的可信 Core launch seam 可构造 Open。公共请求不得给 executable、环境全集、owner 或物理 root。
- B 对照本机 CLI、批准的工作区和冻结 bundle 验证；A 的本机 executable/cwd 存在性不能冒充 B 的准入。
- 不复制 A 的 inherited environment。Node 只在本机环境上合并明确允许的非秘密运行选项；真实凭据不进 bundle 或公开日志。
- 原生参数与文件必须投影到 B 的真实私有材料；不能把 A 的临时文件绝对路径传给 B。B7/B8 materializer 保留唯一所有权直到进程树真正结束。

## 输入、输出和恢复

Open 在 spawn 前写私有 durable launch 记录；同 key/digest 的活进程返回同一进程，不再启动。已存在但结果未知的 tombstone 拒绝自动重启，换 epoch 也不隐式绕过旧未清理进程。

stdin 独立单调 inputSeq，requestId 与完整输入摘要绑定。原始字节不解释、不添换行。写前持久记录 prepared，写入并 flush 后记录 written；若进程/节点崩溃发生在两者之间，结果是 unknown，不能重发。queued 和 pipe-written 都不是 native accepted；只有 A 原 driver 识别的原生 ACK 能确认输入被接受。

stdout/stderr、输出错误和Exited使用独立eventSeq；InputWritten、OwnerBound、Terminated、State、Released是控制回执，不占输出窗口。每块原始输出至多16KiB，未ACK窗口至多64帧/1MiB，A持久保存后ACK；断线期间原进程继续，缓冲满时施加背压。重复输出只重放同一seq，不产生第二次业务结果。控制输入至多64KiB一块，队列至多16项。

初始Open保存owner和Core当前lease导出的builtin_tasks_enabled，bindingSeq=0。相同owner及相同能力的初始幂等确认由Hub完成，不发BindOwner(seq=0)。改变owner或能力都必须在已确认的stdin边界推进bindingSeq；无owner时任务能力必须为false。新flag进入durable ledger、OwnerBound和State，不从UI或旧Run推断。

同一 A 实例的网络恢复保留 driver、process key 和原生会话。A 或 B 进程重启后，不能只凭 stdout 重放宣称原生控制状态恢复；必须走既有 accepted-input recovery 或保守 unknown，不自动重投可能被接受的内容。

## 取消

遵守 Cancellation Settlement v2：业务cancelled与Runtime cleanup证据分别记录。远端leader退出不是进程树停止证明。Node对精确key/epoch发起有界终止，只有共享边界证实tree empty后，Terminated回执的treeStopped才为true；断线或超时只返回未确认，不伪造本机Job/PID或cleanup ACK。满输出窗口不能阻塞这条停止回执。

Release与停止分开。正常Release要求leader/tree均结束、终态已形成且所有输出ACK；显式abandon_output必须先持久记录“不完整输出已放弃”，才释放输出窗口和actor。缺失ACK不能永久占满32个live process槽，不能把放弃输出伪装成完整收集。

用户 steer、普通续聊、interrupt 沿用 A 的既有 native driver。B 不把普通文本拼到一次性 exec 的 stdin，不把重启一个新 agent 冒充持续控制。

## 节点本机内建CLI

B复用现有rovai可执行程序的参数解析、输出和重试，不复制CLI parser，不链接Core数据库。Node从本地配置或同目录选择helper并核对contract-v45/ipc-v3与强程序身份；缺helper不得宣告process-pipe可用。Shared rovai-local-ipc提供与Core相同的Windows私有named pipe/Unix socket语义。probe4产出的旧helper实际为v44，仅保留原版本证据，不能用它宣称v45接通。

每个受管进程获得B私有context/run-tmp和Node-only process/lease凭据。请求经本机凭据验证后换成RemoteProcessKey+真实AgentRunOwner+bindingSeq，经已认证节点通道传给A；A重新解析自己的当前lease。Core凭据不跨wire。owner或tasks能力变化会原子写新context、轮换lease token并关闭旧pending调用，旧调用不会变成后继Run的请求。

当前BuiltinToolIpcRequestBody仅有Invoke，request_id使用既有snake_case。sendInputFilePath是调用者提供的展示字段，不证明Node验证过该路径，Core远端入口清空它，不能授予打开A文件的权限。pending至多16项、frame至多1MiB；同ID不同body拒绝，网络未知关闭本机连接，让原CLI重试同一request ID。真正业务去重仍属于Core既有journal，Node不建第二个业务调度器。

每个本机pending存活批次有独立dispatch UUID，并携带已验证的摘要；它们只供本机relay判断是否发送，不改变wire上的业务幂等键。同ID/body在完成、unknown或超时后重建pending时必须再次送Core journal，即使relay没有观察到中间空状态；并发重复waiter仍共享一个批次。发布前按binding→pending锁序重新核对owner/seq/lease，防止认证后绑定已变却重新插入旧请求。

绑定只有精确OwnerBound才能轮换本机lease，Refused原样返回。同步失败先关闭该进程的本机admission并清除pending，然后有界停止；关闭admission不是tree-empty回执，不删除仍由actor持有的材料和私有目录。

实际媒体合同审计：builtin结果为普通JSON，没有通用大结果文件DTO。member.get头像是已知A run_tmp文件出口，远端当前返回unavailable/path:null/displayCrop:null；非空send.files及member.create/update.avatarFile明确返回remote_file_transfer_required。这些是当前受限能力，不能把A路径当B可用文件。R2完整小文件及有界输出另接Core私有归档和同一journal行的receipt，不以offset分段Read冒充稳定大文件快照。

## 已执行的部件证据

- _artifacts/pipe-owner/round5/result.json：真实Node管道6项PASS，1个受控子进程入口helper按设计ignored；协议/bundle10项PASS，SHA前后一致。含replay_open、同owner仅能力变化、持久回执、满窗口Stop和无ACK显式Release。
- _artifacts/builtin-owner/round5/result.json：两个真实Windows IPC owner PASS、0 ignored、19.407秒、SHA前后一致。覆盖凭据替换/轮换、身份与body冲突、有界pending/报文、同ID完成/unknown后重新派发批次、认证后绑定轮换竞态、admission fence不冒充树清理及guard释放后零派发。当前context为contract45；不包含实际rovai可执行程序的seam验证。
- target/loom-integration-20261104-evidence/ipc_native_owner_after_extract.json：共享IPC正式crate Windows owner由整合主管报告1项PASS；Unix cfg未运行，Linux仍待原生独立主机或CI。

这些部件结果不等于A+B业务R1/R2/持续会话已通过。新接线按源码冻结后的联合编译和实际进程证据继续验收。

## 所有权与最小验证

- root：新 `loom-protocol/src/process_pipe.rs` 和 `loom-node/src/process_pipe.rs`；协议闭集、private journal、去重、有序写与控制。
- R1 监督线：Core remote process trait、真实 task/claim/AgentRun/host 冻结、原 native driver 接线；migration231预留，230属R2。
- B7/B8 监督线：现有 bundle 与共享 Web/Node seam，稳定后协调注册新 wire。
- R2 监督线：共享进程树边界，Windows原生验证后补Linux；R2工具协议保持独立。

新协议 owner 只覆盖封闭 schema、跨身份/epoch、payload/数量/摘要边界；Node owner 覆盖写前故障、重复/冲突、重启unknown、输出ACK和树取消。真实 A+B 隔离fixture验证同一native会话连续输入/steer/中断/重连，不能用fixture parser或仅单个CLI进程替代。

文档接线时同步当前 Contract/Architecture；按通用门禁执行，不新增功能专用豁免。
