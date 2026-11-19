# LOOM 文档导航

> **本页只负责找文件。** LOOM V2 是正在施工的下一代产品；仓库已发布版本仍由 [versions](../versions/README.md) 的 `current_version` 管理（当前 v1.72），整理文档不修改它。

外层 `skill-cli/` 是独立的 Skill/Hook/Rule/MCP/CLI 治理仓；本仓 `loom/` 是独立产品仓。父仓的技能源不是 LOOM 的业务事实，LOOM 不修改用户 `~/.claude` 配置、凭据或父仓任务。

## 现行计划只有三份（2026-11-18 起）

| 需要了解 | 只看这一份 |
|---|---|
| 架构、已拍板决定、每层直接复用哪个开源的哪个文件 | [LOOM-ARCHITECTURE.md](LOOM-ARCHITECTURE.md) |
| 交接、复用硬规则、当前状态、施工顺序、工单模板 | [LOOM-HANDOFF.md](LOOM-HANDOFF.md) |
| 验收门禁、复用验收、T 系列场景、“个人版可用”定义 | [LOOM-ACCEPTANCE.md](LOOM-ACCEPTANCE.md) |

## 其它权威文件

| 需要了解 | 看这里 | 边界 |
|---|---|---|
| 用户要什么、长期 Bot、未来企业扩展 | [PRODUCT.md](../../PRODUCT.md) | 产品目标，不声明代码已完成 |
| 已批准的 Mikka/PiBot 三栏 UI 与猫耳品牌 | [DESIGN.md](../../DESIGN.md) | 视觉唯一真源 |
| **现在开发到哪、哪些未通过** | [LOOM-IMPLEMENTATION.md](../../LOOM-IMPLEMENTATION.md) | **进度唯一真源** |
| 参考项目固定版本、许可、主体/参考分级 | [LOOM-V2-REFERENCE-LOCK.md](LOOM-V2-REFERENCE-LOCK.md) | 固定快照，不等于已集成 |
| 个人预览包说明（CI 打包引用） | [LOOM-PERSONAL-CANDIDATE.md](LOOM-PERSONAL-CANDIDATE.md) | 隔离启动，不代表正式发行 |
| 机读草案 | `loom-v2-*.schema.json` | 讨论草案，未晋升正式 Wire Contract |

## 归档

- [archive/plans-2026-11-18](archive/plans-2026-11-18/README.md)：2026-11-18 合并前的全部计划书、交接书、阶段合同与研究稿（旧 V2 设计基线、产品接口边界、Pi Purge 合同、P1 切片、各次交接等）。只作溯源。
- [archive/legacy-plans-2026-11-15](archive/legacy-plans-2026-11-15/README.md)：更早的方案与看板。

## 防膨胀规则

- 阶段结果直接更新 `LOOM-IMPLEMENTATION.md`，原始回执存 `_artifacts/` 并引用。
- **不再新建** `*-handoff.md`、`*-master-plan.md`、阶段计划书或“最新进度”第二真源；要改计划就改上面三份。
- 改协议、安全、当前版本的正式 Architecture/Contract/Decision，仍遵守 [长期架构](../architecture/README.md)、[Contracts](../contracts/README.md)、[当前决定](../decisions/CURRENT.md)与[版本治理](../versions/README.md)。
