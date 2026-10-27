---
document_type: protocol-contract
contract: run-process-detail-surface-v54
authority: conversation-run-presence-surface
status: accepted
version: 54
source_version: v1.72
last_updated: 2026-10-19
---

# Run Process Detail Surface v54

继承 [v53](run-process-detail-surface-v53.md) 的位置、完整回复产物组、精确 Run 身份衔接与执行交互。
本次补齐独立执行行的队员卡片与模型入口，Desktop / Web 共用组件。

- 显示身份时，头像和姓名复用公开消息的队员卡片入口。点击、Enter、Space 打开同一张锚定卡片；
  Escape / 外部点击关闭，保留既有焦点归还规则。队员离开、档案删除或无法解析时静态展示。
- 姓名旁展示可点击的“模型 · 强度”摘要，复用消息的模型浮层。数据只来自该 Run 的模型记录，
  使用 [Camp Open Projection v28](camp-open-projection-v28.md)，不使用队员当前配置冒充运行事实。
  未记录显示“模型未记录”；默认且未观察显示“智能体默认”；只展示实际记录的强度。
- 队员卡片仍展示队员当前资料与配置，模型浮层展示本次运行记录；两者不互相替代。
- 紧接同一 Run 输出组时，隐藏重复头像、姓名和模型摘要。新 Run 即使来自同一队员仍显示自己的身份。
- 点击卡片入口不打开执行详情，不触发停止；执行内容、停止与重试保留各自原入口和精确 Run 归属。

停止确认沿用当前[会话工作区规范](../ui/components/conversation-workspace.md#会话中的队员占位)的
非模态文字气泡，取代继承链中的旧确认 Dialog；取消、Esc 和点外部不提交，关闭不抢回焦点。
队员资料与模型浮层的焦点规则独立于停止确认。

父 Run 终态收口尚未结算工具的活动展示：cancelled 下的 running/waiting 投影为 stopped；
succeeded/failed 下投影为 recorded（结果未知）。已收到的工具终态原样保留，缺失回执不从 Run 的
成功／失败推断。此处仅是共享展示投影，不改写原始或 Canonical Evidence，不声明后台进程已经退出；
迟到的明确工具结果继续覆盖未知展示，展开状态保持。

生产组件浏览器 owner 验证头像 / 姓名、键盘与焦点、冻结模型与当前资料差异、跨适配器强度、
默认 / 缺失 / 旧 Host 记录、离开与删除后的静态回退、回复后的身份衔接，以及日夜主题和窄宽度布局。
