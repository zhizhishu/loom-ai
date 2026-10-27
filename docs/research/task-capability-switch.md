---
document_type: implementation-proposal
authority: proposed-task-capability-design
status: confirmed
revision: 4
confirmation_status: confirmed
confirmed_revision: 4
confirmed_by: User
confirmed_at: 2026-10-17
confirmation_message_id: fd9bee73-2ea8-4798-9d3d-dbb9ca067963
implementation_status: in_progress
review_baseline: 81bb808c72721f67e2f07ead49fa4aca2ad64c02
last_updated: 2026-10-17
---

# 会话 Task 能力开关方案

推荐采用一个 Core 持久管理、默认关闭的实例级开关。Bootstrap 与平台 Skill 的通用教学统一去掉
Task 专用内容。Send 在所有状态下使用同一份不含 Task 关联的公开定义；开关只控制 Task 命令组、
新动态输入中的 Task 数据与客户端 Task 功能。设置随时保存，后续操作读取当前值，已有执行继续。
开启后提供 Task 创建、查询和更新；关闭后包括已有 Task 在内均不可新读取或更新，仅保留记录供重新开启后管理。
历史消息/审计、已提交回执与已冻结输入沿连续性规则保留，新消息不再建立 Task 关联。

本 R4 已获 User 实施授权；完整确认说明见 [当前版本变更说明](../versions/v1.72/model-context-change-task-capability.md)。当前版本从
[版本索引](../versions/README.md)解析。后续确认实施时，将本稿确认过的完整模型输入对照和兼容规则
纳入该版本独立的 `model-context-change-task-capability.md`，记录确认的 revision，再进行编码；
本稿不代替[模型上下文变更治理](../development/model-context-change-governance.md)。

## 上下文审阅方式

每个改动项均列出“变更前、变更后、说明”。“变更前”来自 `review_baseline` 的源码，
不是上一版提案；示例 ID 仅代替真实数据。写明“删除/不输出”表示对应字节不存在，不是向模型发送这几个字。
Bootstrap 用 B 编号，动态上下文用 D 编号，CLI 用 C 编号，Skill 用 S 编号。

R3 保留逐项对照，统一 Send/Skill 文案和定义，取消忙时切换限制及开关造成的执行阻断。
R4 的增量仅为明确既有任务同样停止新读写、将任务入口移至第 4 位，并在本次升级一次性统一四项数字快捷键；
B/D/C/S 编号的模型输入与提示词对照均沿用 R3。
提示词只保留会改变操作选择的规则；字段、权限与状态细节留在精确命令帮助，不重复放入通用上下文。
不新增“Task 已关闭”、开关原因或内部实现说明；同一项教学只维护一个文本来源。

R3 的明确取舍：退役新消息的 Task 关联，包括开启模式；旧 `taskId` 参数只兼容为普通消息发送。
任务记录仍可由 Task 操作维护，分工和唤醒统一通过消息完成。开关不取消已经授权的消息或执行。

## 方案选择

| 项目 | 当前建议 |
| --- | --- |
| 开关范围 | 一个 Core 数据实例；Desktop、Web、渠道和全部 Thread 共用 |
| 默认值 | `false`；新安装与升级后缺少配置都关闭，已有 Task 不自动开启功能 |
| Bootstrap | 所有开关状态使用同一份不含 Task 专用教学的公开 Charter |
| 原生 Session | 保留；不因开关或 Charter 改动强制重建 |
| 切换时机 | 随时保存，不等待 Run、队列或恢复记录清空；后续操作读取当前值 |
| Send / cli-operations | 两个状态共用一份定义和教学；Send 不再建立 Task 关联 |
| 数据 | 保留 Task、历史关联和审计；不批量完成、取消、释放或转换成 Mission |
| Agent 权限 | Agent 不能修改这个开关；有记忆或旧工具名也不能绕过 Core |
| 兼容范围 | 关闭新的 Task 发现、操作和输入选择；已冻结输入照常恢复，旧关联不阻断消息执行 |
| 实施规模 | 一个业务开关及其投影，不引入通用 Feature Flag 平台或每 Thread／每成员继承规则 |

维护范围收敛为：

| 内容 | 定义数量 | 开关只影响什么 |
| --- | --- | --- |
| Bootstrap、Memory 入口规则、平台 Skill | 一套 | 不读取 Task 开关 |
| Send help、Schema、错误表、旧参数兼容 | 一套 | 不读取 Task 开关 |
| 四个 Task 命令及其 help/Schema | 每个命令一份 | 整组是否提供；新的 Task 操作是否执行 |
| SELF_ACTIVE_TASKS 与 UI/读侧/通知 | 保留现有 shape/组件 | 是否选择 Task 数据、显示 Task 功能 |

Task 创建不启动队员；消息的 Task 关联本来就是可选的。现有消息 → Delivery → AgentRun → 公开回复
路径足以支持日常分工。Mission 继续表示整件工作的目标，Automation 继续表示定时执行，二者均不依赖
Task 开启。开启时 Task 只承担责任记录；消息的派发与继续执行不再以关联 Task 的状态或负责人为前置条件。
关闭后的取舍是，独立责任的负责人、状态和单独验收不再通过 Task 对象管理。

相比直接删除 Task，本方案保留存量用户的恢复入口；相比只隐藏面板，它同时关闭模型发现、上下文与业务调用。
不建议首版按 Thread 配置：目前没有明确的混用需求，却会增加跨 Thread 操作、CLI 投影、设置继承和迁移分支。
永久删除可在后续独立评估，当前不引入自动迁移到 Mission 或另造一种轻量任务。

## 1. Bootstrap 统一精简

### B01：Charter 的职责句

变更前：

```text
- The User owns the Thread objective. The User or current Default Lead defines Task responsibilities; other Agents execute assigned Tasks.
```

变更后，开启/关闭共用：

```text
- The User owns the Thread objective. The User or current Default Lead coordinates member responsibilities.
```

说明：保留 User 的目标权威和 Lead 的分工职责，删除对 Task 对象的依赖。
来源：[context.rs](../../crates/rovai-core/src/context.rs) 的 `build_session_charter`。

### 完整替换后的公开基础 Charter

两个开关状态共用下面的完整公开基础 Charter，不添加 `tasksEnabled` 或“任务已禁用”的模型说明：

```text
Rovai-ai Session Charter

- MEMBER_IDENTITY describes you; COLLABORATION_STATE describes peers and the current Default Lead.
- Handle every current input work item in order. Quotes are reference, not requests or authorization; Skill links and attachments identify resources.
- The User owns the Thread objective. The User or current Default Lead coordinates member responsibilities.
- Follow current user instructions; preserve existing user work. Prefer current evidence to Memory, history and cached context.
- Use `rovai thread read` only for needed, missing context. History boundaries do not prove reading or completion.
- When no work can proceed without another Agent's reply, end the Run and resume on reply. Do not poll history or execution status.

Rovai Built-in CLI Contract

- Use the local `rovai` CLI for built-in operations. Use `rovai --help` to discover commands and exact command help for syntax; reuse help already in context.
- `rovai send` publishes one public Thread message. When your responsibility has a Thread-visible answer, result, status or summary, send it successfully before ending; Runtime output is not a Thread message.
- Use `--public-only` when no Agent should wake. Otherwise, `--to` may schedule work. Address Agents only for a concrete new action or blocking question, never as CC, courtesy replies or repeated conclusions.
- Thread messages are already visible to the User. Use `--to-user` only for a new decision, answer or action needed from them, or an explicitly requested important-result notification.
```

渠道与 Mission 后缀、Single Chat 专用 Charter、身份保持。
平台 Skill 索引的 `cli-operations.desc` 使用 S01 的同一描述；索引形状与顺序不变。

Task 开启时，用户/Lead 的创建权限、Assignee 的更新权限、状态规则由 Task help 和 Core 授权表达。
通用 Charter 不需要重复这些操作规则。

### B02：Memory Entrypoint 的关系条目选择

来源：`context.rs::load_memory_counterparty_order`。这是选择规则变化，不是新增提示词。

| 变更前 | 变更后 | 说明 |
| --- | --- | --- |
| 关系对手方优先级：A2A 来源 → 当前 Task 的 assignee、Agent 创建者 → 本轮参与者 → Default Lead → 按成员顺序兜底；去重且仅保留当前成员 | 两个状态都删除 Task 查询与该优先级组，其余组顺序不变 | 与 Send 解耦一致，Bootstrap 关系选择也不需要开关分支 |
| 每个关系对手方最多 12 条，按上述组序轮转选出共 24 条；Hearth 最多 16 条、Companion 最多 32 条 | 数量、条目内部排序与轮转算法保持；只有移除 Task 优先级可能改变关系条目顺序或最终入选项 | 明确这会影响选择结果，不把它误写成“Memory 内容完全不变” |

Memory 条目的内容、访问授权、表格 shape、末尾发现提示和空索引提示不变，不删除用户 Memory。
新 Run 采用上述规则，同一 Run 的已冻结索引保持原样。

### Session 连续性

这次改动不破坏会话连续性。原生 Session 是模型保留的会话历史；Run 是收到新输入后的一轮执行，
同一个 Session 可以经历很多个 Run。

| 场景 | 行为 |
| --- | --- |
| 老 Session 收到新消息，启动下一 Run | 继续原 Session、保留历史，同时用当前 Bootstrap 模板装配这一 Run |
| 创建全新的 Session | 使用当前 Bootstrap 模板 |
| 同一 Run 恢复或重试已冻结输入 | 使用该 Run 保存的原字节，不追改已经准备的材料 |
| 执行中切换 Task | 当前执行继续；后续 Task 调用按当前值处理，新生成的动态输入按当前值选择 |

例如：`Session A / Run 1 → 关闭 Task → Session A / Run 2`。Session 仍是 A，Run 2 读取当前模板；
不是只有换一个新 Session 才能使用新版 Bootstrap。开关两态本来就共用同一份 Charter 文本。

实现上沿用 `prepare_session_bootstrap_evidence_for_snapshot` 的每 Run 冻结和现有投递判断：
装配当前模板不代表无条件重复发送；是否补发仍由 Adapter、digest 与 accepted 记录决定。
开关不进入 Binding compatibility digest，不触发 Session rotation；旧历史允许保留旧说明。
参见 [Session 不变量](../architecture/foundational-invariants.md#context-session-bootstrap)。

## 2. 唯一配置与即时切换

建议新增窄接口，名称在确认后作为实施合同冻结：

```text
preferences.tasks.get
  request: {}
  response: { enabled: boolean }

preferences.tasks.set
  request: { enabled: boolean }
  response: { enabled: boolean }
```

这两个接口属于已认证 User 的 Host/Desktop 设置操作，不注册到 Agent 内置工具目录。
配置使用 Core 数据库的一条 singleton 记录，缺行按关闭解析；不保存在 Electron
`general-preferences.json`、浏览器 localStorage、Agent Profile 或每个 Thread 中。
设置保存与业务准入共用数据库串行事务，因此不存在各客户端各存一份的授权状态。

设置保存按以下顺序执行：

1. 校验 User 调用和布尔输入；相同值是幂等读取，不产生变化事件。
2. 直接提交新值，不查询“是否空闲”，不取消 Run，不清空或重排消息队列。
3. 发布设置/读侧失效信号，刷新客户端与存活进程的 CLI 能力投影，不轮换 lease 或原生 Session。
4. 后续 Task 操作在自己的事务中读取当前设置；新生成的上下文在 preparation 事务中读取一次并冻结。

没有 `task.setting_busy`、待生效状态、排空 worker 或“开启前先处理恢复阻断”的前置条件。
Task 命令事务与设置事务按 Core 原有顺序串行：已经按旧值提交的命令保留真实结果，
排在设置提交之后的新命令使用新值，不追溯撤销前一条命令。

| 对象 | 何时应用设置 | 不做什么 |
| --- | --- | --- |
| Task CRUD / 旧客户端调用 | 每次新操作执行时读取当前值 | 不把 Run 启动时的布尔值当作整轮授权 |
| 普通新 Run / 新 Steer 输入 | 各自 preparation 时读取并冻结选择 | 不重复渲染或改写已冻结输入 |
| UI、CLI 命令发现 | 保存后刷新；新 lease 绑定时再次同步 | 不因投影刷新失败回滚设置或终止执行 |
| Send、已发布消息、正在运行的 Run | 正常继续，与 Task 设置无关 | 不因为 Task 关闭取消或失败 |

CLI 投影采用现有原子文件写入，刷新失败只记录诊断，后续绑定时再同步；短时旧展示不影响 Core
按当前值执行。配置项缺失使用 `false`；该可选配置自身损坏时使用关闭状态并报告诊断、保留原记录，
不阻止普通会话。设置持久化失败才向用户报告保存失败，不伪称成功；数据库与授权的真实故障仍走原流程。

## 3. 动态上下文按能力选择

现有路径至少包括：

- [context/input.rs](../../crates/rovai-core/src/context/input.rs)：
  `DynamicInputContext::prepare`，普通 public 输入与 Steer 共用；
- [context/claim.rs](../../crates/rovai-core/src/context/claim.rs)：
  claim 冻结、FIFO 预算与 `payload_len`；
- [context.rs](../../crates/rovai-core/src/context.rs)：
  非 batch 物化、旧 A2A preflight、Run Facts 与最终 formatter。

在共同选择入口读取 Core 状态，在现有 claim/frozen-context DTO 中携带本次的内部布尔选择结果；
渲染、容量检查与物化使用同一个结果，不分别重新取设置。旧 DTO 的缺失字段仅在历史解码分支解释，
不能让新请求用字段缺省恢复为开启。这个值只解释该份输入，不是整个 Run 的授权快照；
同一 Run 后来的 Steer 输入仍重新读取当前设置。不新增模型可见 capability section。

### D01：公开输入的 SELF_ACTIVE_TASKS

变更前，有活跃任务且能放入预算时：

```text
[SELF_ACTIVE_TASKS]
{"tasks":[{"taskId":"task_example","title":"验证改动","status":"in_progress"}]}
[/SELF_ACTIVE_TASKS]
```

变更后：关闭时整个区段不输出；开启时保留上述 shape 和选择规则。
说明：直接消除新输入中的 Task 责任，不添加替代提示词。

同一改动的边界逐项如下：

| 情形 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| 有候选且预算足够 | 当前 Thread、本 Agent 的 `pending/in_progress/blocked` Task，按 `updated_at DESC, id DESC`，最多 8 项 | 开启保持；关闭不查询、不输出 | 条目只含 `taskId/title/status`，不开启详情自动注入 |
| 无活跃任务 | `[SELF_ACTIVE_TASKS]` 内为 `{"tasks":[]}` | 开启保持；关闭连空 section 一并删除 | “没有任务”与“不提供任务能力”不是同一状态 |
| 还有未入选任务 | 部分入选时附 `omittedCount`，值为未入选数量；数量为 0 时省略该字段 | 开启保持；关闭连 section 一并删除 | 不留下 Task 遗漏提示 |
| 预算淘汰所有候选 | 整个 section 省略 | 开启保持；关闭不进入 Task 选择与淘汰 | 保持开启模式的原有省略含义 |

### D02：Single Chat 的空 Task 区段

变更前，共用物化路径把单聊的 `(空任务, 0 遗漏)` 渲染为：

```text
[SELF_ACTIVE_TASKS]
{"tasks":[]}
[/SELF_ACTIVE_TASKS]
```

变更后：无论全局开关如何，整个区段不输出。
说明：单聊本来没有 Task 操作，去掉无用区段，不改变权限。

### D03：Run Facts 的 taskContext

变更前，旧 A2A 路径有 Task 关联时，在 `RUN_FACTS` 中包含下面的完整字段；其他字段不在此示例展开：

```json
{
  "taskContext": {
    "taskId": "task_example",
    "referenceMode": "frozen",
    "laterChangesRetargetRun": false
  }
}
```

变更后：新生成的 Run Facts 在两个开关状态中都删除 `taskContext`，不输出 `null`。
说明：消息不再绑定 Task，旧关联只保留为历史事实，不阻止派发与继续执行。
开启时已有任务仍通过 D01 的责任列表提供；历史已冻结 Run Facts 保留原字节。

### D04：Single Chat 的 taskMutationAllowed

变更前，`RUN_FACTS.singleChat` 完整对象为：

```json
{
  "kind": "single_chat",
  "visibility": "principal_only",
  "responseDelivery": "single_chat_message",
  "operationPolicy": "single_chat_v1",
  "threadPublicationAllowed": false,
  "memberDispatchAllowed": false,
  "taskMutationAllowed": false,
  "memoryMutationAllowed": false
}
```

变更后，无论全局开关如何，该对象为：

```json
{
  "kind": "single_chat",
  "visibility": "principal_only",
  "responseDelivery": "single_chat_message",
  "operationPolicy": "single_chat_v1",
  "threadPublicationAllowed": false,
  "memberDispatchAllowed": false,
  "memoryMutationAllowed": false
}
```

说明：仅删除 Task 专用禁用字段。其余字段和单聊 operation policy 保持，不新增单聊能力。

### D05：选择、预算和已冻结输入

| 项目 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| 新公开输入的 Task 选择 | 每次 prepare 选择 Task，claim/FIFO 预算与渲染使用该结果 | 关闭时选择结果明确为“不提供”；开启保持原结果；普通启动与 Steer 共用 | 防止 claim 算了一种输入、实际发送另一种 |
| 容量计算 | Task bytes 参与完整 payload 预算，可能被逐项淘汰 | 关闭时 Task bytes 为零；仍按真实完整 payload 决定 FIFO 能装下多少消息 | 容量上限和完整用户消息规则不变，实际可领取数量可能变化 |
| 新 Run 的材料 | 新 Run 读取当前模板和当时事实 | 新 Run 读取统一模板和当时能力选择 | 不复制旧 Run 的 Task 区段 |
| 同一 Run 的既有冻结载荷 | 恢复使用保存的原字节，accepted/unknown 不自动重发 | 继续使用原字节，即使含旧 Task 信息；accepted/unknown 沿原结算规则 | 不因切换新增失败或恢复阻断，也不把开关当作重放许可 |

来源：`DynamicInputContext::prepare`、`ClaimedBatchContext::payload_len`、
`self_active_task_projection`、`build_run_facts` 与最终 formatter。
上面的“关闭、不提供”等词仅解释实现行为，不进入模型输入。

必须区分三种内部状态：能力关闭、开启但没有候选、开启但预算淘汰。建议用
`Option<SelfActiveTaskProjection>` 配合明确的选择原因表达；不能只清空 `Vec`，因为当前
`self_active_task_projection([], 0)` 会重新生成空 section。
也不要把 `maxSelfActiveTasks` 改成 0：当前 Profile 要求它为 8，功能状态不是容量上限。

保留最终动态输入 Managed Blob 与必要来源；不恢复已经退役的 Task evidence JSON、
独立 digest、Profile JSON 或另一套输入副本。历史已物化载荷不重算，详见第 8 节。

`COLLABORATION_STATE`、`WORKSPACE`、`RUN_INPUT`、额外 Skill 索引以及 Run Facts 中未列出的字段，
内容、顺序和选择规则不变；`ROVAI_PLATFORM_SKILLS` 的描述改动单列于 S01。

## 4. CLI help 与执行入口

### 当前问题及推荐控制位置

[bin/rovai.rs](../../crates/rovai-core/src/bin/rovai.rs) 目前先处理根 help、Task family help、
operation help，再调用 `load_context()`。仅在 Router 拒绝操作不会改变这些帮助。
[工具目录](../../crates/rovai-core/src/builtin_tool_transport.rs) 的 `OnceLock` 缓存也是全量静态目录。

`BuiltinToolCliContext` 的控制字段对照如下，它不属于发送给模型的 section：

| 变更前 | 变更后 | 说明 |
| --- | --- | --- |
| 无 Task 能力字段，help 使用全量目录 | 增加 Core 生成的 `tasksEnabled: boolean`；缺失或不可信时按 `false` 展示 | 只控制 Task 命令组是否提供，不修改 Send 或其他命令的定义 |

这只是本进程的命令发现投影，不是授权凭证。Core 在绑定 Run lease 与设置变化时由实例状态和运行模式计算它：
public Run 且功能开启才是 `true`；Single Chat、未绑定、无法确认状态都是 `false`。
不把它作为单独环境变量，不让 CLI 读取日常数据库或自行扫描配置目录。

流程调整为：

```text
读取 CLI 上下文中的能力投影（不要求执行认证，也不为 help 发 IPC）
    → 仅筛选 Task 命令组是否可用
    → 从同一份静态定义生成 help / Schema / 参数解析
    → 真正执行时才校验 active lease 并发送 IPC
    → Core 使用当前状态重新准入
```

没有上下文、旧上下文缺字段、格式损坏或版本不支持时，帮助只显示不依赖 Task 的公共目录；
真实执行仍保留原有上下文/版本错误。脱离受管 Runtime 的终端默认不展示 Task，
不会为了 help 唤醒或连接一个猜测的 Core 实例。

实现上只保留一个静态 catalog 和一个 Task 命令组可用性判断。根 help、family、精确 help、
`builtin_tool_list/description` 与命令查找共用该判断；各命令的文案、字段和错误定义不按开关改写。
`OnceLock` 只缓存静态定义，不缓存开关。此处唯一差异是“Task 这一组是否存在”，不维护两套配置。

只统一文案仍会留下 Send 的 `taskId` Schema 分支，因此 R3 选择同时退役新消息的 Task 关联。
代价是开启模式也不再提供这项关联；Task CRUD、面板和数据保留，普通消息继续负责派发工作。

### C01：根 help 的 Task 行

| 变更前 | 变更后 | 说明 |
| --- | --- | --- |
| `rovai task create\|get\|list\|update` 始终出现在 Agent operations | 关闭时删除这一行；开启时原位置保留 | 关闭时不提供 Task 发现入口，不添加禁用说明 |

关闭后的完整根 help：

```text
Rovai CLI

Agent operations:
  rovai send
  rovai member list|get|create|update
  rovai thread list|search|read|runs
  rovai history search
  rovai memory view|search|read|write
  rovai automation list|get|create|run|close|update|delete
  rovai mission list|get|update|status

Run an Agent operation's exact `--help` for its closed inputs.
```

普通非受管终端继续按现有规则追加 User Automation 段。
开启时只在原位置加入 `rovai task create|get|list|update`；其余命令不受影响。

### C02：四个 Task operation 的发现与精确 help

来源：`builtin_tool_transport.rs`、`team_tool_catalog.rs` 与 `team_tool.rs`。下表逐个列出入口；
四个 operation 各只有一份定义，关闭模式只从可用集合移除，不改写定义内容。

| 入口 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| `team.create_task` / `rovai task create --help` | 全量目录可发现，可读创建 help | 关闭时省略；开启使用唯一静态定义 | 创建描述的统一微调见下表 |
| `team.get_task` / `rovai task get --help` | 全量目录可发现，可读详情 help | 关闭时省略；开启使用唯一静态定义 | 参数与成功结果保持 |
| `team.list_tasks` / `rovai task list --help` | 全量目录可发现，可读列表 help | 关闭时省略；开启使用唯一静态定义 | 参数与成功结果保持 |
| `team.update_task` / `rovai task update --help` | 全量目录可发现，可读更新 help | 关闭时省略；开启使用唯一静态定义 | 参数与成功结果保持 |

关闭时直接请求这些 help 返回 C10 的同一份短错误，不输出开启方法。

由于 Send 退役 Task 关联，create 的描述末行统一调整；输入字段、权限和成功结果不变：

| 变更前 | 变更后 | 说明 |
| --- | --- | --- |
| `Does not notify or start work; use rovai send --task-id.` | `Does not notify or start work; use rovai send --to <assignee>.` | 用普通消息派发工作，不再教已经退役的关联参数 |

这句同时存在于 catalog 和 `create_task_input_schema` 的描述中；实施时二者复用同一文本来源，
一起替换，避免公开 Schema 仍保留旧教学。

### C03：Send 的 taskId / --task-id

变更前，Send Schema 的 `properties.taskId` 完整内容为：

```json
{
  "type": "string",
  "minLength": 1,
  "description": "Optional current Task link; exactly one effective recipient is required."
}
```

CLI 参数表提供 `--task-id`，当前没有为它追加专用参数说明。

变更后：两个状态都从公开 Schema 删除整个 `properties.taskId`，从 help 删除 `--task-id` 参数行，
不增加替代字段或参数教学。Send 的定义不再读取 Task 开关。
说明：发送消息与管理任务分开；创建任务后用普通 `--to` 消息要求队员执行。
来源：`team_tool.rs::camp_message_send_input_schema` 与 `bin/rovai.rs` 参数渲染。

Send CLI 保持现有的 direct flags 或 `--input-file` 正文文件加发送 flags，不新增 JSON stdin
或完整 JSON 文件入口。兼容旧调用的规则也只有一套，与开关无关：

| 旧输入 | 兼容处理 | 说明 |
| --- | --- | --- |
| CLI 中合法的 `--task-id <value>` | 在公开参数校验前消费并忽略该关联参数 | 旧模型指令不应阻止消息发送；不在新 help 列出 |
| Agent IPC 的 `taskId`、User Send 的 `execution.taskId`，包括 `null` | 在新业务校验前按已知退役字段处理，不建立新 Task 关联 | 不查询 Task 是否存在、完成或换人，不因该元数据报错 |
| 原有已提交消息/命令回执中的 Task 关联 | 保留原记录与准确回执 | 不改写过去已经发生的事实 |

只兼容上述已知字段，不放宽其他字段、正文/附件验证或授权。有效收件人仍完全按消息的当前寻址规则确定，
不从旧 Task ID 推断或补充收件人；正文、附件、`--to`、`--public-only` 与用户注意力保持。
幂等仍核对原请求身份与内容，兼容转换不允许同一请求重复发布。

### C04–C06：Send 的通用教学

来源：[camp_message_send_teaching.rs](../../crates/rovai-core/src/camp_message_send_teaching.rs)。
开启/关闭共用以下变更；help 仅替换表中列出的段落，其余段落保持。

| 项目 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| C04 · User attention help 末段 | `It creates no Agent Delivery, does not represent approval, and may be combined with --public-only. User attention is message-local and is never inherited by replies, Tasks, or downstream A2A work.` | `It creates no Agent Delivery, does not represent approval, and may be combined with --public-only. User attention is message-local and is never inherited.` | 删除继承对象的枚举，保留注意力仅属于本消息的规则 |
| C05 · public-only help 末段 | `Do not combine this option with --to or --task-id. It may be combined with --to-user.` | `Do not combine this option with --to. It may be combined with --to-user.` | Send 不再创建 Task 关联，无需这条互斥教学 |
| C06 · public-only Schema 完整 description | `Guarantee that this public Thread message addresses no Agent. When true, explicit Agent recipients and taskId are invalid, effectiveRecipients and deliveryIds are empty, and no Agent is woken. This may be combined with mentionUser because User attention is not Agent routing.` | `Guarantee that this public Thread message addresses no Agent. When true, explicit Agent recipients are invalid, effectiveRecipients and deliveryIds are empty, and no Agent is woken. This may be combined with mentionUser because User attention is not Agent routing.` | Schema 中同样删除 Task 专用枚举，保持回执与 User attention 语义 |

新业务不再建立 Task 关联；旧关联参数按 C03 兼容，不再导致 public-only 冲突。
正文、附件、文件输入选择、发送结果和用户注意力规则保持。

### C07：Send 描述中的 Task 错误目录

| 变更前 | 变更后 | 说明 |
| --- | --- | --- |
| `builtin_tool_description` 的 `errors` 包含 `message.task_recipient_ambiguous` 与 `message.invalid_task`，两者 recovery 均为 `fix_input` | 两个状态都从当前 Send 描述中删除这两项，新的 Send 不再产生它们 | 发送消息不受 Task 关联约束；历史错误仍按原记录读取 |

旧 Send 关联参数按 C03 正常兼容。直接调用关闭的 Task CRUD 才得到 C10 的局部不可用结果。

### C08：Automation 描述中的术语

| 变更前 | 变更后 | 说明 |
| --- | --- | --- |
| `automation.list` 描述尾句：`This read does not run or modify a task.` | `This read does not run or modify an Automation.` | 明确描述的是 Automation，其功能和其他文案不变 |

### C09：Task family help

变更前，完整 `rovai task --help` 为：

```text
rovai task

  create  Create a durable task.
  get     Read task details.
  list    List task summaries.
  update  Update an existing task.

Use rovai task <command> --help for arguments.
```

变更后，关闭时不输出此帮助；开启时完整文本为：

```text
rovai task

Use Tasks for responsibility that spans Runs and needs independent handoff or acceptance.
Use messages for one-time coordination. Update Task state before a required handoff, request or result.

  create  Create a durable task.
  get     Read task details.
  list    List task summaries.
  update  Update an existing task.

Use rovai task <command> --help for arguments.
```

说明：只增加“何时用 Task”和“交接前维护状态”两行。复用已有 Task、权限、字段与“不自动唤醒”
由 create/update/list 精确帮助拥有；Send 不再承担 Task 关联约束。
S12 列出原 reference 每条规则的去向，避免缩短文案时丢失必要行为。

### C10：直接请求禁用能力时的错误文本

这个结果只回应实际请求，不主动注入上下文。

| 位置 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| 新 CLI 的 Task family/operation help 或执行入口 | help 返回当前帮助；执行请求按原规则解析 | 关闭时退出码为 2，返回下方同一不可用结果 | 只结束这次 Task 操作，不结束 Run |
| Core 收到新的 Task CRUD | 按原领域规则执行，合法请求返回业务结果 | 关闭时返回同一不可用结果，不产生新的 Task 副作用 | Agent 可以继续使用消息、文件和其他操作 |

CLI 与 Core 共用的 Agent 可见结果：

```json
{"error":{"code":"task.feature_disabled","message":"Tasks are disabled. Continue with messages.","recovery":"stop"}}
```

`stop` 沿用已有 Recovery 合同，只停止本次 operation；不得因此标记 Run failed、取消 Delivery
或要求重新开启设置。Task 定义的错误表固定增加这一项，不按开关产生两份表；Send 不增加它。
已提交请求的准确回执仍可重放，旧 Send 关联字段正常兼容。其他错误和成功输出保持原合同。

## 5. 平台 Skill 使用一套通用文本

### S01：cli-operations 的 description 与 Bootstrap 索引

变更前，`skills/cli-operations/SKILL.md` 的完整 description 为：

```text
Choose among Rovai messages, Tasks, Missions, history and Memory; coordinate parallel member requests, multi-step operations or recovery. For one known operation, use its command help directly.
```

变更后，开启/关闭共用：

```text
Choose among Rovai messages, Missions, history and Memory; coordinate parallel member requests, multi-step operations or recovery. For one known operation, use its command help directly.
```

说明：只删去 `Tasks, `。Bootstrap 的
`ROVAI_PLATFORM_SKILLS.skills[name="cli-operations"].desc` 从同一 front matter 读取这段新文字，
`root/name/skills` 结构及其他 Skill 描述保持，不增加能力状态字段或另一份描述。

### S02–S11：通用 Skill 的逐项删改

下面均是开启/关闭共用的完整句子或完整段落替换；未列出的内容保持。
路径以 `skills/` 为根，未写 Skill 名前缀的 reference 属于 `cli-operations/`。

| 项目与位置 | 变更前 | 变更后 | 说明 |
| --- | --- | --- | --- |
| S02 · `cli-operations/SKILL.md` 选择表 | `Responsibility that survives Runs and can be handed off and accepted independently` → `Task` | 删除这一行 | 通用选择表不再引导创建 Task |
| S03 · 同文件选择表后 | `Choose the smallest object that fully serves the request. Tasks own durable responsibilities; project sources and history own their facts.` | `Choose the smallest object that fully serves the request. Project sources and history own their facts.` | 删除 Task 定位，保留最小对象与事实来源规则 |
| S04 · 同文件 References | `[Task](references/task.md): durable responsibility and Task-linked messages.` | 删除这一项 | 通用索引不再提供 Task 教程入口；旧路径按 S12 兼容 |
| S05 · `references/send.md` attention 段首句 | `Attention belongs to this message; replies, Tasks and downstream work do not inherit it.` | `Attention belongs to this message and is not inherited.` | 用一句通则替代对象枚举 |
| S06 · 同文件一次性协作段 | `A one-time answer, update, question or request uses a message. Use a [Task](task.md) only for durable, independently transferable responsibility. A Task-linked Send requires exactly one effective Agent recipient; User attention does not count.` | 删除整个段落 | 消息用法已在本页开头；Task 选择见 C09，Send 不再建立关联 |
| S07 · `references/mission.md` 定位句 | `A Mission owns the shared objective; a Task owns independently transferable responsibility. Do not automatically create a duplicate Task. Edit only the established objective and requirements.` | `A Mission owns the shared objective. Edit only the established objective and requirements.` | 仅保留 Mission 职责，不教学另一种对象 |
| S08 · `references/memory.md` 权威句 | `Tasks, temporary plans, project facts and historical evidence belong to their existing authoritative sources.` | `Temporary plans, project facts and historical evidence belong to their existing authoritative sources.` | 保留临时计划与项目事实不应进入 Memory 的边界 |
| S09 · `cli-operations/agents/openai.yaml` 的 `short_description` | `在 Send、Task、检索与 Memory 之间选择并安全协调` | `消息、Mission、检索与 Memory 操作` | 同步资源元数据，用短语表达用途 |
| S10 · `memory-stewardship/references/authority-and-safety.md` 适用条件 | `belong in Memory rather than Tasks, history, project documents, code, tests, approval or audit records;` | `belong in Memory rather than history, project documents, code, tests, approval or audit records;` | 只删除 Task；下文已有临时进度排除规则，不另造替代对象名 |
| S11 · `memory-stewardship/references/content-and-keys.md` 示例 | `Agreement: Include the goal, verified state, evidence, open issues and next action in durable Task handoffs.` | `Agreement: Include the goal, verified state, evidence, open issues and next action in handoffs.` | 保留交接内容要求，不绑定 Task 对象 |

### S12：旧 Task reference 的兼容页及规则去向

变更前，`skills/cli-operations/references/task.md` 完整正文为：

```markdown
# Task

Create a Task only for responsibility that needs tracking across Runs and independent handoff or acceptance. Use ThreadMessage for brief coordination, answers, progress and questions.

Choose an operation with `rovai task --help`, then read its exact help. Reuse an existing Task where possible; put scope and requirements together in `description`.

Decide from current Task state; read it when the needed information is missing or stale. Submit only the fields you intend to change.

Tasks preserve responsibility; messages communicate it. Bring the Task to the appropriate state before publishing a required handoff, request or result. A Task-linked Send requires exactly one effective Agent recipient; User attention does not affect that count.
```

变更后：保留原路径，两个状态共用下面的完整短文本：

```markdown
# CLI operations

Use `rovai --help` for available operations and exact command help for syntax.
```

说明：不再发布 Task 教程；老会话读旧路径仍能得到有效导航，不产生文件缺失错误。
新 Skill 的 References 不列出此兼容页，不把它作为常规教学重复注入。

| 原规则 | 变更后的唯一主要入口 | 简短说明 |
| --- | --- | --- |
| Task 与一次性消息如何选择；交接/请求/结果前维护状态 | C09 的两行 family help | 保留使用决策与交接纪律 |
| 先发现命令、再读精确 help | `cli-operations/SKILL.md` 首段，保持原文 | 已有通用规则，无需再迁入一遍 |
| 复用已有 Task；范围和要求放入 `description` | 已有 create help 与 create/update 参数帮助，保持原文 | 与操作参数放在一起 |
| 需要时读取当前状态；只提交要修改的字段 | Skill 的 `Read the authoritative state needed for the decision.` 与已有 get/update help，保持原文 | 不强制每次重复读取 |
| Task 关联 Send 只有一位 Agent 接收者 | 随新的 Task 关联一起退役，C03 兼容旧参数 | 普通 Send 仍按显式收件人和现有寻址规则执行 |
| User attention 不计入 Agent 接收者 | Send 的既有 attention/public-only 规则 | 与 Task 无关，保留已有教学 |

### 受管文件同步

[managed_skills.rs](../../crates/rovai-core/src/managed_skills.rs) 的 `sync_directory` 现有复制/覆盖行为
足以发布这份兼容页；不新增删文件、旧内容 hash 识别或开关专用清理流程。打包资源与 `include_str!`
引用继续指向同一路径，发布新版时正文一起更新。切换 Task 不触发 Skill 同步；发布资源的故障仍使用
现有诊断与修复路径，不新增 Task 开关的执行门禁。
不扩展对第三方 Skill、用户 Memory、成员身份或 Runtime 原生技能库的写入范围。
自然语言中的普通 `task`（当前工作）不做机械字符串清除。

## 6. Core 按当前值处理，失败只影响对应操作

UI 和 CLI 的过滤只负责发现与呈现。只有新的 Task CRUD 需要读取当前开关；消息与执行主流程不依赖它：

| 入口 | 处理方式 | 可用性边界 |
| --- | --- | --- |
| `team.create_task/get_task/list_tasks/update_task` | 新调用按当前设置决定是否执行；关闭时返回 C10，不读写 Task 业务内容 | 不将 Run 标成失败，不取消关联消息 |
| `tasks.create/update/list/get` | 同样读取当前值；关闭时界面收起旧面板 | 不用空任务列表冒充读取成功，不影响 Thread 主界面 |
| Agent Send 的 `taskId`、User Send 的 `execution.taskId` | 两个状态都按 C03 兼容为普通消息发送 | 不因 Task 关闭、完成或负责人变化阻止发送 |
| waiting 消息、旧 Run 的“继续执行” | Task 关联仅作历史数据，不再决定是否能派发或继续 | 保留消息未撤回、成员有效、User 授权、Mission 和实际 Runtime 恢复检查 |
| 已按旧值执行完成的 Task 命令 | 返回真实结果；准确重试复用已提交回执 | 不因随后关闭改判失败，也不重复副作用 |
| 成员离队、永久删除 Thread | 继续维护保留数据的外键、assignment 和清理不变量 | 开关不关闭数据生命周期管理 |

Task CRUD 的最终 guard 放到 [collaboration.rs](../../crates/rovai-core/src/collaboration.rs) 中的
业务入口，和设置保存使用同一事务顺序。已认证请求先按原身份与 digest 核对准确回执；有已提交结果就返回
原结果，没有才按当前设置执行新操作。开关不是撤销历史授权或已提交结果的按钮。

[message_delivery.rs](../../crates/rovai-core/src/message_delivery.rs) 与 User publication 共用
Task 关联兼容规则，不再从旧参数产生新的 Task 关联或触发 Task 校验。
[run_continuation.rs](../../crates/rovai-core/src/run_continuation.rs) 的 `eligible_source` 当前还检查
原消息所关联 Task 的状态和 assignee；R3 在两个状态中统一去掉这一前置条件。
其余来源、内容摘要、成员、撤回与恢复条件保留，不扩大收件人或修改用户消息。

不禁用整个 CollaborationService、Scheduler 或 AgentRun。它们继续承担普通消息和执行职责。

## 7. UI、读侧与通知

四页界面、设置位置和可见文案逐项对照见 [会话任务开关界面设计稿](task-capability-ui.md)。
设计稿仍属提案，不代表以下 UI 或 Core 规则已实施。

设置入口位于通用设置的会话区域，使用现有开关样式：

```text
会话任务
在所有会话中提供任务面板和队员任务工具；关闭不删除已有任务记录。
```

执行中也可保存；仅本次保存请求尚未完成时防止重复提交，成功后立即应用，不显示“执行结束后可切换”。
确有保存失败时在设置行说明，不影响正在进行的会话。
Desktop 与 Web 使用 Host 设置，远程连接切换时重新读取对应实例，不继承另一实例或浏览器缓存值。

读侧应在同一读事务中投影 `tasksEnabled`。关闭时，常规界面投影不执行 Task 内容/计数查询，
`ThreadSnapshot.tasks`、`ThreadOpenProjection.tasks`、`coverage.tasks` 和列表 `openTaskCount`
省略；客户端通过能力字段区分“不提供”与“开启但为空”。开启后保持原完整度语义。
不要返回假的零计数来表示未提供，也不要在前端拿到全部任务后再 CSS 隐藏。

[read_model.rs](../../crates/rovai-core/src/read_model.rs) 的 `load_events` 还会通过 Task 表归属
历史事件，并把 Task 事件送进 presentation 流。关闭模式的普通 Thread 打开/增量读取应直接排除
Task presentation 事件与对应关联查询，分页和覆盖范围一起调整；数据库事件和显式历史审计读取仍保留。
Run/Delivery 的旧关联可作为历史证据保留，不再据此查询实时 Task 详情或生成可操作入口。

| UI 入口 | 关闭时处理 |
| --- | --- |
| 标题栏/手机菜单 | 四项统一为执行、队员、单聊、任务；关闭时移除末项。手机更多菜单同步为队员、单聊、任务，关闭移除任务 |
| 任务面板/详情/Dialog | 不挂载；已打开时收起并移回有效焦点，未保存草稿不自动提交 |
| 时间线 | 不构建实时 Task 卡；普通历史消息、执行过程和工具审计保留 |
| 快捷键 | 本次升级统一重置执行/队员/单聊/任务为 Mod+1/2/3/4；关闭时隐藏并停用任务行和所有输入路径。升级后开关不再重置绑定。迁移与正常改绑规则见[快捷键设计](task-capability-ui.md#6-快捷键页与全部输入路径) |
| 旧路由/通知焦点 | 回到 Thread 的有效阅读位置，不重新打开任务区 |
| 起步建议 | “整理成任务”改为“梳理步骤”；仅填入普通消息，不创建替代对象 |
| 成员移出/删除预览 | 关闭模式不展示可操作的任务入口；内部仍执行已定义的数据收口 |

Task 通知从当前列表、计数、heads-up 和可操作路由中一起过滤，过滤必须在分页/统计边界一致执行；
保留通知记录、已读位置和用户的任务通知偏好。重新开启可以恢复历史 Inbox 项，
但不能把设置切换当成新状态事件批量弹出历史通知。任务提醒设置行关闭时隐藏。

当前生产入口为“设置 → 提醒”，没有 Notification Center 抽屉、全局铃铛或 Inbox 未读总数。
上述 Inbox 规则是历史读侧兼容要求，不要求本次增加任何通知中心界面。

事件订阅、客户端缓存与多窗口需要一起失效。离线旧客户端暂时显示旧入口不能构成权限；
重新连接先读取当前能力，再接受缓存页面。关闭中的请求结果到达时，不得重新填回已隐藏任务缓存。

主要落点是 [ThreadWorkspace.tsx](../../apps/desktop/src/renderer/src/ThreadWorkspace.tsx)、
[共享快捷键](../../apps/desktop/src/shared/shortcuts.ts)、
[通知设置](../../apps/desktop/src/renderer/src/NotificationSettings.tsx)与 Core 通知投影，
不能只改 Desktop 的一个按钮。

## 8. 存量、冻结输入与升级

“关闭”作用于后续新操作与新输入选择，不是撤销已经准备或投递的工作。
用户正文、引用、旧消息、已冻结输入和历史工具结果保持原样，不按字符串 `task` 过滤。

| 存量状态 | 处理规则 |
| --- | --- |
| 既有 Task 行、Task/消息关联、审计 | 保留；重新开启可继续管理；关闭不批量完成、取消或转换 Task |
| 老 Native Session | 正常 resume；其中的新 Run 同样使用当前模板，不要求新 Session |
| 设置切换时仍有执行/待投递 | 立即保存，原执行与消息继续；不创建开关专用的暂停/失败状态 |
| 尚未冻结输入的 waiting 消息 | 正常 claim，以当前设置构建新输入；正文、附件和收件人保持 |
| 旧 Task-linked waiting 消息 | 保留历史关联，按已有消息收件人与当前授权正常派发；关联 Task 不再成为执行前提 |
| 已冻结、尚未发送且仍具备原恢复资格的输入 | 按原字节继续，包括其中可能存在的旧 Task 内容；不重新 claim，不另发一次业务输入 |
| accepted/unknown 输入 | 沿原有结算与隔离规则处理，不重发、不裁剪、不把状态改成未接受 |
| User 继续一个旧 Run，包括 Task-linked Run | 沿现有继续入口创建新 Run，按当前设置选择输入；不因旧 Task 关联拒绝，不复制旧 Blob 作为新输入 |
| 切换前已提交、响应尚未到达的 Task 命令 | 正常返回已提交结果；重试命中准确回执，不改判失败、不重复执行 |
| 切换后旧模型调用 Task CRUD | 本次 Task 操作返回 C10；模型仍可完成普通消息协作与其他工作 |
| 切换后旧模型使用 Send 的 Task 参数或读取旧 Task reference | 分别按 C03、S12 兼容，不因这两处旧用法失败 |

升级后缺配置仍默认关闭，但不把旧队列和恢复记录标成失败。这里有一个明确的保留范围：
已经冻结的旧输入可能继续包含 Task 信息；之后新生成的输入才保证不再选择 Task。
这是保持输入证据和执行连续性的规则，不是让旧布尔值继续授权新的 Task 操作。

关闭期间 Run 完成不自动改写 Task 状态；重新开启恢复已有记录，成员离队等生命周期维护仍正常执行。
开关不改变既有防重、取消、消息撤回和实际 Runtime 恢复约束，也不新增恢复协调器或数据清理步骤。

Desktop 快捷键本次统一升级 `schemaVersion: 1 → 2`：四项旧键盘绑定直接覆盖，其他动作占用 Mod+1–4 时让出；
其余非冲突绑定、侧键与发送方式保留。迁移成功后只读 v2，不因启动、Host 或 Task 开关变化重置。
这是本机偏好的最小一次性迁移，不改变 Core 的 Task 保留/恢复数据规则。详见界面稿的“一次性统一更新”。

## 9. 合同与版本轴

基线的 public Formatter/Manifest 为 39、Profile 为 14、Run Facts 为 10；
non-batch 为 37/12/6；Bootstrap 为 5、Charter revision 为 23；
Built-in transport/command 为 41、Agent output 为 14、IPC 为 3。

| 轴 | 本方案处理 |
| --- | --- |
| Charter revision | 推进一个新 revision，所有状态共用文本 |
| Bootstrap wrapper/formatter | 形状不变，保持；平台索引描述与精确 bytes 按新文本冻结 |
| Native Binding compatibility | 保持，开关不进入兼容摘要，不强制换 Session |
| Public 与 non-batch Formatter/Manifest | 各推进新版本，记录 Task section 的能力条件；旧载荷仍用原版本解释 |
| Profile | 新版本记录 selector 规则改变；开启时上限仍为 8，不用 0 冒充关闭 |
| Run Facts | 对新输入统一删除 `taskContext` 与单聊 Task 专用字段推进相应版本 |
| Built-in transport/command | 推进新版本，覆盖 Task 命令组可用性、单一 Send Schema、旧关联兼容与局部错误 |
| Agent output/IPC | Task 成功结果形状和 IPC framing 保持；是否需推进以最终字段差异核对，不能把新 Schema 冒称旧合同 |
| Read-side/Host | 为能力字段和可选 Task 投影推进对应当前 Schema/协议 |
| Send / Continuation | 明确新关联退役、旧参数兼容、旧 Task 关联不再约束消息派发与 User 继续执行 |
| 数据库 | 仅增加配置及必要接口支持；不重建 Task 表，不改写旧快照与事件 |

具体新整数在正式说明中按合入基线分配，不预占并行工作的版本号。
当前权威同步范围包括 Durable Task、Built-in Transport、Context/Profile/Run Facts、Send、
AgentRun Continuation、Camp Open、Notification、Single Chat、Host Web、UI 与相应架构。
本稿阶段仅链接这些影响，不把当前合同提前改成已接受行为。

## 10. 实施顺序与验证

1. 确认本 R4 的语义与逐项文案，在当时 current 版本保存独立模型变更说明及确认记录。
2. 实现 Core 配置、即时切换与每次 Task 操作的当前值判断；保证切换不停止已有工作。
3. 统一 Send 定义与旧参数兼容；Task CLI 只筛选命令组，刷新活跃进程的发现投影。
4. 统一 Bootstrap/Skill 教学与旧 reference 兼容页，接入新输入选择；旧输入沿原恢复路径继续。
5. 收敛读侧、任务卡/入口、通知、快捷键与客户端失效刷新。
6. 验证保留的 Task 功能、消息解耦、执行中切换和升级恢复，再运行真实上下文 Gate。

已有相关测试位于 `context.rs` 的 self-active selection/empty/budget 场景、
`team_tool.rs` 的 Task 权限/幂等/不唤醒场景，以及 `delivery_queue.rs` 的 continuation Task links 场景。
实现时优先扩展现有行为测试，Rust 测试增删遵循
[准入与退役门槛](../development/testing.md#rust-测试准入与退役门槛)。

| 验收组 | 必须证明 |
| --- | --- |
| 默认与保存 | 新库、旧库无配置均关闭；running/waiting/恢复过程中都可切换；两个客户端一致；同值保存幂等 |
| 单一定义 | on/off 的 Send help/Schema/错误表与 cli-operations 字节相同；Task 定义只有一份，整组可见性变化 |
| 旧调用兼容 | CLI `--task-id`、IPC `taskId`、User `execution.taskId` 均正常发送一次，不新建关联、不改变收件人；旧 reference 可读 |
| Task 操作 | 新调用读取当前值；关闭时无 Task 读写副作用，只有局部不可用结果，Run 与普通 Send 继续 |
| 并发与回执 | 设置和 Task 命令前后交错的结果与事务顺序一致；已提交回执准确重放，没有重复 Task 或消息 |
| 上下文 | on/off × 有/无任务 × 首轮/热续接/冷续接/Steer/补发/单聊；关闭后的新输入无 Task section，已冻结输入原字节保持 |
| 预算 | FIFO claim 与实际渲染共用选择结果，开关不改变完整用户输入和超限失败规则 |
| 存量 | Task 数据保留；旧 waiting/可恢复输入继续；旧关联不阻止 User 继续；accepted/unknown 不重放 |
| 可选投影故障 | CLI 文件刷新失败不终止 Run；新 Task 操作仍服从当前状态；开关不触发 Skill 同步或文件清理 |
| UI/通知 | Desktop/Web/手机均无任务入口；旧焦点、快捷键、迟到请求不会恢复面板；计数与分页一致 |
| 数据生命周期 | 关闭时成员离队/永久移除/Thread 删除仍正确收口；重新开启没有悬空负责人 |
| 无关主路径 | 普通消息协作、Mission、Automation、审批、停止、附件和 Runtime-native plan/todo 保持 |

上下文与共享 `cli-operations` 改动适用
[12 Case 通用 Gate](../development/evaluation.md#上下文改动-gate)，在实施前冻结基线、候选、
Case、Judge、预算和判定标准。Task 关闭时的缺失能力按该模式解释，不能把“没有创建 Task”
自动算成协作失败；保留对实际分工、交接、结果和副作用的判断。
模型/Runtime/预算配置须在正式执行计划中明确，本提案不把尚未运行的评测写成通过。

本 R4 文档完成只代表方案可审阅；产品实现、真实 Runtime Gate、升级与 UI 验收均在确认后的实施阶段。
