---
document_type: protocol-contract
contract: host-web-v6
status: accepted
version: 6
source_version: v1.72
last_updated: 2026-10-17
---

# Host Web v6

继承 [host-web-v5](host-web-v5.md) 未被下述条款替代的规则。

Host Web protocolVersion **5**，与新 Task 可选读取投影共同配套发布；协议不匹配仍使用既有明确错误，不猜测旧响应字段。

受认证 User allowlist 增加 preferences.tasks.get/set。SSE invalidate 增加可选 tasksChanged:true，resync/重新连接重新读取当前 Core 设置；读取 pending 或失败保留本 Host 已确认的投影，不能当作 Core 已关闭。首次未知仍默认不显示 Task。不会暴露内部凭据或向 Agent 增加设置权限。

切换 Host 时同时重置本地 enabled、ready、saving、error；旧 Host 的保存成功或失败不能覆盖新 Host 状态。
只重置能力 Provider 的本地投影，不重建整个会话工作区或清空草稿。
能力投影同时携带 Core 固定的 `headsUpAfterSequence` 与读取时的 `observedThroughChangeSequence`，与 enabled 原子接收。设置 get/set 和通知增量共同更新该投影，较旧序号不能覆盖较新结果；同一快照重复到达不触发重复渲染。Renderer 不通过额外 Inbox 请求推测开启时间，也不等设置响应才处理通知。
