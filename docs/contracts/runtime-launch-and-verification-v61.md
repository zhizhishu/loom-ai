---
document_type: contract
name: Runtime Launch and Verification
version: v61
status: accepted
source_version: v1.72
last_updated: 2026-10-13
---

# Runtime Launch and Verification v61

继承 [v60](runtime-launch-and-verification-v60.md) 的启动、环境读取、原生恢复及输入保护。
本次按 User 要求替代 v58 中 Camp 队员操作提供重置入口的界面规则。

## 会话队员列表

Desktop 与 Mobile 的会话队员列表均不再提供“重置队员会话”，同时移除该入口专用的确认弹窗。
桌面“…”菜单保留队长、模型信息及移出当前会话操作；不以隐藏、禁用或替代入口继续展示重置。

此变更仅收敛 Renderer 入口。既有后端重置命令、会话归属、原生恢复、活动工作保护、
Camp 消息与持久化数据保持，不触发已有会话重置或数据迁移。
