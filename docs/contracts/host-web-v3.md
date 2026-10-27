---
document_type: protocol-contract
contract: host-web-v3
authority: shared-host-web-transport
status: accepted
version: 3
source_version: v1.63
last_updated: 2026-09-21
---

# Host Web v3

v3 完整继承 [v2](host-web-v2.md) 的网络信任、认证、编辑器归属、Session、操作 allowlist、上传、资源、
共享页面和未通过安全发布资格的边界，并把 Task operation 切换到
[Durable Task v4](durable-task-v4.md)。当前 Task create/update 与 Task read projection 不再接受或返回
`acceptanceCriteria` / `clearAcceptanceCriteria`。

HTTP 登录、登录票据、Session identity 和 capabilities 的 `protocolVersion` 同步轮换为 `3`。Host 拒绝
携带旧协议版本 `2` 的新登录或票据兑换，Web 客户端也拒绝 Host 返回旧版本 Session；已经建立的 v2
Session 不跨版本复用。

`commands.reconcile` 仍然只按原 command ID、当前可解析 payload digest、Owner 和 editor 读取已记录
receipt，绝不重新 dispatch。v3 不保留 v2 Task payload 的 legacy decoder：带已删除 Task 字段的旧
create/update reconciliation 请求在读取 receipt 前作为不兼容输入拒绝，即使旧命令可能已经提交。客户端
不得把这种拒绝解释为原命令未提交，也不得换新 ID 自动重发；需要时由用户根据当前 Task 状态决定后续动作。

这是 v1.63 明确接受的低概率 clean break。其他 operation 的 receipt reconciliation、`recorded` / `unknown`
语义、15 秒 timeout、SSE、编辑草稿和恢复规则全部保持 v2 不变。
