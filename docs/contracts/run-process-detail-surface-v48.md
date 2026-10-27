---
document_type: protocol-contract
contract: run-process-detail-surface-v48
authority: conversation-run-presence-surface
status: accepted
version: 48
source_version: v1.72
last_updated: 2026-10-11
---

# Run Process Detail Surface v48

继承 [v47](run-process-detail-surface-v47.md) 的会话占位、消息顺序、Evidence 读取与停止资格。
按 User 确认的 v10「停止区分隔」实现，并遵循后续修正：停止按钮默认沿用 v8 原稿的中性色，悬浮才变红。
重试恢复读取既有续做 Delivery 的受理事实；不增加排队占位，不改变原 Run 或继续执行的授权规则。

## 执行行

透明单行保持现有消息轨道。左侧复用执行台的进行中图标和命令图标；正文从开头流式增长，
填满一行后静态省略，不横向滚动。右侧停止按钮前以 1px × 16px 短竖线分隔，间距 10px；
没有操作按钮时不留下分隔线。整行不增加底色、外框、耗时或重复状态文字。

停止图标与执行台共用实心方形组件，默认 `--muted` 色、透明背景；悬浮时使用 `--danger`
与 `--danger-soft`，键盘焦点保留现有 focus ring。停止确认仍沿用 v2，执行台按钮自身行为不变。
桌面执行行 36px、内容入口 34px、停止目标 26px；粗指针分别为 48px、46px、44px。
同一组件覆盖日夜主题、reduced-motion 与窄窗口，不修改复制／回复显隐规则。

## 重试受理与恢复

公开 `AgentRunView.hasAcceptedContinuation` 是 Core 派生的布尔事实：存在一条关联此 source Run
的 `camp_run_continuation` 及其真实 Delivery，即为 true。它不依赖当前组件状态、消息页、
有界 Delivery 列表或后继 Run 是否已经创建；完整快照、轻量打开和重新连接均使用同一读取逻辑。
兼容旧数据/夹具时缺省视为 false。该字段只用于消息区提示收起，不表示原 Run 已恢复或失去继续资格。

- 点击消息区「重试」后，按钮显示「正在提交…」并禁用。
- 明确受理后收起这条中断提示；Delivery 等待调度期间不展示排队行。组件内回执集合仅用于
  权威快照到达前的即时反馈，重新挂载、切群或刷新均由 Core 事实恢复。
  切群的缓存预览阶段不展示中断／重试行，等待权威打开投影后再判断，避免旧缓存短暂恢复已处理的入口。
- 新 Run 开始时显示正常执行占位；新 Run 再失败时，入口指向这个新 Run，旧提示不复活。
- 明确拒绝时保留「重试」并反馈原因。网络回执丢失时，界面不增加「结果未知／确认提交结果」
  分支，后续重试内部仍复用同一 commandId 核对，不能把传输失败当成新授权。
- 执行台保留历史失败记录与「继续执行」。符合资格时可多次主动授权，每次明确的新操作
  创建独立 Delivery；不得用此字段增加“一生只能重试一次”的限制。

授权、事务、重放、排队及 cleanup 继续由 [AgentRun Continuation v3](agent-run-continuation-v3.md) 拥有。
不迁移数据库，不改写源 Run 状态或 version，不修改模型上下文、公开消息及输入草稿。
