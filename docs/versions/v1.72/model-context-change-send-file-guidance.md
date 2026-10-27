---
document_type: model-context-change
version: v1.72
change_id: send-file-guidance
revision: 3
confirmation_status: confirmed
confirmed_revision: 3
confirmed_by: User
confirmed_at: 2026-10-16T09:33:29Z
confirmation_source: "Thread rvcamp_01m51tzyg3emhrkdf78r95pzgt message 19 (b27e38e9-8345-4198-bf97-6b47223395dc)"
implementation_status: implemented
source_commit: 3979e32ec4834ce5fc02cd72309bbd7b5cd800c6
last_updated: 2026-10-16
---

# Send 文件引用、临时正文清理与渠道提示：R3

本稿记录 User 已确认的 R3 精确上下文差异，实施按以下文本与边界进行。
需求来自 Thread `rvcamp_01m51tzyg3emhrkdf78r95pzgt` 消息 5
（`2321c468-93a1-45c8-86eb-9c470dcf6536`）；R2 按消息 7
（`2c1b26d5-f7c8-43ad-bd56-7473ee815568`）精简附件帮助，并明确临时正文文件名仅为示例。
R3 根据消息 11（`a64238d5-017c-4ce4-8966-6f874e833b42`）和消息 13
（`1c49f3de-ebed-44d7-b12e-07c51cf90fec`）的审阅问题，提出删除归档句、优先直接发送单行 Markdown，
并展示完整 CLI help；User 在消息 19 明确确认实施并授权创建 PR、合入 main。

## 选择与冲突处理

- 简单单行正文（包括 Markdown）使用 `--body`；多行或复杂正文再使用临时输入文件。
- 临时正文清理只作用于 Agent 自己创建、用途仅为消息输入的临时文件，并以发送成功为前提。
- 普通文件引用默认使用显式 Markdown 链接；用户要求附件，或外部渠道需要交付文件本身时使用 `--file`。
- 通用帮助不单独增加归档规则；用默认 Markdown 引用引导减少普通消息的附件交付，渠道格式限制仍按既有能力处理。
- 飞书、Lark、钉钉共用已有渠道提示正文，只扩展注入条件；不增加渠道名称列表或客户端类型字段给模型。
- 操作细节集中到 `send --help`；删除 Send reference 的重复 Files 段，沿用其第一行已有的 exact-help 入口。

“文件引用”和“文件交付”的适用条件在同一句中给出，不依赖两条互相覆盖的绝对指令。
即使用户从 Desktop/WebUI 打开已绑定渠道的 Thread，交付文件本身仍按渠道规则使用 `--file`。
`send` 成功只证明消息提交，不证明渠道已完成后续上传；附件源文件必须继续保留。

| 场景 | 预期行为 |
| --- | --- |
| 简单单行 Markdown 正文 | 直接用 `--body`，无需为了 Markdown 本身创建临时正文文件 |
| 多行或复杂正文 | 写入临时正文文件，通过 `--input-file` 读取正文 |
| Desktop/WebUI/MobileUI 指向已有代码、报告或生成文件 | Markdown 文件链接；文件继续保留 |
| 用户明确要求附件 | `--file`，允许同时在正文解释文件 |
| 任一已绑定渠道的收件人需要文件本身 | `--file`；仅贴本地链接不能完成交付 |
| 渠道中的普通进度说明或代码路径引用 | 普通正文；不会因“有渠道”就自动附加文件 |
| 自建临时正文发送成功 | 删除仅用于消息输入的临时文件 |
| 发送失败、结果不明、现有文档、已链接或已附加的文件 | 不因本清理规则删除；继续按现有恢复和文件生命周期处理 |

## 上下文入口

| 入口 | 本稿变化 |
| --- | --- |
| `camp_message_send_teaching.rs` 的 BODY_HELP | 明确单行 Markdown 可用 `--body`，文件输入仅用于多行或复杂正文；追加成功后清理 |
| 同文件 FILE_HELP | 仅保留文件选择、文件/目录与重复参数用法 |
| 同文件 HELP_EXAMPLES | 首例直接发送 Markdown 链接；原首例移为多行正文次例，注明临时示例文件名；共四例 |
| `cli-operations/references/send.md` | 删除末尾 Files 段；其余全文不变 |
| `context.rs` 的渠道 Charter 后缀 | 正文逐字不变，active binding 准入从飞书扩到三个现有 provider |
| 公共 Charter 主文、Single Chat、Mission 后缀、其他 Skill、Runtime 专属指导 | 不变 |

## 变更前

下列块分别是受影响的完整正文帮助、附件帮助、首个示例、Send reference 删除段和渠道后缀。
源码位置见 [Send teaching](../../../crates/rovai-core/src/camp_message_send_teaching.rs)、
[Send reference](../../../skills/cli-operations/references/send.md)、
[Context](../../../crates/rovai-core/src/context.rs)。

### 正文帮助

```text
Use --body for simple single-line text; \n remains literal.
For multiline, Markdown, or complex text, use a file-write tool to write the reply text itself, with real newlines, to a UTF-8 file.
```

### 附件帮助

```text
Attach a recipient-facing file or directory at its actual path; repeat to preserve attachment order. Rovai references the current file without copying or changing permissions. Temporary files may become unavailable when their source is cleaned up.
```

### 首个普通发送示例

```text
Write reply.md:
  Result:

  Updated `src/example.rs`.
After the write succeeds:
  rovai send --public-only --input-file reply.md
```

### Send reference 末尾重复段

```markdown
## Files

Use `--file <path>` to publish a file or directory with the message; repeat it to preserve attachment order. No separate upload is required. At least one file can form a message without a body.
```

### 渠道 Charter 后缀及条件

新公共 Session Bootstrap：Camp 存在 `status = 'active'` 且 `provider = 'feishu'` 的绑定时，
在现有 CLI Charter 后、可选 Mission 后缀前追加以下一条；其他 provider、closed 或未绑定不追加。
Single Chat 仍使用专用 Charter，不追加。

```text
- This Thread is connected to an external channel. Local file paths and Runtime image previews are not delivered there; when the recipient needs the file itself, include `--file <path>` in the corresponding `rovai send` message.
```

## 变更后

### 正文帮助

```text
Use --body for simple single-line text, including Markdown; \n remains literal.
For multiline or complex text, use a file-write tool to write the reply text itself, with real newlines, to a UTF-8 file.
After a successful send, delete files you created solely as temporary input for that send.
```

去掉“所有 Markdown 都先写文件”的引导，与下面直接发送 Markdown 的首例一致。
`solely as temporary input for that send` 将清理限定为本次发送，排除正文引用目标、附件、用户已有文档以及同时承担其他用途的文件。
这是 Agent 清理教学，不给 CLI 增加自动删除行为、目录限制或新选项。

### 附件帮助

```text
Prefer Markdown file links; use --file for requested attachments or channel file delivery. --file accepts files or directories; repeat for multiple attachments.
```

第一句同时给出默认方式和附件适用条件。帮助只保留选择规则与必要用法，删除复制、权限和源文件保留说明；
实际原路径引用语义不变。清理范围已由正文帮助中的 `solely as temporary input for that send` 限定，
无需再为交付文件重复增加保留指令。路径可访问、预览类型、相对路径基准仍由现有文件预览实现决定。
R3 删除 R2 的 `Archive only when requested or required for delivery.`，通用帮助不再要求模型另行判断归档条件。

### 普通发送示例

第一例直接发送带 Markdown 文件链接的单行正文：

```text
rovai send --public-only --body 'Updated [src/example.rs](src/example.rs).'
```

第二例保留多行正文的临时文件写法：

```text
Write a temporary body file (e.g. reply.md):
  Result:

  Updated [src/example.rs](src/example.rs).
After the write succeeds:
  rovai send --public-only --input-file reply.md
```

`e.g.` 表明 `reply.md` 只是示例文件名，不增加固定命名要求。
仍保留“写入成功后再发送”，清理规则只在正文帮助中说明一次。总示例数由三改为四，其余两个寻址示例逐字不变：

```text
rovai send --to agent_5 --body 'Please reproduce on the previous client build and return the version and result.'
rovai send --public-only --to-user --body 'Please choose whether to roll back the client or continue the token investigation.'
```

### Send reference

仅删除变更前的整个 `## Files` 段，不新增替代段。文件止于现有句子：

```text
A successful Send proves publication and its frozen effects, not that a recipient has started or finished.
```

第一行原有 `Read rovai send --help for current inputs.` 的 Markdown 写法及其他正文逐字不变。
纯附件消息仍受原 Schema 和 Core 支持；本稿只移除重复操作教学。

### 渠道 Charter 后缀及条件

新公共 Session Bootstrap：Camp 存在 `status = 'active'` 且 provider 属于
`feishu | lark | dingtalk` 的绑定时，在原位置追加同一条。Single Chat、closed、未绑定和未知 provider 不追加。
Quick Chat/项目会话共用 Camp 级判断，不根据当前使用 Desktop、WebUI 或 MobileUI 分支。

```text
- This Thread is connected to an external channel. Local file paths and Runtime image previews are not delivered there; when the recipient needs the file itself, include `--file <path>` in the corresponding `rovai send` message.
```

| 新 Bootstrap 来源 | 变更前 | 变更后 |
| --- | --- | --- |
| active 飞书绑定 | 追加一条 | 追加同一条 |
| active Lark 绑定 | 不追加 | 追加同一条 |
| active 钉钉绑定 | 不追加 | 追加同一条 |
| closed/无绑定/未知 provider | 不追加 | 不追加 |
| Single Chat | 不追加 | 不追加 |

三个渠道的追加正文完全一致；Lark/钉钉的文件外发能力本来就存在，本稿不修改外发协议。

## 审阅用完整 `rovai send --help`

下列为 R3 实施后的完整帮助草案；由本次实际 CLI 输出仅替换上述正文帮助、附件帮助和示例构成。
Markdown 是正文格式；`--body` 和 `--input-file` 是输入方式；`--file` 才是附件交付。

```text
rovai send
Publish one public Thread message. Use --public-only when the message must not address any Agent; it prevents Agent addressing, creates no Agent Delivery, and wakes no Agent. Without --public-only, --to may schedule Agents. Agent addressing schedules concrete continuing work, not CC; never use it for acknowledgement, agreement, thanks, closure, standby, no-new-information, or repeated conclusions. Ordinary public messages are already visible to the User. Use --to-user only for a new unresolved User decision, answer, or action, or an explicitly requested important-result notification. Always inspect agentAddressingMode, effectiveRecipients, and deliveryIds. A successful send proves only that its message and effects were committed; it does not prove recipient work has started or completed.

Input: direct flags, or --input-file <path> with send flags except --body.

  --body                       field=body type=string
      Use --body for simple single-line text, including Markdown; \n remains literal.
      For multiline or complex text, use a file-write tool to write the reply text itself, with real newlines, to a UTF-8 file.
      After a successful send, delete files you created solely as temporary input for that send.
  --file                       field=files type=array repeatable
      Prefer Markdown file links; use --file for requested attachments or channel file delivery. --file accepts files or directories; repeat for multiple attachments.
  --to-user                    field=mentionUser type=boolean
      Mention the User and create an Inbox notification.

      Ordinary public Thread messages are already visible to the User. Use this flag only when the message creates a new unresolved decision, answer, or action for the User, or when the User explicitly requested notification of an important result.

      It creates no Agent Delivery, does not represent approval, and may be combined with --public-only. User attention is message-local and is never inherited by replies, Tasks, or downstream A2A work.
  --public-only                field=publicOnly type=boolean
      Guarantee that this public message wakes no Agent.

      effectiveRecipients and deliveryIds are empty, and no Agent Delivery is created.

      Do not combine this option with --to or --task-id. It may be combined with --to-user.
  --task-id                    field=taskId type=string
  --to                         field=to type=array repeatable
      Explicit Agent recipient to wake; repeat as needed.
      Agent addressing schedules concrete continuing work, not CC.
      Do not use it for acknowledgement, agreement, thanks, closure, standby, no-new-information, or a repeated conclusion.
      This option is invalid with --public-only.

Examples:
  rovai send --public-only --body 'Updated [src/example.rs](src/example.rs).'
  Write a temporary body file (e.g. reply.md):
    Result:

    Updated [src/example.rs](src/example.rs).
  After the write succeeds:
    rovai send --public-only --input-file reply.md
  rovai send --to agent_5 --body 'Please reproduce on the previous client build and return the version and result.'
  rovai send --public-only --to-user --body 'Please choose whether to roll back the client or continue the token investigation.'
```

## 明确不变

- 不增加 `RUN_INPUT`、`RUN_FACTS` 或其他动态字段；不把渠道来源推断交给模型。
- `SESSION_CHARTER` 公共主文、身份、Memory、平台 Skill 索引、Single Chat 和 Mission 后缀不改。
- `--body`、`--input-file` 的正文/合法旧 JSON 请求兼容、32 KiB 正文限制、输入来源和真实换行语义不改。
- `--file` 仍是原路径引用，文件/目录、顺序、权限、生命周期和外部渠道 Outbox/重试规则不改。
- `--public-only`、`--to`、`--to-user`、Task、消息事务、发送回执和幂等/不确定结果处理不改。
- Bootstrap 冻结与恢复、动态 section 顺序、消息选择、预算、既有证据身份和 Native Binding 兼容轴不改。
- 不新增 TMP 目录硬约束、归档工具、自动压缩、正文扫描自动附件或 CLI 自动删文件。

## 版本轴、合同与兼容

| 项目 | R3 计划 |
| --- | --- |
| 当前产品版本 | 沿用版本索引的 v1.72 |
| Session Charter revision | 22 → 23，记录渠道后缀准入扩展 |
| Bootstrap contract / formatter | v5 / 5 不变 |
| Native Binding compatibility | 保持现有 4 / 4 / 16 / 26 / 26；不强制轮换会话 |
| public Context formatter / manifest / profile / facts | 39 / 39 / 14 / 10 不变 |
| non-batch Context formatter / manifest / profile / facts | 37 / 37 / 12 / 6 不变 |
| Transport / CLI / Agent Output / IPC / Envelope | 41 / 41 / 14 / 3 / 2 不变；本次 help 常量不参与输入/输出 Schema |
| 当前规范同步 | 实施时以 Send v27 为基线承接新教学，更新 Built-in Tool Runtime 的注入条件与 Lark 当前合同第 7 节；版本号按实施基线核对，不能继续保留“Lark 不注入”作为当前规范 |
| 数据迁移 | 无；历史消息、Manifest、Bootstrap Blob 和 receipt 不重写 |

新 Bootstrap 使用本稿条件，旧 Binding 继续使用自己的冻结 Charter。旧 Lark/钉钉 Session 不会立即获得新后缀；
下一次正常创建 Binding 时生效，不以本次教学调整中断正在运行的会话。CLI help 和 managed Skill 在后续读取时更新；
不承诺模型主动重读已缓存帮助。回滚恢复相应 help/Skill/条件与版本，已进入原生历史的教学不能撤销。

## 验证

提案阶段只验证文本与当前源码对应关系、文件链接和文档结构；实施验证结果另行追加，不重写已确认文本。

实施后复用现有测试 owner，优先扩展已有矩阵；新增/删除 Rust 测试前遵循
[测试准入规则](../../development/testing.md#rust-测试准入与退役门槛)：

1. Send help：完整文本、单行 Markdown 的 `--body` 引导及首例、临时正文清理及多行次例、总计四例和两个寻址示例保持；
   命令检查使用 `cargo test -p rovai-core --lib camp_message_send_teaching::tests::` 与
   `cargo test -p rovai-core --bin rovai`。
2. CLI 文件输入：使用 `pnpm test:send-input-file` 确认正文保真及 CLI 不删除输入，避免把 Agent 教学实现成破坏性 CLI 行为。
3. Context：扩展现有 provider × Quick Chat/项目 × active/closed 矩阵；三 provider active 各追加一次，
   inactive/无绑定/未知 provider/Single Chat 不追加。既有 Bootstrap 不因绑定创建、关闭或实现升级被重写。
4. 文案与选择：检查单行 Markdown 无需临时正文文件、普通引用无需附件/ZIP、请求附件与渠道文件交付仍可用；
   临时输入清理不能删除交付目标，失败与未知结果不能视为成功。删除归档句不代表实现了自动打包限制。
5. 文档/Skill：`pnpm docs:test`、`pnpm docs:check`、`DOCS_BASE_REF=<实际 base SHA> pnpm docs:check:ci`、`pnpm skills:check`。

本稿同时改变共享 help、`cli-operations` reference 与 Bootstrap 选择，实施后按
[上下文改动 Gate](../../development/evaluation.md#上下文改动-gate)使用通用集：
基线为本稿 source commit，Suite `context-regression@2.12.0` 的 DEMO-101 至 DEMO-112 全部 12 Case，
baseline/candidate 各一次 repetition，使用相同明确冻结的既有 Runtime、模型、权限和 Judge 配置。
计划预算为每 campaign 14,400 秒、Judge 2,400 秒、并行 Case 最多 2、同一 campaign 尝试最多 2 次。
实际模型/Judge 与完整 plan 在执行前冻结；本次文本审阅不启动该评测。
通过条件沿用同一 Suite 的硬性规则、关键协作项及语义 Judge 门槛，未知保持未知，不以模拟、缺失 Case 或 `judge: null` 声称完整通过。
通用集不替代以上渠道矩阵与本次文件选择边界；真实外部平台交付也不能由 Context fixture 冒充。

## 二次确认

状态：User 在消息 19（`b27e38e9-8345-4198-bf97-6b47223395dc`）明确确认 R3：
“没问题，开启wt开始实现，实现完pr到mian merge”。确认前已在消息 18 提供逐项完整前后对照。
记录时间为 2026-10-16T09:33:29Z；沿用既有 worktree，实施后创建 PR 并按门禁合入 main。
依据是[核心模型上下文变更治理](../../development/model-context-change-governance.md)中的：
“未取得确认时可以继续调查和编辑提案文档，但不得修改实现、Schema、当前合同或执行 clean break。”

Front Matter 已记录 `confirmed_by`、`confirmed_at`、`confirmed_revision: 3` 与来源消息。
确认的前后文案保持不变；若实施改变方案语义，则递增 revision 并重新审阅。

## 工作记录

- Work item：Send 文件教学及三渠道 Charter 的 R3 前后对照和完整 help。
- Worktree：`/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-send-file-guidance`。
- Branch：`rovai/send-file-guidance`。
- Base：`origin/main@3979e32ec4834ce5fc02cd72309bbd7b5cd800c6`；已 fetch 并核对与本次审阅源码一致。
- Governance：R3 已由 User 消息 19 确认；无要求先合入 main 的独立治理提交。
- Status：ready，R3 已实施；User 消息 22 已接受通用 Gate 的验证限制并授权合并 PR #780。
- R1 Validation：正文/附件帮助、首例、删除段及渠道原文逐字匹配源码；`git diff --cached --check` 通过。
  `node --test scripts/lib/doc-decisions.test.mjs` 10/10 通过；带真实 base 的
  `node scripts/check-doc-decisions.mjs --require-base` 通过。
  `pnpm docs:check` 与 `pnpm docs:check:ci` 均只因本稿缺少四项二次确认记录而未通过，符合待审阅状态。
  初次并行 `pnpm` 调用触发依赖自动安装，其中 `docs:test` 启动因安装竞争失败；已用上述相同 Node 测试入口完成验证。
  不宣称产品实现或模型行为已通过。
- R2：附件帮助删除实现说明与重复保留指令；首例用 `e.g.` 明确示例文件名；临时正文清理及渠道规则保持不变。
- R2 Validation：`git diff --check` 通过；`pnpm docs:test` 10/10 通过；带上述真实 base 的
  `node scripts/check-doc-decisions.mjs --require-base` 通过。
  `pnpm docs:check` 与 `pnpm docs:check:ci` 仍仅因本稿缺少四项二次确认记录而未通过。
- R3：删除归档句；明确单行 Markdown 可用 `--body`，将直接发送链接移为首例，临时正文移为第二例；追加完整 help 供审阅。
- R3 Validation：完整 help 与实际 CLI 输出仅作三处已声明替换后的结果逐字一致，四个示例已核对；
  `git diff --check`、`pnpm docs:test`（10/10）及带上述真实 base 的
  `node scripts/check-doc-decisions.mjs --require-base` 通过。
  `pnpm docs:check` 与 `pnpm docs:check:ci` 仍仅因本稿缺少四项二次确认记录而未通过。
- Next：同步主线并通过必要检查后合并 PR #780，再清理 worktree。

## 实施与验证记录（2026-10-16）

已逐字实现 R3 的 BODY_HELP、FILE_HELP 和四个示例；编译后的完整 `rovai send --help`
与本稿审阅块逐字一致。Send reference 仅删除末尾 Files 段；共享 Charter、Single Chat 模板与渠道提示
原文均与基线逐字相同。渠道选择扩到三个 provider，Charter revision 为 23，其余版本轴及冻结边界保持。
当前 Send v27、Lark v1、Architecture 和版本入口已同步；无迁移、自动删除或新增归档行为。

复用现有 Rust owner，没有新增、删除或忽略测试：

- `pnpm test:rust:pr`：473 项通过、0 失败、1 项原有 ignored，包含 CLI 的 31 项测试。
- `pnpm test:send-input-file`：1 项进程回归通过，正文输入与 CLI 不自动删除的边界保持。
- `session_charter_publishes_one_cli_only_builtin_contract`：三渠道 × 两种 Thread scope × active/closed，
  加未知 provider、无绑定与 Single Chat 负向检查通过。
- `newly_bound_session_bootstraps_on_its_current_generation` 与
  `replacement_binding_bootstrap_keeps_history_on_demand_after_the_accepted_watermark`：各 1 项通过。
  三个 Context owner 均显式使用 `--features slow-tests --lib`，没有把零测试命中算作通过。
- `cargo fmt --all --check`、`git diff --check`、`pnpm docs:test`（10 项）、
  带真实 base 的 `pnpm docs:check:ci` 与 `pnpm skills:check` 通过。

通用 Gate 使用冻结的 `context-regression@2.12.0`、12 Case、新旧各一次与原定预算。
attempt-01 新旧合同检查均 25/25 通过；24 个试跑均在 dispatch 前以
`frozen member Runtime drifted: agent_1` 结束，没有实际模型执行。复用配置中的 Judge 为空，
语义评测未运行。报告为 `insufficient`、54 项 evidence gaps；空 regressions 不证明模型行为无回归。
没有修改冻结基线、Case、标准或删除失败尝试，也不将确定性测试代替完整通用 Gate。
另起隔离 Core 诊断确认实际 adapter、model 与 permissions 均与冻结配置相同；成员 readiness 为
`installed_unverified`，Runner 的启动前断言只接受 `ready`，因而报告 Runtime drift。
诊断 Core 已退出；未在本项修改 Runner 或放宽其断言。

私有证据保存在本 Thread 的 `send-file-guidance-r3-validation` 目录，含构建、逐项日志、冻结计划与
`generic-gate/index.html`、`attempt-01/report.html`、JSON。已核对报告结论、全部 slot、证据缺口与本地链接。
报告 JSON SHA-256：`a7d9bf1d68fca523c43e799bfd00c6ec6201609f2b83aae93286bde67c34a45c`。
基线生产源码摘要：`b247a282669595f189dd69ebc316333339f1da52f08853a587e6336e97324e86`；
候选生产源码摘要：`0f48b1a28a0c5178499ae75b829957f108c6a1b84ebc09a0f6d27aa9dc370c0f`。
候选产物基于确认提交 `1a882e31` 加本次生产 diff；完整文件摘要保存在 `candidate-build/product.json`。
未进行真实飞书/Lark/钉钉平台交付验收，未安装或重启日常 App。

### 本次合并的验证例外

User 已收到 PR #780、确定性测试与 CI 通过、通用回归启动失败和 Judge 缺失的完整说明，
并在 Thread 消息 22（`c852ddbb-140d-4bfb-b45e-c3c7d9a64de0`）明确回复“merge”。
记录时间为 2026-10-16T10:16:00Z。本次按该授权合入，通用 Gate 仍为 `insufficient`，
不改写原报告或声称语义回归通过；此例外只适用于本 PR，不修改仓库评测规则。
同步主线 `8ec2cc1c6` 时仅版本概览新增段落冲突，保留双方内容；R3 文案与选择条件不变。
同步后重跑 Rust workspace，仍为 473 项通过、1 项原有 ignored；三个 Context owner 均通过。
格式、文档治理与差异检查通过；与新主线相比，R3 的 Rust/Skill diff 和原已验证版本一致。
