---
document_type: contract
contract: scheduled-automation-v4
status: accepted
target_version: v1.72
last_updated: 2026-10-26
---

# Scheduled Automation v4

v4 继承 [v3](scheduled-automation-v3.md) 的定义、调度、occurrence、普通 Delivery、结果与通知合同。
日期标题功能暂时停用，Desktop/Web 隐藏“对话命名”入口；任务名称仍是 Automation 的名称，
生成的 Thread 标题直接使用该名称并单独持久化。

## 当前标题行为

- Core 在 occurrence admission 的同一事务内把任务名交给普通 Camp 创建路径，`camp.title`
  与 `camp.created` 事件使用同一个结果；保持现有用户来源名称语义，后续自动派生不覆盖。
- 手动运行和定时运行均不附加日期、时间或分隔符，不消费 `threadNaming`。名称为空时仍由 Core
  从 Prompt 派生，名称长度规则不变。
- 命令重放返回原 occurrence，不新建 Thread；修改任务名只影响之后创建的 Thread。
  本次不重写历史标题、用户重命名、历史消息或引用快照。

## 保留的命名配置（暂不生效）

Desktop/Web `CreateAutomationCommand` 可省略 `threadNaming`，省略使用下表默认值；
`UpdateAutomationCommand` 省略该字段保留原配置，提供时整体替换。`AutomationView.threadNaming`
始终返回完整对象。对象是 closed schema，字段必须齐全，未知字段、枚举或类型拒绝。
这些设置当前只存取、不参与标题生成，Renderer 不提供编辑或预览入口。

| 字段 | 值 | 默认值 |
| --- | --- | --- |
| `includeDate` | boolean | `true` |
| `includeTime` | boolean | `true` |
| `dateFormat` | `iso` / `slash` / `short` / `chinese` | `iso` |
| `timeFormat` | `24` / `12` / `seconds` | `24` |
| `position` | `prefix` / `suffix` | `suffix` |

日期格式分别是 `YYYY-MM-DD`、`YYYY/MM/DD`、`MM-DD`、`M月D日`；前三种月份/日期补零，
中文格式不补零。时间分别是 `HH:mm`、`上午/下午 h:mm`、`HH:mm:ss`；12 小时制零点/正午分别是
`上午 12:mm` / `下午 12:mm`，小时不补零。它们是保存的数据格式，不随界面语言重写。

命名配置存取仍参与现有版本 CAS 和命令幂等；只改命名配置不改变 `nextRunAt` 或实际标题。

## 持久化与 Agent 边界

Migration 215 将 v1.72/schema 164 升级至 schema 165，在 Automation 定义增加
`thread_naming_json`。schema 165 和已有字段保持不变，配置默认值不代表功能已启用；
本次停用不增加迁移、回填或兼容分支，不重写任何 occurrence 或 Thread。
DDL、migration receipt 和 schema marker 同事务提交，失败完整回滚，重开继续升级。

Agent Built-in automation 工具仍沿用原参数与输出合同，不暴露 `threadNaming`；Agent 创建使用默认值，
更新保留既有设置。Host 编辑回执和查询返回完整设置。没有模型模板、Bootstrap、Manifest 或工具
目录版本变化；模型读取 Thread 时沿现有字段看到实际标题。
