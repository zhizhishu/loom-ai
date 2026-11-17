# LOOM 文档导航

> **本页只负责找文件，不记录进度、不签发新计划。** LOOM V2 是正在施工的下一代产品；仓库已发布版本仍由 [versions](../versions/README.md) 的 `current_version` 管理（当前 v1.72）。旧交接、讨论稿和阶段看板一律不覆盖下面的权威文件。

## 与父项目的单一职责接口（2026-11-16）

外层 `skill-cli/` 是**独立 Git 四端 Skill/Hook/Rule/MCP/CLI 治理仓**；本仓 `loom/` 是**独立 Git 产品仓**。不能把父仓技能源或同步结果视为 LOOM 的业务事实，也不能让 LOOM 修改用户 `~/.claude` 配置、凭据或父仓任务。

产品真值由 LOOM Core 拥有；正式 Wire、状态机、权限去 [Contracts](../contracts/README.md) 与 [Architecture](../architecture/README.md)。[产品接口边界](productization-interfaces-2026-11-13.md) 负责标明 RuntimePort / Capability / DevicePort / Artifact Review 的 Owner、应用回执和未验范围；[当前 E0–E7](../../LOOM-IMPLEMENTATION.md) 负责实际实证。V2 [冻结蓝图](LOOM-V2-MASTER-PLAN.md) 不替代目前已发布 `v1.72` 的版本治理。


## 只需要知道这些入口

| 需要了解 | 只看这一份 | 边界 |
|---|---|---|
| 用户要什么、长期 Bot、单聊/群聊、未来企业扩展 | [PRODUCT.md](../../PRODUCT.md) | 产品目标，不声明代码已完成 |
| 已批准的 Mikka/PiBot 三栏 UI、粉发绿眼猫耳品牌 | [DESIGN.md](../../DESIGN.md) | 视觉唯一真源；保留 `loom-native` |
| **现在开发到哪、E0–E7、哪些未通过** | [LOOM-IMPLEMENTATION.md](../../LOOM-IMPLEMENTATION.md) | **当前实施/验收唯一真源** |
| Claude/Codex/DSH/Pi、四能力、Core/UI/Device 接口 | [productization-interfaces](productization-interfaces-2026-11-13.md) | 只描述有来源的当前接口及明确的设计目标 |
| Mikka、PiBot、ROVAI、ACCP、AgenTeam、MOVO、DeskFleet、MindFS、UFO³ 等参考项目 | [LOOM-V2-REFERENCE-LOCK.md](LOOM-V2-REFERENCE-LOCK.md) | 13 个固定本地快照、许可、引用边界；不等于已集成 |
| P0–P14 的原始深度架构设计 | [LOOM V2 设计基线](LOOM-V2-MASTER-PLAN.md) | **冻结蓝图，仅供设计溯源，不是实时开发书** |

## 需要实证或实施细节时

- [2026-11-16 真实模型与恢复验收记录](LOOM-LIVE-ACCEPTANCE-2026-11-16.md)：原始阶段证据；完成度仍由根目录 `LOOM-IMPLEMENTATION.md` 汇总。
- [个人预览包说明](LOOM-PERSONAL-CANDIDATE.md)：隔离启动和退出，不代表正式发行。
- [P1 协议切片](LOOM-V2-P1-FOUR-LANE-SLICE-2026-11-15.md)、[原生 Pi 阶段回执](LOOM-V2-P1B-ACCEPTANCE-HANDOFF-2026-11-15.md)、[Pi Runtime 子合同](LOOM-V2-P1B-PI-RUNTIME-INTEGRATION-2026-11-15.md)、[Pi Purge 原生扩展合同](LOOM-V2-PI-PURGE-EXTENSION-PLAN.md)：为保持已有源码证据路径，暂留顶层，**不是新的总体计划或当前进度入口**。
- `loom-v2-*.schema.json`：可机读讨论草案，未自动晋升为正式当前 Wire Contract。
- [未冻结的技术研究与提案](research/loom-v2-universal-architecture-and-ports-proposal-2026-11-15.md)、[Runtime/能力研究](research/loom-v2-runtime-bundles-and-capability-selection-proposal-2026-11-15.md)、[Persona/Memory 安全实验研究](research/LOOM-V2-PERSONA-MEMORY-AND-SECURITY-LAB.md)：只读研究，不覆写 Core 授权。
- [历史归档](archive/legacy-plans-2026-11-15/README.md)：早期 Mikka-first、ACCP、单脑设备、方案 B、旧 P1 交接/计划和静态看板；**都不再自称最新**。

## 唯一权威与防膨胀规则

- Core 仍是唯一真实事实、权限与审查 owner；LOOM UI 不创建第二套业务数据库。ACCP 是协作控制面借鉴，**不等于** ACP 协议，更不是第五 Runtime。
- 云端执行采用三种待验模式：纯 Tool Node、可选 Local Runner、两者 Hybrid。设备在线、TLS 连通、设备配对、工作区授权和图形控制不能互相冒充。企业多租户/RBAC 是未来方向，未通过实际隔离验收。
- 新阶段结果**直接更新** `LOOM-IMPLEMENTATION.md`，原始回执存独立证据目录并引用；**不要再创建 `*-handoff.md`、`*-master-plan.md` 或 “最新进度” 的第二真源**。
- 修改协议、安全、当前版本的正式 Architecture/Contract/Decision 时，仍遵守 [长期架构](../architecture/README.md)、[Contracts](../contracts/README.md)、[当前决定](../decisions/CURRENT.md)与[版本治理](../versions/README.md)；整理文档不修改 `current_version`。
