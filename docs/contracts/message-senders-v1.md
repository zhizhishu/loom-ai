---
document_type: protocol-contract
contract: message-senders-v1
authority: model-message-sender-projection
status: accepted
version: 1
last_updated: 2026-10-14
---

# Message Senders v1

公开 RUN_INPUT.messages、SHARED_THREAD 普通消息及 thread.read、thread.search、history.search
普通消息结果复用一个模型发送者投影。每条普通消息的发送者字段如下，名称只用于展示：

| 内部作者 | senderType | senderId | senderName |
| --- | --- | --- | --- |
| Agent | agent | 原 Agent ID | 原作者保留 Profile 的显示名；缺失或空白为 null |
| 本地 User / 已通过渠道准入的 external_principal | user | user | 省略 |
| system | system | system | 既有可靠名称；目前无该来源，输出 null |

senderType、senderId 必填。Agent/system 必含可空 senderName。新读取和搜索不同时返回 authorType /
authorId；封闭 Schema 拒绝混合字段。撤回占位保持原结构，不增加 sender 字段。

原始 author_type/author_id、local_user、external_principal、Automation Run 作者 ID、渠道 Owner
认证与外发对象保持。Mission start 原本由 User 发起，投影为 user/user；不能因为正文由 Core
生成就标为 system。模型 user/system 不作为内部身份，也不能反向决定权限或渠道收件人。

按作者 ID 解析保留 Profile，不查询当前成员集合、不猜测名称、不读取 current-user-profile.json。
使用请求内缓存，包括名称缺失结果。名称表示本次投影时间；同名不合并 ID，改名不改历史目标。
组装实际需要的 input、SHARED_THREAD、读取/搜索结果时，只查询这些消息中 Agent 的当前名称，
同一批次复用查询结果。公开 batch 在原有输入组装阶段取名，名称随完整输入进入既有快照；
预算与最终渲染使用同一份值。非 batch 领取时不为名称扫描历史或查询 Profile，不另设名称快照、
持久缓存或恢复分支。已保存输入及工具回执沿用原有保存和回放机制，不重新取名。
读取/搜索仍在本次读取事务解析，不领取新责任。

body/snippet、Mention、引用作者、附件、时间、分页、可见性、FIFO 与截断算法保持。新增字段纳入
现有真实字节预算和最终 payload 摘要。旧 CURRENT_INPUT.source、私聊专用结构、send 入参/回执不变。

Agent Output **12** 取代上述三种工具的旧 author 字段输出。Transport/CLI **39**、IPC **3**、
Envelope **2**、capability `builtin_cli.transport.v39` 保持；Bootstrap/Charter 与所有 Binding compatibility
输入保持，包括 Antigravity 的既有工具版本字段。此处不扩大运输版本或更改恢复资格。
旧成功 read 的 addressing、mentions 两版与旧 search 回执仍按各自封闭结构校验，保留原字节和摘要。
新调用与新 Run 使用当前格式，包括旧 Session 中的新内容，不要求 Session 重建或升级。

确认与验证见 [R2](../versions/v1.72/model-context-change-message-senders.md)。
