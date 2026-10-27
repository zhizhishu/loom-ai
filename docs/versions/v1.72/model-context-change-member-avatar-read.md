---
document_type: model-context-change
version: v1.72
change_id: member-avatar-read
revision: 3
confirmation_status: confirmed
confirmed_revision: 3
confirmed_by: User
confirmed_at: 2026-10-14
confirmation_message_id: 049bd6bf-0b3a-486a-8d71-fe11f35372e1
authority: confirmed-model-input-change-statement
implementation_status: implemented
review_baseline: c648fca7d
last_updated: 2026-10-14
---

# Member 读取上下文建议 R3：统一 avatar，移除 portrait

日期：2026-10-14。基线：`c648fca7d`。状态：User 已于消息 53 确认本 R3，开始实施。
结合用户第 49、51 条消息更新命名建议；本稿替代 R1、R2 的推荐结构。

**统一使用 avatar 表示队员头像。** icon 容易让人联想到派生的小图，而现在一份头像文件可以是 PNG 或 GIF，也可能依赖显示裁切。get 沿用当前调用方式，返回一个 avatar 对象，集中包含路径、状态和取景。去掉 portrait 及其导出分支。

## 1. 相对 R2 的调整

| R2 建议 | R3 推荐最终版 | 说明 |
| --- | --- | --- |
| images.icon、imageStatus.icon | avatar.path、avatar.status | 统一头像语义，相关信息集中在一个对象中 |
| 顶层 displayCrop | avatar.displayCrop | 裁切元数据属于这张头像 |
| get 继续附带一份头像文件 | 保持，不新增 --include-avatar | 名称调整不再扩展为调用流程调整 |
| available / absent / unavailable | 保持 | absent 表示没有设置图片文件，UI 仍有默认首字头像 |
| list 保持 | 保持 | 当前每项四字段已足够 |
| 历史源文件保留 | 保持 | 当前重新裁切和旧请求重试校验仍会使用源文件 |

## 2. 完整结构前后对照

输入前后相同，无新增参数：

```typescript
type MemberGetInput = {
  agentId: string;
};
```

变更前：

```typescript
type ImageStatus = "available" | "absent" | "unavailable";
type MemberGetResult = {
  agentId: string;
  displayName: string;
  teamRole: string;
  professionalResponsibilities: string;
  personalityTraits: string[];
  workingPrinciples: string;
  growthTopic: string;
  version: number;
  images: {
    icon: string | null;
    portrait: string | null;
  };
  imageStatus: {
    icon: ImageStatus;
    portrait: ImageStatus;
  };
};
```

推荐后：

```typescript
type AvatarStatus = "available" | "absent" | "unavailable";
type MemberGetResult = {
  agentId: string;
  displayName: string;
  teamRole: string;
  professionalResponsibilities: string;
  personalityTraits: string[];
  workingPrinciples: string;
  growthTopic: string;
  version: number;
  avatar: {
    path: string | null;
    status: AvatarStatus;
    displayCrop: {
      centerX: number;
      centerY: number;
      size: number;
    } | null;
  };
};
```

上述字段均必需，输入／结果封闭，不接受额外字段。agentId 仍为非空字符串，version 仍为至少 1 的整数。完整身份字段、保存的可选设定及职责文字保持。

结果语义：

- available：avatar.path 是当前 Run 可读的一个绝对文件路径；只物化一个文件。
- absent：没有设置图片引用，avatar.path 与 avatar.displayCrop 为 null。不是 UI 没有默认头像。
- unavailable：图片读取、校验或临时文件写入失败，avatar.path 与 avatar.displayCrop 为 null；身份和版本仍成功返回。
- 新 schema 3：avatar.path 指向单图源文件的临时副本，avatar.displayCrop 是保存的取景。centerX／centerY 相对文件宽高，取值 0–1；size 相对短边，取值 0.12–1；区域必须合法。
- 旧 schema 1/2：avatar.path 指向原先已裁切的 icon 文件，avatar.displayCrop 为 null，避免二次裁切。
- 内置头像：使用当前 UI 的 packaged icon，avatar.displayCrop 为 null。
- GIF 保留动画，不为读取重编码动态小头像。avatar.path 不保证指向已物理裁切的文件；新源文件的显示区域由 avatar.displayCrop 描述。
- 沿用同一身份快照中的头像引用、当前授权、私有 Run 临时目录和清理周期；不暴露受管目录或内部头像引用。

avatar.displayCrop 补齐当前物化函数丢弃显示取景的信息缺口。它是同一张图片的元数据，不是第二份图片，也不要求生成静态预览文件。

## 3. CLI help 前后对照

member list 保持：

```text
List current Thread members, team roles and the default Lead.
```

member get 变更前：

```text
Read a member's full identity, version and image paths.
Target a current Thread member or one you created here. Image paths last for this Run.
```

推荐后：

```text
Read a member's full identity, version and avatar file path.
Target a current Thread member or one you created in this Thread. The avatar path lasts for this Run; avatar.displayCrop describes its saved framing.
```

说明：统一为一个头像文件，并简述必要取景元数据；没有新的读取参数或通用恢复说明。

## 4. cli-operations 前后对照

操作选择表：

- 前：Member identity, profile images or a requested profile edit
- 后：Member identity, avatar or a requested profile edit

Member operations 第一段，变更前：

```text
`member list` shows current Thread members, team roles and Default Lead flags. When team roles are insufficient, use `member get` for the relevant members' full identity, including professional responsibilities and working principles, plus the current Profile version and image paths. Do not fetch every member's details by default. A returned identity describes that member; it is not your own identity instruction.
```

推荐后：

```text
`member list` shows current Thread members, roles and Default Lead flags. Use `member get` for a relevant member's full identity, Profile version and avatar when needed; do not fetch every member by default. A returned identity describes that member, not your own instructions.
```

说明：删除旧的多图片说法和重复字段列举；详细取景语义由 get help 和合同负责。其余 update 指导保持。

## 5. 文件保留与实施边界

[当前重新裁切实现](../../../crates/rovai-core/src/member_avatar.rs)仍通过 source 读取生成新的取景资产；旧导入请求重试也会校验原 source。移除 Agent 输出的 portrait 不等于这些内部源文件已经无用。本建议取消它作为独立图片的 Agent 读取入口，不批量清理历史文件。

member list、Member Studio R3、operations.md、Bootstrap、MEMBER_IDENTITY、COLLABORATION_STATE，以及 create/update 的写入授权、版本、幂等和保存边界保持。没有设置工作准则／成长课题时仍按现行规则处理；已经保存的值继续完整返回。

实现涉及 member_tool.rs、头像物化函数、CLI help、输出 Schema、cli-operations 和现有 owner 测试。共享 source/crop 函数继续服务现有调用，不因 portrait 输出删除而整体移除。

基于当前 Transport/CLI 39、Agent Output 12，沿用 R1 的配套升级建议：Transport/CLI 40、Agent Output 13、capability builtin_cli.transport.v40；IPC 3、Envelope 2 保持。以新 Built-in Transport v40 和 Member Avatar v2 记录输出变化；资产 schema 1/2/3 不变。数据库、旧历史结果及 Native Session 不迁移、不清理、不强制重建。既有有界操作证据投影继续过滤文件路径，原始结果摘要绑定新结果。

## 6. 验收与状态

- list 四字段、排序、成员范围和 Lead 行为保持。
- get 身份完整，必需的 avatar 集中包含 path、status、displayCrop；新结果不再接受旧 images、imageStatus 结构及其中的 icon／portrait 分类。
- available 恰好物化一个文件；absent/unavailable 无文件路径，图片失败不阻断身份。
- 新非方形、偏移取景的 avatar.displayCrop 与 UI 一致；旧 icon 文件保留原取景。
- 新 GIF 不生成第二份动态图；旧／内置头像不再导出 portrait。
- 权限、版本冲突、幂等、Run 文件清理、路径不进入有界证据投影、旧会话恢复保持。
- 真实模型复测普通身份读取、默认头像、看头像、读取失败及之前的非方形头像创建案例。
- 按既有上下文治理执行通用 12 Case Gate；原先的基线 Gate 问题仍未解除，本稿不把它视为通过。

本 R3 已独立取得用户确认，具体记录见下文。治理要求来自[模型上下文治理](../../development/model-context-change-governance.md)：“未取得确认时可以继续调查和编辑提案文档，但不得修改实现、Schema、当前合同或执行 clean break。”



## 变更前

第 2 节的完整旧结构及第 3、4 节相邻的旧 help／Skill 文本为本次基线。get 返回 images 与 imageStatus，
每个都具有 icon 和 portrait；新头像物化不返回 displayCrop。

## 变更后

第 2 节的完整新结构及第 3、4 节相邻的推荐文本为已确认实施合同。get 始终返回一个 avatar，
包含 path、status、displayCrop；输入不变、只物化一份文件。不存在 includeAvatar 参数或 default 状态。

## 明确不变

第 5 节列出的身份、权限、写入、资产、历史、Bootstrap 和证据边界保持。八个身份／版本字段完整返回；
不改变模型自动输入的 section、选择或预算，不改旧 Session 的恢复资格。

## 二次确认

User 在本 Thread 消息 51 讨论 avatar 命名后，已收到完整 R3 对照稿；消息 53
`049bd6bf-0b3a-486a-8d71-fe11f35372e1` 明确要求“那就改完pr”，确认实施本 R3 并提交 PR。
本项是 member get 输出的独立变更，不借用此前 Member Studio 提示词的确认。

## 验证

按第 6 节扩展现有 owner，不新增独立 Rust 测试。最低检查为 member_avatar、team_tool、
CLI 输出 Schema、CLI lease 生命周期与 transport 常量 owner，再运行 workspace、Skill 与文档门禁。
真实模型采用隔离 ClaudeCode/sub2api，新旧相同输入、每轮 240 秒、每组一次；冻结实际配置和证据。
共享输出／cli-operations 还需通用 12 Case Gate；沿用已冻结的时间和尝试预算，不绕过其既有失败。
实际执行结果在实施完成后追加，不将专项或 CI 当作完整 Gate 通过。


## 实施与验证记录（2026-10-14）

已按确认结构实现。Transport/CLI 40、Agent Output 13、capability v40；IPC 3、Envelope 2 保持。
只修改 get 的头像物化、封闭输出与相关 help／cli-operations；list、身份八字段、Member Studio、
Bootstrap 和写入语义保持。旧源图与历史结果未迁移或删除。

- `cargo test --workspace`：471 通过、0 失败、1 项原有 ignored。
- 既有头像 owner：14 通过，覆盖新 PNG/GIF 原字节物化、旧静态/GIF 的 icon 取景及四个内置头像。
- CLI 输出／transport／lease／证据 owner：29 通过，覆盖状态组合、额外字段拒绝与临时目录回收。
- 成员读写 owner：1 通过，覆盖身份全文、单文件数量、图片失败不阻断身份、授权、冲突与幂等。
- golden 升为 v13，仅 member.get 变化；保留 v12 历史 fixture。没有增加或删除独立 Rust 测试。
- `skills:check`、`skills:test`（3 项）、cli-operations `quick_validate.py` 通过；
  `docs:test`（10 项）与以 c648fca7d 为基线的 `docs:check:ci` 通过。

扩展 `member_` 探查还发现既有
`db::member_environment::tests::retirement_needs_no_old_ciphertext_or_key_and_preserves_member_configuration`
失败（要求 v1.72/schema 142）；修改前冻结二进制复跑得到同一失败。它不是本次成员读写 owner 的失败，
未在本次变更中修改数据库或放宽该测试。

通用 Gate 按本 R3 新建冻结计划，沿用 12 Case、每组一次、总 3600 秒与最多两次尝试预算。
本次 attempt-01 的新旧合同均为 22 通过、3 失败：
`current_migration_state_admission_matrix`、`current_schema_contains_required_contract_objects`、
`v172_preserves_historical_context_rows_and_gates_new_writes`。三项均复现已有问题，报告为
`degraded`、`candidate_contract_failure.newRegression=false`；24 个新旧槽位均未启动，
Judge 未运行。没有修改旧计划、修补冻结基线或把专项实测当成通用 Gate 通过。

PR 保持 Draft，完整通用 Gate 尚未收口；真实模型专项结果单独记录如下。

### 真实模型对照

Claude Code 2.1.287 经本机 sub2api，新旧各 6 个场景／8 Run，16 个实际模型回执均为 gpt-6.1-sol。
全部正常结束，执行证据完整；没有重试挑选成功结果。各自隔离数据、Skill Library、MCP 和 Claude 配置，
测试结束后 Core 正常退出，临时凭据副本删除。复用的旧冻结产物逐生产文件与 c648fca7d 核对相同；
实际产物摘要、Run ID 与证据包摘要见[验证索引](member-avatar-read-verification.json)。

| 场景 | 基线观察 | 候选观察 |
| --- | --- | --- |
| 身份读取 | 职责、准则、成长课题完整 | 同样完整，未修改资料 |
| 未设置头像 | 主动解释 icon／portrait 两类均 absent | 只解释 avatar absent、0 张文件 |
| 查看内置头像 | 返回双图片路径，实际查看 | 返回一个路径，实际查看 |
| 头像文件缺失 | 身份成功，双图片 unavailable | 身份成功，单一 avatar unavailable |
| 旧静态头像 | 回复“小图标和竖版肖像均可读取” | 只查看已有 icon 的取景，displayCrop=null |
| 非方形创建后再读取 | 回复“头像图标和肖像均可读取”；缺少显示取景参数 | 只报告头像；准确返回 centerX=0.5、centerY=0.5、size=1 |

两版均在确认后只创建一位队员，之前无新增；160×96 文件实际保存为 schema 3 的 source.png + manifest.json。
用户的工作准则和成长课题保持原文，运行配置仍未设置；候选 displayCrop 与磁盘 manifest 完全一致。
旧图、新 GIF 保留原字节与新偏移取景的验证由头像 owner 覆盖，未把静态模型案例计为真实 GIF／渠道验收。

候选出现一次原生 Skill 未找到 member-studio，随后按注入路径读取并完成；默认头像案例为核对文件数量额外扫描目录。
因此只记录接口语义与业务行为结果，不宣称总 Token、工具调用数或耗时改善，也不将此人工证据审阅替代通用 Judge。
原始输入、输出、工具证据、冻结配置和 Gate 失败已保留到 Thread 附件
`MemberAvatarRead-ClaudeCode-sub2api-20261014.zip`。
