# W12 实施修订：DeviceInvocation 独立身份 × 复用 R2 Node 传输（2026-11-15）

> **历史归档 / KEEP_AS_RESEARCH_FINDING / 不再作为 Core V2 施工指令。** 用户最新要求「本轮只整理架构、不开工」，后续唯一入口：[LOOM V2 总计划](../plans-2026-11-18/LOOM-V2-MASTER-PLAN.md)。此文件原始正文与当时测试结论仅作历史证据；原字节 SHA256 快照在 [历史归档](README.md)。**不得依据下文旧“已授权开工/唯一入口”重新派工**。

> **状态：源码已证实的架构缺口 + 下一阶段 implementation contract proposal；并未完成 E4，更未上线。** 用户已授权在隔离工作区实施，**不需要再把历史讨论稿的“不准开工”当阻塞**；但任何改动仍需具名所有权、真实授权/回执、向下兼容和隔离验收。此文是最新 W12 工单路由，不是已有 Current Architecture/Contract 的规范真源；正式实施需依据 `AGENTS.md` / `docs/decisions/README.md` 同步权威文档和门禁。

## 1. 2026-11-15 真实发现：旧模型的两个锁死点

**已证 E3**：新 `rovai-host.exe` → Core Web `crates/rovai-web/src/nodes.rs::workspace_files` → 独立 `loom-node.exe --device-only` 的 HTTP/WS → Win 文件系统，真实 list/read/越界拒绝 PASS；Node inventory `clis=[]`、`activeRunCount=0`。

**未通 E4**：一旦尝试让某个 Bot/AgentRun 的 `loom.evidence` 从相同 device-only workspace 归档，当前源码有两重硬约束：

1. **Run 身份绑死 CLI Runtime**：`crates/rovai-core/src/remote_execution.rs:44-58` 的 `agent_run_execution_target.installation_id` 是非空 FK（指向 `remote_runtime_installation`），`RemoteMemberSelection::validate:97-103` 只允许 `ClaudeCodeCli | CodexCli`，`remote_catalog.rs:150-166,255-270` 要求可启动的 `execution_node_cli`。Device-only 节点没有这些 CLI，因而没有 `FrozenRunTarget`。`crates/rovai-core/src/loom/remote_artifact.rs:187 current_target` 要求 `revalidate_run_claim` 的冻结目标；不能伪造一个 installationId 绕过。
2. **证据 RPC 与 E3 文件 RPC 不同路**：`crates/rovai-core/src/application/workspace_rpc.rs:245-263` 从 `remote_runtime_services.workspace_transport()` 取运输，并按 `owner_node_id` 查 `connection_generation`；`:399-410` 在无该运输/连接时返回 `NodeOffline`。E3 证明的是 Web 的 `nodes.rs::workspace_files` HTTP→Node WS，不是当前 Run/evidence 使用的 Runtime-services transport。**即使在 Rust 归档里添加一个 WorkspaceProducer fallback，也会卡在第二层**。

W12 Scout `7887f6f21863470bbf2a76782baa34e5` 和受管 Worker `4c7f285307784b0c9e83e521cd6e6bb3` 已核对。Worker 正确标 `STATUS: STUCK`，其隔离 `worktrees/core/crates/rovai-core/src/loom/remote_artifact.rs` 只加强了冻结目标的 node 撤销/代次/token 校验及相应负例，**没有实现 Device-only producer**；`application.rs` 未改；编译/单测 **NOT_RUN**；主仓未合并。这不是“阻塞不让开工”，而是现有建模错误，应该通过以下 W12A/B/C 有界修正。

## 2. 正式方向：Bot Goal、AgentRun、DeviceInvocation 三者独立

```text
User / Bot / Mission Goal
      |
      +--> Step 1: AgentRun (Cloud Pi / optional DSH)
      |            |
      |            +-- ToolCall -> DeviceInvocation (B 无 CLI)
      |                                | DeviceGrant/WorkspaceBinding
      |                                v
      |                       DevicePort -> Node WS
      |                                | Receipt + Digest
      |                                v
      |                      Artifact/Evidence/Review
      |
      +--> Step 2: pure DeviceInvocation (没有模型 Run 时也成立)
      |
      +--> Step 3: optional Local Runner (B 上有 Pi/DSH/Codex)
```

**选择**：新增一个可独立审计的 `DeviceInvocation` 作为事实身份，`AgentRun` 只是其可选发起者；不要把设备用具绑定成 `RemoteRuntimeInstallation`，也不要把人类登录 Session 伪装为 CLI Run。现有 `WorkspaceRpcStore`、`WorkspaceRpcRequest/Event`、`WorkspaceArchiveReceipt`、`Artifact` 尽量复用，**不是再造轮子**。如为了最短 MVP 暂用单一 Run 主导，仍必须保留 `device_invocation_id` 和明确资源 Grant，而非随意填 `agent_run_execution_target.installation_id`。

## 3. 拟议领域接口（新合同待冻结）

```text
DeviceInvocation {
  invocation_id, protocol_version, owner_kind: agent_run | human,
  owner_user_id, workspace_id, mission_id, bot_id?, step_id?,
  agent_run_id?, tool_call_id?,
  device_id, device_workspace_id, workspace_generation,
  binding_id, resource_grant_id, grant_version,
  operation, relative_path?, fixed_tool_id?,
  request_digest, idempotency_key, deadline, controller_epoch?,
  state: queued | accepted | executing | completed | rejected
       | cancelled | expired | unknown_outcome,
  receipt_digest?, output_ref?, error_code?,
  created_at, settled_at?
}
```

字段必须由**Core 验证过的 user/workspace/Mission/Run/DeviceRegistry/WorkspaceBinding/Grant**推导，不能由模型提供 `device_id`、`grant_id`、`run_id` 来取得权限。Device 侧必须收到并验证 grant 版本/范围/时限；撤销后待执行请求 fail closed；文件 root 校验路径真实展开（含 junction/symlink）且重新检查工作区代次。对带副作用操作，断线未收到 result 是 `unknown_outcome`，不盲重放。每个 `invocation_id` 最终只能归档一份确定状态与证据。

### 3.1 传输策略

**主选**：用现有 Node 出站 WS & pairing / ConnectionRegistry 作为 DevicePort 的 transport，适配 `WorkspaceTransport` 接口或在同一 Core Broker 中暴露 `invoke/settle`。请求的 `owner_node_id` 和 `connection_generation` 必须来自该 Node 连接的实际 registry，绝不可由 Web 请求自行指定。控制面 WSS、文件数据面 hash + quota；PTY/GUI 高带宽未来再单独引入 WebRTC。

**备选短期 E4**：针对只有 `file.list/read` 的操作走现有 `nodes.rs::workspace_files` 路由，但只能由 Core-owned `DeviceInvocationService` 在已验证 Session+Mission Workspace/Grant 的前提下调用，不能直接给模型一个能发 HTTP 到 loopback 的任意工具。长期必须统一 Node transport，避免 Web 与 AgentRun 使用不同授权事实源。

## 4. 并行工兵：下一批 W12A/B/C，可分开实施

| ID | 唯一 owner / 写入边界 | 工单输出 | Gate |
|---|---|---|---|
| **W12A 域/模式** | `crates/rovai-core/src/remote_execution.rs` + 新 `device_invocation` 模块和 **新增 additive schema migration**；独立 Git worktree；不要碰 Node/Renderer | 真 `DeviceInvocation` 的 Run 可选父关系、Grant/Scope/WorkspaceBinding/状态机、receipt/idempotency；**不**靠假 CLI installation | 数据库 up/rollback、旧 agent_run+missions 查询兼容、无 grant/跨用户/离线拒绝 E2/E3 |
| **W12B Transport** | `crates/rovai-web/src/nodes.rs` / 现有 Node broker 或独立 `device_transport` 适配模块；独立 Git worktree；不写 Core schema | 复用 Node 配对+出站 WS 把 typed R2 调用路由给 `device-only`，真实 owner generation 与 revoke | 同进程 E3→双进程 E3，断网/重复/旧代次拒绝，不得伪造 `remote_runtime_services` CLI |
| **W12C Core 集成** | `crates/rovai-core/src/loom/remote_artifact.rs`、`application.rs`、必要 API 注册文件；仅 A+B gate 通过后独占 | Bot/Run→DeviceInvocation→Core retained Receipt→真实 Artifact/Review，支持可信 `owner_kind`，旧 FrozenRunTarget 路径保留 | 真实 RunToolCall 与可读回 Artifact E4；错误代次/错 owner/旧 grant/重复结果负例；数据库隔离 |
| **W12D QA** | 只写 `_artifacts/` 证据与隔离测试根 | E3/E4 T2/T4/T5/T6/T7 完整日志、权限与超时 | 新 Node 单测可核验、协议 33/33 回归、不碰 64851 |

**并行次序**：先冻结 W12A/B 共享字段合同 → A/B 并行（各工作区独占文件）→ C 集成→D E4；任一步失败仅返回差异和可修工单，不改现有主仓。需要更新当前版本 Architecture/Contract/Decision 时按版本治理而不是在历史文件里随意写 ADR。用户允许大重构，但**不允许丢数据**。

## 5. 真实可用验收：不能降级通过

- E3 真 Host/Node FS：已有 **PASS**，证据 `_artifacts/loom-execution-20261115/pure-device-runs/3d1ec28e1a214fc5827c11a678b4c795/pure/evidence/e3-proof.json`。
- E4 Bot 工具到 Artifact：**NOT_RUN**。需要从一个真实认证 Run/Goal 进入设备，设备 B 没有 CLI，输出的 Core `DeviceInvocation` 与 `WorkspaceArchiveReceipt` 可查到，同一内容 hash 的 `Artifact/Review` 再读回。
- 安全负例：撤销 Grant、切换 workspace generation、替换 Node、伪造 receipt、重复 idempotency_key、断网 `unknown_outcome`、path traverse、跨 owner/tenant，每项真实拒绝不泄露数据。
- E5 真 Linux Core A ↔ 另一台 Windows B：**NOT_RUN**，当前 Bero DE-BERO 根盘 196GB 100% 且无另一持久挂载；仅 tmpfs ≠ 可持续 Cloud。WSL Ubuntu-24.04 只读起机探针超时，不可作已验 Linux A。
- W12 Worker 新代码仍是 **UNMERGED_CANDIDATE**，只加强旧远程归档权限，未解决这两重锁死点；不绕过安全校验合并。

**最短路线结论**：`P3 FilePort E3` 已可证明“不需 B 上 DSH Host”；要从“能读到 B 文件”走到“Bot 能持续接手工作并归档”，必须先给纯工具设备调用一个不依赖 CLI 的可信业务身份，并桥接 Core→Node 受控 transport，而不是继续调一个旧 Run-only 核心测试。这个发现优先于一切 Pi→DSH 换内核讨论。
