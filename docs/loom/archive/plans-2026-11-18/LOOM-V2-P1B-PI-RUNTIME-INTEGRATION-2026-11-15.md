# LOOM Core V2 · P1-B 第二轮 4 路 Pi Skill 子合同（Pi Purge 真 Hook + 多 Agent/能力桥）

> **ACTIVE_P1B / 工兵须先微计划再 Root 授权写入。** 上一阶段 [P1-A 实际验收](../legacy-plans-2026-11-15/LOOM-V2-P1A-ACCEPTANCE-HANDOFF-2026-11-15.md) 已经完成 Rust62/62+Node16/16、旧 Pi Bundle verify PASS；本阶段继续建立**运行插件/工具物化的真实证据**。仍遵循用户 PDF P0–P14 总架构和 [唯一总计划](LOOM-V2-MASTER-PLAN.md)。  
> Parent Root `C:/Users/echo/Downloads/claude/skill-cli`，child 产品 `loom/`。AgentDock 本阶段任务 **`tsk_2f9eed3cec934bf8`**；Pi Skill 实时本机看板 `http://127.0.0.1:8767`。

## 安全与前置事实（G0）

- 本地已知 Pi Package **0.85.1**，`resources/runtime/pi/` 保留且`node scripts/package-embedded-pi.mjs --verify --destination resources/runtime/pi` 已 exit0，树 SHA256 `5692cc77a900ec7fccc8b6e9dcc6648b8ec42d81e83b627cd06c21fd0707c871`；此自检不发送 Prompt。打包器固定 Pi 0.85.1，不可擅自升到参考仓 1.0.4。
- Pi Purge 来自只读 `_artifacts/reference-repos/pi-purge-current`，源码 commit **d0196ccfd773b0ed342bd2f25372aff65f1a4a53**，package 0.3.0、MIT、Node>=22.19.0、Pi peer>=0.80.0<2；其源码 `session_start` 清零 enabled，只有 `before_agent_start` 修改模型提示词；`/purge` 是 Extension 命令不是用户聊天命令。**本轮若实际执行上游 JS/TS，只能在独立测试进程（无模型、无公网、无生产认证或目录）**，并记录当前真实 Hook 输入/输出，不得说 Provider 收到了 Prompt。
- **不可动**：原 `resources/runtime/pi` 打包产物（可只读 verify）、`scripts/package-embedded-pi.mjs`、用户 `~/.pi` 和 DSH、Claude/Codex 的全局配置、真实 DB/64851/用户真实 Chrome、GitHub/Bero、五处原已存在 UI/Node WIP、旧 dirty worktree。对于 staging/copy，只写本轮明确创建的 `skill-cli/_artifacts/loom-v2-20261115/p1b-sandbox` 私有目录。
- 界限：E3 原生 Extension Hook 的**隔离模拟事件**不等于 E4 真 Pi SDK+Provider 模型请求；Loaded、Activated、PromptSeen 必须分别报告。即使 Hook 测试成功，真人审批/文件权限仍由 Core/DevicePort，不能被 Pi Purge 掩盖。
- 这轮仍不动用户喜欢的 UI / 正式 Core 数据库。Rust 新模块 `lib.rs` 注册由 Root 单点进行，不让四 Worker 并写已有文件。

## 四路 Owner（先微计划，独占写白名单待 Root 复审）

| Lane | 首选模型与最高可用思考档 | 待批准的新文件 | 最低测试合同 |
|---|---|---|---|
| **A · Pi Purge 私有 Stager** | DeepSeek V4.1 Flash / max | `scripts/loom-v2-pi-purge-stage.mjs`、`scripts/loom-v2-pi-purge-stage.test.mjs` | 从锁定本地源路径只读读取插件文件/License/package，固定 SHA 与安全路径，**仅向显式隔离 staging 目标**复制、给出 plugin tree SHA 与可追溯清单；verify 拒绝源漂移、已有非空目标、软链接路径穿越；测试全部 tmp dir，不碰用户 `~/.pi`。 |
| **B · Coordinator Replay** | GLM-5.3-Flash / Pi 可用 xhigh | `crates/loom-protocol/src/v2_coordinator_replay.rs` | 真实可重放的纯数据 `EventEnvelope` / ordered sequence / generation fence / deterministic replay `CoordinatorState::apply`；重放+乱序/缺洞/时间回退/重复关键 Event 的单测。它不是数据库写入；Root 后续独占注册 `pub mod`。 |
| **C · Capability Materializer Plan** | DeepSeek V4.1 Flash / max | `scripts/loom-v2-capability-plan.mjs`、`scripts/loom-v2-capability-plan.test.mjs` | 四类 Skill/MCP/Rule/Hook 的 per-Runtime support/denial plan 与 evidence 协议，**Selected 不能冒充 Loaded/Invoked**；仅输出 dry-run action manifest，绝不安装真实 MCP/Hook、读用户源密钥；测试 Unsupported/Revoked/Grant 缺失/跨 Bot。 |
| **D · Pi Purge 真 Extension Hook Fixture** | GLM-5.3-Flash / Pi 可用 xhigh | `scripts/loom-v2-pi-purge-hook.test.mjs`、必要时 `scripts/loom-v2-pi-purge-hook-fixture.mjs` | 使用 Node 24（原仓 bundle Node24.14.1）只从本机 pinned `extensions/pi-purge.ts` 加载原扩展，提供**完全隔离伪 Pi ExtensionAPI**、真实调用其 `session_start`、`purge` command 和 `before_agent_start`；校验 Off/Append/Replace/Fallback/Strict 与 session restart 禁用、Strict 丢 AGENTS/Skills 提示、无审批/沙箱越权。零真实模型/设备工具、零网络/用户文件写入；不能把 mock API 说成官方 Pi 进程。 |

**注意**：A/D 二者都不修改 `scripts/package-embedded-pi.mjs`，不依赖另一 Worker 产物；待各自 Root Review+测试后，Root 在独立 sandbox 手工验证 stager 输出与 Pi Bundle 的 `get_commands`/get_state hook 是否真实可加载。若不能由受管 RPC 无模型触发 Pu rge 激活，就如实写 BLOCKED，不能伪造 T30 Pass。

## P1B 真实验收与合入边界

1. 所有 Pi Skill Worker 先只读提交 API/microplan，Root 逐一确认写白名单；写任务 `--agent worker --tools file,write --reasoning max`，没有 shell/MCP/DevicePort；Root 运行全部 tests。
2. 新 Node 测试必须用独立临时 profile/Dir 和 fake Provider；运行前 Root 已读 `docs/development/local-workflow.md`，绝不指向实际用户 Data。任何第三方 Hook 只有在本机 sandbox 且被 Root 审查源码/Hash 后可执行，**不授真实 Grant**。
3. B 新 Rust 文件单独 `rustfmt`，由 Root 最后单点加 `pub mod v2_coordinator_replay;`，再 `cargo test -p loom-protocol --locked --lib`，确保 P1A 62 测仍全通过。
4. E0/E1/E2 是合同/代码/测试；E3 中需要真实上游 Pi Purge Hook 已运行且产生可辨证据（offline fake API），不等于 Provider E4；Pi Bundle `get_commands` 如果实测有 purge 命令只代表扩展已装载，不代表已经启用且 PromptSeen。
5. 最终阶段写入 `docs/loom/LOOM-V2-P1B-ACCEPTANCE-HANDOFF-2026-11-15.md`、Root 更新 Mindkit TASK/LOG/PROJECT_CONTEXT、可视化静态规划看板、AgentDock Task 及 Pi Skill Board 真状态；用户看的是**真实测试和下一步缺口**，非虚假的 P0–P14 15/15。
