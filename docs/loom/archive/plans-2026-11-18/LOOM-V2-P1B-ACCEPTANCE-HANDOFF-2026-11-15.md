# LOOM V2 P1-B · 四路工兵 + 真 Pi RPC 首次签收（2026-11-15）

> **P1-B ACCEPTED · E2 PASS、E3 受限 PASS；E4 真 Provider PromptSeen / Bot→Artifact NOT_RUN。** 工作总管根 `C:/Users/echo/Downloads/claude/skill-cli`；子仓 `loom/`。此阶段 Root 验收四路真实 Pi Skill 工兵和两个独立 Pi 0.85.1 Runtime；不是 P0–P14 全产品完成。上一阶段 [P1-A 验收](../legacy-plans-2026-11-15/LOOM-V2-P1A-ACCEPTANCE-HANDOFF-2026-11-15.md)，本阶段 [合同](LOOM-V2-P1B-PI-RUNTIME-INTEGRATION-2026-11-15.md)，下一阶段 AgentDock `tsk_a21d75f405171f22` 正持续进入 Core/Runner/UI 真接线。

## 真实完成的可复验功能

| 子线 | 新增资产 / 真执行结果 | Root 的验收边界 |
|---|---|---|
| **A·安全 staging** | `scripts/loom-v2-pi-purge-stage.mjs` 与 `.test.mjs`；**Node 29/29 PASS**。上游 Pi Purge 0.3.0 固定 Git `d0196ccfd773b0ed342bd2f25372aff65f1a4a53`，Root 真正以 `--apply` 复制 3 个明确允许文件到父项目私有 `.../_artifacts/loom-v2-20261115/p1b-sandbox/pi-purge-stage-v030`，随后 `--verify` exit0。Tree SHA256 `69ae4267a250afb915c9f63cc2ccaf8d46a0c0a4048813cd96b102ea9fe1f9ce`。| 仅 staged_files_only，不说明 loaded/PromptSeen；拒非空目标/路径越界/软链/源漂移。|
| **B·ACCP Replay** | `crates/loom-protocol/src/v2_coordinator_replay.rs` + Root 唯一 `lib.rs` 入口；原 Rust 62 + 新 14 = **76/76 PASS**。支持有序 EventEnvelope/成功与拒绝均记账/时间倒退与伪造回执拒绝。 | 纯内存，不代表 Core 已持久化 / Owner Review 已接受。|
| **C·四能力物化计划** | `scripts/loom-v2-capability-plan.mjs` + `.test.mjs`；**Node 17/17 PASS**。Skill/MCP/Rule/Hook dry-run action/拒绝跨 Bot、缺 Grant、Revoked 与假 Load/Invoke。 | 所有 action 仍 dryRun；没有真正安装或调用 MCP/Hook。|
| **D·真上游 Hook 模拟宿主** | `scripts/loom-v2-pi-purge-hook-fixture.mjs` + `.test.mjs`；**Node 16/16 PASS**。`pi-purge.ts` 原字节 SHA256 `983a3c3cc3011928a33805d84414060729fd2aa81822bc7ba94008943a65d71d`，真实动态 import 上游 Extension、调用 `session_start` / `before_agent_start` / `purge` command，覆盖 Off/Append/Replace/Fallback/Strict、重启 reset、source 回滚。 | 真 Hook 函数在 mock ExtensionAPI 调用；并非 Pi Provider 传入的真实 Prompt。Strict 确实丢 AGENTS/Skills 提示词，不能用于生产默认。|

### Root 独立测试命令和进程证据

- `cargo test -p loom-protocol --locked --lib` → **76 passed, 0 failed, exit0**。最后复核 AgentDock `session-fc6c01fe3b7ac13b43ea1bf8`；新 Replay 文件 `rustfmt --check` PASS。
- `node --test scripts/loom-pi-purge-bridge.test.mjs scripts/loom-v2-pi-purge-stage.test.mjs scripts/loom-v2-capability-plan.test.mjs scripts/loom-v2-pi-purge-hook.test.mjs` → **78 passed, 0 failed, exit0**，AgentDock `session-b2b9e429701cbc7d19ce3b8e`。
- 固定 Pi 0.85.1 包源 `resources/runtime/pi/pi.exe`，原 bundle `node scripts/package-embedded-pi.mjs --verify --destination resources/runtime/pi` → **exit0**，tree SHA256 `5692cc77a900ec7fccc8b6e9dcc6648b8ec42d81e83b627cd06c21fd0707c871`（上阶段实测，本阶段继续用该原包）。
- 真 Pi **离线 JSONL RPC**（`--mode rpc --no-session --no-tools --offline --no-context-files --no-skills --no-themes --no-extensions --extension <私有stage pi-purge.ts> --approve`；显式隔离 PI_CODING_AGENT_DIR）→ `get_commands` 成功列出名称为 `purge` 的真实 extension command，且 `sourceInfo.path` 对应私有 stage，`get_state` 的 `messageCount:0`；AgentDock `session-31ab97a828d920396f19658f`。
- 真 Pi RPC 依次 `/purge on`、`/purge mode append`、`/purge status`：原上游扩展通知“已开启”和“模式 append”，命令 response success，`get_state.messageCount:0`，未触发模型；AgentDock `session-676dd036c1504709cf842ca8`。
- **两独立 Bot profile 真并发测试**：Pi A (`session-fb9f8099a0e259ccbf6de44f`) 启用 append，Pi B (`session-2d5855053fa91f56efd013e5`) 状态仍“关闭、strict”，两个 `sessionId` 不同，双方 `messageCount:0`。证明进程级隔离与重置初态，**不等于 Core 多 Bot 持久化/故障恢复 T32**。
- 根项目防护检查 AgentDock `session-4f3ffd41a0ee61c7b4be5bb3`：五处原 UI/Node WIP SHA **5/5 unchanged**，`git diff --check` PASS、新 Rust 文件 rustfmt --check PASS、Mindkit guard verify PASS；现有服务 64851 仍有 pid12944 listener。

## 非绿门禁 / 对上游的真实反馈

- 原真实 `pi-purge.ts` 对未知子命令 `bogus` 的通知级别为 **info** 而不是 **error**（default `notify` 无 level）；D 工兵第一轮断言 `error` 导致 15/16，Root 根据上游源码修正测试后 16/16；这是一处**原上游行为风险**，不能写成拒绝模式均 error。非法 mode/不存在 source 才是 error。
- 现有全 crate `cargo fmt --check -p loom-protocol`、`cargo clippy --all-targets -- -D warnings` 尚有历史 style/lint 阻塞（以及单个新 B lint），`pnpm docs:check` 原 v1.72 历史审批元数据阻塞；**未签全绿**。Root 没有批量重排旧文件或伪造批准。
- **E4 未完成**：UI 勾选 Pi Purge → Core 冻结 Bot/Persona/Capability → 受管 Pi `session_start` 后确实在模型请求之前激活 → `before_agent_start` 改写 **Provider 实际收到的 Prompt** → 产物 Artifact/Owner Review。`get_commands` 和 `/purge on` 不等于这一条闭环。
- **E5/E6/E7 未跑**：另一物理 Windows/Linux/Mac、断电恢复、线上生产监控。P0–P14 整体 Gate 不因为 154 单测绿而显示 15/15。

## 向 P1-C / P2 / P8 / P9 交接

- Root 新任务 `tsk_a21d75f405171f22` 正继续四路 Pi Skill 的 Core 单库事件持久化（`crates/rovai-core/src/loom/v2_coordinator_adapter.rs`，先新增文件、再由 Root 安全注册/migration）、可重复受管 Pi RPC Supervisor（`scripts/loom-v2-managed-pi-rpc.mjs`）、用户可见且不造假的 Team/Worker/Artifact 事实适配（`v2-run-service.ts`），以及真正隔离 Runner/Artifact E3/E4 测试。
- 最小下轮成功标准：至少一个隔离数据根产生 `Goal → Worker/Run → typed Receipt → Artifact → Review` 实证，当前这一步仍 **NOT_RUN**；不碰现有 64851/真实用户 DB、五处 WIP/全局 Pi/DSH/云端 Bero/GitHub，Pi Skill 看板仍是本机 `http://127.0.0.1:8767`。
