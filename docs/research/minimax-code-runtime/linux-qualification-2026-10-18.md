---
document_type: research-report
authority: observed-minimax-code-linux-qualification
status: qualified
last_updated: 2026-10-18
---

# MiniMax Code Linux x64 准入验收

本轮按维护者要求，以完成 Runtime 接入 Checklist 为目标，在独立 Ubuntu 24.04.5 x86_64
开发机使用官方 npm `@minimax-ai/code` **0.6.12**、Node **24.21.0** 和真实生产 Core 路径验收。
模型为官方原生 `config.yaml` 中的 Sub2API / `gpt-6.1-sol`，未替换 mcode、未修改日常原生认证。
验收 Core、项目、原生数据、Skills、MCP、缓存和浏览器 profile 均独立；公网服务与业务数据保持隔离。

**结论：Linux x64 的 14 个能力轴已按本轮实际边界闭合。** 平台行晋升 Qualified，绑定
[不可变脱敏记录](../../../qualification/runtime-platform/linux-x64-minimax-code-v1.json)的 SHA-256。
macOS Intel 的既有确认独立保留，arm64 仍为 Preview；Windows 按同日独立证据 Qualified。

## 证据边界

- 真实 Provider：first/warm/cold、A→B→A、并发、官方配置地址/Key 热刷新、Skill/MCP、当前 CLI 操作集及故障恢复。
- 实际官方 CLI 与确定性本地 Provider：命令输出、文件矩阵、问卷、空 final、Steer 传输、MCP 取消和 Fleet。
  它们证明原生协议及副作用，不代替真实模型生成。
- 真浏览器：Linux Chromium 打开生产 WebUI，点击真实新增文件和 Edit 卡片，核对原文及 Diff。
- Rust owner：身份、计数桶、历史排除、跨 Run 去重和文件换代负例；不将单元测试数量算入真实验收。

Server 包从 Ubuntu 22.04 原生构建，glibc 符号上限 2.35。Ubuntu 22.04、Debian 12 VM、
Ubuntu 24.04 的 Server smoke 与 Runtime 准入分别记录：本轮 mcode 的实际执行主机是 Ubuntu 24.04，
不声称在三种发行版都执行了 mcode，也不外推 Linux ARM64、musl 或其他平台。

## 核心能力矩阵

| 能力轴 | 已验证行为 | 边界 |
| --- | --- | --- |
| Auth / Provider / Model | 原生 BYOK 默认、opaque catalog ID、显式选择 ACK、下一 Run 地址/Key 热刷新 | 保存未知选项保留用户意图，正式执行前由 live Host 拒绝；无模型请求 |
| Host / Fleet / LRU | warm 驻留、A→B→A、真实并发；21 Session 触发生产 20 Host LRU | 未改容量和时钟；真实等待生产 30 分钟 idle TTL 后精确恢复 |
| Native Session | warm、Host/Core 冷恢复、Runtime/Core crash；缺失 Session 只产生一次替代 | 不按最近会话或相似 ID 恢复，不重播历史工具 |
| Bootstrap / Context | 根模型请求高权限层一份 Charter；A/B 隔离、冷恢复、压缩后身份一致 | 原生标题生成另记，不把辅助调用当作根模型请求 |
| Compaction | 自动阈值、Core 在 checkpoint 中取消及原 Session 后继恢复；手动失败不推进代次，一次受控 overflow 后重试、单次提交及 Core 冷恢复通过 | 64K 原生限额用于真实摘要；受控错误不等于自然耗尽 Provider 窗口，原生管理命令取消限制见下文 |
| Skills | user/project 原址发现并实际调用；平台/工具箱真实 Read；更新、禁用、同名多来源、删除引用、相邻成员、冷恢复 | 按当前 Skills Rebuild v2，不恢复历史 Library/group 项目投影 |
| External MCP | stdio、带认证 HTTP、同名整项 RovaiWins、更新/移除/恢复、相邻隔离和冷恢复 | 合成认证不进入模型请求或原生全局配置；MCP 取消观察 37 秒无延迟写入 |
| Tool / Action / Output | 原生 Read/Write/Add/Edit、失败 Edit、相对及中文空格路径；stdout/stderr/混合/空/非零/大输出 | 一张每 Run 文件聚合卡；真实 WebUI 打开 Diff 和新增文件内容 |
| Narration / Final / Missing-Send | 零发送恢复、已发送抑制、工具后 final、发送后空 final、发送后原生错误 | 公开消息只走 bundled CLI；问卷不能用结束文字掩盖 |
| Permission / Approval / Workspace | 默认最高权限原值传递；原生 allow/deny/cancel 和零副作用；压缩/冷恢复保持权限 | `plan` 是流程模式，搭配显式 bypass 仍可写文件；不宣称 OS 级只读沙箱或 additionalDirectories 支持 |
| Built-in CLI | 当前 contract v42 / IPC v3 全部 30 个操作、公开与私有上下文、过期及后继 lease | 私有 Run 通过 Single Chat read side 验证，不越过公共 Thread 隐私边界 |
| Usage / Cache / Cost | first/warm/A-B-A/并发/配置刷新/cold 的 8 个 Run 四桶与原生数值完全一致 | 纯工具调用漏计已修；压缩换代补采修复已通过原生包复测，费用与 reasoning 不补零，短 Run 或取消窗口仍可能缺数 |
| Retry / Queue / Cancel / Cleanup | 503 原生重试只写一次、拒绝与取消、取消后普通队列只启动一次、Runtime/Core crash、MCP 子进程清理 | 明确的主请求 context rejection 失败退出，不盲目重放已接受输入；协议错误和 Probe timeout 单独记账 |
| Ready / Version / Platform | 安装入口指纹、真实 ACP、原生默认与动态目录 | 本轮只评估 Linux x64；macOS Intel 既有 Qualified、arm64 Preview 保持，Windows 资格由同日独立记录拥有 |

## 发现与修复

1. **纯工具调用漏计**：mcode 不为所有纯工具 assistant 消息发送显示 message ID。只补充本轮实际
   ACP toolCallId 与原生结构化 toolCall 的精确匹配；不按 Session/turn 邻近推算。
2. **压缩换代后统计为空**：原生会替换 active journal，并将旧代保存为 catalog snapshot。
   仅在终态冻结身份后有界读取同一根 Session 的原生历史；跨文件保留去重，业务结束和后继不等待。
   规则见 [Usage v11](../../contracts/runtime-usage-monitoring-v11.md)。

保留失败尝试。验收脚本曾使用旧 Skill 投递、假定文件变化一文件一卡、通过公共 read side 查询私有 Run、
从改写后的进程 argv 寻找 Bootstrap、将简单 printf 默认允许误认为审批失效、将列表中的旧安装状态误认为新入口检查结果，以及把上一 Session 的异步标题请求混进当前根模型隔离断言；均按当前合同和实际
原生行为修正，未通过增加产品兼容层或放宽副作用断言来解决。首次 Debian VM 的 SSH 传输失败发生在
应用启动前，原样重跑通过；最终原生包仍需自己的三系统结果。

## 原生边界

手动 `/compact` 在独立原生 ACP 客户端中执行，用于验证同一 Session 的历史和 Bootstrap；产品
没有新增手动压缩按钮。官方 0.6.12 在该管理命令等待模型时不响应 ACP cancel，旧探针的超时
不能算取消通过。产品停止路径另通过真实 Core Run 的自动 checkpoint 验证：连接关闭、代次不推进、
后继保持原 Session，并能实际调用 Skill/MCP 和召回原始记忆。

一次受控 checkpoint `context_length_exceeded` 后，原生重试并提交一次，但请求体没有缩短。
这只证明该失败后的重试及连续性，不证明持续低于本机配置的 Provider 窗口能够被自动适配。
主请求的确定性超限另外验证失败退出且不重放已接受输入。统计继续是部分观测，短 Run／取消
窗口可以缺数；不把本轮四桶对账通过说成完整费用账单。

## 重跑

先准备独立空绝对目录、匹配的生产 Core/CLI 成品与官方原生 BYOK 配置：

```sh
node scripts/qualify-minimax-linux.mjs /absolute/empty-fixture /absolute/package/rovai-host basics
```

其他真实 Provider 阶段为 `capabilities`、`cli`、`compaction`、`compaction-manual`、`failures`，每阶段使用新的空目录。
控制服务沿用 `scripts/smoke-minimax-runtime.mjs`，可用 `--files-only`、`--completion-only`、
`--questionnaires-only`、`--fleet-only`、`--plan-only`、`--mcp-only`；Fleet 必须等待生产 TTL。
可通过 `ROVAI_MINIMAX_CONTROL_CORE_EXECUTABLE` 指定同一成品 Core，报告记录指纹。
浏览器入口为 `scripts/qualify-minimax-linux-web.mjs`，只对已停止的本次验收数据运行。

报告、原生历史和截图是私有诊断，不能原样公开。公开记录只保留版本、SHA、用例结论、数字与必要限制。
本轮没有修改模型上下文、Session 恢复门禁、全局原生配置或其他 Runtime 的平台资格。
