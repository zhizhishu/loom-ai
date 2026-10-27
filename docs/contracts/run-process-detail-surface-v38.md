---
document_type: protocol-contract
contract: run-process-detail-surface-v38
authority: execution-console-run-card-queue-projection
status: accepted
version: 38
source_version: v1.62
last_updated: 2026-09-20
---

# Run Process Detail Surface v38

继承 [v37](run-process-detail-surface-v37.md) 的终态步骤计数，以及
[v36](run-process-detail-surface-v36.md) 的三位置承载、共享详情 DOM、进入恢复、Run 导航、Evidence、停止、
折叠历史、排队卡、多输入入口和紧凑卡几何。本版只校正当前 Delivery 队列的读取来源与层数按钮视觉；不改变
AgentRun、CampMessageDelivery、MessageDeliveryView、CampTurn、Evidence 或 Runtime 的权威状态。

## 当前 Delivery 队列来源

执行台的 claim 前排队卡消费 Camp Open `messageDeliveries` 中由当前 `camp_message_delivery` 投影的行，而不是只消费
历史 `message_delivery` 表或只接受 Agent 作者。符合 [Camp Open Projection v21](camp-open-projection-v21.md) 的
用户、Agent、Mission、Automation 与 Channel 消息使用同一入口；`sourceAgentRunId` 对用户消息为空，不能成为排队卡
准入条件。

Renderer 仍按 v36 的状态条件选择 `targetAgentRunId=null` 的 waiting Delivery，并按 `recipientAgentId` 聚合。
`deliveryKind=public_a2a` 是现有兼容 View 的标签，不表示该消息必须由 Agent 发出。作者类型只用于输入清单展示，
不得在 Core Open loader、coverage count 或 Renderer 队列选择中排除用户消息。消息被 claim 后，真实 Run 继续接管。

## 层数入口视觉

多输入入口沿用 v36 的独立语义按钮和焦点往返，并固定使用交互稿的紧凑层数构图：

- 按钮最小宽度 30px、高度 26px、水平内边距 2px、内容间距 3px、圆角 4px；
- 图标使用 24×24 viewBox 中的三层堆叠路径
  `m12 3 10 5-10 5L2 8Zm-10 9 10 5 10-5M2 17l10 5 10-5`，显示尺寸 13×13px、描边 1.5px；
- 数量使用 10.5px 等宽字体和常规字重，不把数字做成单独徽章；
- 输入清单中的“定位原消息”保留文字，并在其前显示交互稿的定位消息图标；图标为装饰，按钮的可访问名称仍由文字提供。

图标与数量共同位于一个按钮内；按钮仍独立于卡片展开按钮，hover、focus 和 open 状态使用既有 Surface token。

## 验收

- 当前用户连续发送给忙碌队员的两条 waiting Delivery，在尚无 successor Run 时同时进入该队员的排队卡；
- 同一读取与 coverage 统计包含这两条 Delivery，不能出现“总数完整但集合遗漏”或相反情况；
- claim 后两条输入由真实多输入 Run 接管，层数仍为 2；
- waiting 排队卡与真实多输入 Run 都显示同一三层图标、常规字重计数及可点击输入清单；
- 鼠标、键盘和 `Escape` 焦点返回边界继续满足 v36。
