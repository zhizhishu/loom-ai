---
document_type: contract
contract: scheduled-automation-v5
status: accepted
target_version: v1.72
last_updated: 2026-10-27
---

# Scheduled Automation v5

v5 继承 [v4](scheduled-automation-v4.md) 的定义、调度、occurrence、普通 Delivery、结果与通知边界，
恢复对话命名，并将日期与时间固定为单一格式。任务名仍是 Automation 的名称，生成的 Thread 标题单独持久化。

## 命名配置

Desktop/Web `CreateAutomationCommand` 可省略 `threadNaming`，省略使用下表默认值；
`UpdateAutomationCommand` 省略该字段保留原配置，提供时整体替换。`AutomationView.threadNaming`
始终返回完整对象。对象是 closed schema，字段必须齐全，未知字段、枚举或类型拒绝。

| 字段 | 值 | 默认值 |
| --- | --- | --- |
| `includeDate` | boolean | `true` |
| `includeTime` | boolean | `true` |
| `dateFormat` | 固定 `iso` | `iso` |
| `timeFormat` | 固定 `24` | `24` |
| `position` | `prefix` / `suffix` | `suffix` |

日期固定为 `YYYY-MM-DD`，时间固定为 `HH:mm`，月份、日期、小时和分钟补零，不随界面语言改变。
格式字段只保留固定序列化值；UI 不提供格式选择。暂停前的其他格式退出合同，不增加旧格式兼容或回填。
命名配置继续参与现有版本 CAS、完整表单自动保存和命令幂等；只改命名配置不改变 `nextRunAt`。

## 标题与时间来源

- Core 在 occurrence admission 的同一事务内生成标题并交给普通 Camp 创建路径；`camp.title`
  与 `camp.created` 使用同一个结果，保持用户来源名称语义，后续自动派生不覆盖。
- 定时运行使用该 occurrence 的 `scheduledFor`；手动运行使用实际 admission 时间，不使用下次计划时间。
  两者都按执行 Core 的本地时区格式化。Renderer 的当前本地时间仅用于预览，不是权威时间。
- 日期与时间按勾选状态以空格连接；时间戳和任务名以 ` · ` 连接，位置由 `position` 决定。
  两项都关闭时，标题仅为任务名，不加分隔符。
- 名称为空时仍从 Prompt 派生；任务名自身沿用 80 个 Unicode scalar 上限，附加时间后标题允许超过该上限，
  不截断或破坏 Unicode。命名设置修改只影响之后创建的 Thread。
- 命令重放返回原 occurrence，不新建 Thread；历史标题、用户重命名、消息及引用快照均不重算。

## 持久化与 Agent 边界

沿用 migration 215 / schema 165 的 `thread_naming_json`，列默认值已是 `iso` / `24`；
本次没有 schema 升级、历史标题迁移或兼容分支。
Agent Built-in automation 工具继续沿用原参数与输出，不暴露 `threadNaming`；创建使用默认值，
更新保留既有设置。Host 编辑回执和查询返回完整设置。没有模型模板、Bootstrap、Manifest 或工具目录版本变化。

UI 结构及保存/失败行为见 [Automation 工作区](../ui/components/automation-workspace.md)。
