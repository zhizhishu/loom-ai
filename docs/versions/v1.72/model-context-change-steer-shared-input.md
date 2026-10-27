---
document_type: model-context-change
version: v1.72
change_id: steer-shared-input
revision: 3
confirmation_status: confirmed
confirmed_revision: 3
confirmed_by: User
confirmed_at: 2026-10-14
confirmation_message_id: 52de18ca-e5df-4c91-b2a7-ee998f8068b0
authority: proposed-model-input-change-statement
implementation_status: implemented
review_baseline: 41c8ca19238de8465c23ff0c030f5c7620dd2c02
last_updated: 2026-10-14
---

# 普通消息与 Steer 共用上下文：R3 前后对比报告

这是一份**已确认并实施的 R3 方案**。每个项目都将变更前、变更后紧挨着放。
“变更前”来自上述代码基线；前后对照保留确认时的规则，实际实现与验证见文末实施记录。

核心变化是：**每次新的投递生成自己的动态上下文，普通消息和 Steer 使用同一套构建及格式化规则。**
模型可见的结构保持现状；historyHint 只说哪些消息在当前输入中、是否还有额外消息，
直接用已有序号限定范围。Additional Skills 和其余提示词保持原样。
内部需要解除“一个 Run 只有一份输入上下文”的限制，但不另建 Steer 消息类型、补充消息库或提示词体系。

本轮复查不扩大提示词改动。以下是 R2 提案中的问题及 R3 修正，不是已经实施的产品缺陷修复：

| R2 的问题 | R3 修正 |
| --- | --- |
| historyHint 仍用一句话介绍“记录的公屏边界”，紧接着又重复该范围 | 直接说 `after sequence {P}`，每种提示只留一句，不增加术语教学 |
| 目标是共用动态 Builder，但未指出现有 Run 准备入口还会读取最新身份 | 动态构建共用；执行身份、权限、模型、Bootstrap 来自当前执行的冻结环境 |
| 消息格式已对齐，尚未检查附件／Skill 准备和恢复中的 Run 级查找假设 | 这些内容一起按本次来源消息选择，不能复用 Run 初始输入的资源选择 |
| 已要求支持一 Run 多输入，但未展开具体查找／ACK 分支的影响 | 按具体输入关联 Manifest 与回执；同队员按既有消息顺序提交，旧回执不覆盖新标记 |
| 未说明 Run 结束时如何处理已关联但尚未送出的插话 | 未提交的插话继续普通投递；Run 成功不能代替该条输入的投递证据 |
| “恢复原字节”容易被读成允许重发；“共用”容易被读成跨不同 Session 的整包必须相同 | 恢复不授权重发；只在相同构建事实和发送条件下比较动态内容，Runtime 包装沿用原规则 |
| 按旧 Manifest 版本一概禁止活跃 Run 插话，没有实际能力依据 | 旧输入原样恢复；是否能插话按实际活跃执行与 Runtime 能力判断 |

后面新增的实施约束不进入模型提示词。不为这些工程问题增加 Steer 指导、消息标签或新的历史说明。

当前基线为 public Manifest／Formatter 36、Profile 13、Run Facts 9。本文仅覆盖公开 Thread 的
用户 Steer 和它与普通公开消息共用的上下文路径；Agent 消息仍走普通投递，Single Chat 和渠道入站不扩展 Steer。
用户已经明确的多队员 @、附件消息与纯附件消息均纳入；不采用最初转发方案的单目标、纯文本限制。

## 1. 构建入口与 Runtime 分工

### 变更前

```text
本队员 waiting Delivery
  → 按完整上下文预算选择本批消息
  → 创建 Run，冻结 AgentRunInput 和本 Run 的 claim 上下文
  → Context Builder / Formatter
  → 当前 Runtime 输入投递路径，启动执行

同一 Run 再次 materialize
  → 恢复原 Manifest / payload
```

当前公共消息路径没有已接入的产品 Steer 构建入口。重复调用 `materialize_inner` 并不会生成
一份新插话上下文；找到已有 Manifest 时会直接返回它。

### 变更后

```text
本队员本次投递的消息集合 + 当前执行的冻结环境
  → 共用 Context Builder：读取并冻结本次动态上下文
  → 共用 Formatter：生成普通的 RUN_INPUT 与其余现有区段
  → Runtime 投递层
       开始执行：普通投递
       注入指定活跃执行：Steer

恢复／重试同一次已准备投递
  → 恢复该次投递的原 payload
```

Builder 和 Formatter 不接受 `isSteer` 来改变内容。它们需要的是接收队员、已确定的执行环境、
本次消息集合及共同的上下文／预算策略。目标活跃 Run、执行代次、原生输入关联和能力检查归 Runtime 投递侧。
这不取消投递层的 Steer 准入检查，也不意味着所有 Runtime 已支持注入。

这里共用的是动态上下文构建，不能直接把现有整段 Run 启动准备拿来再次运行。
当前 `ClaimedBatchContext::prepare` 会读取最新 Bootstrap 和成员身份；普通新 Run 仍按原流程准备，
向已有执行投递时则使用该执行已冻结的身份、Bootstrap、模型、权限及工作区归属。
动态 Tasks、协作名单、Mission 状态和本次消息按共同规则刷新；两类数据的来源不能混用。

## 2. 动态上下文区段与顺序

### 变更前

```text
COLLABORATION_STATE?
SELF_ACTIVE_TASKS?
RUN_FACTS
WORKSPACE?
ROVAI_ADDITIONAL_SKILLS
RUN_INPUT
```

### 变更后

```text
COLLABORATION_STATE?
SELF_ACTIVE_TASKS?
RUN_FACTS
WORKSPACE?
ROVAI_ADDITIONAL_SKILLS
RUN_INPUT
```

顺序、标签和 JSON 包装不变。`?` 表示沿用现有条件省略，并不代表 Steer 可以任意少发。
每次新投递重新执行共同构建规则；“重新构建”不等于强制重发所有区段。
协作信息和工作区仍使用现有已接受标记判断是否需要发送，可选 Tasks 仍按共同预算选择。
当前公开 batch 不包含 `SHARED_THREAD`、`CURRENT_INPUT`、`A2A_GUIDANCE` 或 `SINGLE_CHAT_GUIDANCE`；
通用 Formatter 中仍有历史／非 batch 分支，不把它们误列为本次公开输入的区段。
不新增 `STEER_INPUT`、`STEER_GUIDANCE`、`SUPPLEMENT` 或“这是一次插话”的前缀。

## 3. RUN_INPUT：格式不变，取本次投递的消息

以下是同一条示例用户消息的完整模型投影，ID、目录和内容均为说明用的虚构值。
为了可读性展开 JSON；当前 Formatter 的单行紧凑 JSON 序列化方式不改。

### 变更前：普通消息

```json
{
  "messages": [
    {
      "messageId": "msg-103",
      "sequence": 103,
      "senderType": "user",
      "senderId": "local_user",
      "body": "@爱丽丝 @雾切响子 请按附件补充空状态。",
      "anchorMessageId": "msg-100",
      "quotes": [
        {
          "kind": "message_excerpt",
          "source": {
            "scope": "current_messages",
            "messageId": "msg-100",
            "author": { "type": "user", "displayName": "用户" }
          },
          "text": "保留现有界面风格。"
        }
      ],
      "attachments": [
        { "name": "empty-state.png", "mediaType": "image/png", "path": "/example/attachments/empty-state.png" }
      ],
      "mentions": [
        { "id": "agent_6", "name": "爱丽丝" },
        { "id": "agent_7", "name": "雾切响子" }
      ],
      "skills": [
        { "name": "ui-ux-pro-max", "path": "/example/skills/ui-ux-pro-max/SKILL.md" }
      ]
    }
  ]
}
```

### 变更后：普通消息或 Steer

```json
{
  "messages": [
    {
      "messageId": "msg-103",
      "sequence": 103,
      "senderType": "user",
      "senderId": "local_user",
      "body": "@爱丽丝 @雾切响子 请按附件补充空状态。",
      "anchorMessageId": "msg-100",
      "quotes": [
        {
          "kind": "message_excerpt",
          "source": {
            "scope": "current_messages",
            "messageId": "msg-100",
            "author": { "type": "user", "displayName": "用户" }
          },
          "text": "保留现有界面风格。"
        }
      ],
      "attachments": [
        { "name": "empty-state.png", "mediaType": "image/png", "path": "/example/attachments/empty-state.png" }
      ],
      "mentions": [
        { "id": "agent_6", "name": "爱丽丝" },
        { "id": "agent_7", "name": "雾切响子" }
      ],
      "skills": [
        { "name": "ui-ux-pro-max", "path": "/example/skills/ui-ux-pro-max/SKILL.md" }
      ]
    }
  ]
}
```

**这两个内容相同。** 对同一接收队员、同一消息集合和同一动态状态，选择普通发送或 Steer
不能导致 Builder／Formatter 产生不同格式。`messageId`、`senderId` 等均为普通消息已有字段，
不是为 Steer 新增身份。`mentions` 保留整条消息的全部有效目标，不裁成只剩当前接收队员。

整份动态内容的字节比较还要固定执行环境和区段发送条件。新 Session 与已有 Session 需要发送的
Bootstrap、协作或工作区可能不同，这些现有条件差异不构成一套 Steer 格式；Runtime 原生包装也不要求相同。

完整字段与省略规则继续如下；Steer 仅限制外层消息作者必须是用户，不限制被引用内容的作者：

| 字段 | 必选／可选与含义 | 本次是否改变 |
| --- | --- | --- |
| `messages` | 本次投递的非空有序消息数组；普通批次可含多条 | 结构不变，新增在同一 Run 内按每次投递选取 |
| `messageId`, `sequence` | 原公开消息身份与顺序 | 不变 |
| `senderType`, `senderId` | 原作者类型与身份，不能把 Agent 原消息伪装成用户消息 | 不变 |
| `body` | 正文采用现有投影；纯附件可为空字符串 | 不变，不追加插话前缀 |
| `anchorMessageId` | 有回复锚点时才出现；它不是 Steer 目标 Run ID | 不变 |
| `quotes` | 非空时出现；每项含 `kind`, `source`, `text` | 不变 |
| `quotes[].source` | `scope: "current_messages"`、原 `messageId` 和捕获时的 `author` | 不变 |
| `quotes[].source.author` | `{type:"user",displayName}` 或 `{type:"agent",agentId,displayName}` | 不变，引用不生成执行授权 |
| `attachments` | 非空时出现；每项恰为 `{name, mediaType, path}` | 不变；不是路径字符串数组 |
| `mentions` | 正常公开消息必有；无目标时为 `[]`；Agent 项为 `{id,name}`，用户关注项为 `{id:"user"}` | 不变，不输出 `mentionsCurrentUser` |
| `skills` | 有已选择且可用的链接时出现；每项 `{name,path}` | 不变；链接失效仍按既有检查收缩 |

不额外输出投递 ID、目标 Run ID、投递方式、运行内序号、回执状态或上下文版本号。
它们的必要关联保留在现有投递证据侧，不进入消息正文。

### 变更前：同一 Run 的消息范围

```text
Run A 启动输入：msg-101、msg-102
Run A 的 RUN_INPUT：msg-101、msg-102
再次读取 Run A 已冻结上下文：仍是 msg-101、msg-102
之后到达的 msg-103：当前产品沿普通 Delivery 路径等待后续执行
```

### 变更后：同一 Run 的消息范围

```text
Run A 启动输入：msg-101、msg-102
启动投递的 RUN_INPUT：msg-101、msg-102
第一次 Steer 投递的 RUN_INPUT：msg-103
第二次 Steer 投递的 RUN_INPUT：msg-104
恢复第一次 Steer 的已准备输入：仍是 msg-103 对应的原始 payload
```

启动输入及其证据保持冻结；不会改成 `[msg-101,msg-102,msg-103]`，也不会在第二次插话中重带
`msg-103`。历史按现有读取能力获取，不为了 Steer 拼接对话历史或模型上一段输出。
上例每次 Steer 含一条，是举例；共用结构仍为数组，不为 Steer 单独改成单消息对象。

同一组来源消息必须同时决定正文、引用、附件、Skill 选择及相应恢复材料。
例如启动消息引用附件 A、插话引用附件 B，本次输入与附件准备都只能从本次消息选出 B，不能因
只替换 JSON 正文而继续沿用 A 的 Run 级资源选择。Skill 也不能继续使用启动时的消息选择。
这里限定的是本次消息触发的 Skill 链接；成员已配置的通用 Skill 索引仍按普通规则构建。
普通路径现有的来源解析与可用性检查继续复用；已冻结的原生工具配置和权限不随新 Skill 链接扩张。

## 4. RUN_FACTS.historyHint：四种完整文本相邻对照

当前提示由历史边界 `P` 和“是否存在额外可见消息”选出。Agent 只需要知道这个历史范围和
当前输入是否包含该范围内的消息，不需要理解 ACK、投递或快照。

保留这次小幅修正的原因是：插话在 Run 已经开始后到达，动态上下文描述的是新输入时的消息范围，
继续写“上次 Run”或“本 Run 开始时”会指向错误时点。R3 也删去 R2 的边界介绍句，
直接用已有序号限定范围。既有“是否存在额外消息”的意义保持，不增加读取要求或工程术语。
普通消息和 Steer 共用以下四种单句文本。

### 4.1 已有边界，没有额外可见消息

**变更前**

```text
The latest public message before your last recorded run in this Thread had sequence {P}. As of this run's start, all visible messages after that sequence are already in RUN_INPUT or were written by you.
```

**变更后**

```text
All visible messages after sequence {P} are in RUN_INPUT or were written by you.
```

### 4.2 已有边界，存在额外可见消息

**变更前**

```text
The latest public message before your last recorded run in this Thread had sequence {P}. As of this run's start, there are additional visible messages after that sequence beyond RUN_INPUT and messages written by you.
```

**变更后**

```text
There are additional visible messages after sequence {P} beyond RUN_INPUT and messages written by you.
```

### 4.3 没有既有边界，没有额外可见消息

**变更前**

```text
As of this run's start, all visible messages in this Thread are already in RUN_INPUT or were written by you.
```

**变更后**

```text
All visible messages in this Thread are in RUN_INPUT or were written by you.
```

### 4.4 没有既有边界，存在额外可见消息

**变更前**

```text
As of this run's start, there are additional visible messages in this Thread beyond RUN_INPUT and messages written by you.
```

**变更后**

```text
There are additional visible messages in this Thread beyond RUN_INPUT and messages written by you.
```

### 4.5 实现侧的判断范围与冻结时点

以下用于实现与验证，不新增任何模型可见字段、快照信息或教学提示。

| 事项 | 变更前 | 变更后 |
| --- | --- | --- |
| `P` | 本队员上一次有效 accepted ACK 对应 Run 启动时记录的公屏尾；无记录为 0 | 本队员上一次有效 accepted 输入对应的投递快照公屏尾；初始输入与 Steer 同样处理，无记录为 0 |
| `T` | 本次 Run claim 的公屏尾 | 本次新投递冻结动态上下文时的公屏尾 |
| `I` | 本 Run 最终选入 RUN_INPUT 的消息 ID 集合 | 本次投递最终选入 RUN_INPUT 的消息 ID 集合 |
| 额外消息判断 | 在 `(P,T]` 内查询可见消息；排除 `I` 和自己写的消息 | 同一查询规则，不另存正文、数量或完整历史快照 |
| 无既有边界 | `P=0` 时检查截至 `T` 的全部可见消息，不能直接断言“没有” | 不变 |
| 冻结 | 与 Run claim 同事务；后续不按实时消息重算 | 与本次投递的消息选择同一一致性快照；恢复同次投递时不重算 |
| 查询失败 | 回滚 claim，不领取消息，不制造“未知”提示 | 回滚该次投递准备，不制造“未知”提示 |

`P` 始终只是历史提示边界，不表示此前每条消息已读、已处理或已完成。它不能参与剔除 waiting Delivery。
例如序号 102 仍排队、103 已 Steer 接受：102 仍须正常投递；不能因接受边界前进而丢掉它。
本次不新增已读水位或第二套历史裁剪算法。ACK 只能推进匹配输入的既有证据；迟到 ACK 不得复活旧执行。

## 5. ROVAI_ADDITIONAL_SKILLS：保持原文

本节不改提示词；`Current for this run` → `Current for this input` 没有必要。
现有句子已经明确“替换此前索引”，在同一个 Run 中收到更新后的索引并不与它矛盾。
这与 historyHint 明确断言“Run 开始时”的历史范围不同，不需要为了术语统一而修改。

### 变更前

```text
[ROVAI_ADDITIONAL_SKILLS]
Current for this run; replaces any earlier Rovai Additional Skills.
{"root":"/example/skills","skills":[{"name":"member-studio","desc":"Example description."}]}
[/ROVAI_ADDITIONAL_SKILLS]
```

### 变更后

```text
[ROVAI_ADDITIONAL_SKILLS]
Current for this run; replaces any earlier Rovai Additional Skills.
{"root":"/example/skills","skills":[{"name":"member-studio","desc":"Example description."}]}
[/ROVAI_ADDITIONAL_SKILLS]
```

**前后完全相同。** public、非 batch 和旧冻结输入均保持原文。
JSON 仍为 `root` 与 `skills`，每项仍为 `name`、`desc`，
空集合仍显式输出；不增加 Steer 专用 Skill、标签或选择器。
新投递按既有配置及本次消息的 Skill 选择生成当前索引。来源缺失继续按现有规则省略和记录，
不编造描述。消息中的 `skills[].path` 与此索引各自沿用原职责。

## 6. 其余动态信息：字段不变，按本次投递取值

以下表格把每段的前后紧邻列出。变化在读取时点，不引入第二份结构或 Steer 特例。

| 区段 | 变更前 | 变更后 |
| --- | --- | --- |
| `COLLABORATION_STATE` | Run claim 时构建；按 Session／accepted marker 判断发送 | 每次新投递构建；使用同一发送规则 |
| `SELF_ACTIVE_TASKS` | Run claim 时读取当前队员的活跃任务，至多 8 项，再按预算减项 | 每次新投递读取当前队员的活跃任务；8 项与预算规则保持 |
| `RUN_FACTS` 的其他字段 | Run claim 时读取事实并冻结；真实会话恢复仍按既有规则添加事实 | 每次新投递读取动态事实并冻结；任务绑定仍来自目标 Run，不改变既有字段或重定向执行 |
| `WORKSPACE` | 使用 workspace owner 准备的真实执行目录和 Git 观察；按 accepted marker 判断发送 | 使用当前执行的真实目录和相同 owner 的有效观察，按同一规则发送；Steer 不切目录、分支或工作区归属 |

这些区段完整业务 shape 沿用现状：

```ts
type CollaborationState = {
  defaultLeadAgentId: string | null
  peers: Array<{ agentId: string; name: string; teamRole: string }>
  selfIsDefaultLead: boolean
}
type SelfActiveTasks = {
  tasks: Array<{ taskId: string; title: string; status: 'pending' | 'in_progress' | 'blocked' }>
  omittedCount?: number
}
type PublicRunFacts = {
  attachmentOutputRoot: string
  historyHint: string
  mission?: {
    missionId: string
    title: string
    status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
    updateNotice?: 'Mission details have changed. Read the latest mission name and description before handling RUN_INPUT.'
  }
  taskContext?: { taskId: string; referenceMode: string; laterChangesRetargetRun: boolean }
  sessionContinuity?: { state: string; requiredAction: string }
  externalEffect?: { state: string; requiredAction: string }
}
type Workspace = { workingDirectory: string; branch?: string | null }
```

`PublicRunFacts` 中后面三个可选事实的既有值域／触发条件不变，上述 `string` 是类型表达，
不是允许新增任意事实。没有对应事实时省略，不写空对象或 `null`。
Mission 详情变更继续使用上面那句完整 `updateNotice`，不新增 Steer 任务重定向说明。
协作名单只含当前有效的其他队员，没有默认 Lead 时为 `null`。
Tasks 没有任务时保留 `{"tasks":[]}`；有遗漏才有 `omittedCount`，全部因预算省略时按原规则省略区段。
WORKSPACE 没有 Mission 时省略；存在时保持 `workingDirectory` 及原有 branch 可选／null 语义。
Git 检查仍在 SQLite 事务外由既有 owner 完成，不能为了即时插话在事务里执行 Git。

## 7. Bootstrap 与运行身份

### 变更前

```text
SESSION_CHARTER
MEMBER_IDENTITY
ROVAI_PLATFORM_SKILLS
MEMORY_ENTRYPOINT?
```

普通 Run 保存启动内容；同一 Run 更换 Binding 仍使用该 Run 的启动快照。
是否实际发送 Bootstrap 由既有 Session、摘要、补发要求和 ACK 规则决定。

### 变更后

```text
SESSION_CHARTER
MEMBER_IDENTITY
ROVAI_PLATFORM_SKILLS
MEMORY_ENTRYPOINT?
```

文本、结构与触发规则不变。Steer 只刷新动态上下文，不把成员身份、Charter 或 Memory 入口
在同一执行中换成最新编辑版本；需要补发时仍走既有 Bootstrap 恢复流程。
这要求共用动态 Builder 消费已确定的启动内容，不能在每次动态构建中调用最新身份／Bootstrap 读取。
每次新投递的预算须覆盖实际可能出现的启动／补发字节，不因“这是插话”而漏算。
不添加“插话优先于原任务”“忽略前面要求”“停止当前工作”之类专用指导。
运行模型、权限、执行预算和工作区归属不因插话重置，实时 Memory 读取继续按既有权限检查。

## 8. 多队员与附件

### 变更前

一条公开消息按有效接收者形成普通 Delivery。各队员自己的上下文由各自的执行构建；
当前产品没有按接收队员选择 Steer 的投递路径。

### 变更后

仍只发布一条普通用户消息，按接收队员分别决定投递：

| 同一条消息的接收队员 | Runtime 动作 | 上下文内容 |
| --- | --- | --- |
| 活跃且支持本次输入的 Steer | 注入指定活跃执行 | 共同 Builder 生成该队员本次输入 |
| 忙碌但不支持本次 Steer | 普通排队 | 实际领取时走同一 Builder |
| 空闲 | 普通启动 | 同一 Builder |

各人的任务、历史边界和协作视角可能不同；共用 Builder 不等于给所有人复制同一个 payload。
同一消息的正文、作者、引用、附件及完整 `mentions` 沿用共同消息投影。
发布后，一位队员的投递失败或结果未知不撤销其他队员已成功的投递，也不把全体接收者重新发送一遍。
能力与预算针对目标执行已冻结的 Runtime／模型检查，不使用用户后来修改的队员设置替代。

附件继续以 `{name,mediaType,path}` 传递，并使用普通消息已有的路径可达性和授权规则。
不把“带附件”设为全局禁止 Steer 的条件，不剥离附件只注入正文；纯附件消息也可使用同一结构。
单个 Runtime 的真实能力不足时，由它的普通投递路径处理，不能伪称已注入。
路径 JSON 相同不等于实际文件已经可读：附件准备须解析本次来源，并检查目标活跃执行中的可达性。
文件缺失等本身无法正常发送的问题仍使用已有失败规则，不伪装成“仅不支持 Steer”而无限排队。
Agent 发出的消息即使 @ 多位队员，仍只走普通投递。

目标正常结束且能确认尚未提交原生输入时，复用该接收者原 Message Delivery 继续普通投递，
不再发布一条公屏消息，也不把后继 Run 当作原目标继续注入。沿用普通消息回执，不添加
“爱丽丝的当前执行已结束，发给该队员的消息已排队。”这类提示。
已发送而接受结果未知的输入不能按正常结束处理后自动再排队；这是防重复执行的证据边界。

## 9. 快照与存储：复用普通输入的证据

### 变更前

```text
CampMessage：唯一消息正文
Message Delivery：按接收者记录投递责任
AgentRunInput：Run 启动时冻结的有序来源消息
agent_run_claim_context：本 Run 的 claim 快照
ContextManifest / Dynamic Context Blob：本 Run 物化后的最终输入
Runtime Input Delivery：关联该输入与原生接受证据
```

`claim::persist/load` 按 Run 保存／恢复 claim 快照；`materialize_inner` 优先恢复该 Run 的
已有 Manifest。这个前提适用于当前初始输入，不能直接承担同一活跃 Run 的后续多次输入。

### 变更后

```text
CampMessage：仍是唯一消息正文
Message Delivery：仍按接收者记录投递责任
AgentRunInput：仍保留原 Run 启动输入
共用输入准备／ContextManifest / Dynamic Context Blob：按每次投递保存来源关联和冻结输入
Runtime Input Delivery：同一 Run 可关联多次输入，各自保留原生接受证据
```

优先扩展现有输入投递与 Manifest 的关联、唯一约束和查找方式，用现有投递身份区分多次输入。
初始输入与 Steer 均由共同准备流程保存实际恢复所需数据，不建立 `RunSupplement`，
不复制另一份消息正文，不添加一组 Steer 专属摘要、状态机或格式版本。
消息 Delivery 与一次 Runtime 输入可能是多对一，不能假设一个普通消息 ID 就等于一份批次 Manifest。

以下现有假设必须一起解除，不能只增加一条 Runtime 调用：

| 当前查找／结算 | 本次扩展要求 |
| --- | --- |
| `materialize_inner`、Skill 恢复按 Run 查已有 Manifest | 查本次输入的 Manifest；初始输入仍可定位自己的原版本 |
| `prepare_input_delivery_inner`／`load_delivery` 按 Run + epoch 找唯一输入 | 同一执行可有多个输入，复用既有输入 ID 关联准确的 Manifest |
| ACK 中工作区标记有按 Run 查询 Manifest 的路径 | 所有受理标记取本次输入关联的 Manifest，不能任取该 Run 的一行 |
| `settle_run_deliveries` 按 Run 批量结算 claimed 消息 | 纳入每次输入是否提交／接受的证据，尚未投递的插话不能随 Run 成功被结算为成功 |

同一队员复用 Runtime 的串行输入准备与提交，按既有 Message Delivery 顺序处理已选择的插话，
不为排序建立新的消息身份或模型可见序号。尚未确认的原生提交先对账，后续插话不越过它；
这不要求停止当前执行，也不阻塞其他队员。旧回执只补原输入的证据，不覆盖较新的协作／工作区／
Mission 标记；相同公屏尾序号也不能被当作“同一输入”。

“每次投递正常构建”指**新的一次逻辑投递**：准备时读取并冻结，正式组包消费同一快照。
恢复同次输入复用已准备字节，不读取后来消息、成员、Mission 或 Skill 配置重渲染。
恢复 payload 不等于再次提交：只有既有恢复规则能够证明未被接收时才允许安全传输重试，
accepted／unknown 不因恢复成功而重发。
最终物化前仍保留现有附件授权、Skill 可用性等必要检查；物化后保留最终原字节。
保留现有实际 Blob、版本、来源关联和恢复材料，遵守输入快照存储的减重约定。

若输入准备后、原生提交前目标结束，记录这次准备没有发送，再让原 Message Delivery 等待普通领取。
后续普通领取是一次新的输入准备，按当时状态构建；原准备记录不覆写，也不当作同一次传输重试。
已开始原生提交且结果未知时不能这样转换。Run 收尾与这次转换须互斥结算，不能丢消息或双重领取。
Run 的完成和用量仍只结算一次，不能因补充输入多次创建 Run 或重复结算。

## 10. 选择、容量与恢复

| 项目 | 变更前 | 变更后 |
| --- | --- | --- |
| 普通消息选择 | 当前队员 waiting Delivery 的 FIFO 最大完整前缀 | 不变；Steer 的目标消息由投递侧明确传入，不顺带带走其他排队消息 |
| 输入范围 | 本 Run 启动时选中的消息 | 本次投递选中的消息；共用投影，不增历史窗口 |
| 预算 | 默认 256 KiB，显式 `maxContextPayloadBytes` 可覆盖 | 不变；普通与 Steer 共用预算，Runtime 自身限额继续生效 |
| 计算 | 实际 UTF-8 字节，含可能发送的协作／WORKSPACE／Bootstrap wrapper | 不变，使用同一快照与最终 Formatter |
| 可选内容 | 先保完整输入，再减少可选 Tasks；上限 8 项 | 不变 |
| 超限 | 单条或不可拆原子输入超限明确失败；正文不截断 | 不变；不为 Steer 删除附件、引用或另做短摘要 |
| 已物化恢复 | 原 Manifest / payload 原字节 | 按对应输入恢复原字节；恢复本身不授权重发，也不覆盖启动输入 |
| accepted／unknown | 不自动重播 | 不变；不能同一输入既注入又排队执行 |
| 目标与 ACK | 与 Run、epoch、Binding 对应才可结算当前证据 | 扩展到同一 Run 的具体输入；旧输入的 ACK 不结算另一条输入、不复活旧执行 |

## 11. 版本、迁移与兼容

以下数字是针对本文基线的**拟用版本**，尚未写入合同或代码；实施前若主线已占用，须在确认稿中更新。
版本仅在内部证据中出现，不加入模型正文，也不建立 Steer 专属版本轴。

| 版本轴 | 变更前 | 变更后（拟） | 原因 |
| --- | --- | --- | --- |
| public ContextManifest／Formatter | 36／36 | 37／37 | 每次投递的输入证据及 historyHint 的 Run 时点限定修正 |
| public Context Delivery Profile | 13 | 14 | 同一预算策略扩为逐次投递准备；容量和 Tasks 上限不变 |
| public Run Facts schema | 9 | 10 | `historyHint` 文本与边界时点变化；业务字段不变 |
| 非 batch Manifest／Formatter／Profile／Run Facts | 35／35／12／6 | 不变 | 此次不改变私聊及历史非 batch 路径 |
| Bootstrap／Bootstrap Formatter | 5／5 | 不变 | 不改启动文本 |
| Charter／Redelivery／Binding compatibility | 当前既有版本 | 不变 | 不因 Steer 重建 Session 或换身份 |
| 数据库 schema | 148 | 需新迁移，编号实施前按主线分配 | 扩展已有输入关联与约束；不就地改写 Migration 198 |

涉及的现行权威为 [ContextManifest v36](../../contracts/context-manifest-evidence-v36.md)、
[Profile v13](../../contracts/context-delivery-profile-v13.md)、[Run Facts v8 的判断规则](../../contracts/run-facts-v8.md)
及其后续 Thread 文案／schema 9 覆盖、[Message Mentions v1](../../contracts/message-mentions-v1.md)、
[输入快照存储 v1](../../contracts/input-snapshot-storage-v1.md)与现有 Message Delivery、Runtime 输入接受合同。
本报告没有改写这些当前合同。

迁移保留旧 Run、消息、Delivery、Manifest、Blob、accepted／unknown 记录和原生 Session。
旧的已冻结输入沿原版本恢复，不把旧文案原地替换成新句子，也不为历史记录补造 Steer。
升级后新准备的输入采用新共同格式；不改写原 Run 的旧输入，也不把原有普通 waiting 消息自动改为插话。
活跃执行是否支持 Steer 由实际目标、绑定及 Runtime 能力判定，不因旧 Manifest 号一概禁用；
同样不能仅凭升级成功就声称已支持。新输入缺少必需快照时明确报存储错误，不以实时状态补出另一个 payload。
原生 Session 不因本次格式变化自动失效；只有既有运行恢复条件触发原恢复流程。
精确迁移 DDL 和编号在实现前落定，不用报告中的概念图冒充已完成的数据库设计。

## 明确不变

消息的作者与正文权威仍在 CampMessage；接收责任仍在 Delivery；读到某条消息不等于被分派任务。
`RUN_INPUT` 沿用普通消息字段，不额外保存或注入 Steer 指导。
Bootstrap 原文、模型与权限、原 Run 的启动输入、消息／附件／引用／Skill 投影、公共历史访问权限、
预算上限与完整消息优先级、accepted／unknown 防重原则均保持上述现行边界。
这份报告不新增 UI、提示条或执行结束通知；交互延续此前已修改的交互稿。

## 验证计划与本次实际验证

### 实施后的验证计划（本次未执行）

| 检查 | 固定输入／动作 | 必须得到的结果 |
| --- | --- | --- |
| 共用 Formatter | 同接收者、同消息集合、同冻结执行环境、同动态事实与发送条件，分别选择普通或 Steer | 动态 payload 字节一致；新 Session 的合法区段差异和原生包装另按原规则核对 |
| 不累计输入 | 初始 101、102；连续注入 103、104 | 三份 RUN_INPUT 分别为 `[101,102]`、`[103]`、`[104]` |
| 动态刷新与恢复 | 两次投递间修改 Task、Lead、Mission；物化后再修改 | 新投递反映当时状态；恢复旧投递字节不变 |
| 执行环境冻结 | Run 期间修改成员身份、模型、权限或 Bootstrap 来源 | Steer 仍使用目标执行原环境与启动内容；正常新 Run 按原规则使用新配置 |
| historyHint | 覆盖四模板；边界前／后、首轮、自己写的消息与额外消息 | 选择准确，句子逐字匹配，查询失败不领取 |
| 旧消息不丢 | 102 waiting，103 Steer accepted | 102 仍可被普通领取；接受边界不能代替 Delivery 状态 |
| 附件与引用 | 中文多行、纯附件、附件＋文字、用户／Agent 引文、Skill 链接 | 投影与普通消息相同；不丢附件、不提升引用权限 |
| 来源一致 | 初始输入带附件 A／Skill A，插话带附件 B／Skill B | 本次消息、附件解析与消息 Skill 链接均来自 B；通用 Skill 索引仍按普通规则；不扩张原工具与权限 |
| 多接收者 | 支持 Steer／不支持且忙／空闲各一位 | 一条公屏消息，三份接收责任，各自选正确投递路径 |
| 单个接收者失败 | 一人 accepted，一人 unknown，另一人仍排队 | 保留各自状态，不整条回滚或重发，不阻塞其他队员 |
| 作者限制 | Agent 发送同样内容 | 只普通投递，不 Steer |
| 容量 | 精确边界、超一个 UTF-8 字节、可选 Tasks、Bootstrap 补发 | 同一容量判断；不截正文或附件，不漏算补发 |
| 结束与重复 | 准备后提交前结束、Run 收尾竞态、发送后回执丢失、重复请求、停止后恢复 | 未提交输入不被 Run 成功吞掉；原 Delivery 只转普通领取一次；unknown 不再排队／重播 |
| 多输入 ACK | 同 Run 两次输入具有相同公屏尾，重复或迟到回执到达 | 回执只归对应输入；旧回执不覆盖新标记，Run 完成与用量不重复结算 |
| 数据升级 | 旧 36/13/9 冻结输入与新输入并存，重启恢复 | 旧字节不变，关联准确，缺失快照不能重建冒充 |

实现时扩展既有 Context、Delivery、Runtime 和 migration 测试 owner；新增 Rust 测试前遵循
[准入与退役规则](../../development/testing.md#rust-测试准入与退役门槛)。运行相应 owner、编译和文档门禁，
再使用隔离数据目录做真实 Runtime 前后对照。按用户范围不验证 Cursor、Cline、Command Code。
此前原生能力探针只能说明研究结果，不能代替新共同输入通道的真实验收。

上下文共享机制的真实语义 Gate 采用现有 DEMO-101–112 全部 12 Case、基线与候选各一轮，
同一固定队伍／模型／权限，`maxParallelCases=2`、总预算 14,400 秒、Judge 预算 2,400 秒，
每个 campaign 最多两次，保留失败记录。通过标准为既有 Gate 的硬性边界和关键协作项全部满足、
无未解释回归且证据充分；缺固定 Judge 或实际 Runtime 结果时记证据不足。
实际队伍、模型与 Judge 配置须在执行前写入冻结计划；不把未冻结的配置或未跑的 Case 记为通过。
操作流程与命令见 [上下文改动 Gate](../../development/evaluation.md#上下文改动-gate)。

### R3 确认前的方案验证（历史记录）

本次仅核对当前代码、合同与这份报告；尚未修改产品实现，也没有运行候选模型或宣称 Steer 验收通过。

| 检查 | 实际结果 |
| --- | --- |
| 示例与源码核对 | 两份 JSON 均可解析且内容相同；4 个旧 historyHint 模板与基线一致；R3 四种新提示均为单句且保留范围／额外消息判断；Additional Skills 前后逐字相同且与基线一致；代码围栏成对 |
| 提案与实现假设核对 | 对照当前 Bootstrap 准备、来源附件／Skill 选择、Manifest 查找、ACK 标记及 Run 结算路径，确认上述改动点仍需实现；未将文档修正算作功能通过 |
| 文档治理测试 | `node --test scripts/lib/doc-decisions.test.mjs`：10 passed、0 failed |
| 文档链接／决定治理及固定基线冻结 | `DOCS_BASE_REF=41c8ca19238de8465c23ff0c030f5c7620dd2c02 node scripts/check-doc-decisions.mjs --require-base`：通过 |
| 当前版本与上下文确认门禁 | `node scripts/check-doc-version.mjs`：未通过；仅 4 项 R3 确认记录缺失／待确认，无其他错误 |
| 差异空白检查 | `git diff --check`：通过 |
| 候选实现、真实 Runtime 与完整语义 Gate | 未运行；本次没有候选实现 |

以上 Node 命令是仓库 `docs:test`、`docs:check`、`docs:check:ci` 脚本的实际检查入口。
R1 首次 pnpm 调用触发本地依赖自动准备，主动中止后改用这些入口完整重跑；中止的尝试不计通过。
R3 继续使用这些入口核对修改后的报告。
以上是确认前的历史结果；User 后续确认及当前门禁结果见下文，没有修改检查器。

## 二次确认

User 在消息 `52de18ca-e5df-4c91-b2a7-ee998f8068b0` 明确要求“那你开始执行吧”，
并要求最终交付不同智能体的实际测试结果。本消息确认此前提交的 R3，实施沿用 revision 3。
消息 `ceb40a67-500b-4e82-b7bf-ba6b0dc49638` 提出了共用上下文方向，
消息 `dbdbfde2-2ac9-4826-ad07-91a94b5adcf0` 要求这份紧邻前后对照报告；
消息 `b1262396-a0a4-4b20-821f-5119035b6da9` 质疑第 4、5 节修改的必要性，R2 据此收缩。
消息 `232a40b6-c144-427a-bdcf-ffdb16cbdb8e` 要求提示词简洁有效并全面复查，R3 据此收缩文字、修正实施漏项。
上述讨论形成 R3；本次实施授权已在 Front Matter 记录。

仓库[核心上下文变更治理](../../development/model-context-change-governance.md#二次确认门槛)规定：
“未取得确认时可以继续调查和编辑提案文档，但不得修改实现、Schema、当前合同或执行 clean break。”
本次确认已满足该门槛。若模型可见文案或语义超出 R3，递增 revision 并重新依规则审阅。

## 代码定位

| 报告项目 | 当前基线中的定位 |
| --- | --- |
| 已有 Manifest 优先恢复 | `crates/rovai-core/src/context.rs`：`materialize_inner`、`load_existing_manifest` |
| Run claim 快照与预算 | `crates/rovai-core/src/context/claim.rs`：`ClaimedBatchContext::prepare`、`with_input`、`payload_len`、`persist`、`load` |
| 普通消息／附件／Skill 投影 | `crates/rovai-core/src/context.rs`：`model_batch_message`、`model_batch_input_message`、`project_batch_run_input_for_claim` |
| 引用及 mentions | `crates/rovai-core/src/message_quote.rs`：`MessageQuoteSnapshot::model_projection`；`camp_content.rs`：`message_mentions` |
| 四种 historyHint | `crates/rovai-core/src/context.rs`：`public_history_hint` |
| 额外可见消息的实际查询 | `crates/rovai-core/src/delivery_queue.rs`：`has_additional_public_messages` |
| 区段顺序与 Skill 时点句子 | `crates/rovai-core/src/context.rs`：`render_payload`、`prepare_additional_skills` |
| 动态协作、Task、Mission 与工作区 | `crates/rovai-core/src/context.rs`：`build_collaboration_state`、`self_active_task_projection`、`selected_mission_facts`、`prepare_workspace_fact` |
| 现有 Run 级来源附件准备 | `crates/rovai-core/src/application.rs`：`resolve_agent_run_source_attachment_paths`；`local_attachment_source.rs`：`load_agent_run_source_attachments` |
| 输入查找与 ACK 标记 | `crates/rovai-core/src/context.rs`：`prepare_input_delivery_inner`、`load_delivery`、`acknowledge_input_delivery_transaction` |
| Run 收尾批量结算 | `crates/rovai-core/src/delivery_queue.rs`：`settle_run_deliveries` |


## R3 实施记录（2026-10-14）

User seq18 授权后在 `rovai/mission/064` 实施。新 public Manifest／Formatter 37、Profile 14、
Run Facts 10，Migration 199 / schema 149；旧输入及非 batch 保持原版本恢复。

共用动态构建、普通来源消息投影与 Formatter；Steer 每次选择自身 Delivery，冻结后只恢复同一输入。
执行配置与 Bootstrap 沿用当前执行；本次动态名单、Tasks、Mission、Additional Skills 正常构建。
四种 historyHint 与 R3 确认稿一致，Additional Skills 原文保持，没有新加模型可见字段、Steer 指导或标签。

本次接入 Codex；多队员按各自能力及活跃状态投递，支持附件及纯附件。
未知结果不重发，核对仅接受原 turn 中的正向证据；正常结束安静回普通投递，取消／失败不另起执行。
细则由 [Send v27](../../contracts/camp-message-send-v27.md)、[Delivery v13](../../contracts/message-delivery-v13.md)、
[Manifest v37](../../contracts/context-manifest-evidence-v37.md) 和 [Profile v14](../../contracts/context-delivery-profile-v14.md)拥有。

逐 Runtime 真实结果、产品验收与失败记录见[实测报告](../../research/runtime-monitoring/steer-2026-10-14.md)，
机器可读证据见[验收索引](steer-verification.json)，复现命令见[实施计划](implementation-plan.md#用户-steer2026-10-14)。
完整 12 Case 语义 Gate 因缺固定 Judge 配置未执行，记证据不足；不把原生插话单例或确定性测试等同语义 Gate 通过。
