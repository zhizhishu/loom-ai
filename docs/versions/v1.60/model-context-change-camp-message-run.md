---
document_type: model-context-change
version: v1.60
change_id: camp-message-agent-run
revision: 2
confirmation_status: confirmed
confirmed_by: local_user
confirmed_at: 2026-09-17T15:45:25+00:00
confirmed_revision: 2
authority: confirmed-model-input-change-statement
implementation_baseline: 717f198794d7514c022e6fad133bd63729cbf7d0
implementation_status: completed
last_updated: 2026-09-18
---

# Camp 消息与多输入 AgentRun：模型输入变更（revision 2）

本说明把开发者对 Q1–Q43 的最终回答收敛为一份可实现、可迁移、可验证的字段级合同。
它只改变公开 Camp。Single Chat 继续使用自己的 Conversation-local 队列、`CURRENT_INPUT`、
Formatter/Manifest 和 Built-in policy。

开发者已阅读并确认 revision 2，包括增量公共消息窗口与实时 Camp Read 语义。实现、Schema、当前 Contract、
Architecture 与 clean break 只能遵循本 revision；任何语义变更仍须递增 revision 并再次确认。

## 变更前

### 1.1 公开 Camp 的动态上下文

当前 public Camp 的动态 section 顺序为：

```text
[COLLABORATION_STATE]?
[SELF_ACTIVE_TASKS]?
[SHARED_CONVERSATION]?
[RUN_FACTS]
[WORKSPACE]?
[A2A_GUIDANCE]?
[CURRENT_INPUT]
```

`CURRENT_INPUT` 一次只表达一个 trigger。普通用户/渠道输入使用 `source + message`；A2A 使用
`source.type = member_call`；Mission start 和 Gather completion 使用互斥的特殊 shape：

```ts
type DirectCurrentInputBefore = {
  source:
    | {type: 'user'}
    | {type: 'external_principal'; provider: string; displayName: string}
  message: string
  mentionsCurrentUser: boolean
  quotes?: ModelQuote[]
  attachments?: string[]
  skills?: Array<{name: string; path: string}>
}

type A2ACurrentInputBefore = {
  source: {type: 'member_call'; senderAgentId: string; senderName: string}
  message: string
  mentionsCurrentUser: boolean
  quotes?: ModelQuote[]
  attachments?: string[]
}

type MissionStartBefore = {
  kind: 'mission_start'
  source: {type: 'user'}
  missionId: string
}

type GatherCompletionBefore = {
  schemaVersion: 3
  messageProjectionAudience: 'agent_v1'
  source: {type: 'gather_completed'}
  gatherId: string
  commandId: string
  requestMessageId: string
  request: object
  items: object[]
}
```

Direct、A2A、Mission start 与 Gather completion 由 `invocationKind`、单个 trigger message/delivery、
单个 A2A root/parent/depth 和 CampTurn 证明。一个 Run 不能同时接收多条普通输入。

### 1.2 现有 SHARED_CONVERSATION

当前 public projection 把历史拆成多个用途容器：

```ts
type SharedConversationBefore = {
  campId: string
  originatingPublicUserMessage?: ModelCampMessage
  referenceClosure?: ModelCampMessage[]
  recentMessages?: ModelCampMessage[]
  omittedMessages?: {
    count: number
    sequenceStart: number
    sequenceEnd: number
  }
}
```

历史消息可带 `replyToMessageId`、`nextBodyOffset` 和正文 prefix；recent 最多 15 条，总公共历史预算
24,000 Unicode scalars、单条通常 2,000 scalars、回复 closure 最多三层。当前 trigger 与当前 Agent 自己的
消息按既有规则排除。读取和 Context 候选通过 tombstone 过滤，但目标 Agent 在正式领取前仍可能通过其他
公共读取路径看到已经发布的正文。

### 1.3 现有 RUN_FACTS 与 A2A 指引

```ts
type RunFactsBefore = {
  schemaVersion: 4
  attachmentOutputRoot: string
  mission?: {
    missionId: string
    title: string
    status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
    updateNotice?: 'Mission details have changed. Read the latest mission name and description before handling CURRENT_INPUT.'
  }
  conversationMode?: ConversationModeFact
  taskContext?: TaskContextFact
  sessionContinuity?: SessionContinuityFact
  externalEffect?: ExternalEffectFact
  gather?: GatherFact
  delegation?: DelegationFact
}
```

`delegation` 投影固定 depth/accepted-A2A 预算是否已经禁止新 dispatch；`gather` 教导成员提交可捕获返回。
`A2A_GUIDANCE` 依赖 forward/return、单 root、parent 和 depth，帮助模型区分委派与 caller return。

### 1.4 现有版本轴与容量

- Native Session Bootstrap contract v3、Bootstrap Formatter 3；
- public Session Charter revision 7；
- AgentRun Context Formatter 25、ContextManifest 25、Delivery Profile 6、Run Facts 4；
- Built-in Tool Contract/CLI 26、Agent Output Projection 3、IPC 2、Envelope/Receipt 1；
- Runtime payload 默认 96 KiB，并被通用 8 KiB–1 MiB clamp 限定；
- Gather 是当前 Built-in catalog、CLI、Skill 和 Run Facts 的正式能力；
- Built-in request/response、Runtime Adapter 与 `camp.read` 仍存在不同层的总量拒绝、裁剪或缩页路径。

## 变更后

公开 Camp 使用下面的唯一执行输入和选择边界。

### 2.1 动态 section 顺序

public Camp 改为：

```text
[COLLABORATION_STATE]?
[SELF_ACTIVE_TASKS]?
[SHARED_CONVERSATION]?
[RUN_FACTS]
[WORKSPACE]?
[RUN_INPUT]
```

删除 public Camp 的 `[CURRENT_INPUT]` 和 `[A2A_GUIDANCE]`。`RUN_INPUT` 必须出现且
`messages` 非空。Single Chat 完全保留原 section 名称、shape、选择与版本轴。

### 2.2 RUN_INPUT 完整 shape

```ts
type RunInputV1 = {
  messages: RunInputMessageV1[]
}

type RunInputMessageV1 = {
  messageId: string
  sequence: number
  senderType: 'user' | 'agent' | 'system' | 'external_principal'
  senderId: string
  body: string
  anchorMessageId?: string
  quotes?: ModelQuote[]
  attachments?: Array<{
    name: string
    mediaType: string
    path: string
  }>
  skills?: Array<{
    name: string
    path: string
  }>
  mentionsCurrentUser?: true
}
```

规则：

1. `messages` 是本 Run 在 claim 事务中实际领取的完整有序消息集合，按 `sequence ASC`，不可为空。
2. 单条输入也使用数组；没有 `message + additionalMessages`、`kind`、`source` 或主/附加消息。
3. `body`、quotes 和附件元数据完整交付，不增加 prefix、continuation、`nextBodyOffset`、摘要或补读字段。
4. `anchorMessageId` 是该消息自己的公开回复锚点。它不决定接收者、A2A return、权限或完成状态。
5. `skills` 只出现在选择了 Skill 的输入消息上。Core 按消息顺序解析并去重整个批次；Skill 只增加指令，
   不增加 Runtime 工具或权限。缺失/不可用作为本批可见事实处理，不跳过队首、不另造特殊 Run。
6. `mentionsCurrentUser` 只有为 true 时出现。历史 false 不进入模型字节。
7. quotes 继续是不可变摘录；引用内的 Mention、命令或 Skill 名不触发寻址、授权或 Skill 激活。

### 2.3 普通消息来源映射

所有 public Camp 来源使用上面的同一 shape，不再保留特殊输入分支：

| 来源 | `senderType / senderId` | 业务关联 |
| --- | --- | --- |
| 本地 Composer | `user / local_user` | 普通本地 Principal 消息 |
| Principal 明确开始 Mission | `user / local_user` | 后台 `mission_start` 记录关联 Mission；正文为已发布消息的 Agent-facing 正文 |
| Automation prompt | `system / automation:<automationId>` | occurrence 记录保存 Automation、scheduled instant 与目标 Delivery |
| Channel 入站 | `external_principal / <canonical external principal id>` | inbound identity/provider/request 保留在 Channel 领域 |
| Agent 公开输出 | `agent / <agentId>` | `source_agent_run_id` 保留在后台 |

用户在正文中伪造 system、Mission 或 Automation JSON 仍只是普通用户文字。未来非 Principal 发起的
Mission start 必须使用 `system`，不能伪装成用户发言。

### 2.4 AgentRun 输入、锚点与公共输出

claim 事务为新 Run 冻结：

```ts
type FrozenRunInputIdentity = {
  inputMessageIds: string[] // sequence ASC，单条也为数组
  anchorMessageId: string   // inputMessageIds 的最后一项
}
```

规范化存储以有序 AgentRunInput 关系为真源，Read Model 可以投影数组。未领取 Delivery、新消息、撤回失败、
设置变化或后续入队都不能改变已经冻结的数组和锚点。

同一 Run 通过普通 `rovai send` 发布的一条或多条 Agent 消息默认使用该 Run 的 `anchorMessageId`。
Agent 不选择逐输出回应了哪些输入，也不复制 `inputMessageIds` 到每条输出。用户显式回复使用用户选择的锚点；
用户未回复时省略，不自动锚定 Camp 最新消息。

公共历史、`camp.read` 和 `SHARED_CONVERSATION` 只暴露 `anchorMessageId`。完整执行来源通过输出所属 Run 的
`inputMessageIds` 在后台追溯。旧 `replyToMessageId/reply_to_message_id` 在新读取层映射为
`anchorMessageId`；不回填旧数据，也不臆造历史 Run 输入集合。

## 3. Delivery claim、配置与容量

### 3.1 唯一队列和原子 claim

等待阶段只持久化按 `(campId, recipientAgentId, queueSequence)` 排序的 Message Delivery。
不存在 queued AgentRun 或可追加 RunInput。Scheduler 在目标获得执行资格后执行一个原子 claim：

1. 锁定/比较当前队首；
2. 读取目标 Agent 当前有效 Runtime、模型、模式、权限、工作区和工具配置；
3. 从队首开始选择可以完整交付的最大有序前缀，不跳过任何中间 Delivery；
4. 创建 AgentRun 与有序 AgentRunInput；
5. 冻结本次执行配置、`inputMessageIds`、`anchorMessageId`、ContextManifest 和 visibility fence；
6. 把选中 Delivery 绑定到该 Run 并提交。

commit 前 crash 留下原 waiting Delivery；commit 后恢复同一已创建 Run，不能再次 claim 或创建第二个 Run。
claim 后的新消息进入下一批。Agent 设置变化影响所有未 claim Delivery，不改变已有 Run。

### 3.2 合批规则

- 用户、A2A、Mission start、Automation 和 Channel 消息不因来源类型形成批次边界。
- 不按 caller、预算根、Mission、occurrence 或自动化“第一条消息”拆批。
- 当前 Agent 的执行配置在 claim 时统一冻结，不存在等待消息各自携带 Runtime 配置再做兼容合并。
- 消息来源不携带独立 Runtime 权限或工具能力；消息、引用、历史和 Skill 不能扩大 Run 权限。
- Core 在每个受控 operation 执行时继续校验真实执行身份、成员资格、operation 规则和 Approval。

### 3.3 固定输入预算

claim 使用本次 Runtime/model profile 的 `maxContextPayloadBytes`；未声明时为 `96 * 1024` UTF-8 bytes。
删除通用 1 MiB clamp，不新增另一个全局最大值。该预算只控制模型输入物化，不是协作预算、IPC request/response
上限或 Built-in result 上限。

选择以最终序列化字节为准：

```text
mandatory fixed sections + candidate RUN_INPUT prefix
→ 选择能完整容纳的最大 FIFO 前缀
→ SHARED_CONVERSATION 与其他可选上下文只使用剩余预算
→ 冻结 exact bytes 与 digest
```

必要 `RUN_INPUT` 不为公共历史让位。队首一条单独仍不能容纳时，Scheduler 为该 Delivery 创建一个精确 Run，
在 Runtime 接受前终态失败为 `context_payload_too_large`；该输入不截断、不摘要、不送给 Runtime，随后队列继续。

Runtime Input accepted ACK 绑定整个冻结 payload 和全部 `inputMessageIds`。不能推测其中一部分被接受、把另一部分
退回等待，也不能为了数组逐条发送多个原生 prompt。

## 4. SHARED_CONVERSATION vNext

### 4.1 完整 shape

```ts
type SharedConversationAfter = {
  campId: string
  messages: SharedMessageVNext[]
  omittedCount?: number
  historyReadCursor?: string
}

type SharedMessageVNext = {
  messageId: string
  sequence: number
  senderType: 'user' | 'agent' | 'system' | 'external_principal'
  senderId: string
  body: string
  anchorMessageId?: string
  quotes?: ModelQuote[]
  attachments?: Array<{name: string; mediaType: string; path: string}>
  mentionsCurrentUser?: true
}
```

删除 `originatingPublicUserMessage`、`referenceClosure`、`recentMessages`、`replyToMessageId` 和
`nextBodyOffset`。不自动展开锚点祖先正文；需要更早内容时使用 `camp.read`。

### 4.2 选择和省略

每个 `(campId, agentId)` 维护一个 `lastAcceptedContextPublicTailSequence`。它不是 claim 水位：只有某个 Run 的
整份 frozen Runtime input 在正确 binding/generation 上收到有效 accepted ACK 后，才把该 Run 冻结的
`currentPublicTailSequence` 提升为下一次 claim 的下界。prepared、rejected、unknown、单纯 claim 成功或迟到旧
binding ACK 都不能推进它；同 Run 的安全运输恢复必须复用原 ContextManifest 和原窗口。

新 Run claim 时原子冻结：

```text
下界（exclusive）= lastAcceptedContextPublicTailSequence
上界（inclusive）= claim 时 Camp 当前公共尾部 currentPublicTailSequence
```

选择规则：

- 候选是原始 `sequence` 位于 `(下界, 上界]` 且在 claim 时对当前 Agent 可见的公共消息。
- 不过滤当前 Agent 自己发布的消息，也不排除本 Run 已领取的消息。因此同一条消息可以同时出现在
  `SHARED_CONVERSATION.messages[]` 和 `RUN_INPUT.messages[]`；后者仍是本次必须处理的唯一输入责任真源。
- 候选保持原始时间顺序。数量上先取最新 15 条，再在 mandatory `RUN_INPUT` 之后的剩余 payload 预算内保留
  能完整容纳的最新后缀，最终按 `sequence ASC` 输出并按 message ID 去重。
- 每条消息的 body、quotes 和 metadata 是不可拆分整体；不输出 prefix、摘要、continuation 或尺寸造成的半条消息。
- 只要存在真实可见但未注入的候选，就同时输出正整数 `omittedCount` 与 opaque `historyReadCursor`；两者必须一起
  出现或一起省略。`omittedCount` 是 claim 时因 15 条上限或剩余字节预算被省略的候选数。cursor 定位到首条已注入
  消息之前；若一条也未注入，则定位到冻结上界之前的读取位置。
- 撤回消息和 claim 时被 recipient-specific suppression 隐藏的消息不属于候选，不计入 `omittedCount`。
  为保持纯 sequence 水位，这类消息若在水位推进后才变得可见，不做自动追补；它们仍可由实时 `camp.read`
  按调用时可见性读取。
- `historyReadCursor` 只是实时 `camp.read` 的定位游标，不恢复 ContextManifest 快照，也不把读取限制回本次上下界。
  因撤回或可见性变化，稍后读取的实际条数可以与冻结时的 `omittedCount` 不同。

## 5. Run Facts 与 Charter

### 5.1 Run Facts v5

public Camp 使用：

```ts
type RunFactsV5 = {
  schemaVersion: 5
  attachmentOutputRoot: string
  mission?: {
    missionId: string
    title: string
    status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
    updateNotice?: 'Mission details have changed. Read the latest mission name and description before handling RUN_INPUT.'
  }
  taskContext?: TaskContextFact
  sessionContinuity?: SessionContinuityFact
  externalEffect?: ExternalEffectFact
}
```

删除 `gather` 和 `delegation`，不输出 null、空对象、“unlimited”或改名预算字段。public Camp 不需要
`conversationMode`；Single Chat 继续使用自己的 Run Facts v4 shape 和 `conversationMode`。

`externalEffect` 只表示真实未决 Action/外部效果，不为普通 accepted-input unknown 伪造。Run 的内部
`accepted_input_outcome_unknown`、accepted evidence、`manual_retry_allowed=false` 和 isolation state 不需要全部进入
Run Facts；后续 Run 只有在存在真实相关外部效果时收到现有 `externalEffect` 提示。

### 5.2 Session Charter 与 Built-in catalog

public Camp Charter 中的完整 Built-in operation catalog 删除 `rovai gather`。不增加 multi-mention、reply counter、
讨论账本、轮询或 completion 替代物。Campfire 通过普通多目标 `rovai send` 邀请成员，并提示主持人尽量收齐
本轮受邀成员回复；未齐时不轮询、不催问，后续普通回复到达后继续。

成员 Skill 按输入处理本批讨论请求并向请求发送者返回一条普通完整消息，不能假设整个 Run 只有一个讨论输入，
也不能因发出讨论回复而忽略同批其他输入。

预算、depth、fanout 和 ancestor-cycle 文案全部删除；self-send 仍明确拒绝。所有 `rovai send --to` 都是普通显式
目标 Delivery，不从 anchor 推断 caller return 或获得额外权限。

## 6. Agent 消息可见性与撤回

### 6.1 可见性 fence

Core 对自动上下文、`camp.read`、`camp.search`、thread/reply 展开和结构化引用统一执行：

1. 仍满足本地撤回资格的 Principal Composer 消息只向 Principal 展示正文；任何 Agent 都不能读取。
2. 首个目标 Delivery 的 claim 事务使消息永久失去撤回资格。
3. 已 claim 目标通过该 Run 的 `RUN_INPUT` 接收完整消息。
4. 仍未 claim 的目标继续被隔离，不能通过历史、搜索、线程、引用或其他 Run 提前读取正文。
5. 非目标 Agent 在首次目标 claim 后按普通公共历史规则读取。

不建立自由文本衍生追踪或“认知撤销”。只要正文已经进入任一 frozen/accepted Runtime input、
ContextManifest 或等价 Runtime context，撤回必须失败。

### 6.2 撤回后的 Agent-facing 结果

撤回成功后：

- `SHARED_CONVERSATION`、Camp Read、搜索、线程和结构化引用全部过滤该消息；
- 不返回 Agent-visible tombstone，不占分页名额，不增加遗漏计数；
- 按 message ID 精确读取返回 `message.withdrawn`，不返回正文或 metadata；
- 人类时间线可以显示“你撤回了一条消息”，但该占位不是 MessageView；
- 其他已发布消息自己的 quote snapshot 不级联删除。

撤回事务清除 Rovai 活跃控制范围内的 body、structured content、本消息 quotes、附件关系、FTS、派生索引、缓存、
`content_digest` 和取消 Delivery 中复制的 body digest。零引用的受管附件可按既有资源清理；用户源文件和其他对象
仍引用的资源不删除。

保留 message ID、sequence、撤回者/时间、Delivery/cancellation 事实和原 publication command identity。
publication command 转为 erased-terminal receipt：同 command ID、同命令类型和 actor/Camp scope 返回稳定
`message.withdrawn`；类型或 scope 不同返回 idempotency conflict；两者都不进入 Handler。删除原 request digest，
不使用普通 content hash、HMAC 或第二套幂等系统，新消息必须使用新 command ID。

该合同只适用于 Principal 通过本地 Composer 直接发布的消息。Channel inbound、Automation、Agent/A2A 输出不提供
原文擦除式撤回。

## 7. 停止、失败、恢复与 Session

- 普通 Stop 只对精确 `agentRunId + version` 做 CAS。终态或版本变化返回 stale/already-terminal，不能改停后继 Run。
- Stop 不取消未 claim Delivery，不暂停 `CampId + AgentId` 队列，不新增 Camp/因果树停止或恢复入口。
- 产品不提供用户业务重试。明确 `not_accepted` 且无副作用风险的同 Run 运输恢复可以继续；它不是新 Run 或业务重试。
- accepted/outcome-unknown 不自动重放、不假定成功；Run 在主 UI 显示普通红色失败，内部保留类型化 outcome 与 evidence。
- Run 业务终态不等于执行隔离。后继 Delivery 在 execution-isolation ACK 前保持 waiting，不创建一个注定失败的 Run。
- 复用现有 Adapter stop/cleanup 证明；没有输出一段时间不是 quiescence 证明，也不提供用户确认后强制放行。
- cleanup `Unproven` 且旧执行仍可能写共享 executionRoot 时，临时阻止所有共享该 root 的新 dispatch；正常执行不因此互斥，
  不建设通用工作区锁或跨 Camp 排队系统。
- outcome unknown 后默认创建新 Native Session；只有 Adapter 已有能力证明旧 Provider turn 终止时才允许复用。
  不把建设通用 `native_turn.reconcile` 作为本版前置。

## 8. Mission、Automation 与 Channel 输入

### 8.1 Mission

Mission start 是一条普通 user-authored CampMessage 和普通 Delivery。后台 Mission start 事实保留幂等、业务关联和
Mission 状态；模型输入没有 `kind: mission_start`。Mission 本身继续维护业务状态，不从 Run、Delivery 或 Camp 空闲推断。

### 8.2 Automation

成功触发时，一个事务创建 `started` occurrence、新 Camp、首条 system CampMessage 和目标 Delivery。
Scheduler 随后立即尝试普通 claim；成功才创建 AgentRun，失败则 Delivery 等待而 occurrence 仍是 started，
occurrence time limit 从 admission 起继续计时。相同 Automation 看到 active occurrence 时直接
`skipped(overlap)`；不存在 queued occurrence、queue timeout、特殊 input kind 或来源型批次边界。

### 8.3 Channel

Channel inbound 在 CampMessage 和目标 Delivery 成功提交后完成接收，不等待 Agent 执行或外部回复。
同一 ChannelConversation 的后续消息可以继续进入普通队列。一个 Camp 最多一个 Channel binding。

Agent 在 Channel-bound Camp 通过普通 `rovai send` 成功发布公开消息时，Core 自动为该条消息创建独立、稳定去重的
ChannelDelivery。外发对象只有该消息和显式附件，不包含 Run 输入、执行日志或 anchor 关联正文；不依赖 Run trigger、
合批组成或 anchor。该 Camp 的成员公开 send 同样是渠道可见发言，内部非公开控制不能复用该发布接口。

ChannelDelivery 失败/重试不改变 CampMessage、inbound、AgentRun 或 Delivery，不重跑模型；渠道不可用时保留明确 outbox 状态。

## 9. Built-in 结果与 Camp Read

删除 Rovai-owned 的统一 request/response 总量阈值、Camp Read 80,000-scalar 预算、动态正文 prefix、尺寸缩页和
Runtime Adapter 对完整 Built-in 结果的静默截断。

`camp.read` 始终按调用时最新的 Camp 状态、调用身份与消息可见性执行，不受调用方 AgentRun 的
ContextManifest 上下界、`currentPublicTailSequence` 或 frozen visibility snapshot 限制。它先按 `limit <= 20`、
opaque cursor 和调用时可见性选择实际页面，再完整返回该页消息的正文、quotes、attachments/metadata 与
`anchorMessageId`。可见消息不足 limit 可以少于 limit；禁止选页后因序列化大小减少数量。

所有 Agent-facing 读取路径继续应用同一正文隔离规则：仍可撤回的排队消息对任何 Agent 不可见；首次目标 claim
原子关闭该消息的撤回资格；之后，尚未 claim 自己 Delivery 的目标 Agent 仍被 recipient-specific suppression 隔离，
已 claim 目标通过 `RUN_INPUT` 接收，非目标 Agent 按普通历史规则读取。cursor 和按 ID 读取都不能绕过隔离或撤回。

实时读取可以看到 Run claim 后新发布、且当前可见的消息；这些消息只是即时背景，不因此加入 frozen
`RUN_INPUT`，也不证明当前 Run 已处理它们。`camp.read` 不推进 required-input receipt、
`lastAcceptedContextPublicTailSequence` 或任何 accepted-only 水位。

一次需要完整结果的 Agent-facing 调用只有两种结果：完整到达后成功，或无法完整交付时明确失败/中断。
不允许 success + truncated，不引入 preview、blobRef、nextOffset 或要求 Agent 再调用一次的补读语义。

Core/CLI/Runtime 可以使用 bounded buffer、分段 transport、backpressure 和 managed spool/ref 控制内存；这些内部机制
不得改变逻辑结果或泄露内部 envelope。Provider context、物理内存、磁盘、操作系统和第三方协议限制继续存在，
触碰时诚实失败。本合同不承诺无限容量。

## 10. ContextManifest 与 evidence

public ContextManifest vNext 至少冻结：

```ts
type PublicRunInputEvidenceVNext = {
  inputMessageRefs: Array<{
    messageId: string
    sequence: number
    contentDigest: string
    projectedMessageDigest: string
    deliveryId: string
  }>
  anchorMessageId: string
  runInputDigest: string
  runInputByteLength: number
  frozenExecutionConfigDigest: string
  skillSelectionSnapshotDigest: string
  currentInputSkillResolutionDigest: string
  messageVisibilityFenceVersion: number
  previousAcceptedPublicTailSequence: number | null
  currentPublicTailSequence: number
  sharedConversationMessageIds: string[]
  sharedConversationOmittedCount: number
  historyReadCursor?: string
}
```

Manifest 保存 exact dynamic-context bytes/digest、Profile、omission evidence、workspace/mission facts和当前 binding/generation。
删除单 trigger source、A2A root/parent/depth、Gather completion evidence、delegation fact refs 和特殊 Mission input evidence。

Run input accepted ACK 必须匹配 Run、epoch、binding/generation 和整批 payload digest；成功后一次把该 Run 冻结的
`currentPublicTailSequence` 写为对应 `(campId, agentId)` 的 `lastAcceptedContextPublicTailSequence`，并推进 Mission details、
Workspace delivery watermark 和其他既有 accepted-only 水位。prepared、rejected、unknown 或迟到旧 binding ACK
都不能推进。ContextManifest 保存自动上下文的完整选择证据，但不限制 Run 内后续 `camp.read` 的实时读取范围。

## 明确不变

- Single Chat 的 Conversation-local FIFO、`CURRENT_INPUT`、Formatter/Manifest 25、Profile 6、Run Facts 4、
  private history 和 Built-in policy 不变。
- Native Session Bootstrap contract v3、Bootstrap Formatter 3、Member Identity、Memory Entrypoint 与
  compaction redelivery 机制不变；public Charter digest 按 revision 8 正常变化。
- `COLLABORATION_STATE`、`SELF_ACTIVE_TASKS` 和 Mission/Workspace accepted-only 水位的既有权威不变，
  只把固定 Mission notice 中的 section 名从 `CURRENT_INPUT` 改为 `RUN_INPUT`。
- Task 与 Mission 的业务完成状态不从 Run/Delivery 推断；Memory 捕获也不把一个批次的全部输入自动记为完成。
- Agent 当前 Runtime 权限、成员资格、Approval 和受控 operation 校验不因多输入合批扩大。
- Workspace 没有事务回滚。本版只在故障 cleanup 未证明且旧进程仍可能写入时使用临时 dispatch fence，
  不建立日常工作区锁、Camp 全局 busy 或通用资源锁管理器。
- 用户原始附件文件、其他消息自己的 quote snapshot、已发布消息及历史 frozen evidence 不因 Draft 清理或撤回级联删除。
- Provider context limit、物理内存、磁盘、操作系统和第三方协议限制继续存在；删除 Rovai-owned 总量阈值不表示无限容量。
- Camp ID、Agent ID、membership identity、Task、Mission、Memory、Runtime Activity 和 Runtime qualification 语义不变。

## 11. 版本轴

确认后 public Camp 发布下列版本：

| 轴 | 变更后 |
| --- | --- |
| Native Session Bootstrap contract / Formatter | v3 / 3，不改变固定 Bootstrap 结构 |
| public Session Charter | revision 8，删除 Gather/预算/旧单 trigger 指引 |
| public AgentRun Context Formatter | 26 |
| public ContextManifest | 26 |
| public Context Delivery Profile | 7 |
| public Run Facts | 5 |
| Built-in Tool Contract / CLI Command | 27 / 27 |
| Agent Output Projection | 3，结果 shape 不因大小分流 |
| IPC / Envelope / Receipt | 2 / 1 / 1，wire shape 不因删除总量 cap 而改名 |

Single Chat 继续使用 Formatter/Manifest 25、Profile 6、Run Facts 4、`CURRENT_INPUT` 和原 Built-in policy。
旧 frozen public ContextManifest 22–25、Run Facts 2–4、Gather completion、A2A guidance 和 tool evidence 按原版本只读解释，
不重新格式化、回填 inputs、重算 anchor 或改写 digest。

public Charter 和 tool catalog 变化使旧 public Native Binding 不再适合新输入。cutover 后为 public Camp 新 Run 创建
新 Native Session/Binding；旧 Session 仅作为历史/cleanup evidence 保留。Single Chat Binding 不因本版强制轮换。

## 12. 数据迁移与 cutover

切换采用单轨停机窗口，不双写两套 scheduler：

1. 暂停接收新的 public Camp execution admission；
2. 让旧 running/frozen execution 与 active Gather 安全终结或保留诚实 unknown；
3. 终止旧 scheduler、completion pump、retry/recovery scanner 的新写入资格；
4. 执行末端 Migration；
5. 发布新 Context/Tool capability 并启动 Delivery-first scheduler；
6. 恢复 public Camp admission。

Migration 规则：

- 历史 CampTurn、终态 Gather、Run、Delivery、ContextManifest、command result 和 evidence 原样只读保留；不改旧 migration。
- 所有非终态 Gather 必须在切换前终结；Migration 不伪造 completion，不把它转成普通消息聚合。
- 已公开且尚未被任何 Runtime 冻结/接受的旧 waiting responsibility 转成或保留为一条新 waiting Delivery，保持目标和顺序。
- 旧 queued Run 只有在没有 frozen manifest、accepted/unknown evidence 或副作用权威时，才由 Migration 终态化旧 Run并保留其
  原公开消息的 waiting Delivery；已经冻结的旧输入不重新格式化为 `RUN_INPUT`。
- accepted/outcome-unknown 旧输入永不作为未执行消息重新入队。
- 删除旧 Composer Draft、未公开 Pending、编辑 session、恢复锁和可被旧逻辑重新激活的状态；不迁移 legacy recovery。
- 删除 Draft/Pending 附件引用时不删除用户源文件；已发布消息及附件不变；本版不新增引用计数 GC 或迁移文件清理任务。
- 旧 `replyToMessageId` 不回填；新读取层映射为 `anchorMessageId`。
- 旧 Gather 历史可以继续显示只读“rovai gather”标签，但该标签与当前 catalog/help/capability digest 分离。
- 旧 cursor 可以明确失效；不能绕过新 visibility/withdrawal 规则读取正文。

## 验证

### 13.1 Context golden 与选择

- 单条和多条 `RUN_INPUT.messages[]` 的完整字段、顺序、digest 与 accepted ACK；
- mixed user/A2A/Mission/Automation/Channel FIFO batch，不因来源拆批；
- max prefix、mandatory-first、96 KiB fallback、无 1 MiB clamp、超大队首明确 preflight failure；
- `SHARED_CONVERSATION.messages[]` 使用 accepted 水位到当前 claim 尾部的增量窗口，包含当前 Agent 自己的消息和
  可能重复出现的本批 `RUN_INPUT`；最新 15 条、正序、完整消息，无 prefix、closure 容器或 next offset；
- claim 未 accepted 不推进水位；同 Run 恢复复用原窗口；`omittedCount` 与 `historyReadCursor` 成对出现，
  后续读取按实时可见性执行而不恢复 Manifest 快照；
- public Formatter/Manifest 26 与 Single Chat 25 并存；旧 frozen context exact replay。

### 13.2 调度、停止与恢复

- 同 `(Camp, Agent)` 并发 claim 只有一个成功；commit 前后 crash 分别恢复 waiting Delivery或同一 Run；
- 设置修改只影响未 claim Delivery；新消息不追加 frozen Run；严格 FIFO 不跨超大/失败队首；
- Stop CAS 不误停 successor；终态后正常 claim 下一批；没有 pause/retry UI 或业务 API；
- accepted/unknown 红色失败、禁止重放、cleanup ACK、迟到 launch、process reap、executionRoot 临时 fence和新 Session。

### 13.3 可见性、撤回与幂等

- claim 前所有 Agent 读取路径不可见；首个 claim 后非目标可见、未 claim 目标仍隔离；
- `camp.read` 可读取 claim 后新发布的当前可见消息，但不把它们变成当前 Run 输入，也不推进 accepted 水位；
- 撤回与 claim 竞争只有一个事务结果；撤回后 Read/Search/Thread/Quote/旧 cursor 不泄露正文；
- body、structured content、FTS、cache、digest、附件关系和 Delivery snapshot 清理；其他 quote snapshot不级联；
- erased-terminal command ID 同 scope 返回 withdrawn，异 scope/type 冲突，均不再执行 Handler。

### 13.4 Gather、预算与工具 clean break

- `rovai gather` 不存在于 CLI/help/catalog/capability，调用明确未知；旧历史标签仍可读；
- 没有 captured return、completion pump、Run Facts gather/delegation、budget/depth/fanout/ancestor cycle；self-send仍拒绝；
- Campfire 普通多目标 send，回复正常进入发起者 FIFO，未齐时没有 completion 自动唤醒。

### 13.5 Channel、Automation 与完整结果

- Automation `started/skipped(overlap)`、普通 Delivery claim、等待 timeout、无 queued occurrence和无重复 Run；
- Channel inbound admission 即完成；Channel-bound 每条 Agent public message只生成一个 outbox，重试不重跑模型；
- 合法 request 和 response 超过旧 1/8/16 MiB，Camp Read 超过 80k scalars，Unicode/emoji/quotes/metadata仍完整；
- 慢接收与分段到达保持同一完整结果；传输中断不被标记 success；replay byte/digest与首次定稿一致。

## 二次确认

当前状态：`confirmed`。

开发者 `local_user` 在 2026-09-17T15:45:25.651049+00:00 通过 Camp 消息
`ec09870c-3d97-4e07-9c1a-166ed05f9086` 回复“确认”，明确确认 revision 2。

确认本 revision 表示授权实现本文件完整前后合同、版本轴和 clean break；不表示测试、Migration、代码或产品验收已经完成。
任何语义变化都必须递增 revision 并重新确认。仅修复错字、链接或不改变合同的表达可保留 revision。
