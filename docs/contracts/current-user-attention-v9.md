---
document_type: contract
name: Current User Attention
version: v9
status: accepted
source_version: v1.72
last_updated: 2026-10-21
---

# Current User Attention v9

继承 [v8](current-user-attention-v8.md)，新增 [Notification Episode v11](notification-episode-v11.md)
的中断注意力，保持 Agent 回复发布水位和 Core 查看水位各自的语义。

侧栏持久蓝点是新回复未读、本机手动提醒、有效中断未读的组合。运行环独立保留。
可访问名称按真实组成说明“有新回复”“已标记未读”“有未查看的执行中断”，短亮本身不声称有未读。

当前前台窗口在异步停止请求前登记精确 Run/Thread/原 Conversation 的本机意图；
实际 `occurrence_admitted` 描述匹配后，若侧栏行与状态槽可以绘制，独立短亮约 600ms。
按钮点击、停止回执、未读 Boolean、Episode 当前主原因不能代替真实准入。
被拒绝请求移除意图；不确定回执不伪造结果。其他窗口没有该本机意图，不产生短亮。

ACK 与展示没有先后屏障。结果实际可见即可正常确认，即使它发生在侧栏第一次读取之前，
精确实时描述仍能支持短亮。短亮不延迟 ACK、不阻止已读，也不读取或改写本机提醒。
600ms 后仍有任何持久未读时蓝点继续存在。

侧栏折叠、行在视口外、状态槽被 hover/菜单隐藏时跳过短亮，不等待展开，不排队补播。
失焦、页面不可见、切换 Thread/单聊、clear、原来源失效会终止短亮；ACK 不会。
启动、重建基线、reset、历史重读、重试都不补播。强退恢复只通过持久候选显示提醒，
真实停止结果可见后自然确认；缓存画面或恢复选中状态不能确认。

已结束的 C1 不扩展历史阅读 UI，不把提醒交给 C2；其来源资格、保留审计与范围确认均由通知模块拥有。
