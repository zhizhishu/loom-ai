---
document_type: model-context-change
version: v1.59
change_id: mission
revision: 6
confirmation_status: confirmed
confirmed_by: local_user
confirmed_at: 2026-09-17T04:01:19Z
confirmed_revision: 6
authority: confirmed-model-input-change-statement
implementation_baseline: b2df4d85cdb8c6b8a9346290b16311b94fa4b7ed
implementation_status: in_progress
last_updated: 2026-09-17
---

# 使命：模型输入增量与实施边界（revision 6）

本说明把用户提供的《使命板方案说明 v2》《使命 Camp：Bootstrap、CLI Help 与 cli-operations》
以及后续持久 Worktree／累计 Diff 要求落实为字段级方案。桌面交互采用已确认 v7，补充整卡点击和
普通会话式顶栏对齐。本轮不向 Mobile UI 开放使命入口。

本 revision 纳入开发者 2026-09-15 的六项反馈（Camp 消息 `6c00a264-6883-4faf-87c0-0552bc7041b9`）：
Bootstrap 两条规则已明确通过；使命事实缩至三个字段；开始按钮使用结构化输入；Mission 更新采用后提交覆盖；
工作区只在 Run 获得执行机会、进入 preparing 后准备；工作环境独立投影且不逐轮重复。
开发者已审阅完整 revision 3，并通过下方确认记录授权实施。

后续消息 `8d93ff85-6de9-45f8-9c6c-8c5fc4b82831` 已明确 WORKSPACE **不新增 Agent 管控**，
且 Git Diff、branch 只对 Git 项目有效。非 Git 使用原目录，本期不建立内容基线或提供文件 Diff；
交付页保留队员发送的文件。以下是整合后已确认的完整说明。

revision 4 纳入开发者 2026-09-16 消息 `4e5e0e3a-f6c4-4177-9f5c-37363adab579`
及其两份完整附件：创建不再接收起始版本，首次 preparing 现场固定当前本地分支与 HEAD；Renderer
标题／描述编辑使用内部乐观版本；Agent 接口继续无版本。定义在某 Agent 会话首次进入后发生变化时，
下一轮 `RUN_FACTS.mission` 加入固定 `updateNotice`。revision 5 将其消除条件改为包含该版本的 Runtime Input
成功 accepted；`mission get` 保持纯读取。CURRENT_INPUT 不变。
该消息直接要求“修改三个功能”，构成 revision 4 的字段级确认与实施授权。

revision 5 纳入开发者随后对稳定数字号与更新提醒的明确修订：内部 UUID 不再用于 UI、分支或 worktree
命名；Mission 不保留历史标题／描述正文；`mission get` 不再确认已读。每次 ContextManifest 冻结当前
`details_version`，只有包含该版本的 Runtime Input 在当前 binding 上 `accepted` 才推进会话已投递水位。
该修订替代下文 revision 4 的读取水位、委托正文快照和完整 UUID 命名结论，其他输入 shape 不变。

revision 6 纳入开发者 2026-09-17 的状态语义修订：开始 Mission 只派发执行，不再自动切换为
`in_progress`；最新 Turn 是否提及 Principal 也不再推断 `needs_you`。Mission 状态只接受显式状态命令。

## 变更前

基线没有 Mission 领域、Mission CLI 或使命上下文。公开 Camp 的 Charter 由现有
`build_session_charter` 生成，Single Chat 使用原有独立 Charter；均没有 `Rovai Mission Contract`。
既有身份、引用授权、CLI、飞书附件与 Adapter 指引不改写。

Dynamic Context 按下列顺序输出，括号说明现有出现条件，不是模型正文：

```text
[COLLABORATION_STATE]（现有选择规则需要时）
[SELF_ACTIVE_TASKS]（公开 Camp）
[SHARED_CONVERSATION]（有已选历史时）
[RUN_FACTS]（有运行事实时）
[A2A_GUIDANCE]（适用的 A2A Run）
[SINGLE_CHAT_GUIDANCE]（适用的 Single Chat）
[CURRENT_INPUT]（必有）
```

当前版本轴：Bootstrap Contract v3、Bootstrap Formatter 3、Session Charter revision 6、
AgentRun Formatter 23、ContextManifest 23、Delivery Profile 5；Built-in Tool Contract／CLI Command 24、
Agent Output Contract 2、IPC 2、Envelope／Receipt 1。

现有 `RUN_FACTS` 外层完整字段与输出顺序如下。各 `*Fact` 子对象沿用
[Run Facts v2](../../contracts/run-facts-v2.md)、其 v1 可选字段及
[Single Chat v5](../../contracts/single-chat-v5.md)；本次不修改它们的内容：

```ts
type RunFactsBefore = {
  schemaVersion: 2
  campResources: CampResourcesFact
  conversationMode?: ConversationModeFact
  taskContext?: TaskContextFact
  sessionContinuity?: SessionContinuityFact
  externalEffect?: ExternalEffectFact
  gather?: GatherFact
  delegation?: DelegationFact
}
```

CLI 根帮助没有 `rovai mission get|update|status`。`cli-operations` 的 CampMessage 路由目前写“答复、状态、
问题或一次性协作消息”，没有 Mission 路由或 reference。

## 变更后：Bootstrap 完整增量

只在 Core 确认属于使命的公开 Camp 中，于当前 Charter 末尾追加两个换行和下面完整正文：

```text
Rovai Mission Contract

- All current members may use `rovai mission get|update|status` to maintain this Camp's Mission.
- Change status only when the whole Mission's state changes, not merely when your Run ends.
```

普通 Camp 与 Single Chat 的 Charter 正文逐字保持。使命标题、描述、队员、状态、版本均不进入固定块。
现有 Bootstrap 建立、证据保存及重送机制负责交付，不增加 Adapter 私有注入或仓库指令文件。

## 变更后：动态上下文完整 shape

### RUN_FACTS：使命身份与状态

取消独立 `[MISSION]` section。使命公开 Camp 的 `RUN_FACTS` 增加可选字段 `mission`，完整形状为：

```ts
type MissionFacts = {
  missionId: string
  title: string
  status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
  updateNotice?: 'Mission details have changed. Read the latest mission name and description before handling CURRENT_INPUT.'
}
// RUN_FACTS.mission?: MissionFacts

type RunFactsAfter = Omit<RunFactsBefore, 'schemaVersion' | 'campResources'> & {
  schemaVersion: 4
  attachmentOutputRoot: string
  mission?: MissionFacts
}
```

每次新输入准备时读取三个当前事实，并按下述投递水位选择可选固定提示。普通 Camp 和 Single Chat 省略 `mission`，不输出 null。
此对象没有 description、业务版本、sourceMessageId、标签或工作区；需要完整定义时用 `mission get`。
`attachmentOutputRoot` 采用已确认的附件原路径 revision 2：它只是 Agent 默认输出位置，不是权限或附件枚举根。
既有其他 RUN_FACTS 平台字段保持原职责，不向 Mission 对象增加 schemaVersion／version／expectedVersion。
输出保持既有字段顺序，使命字段位于最后。外层平台 schemaVersion 只标识通用 RUN_FACTS 合同，不参与使命编辑。
Mission 状态变化不是工作区准备的条件，也不是自动派发或停止信号。

`details_version` 是 Core 内部定义版本：创建为 1，每次标题／描述的有效原子修改递增一次，no-op 不递增；
状态、标签、成员、队长和工作区变化不递增。首次进入不发提示；包含当前版本的 Runtime Input 成功 accepted
后，Conversation 记录该已投递版本。之后当前版本高于已投递版本时加入上面逐字固定的 `updateNotice`；提示
跨 Run 保留，直到包含该版本的新输入 accepted。`mission get` 是纯读取，不推进水位。提示不含版本号、编辑者
或变更字段，且不改变 CURRENT_INPUT。新 conversation 独立执行首次进入流程。内部版本／投递水位不进入任何
Agent CLI 输入、输出或错误。

### WORKSPACE：已经解析出的运行环境

在 `RUN_FACTS` 之后、A2A 指引之前新增同级 `[WORKSPACE]`，本轮仅用于使命公开会话：

```ts
type WorkspaceFacts = {
  workingDirectory: string
  branch?: string | null
}
```

```text
[COLLABORATION_STATE]（现有条件）
[SELF_ACTIVE_TASKS]（现有条件）
[SHARED_CONVERSATION]（现有条件）
[RUN_FACTS]（原有事实，加可选 mission）
[WORKSPACE]（该原生会话首次收到，或实际环境发生变化时）
[A2A_GUIDANCE]（现有条件）
[SINGLE_CHAT_GUIDANCE]（现有条件）
[CURRENT_INPUT]（必有）
```

- `workingDirectory` 为该 Run 在 preparing 中解析、随后用于启动 Agent 进程的绝对 cwd。
  Git 使命映射到持久 worktree；项目是子目录时保留相同相对位置。非 Git 保留配置的原目录。
- Git 项目的 `branch` 为准备时实际工作树分支；Git detached HEAD 为 null。非 Git **完全省略 branch**。
  它是启动时快照，不宣称 Agent 后续 cd／checkout 后仍实时准确。现阶段没有通过 Mission UI 改工作目录或分支的流程。
- 不增加 repo root、源目录、仓库／Host／工作区 ID、base_sha、Git 状态、Diff、清理状态、readOnly、
  allowedPaths 或权限列表。内部关联、比较基准及清理信息归 Core，用户从交付页按需查看。
- WORKSPACE 既不授予权限，也不新增 Agent 行为管控；Core 继续按已有授权执行并保护工作区关联。
  不为了保住已投递的 branch 文案，强制 Agent 保持某个 shell 目录或 Git 分支。

Git 使命示例：

```json
{"workingDirectory":"/Projects/app-mission-042","branch":"rovai/mission/042"}
```

非 Git 使命示例：

```json
{"workingDirectory":"/Projects/writing"}
```

### 只注入一次的精确边界

“同一个 Agent”按 **Mission 内该队员当前的原生会话** 计算；标记附着于现有 Native Binding／generation，
不做全应用 Agent ID 的永久已读标记。实际输出字段组成的快照 digest 只保存在 Core。

| 情况 | WORKSPACE 行为 |
| --- | --- |
| 该队员首次使用当前原生会话 | 包含 |
| 相同队员、相同原生会话，实际输出字段均未变 | 完全省略 section |
| 切换到另一名队员 | 在其原生会话首次包含 |
| Core 重启后恢复同一原生会话，先前投递已 accepted | 保留已送达标记，不重复 |
| 新建／重建原生会话，或切换 Runtime 后建立新 Binding | 新会话首次包含；旧会话的已读标记不能证明新会话已收到 |
| preparing 或投递失败，没有 accepted ACK | 不记录已注入；恢复时交付冻结的原输入 |
| 同一原生会话确实解析出不同目录／分支 | 下一次新输入包含更新快照 |

以 accepted ACK 为送达依据，而不是“生成过 Prompt”或“尝试发送过”。迟到的旧 ACK 不得标记新的 Binding。
正常压缩／恢复沿用既有 Native Session 连续性和重送规则；不在每个 Run 的 Bootstrap 中重复塞工作区。

### CURRENT_INPUT：开始按钮与普通消息

只有可信用户点击“开始使命”才能生成以下新变体，采用现有 camelCase，去掉冗余的用户 ID 和嵌套 ref：

```json
{
  "kind": "mission_start",
  "source": { "type": "user" },
  "missionId": "mission_42"
}
```

这是完整 shape：不附加 message、标题、描述、version、mentionsCurrentUser、空附件数组或平台教程。
Core 校验 missionId 属于本轮真实 Camp；用户文本中写同样的 JSON、Agent 发消息或修改描述不能产生该变体。

- 接纳开始命令时，把 Mission 设为 `in_progress`，在同一命令事务内保存开始记录并创建／关联一次合法 Run。
  进入队列不创建工作区。重复 commandId 不新增 Run；已有正在推进的 Run 时，不再创建第二个开始委托。
- 该输入表示用户开始当前 Mission。Agent 使用 `mission get` 读取完整的**当前定义**再开展工作；不要求
  每轮 get，也不把描述自动塞回 RUN_FACTS。若队列等待期间有人更新定义，get 读最新内容，不制造版本冲突。
- 主 Camp 留一条用户操作产生的委托卡和 Mission 引用，不复制标题／描述。界面联查当前 Mission 定义；
  消息正文只表示“开始使命”，不通过 Camp 历史形成旧标题或旧描述。
- 对已准备的 Input Delivery，重试仍使用原始 mission_start 引用及投递 bytes；之后的 get 是独立的当前状态
  查询，不谎称其查询结果被冻结在点击时。委托卡随当前 Mission 定义投影更新，不保存旧正文。

**用户发消息，包括使命中的第一条消息，完全沿用普通 CURRENT_INPUT。** source、message、引用、附件、
Skill、接收者和 Pending 路径均保持，不加 mission_start kind，不拼使命描述，不多发一条启动消息。
普通消息触发 Run 时也会在 preparing 准备工作区，但不自动修改 Mission 业务状态；由 Agent 判断本轮是否
实质推进使命，再选择是否调用 mission status。A2A 的本轮输入同样沿用既有形状。

### 工作区创建时机与持久复用

```text
保存 Mission → 建立 Mission + 主 Camp
用户开始／消息触发 Run → 入队
调度获得执行机会 → Core 进入 preparing
  已有关联 → 验证并复用
  尚无关联 → 读取当前本地分支与 HEAD、准备工作区、保存实际关联
准备成功 → 冻结本 Run 的 cwd → 启动 Agent 并投递输入
```

preparing 是 Core 的执行准备阶段，独立于 Mission 四种业务状态；不能用设置 `in_progress` 代替调度。
保存、编辑、读取、状态更新、预检、等待依赖或排队均不创建 worktree／分支。

Git 首次准备读取 Mission 工作目录当时的本地分支与 `HEAD` commit：分支保存为可空 `base_branch`
（detached HEAD 为 null），commit 固定为 `base_sha`。创建命令／恢复草稿没有起始版本字段，保存 Mission
不读取 Git；工作树从该 commit 以禁用远端猜测的方式创建，不切换源仓库、不复制源目录未提交文件。
目录为原仓库同级的 `<repo>-mission-<number>`，分支为 `rovai/mission/<number>`。`number` 是删除后不复用
的全局单调 Mission 数字号，小于 1000 时至少补齐三位；不按标题／Agent／Run 重算。内部完整 Mission ID
继续作为关系主键，但不进入这些用户可见／Git 名称。
目录和分支作为同一候选组，任一占用则同时递增 `-2`、`-3` 后缀，保存最终路径和分支。
先复用确认过的关联；只对名称占用或创建竞争继续尝试，其他错误明确返回。
同一 Mission 的并发 preparing 通过 Core 的同一准备归属协调，只创建一次，不把同名目录当自己的工作区。

后续 Run、恢复、队员切换复用原关联，base_sha 不变。准备失败时 Agent 不启动，不回退到原 Git 项目写入；
取消／删除与准备过程需要协调，避免删除后迟到的准备结果重新启动执行。运行结束、完成、归档均保留工作区。
删除 Mission 时先停止占用再清理 worktree，分支保留；清理失败的独立记录支持重试。

非 Git 使用原目录，不创建分支、worktree 或内容基线，也不提供 Git Diff。交付页不显示分支与累计 Git 变更，
仍显示工作目录及队员发送的文件。非 Git Diff 查询明确返回不适用，不能伪装成“没有改动”。删除永不触碰原目录。
Git 不可用、已关联 worktree 丢失或基准不可读属于计算／准备失败，不能当作非 Git 降级继续执行。

### 选择、预算与证据

Delivery Profile 6 继承 Profile 5 全部数值：15 条 recent、24,000 历史 scalar、单条 2,000、
3 层 Reply、8 个 self-active Task。MissionFacts 的三个常驻字段、条件提示和本次需要发送的 WORKSPACE 属于不可拆分必要事实。
既有可选历史先让出 Runtime 预算，随后 self-active Task 让出；仍容不下时使用既有 payload overload。
不能偷偷截断字段、改发摘要或把准备失败当作空 WORKSPACE。

Direct materialization 和 A2A preflight 使用同一选择／预算函数。预检不准备工作区；首次调度准备完成后，
以真实解析结果做最终预算检查，再冻结与投递。排队时不能通过“预检”提前创建文件系统对象。

MissionFacts 归既有 `run_fact_payload_json`／digest 和 fact reference 证据，不再新增完整 mission_context 列。
新 Manifest 保存 `workspace_fact_json`、`workspace_fact_digest`、`workspace_fact_included`、本轮内部
`mission_details_version` 及来源关联：
未发生 workspace 投影的普通／私有会话为 NULL／NULL／false；Mission 保存准备时快照，included 决定是否
真的出现在 Prompt 中。同一会话后续省略时仍可证明使用了哪份环境和哪次先前 accepted Delivery。
这些内部列、源 Mission 的序号、binding generation 不进入模型 JSON。

mission_start 在现有 Current Input source evidence 中冻结用户开始命令、Mission／Camp 关联和完整投影摘要。
实际模型 bytes 参与 rendered payload digest。Bootstrap 继续使用现有 blob／digest 路径，旧证据不重写。

## CLI 完整新增接口

根帮助只新增 `  rovai mission get|update|status`。三个 operation 为 `mission.get`、`mission.update`、
`mission.status`，从可信当前公开 Camp 解析 Mission，不接收任意 Camp／Mission ID。
复用 flags、完整 JSON stdin/heredoc、`--input-file` 三选一和未知字段拒绝规则。

```text
rovai mission get
Read the current Camp's Mission.

Input: direct flags, JSON stdin/heredoc, or --input-file <path>. Choose exactly one input source.

Examples:
  rovai mission get
```

输入为 `{}`，成功输出完整形状：

```ts
type MissionInfo = {
  missionId: string
  title: string
  description: string
  status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
  sourceMessageId: string | null
}
```

只包含使命信息和当前问题／成果的消息引用。没有业务版本、工作目录、branch、base_sha 或 workspace 列表。
当前无 Mission、已离队、私聊／跨作用域访问明确失败；读取不会准备工作区或派发 Run。

```text
rovai mission update
Update the current Mission's title or description without starting work.

Input: direct flags, JSON stdin/heredoc, or --input-file <path>. Choose exactly one input source.

  --title                      field=title type=string
  --description                field=description type=string

Provide at least one content field; omitted fields remain unchanged.
Use mission status to change status.

Examples:
  rovai mission update --title "目录导航"
```

```ts
type MissionUpdateInput = { title?: string; description?: string }
type MissionMutationResult = { missionId: string; changed: boolean }
```

至少一个内容字段。只更新提交字段，**同字段按 Core 提交顺序后写覆盖**，不要求先 get、不要求 expectedVersion、
不把并发编辑报成业务版本冲突。不同字段的并发修改都保留，不能拿旧完整对象覆盖未提交字段。
标题非空、最多 200 Unicode scalar；描述完整保留、最多 12,000 scalar；超限拒绝并保留输入，不截断。
相同值为 no-op，changed=false，不新增活动、提醒或 Run。更新不改变业务状态。

```text
rovai mission status
Set the current Mission's status without starting or stopping work.

Input: direct flags, JSON stdin/heredoc, or --input-file <path>. Choose exactly one input source.

  --status                     field=status type=string required
      One of: needs_you, not_started, in_progress, completed.
  --source-message-id          field=sourceMessageId type=string
      Required for needs_you or completed; reference an existing public message in this Camp.

Examples:
  rovai mission status --status in_progress
```

```ts
type MissionStatusInput = {
  status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
  sourceMessageId?: string
}
```

状态与来源作为同一原子修改，后提交覆盖，成功返回同一 MissionMutationResult。Agent 设置 needs_you／completed
仍按原稿关联当前 Camp 真实已发布消息；用户手动标记记录真实用户来源，不伪造消息。
其他状态未提供来源时清空旧引用；同一状态与同一引用为 no-op。普通消息／Run 结束不会自动调用该操作。

数据库内部可以保留序号、事务互斥、commandId 幂等和活动历史；这些机制不要求 Agent 理解或提交版本。
**三个 CLI 的输入、成功输出、错误 details 和帮助均不泄漏 Mission version／expectedVersion。**
Agent 继续使用上述字段覆盖规则。UI 的正式编辑包含名称、可选描述、标签和使命源附件，并携带 Renderer
读取到的内部 `details_version`；项目、队员与队长只读锁定。Core 在同一事务比较并更新定义字段和附件集合。
过期版本拒绝后，弹窗重新读取最新可编辑字段并要求用户继续编辑。该内部冲突结果只属于用户 RPC，不进入 Agent CLI。
Agent 传入任何版本字段仍按未知字段拒绝。
结果不确定时仍按已有 confirm_outcome 检查当前事实；不能为恢复而重复发布已成功的公开消息。
不提供 Agent start、update --status、--no-start、位置状态参数或 description-file。

Renderer 只从使命卡片／列表的右键或 Shift+F10 菜单进入“编辑使命”；卡片普通点击仍打开会话。名称必填
1–200，描述可空且至多 12,000；标签和至多十个源附件可编辑，项目、成员与队长显示为锁定属性。
内容规范化后无变化时保存禁用，busy 时弹窗不关闭。成功后刷新使命板、当前 Mission 与主 Camp 标题。

## cli-operations 完整修改范围

主文 description 在现有多步协调触发中加入“需要协调使命内容、状态与公开消息”，其余触发保持。
“选择操作”的 CampMessage 行替换并紧接新增一行：

```markdown
- Camp 中可见的答复、进展说明、问题或一次性协作消息：选择 CampMessage。
- 当前 Camp 的使命定义或整体状态：选择 Mission。
```

“按需读取”增加一项：

```markdown
- 需要协调使命内容、状态与公开消息时，读取 [Mission](references/mission.md)。
```

新增 reference 的完整正文：

```markdown
# Mission：当前 Camp 的共同目标

Mission 保存共同目标，Task 保存可独立交接的责任；不要为使命自动创建同名 Task。
编辑描述只整理已明确的目标，不自行扩大授权或删减要求。

按整体使命选择状态：

- `not_started`：尚未开始，或退回等待安排。
- `in_progress`：正在推进目标，包括无需 Principal 介入的正常等待。
- `needs_you`：确有需要 Principal 回答、决定或处理的事项。
- `completed`：整体目标已经交付，不是自己的局部分工或本轮 Run 结束。

仅回答既有结果的解释性问题，不重开使命。

不要根据最新 Turn 是否提及 Principal 推断或改写 Mission 状态。公开消息和 `--to-principal` 都不会
自动改变状态；只有明确需要更新整体 Mission 状态时，才单独调用 `mission status`。

收到 `mission_start` 时，先用 mission get 读取当前完整定义，再开展工作；普通消息沿用本轮真实输入。
只提交要修改的字段；同字段后提交覆盖，无需读取或提交版本。结果不确定时，按 [Recovery](recovery.md) 处理。
```

不建立新 Skill，不要求每轮 mission get。只改 tracked `skills/cli-operations`，不编辑本地 projection。

## 明确不变的边界

- 使命描述、状态、标签、成员和队长修改均不启动／停止 Agent、不创建工作区，不制造用户授权。
  Run 结束不改变业务状态；completed 不暗中停止仍在执行的工作。
- 信任源仍是当前用户命令／消息和 Core 现行授权；旧引用、A2A、文件、描述修改不能冒充用户重新启动。
  正常用户委托中的 A2A 继续走原有链路和预算。
- 同一主 Camp 复用当前队员／队长、Composer、Draft、Pending、附件、未读、执行台及停止机制。
  Mission 不复制 Task，不从自然语言“完成”推断状态。
- Worktree 首次执行后持久复用；base_sha 永不随 commit／Run 更新。实际文件 Diff 使用执行节点 Git，
  临时 index 不改真实暂存区；非 Git 不建立基线或计算 Diff。Diff 不进入隐式模型输入。
- 删除 Mission 先停止使用工作区，持久化清理状态再执行删除；保留 Git 分支。清理失败可以独立重试。
  非 Git 没有使命 worktree 或内容基线可清理，永不删除源目录。
- 不增加自动推送、合并、发布、无限续跑或操作系统权限；手机端暂不提供本功能。

## 版本、迁移与恢复

| 版本轴 | 变更后 | 原因 |
| --- | --- | --- |
| Bootstrap Contract／Formatter | v3／3 | 包装和证据格式不变 |
| Session Charter revision | 7 | Mission 条件追加块纳入兼容摘要 |
| AgentRun Formatter／Manifest | 25／25 | 合并 attachmentOutputRoot、mission_start 变体、WORKSPACE 条件投递及其证据 |
| Delivery Profile | 6 | 简短使命事实和需要发送的 WORKSPACE 参与必要输入预算 |
| Built-in Tool Contract／CLI Command | 26／26 | 保留附件原路径行为并增加三个 Mission 操作、schema、help、作用域 |
| Agent Output／IPC／Envelope／Receipt | 3／2／1／1 | 采用已发布附件投影，既有包装与错误恢复机制不变 |
| Run Facts | 4 | 合并必需 attachmentOutputRoot 与使命公开会话可选 mission；平台封装版本不作为 Mission 业务版本 |

Migration 157/schema 107 先把主线 DSH 闭集扩展应用到两个已存在的 Migration 156/schema 106 形态；
Migration 158 再汇合已发布附件路径形态与已安装 Mission preview 形态，建立 Mission、内部活动序号、
开始记录和独立 workspace／清理记录；旧 Camp 不自动变成 Mission。Migration 159/schema 109 移除
Mission 的创建期 `source_branch`，增加内部 `details_version` 及 workspace 的可空 `base_branch`。
Migration 160/schema 110 增加稳定数字号，移除历史正文／读取水位，增加 Conversation 已投递版本与
Manifest 冻结版本；既有 Mission 157–159/schema 109 preview 在该步原位补齐 DSH 并收敛。这些字段不进入
MissionInfo 或模型输入；迁移不创建或重命名工作区。
Migration 161/schema 111 增加使命定义源附件数组，旧使命使用空数组；该步不改历史消息附件或冻结输入。
历史 Manifest 不改旧 bytes/digest。新生成只写 25／25／6，Run Facts 内部合同为 4；已冻结的受支持旧输入只凭
既有精确 Delivery 证明恢复原版本，不用新投影重算。已发布 v24／Profile 5、Mission preview v24／Profile 6、v23／Profile 5 及 v22／Profile 4 证据均保留。

Binding compatibility 使用现有版本摘要机制。Charter／Formatter 版本变化会使之后新输入重新建立兼容
Native Session 并重送 Bootstrap，包括普通 Camp；普通 Camp 的 Charter 正文和原有事实／历史选择语义保持，平台 RUN_FACTS 外层 schemaVersion 随通用合同升级；MissionFacts 本身无任何版本字段。
已接受输入不重发；在飞的旧输入按原证据收尾，不清空日常会话或历史。旧包不能作为新 schema 的写入客户端；
安装保留旧 App 备份及原数据库备份／迁移恢复路径，不能声称仅替换旧二进制即可安全降级新数据。

## 验证与预算

### 必须闭合的功能与负向场景

1. MissionFacts 为三个常驻字段加一个条件固定 `updateNotice`；首次进入无提示，定义更新后持续提示至含新版输入 accepted，
   且不泄漏版本／编辑者／字段；WORKSPACE 必有目录，Git 才有分支字段；普通消息 CURRENT_INPUT 字节保持，
   只有可信开始按钮生成 mission_start，伪造正文不能改变种类。开始设 in_progress，普通消息不自动设状态。
2. WORKSPACE 首次成功后省略、失败重试、同 Binding 重启恢复、新 Binding 首次补发、切换队员、迟到 ACK，
   直接 Run 与 A2A 预检一致；旧委托／Delivery 重放不变，后续 get 读取当前定义。
3. 三个 CLI 的 flags／JSON／input-file、未知字段、离队／跨 Camp／Single Chat 拒绝、同字段最后提交覆盖、
   不同字段并发保留、no-op、幂等重放；帮助／输入／结果／错误均无 Mission 版本和 workspace；
   needs_you／completed 无效来源拒绝，写状态前后派发数和工作区数不增加。
4. 保存／排队／预检均无工作区副作用；创建输入没有起始版本；获得执行机会进入 preparing 才读取当时
   本地分支／HEAD 并准备，不依赖 Mission 状态。detached HEAD、创建前切换分支、脏文件不复制均覆盖。
   取消排队、并发 preparing、重复开始、准备中删除、失败重启恢复，均不得泄漏孤儿工作区或重复启动。
5. Git 提交、暂存、未暂存、未跟踪、删除、重命名、二进制及实际支持的模式变化形成单一净 Diff；
   原 index 不变，回到基准即消失；路径／分支占用及创建竞争、子目录映射、持久复用、删除中断／重试。
6. 非 Git 使用原目录、WORKSPACE 省略 branch、没有 worktree／基线副作用、Diff 返回不适用；
   交付页隐藏 Git 功能并保留已发送文件，删除不触碰源目录。Git 故障不得误判非 Git；隔离 Core／Runtime 实测。
7. 两主题桌面、overview 顶部留白、整卡鼠标／键盘、共享编辑菜单、无变化禁用、过期版本回载、
   嵌套操作隔离、顶栏／折叠图标、抽屉与会话同源、交付／活动、筛选标签、焦点与失败草稿恢复；
   Mobile 入口不出现。验证通过后同步 main 再构建每日 App，安装不结束当前宿主。

Rust 新用例按现有[准入规则](../../development/testing.md#rust-测试准入与退役门槛)记录 owner、失败语义、
已有覆盖检索和最小命令。只对独立失败语义增加测试，不为样式逐行镜像测试。

### 真实上下文 Gate 冻结范围

共享 `cli-operations` 与上下文改动使用当前 Suite **2.12.0**、scoring **2.10.0** 的
**DEMO-101 至 DEMO-112**，每 Case 两版本各执行一次；Case／题目／标准不修改。
基线冻结为本说明 implementation_baseline，候选为完成实现的独立 build。
使用三个隔离测试身份的 Codex CLI，固定 `gpt-5.6-sol`、medium、danger-full-access／never；
只使用隔离测试数据／目录，不使用日常 App 数据。模型别名不冒充不可变权重快照。
诊断 Judge 复用已登录 CLI、同一模型及仓库既有工具禁用核验，输出明确不是 Formal qualification。

每 campaign 预算 **14,400 秒**，Case 并发 **2**，Judge 预算 **2,400 秒**；每 Case 时间上限采用 suite
现有 480／600 秒，最多 **2 次 campaign 尝试**。Case、环境、规则、模型和解码参数在看到候选分数前冻结。
同时满足通用硬验收、关键语义与证据完整性；同环境 dispatch-to-terminal 同时增长超过 50% 和 15 秒
按既有规则记资源退化，未知／未运行不算通过。失败保留全部证据；修实现偏差可在预算内重试，语义变化须升 revision。

## 二次确认记录

2026-09-15，开发者在阅读 revision 1 后，通过 Camp 消息 `6c00a264-6883-4faf-87c0-0552bc7041b9`
明确接受 Bootstrap 两条规则，并给出六项修订。后续消息 `8d93ff85-6de9-45f8-9c6c-8c5fc4b82831`
确认不新增管控，并限定 branch／Git Diff 仅用于 Git 项目。revision 1、2 已被替代，未作为已确认方案实施。
完整 revision 3 通过 Camp 消息 `5fa96b65-ca30-454b-af49-e458fd87f177` 附件交付，
并由 `25562a73-8f6b-4a1e-9252-b3dc285e478b` 明确请求按该 revision 实施。
开发者 local_user 在 2026-09-15T09:31:03.487288+00:00 的消息
`49707caa-9649-4534-9ae6-fa84ea16dbe0` 回复“开始”，确认按 revision 3 实施。
2026-09-16T07:09:29.755177+00:00，开发者 local_user 通过消息
`4e5e0e3a-f6c4-4177-9f5c-37363adab579` 提交《Mission 创建与 Git 基线调整》与
《Rovai Mission 编辑功能方案》全文，并明确请求修改；该消息确认 revision 4 的 Git 基线、UI 内部并发版本
和 `updateNotice` 语义。实施结果另记，不追改确认过的语义。
