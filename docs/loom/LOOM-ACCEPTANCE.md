# LOOM 验收标准（唯一现行版）

> **现行文档。** 本页定义“什么算过”；“现在过了没有”只记在根 [LOOM-IMPLEMENTATION.md](../../LOOM-IMPLEMENTATION.md)。架构看 [LOOM-ARCHITECTURE.md](LOOM-ARCHITECTURE.md)，施工规则看 [LOOM-HANDOFF.md](LOOM-HANDOFF.md)。旧验收书与阶段回执在 [archive/plans-2026-11-18](archive/plans-2026-11-18/README.md)。

## 1. 三条铁律

1. **测试脚本存在 ≠ 测试跑过；运行端回应 ≠ 成果已验收；截图 ≠ 长任务能恢复。**
2. **只认原始回执。** 工兵自报、`ok=true`、CI 绿灯、包存在、环境变量存在，都不算功能通过。Root 独立复跑才算。
3. **夹具、模拟 Provider、模拟 Owner Review、真实模型、用户亲自签收分开记账。** 回执里写明 `mockProvider`、`humanClickedUI` 等真假标记。

## 2. 门禁 E0–E7

| 门 | 含义 | 证据最低要求 |
|---|---|---|
| E0 | 设计 | 本页三件套对应条目 + 上游对照表 |
| E1 | 代码 | 提交 SHA、改动文件、上游出处注释 |
| E2 | 单测 | 命令 + 退出码 + 通过/跳过/失败数 |
| E3 | 集成 | 真进程/真 Core/隔离数据目录，原始日志 |
| E4 | 真运行端 + 真模型 | 真 Provider、真 Prompt/工具调用回执、真成果 |
| E5 | 真跨设备 | 另一台物理设备，配对与回执 |
| E6 | 故障恢复 | 真断线/重启/旧租约拒绝，未知副作用不重放 |
| E7 | 发布 | 安装/升级/迁移演练/回滚 + Owner 亲自验收 |

只有签过的门才能说完成；`ACTIVE`、会话数、工单已派都不等于完成。

## 3. 复用验收（新增，对应“开源要直接用”）

每个阶段交付必须附**上游对照表**，Root 逐条核：

| 检查项 | 不过的表现 |
|---|---|
| 写了 Mikka/PiBot/上游的 40 位 SHA 与文件路径 | 只写“参考了某项目思路” |
| 复用方式是直接依赖 / 复制改写 / 原样运行之一 | “按其设计自行实现” |
| 复制代码在 `third-party/` 或 `adapted/` 并更新 `THIRD_PARTY_NOTICES.md` | 代码散落、无出处 |
| 新增代码只在架构 §3 “LOOM 只写”范围 | 新服务、新数据库、新调度、新协议 |
| 上游原有测试能移植的已移植为负例 | 只写正例 |

不满足任一项：退回，不进入 E1。

## 4. 场景验收 T 系列

原 PDF 的 T0–T18 保留（详见归档的旧设计基线）。现行重点：

| 编号 | 场景 | 过的标准 | 主体来源 |
|---|---|---|---|
| T19 | 群聊路由 | @ 某 Bot 与不 @ 时能解释选择；只被选中者回复/派工 | Mikka group-routing |
| T20 | Assignment DAG | 一个 Goal 两个工兵、冻结上下文、依赖与租约；一个崩溃时另一个不被错误接管 | Mikka factory + ACCP 规则 |
| T21 | 迟到回复 | 过期租约、旧配置、旧 Grant 的结果不影响现行 Goal | Mikka lease / ACCP fence |
| T22 | 能力跨运行端 | 同一组四能力在 Pi/DSH/Codex/Claude 分别显示 native/adapted/unsupported，有正反例加载与调用证据 | PiBot capabilities |
| T23–T25 | 人格导入、提示词模式、记忆隔离 | 来源/版本可查；Off/Append/Replace 的实际 hash 可审计；W1/W2 记忆不串 | PiBot soul/learning + agent-purge 解析 |
| T26–T27 | 守卫与安全实验 | 恶意插件、提示注入、换人格后审批/Grant/沙箱仍拒绝；实验室假凭据到期清理 | — |
| T28 | 上下文恢复 | Checkpoint 后恢复真实 Goal 与来源引用 | Mikka wake-recovery |
| T29–T31 | Pi Purge 关闭、激活、各模式 | 未选中时无改变；选中后下一 Run 真激活并有 PromptReceipt；各模式正反例 | Pi Purge 上游 |
| T32 | 多 Bot 隔离 | 两个 Bot 并行不同会话/人格，崩溃重启不串 | PiBot bot-sessions |
| T33 | 实验室与 Grant 围栏 | Strict 实验与审批负例仍 fail-closed | — |
| T34 | 先领后写 | r9 场景重跑 10 次，写入早于 claim = 0 | Mikka claim + ACCP fence |
| T35 | 主助手操控 B | 内置 Pi + Purge 主助手经 Tool Broker 在只装 LOOM Node 的设备完成文件操作，有 DeviceInvocation 回执 | PiBot Host / Mikka daemon |

## 5. “个人版可用”的定义

用户在现有 UI 里：创建 Bot → 拉另一个 Bot 进群 → 给一个 Goal → 主助手自动派两个受控工兵 → 一台只装 LOOM Node 的 Windows 完成工具操作 → 经 Review 得到能打开的成果；中途断开后能恢复，不破坏已有用户数据。完整 macOS GUI、企业隔离另设后续门。

## 6. 回执落盘

每次验收写：commit/源文件 SHA、执行位置（本机/Bero/CI）、命令、退出码、原始证据路径、模型真伪、门禁级别、下一阻塞。证据放 `_artifacts/<批次>/`，结论只写进 `LOOM-IMPLEMENTATION.md`。
