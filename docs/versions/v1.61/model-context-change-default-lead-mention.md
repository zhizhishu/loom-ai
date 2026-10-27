---
document_type: model-context-change
version: v1.61
change_id: default-lead-agent-input-mention
revision: 1
confirmation_status: confirmed
confirmed_by: local_user
confirmed_at: 2026-09-19T12:37:25+00:00
confirmed_revision: 1
authority: confirmed-model-input-change-statement
implementation_baseline: e9373e768048d73e01741c61717d2821abe9ec62
implementation_status: completed
last_updated: 2026-09-19
---

# 默认队长接收提示：模型输入变更（revision 1）

本提案修复一个可见性缺口：公开 Camp 消息没有显式 Member Mention、因而由当时的 Default Lead
接收时，Agent 的自动上下文只显示用户正文，看不到这条消息实际默认交给了谁。

修复只在 AgentRun 自动上下文中增加由 Core 生成的接收提示。它不修改用户原文，不把默认路由伪装成
用户显式寻址，也不改变 Delivery、权限或调度权威。开发者已经二次确认 revision 1；实现、Schema、当前合同
与验证必须遵循本文件，任何语义变化都须递增 revision 并重新确认。

## 变更前

### 1.1 当前消息与路由真源

本地 Composer 消息的用户内容以 `structured_content_json` 和对应 `content_digest` 为真源。没有
`MemberMention` 或 `AllMembersMention` 时，发布命令保存：

```ts
type StoredDefaultAddressBefore = {
  addressMode: 'default'
  addressedAgentIds: [resolvedDefaultLeadAgentId]
  structuredContent: StructuredCampMessageContent // 不含 Core 生成的 MemberMention
  body: string                                    // 用户内容的人类投影
}
```

`addressedAgentIds` 与 `camp_message_delivery` 冻结发布时解析出的接收者；后续更换 Default Lead 不会改写
既有消息的目标。路由权威已经正确，缺失的是 Agent 自动输入中的可见提示。

### 1.2 当前自动上下文 shape 与正文语义

公开 Camp 的 `RUN_INPUT` 当前 shape 为：

```ts
type RunInputV1Before = {
  messages: Array<{
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
  }>
}
```

`SHARED_CONVERSATION.messages[]` 使用同一个 Agent-facing Structured Content renderer 产生 `body`。
两处 `body` 都只渲染保存的 Structured Content，不读取默认路由来增加前缀。

例如，Default Lead 为 `agent_6 / 爱丽丝`，用户没有显式 Mention，发送：

```text
请检查这条消息
```

存储和投递为：

```json
{
  "addressMode": "default",
  "addressedAgentIds": ["agent_6"],
  "structuredContent": [{"kind": "text", "text": "请检查这条消息"}]
}
```

但接收 Agent 在 `RUN_INPUT.messages[].body` 中只看到：

```text
请检查这条消息
```

这与显式发送给爱丽丝时的 `@爱丽丝 请检查这条消息` 不一致，也迫使 Agent 依赖模型输入之外的
Delivery 实现细节才能知道默认接收关系。

## 变更后

### 2.1 完整 shape

公开 Camp 继续使用相同 JSON shape；不新增、删除或改名模型可见字段：

```ts
type RunInputV2After = {
  messages: Array<{
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
  }>
}
```

唯一模型可见变化是 `RUN_INPUT.messages[].body` 与 `SHARED_CONVERSATION.messages[].body` 的投影语义。

### 2.2 默认接收提示的精确生成规则

Core 对每条将进入自动上下文的 CampMessage 先渲染原 Structured Content，得到 `authoredBody`，再执行：

```ts
type DefaultRecipientMentionEvidenceV1 = {
  agentId: string
  displayName: string
}

type AgentAutomaticBodyProjectionV2 = {
  body: string
  defaultRecipientMention?: DefaultRecipientMentionEvidenceV1
}

function projectAutomaticBody(message): AgentAutomaticBodyProjectionV2 {
  const authoredBody = renderAgentPlainText(message.structuredContent)

  if (message.addressMode !== 'default') {
    return {body: authoredBody}
  }

  if (message.addressedAgentIds.length === 0) {
    // 无接收者的 public-only 消息。
    return {body: authoredBody}
  }

  assert(message.addressedAgentIds.length === 1)
  const agentId = message.addressedAgentIds[0]
  const displayName = resolveCurrentAgentDisplayName(agentId)
  const token = renderAgentPlainText([{kind: 'member_mention', agentId}])

  if (authoredBody.length === 0) {
    return {body: token, defaultRecipientMention: {agentId, displayName}}
  }

  const separator = startsWithUnicodeWhitespace(authoredBody) ? '' : ' '
  return {
    body: token + separator + authoredBody,
    defaultRecipientMention: {agentId, displayName},
  }
}
```

约束：

1. 接收身份必须来自消息已冻结的 `addressedAgentIds`，不能在投影时重新读取“现在的 Default Lead”。
2. 显示名使用既有 Agent Member Mention renderer 的当前名字解析规则；不存在的身份必须 fail closed，不能输出
   猜测名称、角色名或自由文本 `@队长`。
3. `addressMode = default` 且恰有一个接收者时才增加提示。显式 Member Mention、`@所有队员`、public-only、
   reply/continuation 的显式目标和 Agent 显式 `--to` 均不得重复增加。
4. 非空正文前默认插入一个 ASCII 空格；正文首字符已是 Unicode 空白时不再插入空格。只有附件而正文为空时，
   `body` 只包含 Mention token。
5. `addressMode = default` 却有多个接收者是非法状态，投影必须 fail closed。零接收者仍是合法 public-only。

因此上面的例子在新 AgentRun 中精确变为：

```text
@爱丽丝 请检查这条消息
```

若这条消息发布后 Default Lead 改成其他成员，既有消息仍显示其冻结接收者 `agent_6` 的 Mention；不能改成新队长。

### 2.3 生效面

新投影只用于 Core 自动注入 AgentRun 的两处消息正文：

- `RUN_INPUT.messages[].body`；
- `SHARED_CONVERSATION.messages[].body`。

同一消息同时出现在两处时必须得到相同 `body` 和相同 `defaultRecipientMention` evidence。`RUN_INPUT` 仍是
唯一处理责任；`SHARED_CONVERSATION` 中的同文不创建第二份责任。

下列面明确不增加前缀：

- 数据库 `camp_message.body` 与 `structured_content_json`；
- Renderer / Web 时间线正文、Composer、草稿、Pending 与复制结果；
- `rovai camp read/search` 的实时工具结果及其搜索索引；
- Quote snapshot、选文、引用正文和消息标题生成；
- Channel 出站正文、通知预览和外部平台消息。

人类时间线继续用现有 Delivery footer 表达“发送给 @成员”。实时 Camp Read 返回忠实的已发布内容；自动上下文
里的前缀是 Core 的接收提示，不是用户原文，因此不进入搜索语料，也不能被当作可引用原文。

### 2.4 路由、Mention 与权限语义

生成的 `@显示名` 只存在于已经完成寻址后的 Agent-facing 文本投影中：

- 发送寻址仍只由发布时的 Structured Content、`addressMode`、Address Resolution 与 Message Delivery 决定；
- 不向保存的 Structured Content 插入 `MemberMention`，不把 `addressMode` 从 `default` 改成 `explicit`；
- 不重新派发、不新增 Delivery、不改变 claim FIFO，也不授予 Runtime、Task、Mission、文件或工具权限；
- `mentionsCurrentUser` 仍只表达保存的 `CurrentUserMention`，默认接收提示不会设置或清除该字段；
- 引用、附件名或用户正文中看似 Mention 的字符仍不能触发寻址。

### 2.5 预算、选择与冻结 evidence

Core 必须先生成完整的新 `body`，再执行现有 Unicode scalar 计数、公共历史选择和 payload preflight：

- 默认接收 token 和可选分隔空格计入消息长度、公共历史预算与 payload 大小；
- `RUN_INPUT` 仍交付完整消息，不因前缀新增 continuation 或摘要；若 mandatory input 超过既有 payload 上限，
  继续走现有明确 preflight failure；
- `SHARED_CONVERSATION` 仍按现有增量窗口、正序与 omission 规则选择；前缀造成边界变化时允许更早的消息被遗漏，
  但不能截掉 Mention 后伪装成无目标正文；
- ContextManifest 每条 `RUN_INPUT` 与 shared-message evidence 新增可选
  `defaultRecipientMention: {agentId, displayName}`；不存在前缀时字段省略；
- 既有 `contentDigest` 继续只绑定已保存 Structured Content；`projectedBodyDigest`、`projectedInputDigest`、
  shared evidence digest、完整 payload digest 与 Blob digest 必须绑定增加提示后的精确字节。

冻结后重试或恢复同一 Run 必须复用原 Manifest、evidence 与 payload bytes。成员后来改名、队长后来变更或消息后来
出现在另一个 Run 的共享窗口，都不得重写已经冻结的 Run；新 Run 可按 claim 当时的当前显示名生成并冻结自己的 bytes。

## 明确不变

- Native Session Bootstrap、`SESSION_CHARTER`、`MEMBER_IDENTITY`、Memory Entrypoint 与固定 section 顺序不变。
- `RUN_INPUT` / `SHARED_CONVERSATION` 的 JSON 字段、字段省略规则、消息排序、批次领取、锚点和 Skill 解析不变。
- Default Lead 的选择、Message Delivery、claim、accepted-only watermark、withdrawal、回复和 continuation 权威不变。
- Composer Structured Mention、`@所有队员`、Current User Mention、Skill Mention 与 External Quote 的保存和渲染规则不变。
- Single Chat 的 `CURRENT_INPUT`、Formatter/Manifest 25、Profile 6、私有历史与 FIFO 不变。
- Camp Read/Search/Thread、FTS、Renderer Read Model、Channel、Automation、Mission、Task 与 Memory 合同不变。
- 用户内容 digest、Quote digest、附件引用、消息 ID/sequence、author identity 和 Message Delivery evidence 不变。
- `messageProjectionAudience = agent_v1` 保持不变；它仍表示 Agent-owned plain-text audience。精确投影 revision 由
  Formatter/Manifest 27 与 evidence digest 区分。

## 版本轴

| 轴 | 变更后 | 理由 |
| --- | --- | --- |
| Native Session Bootstrap / Formatter | v3 / 3（不变） | 固定 Bootstrap 字节不变 |
| public Session Charter | revision 10（本变更不再轮换） | revision 10 来自同版 Mission 完成判断增量；默认接收提示不改变 Charter 字节 |
| public AgentRun Context Formatter | 27 | 自动上下文的消息正文精确字节改变 |
| public ContextManifest | 27 | 新正文 digest 与 `defaultRecipientMention` evidence 必须冻结 |
| public Context Delivery Profile | 8 | 数值阈值不变，但默认接收 token 进入 scalar / payload 预算 |
| public Run Facts | 5（不变） | `RUN_FACTS` shape 与语义不变 |
| Message Projection Audience | `agent_v1`（不变） | audience 类型不变，由 Formatter 版本区分精确算法 |
| Built-in Tool / CLI / Agent Output | 29 / 29 / 3（不变） | 同版 Mission catalog 已使用 v29；默认接收提示不改变工具结果或 catalog |
| Renderer Read Model / Camp Open | 34 / 7（不变） | 人类消息正文和 footer 不改变 |
| Database schema | Migration 166 / projection schema 116 | 扩展 Manifest 27 / Profile 8 closed constraints，并在 `agent_run_input` 冻结 context version 与 claim-time 接收者显示名 |

Single Chat 继续使用 Formatter/Manifest 25、Profile 6；旧 public Camp Run 继续使用其原有 Formatter/Manifest，
包括历史 v26 / Profile 7。

## 数据迁移、兼容与恢复

这是 Manifest version 的增量升级，不迁移或重写 CampMessage：

1. Schema migration 只允许新领取的 public batch 写入 ContextManifest 27 / Profile 8，继续只读接受历史 19–26，
   为 `agent_run_input` 增加 `context_manifest_version` 与 nullable `default_recipient_display_name`；迁移前已领取的
   RunInput 回填 version 26、显示名保持 `NULL`，即使尚未创建 Manifest 也继续使用 v26/Profile 7；
2. 升级后尚未 claim 的 waiting Delivery 在首次 claim 时按 v27 生成新投影；消息内容和 Delivery 不变；
3. 已冻结、prepared、accepted、rejected、unknown 或正在恢复的 v26 Run 必须继续 exact replay v26 bytes，不能补前缀、
   改 digest、改 evidence 或重新领取消息；
4. 新 v27 Run 的 accepted ACK 仍绑定完整 Run、epoch、binding/generation 与 payload digest；水位推进规则不变；
5. Bootstrap 和 public Charter 未因本变更改变，因此现有合格 Native Session / Binding 不强制轮换；Core 只为新 claim 选择 v27；
6. 若 migration 或 v27 materialization 失败，事务回滚到 claim 前，Delivery 保持诚实 waiting，不得降级生成缺失提示的
   新 v26 Manifest；
7. 回滚应用版本时，已经冻结的 v27 Run 不能由不理解 v27 的旧 Core 恢复。运维必须先完成或终结 v27 in-flight Run，
   再按既有数据库备份/版本回退流程回滚，不能把 v27 行改写成 v26。

既有历史消息在新的 v27 自动上下文中出现时可以得到默认接收提示，因为路由目标来自其已保存
`addressedAgentIds`；历史消息没有可靠接收者元数据时保持原正文，不推测队长。

## 验证

### 7.1 正向行为

1. Default Lead 为爱丽丝时，本地用户发送无 Mention 文本，断言保存正文不变、`addressMode=default`、目标为
   `agent_6`，而新 `RUN_INPUT.body` 精确为 `@爱丽丝 <原文>`。
2. 同一消息同时进入 `RUN_INPUT` 与 `SHARED_CONVERSATION` 时，两处正文和 mention evidence 完全一致；只产生一份
   Delivery / processing responsibility。
3. 无正文但有附件的默认消息投影为单独 `@爱丽丝`，附件字段保持原样。
4. 原文以空格、换行和其他 Unicode whitespace 开头时，不额外插入 ASCII 空格；普通正文只插入一个空格。
5. 消息发布后更换 Default Lead，尚未 claim 的消息仍使用已冻结 recipient agent ID；显示名按 claim 时的既有
   Member Mention renderer 解析并写入 Manifest evidence。
6. 新 v27 Run frozen 后修改成员显示名或 Default Lead，恢复时仍逐字节复用原 payload 与 digest。

### 7.2 关键负向测试

1. 显式 Member Mention、`@所有队员`、reply/continuation 显式目标和 Agent `--to` 不增加第二个前缀。
2. public-only 零接收者消息、Single Chat、Mission/system 特殊输入和没有可靠历史接收元数据的消息不增加前缀。
3. 非 `default` 消息即使只有一个 `addressedAgentId` 也不增加前缀；`default` 多接收者与丢失 Agent identity 必须
   fail closed，不输出猜测文本。
4. Renderer 时间线、复制、Quote snapshot、Camp Read/Search/Thread、FTS 与 Channel 出站结果保持原正文；搜索
   `@爱丽丝` 不能仅因自动前缀命中一条无 Mention 的消息。
5. 自动前缀不改变 `mentionsCurrentUser`、content digest、address mode、Delivery 数量、目标、FIFO 或权限。
6. 恶意正文开头自行输入 `@名字`、引用内 Mention 或附件名 Mention 均不能伪造 evidence 或改变路由。

### 7.3 预算、evidence 与兼容

1. prefix scalar 计入 Profile 8 的公共历史选择与 payload preflight；覆盖恰好越过预算边界、emoji/CJK 名称和超长名字。
2. v27 Manifest 的 message evidence 条件携带 `defaultRecipientMention`，所有 projected/body/payload digest 与实际 bytes
   一致；无前缀时字段严格省略。
3. prepared/accepted v26 Run exact replay，waiting Delivery 升级后生成 v27；migration 中断不得产生半写 v27 行。
4. Schema closed constraints 接受历史 19–26 与新 27，拒绝 Manifest/Profile 非法配对；新 public batch 只能写
   27 / 8，Single Chat 仍只能写其现行版本。
5. 扩展 Rust 投影/Manifest/DB migration owner、共享 contract fixture 与 TypeScript contract test；运行相关 Core 测试、
   `pnpm docs:test`、`pnpm docs:check` 和 diff-aware `DOCS_BASE_REF=<base-sha> pnpm docs:check:ci`。

## 二次确认

当前状态：`confirmed`。

开发者 `local_user` 在阅读完整 revision 1 后，于 2026-09-19T12:37:25.839890+00:00 通过 Camp
`rvcamp_01m2wqyc2qfp0tyr3crka58qm1` 的消息 `6211754d-ba64-4bb7-a437-9cb0a200ce8a` 回复
“确认，改完pr到main”，明确确认本 revision 并授权继续实现、测试、提交 PR 与合并 main。此前原始修复请求与
提案起草不计作二次确认；本条发生在完整变更说明交付之后。

## 实施记录

- public batch 的 claim sizing、`RUN_INPUT` 与 `SHARED_CONVERSATION` 共用同一默认接收者投影器；
  `defaultRecipientMention` 同步进入 run-input/shared-message evidence。
- public Formatter/Manifest 已切换为 27，Context Delivery Profile 已切换为 8；Single Chat 25/6 不变，
  v26/7 frozen Manifest 继续 exact replay。
- Migration 166 / projection schema 116 扩展 closed version/profile 约束，在 AgentRunInput 冻结 context version
  与 nullable 的 claim-time `default_recipient_display_name`，并保留既有 Manifest 行；迁移前已领取但尚未
  materialize 的 Run 明确保持 v26/Profile 7。没有修改 `camp_message`、Structured Content、Delivery 或读取/搜索投影。
- 正向、显式/public-only 负向、非法目标 fail-closed、附件-only、Unicode 起始空白、共享历史、
  projected digest、旧 schema 升级与历史降级链均有自动化覆盖。
