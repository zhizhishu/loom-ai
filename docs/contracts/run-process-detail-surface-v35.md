---
document_type: protocol-contract
contract: run-process-detail-surface-v35
authority: execution-console-run-card-workspace
status: accepted
version: 35
source_version: v1.62
last_updated: 2026-09-20
---

# Run Process Detail Surface v35

继承 [v34](run-process-detail-surface-v34.md) 的 Evidence、按窗口读取、Tool 分组、完整内容与展示边界。
本版替换 Desktop/Web 共享 Camp 工作区中的执行台承载、Run 导航和卡片编排，不改变 AgentRun、CampTurn、
Evidence 或 Runtime 的权威状态。

## 承载位置与共享工作区

`executionConsolePlacement` 是本机安装级封闭枚举 `right | inspector | bottom`。旧偏好或缺失值继续回退
`inspector`；用户通过同一个位置菜单显式保存，失败时保持原位置。三种承载位置移动同一个执行详情状态，
不得复制 Run selection、Evidence 缓存、disclosure 或阅读位置。

`right` 将“执行”作为无文件能力的合成标签加入 Camp 文件预览的同一标签集合。它不申请文件 handle、
不参与文件恢复来源，也不提供文件搜索。执行、Mission 活动与普通文件切换时复用同一已保存分栏比例，
不得改变预览区宽度。移出 `right` 时关闭该合成标签；再次从标题入口或位置菜单打开时重新建立它。

Mission 进入时仍先建立并选择“活动”。若同一 snapshot 存在符合下节条件的 Run，则再按保存位置打开执行台；
位置为 `right` 时“执行”成为当前标签，“活动”仍留在标签集合中。此时执行的显示优先级高于活动。

## 进入会话与最新指令

从其他 Camp、一级页面或应用启动/恢复进入普通或 Mission 会话时，只以 `status=running` 的 AgentRun 为
自动打开资格；`queued`、`waiting`、`recovery_blocked` 与终态均不具备资格。按 `createdAt + id` 选择最新
running Run，显示用户保存的承载位置，展开该卡片，并把执行阅读区定位到最新已载入指令。随后新指令到达时，
只要用户仍停留在底部便继续跟随；用户上滚立即暂停，回到底部恢复。

同一 workspace 内的后台 refresh、A2A、Runtime 事件或后续状态变化不得重新执行进入规则、切换选择或抢键盘
焦点。自动打开只改变瞬时执行选择，不写回位置偏好。

## 总览、当前执行与历史

队员入口旁保留“总”入口；`bottom` 在队员入口之前显示“总览”，侧面承载使用圆形“总”入口。
总览按队员聚合，但每张卡仍对应一个 exact AgentRun。当前区包含 running、waiting 和 queued；终态进入默认
收起的“执行历史”，按 `createdAt + id` 从新到旧排列。历史标题只显示历史总数，不增加失败待处理汇总。

Run 卡片收起行只展示触发消息摘要、状态/耗时和 hover/focus 后出现的动作；总览卡片额外显示队员头像。
展开后直接进入 v34 的过程正文，不重复队员、Runtime、模型、状态和时间元数据。队员详情 Header 保留队员身份、
Runtime、模型与 Fast，不显示 Run 总数或重复统计。

同一队员的 queued Run 合并为一个排队批次；层数按不同来源消息计数。展开后逐条显示用户或 Agent 作者、
最多两行正文摘要和“定位原消息”。终止当前卡片只取消 exact Run；终止排队批次只取消该批列出的 exact queued
Run，不扩大到队员其他运行或整个 CampTurn。执行台不提供用户消息撤回；撤回由
[Camp Message Send v23](camp-message-send-v23.md)拥有。撤回在 Delivery 跨过 Agent 识别边界前完成，
不会创建专用的 AgentRun 取消原因或执行历史卡片。

## 验收

- 三个保存位置可往返，位置菜单、失败回退与同一详情状态保持一致；
- `right` 与 Activity/文件共享标签栏及分栏比例，切换时文件预览宽度不跳变；
- 普通和 Mission 会话进入时只打开最新 running Run，卡片展开并跟随最新指令；
- Mission 的 Activity 标签仍存在，`right` 执行在有 running Run 时成为当前标签；
- 总览、当前区、排队批次和折叠历史按上述口径稳定排序，卡片不重复详情元数据；
- 单 Run 与排队批次停止只作用于显示的 exact Run ID。
