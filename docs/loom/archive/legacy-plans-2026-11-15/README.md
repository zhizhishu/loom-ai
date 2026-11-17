# LOOM 历史架构/施工计划封存（2026-11-15）

> **ARCHIVED / READ-ONLY。** 本目录存放从 `docs/loom/` 顶层实际移入的过时计划、交接、静态看板和旧研究证据。旧文本中的「当前」「唯一入口」「已授权开工」只代表其历史时点，不能指导现阶段开发。
> 2026-11-15 曾另保存 16 份原字节 SHA256 快照于 `_artifacts/loom-v2-planning-archive-20261115/`；原始 [manifest.json](manifest.json) 的当时路径/哈希不重写。2026-11-16 本机归档另保存所有整理前字节、链接变更和迁移记录于 `_artifacts/loom-doc-consolidation-20261116/`。少量含未提交 WIP、源码引用的旧文件仍在原路径，带退役含义，但并非当前权威。
> **权威位置**：[文档入口](../../README.md) → [当前实施 E0–E7](../../../../LOOM-IMPLEMENTATION.md)。原 [LOOM V2 蓝图](../../LOOM-V2-MASTER-PLAN.md) 现在只作设计基线。

## A. 旧执行线路 —— 已从「未来施工权威」退役

| 历史文件快照 | 历史意义 | V2 立场 |
|---|---|---|
| [loom-mikka-first-execution-plan-2026-11-15.md](loom-mikka-first-execution-plan-2026-11-15.md) | 旧 Mikka-first/Device-first 实施 v1 计划 | SUPERSEDED：只作经验记录；V2 以 27 页 PDF P0–P14 和新 MASTER 为主 |
| [loom-mikka-first-worker-orders-2026-11-15.md](loom-mikka-first-worker-orders-2026-11-15.md) | 旧 W10/W11/W12 工兵卡 | RETIRED：不可原样再派工，尤其旧 W12 AgentRun→CLI 假设 |
| [loom-mikka-first-execution-board-2026-11-15.md](loom-mikka-first-execution-board-2026-11-15.md) | 旧 AgentDock P0/P1/P2/P3 实施快照 | HISTORICAL_EVIDENCE：3/8 与新 15 阶段没有可换算比例 |
| [loom-mikka-first-progress-2026-11-15.html](loom-mikka-first-progress-2026-11-15.html) | 旧静态 HTML 进度板 | HISTORICAL_SNAPSHOT：不可当 V2 当前实时进度 |
| [loom-mikka-first-implementation-handoff-2026-11-15.md](loom-mikka-first-implementation-handoff-2026-11-15.md) | 老用户数据保护、Pi 工兵、Node E3 证据 | EVIDENCE_ONLY：测试事实保留但架构指令退役 |
| [loom-mikka-first-acceptance-2026-11-15.md](loom-mikka-first-acceptance-2026-11-15.md) | 旧 T0–T22 局部验收 | SOURCE_OF_TEST_HISTORY：新验收按 PDF E0–E7 / T0–T18 + 新多 Agent T19–T22 |
| [loom-mikka-first-plain-language-2026-11-15.md](loom-mikka-first-plain-language-2026-11-15.md) | 旧用户说明 | SUPERSEDED：UI 愿景保留，实施说明非现行 |
| [loom-mikka-first-device-invocation-seam-2026-11-15.md](loom-mikka-first-device-invocation-seam-2026-11-15.md) | W12 证明旧 Run/CLI 与证据运输耦合 | KEEP_AS_FINDING：架构问题仍有价值，旧两文件补丁路线失效 |
| [pi-work-orders-architecture-proposal-2026-11-15.md](pi-work-orders-architecture-proposal-2026-11-15.md) | 旧 Pi 工兵研究/待授权任务集 | SUPERSEDED：不沿用旧写 owner |
| [ultimate-workspace-plan.md](../../ultimate-workspace-plan.md) | 更早的四运行端完整工作空间目标 | HISTORICAL_PLAN：当前实现事实以 v1.72 为准，未来路线用 MASTER |
| [MASTER-HANDOFF-2026-10-28.md](../../MASTER-HANDOFF-2026-10-28.md) | 2026-10-28 曾声称唯一交接入口 | SUPERSEDED：仅当时历史恢复路径 |
| [plan-b-a-controls-b-2026-11-01.md](../../plan-b-a-controls-b-2026-11-01.md) | 旧单脑 A→B 远程计划 | SUPERSEDED：Hybrid 模式不再强制 A 单脑/B 纯手 |
| [single-brain-device-implementation-handoff-2026-11-15.md](single-brain-device-implementation-handoff-2026-11-15.md) | 旧纯 Device WIP 和测试 | EVIDENCE_ONLY：源文件/单测/回执可复用，设计不再是不可违背原则 |

## B. 研究、已有实现事实——不是当前 V2 待办，但不应丢失

| 快照 | 说明 |
|---|---|
| [architecture-discussion-master-plan-2026-11-15.md](../../research/architecture-discussion-master-plan-2026-11-15.md) | 旧 50KB 深度源码调查，RuntimePort、Capability Registry、设备事实源等仍有研究价值，不从这里复制含过时授权的施工结论 |
| [ultimate-interface-contracts.md](ultimate-interface-contracts.md) | 描述 v1 受管 Pi/四端和四能力的实际或候选接口边界；V2 可重新设计但迁移必须读取 |
| [productization-interfaces-2026-11-13.md](../../productization-interfaces-2026-11-13.md) | 已完成的 loom-native UI service 与旧 Core 命令形状，**仍是理解当前安装版本的事实参考**，不能在 V2 尚未发布时把 v1.72 当前运行能力判为失效 |

## C. 归档和留存原则

- 2026-11-15 原字节快照在旧原文件顶部加入退役标识**之前**创建；文件实际存放于 `_artifacts/loom-v2-planning-archive-20261115/`，不改写、不覆盖；本目录 manifest.json 保存原始 SHA256 与快照路径。若将来重做，建立新日期目录，不覆盖原哈希。
- 多数旧文件已经物理迁入本目录并同步修正仓库内相对链接；少量受保护的未提交 WIP 和源码关联文档原位留存。未来开发只能从 `docs/loom/README.md` 与根目录 `LOOM-IMPLEMENTATION.md` 读取当前状态，历史「最新」「唯一入口」「暂停/开工」均不再生效。
- 参考 Git 镜像不在这里移动或删除，位置和 pinned SHA 见 LOOM-V2-REFERENCE-LOCK.md；已存在的隔离工兵代码和原始测试日志仍在 _artifacts。
- 这里冻结的是**未来 Core V2 计划的执行权**，不是物理撤销已发布的 v1.72 API。docs/versions/README.md 中 current_version 仍由现行版本治理规则控制。不得在未迁移用户数据的情况下删除产品当前所用接口。
- 原 27 页 PDF 是用户在对话中提供的蓝图，尚未确认本机存在 PDF 文件；本索引不编造它的本机地址。

## D. 2026-11-16 整理留痕

本次将 46 份历史 Markdown 与 2 份静态 HTML 从 LOOM 顶层物理归入此目录，另将 5 份未冻结研究放入 `docs/loom/research/`，不删除原始证据。每份原路径、归档路径、原字节及更新链接见本机 `_artifacts/loom-doc-consolidation-20261116/applied-manifest.json`；它是可恢复清单，不是第二份项目计划。
