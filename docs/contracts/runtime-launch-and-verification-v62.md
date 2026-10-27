---
document_type: contract
name: Runtime Launch and Verification
version: v62
status: accepted
source_version: v1.72
last_updated: 2026-10-13
---

# Runtime Launch and Verification v62

继承 [v61](runtime-launch-and-verification-v61.md) 的启动、原生恢复、输入保护及队员操作边界。
按 User 要求移除 v60 的原生会话重建说明及其展示判断。

## 原生会话重建展示

公开会话与 Single Chat 的执行过程均不显示“原生会话未能恢复，已新建会话继续”说明。
`AgentRunView` 与 `SingleChatRunView` 不再投影 `nativeSessionReplaced`；对应读取路径不查询
`agent_run.native_session_continuity_lost` 事件来判断展示。Camp Open 继续遵守
[首屏读路径](../architecture/camp-open-read-path.md)的零 `event_log` 读取边界。

原生恢复、明确不可恢复后的一次降级、Run/epoch 保护及既有 continuity 审计事件保持；
移除展示不改变 Runtime 行为，不新增持久字段、索引、迁移或历史回填。
