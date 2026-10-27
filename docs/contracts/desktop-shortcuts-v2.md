---
document_type: protocol-contract
contract: desktop-shortcuts-v2
status: accepted
version: 2
source_version: v1.72
last_updated: 2026-10-17
---

# Desktop Shortcuts v2

继承 [desktop-shortcuts-v1](desktop-shortcuts-v1.md) 未被下述条款替代的规则。

本机 shortcuts schemaVersion **2**。一次性迁移 v1：execution/members/dm/tasks 无论旧绑定、自定义或 null，统一 Mod+1/2/3/4；其他占用这些组合的动作清空，其他键位、mouse.side1/side2 和 sendMode 保留。原子写入新完整配置；v2 后续启动、Host 切换与 Task 开关均不重置。

迁移写盘失败不改旧文件，内存采用规范化键位并返回 migrationPending，设置行内允许显式重试。目录仍为 23 个动作；Task 关闭只改变可用性，不新增第二份配置。

关闭时 Task 行、录制、键盘/侧键绑定均不可用，事件不消费。正在录制 Task 则取消，其他录制继续。别的动作使用隐藏 Task 组合时在同一保存中清除 Task 旧绑定，不显示隐藏冲突；重开不抢回。Windows Main app-command 在 preventDefault/send 前按当前窗口 Host capability 判断，未知 false，导航/Renderer loss 清空该投影。
