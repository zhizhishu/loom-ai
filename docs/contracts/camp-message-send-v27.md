---
document_type: protocol-contract
contract: camp-message-send
version: 27
status: accepted
authority: user-message-runtime-delivery-selection
source_version: v1.72
last_updated: 2026-10-16
---

# Camp Message Send v27

继承 [v26](camp-message-send-v26.md) 的正文、附件、引用、幂等、成员与发布规则。
`thread.messages.send` 的 User inline 请求新增可选 `deliveryMode: "start" | "steer"`，缺省 start。
可选 `steerTargets: [{agentRunId, executionEpoch}]` 限定发起操作时可插话的执行；空数组表示没有目标。
Desktop/Web 根据提交时的同一发送预览传入目标，失效目标走普通队列，不改投后继 Run。
API 未给 targets 时由 Core 在发布事务捕获当前符合条件的目标。后续投递仍严格绑定该 Run／epoch。

一次请求发布一条普通用户消息，每位接收者独立按 [Delivery v13](message-delivery-v13.md) 路由。
多提及、广播、引用、Skill、文字附件和纯附件保持普通输入能力；不拆出纯文本，附件错误归本条投递。
Agent 工具不暴露 Steer 参数，普通 API、Automation、私聊、渠道与既有 waiting 消息的语义保持。

CampOpen 的 AgentRun 可选 `canSteer` 表示当前支持且已有初始接受证据，前端不从模型名猜能力。
MessageDelivery 增加可选 requestedMode 与 inputDeliveryStatus，正文和消息身份保持。
普通结束后的 fallback 安静更新回执；未知状态仅核对，不把重新发送藏在核对操作中。

## Agent 文件引用与发送教学

按已确认的 [R3](../versions/v1.72/model-context-change-send-file-guidance.md)，`rovai send --help`
将简单单行正文（包括 Markdown）交给 `--body`；多行或复杂正文通过 `--input-file` 读取。
发送成功后，Agent 清理自己创建且仅用于本次发送的临时输入；CLI 不自动删除文件。
附件、正文链接目标、用户已有文件及发送失败或结果未知时的输入不因该规则删除。

普通文件引用优先 Markdown 链接；用户要求附件或渠道收件人需要文件本身时使用 `--file`。
帮助保留文件/目录及重复参数用法，不增加归档指令。首例直接以 `--body` 发送 Markdown 链接；
第二例演示多行临时正文，`reply.md` 用 `e.g.` 标明为示例。两个寻址示例保持，总计四例。
`cli-operations` 的 Send reference 通过已有 exact-help 入口获取操作说明，不重复 Files 段。

新公共 Session Bootstrap 在 Thread 存在 active `feishu`、`lark` 或 `dingtalk` 绑定时追加同一条：

```text
This Thread is connected to an external channel. Local file paths and Runtime image previews are not delivered there; when the recipient needs the file itself, include `--file <path>` in the corresponding `rovai send` message.
```

Quick Chat/项目共用 Thread 绑定判断，不按当前客户端分支。Single Chat、closed、无绑定和未知 provider 不追加。
Charter revision 为 23，Binding compatibility 保持 16；已有 Bootstrap 不回写或强制轮换。
Send 输入/输出 Schema、原路径附件引用、纯附件消息、顺序、权限、生命周期和渠道重试规则保持。
