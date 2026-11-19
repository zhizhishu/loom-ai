# LOOM Core V2 · P1-A 四路独立施工最小合同（2026-11-15）
  
> **ACTIVE_SLICE / 已经获得用户“开始执行”授权**；本文件只冻结 P1 中**首个可并行、可测、能回滚**的薄切片，不冒称 PDF P0–P14 已经整体完成。未来总蓝图仍是 [LOOM-V2-MASTER-PLAN.md](LOOM-V2-MASTER-PLAN.md)，本机真实发布版仍是 v1.72。  
> **总管工作目录** `C:/Users/echo/Downloads/claude/skill-cli`，**产品仓库** `C:/Users/echo/Downloads/claude/skill-cli/loom`。  
> 四路 Pi Skill 工兵由 Root 派发、独占写入、只在受管本地项目工作；模型 2×DeepSeek V4.1 Flash、2×GLM-5.3-Flash。全部请求 --reasoning max；**当前 Pi 实际暴露 DeepSeek max、GLM xhigh（因 Pi 模型目录与 DSH 映射漂移）**，不为调档修改用户全局模型配置。

## G0 基线/禁止区

- Git HEAD `65fcb85265fe208c43d7999b320fc7302ece67fa`，本地分支 `rovai/loom-b6-b9-integration-20261104`，含未提交的 `apps/desktop/src/renderer/src/loom-native/Inspector.tsx`、`product.css` 与 `crates/loom-node/src/lib.rs`、`process_wire.rs`、`session.rs`。**四名工兵均禁止修改它们**；所有数据库/用户目录/64851/当前 Chrome/服务端/全局 CLI/Pi/DSH 设置均禁止碰。
- 旧 core/node/proto 三个 Worktree 也有历史未提交工作；不复用它们给新工兵，不 cherry-pick 未验补丁，不重写现有 W12。
- 已知源码：`crates/loom-protocol` 现有 serde/serde_json；`scripts/package-embedded-pi.mjs` 的实际固定 EMBEDDED_PI_VERSION **0.85.1**，本地 Git 上游 Pi 参考包版本 **1.0.4**，Pi Skill doctor 当前 Pi CLI **0.85.1**。Pi Purge 0.3.0 peer >=0.80.0 <2 **仅说明声明的版本范围匹配**，未经真实 Pi+Purge 集成测试。
- 这轮不改变 `Cargo.toml` workspace 列表、不发布 V2 DB migration、不从真实用户资料启动 Runtime；所有新文件先作为纯合同/状态机/受管构建实验，Root Review 后才由 Root 单点把 `pub mod v2_...` 注册到 `crates/loom-protocol/src/lib.rs` 并执行聚焦测试。
- 如需真实调用模型，只使用 Pi Skill 工兵执行，并由 Pi Skill 自带受管进程记录；不能泄漏 token/服务端响应。Pi Skill 的 `--tools file` 是只读；写任务 `--agent worker --tools file,write`；不加 shell/MCP/设备控制。
  
## G1 四路文件所有权白名单（所有人先交微计划，再由 Root 同会话续聊批准修改）

| Lane | Runtime/模型 | 未来唯一新文件（若存在须让 Root 协调） | 核心行为、必要负例 |
|---|---|---|---|
| A Domain | DeepSeek V4.1 Flash / max | `crates/loom-protocol/src/v2_domain.rs` | BotId/GoalId/RunAttemptId/AssignmentId 的显式 ID；四 RuntimeKind 封闭枚举；FrozenRunTarget 分辨 RuntimeInvocation 和 **Device-only** 不强求 InstallationId；serde round-trip 与非法身份拒绝。 |
| B Coordinator | GLM-5.3-Flash / 最高可用 xhigh | `crates/loom-protocol/src/v2_coordinator.rs` | 无 I/O 的 ACCP Assignment DAG/Claim/Lease/Fence reducer；受控 now_ms、唯一 claim、过期 lease 与迟到回执拒绝，不能自动审批 Goal 完成。 |
| C Capability | DeepSeek V4.1 Flash / max | `crates/loom-protocol/src/v2_capability.rs` | Skill/MCP/Rule/Hook 四项枚举、Binding/Snapshot/Evidence；Selected 不得自动 Loaded/Invoked，Unsupported/Revoked 不能虚报生效，owner/scope 显式。 |
| D Pi Purge | GLM-5.3-Flash / 最高可用 xhigh | `scripts/loom-pi-purge-bridge.mjs`、`scripts/loom-pi-purge-bridge.test.mjs` | 不变更 Pi Agent Loop/已有 packager；固定 pi-purge v0.3.0 Git/digest/来源与模式的受管输入验证、Off/Append/Replace/Fallback、Strict 仅 Lab、session_start 重置检测/激活计划与 Receipt；测试不读取用户全局 Pi 配置/不运行第三方插件。 |

### 冻结的数据/职责约束

- **Core 属主**：BotIdentity、Goal、Assignment、MemoryScope、PersonaRegistry、CapabilitySnapshot、ResourceGrant、Audit；**Pi Purge 仅属于 Pi Extension/Prompt Materializer**，不是第五 Runtime 或第五能力；DSH/Claude/Codex 不安装它。
- **身份**：BotId、GoalId、AssignmentId、RunAttemptId、DeviceId 不相互冒充；每个接受的状态转移记录 version/expected_generation/idempotency；过期/重复事件不得让旧 Worker 重新完成 Goal。具体 Rust API 在各模块独占范围内由工兵提议并经 Root 批准，不提前许诺所有模块自动互调。
- **运行目标**：`RuntimeInvocation` 代表一个确实有可用 RuntimeInstallation 的受管 Pi/DSH/Codex/Claude；`DeviceInvocation` 表示仅发 DevicePort Tool（Win/Mac/Linux 可以无 Pi/DSH），不允许通过伪造 InstallationId 取得通路。
- **安全**：Persona 和 Memory 不扩大 Grant；普通任务 Purge Off 或 Append，Strict 只能独立隔离 Lab；Shell/MCP/Browser 等外部副作用需要真实 OS/设备授权机制，本轮不把 Prompt 当唯一执行权限策略。
- **当前阶段验收线**：E0 合同 REVIEW、E1 新代码 REVIEW、E2 单测可独立运行、E3/E4/E5/E6/E7 不得通过源码存在自报 PASS。新模块必须能够从原 v1.72 仓库回退（删除新模块和 Root 唯一 `pub mod` 注册即可；不修改 DB）。

## G2 Root Review 与发布边界

1. 工兵返回 `RESULT/EVIDENCE/CHECKS/BLOCKERS/STATUS`；Root 读源码、核工具调用、查 diff，拒绝跨目录写入。
2. 仅在各模块对接真合同、无冒名/越权/迟到结果后 Root 注册三个 Rust 模块，执行 `cargo test -p loom-protocol`（若本地资源允许），JS 对应 `node --test scripts/loom-pi-purge-bridge.test.mjs`，单独记时间/退出码。
3. 本轮若无法达到实际 Pi Bundle 真加载或 UI 实际选择，不宣称 T30 PASS；DeepSeek/GLM 工兵返回不等于用户真实产品已具备多 Agent 功能。
4. 进度用户可在 Pi Skill 本机看板 `http://127.0.0.1:8767` 与 AgentDock 任务 `tsk_30842bb1a1a15973` 观察；Root 在各阶段更新 Mindkit `TASK.md`、`LOG.md`，保留失败原因、会话 ID、独立验收。
