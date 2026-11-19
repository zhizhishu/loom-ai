# LOOM 未来 Pi Skill 多路工兵工单（待批准执行的设计稿）

> **历史归档 / RETIRED_SCOUT_CARDS / 不再作为 Core V2 施工指令。** 用户最新要求「本轮只整理架构、不开工」，后续唯一入口：[LOOM V2 总计划](../../LOOM-V2-MASTER-PLAN.md)。此文件原始正文与当时测试结论仅作历史证据；原字节 SHA256 快照在 [历史归档](README.md)。**不得依据下文旧“已授权开工/唯一入口”重新派工**。

> **NOT AUTHORIZED FOR IMPLEMENTATION**：用户当前要求“讨论架构→形成完整计划→再决定动手”。以下是**未来**可直接分发的工单规格，不是此刻运行指令。现在仅可启动 `agent=scout` / `tools=file` 只读调研；所有 `worker` 写入需 P1 合同通过和用户新一轮明确允许。主文：[architecture-discussion-master-plan-2026-11-15.md](../../research/architecture-discussion-master-plan-2026-11-15.md)。

## 0. 工兵协作总合同

- **主管独占**：架构决策、Core/DB/安全合同、跨模块集成、品牌/UI 最终操作、真实设备授权、测试与 Git 提交/推送。Pi 工兵不得替主管“自动验收”。
- **模型**：研究与未来对照试验仅用用户指定 `oct-chat/deepseek-v4.1-flash`、`reasoning=max`；**Claude 不执行**；若模型不可用标 `BLOCKED`，不偷偷 fallback。
- **开始前读取**：`AGENTS.md`、`docs/README.md`、当前版本/决策/合同、`DESIGN.md`（UI）、`TASK.md`、两份讨论方案、`docs/loom/ultimate-interface-contracts.md`。任何参考仓只能读。
- **范围**：每个工兵最多一个明确文件/目录 owner，写白名单必须是**精确路径**。所有共用 `lib.rs`、`mission.rs`、`nodes.rs`、`product.css` 等由主管或指定唯一 integrator 合并；不让四个工兵同时改同一文件。
- **禁止**：`git reset/clean`、全仓格式化、强制覆盖历史 WIP、执行未知 Skill/Hook、修改 `~/.claude`/`~/.pi`/`~/.dsh`、操作用户生产 DSH/Octopus/浏览器 Profile、运行任意公网服务、安装 Windows Service/macOS launchd、导出密钥、提交/推送。
- **验收回执**：每个工单交 `RESULT / EVIDENCE(file:line,sha) / CHECKS(真命令,exit,log) / NEGATIVE_CASES / BLOCKERS / STATUS(PASS|FAIL|NOT_RUN) / ROLLBACK`。主管必须独立运行测试、审查 diff、比对数据根和系统进程，才能标 `ACCEPTED`。
- **小阶段交接**：更新 `TASK.md` + `docs/loom/` 对应交接 + `_artifacts/loom-architecture-20261115/` 证据，保持用户可恢复。每次改产品前独立 Git diff patch + 文件 SHA + 隔离数据快照；不自动清理旧 WIP。

## 1. 依赖 DAG（不要乱并行）

```text
P0(备份/冻结)
  ├─ R01 Mikka/UX 只读
  ├─ R02 MindFS/DeskFleet/UFO 只读
  ├─ R03 MOVO/AgenTeam/DSH/Pi 只读
  └─ R04 LOOM Core/能力/内存/OS 只读
           │
           ▼
P1 Bot/Goal/Device/Grant/RuntimePort/DevicePort 合同评审
           │
     ┌─────┴─────┐
     ▼           ▼
P2 Pi Spike   P2 DSH Spike（相同 DeepSeek 模型）
     └─────┬─────┘
           ▼
P3 Node Tool Mode + Core ToolRouter/Grant
           │
           ▼
P3 双设备同一父 Goal E2E + 全部负例
     ┌─────┼────────┬──────────┐
     ▼     ▼        ▼          ▼
P4 File  Terminal Browser  Computer
     └─────┬────────┴──────────┘
           ▼
P5 四能力/记忆与真实激活回执
           │
           ▼
P6 主管 UI / Logo / 手感与性能
           │
           ▼
P7 Linux A + Win B + macOS C 真实单用户
           │
           ▼
P8 组织/多用户（后置）
```

## 2. 可直接分发的工单

### R01｜Mikka Bot / 右栏 / 注意力系统（只读 Scout）

- **目标**：用源码还原 Mikka Bot vs Agent、Bot Overview/`@ui-slot`、Factory 派工、Question/Attention、Memory、Computer broker、Local/Cloud routing；说明公开仓和私有 UI 的边界。
- **READ**：`_artifacts/reference-repos/mikka-current/docs/design/glossary.md`、`components/nav/context-panel.tsx`、`bot-overview.tsx`、`lib/coordinator`、`lib/factory`、`lib/profile/memory.ts`、`packages/daemon/src`。
- **WRITE**：仅 `_artifacts/loom-architecture-20261115/pi-mikka-scout.txt`（由主管保存工兵回执）。
- **DONE**：至少 12 个 `path:line`、一条 Bot 目标→Agent Run→结果回 Bot 的源码调用链、两项需注意的风险（默认电脑授权等）；标明未能看到的私有 overlay。
- **禁止**：执行 Mikka、在共享环境安装依赖。代码本身许可可用，可直接复制到 LOOM。

### R02｜MindFS / DeskFleet / UFO³ 设备控制（只读 Scout）

- **目标**：区分 Tool Node 和 Local Runner，查设备注册、连接方向、FS/PTY/Browser/Screen 能力、认证与授权边界；纠正“MindFS 有通用远端 PTY/桌面”的无证据说法。
- **READ**：`_artifacts/reference-repos/{mindfs-current,deskfleet,ufo-galaxy}` 的相关 `server/internal`、`apps/daemon`、`galaxy`、`ufo`。
- **WRITE**：仅保存只读回执；不运行任何仓库服务。
- **DONE**：每个项目至少 6 个 `path:line`，输出 T/R/H 设备模式可复用的设计，说明未知/未验证的鉴权路径；安全漏洞静态推断须单列 `UNVERIFIED`，不冒充真实攻击复现。

### R03｜DSH / Pi / MOVO / AgenTeam 能力与许可（只读 Scout）

- **目标**：核对 DSH Cordis Plugin/Profile/Tool guard/沙箱强制、Pi RPC/Extensions/MCP/Skills/Rule/Hook、MOVO Host 封包、AgenTeam Approval 与 Workspace 根；许可证清单。
- **READ**：`_artifacts/reference-repos/{deepseek-harness,movo,agenteam}`、父级 `_references/pi-agent`。
- **WRITE**：仅只读回执。
- **DONE**：输出 `Skill/MCP/Rule/Hook` × `Pi/DSH/Codex/Claude` 的 `native/adapter/unsupported/unknown` 矩阵；**不能**把 Pi fork 的 MCP 功能说成缺失，也不能把 DSH Windows ACL partial 说成 full。

### R04｜LOOM 当前能力/合同/数据库（只读 Scout）

- **目标**：定位 `Bot/AgentProfile`、Mission/Camp/Task/AgentRun、Node R1/R2/B7、Computer、Workspace、Memory、四能力、RuntimeAdapter 的现有真源与缺口。
- **READ**：`crates/rovai-core`、`crates/rovai-web`、`crates/loom-node`、`crates/loom-protocol`、`apps/desktop/src/renderer/src/loom-native`、当前版本/合同。
- **WRITE**：仅只读回执。
- **DONE**：当前接口/数据表映射、最小迁移候选、历史 `--device-only` 单测 10053 原因待查、双节点 fixture NOT_RUN；**不能**把同一 Run 跨 B/C 当作用户已定的硬要求。

### A01｜Bot/Goal/Run 领域合同（主管设计，Pi reviewer 只读）

- **依赖**：R01–R04 完成；用户明确选择要继续设计。
- **产物**：`docs/loom/` 下新的 Bot/Goal/Step/Run/Device/Root/Memory/Grant 词典、领域图、旧 `agentId`/`campId` 兼容表；G 路线（一个 Goal 多 child Runs）与 M 路线（一个 Run 多 DevicePort 工具）的对照。
- **禁止**：直接修改 `mission_schema.sql` 或 `agent_profile` 表。
- **Gate**：主管评审无双账本、旧 MissionWorkspace/清理/版本迁移路径明确。

### A02｜RuntimePort / DevicePort 候选 IDL（主管设计，Pi reviewer 只读）

- **依赖**：A01。
- **产物**：`RuntimePort` 的 start/stream/steer/approve/cancel/recover/settled；`DevicePort` 的 typed tool envelope/receipt、grantId/epoch/requestId/deadline/unknown；现有 R1/R2/B7/ComputerPort 的复用/新增版本表。
- **禁止**：先写任意 Shell/远端 Desktop 协议。
- **Gate**：设备离线、拒绝、重放、权限变更、版本不兼容均有明确行为。

### E01｜Pi RuntimePort Spike（未来 Worker，独占新适配目录）

- **建议 WRITE_ALLOWLIST**：仅新 `crates/rovai-core/src/runtime_ports/pi.rs` 与对应隔离测试；`agent_runtime_adapter.rs` / `runtime.rs` 由主管合并注册。
- **依赖**：A01/A02 合同通过。
- **DONE**：DeepSeek V4.1 Flash/max 真 RPC `prompt→tool_call→agent_settled`；Skill/MCP/Rule/Hook 各 1 真例；中途 cancel/进程崩溃/恢复；无其他模型 fallback。
- **NEGATIVE**：启动失败、MCP 连接失败、Hook 拒绝、用户撤销；不能把 prompt accepted 当最终完成。

### E02｜DSH RuntimePort Spike（未来 Worker，独占 DSH Host）

- **建议 WRITE_ALLOWLIST**：新 `packages/loom-dsh-host/` 或同等隔离目录 + `crates/rovai-core/src/runtime_ports/dsh.rs`；Core 现有共用文件只由主管改。
- **依赖**：A01/A02 合同通过。
- **DONE**：锁 DSH 版本/许可证/生产 profile；Cordis 插件 inventory 与 `loaded` 真回执；DeepSeek 同模型真 Run、四能力各 1 例、guard/approval、crash/recover/uninstall。
- **NEGATIVE**：未知插件、Windows sandbox partial、插件加载失败、Profile 污染/泄密；无真实证据不选 DSH 默认。

### D01｜Node Tool Mode / 10053（未来 Worker，独占 Node 三文件）

- **建议 WRITE_ALLOWLIST**：`crates/loom-node/src/lib.rs`、`session.rs`、`process_wire.rs`，此三文件由**同一个工兵独占**，不得与其他工兵并行写。
- **依赖**：A02 + E01 或 E02 真 RuntimePort；先保存历史 WIP patch。
- **DONE**：修 `cargo test --offline -p loom-node --lib` 的 10053 失败并复跑；无 CLI 的 Tool Node Hello 不声明 R1、误投 Start/Open 拒绝，R2/Computer 有界保留；真实 Windows/Unix 分别验证。
- **NEGATIVE**：WebSocket 假服务端关闭、重复请求、错误 R1 命令、重连代次；不能改测试断言来遮蔽真实拒绝缺陷。

### D02｜Core ToolRouter / Grant（未来 Worker，独占新模块）

- **建议 WRITE_ALLOWLIST**：新 `crates/rovai-core/src/device_tool.rs`、`crates/rovai-core/src/device_grant.rs`、`crates/loom-protocol/src/device_tool.rs`；现有 `lib.rs`/`nodes.rs`/DB migrations 由主管统一集成。
- **依赖**：A02。
- **DONE**：每次工具调用绑定 actor/goal/step/run/device/root/capability/grant/epoch/requestId；Node 独立拒绝越权；结果/未知/审计/取消/幂等存档。
- **NEGATIVE**：过期 grant、错误设备、篡改 digest、旧 epoch、路径逃逸、无审批答复；没有 Node 真拒绝不报权限完成。

### D03｜真实双 Node + 同父 Goal E2E（未来 Worker，独占测试文件）

- **建议 WRITE_ALLOWLIST**：新 `tests/e2e/loom-device-port/`（精确文件清单在 A02 冻结），**不要只留在忽略的 `_artifacts`**；生产源码不得改。
- **依赖**：D01/D02 真构建。
- **DONE**：一台隔离 A Core + 两个隔离 Node（B/C 均无 Agent CLI）+ 一个**持久父 Goal** + 两个不同设备 Step/Run；A 真 Pi/DSH 模型发出有界工具调用、结果哈希与证据归档；断连/撤销/重复/错误设备负例。
- **NEGATIVE**：仅两个互不相关 camp 的旧脚本、AST parse、编译通过都**不算**“一个 Bot 协调两设备”。

### T01｜FilePort（未来 Worker）

- **建议 WRITE_ALLOWLIST**：新 `crates/loom-node/src/device_tools/file.rs` + `crates/loom-node/tests/device_file.rs`；Node 共享注册由主管集成。
- **DONE**：rootId/canonical path/文件身份、读/写/移动/原子替换/摘要/限额；Windows junction/reparse/UNC/ADS、macOS/Linux symlink/TOCTOU；读写审计与撤销。
- **NEGATIVE**：越根、链接跳转、非幂等重复写、文件修改后 hash 失配。

### T02｜TerminalPort（未来 Worker）

- **建议 WRITE_ALLOWLIST**：新 `crates/loom-node/src/device_tools/terminal.rs` + 专项测试。
- **DONE**：固定命令或显式审批的 Shell/PTY、stdin/resize 若声明支持则真实有证据、输出限额、子进程树停止/回收、超时/unknown。
- **NEGATIVE**：Shell 注入、孤儿进程、取消后仍有副作用、环境变量/密钥泄漏。

### T03｜BrowserPort（未来 Worker）

- **建议 WRITE_ALLOWLIST**：新 `crates/loom-node/src/device_tools/browser.rs` + 独立受管测试浏览器 fixture。
- **DONE**：受管 Profile、URL/网络域权限、导航/截图/点击/表单/下载，用户账号交接与日志脱敏；工具不可见默认浏览器私密资料。
- **NEGATIVE**：SSRF/内网、未授权 Cookie、关闭后残留控制、登录态跨 Bot 泄漏。

### T04｜ComputerPort / OS companion（未来 Worker，按平台独占）

- **建议 WRITE_ALLOWLIST**：既有 `crates/loom-node/src/computer_provider.rs` 和 `crates/rovai-web/src/computer/node_provider.rs` **由主管或单一专人**负责；Windows/macOS/Linux OS provider 另开独立文件，避免同改。
- **DONE**：view / human-control / agent-control 分离；现有远端 Computer 人控 API 已存在，但 `computer_agent.rs:1418-1466` **只绑定本地 Host**，须新增受控远端 AgentGrant 路由；先沿用屏幕 bounds→deviceId 的现有撤销栅栏，必要时才增 displayGeneration；Windows UU/RDP 无实体屏、macOS TCC、Linux Wayland/XDG provider 实机。
- **NEGATIVE**：Session0 伪屏幕、锁屏后旧输入继续、旧 frame 复用、无授权的桌面注入。

### C01｜四端 SourceScanner（未来 Worker，独占只读扫描模块）

- **建议 WRITE_ALLOWLIST**：新 `crates/rovai-core/src/capability_sources/` 下 Claude/Pi/DSH/Codex 各独立 scanner；已有 `member_capability.rs`/DB 表由主管统一接线。
- **DONE**：四类能力来源/版本/摘要/冲突/错误；Claude 只读，敏感字段脱敏；扫描不执行 Hook/Skill。
- **NEGATIVE**：大配置文件、符号链接、秘密泄漏、跨端同名不同版本、损坏配置；未扫描不显示“0 项”。

### C02｜有效能力快照与 Runtime Materializer（未来 Worker）

- **建议 WRITE_ALLOWLIST**：新 `crates/rovai-core/src/capability_materializer/`，与 C01 不重叠。
- **DONE**：`discovered→inspected→selected→loaded→invoked` 状态分离；Pi/DSH 的 Skills/MCP/Rules/Hooks 真回执与 `unsupported`；审批与 Node Grant 独立。
- **NEGATIVE**：勾选但未加载、Hook 事件不匹配、MCP 启动失败、撤销后仍调用。

### M01｜Bot/Project Memory（未来 Worker，主管掌控数据库）

- **建议 WRITE_ALLOWLIST**：先仅新 `crates/rovai-core/src/bot_memory_projection.rs` / 专项测试；任何 DB migration、`memory.rs`、`mission_schema.sql` 由主管审核并独占。
- **DONE**：Bot/Chat/Project/RunEvidence 四层、来源/权限/删除/恢复/检索引用、设备离线仍能回忆；迁移后旧记忆无丢失。
- **NEGATIVE**：跨 Bot/项目泄漏、已删记忆仍检索、未经允许把秘密写到 Pi/DSH 全局配置。

### U01｜Mikka 式 UX/品牌/性能（**主管亲自实现**）

- **主管 WRITE_ALLOWLIST**：`apps/desktop/src/renderer/src/loom-native/Inspector.tsx`、`product.css`、`LoomApp.tsx`、`Avatar.tsx` 与经批准的 `public/` 资产；Pi 工兵只做 read-only 对照和专项回归。
- **DONE**：图三透明 Logo/favicons、眼随鼠标/reduced-motion、右侧 1/3 Hero、四 Tab 下移、蓝点编辑、三栏拖宽/重开、工作/审批卡、默认/多根目录、可见设备/授权。
- **NEGATIVE**：短屏/触屏/DPR2、RDP/UU、1k 对话滚动、焦点丢失、改 Logo 覆盖助手头像。**真实鼠标拖拽、截图、帧时指标**必须亲验。

### O01｜Linux A / Win B / macOS C 云端单用户部署（主管授权后）

- **建议 WRITE_ALLOWLIST**：独立部署脚本/配置模板/安装包，禁止生产凭据和用户日常服务。
- **DONE**：先评审 `rovai-web/src/nodes.rs:2005-2033` 当前 **loopback-only pair/connect** 的安全网关改造，不能直接关掉限制；随后设备主动出站、一次性配对、TLS/设备身份、凭据轮换、升级/卸载/回滚、A 重启恢复、B/C 断网、不同 OS 文件/屏幕/权限能力报告；手机/另一电脑登录同 Bot。
- **NEGATIVE**：误入生产数据根、公网开放 Node 管理端口、离线重放写入、UI 误报“电脑在线有屏幕”。

### O02｜多用户企业层（后置，非当前产品开发）

- **建议 WRITE_ALLOWLIST**：另行设计 tenant/role/ACL/migration，绝不提前改单用户 Core 默认行为。
- **DONE**：组织 Skill/知识/RAG、设备共享、权限审批链、审计、配额、租户隔离、可删数据与许可证核查。
- **NEGATIVE**：跨租户读写/凭据/记忆、用户退出组织后设备授权仍有效。

## 3. 主管阶段性验收模板

每个阶段填写：
```text
Stage / Commit(or WIP SHA) / Source HEAD
Plan approval: approved | discussion_only
Worker IDs + file ownership + actual diff
Build/typecheck/unit/integration/e2e: command, exit, log
Real model: provider/model/thinking, request/settled receipts
Device: B/C identity, OS, mode T/R/H, isolation roots, no secret export
Permissions: Ask/Never/Full, real deny, revoke, replay, unknown
UI: screenshot, drag, FPS/input-latency, reduced-motion, short-window
Rollback: restore tested | not_run
Conclusion: PASS_FOR_RECORDED_SCOPE | FAIL | BLOCKED | NOT_RUN
Remaining gaps: ...
```

**不可降级的判定**：只读 Scout 报告不是实现；Pi 工兵 `completed` 不是测试通过；编译不是实机；两个独立 camp 不是同一个 Bot 目标；`Full` 不是 OS 沙箱；图片已上传聊天不是 Windows 已有 PNG；Windows 本机预览不是 Linux 云端上线。

**目前所有 E/T/C/M/U/O 工单均为未来候选，不应立即派写入工兵。** 先交付/讨论方案，用户认可后再按 Gate P0/P1 → P2… 分阶段批准。
