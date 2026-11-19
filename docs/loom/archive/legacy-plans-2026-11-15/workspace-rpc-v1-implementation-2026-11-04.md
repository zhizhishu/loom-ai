---
document_type: implementation-plan
authority: implementation-evidence
last_updated: 2026-11-05
---

# R2 Workspace RPC v1：实施与验收

状态：2026-11-05 R2 protocol、Node executor/authority/wire、Core journal/可信入口/CLI、Web child 已落并注册；实际 Node 生产库 check 已通过，当前 Core 及 Agent-facing CLI 全链 gate 正由 Core owner 执行。模块 S 已有证据，真实 A+B 同一 AgentRun 闭环仍待主 harness，不能标完成。当前字段规范为 [Workspace RPC v1](../../../contracts/workspace-rpc-v1.md) 与 [Transport v45](../../../contracts/builtin-tool-transport-v45.md)。本文保存工作包实施和验收事实，不代填人工治理确认。

## 范围与已核实的基线

R2 使 A 上同一个 agent 会话连续调用 B 的工作区 list、read、run。模型和父 Run 留在 A，结果回到同一会话。R1 的整次 Run 派发保持独立；远端 agent 的 steer/续聊/中断/恢复（L-D07）是独立 session-control 工作包。

真实入口：

- [现有节点 wire](../../../../crates/loom-protocol/src/lib.rs)：ClientMessage 的 Exit / AlreadyRunning、ServerMessage 的 Start；不存在可直接充当 R2 的通用 RPC。
- [现有文件边界](../../../../crates/loom-protocol/src/workspace.rs)：list_directory/read_file/resolve_inside；R2 在复用前增加严格相对路径校验，根内绝对路径也拒绝。
- [Hub](../../../../crates/rovai-web/src/nodes.rs)：已认证节点连接、代次、B6 文件等待者、per-run shim；现有 shim 只允许 loom status。
- [NodeStore](../../../../crates/rovai-core/src/execution_node.rs)：workspace owner 和 run credential；run_grant 当前只返回 member/mission/usable，不能宣称已含完整 Run/Session 身份。
- [节点执行](../../../../crates/loom-node/src/session.rs)：现有 ChildGroup 只在 Unix 群杀，不能证明 Windows 子孙进程清理。

B7/B8 持有 lib.rs、session.rs、nodes.rs、execution_node.rs 和 migration 229。R2 先新增独立模块；共享 seam 释放后才注册。migration 230 预留，必须检查当时真实数据库版本后注册。

## 身份与授权

外部 RequestV1 只有 version、requestId、workspaceId、timeoutMs 和闭集 operation。不得携带 member、mission、run、session、node、root、任意 executable 或 env；所有结构拒绝未知字段。

可信 CallerScope 从共用 Built-in Tool lease 已认证的真实 AgentRun / execution_epoch 及 Core 数据中解析：runId、attempt、sessionId、memberId、missionId。旧 B4 per-run shim credential 不能构造它。管理员 token、node token 不能作为 agent credential；已撤销或已结束 attempt 拒绝。缺失权威关联时拒绝，不能由请求补齐。

A 从 WorkspaceRecord 解析 owner node 和工作区政策；请求者权限与工作区归属匹配后才构造 DispatchV1。工作区 id、owner node、policy revision、scope 和 request digest 被固定。B 的执行器接收独立的已批准本地 WorkspacePolicy（root、允许操作、toolId 到程序的映射），不能从一条请求自建授权。请求中的 target node / policy revision 与本地批准记录不符时拒绝。

run 采用 toolId + 有界 argv + relativeCwd。程序路径来自已批准政策，没有 shell command 或任意 RPC 方法入口；未配置工具拒绝。工作目录约束不是操作系统沙箱。可执行程序的权限必须以对应工具授权为准，不能把 cwd 声称为完整文件访问隔离。

## v1 字段与上限

| 项 | 合同 |
| --- | --- |
| version | 固定 1，不支持的版本在 dispatch 前拒绝 |
| requestId | 非空、最长 128，ASCII 字母数字及 _ . - |
| workspace / identity id | 非空、最长 128，同样的封闭字符集 |
| timeoutMs | 1..300000；A 建立 acceptedAtUnixMs + timeoutMs 的绝对 deadline |
| list | path 为相对路径；limit 1..200 |
| read | 非空相对 path、offset、maxBytes 1..1048576 |
| run | toolId、最多 128 个 argv、单项至多 8192 bytes、总 argv 至多 32768 bytes、相对 cwd |
| relative path | 统一 / 分隔；拒绝绝对、盘符/UNC、反斜线、空组件、. / .. 组件、NUL；空串仅 list root 和 run cwd |
| output | stdout/stderr 共享 seq；单 chunk 至多 16384 raw bytes；每请求总 raw output 至多 1048576 bytes，截断明确可见 |
| pending | 每 owner node / caller Run 有固定上限；满时拒绝，不无限排队 |

字段值不能进入普通诊断日志。参数摘要使用确定性的 serde 结构序列化和 SHA-256。摘要包含请求的完整规范参数与可信身份，重试不改变 deadline。

## 幂等、流与状态

requestId 全局唯一，绑定 caller scope、workspace/owner、policy revision 和 request digest。相同 id + 相同内容返回现状/结果；相同 id + 不同内容冲突。另一个主体不能以相同 id 读取原结果。去重记录的寿命独立于输出缓存，输出清除不恢复执行资格。

Core request journal 在发送前事务持久化。节点 request journal 在任何 spawn 之前以 create-new/atomic durable write 持久化。不能确认 spawn 或退出时结果为 unknown，重试不得再起进程。

Core 状态：queued → dispatched → running / cancelRequested → completed / failed / cancelled / unknown；accepted 是 Node 事件，deadline 是取消 cause，不另造 timedOut 状态。发往 B 后连接中断、A/B 重启、取消回执缺失均不能推导 success 或安全未执行。unknown 保留证据和请求身份，可接收同一执行的迟到确定终态，但不会自动派新 attempt。

事件包含 requestId、runId、attempt、owner node、request digest、seq 和闭集 body：accepted、output、outputTruncated、completed、failed、cancelled、unknown。输出 ACK/fromSeq 可重放；重复 seq 只接受相同内容，跳号/冲突/错误 owner/旧代次拒绝。R2 完成不产生 R1 Run Exit。

cancel 精确作用于一个 request。Core 记 cancelRequested 并发往该 owner；没有 B 已停止的确认只保留未决/unknown。deadline 由 A 固定，节点重连、客户端重试或输出重放都不得延长。已确认退出与取消竞争只生成一个终态。

## Windows 与进程边界

必须拥有真实 Windows Job/process-tree 控制，取消和 deadline 清理子孙进程，并保持 stdout/stderr 有界。允许薄提取仓库已有进程管理实现，但不把整个 Core 引入 loom-node。未完成这一边界的节点必须对 run fail closed，list/read 可继续；总交付仍须完成 Windows run，不能以 fail closed 宣称 R2 完成。

## 审计与敏感数据

审计只保存 scope、workspace/node/request/seq、授权决策、操作种类、参数摘要、状态、输出长度及截断计数。不得保存 token、Authorization、环境变量、原始文件正文或 raw argv。工具结果与输出在私有、授权的结果存储中可重放；普通日志和公开报告只含白名单元数据。

## 文件所有权与阶段

| 阶段 | 文件 / 责任 |
| --- | --- |
| R2-1 | 新 crates/loom-protocol/src/workspace_rpc.rs：v1 types、closed schema、validation、digest、唯一 protocol test owners |
| R2-2 | 新 crates/rovai-core/src/workspace_rpc.rs：durable request journal、scope admission、状态/幂等/取消/重放 |
| R2-3 | 新 crates/loom-node/src/workspace_rpc.rs：本地批准政策、path/command admission、持久去重、bounded stream、执行取消 |
| 接线 | shared lib.rs / Hub / session read loop / CLI / Core scope / migration230，等待 B7/B8 释放后协调 |
| 当前规范 | 生产接线时新增字段级 Contract，更新相应 Architecture / CURRENT 导航；运行通用 docs 门禁 |

独立模块未注册前用 _artifacts 下的临时 compile harness 检查源模块；这只是 S。注册后必须再次构建真实 crate 和定向回归。

## 测试归属与证据

遵守 [Rust 测试准入](../../../development/testing.md#新增独立测试)。不按测试数量定义完成。

| owner | 独立失败语义与最低成本验证 |
| --- | --- |
| protocol | 未知字段/版本、跨平台相对路径、边界与规范 digest；纯 Rust 表驱动，无 Runtime/DB |
| Core journal | 幂等冲突、跨主体读取、事务持久化、重启 unknown、cancel/terminal race、事件顺序；隔离 SQLite |
| node execution | path/symlink、政策、node mismatch、持久 dedup、输出上限、deadline和树取消；隔离临时目录/受控子进程 |
| 实际 A+B seam | 同一 A provider session 连续 list→read→run，实际 B side effect；错误 token/owner/node/越根/离线无副作用，断线/replay不重复执行 |
| R1 回归 | 现有 Start/输出/B6 文件流程，不能替代 R2 验收 |

S（模块 owner）、H（真实宿主/节点）与 E（真实 Core 业务链、真实 Run/native CLI 及 A+B）分开记账。E 可使用明确标注的本地确定性模型 provider；是否连接外部模型、是否跨物理机器/操作系统另行记录，不能由逻辑双 Node 验收推定。所有临时文件仅放相应项目 _artifacts，日常 App、凭据、配置、数据库、会话保持隔离。

## 进度

- 2026-11-04：主管批准独立模块方案；基线代码与路径已核实。
- 2026-11-04 小批 R2-1：Pi 有界文件工兵完成协议，主管逐段复核并纠正 epoch=0 的错误测试预期；独立 offline cargo 4 个表驱动 owner 全通过。生产文件已落 `crates/loom-protocol/src/workspace_rpc.rs`，共享 lib 接线待 B7 释放。证据 `_artifacts/process-check/initial-results.json` 第一项。
- 2026-11-04 小批 Windows 进程边界：新 `rovai-process-boundary` 薄提取现有原子 Job admission / private DACL / CRT 参数，不改原 Core owner。冻结 8 文件哈希 `_artifacts/process-check/frozen-sources.json`；同一源 Windows native 5 PASS（另 1 个 ignored 仅供子进程测试入口），`frozen-windows-results.json`。实际父进程先退出时仍观察到活孙进程，随后 Job 归零并核对独立进程句柄退出；另测 stdio、显式环境、Drop 清理。
- Linux/Darwin 源已接入薄 backend 与 Linux 两个 native owner，但尚未原生运行，不能标 PASS。没有把进程组/被观察到的 pidfd 后代宣称为 OS 沙箱；Linux/Darwin PID 重用、脱离进程组与 Drop 风险已另派只读 Pi 审查。R2 Node 执行器与 Core journal 仍在实现，尚无 A+B 闭环通过声明。


## Native supervision checkpoint: Core journal and process identity

Core crates/rovai-core/src/workspace_rpc.rs is now the independently corrected Pi draft. Five owner tests pass, including a real two-connection SQLite admission race (40 requests, exactly 32 admitted and 8 Busy). Permission-revoked retries, zero connection generation, unsent forged events, and cancellation/cap retention for Unknown are covered. All read/modify/write decisions use one IMMEDIATE transaction. Evidence: _artifacts/core-rpc-check/regression-results.json; source hash and Pi timeout/supervisor verdict: _artifacts/q/supervisor-verdict.json. This is a module-level native proof; Hub and agent tool integration are not yet accepted.

The process boundary now publishes inspect_application_identity and ProcessSpec::application_identity_digest, hashing executable bytes plus OS file identity under the same Windows non-write/non-delete lock rechecked by spawn. Six Windows owner tests passed (_artifacts/process-check/identity-native-results.json). Linux leader observation has subsequently been changed to waitid(WNOWAIT) so a zombie retains the PID/PGID lease until the group is empty; the additional Linux lease assertion has not yet run natively. WSL is prohibited by the source Windows rule, so no WSL build was performed. Darwin remains untested natively; Apple XNU documents parent unique identity surviving reparenting, so a review suggestion assuming immediate loss of that identity was not adopted.

## 2026-11-05 集成检查点

### 已验证小批

- 四端线另行收口：38/38同一source index H、原DSH GUI reason-only Stop H、配置清理及三个生成器检查。DSH standby精确同步Mindkit11+Pi2，保留五项旧Pi WIP；总证据在skill-cli四端handoff，不把它作为LOOM验收。
- Node真实生产 cargo check --offline -p loom-node --lib exit0，包含R2 with_authority、共享进程边界及session。全Node unit suite曾因Core devdependency编译阻断，不能标全量PASS。
- 固定git.status Windows owner 1 PASS：未prepare拒绝、实际prepare后可执行、额外argv拒绝、core.worktree重定向被固定根阻止。证据 _artifacts/node-rpc-check/fixed-git-results.json。
- Core journal六个owner包含当前认证generation从5重新绑定1、旧socket拒绝、新连接恢复、固定deadline及queued不恢复派发，见 _artifacts/core-rpc-check/reconnect-results.json。
- 完整bytes归档加入尚未交付migration230同一request row，archive_receipts_json默认[]；未改日常用户DB。_artifacts/core-rpc-check/archive-results-round1.json 10 PASS（原6+归档4），使用实际production protocol/journal/private-storage。
- 新增受控archive读取API后仅复跑受影响的4个owner，_artifacts/core-rpc-check/archive-read-api-results.json 4 PASS，进程5.797s、测试0.49s、无warning。包含真实bytes/hash/CAS幂等、scope隔离、损坏和落盘失败拒绝、partial read无完整快照、run流顺序/截断、schema缺列/伪造receipt以及../archive_id负例；不把重跑4项与10项相加充数。

### 当前实际接线

Core authority使用agent_run→conversation→camp_member→mission_workspace→execution_node，attempt checked映射真实execution_epoch。Node with_authority按真实prepared事实与本机固定ToolRegistry准入，executor跨WS存续。Web child使用weak-Hub transport、代数原子发送与connected/disconnected/event/rejection/expire，恢复只Replay/Cancel。

Core application/workspace_rpc.rs复用已认证Builtin入口，父router由Core supervisor持有。DB mutex不跨transport或文件await。CLI的workspace list/read/run/poll/cancel共5项完整注册，catalog共41；Transport/CLI45、capabilityv45、Output15，IPC3/Envelope2不变。初始UUID替代call_id参与Run/epoch派生；poll/cancel严格wrpc_64hex。kind统一；控制投递失败返回deliveryError和真实状态。Execution Evidence只记标识/计数，不记raw路径/argv/text/data。

内部 workspace_rpc_read_archive(auth,workspace_id,relative_path,original_call_id) 返回typed (WorkspaceDispatch,WorkspaceArchiveReceipt)，真实完整read且实际归档后才返回，不parse公开JSON恢复权威。workspace_rpc::read_archived_result_bytes(trusted_data_dir,dispatch,receipt) 通过private storage读取<=1MiB并独立复验hash/size；trusted data_dir必须显式传入，不猜DB父目录。LOOM任务产物adapter由Core owner接线，不能用A本机artifact_register读形同B路径的文件。

### 冻结、接口与剩余验收

最终15项源码hash在 _artifacts/core-rpc-check/integration-final-sources.json。journal=78095f72ca4d60129c785495d6a7cfc5c328fba3da3539f2c137fc7d852d6865；archive=ec66d56a7bacc6f46d57007d57b5382fe90e5764e78b33baf95415a500e1976b。任何后续解冻须另记，不将旧测试覆盖新代码。

Core实际gate需覆盖workspace_rpc owners、catalog completeness、全操作golden、CLI UUID和exacthelp；新增v16 golden保留旧v15。Node verify_helper/context必须45，旧44成功binary只作旧版本证据。

真实业务只使用loom supervisor的 _artifacts/windows-e2e/e2e.py 主harness与本线r2_cases.py。先真实embedded配置/member/Mission/prepare/ExecutionTarget/PublicThread DeliveryQueue形成Run/lease，再让真实Native agent通过执行工具调用ROVAI_AGENT_CLI；不造fake Run/lease、不读token模拟成功。正反角色、连续list/read/git.status、owner/node/旧代数拒绝、断线无重跑、取消和A实际bytes归档仍需真实结果。

R2 receipt不是已注册LOOM artifact替身；remote loom.evidence须另接真实任务/claim、持久archive locator与A实际hash复验。16MiB头像及跨host用户文件输入不是R2<=1MiB合同，未实现部分明确拒绝。

Linux/Darwin本轮仍无原生验收，未用WSL。公共文档路由与通用门禁由root协调；历史v1.72r2三项人工字段未满足继续保留，技术审查和当前实施授权不伪装成人工治理确认。

## 2026-11-05 有界控制探针准备

统一产品 Host/Node/rovai 45 构建已由主 E owner 收回 exit0 / 422.969s，并核对 407 项源码 SHA 稳定。该事实仅为构建通过；首次真实 Mission E 正在由主 harness 执行，R2 未提前标为端到端 PASS。

主动取消/重连 owner 为 _artifacts/windows-e2e/r2_control_cases.py，入口 run_r2_control_case(fixture, reconnect=False|True)。使用生产真实 Git 与仅验收仓库本地配置的 clean filter；过滤程序是明确的测试辅助程序，父/子有 50s/55s 保底退出，实际取消必须在固定 30s deadline 内收到 user cause 并使原生父子句柄均 signalled。重复 request 必须保持一次 spawn、固定 deadline 和相同 Core Run/session/PID。True 需要主 harness 的 reconnect_r2_node 仅断连目标 Node；无此适配记 NOT_RUN。配置/attributes 采用精确 CAS 清理，不放宽生产工具策略。

真实 Git 快 filter 前置测试已 exit0 且 filter_invoked=true，证据 _artifacts/r2-control/git-filter-preflight-1a2797e92516416594f2591f3ce0829c/result.json。完整 active/重连控制探针当前仅 AST PASS，尚 NOT_RUN，源码 SHA 及状态在 _artifacts/r2-control/control-harness-source.json。固定 Git argv 仍可能调用仓库原生 filter/helpers；这些子孙属于同一原生进程边界，cwd 不等于 OS sandbox。

## 2026-11-05 CLI 发现性修复与 fixture 冻结

真实 frozen helper45 的 --version 与 workspace list/read/run/poll/cancel 各自 --help 全部 exit0；根 --help 漏列 workspace，负例保存 _artifacts/core-rpc-check/cli45-native-help-round1/result.json（rootHelpPass=false）。本线随后只修 bin/rovai.rs 根帮助、现有 owner 断言和合法 wrpc_64hex 示例；source sha dfed9eab829a61079c18cdfe4c5a1b2f24749076ec83e8b893e2d79a111840e7，rustfmt exit0。15项中其余14项未变，新freeze在 integration-final-sources-round2.json；新helper原生验证须等下一联合build，不能将旧binary补成PASS。

R2 control fixture 增加 deadline 独立模式：run_r2_control_case(...,cancel_cause="deadline") 固定15000ms，不发送user Cancel，等待真实父子进程句柄退出并核对cause=deadline；user模式30000ms、父子watchdog50s/55s。active cancel/reconnect/deadline仍NOT_RUN，不能拿terminal no-op代替。主E仍由loom supervisor持有，D02必须真实A-local Run，B native caller的组合场景另记D06。

按主E owner批准，为provider.py窄增白名单observer（import/init/public register+snapshot/已解析请求metadata旁只读observe），未改租约或重试状态机。实际HTTP隐私/边界/重放三项及原provider selftest均exit0；证据 _artifacts/windows-e2e/b7-fixture-validation.json。B7资产/无凭据HTTP与stdio MCP/hook fixture已准备并完成fixture I/O小测，所有真实Core单选/全不选/下一Run/原生消费仍NOT_RUN，具体API与接线清单在 _artifacts/windows-e2e/b7-assets-handoff.md。

最窄原生性能分解：337745056-byte Claude 2.1.241 --version 0.516s；同隔离环境实际 inspect_application_identity 内部2589ms/子进程2.672s。根Cargo与隔离manifest均sha2 opt-level3。发现每候选仅一次内容hash，本轮没有复现44.4s；未据此降低身份校验或改生产缓存。证据 _artifacts/process-check/identity-performance-20261105-round2/result.json。

### 真实 wrong-node 负例准备

主监督已批准只在隔离Core真实Run活跃无输出Git窗口接入C配对协议peer。_artifacts/windows-e2e/r2_wrong_node_case.py只创建Pair/Hello空CLI连接，凭据仅内存；保留B真实request/scope/digest/owner，仅发送者身份为C。每次实际发送前执行由生产loom_protocol编译的rpc_wire_validate，先通过外层ClientMessage、dispatch.validate及event.validate_for，排除“非法JSON被拒”冒充wrong-node。构建17.125s exit0，证据 _artifacts/core-rpc-check/wire-validator-build/result.json。随后以同socketHeartbeatAck或明确C关闭作处理证据，比较三个journal表同一只读TX摘要，最后只关C。它不是第三台实际执行机器，也不是旧generation证明。当前E尚NOT_RUN。

## 2026-11-05 A-local R2 验收入口准备

新增独立 _artifacts/windows-e2e/local_r2_fixture.py，继承当前主 E Fixture；父 e2e.py/provider.py 未由本线修改。它只复制本轮已生成的无真实密钥 loopback provider 配置到独立 host-home，使用原生 Claude PATH。真实 API 顺序为：先 super.start(dispatch=False) 建成员/Mission/B prepared workspace；按最新 revision CAS 清空 remote selection；从 runtime.installations.list 的 enabled/valid/managed_default Claude 取权限默认值；members.get 最新 version 后 members.runtime.set；最后通过现有公共 thread.messages.send 唤醒真实 Delivery/Run。A 本地 Mission 工作区由生产 scheduler 准备，不造 Run/lease/目标记录。

current_run 只读 agent_run JOIN conversation 并同时断言该 Run 的 remote target/process 行均为 0。caller_snapshot 的 logical session 是真实 conversation.id，原生 session 是 conversation.native_session_id；只在本 fixture Host PID 后代树查找精确 Claude 原生映像和 --session-id/--resume UUID。Win32 GetProcessTimes 保存精确 100ns 创建身份；CIM 时间只作交叉检查，容许 1ms 量化差。实际 Run/claim/binding/PID 创建身份在连续调用和仅 B socket 重连前后必须不变。

源码 SHA 782ec62f7850fa1ae02b0d50f4611f3163fd1a7d534254364eccbf080756ba76。准备验证 4 项通过（Python AST、import 无启动、验证进程自身 Win32 身份、PowerShell 查询脚本 parser），证据 _artifacts/windows-e2e/local-r2-fixture-review/result.json。未运行 CIM 查询、未启动新的 Host/Node/原生助手；D02 E 仍 NOT_RUN，交主 E owner 复用 product2 执行。

Linux 新 process-boundary 验收状态改为 BLOCKED：root 向既有 bero 上传冻结源码的操作被自动审批明确拒绝（当前授权未明确覆盖向该主机外传源码）。本线不通过 git、其他云机或任何间接方式导出被拒源码，不用 Windows/旧 Linux 代码结果替代新 Linux 原生验收；本机 Windows 工作继续。

product2 固定原生 helper 已实跑 --version / --help 均 exit0，版本为 rovai 0.5.1 contract-v45 ipc-v3，根帮助真实列出 rovai workspace list|read|run|poll|cancel；此前实际发现的根帮助缺口已闭合。新 binary SHA 20e5c87a6c144cf8c57b52686e26ed2203489a78688e2780e8355df18283f64f，证据 _artifacts/core-rpc-check/cli45-native-help-round2/result.json。初次验证器误期待五个重复前缀而未识别管道分组，原始 false-negative 保留 verifier-initial.json；最终仅修正解析判据，未重跑或改变原始 subprocess receipts。

## 2026-11-05 B7 原生动作入口与场景 owner

经主 E owner 批准，provider.py 仅为现有 Action 增加可选 native tool name/input，新增 register_fixture_mcp_tools 和 queue_native_tool。白名单只接受两个同 fixture suffix 的完整 HTTP/stdio bundle_probe 名与有界 absolute Read；不修改 generation、lease、FIFO、replay 或真实 tool_result 确认状态机。原 Bash 接口保持。新原始 SHA bccf6a624c592c042a1bc3d7180bfd250105a70c88ed69d0ef791fc121a2c534，先前源码保存在 provider-before-native-tools.py。

实际 loopback HTTP/SSE owner 4 项与原 provider selftest 9 项通过，两个子进程均 exit0/stderr空，源码前后无漂移。新 owner 含 11 个非法参数/注册拒绝、输入快照、Read与两个MCP实际响应编码、匹配 tool_result 确认、精确 body 重放且不消耗下一 action。证据 _artifacts/windows-e2e/native-tool-queue-validation.json。这些只证明 provider 簿记，不能冒充原生 MCP/Skill E。

新增 b7_cases.py（SHA 5d9b65b8a5b18db82e08a0cabea5c9420cb525293b5f695825052eec78d000bb）复用真实 Mission/成员/Run：六个独立可选场景、真实冻结source与native provider观察、选中Skill的完整原生Read正文比对、MCP tools/call 服务回执、真实hook session事件；取消后下一Run必须通过生产Core callback、cancelled终态和原生进程句柄退出，不用finish代替。只限定Claude/Windows逻辑Node，Codex trust与跨机器仍另验。B7Assets路径helper已通过actual同目录normal/verbatim DOS负例定位后修正，仍拒绝越界/device命名空间；新SHA603267afa5b1e119af0be16be00839a4ff58909deae4c7083f9695893091b2f0。准备证据 b7-cases-preparation.json，实际六场景 E 尚NOT_RUN。

Mindkit owner 回报本线 round2 生产源已在 Core extended testexe 通过 workspace_rpc filter 14/14、0ignored、2.687s，321项源码无漂移；证据 _artifacts/r1-core-audit-20261104/core-integration-probe-6/direct-owners-final/results.json。它与原隔离owner是重叠验证，不叠加虚增测试总数。


## 2026-11-05 UI allowlist failure and combined B7 fixture

Real isolated UI login and member Catalog navigation exposed a production Web route omission: `WEB_OPERATIONS` lacked `members.executionTarget.get/save`, so the browser adapter rejected the read before the Core transport. The Run location panel correctly remained an error instead of inventing a local selection. Original screenshot and source diagnosis are retained in `_artifacts/ui-target/four-ends-ui-20261105/ui-initial-failure.json`. Root authorized exactly the two allowlist entries; no Core authorization, CAS, unknown/retry handling or UI component behavior was changed. Actual typecheck, existing Web transport tests and production Vite build are running under `ui_web_gate.py`; real get/save, discard and offline UI acceptance remain pending, not PASS.

The fixture success status was corrected mechanically from `completed` to the actual AgentRun terminal `succeeded` in the local R2 readiness and B7 Run predicates; Workspace RPC Completed was not changed. Evidence: `_artifacts/windows-e2e/agent-run-terminal-status-correction.json`.

B7 matrix now has seven closed cases (`none`, five individual assets, `all`). The combined case requires actual native Skill Read, separate HTTP and stdio MCP calls with separate service receipts, rule context and the exact native-session hook lifecycle. Single selections reject startup of the unselected MCP; all-off rejects hook invocation. Five synthetic preparation assertions passed, including missing-stdio, unexpected-transport and unexpected-hook negatives; these do not prove native acceptance. `_artifacts/windows-e2e/b7-combined-preparation.json` records final raw source hashes; provider/services were unchanged. Native B7 E remains NOT_RUN pending the main owner.


## 2026-11-05 UI route gate and staged effective availability

The native browser reproduced the actual run-location read failure: the shared Web client did not admit `members.executionTarget.get/save`, although the Web server/Core already did. The only applied product change in this batch is those two names in `apps/web/src/client.ts` (raw SHA-256 `288a000f482b767739112fb18d1ceacab45d5add179d23bff8048a2764cd59b1`). TypeScript exited 0, the existing Web transport owners passed 42/42, and the real Vite Web build exited 0. Exact commands, elapsed time and source hashes are in `_artifacts/ui-target/four-ends-ui-20261105/web-route-gate.json`.

The actual browser then read the prepared remote target, saved model `sonnet`, read it back, reopened Catalog, discarded a different unsaved model, saved/read local mode, and restored/saved/read remote mode. Screenshots and the consolidated result are in `_artifacts/ui-target/four-ends-ui-20261105/ui-panel-result.json`. These were UI actions, not API writes relabeled as UI. The isolated noRun fixture stopped at its original deadline; only owned tab `1184441327` was closed, with receipt in `ui-deadline-cleanup.json`.

A separate real product gap remains: Profile/roster still report no configured agent and New chat shows no available teammates because existing consumers read only the controller machine's local runtime binding. Root approved a unified read-only `executionAvailability` projection. The proposed helper preserves original local configuration/readiness, gives explicit remote selection precedence, reuses production workspace/member/catalog and heartbeat authority, keeps offline targets configured but not launchable, and never falls back locally. Profile will identify the active remote target and label any retained local settings as currently unused. Asset preview uses the effective adapter; refreshing target facts must not discard unsaved asset selections.

The exact 15-file patch is staged only under `_artifacts/effective-readiness/staged/`, with `source-manifest.json` and `effective-readiness.patch`. No readiness product source has been applied while the R1 Core10/Core11 build is frozen. Rustfmt parsed/formatted only the staged new helper; five owner groups and two existing UI owner extensions are prepared but NOT RUN. An independent `ui_readiness_fixture.py` is AST-valid only: it will use the reviewed isolated proxy to prove offline/online retained selection, and an actual browser-created chat/message followed by a real native helper and normal Release. No Run/claim/lease is seeded by that harness. Full readiness compile, UI/new-chat E and selected-offline UI acceptance remain pending.


## 2026-11-05 effective availability applied and frontend gate

The approved 15-file effective availability change is now applied by exact before/after SHA-256 CAS. Local runtime configuration/readiness remain the controller's local facts. The readonly effective projection gives an explicit remote choice authority, distinguishes configured from launchable, reuses real catalog/workspace/member admission and heartbeat freshness, and never turns remote offline/drift/revocation into a local fallback. Current-schema authority damage fails closed. Creation preflight, roster/Profile and capability runtime consume the same projection.

The parent review found an asynchronous MemberCatalog refresh race before application. The applied version has an event-only factsReload callback and a separate effect scoped to active/member/client/phase/reload with cancellation cleanup. It updates runtime/preview only; items, saved choices and revision remain the asset draft owner's state. Actual browser late-success/error timing verification remains pending and will be reported separately from the true native New chat E.

Evidence: `_artifacts/effective-readiness/applied-source-manifest.json`, 15 files; applied patch SHA-256 `8c01966bc9d300aedd395670b1f478c4df18a19d3960de7714a677845513be52`. The original sources are retained under `applied-backup`. No commit/index operations were performed. Core source ownership is released to the Mindkit supervisor's joint probe12; the five `member_execution_availability::tests` owners are NOT_RUN as of this entry.

Actual frontend gate PASS at `_artifacts/effective-readiness/frontend-gate/result.json`: TypeScript noEmit exit 0 (85.375 s), five affected UI test files 59/59 PASS exit 0 (11.578 s), Vite Web build exit 0 (28.313 s), all 13 recorded frontend source hashes unchanged. Parent runner exit 0. This does not stand in for native UI or Core integration acceptance.

The requested external Pi readonly review was automatically rejected before a session was created. The exact original refusal, 15-file payload whitelist, default `oct-chat/deepseek-v4.1-flash` destination and blocked original patch SHA are preserved at `_artifacts/effective-readiness/pi-review/approval-block.json`. The request was not reissued or repackaged. Parent and native local review plus local gates continue; no external review PASS is claimed.

The independent `_artifacts/effective-readiness/ui_readiness_fixture.py` is prepared (AST only, NOT_RUN). It begins with zero Runs, retains actual A discovery facts, and requires the browser to create the new Thread/message. The oracle checks the real frozen remote Run, B native process/creation identity, actual new conversation camp for the native member list, and normal process release. It will observe absence of this session's native process within the exact A Host ancestry instead of assuming isolated PATH hides global installations. The scoped Response.json timing probe alters only already-received readonly catalog response timing in the owned test page and will be fully restored before the independent native New chat evidence.


## 2026-11-05 retired Node socket E and readiness fixture correction

The independent same-Node old-socket E passed with the fixed `core11_node_home1` products: `_artifacts/r2-stale/1105-055247-e31a1/result.json`, runner exit 0, 88.343 seconds. The caller was an actual A-local native Claude Run, never a synthetic remote owner: caller Run/session/native PID 5768 remained identical and the terminal record has zero remote target/process rows. The real B workspace request moved online_generation 1 to 2 and Running (SQL 2) to Unknown (SQL 7), as production resume_node requires.

The fixture retained the previously authenticated old Core upstream while closing only its native-facing side. A separate actual loopback WS precheck proved that retention remains usable across a second native connection and that only the upstream peer's close creates the observed closure. In product E, Core closed the retired upstream before marker submission; the retained relay recorded zero test-side upstream close calls and no relay errors. The proposed same-scope new sequence 2 frame passed the production Wire DTO validator, but markerSent is false. This is real **retired transport fencing** evidence, not a claim that a business handler received/rejected the marker. The current request's before/after journal SHA-256 remained `5d5fce25b051d46222202cd81fd57436e15c4db694638213234d9533ee639524`, with the original dispatch/deadline unchanged.

The same control owner then received a real user-cancel outcome, observed the actual Git filter parent/child process handles signalled, proved exactly one filter spawn, no watchdog termination, and no retry/reconnect re-execution. No extra process termination was needed for the passing outcome. Repository-local filter/attributes were CAS-restored, tracked bytes unchanged, owned fixture cleanup had no errors, and all ten fixture source files, the recorded Core snapshot and fixed binaries stayed unchanged. The Run ended succeeded. The parent independently re-read these facts and accepted the bounded transport-fence scope. Same physical Windows hardware remains explicit; no Linux or two-physical-machine PASS is implied. The raw runner stderr included harmless fixture HTTP keepalive connection resets during teardown, separate from the acknowledged control outcomes.

Core12 subsequently compiled the integrated production/test binary successfully (391 source entries unchanged), and the complete Mission claim/archive owner passed. The five new readiness owners initially reported 2 PASS / 3 FAIL because their hand-written Claude permission_mode='default' was rejected by the existing real runtime configuration validator before the intended offline/workspace assertions. This failure is retained at `_artifacts/r1-core-audit-20261104/core-integration-probe-12/effective-readiness.log`. Only the test's `select_remote` construction was changed to obtain both model and permissions from the existing production `agent_profile::member_runtime_defaults(ClaudeCodeCli)` API. The product validator and availability implementation were not loosened.

Final helper SHA-256 is `57cc8452eb33509156387edd1fdd79136983806654c175565e82ba7fee3cbd83`. The original LF convention was restored before the next gate, and the entire production prefix preceding cfg(test) was verified byte-identical to the applied source. `_artifacts/effective-readiness/owner-fixture-fix.json` retains original and intermediate hashes and the exact test-only change. The corrected five owners and the actual New chat browser/native acceptance remain pending Core13's joint gate and fixed products; the already-passing frontend gate is not being repeated without a source change.

## 2026-11-05 four-host acceptance evidence map

Added [the bounded F-A/F-B/M evidence map](four-ends-evidence-map-2026-11-05.md) from existing receipts only; no tests or private-file discovery were repeated. It maps each F-A ID, grouped F-B owner cases and all M IDs to a receipt or an explicit uncovered scope. The 38 shared-index checks establish four actual native startup paths with the same source hook/index SHA, exactly once per request and no topic preload. They do not establish four-host skill-body/MCP/recall/lifecycle completeness. Separate Pi 17 H, Codex image/Stop 9 H plus shell-deny 6 H, DSH 14 Stop S plus existing-GUI H, and Claude real index lifecycle receipts are identified individually. Codex changed production hooks still need native /hooks re-trust; isolated invocation trust is not that approval. Unsupported Pi events and DSH headless opt-in/preset boundaries remain explicit. UI native acceptance awaits the corrected Core13 fixed products.

## 2026-11-05 Core13 actual UI discovered two remaining availability callsites

The new isolated browser fixture is _artifacts/ui-ready/1105-060946-e9237/ui-control.json, using fixed core13_node_home1 products and the already-built Web UI. The fixed binary manifest is component-build PASS only; owners/release remain separate. Its real read models pass remote configured/canLaunch with local runtimeConfiguration=null and zero AgentRuns. The actual roster and Profile correctly show the remote agent, while the refreshed Quick Chat empty page still reports no available teammate. The old state is preserved in browser/quick-chat-original-empty-state.png and its DOM receipt.

The parent reviewed and approved two narrow callsite corrections in ThreadWorkspace.tsx: QuickChatWorkspace now forwards executionAvailability to the existing eligibility helper, and the actual empty Thread runtime summary uses the same helper while preserving active/present filtering and unknown-profile handling. The existing App.test.ts ready fixture gains its real configuredRuntime instead of combining ready with a null configuration. No Core authority, draft behavior or runtime binding was changed. Before/after hashes and the exact two-file patch are in _artifacts/effective-readiness/quick-chat-callsite/final-source-manifest.json and final.patch. Only tsc, the three relevant existing Quick Chat/empty Thread tests, and Web build are being rerun; the original 59-test gate is not repeated. Native panel/offline/timing/new-chat acceptance continues after the fresh Web assets are ready.

F-A05 follow-up is isolated and separate: skill-cli/_artifacts/four-ends-audit-20261104/capability-source-host contains one shared source skill/rule/MCP fixture. Real stdio framing/list/fixed echo and invalid-input rejection passed plumbing only; no native F-A05 PASS is claimed yet. Root/Loom own the independent Codex app-server wrapper; shared common/source/manifest/MCP files are frozen. Claude/Pi/DSH wrappers remain subordinate to the active UI acceptance.

## 2026-11-05 Core13 actual UI gate and delayed-response owners

The additional QuickChat and empty-Thread callsites passed the necessary TypeScript check, four existing App owners, and Vite build. Evidence: `_artifacts/effective-readiness/quick-chat-callsite/gate/result.json`; final exact two-file patch is `quick-chat-callsite/final.patch` (SHA-256 1d1e5e33e05e40e5b06abc7dacba4799ed3325788be5dd80adb818942a395fb9). Root reviewed it. No extra Core permissions or local runtime facts were changed.

Actual Core13/browser fixture `_artifacts/ui-ready/1105-060946-e9237` has now proven remote Profile/roster, model save and reread, discard of unsaved model, local/remote save and reread, and available Quick Chat entry. Three actual delayed-response cases passed: older local success after new remote save, older injected error after new remote save, and old member response after switching to an unconfigured member. Unsaved rule draft was retained in the first two cases. The Response.json fixture was restored exactly; no held reply expired. Full receipt/hash mapping is `browser/catalog-race-result.json`. Two premature precondition reads are retained as failed fixture receipts; mutations were not resent and those reads were not counted as passing cases. Offline and real browser-created new-chat Run remain pending at this checkpoint.

## 2026-11-05 Actual New chat dialog projection and native-init timing

The first actual UI attempt found a second concrete caller defect: `BusinessApp.campCreationPreflightFromAgents` rebuilt candidate rows from local-only fields, dropping the new remote availability. `composer-invitations` and the one-click preference resolver had the same missing field at their existing helper calls. Root reviewed and approved the exact six-file patch `_artifacts/effective-readiness/dialog-callsite/staged.patch` (SHA-256 f179c66fbeaae34db3e7c8ab6278d9a176ca34927f7c5d369666fb7397a08232). The change was applied by before-hash CAS. No Core code changed. TypeScript exited 0, ten relevant behavioral owners passed (199 unrelated skipped), and Vite exited 0; eleven source hashes were stable. Evidence: `dialog-callsite/gate/result.json` (SHA-256 a5c7822f3f25c9edb282781163a6c33abe5b1d993f7ba2786f49ee3d3b229db3).

The same Core13 instance then served `index-6qd67IcL.js`. The real New chat dialog selected the remote member and Lead and enabled New. A native browser click created a new Thread; the empty Thread displayed its actual remote Lead normally. One actual browser Send created exactly one real remote AgentRun and a B native process, but the acceptance harness checked `conversation.native_session_id` immediately after the earlier launched ledger became visible. The new conversation/Run/member were correct; the native session field was still null. The first native acceptance therefore remains FAIL, not PASS: `_artifacts/ui-ready/1105-060946-e9237/ui-control.json`. Source hashes remained stable; its owned Host/Node cleanup completed and owned tab 1184441394 was closed. Existing successful UI/race/offline receipts are preserved separately.

A fixture-only, fixed-Run/epoch/member/ledger wait patch is staged under `_artifacts/effective-readiness/native-session-wait`. It checks terminal and node failure, caps each authenticated node read at three seconds, and waits for the fresh native session's real authority. Production review confirmed fresh Claude binds that session after input-ready and before releasing business input, so it need not wait for the provider-held turn to finish. A fresh instance will only repeat the final New chat + one Send + native/helper completion segment after Root approves the small fixture correction; the earlier UI matrix will not be rerun.


## 2026-11-05 Actual UI New chat completion and scoped acceptance

The final native segment now passed in a fresh isolated fixture after the approved same-Run initialization wait (fixture SHA `18867c0da1425acb7c8ada82dab4b854525af69353c870e0f84886ceeb515da6`). No New or Send action was retried. The browser created one Quick Chat thread and sent one message. Actual Run `6f72ed68-6d72-4ffe-8d80-1c9098ef4290` (epoch 1) ran as the explicitly selected remote member, produced its native helper result for the new conversation camp, reached `succeeded`, and obtained normal Release with 27/27 acknowledged output, no abandoned output, and a stopped process tree. The initial missing native-session field became present on the second bounded observation before business input; this was initialization timing, not a turn-end wait.

The member's local runtime configuration remains absent. The actual B native process was PID 21196 with creation identity 134383349171141200; two snapshots of the fixture A Host ancestry found no native process for that session. Genuine managed installations discovered on A are recorded; physical CLI absence is not claimed. Browser tab 1184441409 was closed, the owned Host/Node were stopped, and the fixture exited 0 with all six fixture sources stable. Fixture-owner exit 1 during shutdown is recorded separately from the successful native protocol Release. Two HTTP keep-alive connection-reset traces on client closure were observed, not hidden.

Canonical evidence index: `_artifacts/effective-readiness/ui-acceptance-result.json`. It maps actual model Save/readback, draft discard, Local/Remote persistence, offline selection retention/recovery, Quick Chat eligibility, three late-response owners with restoration, and this final native New chat chain to exact receipts and screenshots. The earlier UI fixture's final native FAIL and modal projection failure remain unchanged. The new fixture only repeated the final New chat/one Send/native chain.

Served UI is the already-gated `index-6qd67IcL.js` (SHA `2ee76af687dfca96296c8c7f0b93d3dee00017a9e6cf2a4961748397f09c0738`); all build assets still match the final caller gate. Core13 is a fixed component build, with readiness owners separately passed on the same production helper in Core14. This is same-machine Windows logical-node acceptance, not Linux or two-physical-machine evidence. No further UI product change or test rerun was made.


## 2026-11-05 Pi global capability preparation checkpoint

UI ownership is released: both owned browser fixtures are closed. The final UI touched-file index is `_artifacts/effective-readiness/final-source-whitelist.json` (23 files; shared Core files explicitly retain other authorized owners). The final served Web assets remain unchanged.

The remaining F-A05 Pi native case is prepared under the parent skill-cli project's `_artifacts/four-ends-audit-20261104/capability-source-host/`. Only `pi_capability_provider.py`, `pi_capability_probe.py`, and `hosts/pi/` were added; the common source, shared provider, MCP server and other hosts were not modified. The installed Pi package is 0.85.1 and installed `pi-mcp-adapter` is 2.36.0 (native version check remains part of the pending E invocation). The default aggregate `mcp` tool is retained: actual native Read result, search result, and matching call IDs must precede the fixed echo call. A single normal lazy connect is allowed only after an empty search. No directTools override or external model is used.

Preparation owners passed 15/15: exact result-ID binding, incomplete-body negatives, search prerequisite, bounded lazy connect, actual loopback SSE, and creation/removal of an owned empty temporary cwd. This is not native E evidence. The first owner run's 14/15 failure remains: a negative test mutated its reused sample tool list; a test-only deep copy corrected it, with no provider product change. `hosts/pi/review/ready-for-review.json` and `proposed.patch` (SHA `13945909c9c39a7bc842a6e7ca018eee8ce168f02537f96778da52d34cfbcc2e`) identify the frozen proposal. Native execution awaits Root review.

The separate user-TEMP cwd is necessary because Pi's genuine context loader walks ancestor directories up to the volume root, even across Git boundaries. Root authorized only a unique `skill-cli-f05-pi-<uuid>` empty directory, prechecking ancestor context file existence without reading contents and failing closed if any exists. HOME, source, configuration, logs and final evidence remain under `hosts/pi/`; cleanup removes only the exact empty owned directory without recursive traversal.


## 2026-11-05 Pi F-A05 native completion

Root reviewed the frozen two-file proposal and approved one native invocation. It passed 27/27 checks with Pi 0.85.1 and the installed adapter 2.36.0 in its default aggregate mode. Real native Read returned the complete shared Skill; aggregate search found the exact echo metadata and one aggregate call reached the actual MCP service. The first request contained global rule + Skill description and no body; subsequent native Read/body SHA was `9c488abcbf7cfbfabb4dc4c1f708af078baf55124289017364b2d82c14dd030e`. The MCP service independently logged exactly one call with fixed arguments and EOF. No connect fallback was needed.

Evidence is in the parent skill-cli `_artifacts/four-ends-audit-20261104/capability-source-host/hosts/pi/accepted-result.json`, backed by `run-20261105-070239-6c2304d5/result.json` (SHA `a698ad28a6f66b0147a6aea8d2d0fdcf0b8e890d8b24ba253b5484a82cd0fe5f`) and independent raw-event review. All 35 input hashes remained stable. Native PID 26936/creation 134383357609252294 and MCP PID 27152 were owned by the private Job; exit 0 was natural, the tree was empty before Job close, and no timeout/forced cleanup occurred. The exact empty temporary cwd was removed; no global configuration or production adapter changed. The independent raw stdout/service/source reconciliation passed 11/11.

F-A05 is now evidenced for this same isolated source on all four actual hosts (other accepted indexes owned by their supervisors). This does not expand the existing hook lifecycle or daily Codex trust claims. Root retains the combined acceptance/index and Git commit ownership.
