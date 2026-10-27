---
document_type: contract
name: Current User Attention
version: v10
status: accepted
source_version: v1.72
last_updated: 2026-10-21
---

# Current User Attention v10

继承 [v8](current-user-attention-v8.md) 的回复、可见来源与本机提醒规则；
以 [Notification Episode v12](notification-episode-v12.md) 替代 v9 的中断展示与确认机制。

侧栏持久蓝点组合新回复未读、本机手动提醒和有效执行中断提醒，包括 App 退出及已确认的 Run 执行丢失。运行环独立。
可访问名称按真实组成说明“有新回复”“已标记未读”“有未查看的执行中断”。
蓝点不再有独立短亮状态；手动停止、执行进度和普通 command 不触发它。

重新打开 App 时读取既有通知投影。用户成功打开该 Thread 的正式内容后，前台有焦点的页面
确认当时观察到的中断提醒，无需滚动寻找具体执行或输出。使命记录未就绪、缓存预览、加载失败、只恢复选中状态
及后台窗口都不确认；侧栏折叠、行被裁切或菜单遮住槽位均不阻挡确认。
之后新来的中断提醒保留，不能扩大既有确认边界。确认失败沿原 UUID/边界重试。

本机标记未读及 Agent 回复发布水位各自保留原语义；执行中断确认不清除它们。
显式“标记已读”的两步保存与并发边界、已结束私有来源的候选退出由通知合同拥有。
不新增历史单聊阅读 UI，也不让后继 C2 代读 C1。
