---
document_type: model-context-change
version: v1.72
change_id: member-routing
revision: 4
confirmation_status: confirmed
confirmed_revision: 4
confirmed_by: User
confirmed_at: 2026-10-13
confirmation_message_id: 23b13d59-00b5-4c6c-a6f9-992b59fd32d6
authority: proposed-model-input-change-statement
implementation_status: implemented
review_baseline: 39bf1eb09a208ea9abd98b737d6ed7c669ed7cbf
last_updated: 2026-10-13
---

# 成员路由信息精简与专业职责扩容：R4 逐项前后对照

本方案把团队角色用于快速识别分工，把专业职责用于详细描述。自动协作名单与 `member list`
只提供路由信息；需要详细身份时读取相关队员的 `member get`。本人身份继续完整投递。

User 已于 2026-10-13 确认实施本 R4；以下前后对照作为实施基准，实际进度与验证记录另行追加。
用户已确定提高完整上下文上限，并要求此次变化不影响任何现有 resume：新会话按新逻辑初始化，
老会话保留原生历史正常续聊，不迁移、不重建、不要求用户处理。

本工作对应 [Issue #706](https://github.com/murray17/rovai-ai/issues/706) 第 2 项中的身份字段容量问题；
Pi 提问交互、对话分类和 Skills 安装不在本方案范围。R4 撤回 member-studio 的用户原文处理和
专业职责写法两处改动，保留原文；补充协作摘要切换、成员 version 存储语义与各 Runtime 容量边界，
并补列上一版遗漏的 Cline Bootstrap 32 KiB 限制。
每个修改点仍把**变更前、变更后、改动说明放在一起**；代码和文案逐项紧邻展示，规则和数值采用同行对照。
保留事项注明原因，不把现有行为写成本次新增改动。

基线为上方不可变 SHA；当前版本由[版本索引](../README.md)解析。
现行权威包括 [Collaboration State v3](../../contracts/collaboration-state-v3.md)、
[Built-in Transport v38](../../contracts/builtin-tool-transport-v38.md)及其继承的
[成员操作合同](../../contracts/builtin-tool-transport-v36.md)、
[ContextManifest v33](../../contracts/context-manifest-evidence-v33.md)、
[Context Delivery Profile v10](../../contracts/context-delivery-profile-v10.md)、
[输入快照存储](../../contracts/input-snapshot-storage-v1.md)与
[Runtime Launch v62](../../contracts/runtime-launch-and-verification-v62.md)。

## 1. 自动协作名单

### 变更前

每个 peer 包含四个字段。示例值仅展示结构，不代表改写历史团队角色。

```text
[COLLABORATION_STATE]
{
  "peers": [
    {
      "agentId": "agent_2",
      "name": "小河狸",
      "teamRole": "代码审查与质量验收",
      "professionalResponsibilities": "审查实现与需求的一致性，并验证关键边界。"
    }
  ],
  "defaultLeadAgentId": "agent_1",
  "selfIsDefaultLead": true
}
[/COLLABORATION_STATE]
```

### 变更后

```text
[COLLABORATION_STATE]
{
  "peers": [
    {
      "agentId": "agent_2",
      "name": "小河狸",
      "teamRole": "代码审查与质量验收"
    }
  ],
  "defaultLeadAgentId": "agent_1",
  "selfIsDefaultLead": true
}
[/COLLABORATION_STATE]
```

**改动说明：** 只删除 `professionalResponsibilities`，peer 恰好保留 `agentId`、`name`、
`teamRole`。职责不保留为空值、摘要或文件引用；顶层三个字段、空 `peers` 语义保持，
不增加模型可见 `schemaVersion`。其他队员通过团队角色识别分工，必要时再读详情。

| 相关读取 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| 查询和内部投影 DTO | 为四字段 peer 读取专业职责列 | 只读取三字段投影所需内容 | 从读取源头去掉长文本，避免先加载再丢弃 |
| peer 选择与顺序 | 既有 peer 范围、顺序和 Lead 派生 | 保持原规则 | 本次只改变内容投影；不与 member list 统一筛选 |

## 2. 协作摘要与刷新

| 触发情况 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| 只修改 peer 专业职责 | 职责参与完整最终投影，摘要改变 | 职责不参与投影，摘要不变、不因此重发 | 配合名单删除职责，避免无关刷新 |
| 只修改性格、工作准则、成长课题 | 不在投影中，不改变摘要 | 保持 | 不把完整 Profile 或 Profile version 间接纳入摘要 |
| 修改名称或团队角色 | 最终投影变化时刷新 | 保持 | 保留分工识别信息的正常更新 |
| 成员关系或 Lead 变化 | 最终投影变化时刷新 | 保持原选择规则 | 关系变化是否刷新仍由最终投影决定 |
| 按既有规则需要 Bootstrap | 提供完整当前名单 | 提供完整当前三字段名单 | Bootstrap 的出现条件不变 |
| 投影版本切换 | 已接受摘要可能对应旧四字段投影 | 有 peer 时，删除职责字段改变最终 JSON，后续新 Run 按原摘要比较投递新名单 | accepted ACK 后保存新摘要；后续不再因本次删字段重发，不扫描或回填旧会话 |
| peers 为空，其他投影值也未变 | 没有 peer 职责字段参与摘要 | 删除字段不改变空名单的 JSON | 不因本次字段删除强制发送；原有 Bootstrap 条件仍适用 |

**改动说明：** 摘要继续从最终投影计算，inclusion 与 accepted ACK 机制保持。
专业职责更新仍可触发正常的管理 UI 失效通知；管理界面重读资料与模型重收名单分别判断。

这里的“自然投递一次”来自**删除字段后最终 JSON 变化**，不是 Profile version 增加，也不是新增迁移或
resume 操作。[当前代码](../../../crates/rovai-core/src/context.rs)对最终投影计算 canonical JSON
摘要，并与 Conversation 上次 accepted 的摘要比较。新名单受理后记住新摘要；未受理、unknown 和
重试继续遵守原 ACK 规则，不能承诺物理发送恰好一次。已有 Session ID、冻结输入和原生历史均不重写。

## 3. `rovai member list`

### 3.1 成功输出

#### 变更前

```json
{
  "threadId": "thread_123",
  "items": [
    {
      "agentId": "agent_2",
      "displayName": "小河狸",
      "teamRole": "代码审查与质量验收",
      "professionalResponsibilities": "审查实现与需求的一致性，并验证关键边界。",
      "isDefaultLead": false
    }
  ]
}
```

#### 变更后

```json
{
  "threadId": "thread_123",
  "items": [
    {
      "agentId": "agent_2",
      "displayName": "小河狸",
      "teamRole": "代码审查与质量验收",
      "isDefaultLead": false
    }
  ]
}
```

**改动说明：** 每个条目从五字段变为四字段，只删除职责。命令、空对象输入、参数数量和
当前 Thread 范围保持；不新增分页、`--include-details` 或跨 Thread selector。

### 3.2 结果 Schema

#### 变更前

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["threadId", "items"],
  "properties": {
    "threadId": {"type": "string"},
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["agentId", "displayName", "teamRole", "professionalResponsibilities", "isDefaultLead"],
        "properties": {
          "agentId": {"type": "string"},
          "displayName": {"type": "string"},
          "teamRole": {"type": "string"},
          "professionalResponsibilities": {"type": "string"},
          "isDefaultLead": {"type": "boolean"}
        }
      }
    }
  }
}
```

#### 变更后

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["threadId", "items"],
  "properties": {
    "threadId": {"type": "string"},
    "items": {
      "type": "array",
      "items": {
        "type": "object",
        "additionalProperties": false,
        "required": ["agentId", "displayName", "teamRole", "isDefaultLead"],
        "properties": {
          "agentId": {"type": "string"},
          "displayName": {"type": "string"},
          "teamRole": {"type": "string"},
          "isDefaultLead": {"type": "boolean"}
        }
      }
    }
  }
}
```

**改动说明：** 从 item 的 `properties` 与 `required` 同时删除职责，继续禁止额外字段。
Catalog、Core 序列化、CLI 成功输出校验与证据测试同步更新，不能只在显示时隐藏。

| 相关入口 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| Agent list 查询 | 选取含职责的五项结果所需列 | 仅选取四项结果所需列 | 避免全量加载长职责后再丢弃 |
| `rovai app member list` | 用户管理命名空间的完整管理信息 | 保持 | Agent 路由列表精简不扩散到用户管理接口 |

## 4. `rovai member get`

| 内容 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| 输入 | `{ "agentId": "agent_2" }` | 相同 | 不新增参数 |
| 专业职责 | 完整返回已保存文字，字段上限 300 | 完整返回已保存文字，字段上限 10,000 | 只扩容，不摘要、截断或改成文件引用 |
| 结果结构 | 完整身份、version、images、imageStatus | 相同 | 复用现有完整身份接口 |
| 图片 | 当前 Run 可读临时路径及可用状态 | 相同 | 不返回内部资产引用或永久路径 |
| 管理信息 | 不含 Runtime、模型、权限、Presence、排序 | 相同 | 不扩大该接口的管理字段范围 |
| 目标授权 | 当前 Thread 成员或同一 Thread 创建成员的既有例外 | 相同 | 不新增字段级权限，也不扩大目标范围 |

前后共同的完整封闭结果结构如下；唯一内容容量变化已在上表紧邻列出：

```typescript
type MemberGetResult = {
  agentId: string;
  displayName: string;
  teamRole: string;
  professionalResponsibilities: string;
  personalityTraits: string[];
  workingPrinciples: string;
  growthTopic: string;
  version: number;
  images: { icon: string | null; portrait: string | null };
  imageStatus: {
    icon: "available" | "absent" | "unavailable";
    portrait: "available" | "absent" | "unavailable";
  };
};
```

**改动说明：** 队友的完整身份仍可按需读取。返回值是目标队员的配置资料，不能重包装为调用者的
身份指令。团队角色不足以判断分工时再读取相关候选人；不默认逐个 get 所有人。

### version 的含义与存储（保持）

| 内容 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| 当前成员资料 | agent_profile 每名队员维护一条当前记录 | 相同 | 不按每个 version 追加一整份 Profile |
| member get 的 version | 当前 Profile 的并发控制版本号 | 相同 | 与 Context/CLI 协议版本、Delivery Profile 版本是不同概念 |
| member update | expectedVersion 必须等于当前 version；内容有变更时原地更新并递增 | 相同 | 防止旧读取覆盖其他已完成的修改；无实际变化不递增 |
| 历史运行资料 | 按现有生命周期冻结实际运行输入、Bootstrap 或创建回执等必要证据 | 相同 | 这些记录不组成每次成员编辑的完整版本历史，也不是 get 按旧版本查询接口 |

**改动说明：** 例如读到 version 6，更新时携带 expectedVersion 6；如果别人已更新到 7，
本次返回版本冲突，重新读取后再决定如何修改。实现依据是
[member_tool.rs](../../../crates/rovai-core/src/member_tool.rs)中的当前资料查询、expectedVersion
检查和原地 UPDATE。
本次不新增成员版本库、历史回滚或历史 Profile 重算。

## 5. 专业职责长度与写入

### 5.1 上限、计数与失败处理

| 内容 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| 专业职责上限 | 300 个 Unicode scalar value | 10,000 个 Unicode scalar value | 仅扩容专业职责 |
| Core 校验组织 | 职责、工作准则、成长课题在同一个 300 字符校验循环 | 职责使用独立的 10,000 上限；其余两项仍为 300 | 避免全局替换 300 误改其他字段 |
| 前端计数 | 先 trim，再按 Unicode scalar 计数 | 保持计数口径，更新上限与计数显示 | 不改为 UTF-16、字节或 Token，不用 HTML maxlength 代替 |
| 首尾空白与正文 | 前端采用 String.trim()，内部格式保留 | 职责前后端统一沿用该 trim 口径，保留内部换行与格式 | Rust 等效实现，以 U+FEFF、U+0085 等差异字符验证一致性 |
| Schema 校验顺序 | 专业职责 Schema 上限 300 | 解析字符串 → 规范化职责 → 校验规范化值 → 事务保存 | 原始字符串多出的首尾空白不能提前触发新上限 |
| 空值与清空 | 可选字符串；空字符串表示清空，null 非法 | 保持；规范化后 0～10,000 均接受 | 不增加必填或 null 语义 |
| 超限提示 | 前端“专业职责最多 300 个字符。” | 统一“专业职责最多 10,000 个字符。” | Core 独立校验，前端保留超长草稿，不截断或自动摘要 |
| Unicode 归一化 | 不做 NFC/NFKC 或 grapheme 合并 | 保持 | 组合字符继续逐 scalar 计数 |

**改动说明：** 上限按规范化后的文字判断，不能只在 UI 放行。职责之外的身份字段继续沿用各自
规范化方式和限制：name 80、teamRole 120、traits 至多 6 项且每项 1～16、
workingPrinciples/growthTopic 各 300。

### 5.2 create / update 输入 Schema

| 操作 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| create | `{"type":"string","maxLength":300,"default":""}` | `{"type":"string","maxLength":10000,"default":""}` | 只增大 maxLength，保留创建时的默认空值 |
| update | `{"type":"string","maxLength":300}` | `{"type":"string","maxLength":10000}` | 只增大 maxLength；原本就没有 default |

**改动说明：** 本次没有新增“移除 update default”的操作。
[现有实现](../../../crates/rovai-core/src/member_tool.rs)复用 create Schema 时已经去掉默认值，
因为 create 初始化新身份，update 则是局部更新。两者省略字段的含义必须区分：

| 调用方式 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| create 省略职责 | 初始化为空字符串 | 相同 | 沿用创建默认值 |
| update 省略职责 | 保留原值 | 相同 | 不把“未要求修改”解释为清空 |
| 显式提交 `"professionalResponsibilities": ""` | 保存为空，update 时清空 | 相同 | 保留明确清空的入口 |
| 显式提交职责文字 | 保存规范化后文字，最多 300 | 保存规范化后文字，最多 10,000 | 此处只有合法长度扩大 |

`default` 本身不是写入命令；当前 update 的 `Option` 字段与事务内合并逻辑实际负责保留旧值。
例如仅提交新的 `teamRole`，原有职责、工作准则等保持原样，不能补空值一并提交。

### 5.3 写入入口与原子性

| 范围 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| 创建、编辑、复制、已有导入、Agent create/update、用户管理写入 | 遵守现有专业职责 300 上限 | 统一复用 Core 的新长度规则 | 覆盖所有既有入口，不新建导入功能 |
| 写入授权与确认 | direct-user、用户明确要求/确认 | 保持 | 扩容不扩大写入权限 |
| 版本与幂等 | 版本冲突、request/creation 幂等、复合图片原子提交规则 | 保持 | 保留现有并发与重试行为 |
| 超限复合更新 | 整体失败，不产生部分更新 | 保持，失败阈值改为 10,001 | 不能保存其他字段、增加 Profile version 或发布成功失效通知 |

**改动说明：** 超限是整次保存失败，UI 保留草稿供修改。团队角色不从职责自动截取，历史团队角色
不自动改写；不新增 Instructions、能力摘要等身份字段。

## 6. CLI help

CLI 延续英文。描述只说明命令做什么，以及影响正确使用的目标范围、临时路径有效期。
成员筛选细则保留在合同与实现中；`verified by Core` 等内部实现说明不进入目标 help。
以下旧文本来自基线 [Catalog](../../../crates/rovai-core/src/team_tool_catalog.rs) 与
[CLI help renderer](../../../crates/rovai-core/src/bin/rovai.rs)。每项的完整旧文本与完整新文本紧邻。

### `rovai member list --help`

#### 变更前

```text
rovai member list
List all current Thread members, including yourself and away members, with IDs, names, roles, responsibilities and Default Lead flags. Exclude departed or removed members. This does not discover the global roster.

Input: direct flags, JSON stdin/heredoc, or --input-file <path>. Choose exactly one input source.


Examples:
  rovai member list
```

#### 变更后

```text
rovai member list
List current Thread members, team roles and the default Lead.

Input: direct flags, JSON stdin/heredoc, or --input-file <path>. Choose exactly one input source.


Examples:
  rovai member list
```

**改动说明：** 描述缩为一句，只说明当前 Thread 的队员、团队角色和默认 Lead。
删除职责承诺和筛选细节教学；输入方式与示例保持。

### `rovai member get --help`

#### 变更前

```text
rovai member get
Read a member's six identity fields, version and icon/portrait paths. The target must be a current Thread member or a member you created in this Thread, verified by Core. Image paths last only for this Run; null paths have a separate image status.

Input: direct flags, JSON stdin/heredoc, or --input-file <path>. Choose exactly one input source.

  --agent-id                   field=agentId type=string required

Examples:
  rovai member get --agent-id agent_27
```

#### 变更后

```text
rovai member get
Read a member's full identity, version and image paths.
Target a current Thread member or one you created here. Image paths last for this Run.

Input: direct flags, JSON stdin/heredoc, or --input-file <path>. Choose exactly one input source.

  --agent-id                   field=agentId type=string required

Examples:
  rovai member get --agent-id agent_27
```

**改动说明：** 用“完整身份”替代六字段枚举，删除 `verified by Core` 与空路径状态的细节。
保留会影响正确调用的目标范围和图片路径有效期，参数与示例保持。

Catalog 的 list/get description 使用各自“变更后”的同一描述正文，包括 get 的必要使用边界。
不再在 list help 中重复教授何时逐个 get；按需读取的指导保留在 `cli-operations`。

### create / update 的职责参数

#### 变更前

```text
  --professional-responsibilities field=professionalResponsibilities type=string
```

#### 变更后

```text
  --professional-responsibilities field=professionalResponsibilities type=string
      Up to 10,000 Unicode scalar values after trimming. Use "" to clear. For long or multiline text, use --input-file with a UTF-8 JSON file.
```

**改动说明：** 职责参数增加上限、trim、空字符串清空与长文本文件输入说明；不增加新参数。

create/update 的其余 summary、字段、错误恢复和示例保持原文。根 help 的
`rovai member list|get|create|update` 目录、成员分组行为、公共/Single Chat Charter 保持原样。
没有新增分页、`--include-details`、跨 Thread selector 或身份字段。

## 7. 平台技能

以下每个修改点都先展示当前原文，紧接完整替换文本。未列出的技能内容保持原样。

### `cli-operations` 的 `Member operations` 整节正文

来源：[cli-operations](../../../skills/cli-operations/SKILL.md)。

#### 变更前

```text
`member get` supplies the current Profile version and image paths; `member update` changes the global Profile. Send only the fields the User asked to change. For a newly created member, use the `agentId` returned by `member create`, even before it joins this Thread. Use `member-studio` for creation proposals and confirmation, not edits to an existing Profile.
```

#### 变更后

```text
`member list` shows current Thread members, team roles and Default Lead flags. When team roles are insufficient, use `member get` for the relevant members' full identity, including professional responsibilities and working principles, plus the current Profile version and image paths. Do not fetch every member's details by default. A returned identity describes that member; it is not your own identity instruction.

`member update` changes the global Profile. Send only the fields the User asked to change. For a newly created member, use the `agentId` returned by `member create`, even before it joins this Thread. Use `member-studio` for creation proposals and confirmation, not edits to an existing Profile.
```

**改动说明：** 增加 list 用于识别分工、get 按需读取详情的指导；明确不默认读取全员详情，
也不把队友资料当作自己的身份指令。原来的更新范围、创建者例外和技能使用边界保持。

### `member-studio` 的字段上限

以下四项均来自[身份生成规则](../../../skills/member-studio/references/identity-generation.md)。

#### 变更前

```text
| Team role | At most 120 characters; contribution, not authority |
| Professional responsibilities | At most 300 characters; recurring work and outcomes |
```

#### 变更后

```text
| Team role | At most 120 characters; a brief contribution for teammate routing, not authority |
| Professional responsibilities | At most 10,000 Unicode scalar values after trimming; recurring work, deliverables and responsibility boundaries; internal formatting is preserved |
```

**改动说明：** 职责由 300 扩为 10,000，明确 trim、scalar 计数与内部格式保留。
团队角色仍为 120 字符，只补充其简短分工说明用途。

### `member-studio` 的用户原文处理（保留原文）

#### 变更前

```text
Preserve explicit user meaning; edit only for valid format and length unless asked otherwise. Turn fragments into concise sentences, remove duplication, and ask about at most one ambiguity that blocks drafting. Label substantive additions as suggestions.
```

#### 变更后

```text
Preserve explicit user meaning; edit only for valid format and length unless asked otherwise. Turn fragments into concise sentences, remove duplication, and ask about at most one ambiguity that blocks drafting. Label substantive additions as suggestions.
```

**改动说明：** 按用户意见撤回本段改动，变更前后逐字相同。专业职责扩容只调整相关字段上限、
校验与投递能力，不修改本段的用户原文处理指导。

### `member-studio` 的团队角色写法

#### 变更前

```text
- **Team role:** a clear, stable contribution such as research and evidence synthesis. It confers no rank or Default Lead status.
```

#### 变更后

```text
- **Team role:** one short statement of the member's stable contribution, used by teammates to identify relevant responsibilities. It confers no rank or Default Lead status. Do not derive it by automatically truncating responsibilities or rewrite existing roles without a request.
```

**改动说明：** 团队角色用于一句话识别分工；不自动截取职责，也不擅自重写历史角色。
它不赋予级别或默认 Lead 权限的边界保持。

### `member-studio` 的专业职责写法（保留原文）

#### 变更前

```text
- **Responsibilities:** 1-3 sentences covering the problem or object, recurring actions, and expected outcomes. Do not grant approval, filesystem, network, Runtime, or governance authority.
```

#### 变更后

```text
- **Responsibilities:** 1-3 sentences covering the problem or object, recurring actions, and expected outcomes. Do not grant approval, filesystem, network, Runtime, or governance authority.
```

**改动说明：** 按用户意见撤回本段改动，保留 1～3 句的生成建议与原权限边界。
字段可以保存 10,000 字符，不要求身份生成技能默认写成长篇。

技能文件仍在原有发现/读取路径生效，不把技能正文或队友职责复制到其他动态 section。

## 8. 本人身份 `MEMBER_IDENTITY`

| 内容 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| 专业职责全文 | 在本人身份中完整投递，最多 300 字符 | 在本人身份中完整投递，最多 10,000 字符 | 长文保留在本人身份，不改成按需 get 或文件引用 |
| 六字段 JSON 与 section 名称 | MEMBER_IDENTITY，现有六字段 | 相同 | 扩容不增加身份字段 |
| Bootstrap 顺序 | SESSION_CHARTER → MEMBER_IDENTITY → ROVAI_PLATFORM_SKILLS → MEMORY_ENTRYPOINT? | 相同 | 保留已有注入位置 |
| 身份生效与补发 | 既有快照、Bootstrap、恢复及合格补发规则 | 相同 | 不随 Profile 编辑改写正在使用的冻结身份，也不每轮追加最新职责 |

前后共用的完整短文本示例如下；长文本使用同一个职责字符串字段：

```text
[MEMBER_IDENTITY]
{
  "name": "爱丽丝",
  "teamRole": "架构与核心实现",
  "professionalResponsibilities": "理解目标和现有系统，设计接口与数据流，完成核心实现。",
  "personalityTraits": ["好奇", "严谨"],
  "workingPrinciples": "先确认约束，再实施可验证的改变。",
  "growthTopic": "把隐含判断转化为明确的设计依据。"
}
[/MEMBER_IDENTITY]
```

**改动说明：** 从协作名单移除职责不影响本人身份，也不禁止队友通过 get 读取。
长期配置、冻结会话身份与协作名单分别沿用各自生命周期。

## 9. 完整上下文与外围容量

R4 保留原有容量提案，并补列 Cline 的独立限制。确认后实现并以真实投递验收；这不是已验证的
Runtime 能力声明。

### 9.1 共享预算与已确认的局部限制

Core 的组包预算有共享入口，各 Adapter 的 Bootstrap、绑定文件与外部 CLI 限制仍分别存在。
[共享预算函数](../../../crates/rovai-core/src/context.rs)对所有 Runtime 使用默认值或显式
maxContextPayloadBytes；Bootstrap 是否计入同一个 payload，则取决于它实际从哪个通道投递。

| 检查点 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| Core Runtime payload 默认预算，无显式覆盖时 | 96 KiB | 256 KiB（262,144 bytes） | 提高共享组包额度；实际同包的 Bootstrap 一并计入，独立系统提示另核验 |
| 既有 FirstPayload preflight 的 Bootstrap 预留 | 32 KiB | 128 KiB 正文预算，加实算分隔符/补发 wrapper；只计实际同包内容 | 使领取批次前的预留覆盖长身份和实际封装 |
| Command Code Bootstrap 正文，Rust/JS 两端 | 32 KiB | 128 KiB，两端相同字节口径 | 去掉阻碍 10,000 字符投递的局部瓶颈 |
| Command Code 绑定 JSON 文件 | 64 KiB | 256 KiB，按实际外层序列化结果校验 | 外层字符串转义可能比正文占用更多字节 |
| Cline Bootstrap 正文 | 32 KiB | 128 KiB；同时核验规则文件和绑定 JSON 的实际字节 | R4 补列同样会阻碍长职责的独立校验，不沿用旧 32 KiB 瓶颈 |
| 显式 maxContextPayloadBytes | 覆盖默认值 | 保持既有显式配置 | 提高默认值不等于底层真实限制已放宽 |
| 工具结果、IPC、其他 Adapter 限制 | 各自当前规则 | 完整链路核验，只调整实际阻碍新长度的局部限制 | 不盲目放大所有全局限制 |

**改动说明：** 默认完整上限增加 160 KiB；既有 FirstPayload 预留后的动态预算从 64 KiB 增为约 128 KiB，
再扣除实际分隔符/补发 wrapper，仍高于原有 64 KiB。
这保证增加身份容量的同时保留原有业务输入余量，而不是用长职责挤占旧额度。
实际预算必须计入所有必需 section、完整消息、技能入口、Memory、分隔符与外层封装；批次 claim
与最终投递使用一致的容量口径。对实际同包投递的 Bootstrap/补发 overlay 预留足额空间，
不能让 claim 把 256 KiB 全部用作 RUN_INPUT，最终再追加 Bootstrap 导致失败。
FIFO、原子完整消息、可选项优先级保持；提高容量可能让一个新批次容纳更多完整消息，这是预期效果。

### 9.2 各 Runtime 的适用边界

下面按[当前投递模式映射](../../../crates/rovai-core/src/context.rs)说明共享规则与独立路径。
这些是代码静态核对结果，不是 10,000 字符端到端投递通过记录。

| Runtime / 路径 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| Codex CLI、Claude Code、Grok Build（NativeAppend） | 动态 payload 走共享预算，Bootstrap 通过独立系统指令入口传递 | 共享默认预算提高；逐项核验独立入口及真实 Runtime | 不能把动态 payload 的额度直接当作独立 Bootstrap 或模型窗口额度 |
| Pi、Deepseek Harness（ManagedSystemPrompt） | 共享组包预算之外，Bootstrap 经托管系统提示/绑定读取；已读绑定实现未设置与 Command Code 相同的 32 KiB 正文检查 | 提高共享默认值，核验托管 Host、绑定、系统提示拼接及外围传输 | 不据此宣称无其他限制；本轮未启动真实 Runtime |
| Command Code（ManagedSystemPrompt） | 共享预算之外，Rust/JS 正文 32 KiB，JS 绑定 JSON 64 KiB | 正文 128 KiB，绑定 JSON 256 KiB | 同时调整两层、两端校验，不能只放宽 Core |
| Cline（ManagedSystemPrompt） | 共享预算之外，Rust 正文 32 KiB，写入规则文件及绑定 JSON | 正文 128 KiB，核验规则 wrapper 与外层 JSON | 上一版只写 Command Code 漏列了这一独立限制；仍保持既有非公开准入状态 |
| OpenCode、Copilot、Antigravity、ZCode、Kiro、Qoder、CodeBuddy、Qwen Code、TRAE、Cursor、Kimi（FirstPayload） | Bootstrap 需要投递时与动态内容合包，既有 preflight 预留 32 KiB | 共享默认 256 KiB，既有预留改为 128 KiB 正文加实算 wrapper，按实际同包内容核算 | 这些入口共享组包规则，但各自 CLI/协议/模型上限仍须逐项验收 |

**改动说明：** 共用 Core 预算不代表整条投递链路只有同一个限制。
Command Code 的检查见 [Rust 绑定](../../../crates/rovai-core/src/command_code_acp.rs)与
[JS 读取](../../../crates/rovai-core/src/command_code/bootstrap.mjs)；
Cline 的遗漏依据是 [bind_bootstrap](../../../crates/rovai-core/src/cline.rs)中的 32 KiB 检查。
Pi / Deepseek 的静态核对覆盖托管绑定读入，但不替代外部 Runtime、IPC 和模型的实际投递验收。
真实模型上下文仍按各自 Token 窗口限制；本次提高的是 Rovai 内部字节预算。

### 9.3 字节测算依据

本方案已完成以下离线序列化测算。输入均为 10,000 个 scalar，JSON 使用 UTF-8 非 ASCII 原样输出，
第一层是仅含职责字段的紧凑对象，第二层是 `{"bootstrap": 第一层字符串}`；数值不是整份 Bootstrap。

| 文本样例 | 正文 UTF-8 bytes | 第一层 JSON bytes | 第二层 JSON bytes |
| --- | ---: | ---: | ---: |
| `a` × 10,000 | 10,000 | 10,035 | 10,055 |
| `研` × 10,000 | 30,000 | 30,035 | 30,055 |
| `🌸` × 10,000 | 40,000 | 40,035 | 40,055 |
| `e` + U+0301，重复 5,000 次 | 15,000 | 15,035 | 15,055 |
| `a` + 9,998 个换行 + `z` | 10,000 | 20,033 | 30,051 |
| 双引号与反斜杠交替 | 10,000 | 20,035 | 40,055 |
| U+0000 × 10,000，覆盖现有字段未禁止的 JSON 转义 | 10,000 | 60,035 | 70,055 |

测算依据为 Python `json.dumps(..., ensure_ascii=False, separators=(',', ':'))`，用
`len(text)` 与 `len(serialized.encode('utf-8'))` 分别记录 scalar 与字节。
实施验收必须改用产品实际 Rust/JS formatter，包含其他身份字段、条件 Charter、技能、Memory、
绑定元数据和真实业务输入。若固定模板增长或实际允许文本突破提案值，应先更新容量对照与 revision；
不得通过截断、摘要、文件引用或丢弃必需 section 达标。256 KiB 也不是模型 Token 窗口的声明。

## 10. 协议与格式版本

以下编号以本文件的冻结基线为准，实施时若主线占用编号，只调整至未占用编号并记录差异。
不能把改变后的新生成结果继续标为旧结果版本，也不能在模型正文增加版本字段。

| 版本轴 | 变更前 | 变更后（拟议） | 改动说明 |
| --- | --- | --- | --- |
| Collaboration State 合同 | v3 | v4 | peer 删除职责，记录投影变化 |
| Agent Output | 10 | 11 | member list 封闭结果结构改变 |
| Built-in Transport / CLI / capability | 38 / 38 / builtin_cli.transport.v38 | 39 / 39 / builtin_cli.transport.v39 | Core 与 CLI 配套升级，避免旧校验器接收新结果 |
| IPC / Envelope | 3 / 2 | 保持 | 字段删除不需要重建运输框架 |
| 公共 batch Formatter / Manifest | 33 / 33 | 34 / 34 | 冻结三字段 peers 与新预算语义 |
| 非 batch Formatter / Manifest | 28 / 28 | 35 / 35 | 避免复用已有 29～33 的历史含义 |
| Delivery Profile | 公共 10，非 batch 7 | 公共 11，非 batch 12 | 只更新本次容量语义，保留各自字段形状与其他数值 |
| Bootstrap / Bootstrap formatter | v5 / 5 | 保持 | 六字段身份与 wrapper 结构未变 |
| Charter revision / Run Facts / 补发 envelope | 22 / 公共 9、非 batch 6 / 2 | 保持 | 不增加本次无关教学或字段 |
| Native Binding / 原生恢复资格 | 当前既有规则 | 保持 | 上述版本不接入恢复资格判断 |

### Delivery Profile 冻结内容

| 内容 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| 公共 Profile JSON | `{"profileVersion":10,"maxSelfActiveTasks":8}` | `{"profileVersion":11,"maxSelfActiveTasks":8}` | 只调整版本，保留最小字段形状与 Task 数值 |
| 非 batch Profile | profileVersion 7；15 条历史、24,000 history chars、2,000 body chars、3 条 reference chain、8 个 Task | profileVersion 12；其余字段和值相同 | 记录新容量语义，不借机调整其他预算 |
| 容量配置归属 | 既有 Runtime capability / 默认值入口 | 相同 | 不新增第二套配置表或持久化预算系统 |

## 11. 历史与 resume

| 场景 | 变更前 | 变更后 | 改动说明 |
| --- | --- | --- | --- |
| 新会话与尚未冻结的新 Run | 使用当前初始化和格式版本 | 使用新初始化、三字段协作投影与配套工具结果 | 不按 Thread 创建时间维护两套新生成协议；老会话也能继续正常对话 |
| 已准备的同一 Run / Binding / generation | Bootstrap、Manifest、业务输入冻结 | 保持原字节 | 不用最新 Profile 重算并覆盖历史输入 |
| 已领取但尚未 materialize 的旧格式输入 | 沿原版本生成路径完成 | 仍沿原版本路径完成 | 不用新 formatter 覆盖旧格式标记 |
| 历史 Context、身份、Binding 文件与协作摘要 | 按既有冻结和审计规则保存 | 原样保留，不扫描或回填 | 不迁移历史正文；老原生历史中已有职责继续保留 |
| 新 Run 续聊依赖 | 沿既有恢复条件 | 不新增读取、校验或修复旧 Bootstrap 的前提 | 历史 Bootstrap 缺失不能因本次变更新增续聊障碍 |
| 协作摘要切换 | 最终投影比较，仅 accepted ACK 推进 | 沿用同一机制自然比较新投影 | 不为老会话新增一次性修复任务 |
| 原生恢复 | 当前 Conversation 的原 Session ID 与既有 Adapter 流程 | 相同 | 不加拒绝、重置、强制新建或迁移提示；不改变既有降级、unknown/accepted 防重与权限检查 |
| Core / CLI 不匹配 | 既有运输版本机制在 dispatch 前拒绝 | 同一产品包提供匹配的新版本，沿用该拒绝机制 | 防止写入已执行才发现结果校验失败；不因此重建原生 Session |
| 数据库 Context / Profile 版本约束 | 现有版本封闭准入，历史行与引用保留 | 按既有迁移机制增加新版本准入与配对 | 只扩展约束；保留旧版本、历史行、Blob 引用及业务数据，不做历史内容迁移 |

**改动说明：** 用户不需要处理老会话。新生成内容采用新规则，既有冻结输入和原生 Session 保持。
数据库迁移使用实施时下一可用编号，不能复用或回退当前版本。
已有 [v60 继承规则](../../contracts/runtime-launch-and-verification-v60.md)明确：上下文/Bootstrap
格式差异不参与恢复资格，历史 Bootstrap 仅供对应输入审计。不能恢复“格式变化即换 Session”的行为。

## 明确不变

下列事项列出共同基线与保持原因，避免将“本次确认继续保留”误读为新增行为。

| 边界 | 变更前 | 变更后 | 保持原因 |
| --- | --- | --- | --- |
| peer 范围 | 排除 self；active 且非全局 removed；away 与 leave-requested 在正式 left 前仍按既有规则处理 | 相同 | 本次只精简字段 |
| list 范围 | 当前 Thread，包括 self 与 away；排除 leave-requested、left 和全局 removed | 相同 | 不统一 list 与 peers 的不同语义 |
| 顺序与 Lead | 各入口原顺序和 Lead 派生；读取不自动指定 Lead | 相同 | 字段扩容不改变团队关系 |
| get/update 授权 | 当前 Thread 目标或调用者在同一 Thread 创建成员的既有例外 | 相同，无新增字段级 ACL | 不自动注入不等于禁止按需读取 |
| 写入约束 | direct-user、明确要求/确认、版本冲突、原子性、幂等与现有错误恢复 | 相同 | 保持访问与写入边界 |
| 自我身份 | 既有 eligible Bootstrap 边界读取与投递 | 相同，不增加每轮动态补丁 | 保留冻结身份生命周期 |
| 动态正文 | 现有 section 顺序、Task、RUN_FACTS、WORKSPACE、RUN_INPUT/CURRENT_INPUT、Skill/MCP 边界 | 除 peers 删除职责外均相同 | 不把长职责挪入其他动态区段 |
| 管理失效通知 | 正常 Profile 更新可通知管理 UI 重读 | 相同 | 与协作摘要刷新分别判断 |
| 其他身份字段 | 原字段与限制，无 Instructions/能力摘要 | 相同 | 扩容仅针对专业职责 |
| Single Chat | 既有工具 allowlist、专用 Charter，无协作名单 | 相同；完整本人身份遵守同一容量规则 | 不借扩容改变单聊范围 |

## 涉及文件与实施顺序

本分支的文档交付只涉及本说明及版本概览入口；R4 修订技能变更范围并补充摘要、版本与容量说明。
确认实施后预计修改下列范围；最终以实际 diff 为准。

| 文件/范围 | 修改目的 |
| --- | --- |
| `crates/rovai-core/src/agent_profile.rs`、`member_studio.rs`、`member_tool.rs` | 专业职责共享规范化、独立上限、输入 Schema、窄 list 查询、封闭结果 |
| `apps/desktop/src/renderer/src/member-identity-draft.ts` 及既有创建/编辑/复制/导入消费点 | Unicode 校验、计数、错误和草稿保留；不改其他身份字段 |
| `crates/rovai-core/src/context.rs`、`context_delivery.rs`、`context_contract.rs`、`delivery_queue.rs` | peers 窄投影/摘要、完整字节预算、版本化新生成路径与旧冻结恢复 |
| `crates/rovai-core/src/command_code_acp.rs`、`command_code/bootstrap.mjs`、`cline.rs` | 同步已确认的 Bootstrap 局部容量，核验外层文件与规则 wrapper，保持绑定身份/不可变性检查 |
| `crates/rovai-core/src/team_tool_catalog.rs`、`bin/rovai.rs`、`builtin_tool_cli_output.rs`、`builtin_tool_transport.rs` | 统一帮助、新结果校验及匹配的协议版本 |
| `crates/rovai-core/src/builtin_tool_evidence_projection.rs`、`packages/contracts` 对应 DTO/fixtures/tests | 新投影证据与合同校验；历史 fixture 不改写成新格式 |
| 既有数据库版本约束迁移与对应恢复测试 | 增量准入新版本，旧冻结状态继续可读可恢复 |
| `skills/cli-operations/SKILL.md`、`skills/member-studio/references/identity-generation.md` | 上述确认范围的文本；用户原文处理与专业职责写法两段保持原文 |
| `docs/contracts`、`docs/architecture`、当前版本实施记录与必要版本决定 | 更新当前权威/路由，保存历史理由，记录真实验证范围 |

顺序：确认本 revision → 共享字段校验与窄结果 → 上下文/容量/历史兼容 → help/技能/合同同步
→ 自动化与真实投递验收 → 提交实际文件清单、协议差异和证据。不得先改当前合同再把提案视为已确认。

## 验证

### 自动化验收

| 检查 | 必须证明 |
| --- | --- |
| scalar 与 trim | 0、10,000 成功；10,001 失败；中文、补充平面、组合字符、内部换行和首尾空白跨前后端一致；额外首尾空白不会提前触发 raw Schema 上限 |
| 写入与失败 | UI 留草稿；创建/编辑/复制/导入、Agent CLI、用户管理入口一致；超限复合 patch 无部分写入/版本增加 |
| 封闭结果 | list item 恰好四字段，get 保留完整职责并符合原图片/版本语义；非法额外字段被结果校验拒绝 |
| 范围与权限 | self/away/leave-requested/left/removed、无 Lead、创建者例外、跨 Thread 拒绝；list 与 peers 差异保持 |
| 摘要与 ACK | 只改职责/人格等摘要不变；名称/角色/有效关系变动会变；未 accepted/unknown 不推进水位 |
| 本人身份 | 10,000 字符首中尾与完整字节一致；不进 peers，不重复进入动态 section；沿用资格边界 |
| 容量 | 全身份、条件段、最坏 JSON 转义、业务输入与外层封装合计校验；claim 与实际组包边界一致；覆盖 Command Code/Cline 独立限制及所有其他 Runtime 入口 |
| 恢复 | 旧 frozen 字节不变；旧待 materialize 输入维持版本路径；新 Run 采用新版本且继续相同原生 ID；历史 Bootstrap 缺失不新增续聊障碍 |
| 帮助与教学 | Catalog/list/get help、职责参数、技能文本符合本对照；两段明确保留的 member-studio 原文不变；没有默认逐个 get 全队、隐式扩权或旧职责 300 说明 |

优先扩展现有测试 owner；增加或退役 Rust 测试前执行
[测试准入规则](../../development/testing.md#rust-测试准入与退役门槛)。
拟复用命令包括 `pnpm docs:test`、`pnpm docs:check`、`DOCS_BASE_REF=<base> pnpm docs:check:ci`、
成员字段/CLI/Core owner 测试和 `node --test scripts/lib/command-code-bootstrap.test.mjs`。
实际测试名称、通过数与结果在实施记录补齐，不把本表当作已执行证据。

### 真实投递与上下文 Gate

依照[本地隔离流程](../../development/local-workflow.md)和[双轨评测](../../development/evaluation.md)，
使用独立测试目录/数据，禁止启动指向日常 Electron userData 的验收进程。

- 以已保存职责原文为基准记录长度和摘要，分别核对 `member get`、本人 Bootstrap、Adapter 实际入参
  和接受证据；随机首中尾标记用于确认模型可读到全文，单纯模型复述不能替代字节核对。
- 新会话、同原生 ID 的 warm/cold resume、Core 重启后续聊、原有合格 compaction 补发均覆盖；
  不为不具备补发资格的 Runtime 新造恢复机制。
- 按现有投递模式逐项记录，不用一个 Runtime 的通过外推其他 Runtime。当前映射为：

| 交付模式 | 必须逐项记录的 Runtime | 本轮状态 |
| --- | --- | --- |
| NativeAppend | Codex CLI、Claude Code、Grok Build | 全部未运行 |
| ManagedSystemPrompt | Pi、Deepseek Harness、Command Code、Cline | 全部未运行；后两者保持既有非公开准入状态 |
| FirstPayload | OpenCode、Copilot、Antigravity、ZCode、Kiro、Qoder、CodeBuddy、Qwen Code、TRAE、Cursor、Kimi | 全部未运行 |

真实模型 Gate 固定使用基线 Suite `context-regression@2.12.0` 的 DEMO-101～112，共 12 个 Case；
评分 rubric `generic-task-quality@2.10.0`，一轮重复，基线/候选相同 Runtime/模型/权限，至少三位成员。
计划总时限 14,400 秒、Case 并行度 2、Judge 2,400 秒，每个 campaign 最多两次，保留失败尝试。
Case 单项预算与密封材料沿用 suite，不为通过候选修改标准。
具体可用 CLI/模型/真实 Judge 的版本、配置、构建产物及预算由 `eval:gate freeze` 在首次运行前
冻结；本轮没有启动 Runtime、Judge 或付费模型任务。若没有可用完整配置，记录 `not_run`/证据不足。
通过要求为既有 Gate 完整通过、无关键回归与证据缺口；不拿规则测试通过代替语义 Judge 或真实投递。

### 本轮文档验证记录

已完成：干净主线基线核对、独立 worktree 创建、代码/合同/help 只读核对，以及上表离线字节测算。
产品代码和真实 Runtime 验证尚未执行。2026-10-13 的 R1 文档验证结果：

| 命令/检查 | 结果 |
| --- | --- |
| `pnpm docs:test` | 10/10 通过 |
| `pnpm docs:check:decisions` | 通过，全仓文档链接及决定治理检查完成 |
| `DOCS_BASE_REF=39bf1eb09a208ea9abd98b737d6ed7c669ed7cbf node scripts/check-doc-decisions.mjs --require-base` | 通过，独立完成相对基线的历史冻结与治理检查 |
| `pnpm docs:check` | 按预期阻断，仅本 R1 缺少用户二次确认的四项记录 |
| `DOCS_BASE_REF=39bf1eb09a208ea9abd98b737d6ed7c669ed7cbf pnpm docs:check:ci` | 同样在版本确认检查处阻断；不宣称完整 CI 通过 |
| `git diff --check` | 通过 |

四项记录分别为 `confirmed_revision`、`confirmation_status: confirmed`、`confirmed_by` 和
`confirmed_at`。尚未发生的用户确认不能补填；门禁没有被豁免或修改。

R2 同日复核：`pnpm docs:test` 仍为 10/10 通过；相对上述 base 的
`check-doc-decisions.mjs --require-base` 通过，含链接与历史冻结检查；4 个 JSON 示例可解析，
8 处 help/技能均有紧邻的完整前后文本，目标 help 无 `verified by Core`。
`pnpm docs:check` 和 `pnpm docs:check:ci` 仍只因 R2 未确认的上述四项记录阻断。
`git diff --check` 通过，改动仍仅为本说明和版本概览入口。

R3 同日复核：`pnpm docs:test` 10/10 通过；相对同一 base 的
`check-doc-decisions.mjs --require-base` 通过。R2 的 23 个结构示例、help 和技能正文代码块
逐字保留，create 属性短示例并入紧邻对照表；4 个 JSON 示例可解析。
全文 11 组完整文本对照各自包含变更前、变更后和改动说明；其余规则、数值及保持项均用同行对照表。
`pnpm docs:check` 和 `pnpm docs:check:ci` 仍仅因 R3 未确认的四项记录阻断；未修改门禁。
`git diff --check` 通过，产品实现与当前合同未改动。

R4 同日复核：`pnpm docs:test` 10/10 通过；相对同一 base 的
`check-doc-decisions.mjs --require-base` 通过。两段撤回的技能文案在变更前后均与基线原文逐字相同，
4 个 JSON 示例可解析，`git diff --check` 通过。代码只读核对确认了最终投影摘要比较、
member get 当前行读取、member update 原地更新与版本检查，以及共享预算和 Cline 独立 32 KiB 校验。
`pnpm docs:check` 与 `pnpm docs:check:ci` 仍仅因 R4 未确认的四项记录阻断。
此次仍只改本说明与版本概览；真实 Runtime 未运行，未把静态核对记为投递通过。

## 二次确认

User 在阅读 R4 后通过消息 `23b13d59-00b5-4c6c-a6f9-992b59fd32d6` 明确要求：
“那你开始编码，开启wt”。记录 `confirmation_status: confirmed`、`confirmed_revision: 4`，
确认日期为 2026-10-13。继续复用本工作原有 worktree，实施基线已合入 `origin/main` 的
`a8704823a`；原审阅基线与 R4 对照保持，主线新增改动未占用本方案的协议编号。
Thread `rvcamp_01m4r7rvjff0svehpr9s78zc16` 中用户已确定需求、resume 边界与提高完整上限，
消息 `c3403579-8f3c-40d6-b705-ccae198fea70` 要求“开启 wt”并先提供上下文、CLI、CLI-help 前后方案。
该消息授权创建本 worktree 与本方案。随后消息 `c10f4185-c894-4eed-a50c-acc41901fc94`
要求精简 help、解释 `default`、把技能前后文案放在一起；消息
`1a19808b-ee83-4f65-b815-6887010a32ff` 进一步要求每项内容的变更前、变更后紧邻，并解释每项改动。
R3 据此统一整份说明的对照格式，保留 R2 的方案内容，不把审阅意见记为实施确认。
随后消息 `4b828ecd-3df8-4355-b52e-a5d8b15e1b04` 撤回两段 member-studio 改写，并询问摘要、
成员版本存储及 Runtime 限制；R4 落实撤回、补充事实说明并补列 Cline 容量检查，不视为实施确认。
R1、R2 原文分别保留在 Git 提交 `158b333001ba13ed313d9b5f431a69142ef9e50c`、
`454755395c65965976b2faa9c5813613cecf6067`；R3 保留在提交 `5e50c96f1`。

按[上下文变更治理](../../development/model-context-change-governance.md)：
“未取得确认时可以继续调查和编辑提案文档，但不得修改实现、Schema、当前合同或执行 clean break。”
本 R4 已取得上述明确实施授权，无需重复确认。后续若改变已确认语义，按治理规则记录 revision
与实际确认；不伪造确认字段或增加 checker 例外。

## Worktree 交接

```text
Work item: 成员路由精简、专业职责扩容与模型上下文/CLI/help 前后方案
Worktree: /Users/murray.xue/VSCodeProjects/opensource/rovai-ai-member-routing-context
Branch: rovai/member-routing-context
Base: origin/main @ 39bf1eb09a208ea9abd98b737d6ed7c669ed7cbf
Governance: R4 confirmed by User / 23b13d59-00b5-4c6c-a6f9-992b59fd32d6
Status: ready（代码与定向验收完成；语义 Gate 未运行）
Validation: 见本文件“实施与验证记录”
Next: 分支审阅；取得固定 Judge 配置后补齐语义 Gate
```

## 实施与验证记录（2026-10-13）

R4 已在原 worktree 实现；上述审阅时的前后对照和历史验证记录不回写。本节记录实施后的状态。
代码和定向验收完成，不宣称完整语义 Gate 或所有 Runtime 已通过，也未合入、发布或修改日常数据。

### 实际契约差异

| 项目 | 变更前 | 已实现 | 说明 |
| --- | --- | --- | --- |
| 专业职责 | 300 scalar | trim 后 0～10,000 scalar | 前端、Core、CLI Schema 同口径；超限原子失败，草稿保留；其他字段限制不变 |
| Agent member list | 五字段含职责 | 四字段：ID、名称、角色、Lead | Schema 和 SQL 均删除职责；用户管理列表保持完整 |
| Collaboration State | peer 四字段含职责 | peer 三字段：ID、名称、角色 | 直接查窄字段；摘要只基于最终投影；职责编辑不刷新名单 |
| member get / 本人身份 | 完整身份 | 完整身份、允许长职责 | 原授权、临时图片、身份生效及补发资格保持 |
| Transport / CLI / Output | 38 / 38 / 10 | 39 / 39 / 11 | IPC 3、Envelope 2 保持，旧结果 fixture 保留 |
| public Manifest / Profile | 33 / 10 | 34 / 11 | 旧 29～33 已领取输入沿原 serializer；历史 Blob 不重写 |
| 非 batch Manifest / Profile | 28 / 7 | 35 / 12 | 不复用历史 batch 编号；旧冻结 Profile 仍能读取 |
| Database | schema 146 | schema 147 / migration 197 | 原子扩展格式准入，保留旧行；缺少新写入 guard 时拒绝准入 |
| Native Binding / Bootstrap | 既有兼容标识、Bootstrap 5 | 保持 | 不因输出版本变更重建原生 Session |
| 默认完整输入 / 同包 Bootstrap 预留 | 96 / 32 KiB | 256 / 128 KiB，另计实际封装 | claim 计入全部必需区段，保留完整消息及可选 Task 的既有优先级 |
| Command Code / Cline 正文 | 32 KiB | 128 KiB | Command Code 外层绑定 JSON 同时从 64 调整为 256 KiB；Cline 规则文件完整保留 |
| Help / 技能 | 详见 R4 对照 | 按已确认文本实施 | update 原本没有 default；member-studio 的用户原文处理及职责 1～3 句写法未改 |

### 自动化与构建

| 检查 | 结果 |
| --- | --- |
| `pnpm test` | Vitest 243 文件、2,663 项通过；Node 340 项通过、2 项平台跳过；包含文档治理测试 |
| `cargo test --workspace -- --test-threads=4` | 462 项通过、1 项既有忽略 |
| `cargo test -p rovai-core --all-features context::slow_tests -- --test-threads=4` | 45 项通过；含 v32/v33 待物化兼容、冻结恢复、名单 ACK、10,000 字符身份与补发 |
| delivery_queue 既有 owner 组（all-features） | 25 项通过；完整上下文 FIFO 预算、显式预算覆盖和超大首条失败 |
| 成员与 Migration 定向 owner（all-features） | 6 项通过：成员读写/创建授权及原子性、路由迁移、旧结果保留、Bootstrap 迁移、版本准入矩阵 |
| `node --test scripts/lib/command-code-bootstrap.test.mjs` | 通过；长文本真实 JS hook 往返、正文超限及损坏绑定拒绝 |
| `pnpm typecheck`、`pnpm build:desktop` | 通过 |
| `pnpm docs:check`、`DOCS_BASE_REF=a8704823a219334ac73603bc6bfcc5c7dde16373 pnpm docs:check:ci` | 通过 |
| `node scripts/check-skills.mjs`、`git diff --check` | 通过 |

长度矩阵覆盖中文、四字节字符、组合字符、空白、换行/引号和 NUL JSON 转义；10,001 scalar 拒绝。
历史 Rust trim 保留的 FEFF 边界文字仍可读；`member update` 省略职责时保持旧字节，只有显式写入才应用新规范化。
Core 新会话测试使用 10,000 个 NUL，职责 JSON 实际膨胀为约 60 KiB，仍完整进入 Bootstrap 并在恢复时
逐字节保持。补发 owner 使用 10,000 个四字节字符，核验完整 overlay 和既有 revision ACK。
Command Code/Cline 文件测试跨过旧 32 KiB 正文界限；Command Code 两端对外层字节上限独立拒绝。

调试期间保留的失败已修复并定向复验：旧 v33 formatter 的断言漏项、版本 golden/迁移夹具未跟随准入、
图片临时路径不可作恒等断言。首次默认 Rust 并行运行还有一项进程清理时序失败，限制为 4 线程后完整通过。

### Rust 测试准入记录

| 新 owner | 修复前失败输入及不能复用的原因 | 最小命令 / 层级 |
| --- | --- | --- |
| `professional_responsibilities_use_trimmed_unicode_scalar_limits` | 原 Core 仅共享 300 限制，未有职责独立 trim/scalar owner；纯函数覆盖新边界，无需 SQLite | `cargo test -p rovai-core professional_responsibilities_use_trimmed_unicode_scalar_limits`；默认层 |
| `long_bootstrap_bindings_preserve_utf8_and_enforce_body_and_envelope_limits` | 两个 Adapter 的真实绑定文件都拒绝合法长身份；已有 JS hook owner 不覆盖 Rust 写入及 Cline 不可变文件 | `cargo test -p rovai-core long_bootstrap_bindings_preserve_utf8_and_enforce_body_and_envelope_limits`；临时文件默认层，无进程/数据库 |
| `routing_upgrade_preserves_frozen_evidence_and_rolls_back_atomically` | 新格式 DDL/receipt 回滚、旧 Blob 保留和损坏准入属于独立 migration；纯函数无法证明事务边界 | `cargo test -p rovai-core --features extended-tests routing_upgrade_preserves_frozen_evidence_and_rolls_back_atomically`；扩展层 |

其余矩阵扩展现有 owner，没有删除或永久禁用测试。真实模型验证使用单独 Smoke，不混入普通 Rust 测试。

### 真实投递记录与范围

可重复入口为 [smoke-member-routing.mjs](../../../scripts/smoke-member-routing.mjs)：参数是一个空的绝对
fixture 目录及 adapter kind。脚本建立隔离 Core/Skill Library/MCP，保存 10,000 scalar（39,580 UTF-8 bytes），
运行首轮、同 Session 热续接和 Core 重启后冷续接。详细摘要、模型、Run ID、accepted receipt 和本机证据目录
保存在 [member-routing-verification.json](member-routing-verification.json)。

| Runtime / 模式 | 实际版本 / 观测模型 | 结果 |
| --- | --- | --- |
| Codex CLI / NativeAppend | 0.162.1 / gpt-6.1-sol | 3 Run 通过；原生 Session/代次保持；原生 developer 文本 42,214 bytes，职责全文 SHA-256 与保存值、get 相同 |
| OpenCode / FirstPayload | 2.0.25 / sub2api/gpt-6.1-sol | 3 Run 通过；原生 Session/代次保持；get 全文摘要、首中尾标记及 accepted input 已验证 |
| Pi / ManagedSystemPrompt | 1.1.0 / sub2api/gpt-6.1-sol | 3 Run 通过；原生 Session/代次保持；get 全文摘要、首中尾标记及 accepted input 已验证 |
| Cline / ManagedSystemPrompt | macOS arm64 现有准入未通过 | 在创建真实 Run 前返回 `runtime_platform_not_qualified`；保持原准入规则；Rust 绑定文件验证通过 |
| Command Code / ManagedSystemPrompt | 未运行模型 | Rust 文件与 JS hook 验证通过；现有非公开准入未更改 |
| Claude Code、Grok Build / NativeAppend | 未运行 | 不从 Codex 推定通过 |
| Deepseek Harness / ManagedSystemPrompt | 未运行 | 不从 Pi 推定通过 |
| Copilot、Antigravity、ZCode、Kiro、Qoder、CodeBuddy、Qwen Code、TRAE、Cursor、Kimi / FirstPayload | 未运行 | 不从 OpenCode 推定通过 |

三条通过路径都是修改 peer 职责后继续同一原生会话，三个 Manifest 的名单投递标志均为 `1,0,0`。
Codex 有原生文本逐字节证据；OpenCode/Pi 本轮未取得独立原生完整文本，不能把标记复述等同于逐字节比对。
真实 compaction 尚未触发，长身份补发由 Core 集成测试覆盖。重启时出现隔离空附件 view 的完整性告警，
未阻断上述成员验收；不据此宣称附件流程也通过。Windows/Linux、打包安装和日常数据升级均未执行。

12 Case 的 `context-regression@2.12.0` 语义 Gate 为 **not_run / 证据不足**：本机未找到固定版本的真实
Judge 配置，已请求配置路径；未用 fixture Judge 或 CLI 模型目录冒充固定 snapshot。上述真实 Smoke 不是
基线/候选 Gate，也不能代替完整语义评价。后续使用既定 suite/rubric/预算 freeze 后运行，不改变评分标准。

### 修改文件清单

相对编码开始时的分支 HEAD，以下文件承载本次实现、契约与证据（不含生成构建目录）：

```text
CONTEXT.md
apps/desktop/src/renderer/src/MemberIdentityEditor.tsx
apps/desktop/src/renderer/src/locales/en.json
apps/desktop/src/renderer/src/member-identity-draft.test.ts
apps/desktop/src/renderer/src/member-identity-draft.ts
crates/rovai-core/src/agent_profile.rs
crates/rovai-core/src/bin/rovai.rs
crates/rovai-core/src/builtin_tool_cli_output.rs
crates/rovai-core/src/builtin_tool_transport.rs
crates/rovai-core/src/cline.rs
crates/rovai-core/src/command_code/bootstrap.mjs
crates/rovai-core/src/command_code_acp.rs
crates/rovai-core/src/compaction.rs
crates/rovai-core/src/context.rs
crates/rovai-core/src/context_contract.rs
crates/rovai-core/src/context_delivery.rs
crates/rovai-core/src/db.rs
crates/rovai-core/src/db_member_routing.rs
crates/rovai-core/src/db_simplification.rs
crates/rovai-core/src/delivery_queue.rs
crates/rovai-core/src/member_studio.rs
crates/rovai-core/src/member_tool.rs
crates/rovai-core/src/team_tool.rs
crates/rovai-core/src/team_tool_catalog.rs
crates/rovai-core/tests/fixtures/builtin-tool-agent-output-v11.json
docs/README.md
docs/architecture/builtin-tool-runtime.md
docs/architecture/foundational-invariants.md
docs/architecture/native-session-bootstrap-redelivery.md
docs/contracts/README.md
docs/contracts/builtin-tool-transport-v39.md
docs/contracts/collaboration-state-v4.md
docs/contracts/context-delivery-profile-v11.md
docs/contracts/context-manifest-evidence-v34.md
docs/decisions/CURRENT.md
docs/ui/components/member-identity.md
docs/versions/v1.72/README.md
docs/versions/v1.72/decisions.md
docs/versions/v1.72/member-routing-verification.json
docs/versions/v1.72/model-context-change-member-routing.md
packages/contracts/src/index.ts
scripts/benchmark/protocol/product-contract.test.mjs
scripts/lib/command-code-bootstrap.test.mjs
scripts/smoke-member-routing.mjs
skills/cli-operations/SKILL.md
skills/member-studio/references/identity-generation.md
```
