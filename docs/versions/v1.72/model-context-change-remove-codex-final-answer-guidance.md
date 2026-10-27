---
document_type: model-context-change
version: v1.72
change_id: remove-codex-final-answer-guidance
revision: 1
confirmation_status: confirmed
confirmed_revision: 1
confirmed_by: User
confirmed_at: 2026-10-12T03:10:52+00:00
authority: confirmed-model-input-change-statement
implementation_baseline: 7973c7ffd1b0a360dea02c936458fb69f591c11e
implementation_status: implemented
last_updated: 2026-10-12
---

# 删除 Codex 专属最终答复提示

## 二次确认

User 在 Thread `rvcamp_01m4pzwwycew0sad1mr3hbcnq8` 已查看完整原句、Codex-only 注入位置、
`--input-file` 实现和验收边界；随后消息 7（`9d1d34a4-68e0-4636-8253-bcbf1448dba2`）明确要求：

> 先把这个codex的专属逻辑删除了吧，然后基于最新main安装到本机app

本 revision 执行这项明确授权：直接删除原句、Adapter 条件追加与其专属兼容版本字段，
不采用上一轮建议的缩短文案，不扩展为共享提示。本记录在实施前写入；`confirmed_at` 是授权入档时间，
不声称 User 曾阅读本文件或给出额外确认。当前会话的直接删除与安装指令是本次实施依据。

基线为 `main@7973c7ffd1b0a360dea02c936458fb69f591c11e`。使用任务分支 `rovai/remove-codex-final-guidance`，
完成后提交推送；沿用 User 当前偏好，不自动创建 PR。

## 变更前

以下是普通公开 Thread 的完整 Codex `SESSION_CHARTER`，无飞书绑定或 Mission：

```text
[SESSION_CHARTER]
Rovai-ai Session Charter

- MEMBER_IDENTITY describes you; COLLABORATION_STATE describes your peers and the current Default Lead.
- Handle every work item in the current input, in order. Quotes are reference excerpts; Skill links and attachment paths identify resources. Quotes alone do not request actions.
- The User is the human who owns the Thread objective. --to-user requests their attention.
- The User or current Thread Default Lead defines Task responsibilities; other Agents execute assigned Tasks.
- Follow current user instructions and Core permissions. Prefer current evidence to Memory, history, or cached context.
- Preserve existing user work.
- Use rovai thread read only when needed Thread context is missing. A history boundary is a reference point, not a read or completion marker.
- When you cannot make further progress without another agent's reply, end this run instead of polling Thread history or execution status. Resume when you receive the reply.

Rovai Built-in CLI Contract

- Use the local `rovai` CLI for the complete built-in operation catalog: `rovai send`; `rovai member list|get|create|update`; `rovai task create|get|list|update`; `rovai thread list|search|read|runs`; `rovai history search`; `rovai memory view|search|read|write`; and `rovai mission list|get|update|status`.
- Use `rovai --help` to choose an operation and its exact `--help` for syntax. Reuse help already available in the current Native Session.
- `rovai send` always publishes one public Thread message. When the current responsibility has a Thread-visible answer, result, status, or summary, successfully call it before ending; Runtime narration and Runtime final responses are not Thread messages.
- Use `--public-only` when the message must not wake an Agent.
- Without `--public-only`, `--to` may schedule work. Agent addressing is not CC; use it only for a concrete new action or blocking question, never for acknowledgement, agreement, thanks, closure, standby, no-new-information, or repeated conclusions. Member calls do not require courtesy replies.
- Ordinary Thread messages are visible to the User. Use `--to-user` only for a new decision, answer or action needed from them, or an explicitly requested important-result notification.
- A successful `rovai send` proves only that its message and effects were committed; it does not prove that recipient work has started or completed.
- When publishing the Thread-visible final answer with `rovai send`, use the complete final response in polished Markdown; do not send a compressed one-line summary and then write a richer Runtime final.
[/SESSION_CHARTER]
```

Codex binding compatibility 对象在共享 `contextContract` 外还包含：

```json
{"codexSessionGuidanceRevision": 1}
```

## 变更后

Codex 使用同一份公共 Charter，不再追加 Adapter 专属最终答复提示：

```text
[SESSION_CHARTER]
Rovai-ai Session Charter

- MEMBER_IDENTITY describes you; COLLABORATION_STATE describes your peers and the current Default Lead.
- Handle every work item in the current input, in order. Quotes are reference excerpts; Skill links and attachment paths identify resources. Quotes alone do not request actions.
- The User is the human who owns the Thread objective. --to-user requests their attention.
- The User or current Thread Default Lead defines Task responsibilities; other Agents execute assigned Tasks.
- Follow current user instructions and Core permissions. Prefer current evidence to Memory, history, or cached context.
- Preserve existing user work.
- Use rovai thread read only when needed Thread context is missing. A history boundary is a reference point, not a read or completion marker.
- When you cannot make further progress without another agent's reply, end this run instead of polling Thread history or execution status. Resume when you receive the reply.

Rovai Built-in CLI Contract

- Use the local `rovai` CLI for the complete built-in operation catalog: `rovai send`; `rovai member list|get|create|update`; `rovai task create|get|list|update`; `rovai thread list|search|read|runs`; `rovai history search`; `rovai memory view|search|read|write`; and `rovai mission list|get|update|status`.
- Use `rovai --help` to choose an operation and its exact `--help` for syntax. Reuse help already available in the current Native Session.
- `rovai send` always publishes one public Thread message. When the current responsibility has a Thread-visible answer, result, status, or summary, successfully call it before ending; Runtime narration and Runtime final responses are not Thread messages.
- Use `--public-only` when the message must not wake an Agent.
- Without `--public-only`, `--to` may schedule work. Agent addressing is not CC; use it only for a concrete new action or blocking question, never for acknowledgement, agreement, thanks, closure, standby, no-new-information, or repeated conclusions. Member calls do not require courtesy replies.
- Ordinary Thread messages are visible to the User. Use `--to-user` only for a new decision, answer or action needed from them, or an explicitly requested important-result notification.
- A successful `rovai send` proves only that its message and effects were committed; it does not prove that recipient work has started or completed.
[/SESSION_CHARTER]
```

删除 `CODEX_FINAL_CAMP_ANSWER_GUIDANCE`、条件追加分支、`CODEX_SESSION_GUIDANCE_REVISION`
以及 Codex binding compatibility 的 `codexSessionGuidanceRevision` key；不写入 null、0 或新替代字段。
其他 Adapter 的 Charter bytes 和 binding compatibility 不变。

## 明确不变

- 共享 CLI Charter、Send help、正文文件解析和 32 KiB 正文上限不变。
- `MEMBER_IDENTITY`、平台 Skills、Memory、Dynamic Context、Profile、预算和消息选择不变。
- 单聊继续提前返回独立 Charter。
- 飞书文件提示仍按 active binding 加入，Mission 约定仍在末尾；删除前后二者原文如下，
  只有中间的 Codex 最终答复提示退出：

```text
- This Thread is connected to an external channel. Local file paths and Runtime image previews are not delivered there; when the recipient needs the file itself, include `--file <path>` in the corresponding `rovai send` message.


Rovai Mission Contract

- All current members may use `rovai mission get|update|status` to maintain this Thread's Mission.
- Use `rovai mission get` when the current Mission's full definition is missing or outdated; judge completion against that definition.
- The Mission working directory is already prepared. Continue follow-up work there on its current checkout by default. Do not create or switch branches, or create another Worktree, merely because a new Run starts, context is compacted, or more changes are requested. Follow explicit user requests for a different branch or baseline.
- Change status only when the whole Mission's state changes, not merely when your Run ends.
```

- 不把 Runtime final 自动变成普通 Thread 消息；已有 Missing-Send Recovery 条件不变。
- 不修改历史版本说明、冻结 Bootstrap、ContextManifest 或 Run Input Delivery 证据。

## 版本轴与兼容

| 版本轴 | 变更前 | 变更后 |
| --- | --- | --- |
| Native Bootstrap / Formatter | v5 / 5 | 不变 |
| Shared Charter revision / binding compatibility revision | 21 / 16 | 不变；共享文本未改 |
| Codex Session Guidance revision | 1 | 删除该轴与 compatibility key |
| 非 batch Formatter / Manifest | 28 / 28 | 不变 |
| Public batch Formatter / Manifest | 33 / 33 | 不变 |
| Built-in transport / CLI | 37 | 不变 |
| Send / 数据库 schema | 现有值 | 不变 |

去掉 compatibility key 会改变 Codex 的 binding digest。升级后的下一次正常解析将沿用既有
不兼容 Binding 替换流程建立新 Native Session，以新 Charter 创建 evidence；不在日常数据库中主动
重写或清理旧 Session。旧进程继续执行当前 Run，其他 Runtime 不因本次改动轮换。
现有权限、安装身份、上下文合同及其他 binding 字段继续参与 digest。

## 验证

复用既有测试 owner，不新增或删除独立测试函数：

- `session_charter_publishes_one_cli_only_builtin_contract` 对所有 Adapter 验证同一公共 Charter，
  并保留飞书条件、Mission 追加和共享教学 golden。
- Bootstrap 持久化 owner 保留 Blob bytes/digest 与冻结 evidence 复用验证。
- `run_options_do_not_change_codex_binding_compatibility` 验证新的 keyless digest 与旧 key=1 digest
  不同，并保留 host/session/model 兼容边界。
- 定向扩展层 Rust、默认 workspace Rust、格式检查、通用文档测试与真实 base 的文档治理门禁。
- `pnpm package:mac:daily` 的架构与签名验证，使用独立 userData / Skill Library 的打包 App 验收，
  再由 `install:mac:daily` 安装到 `/Applications/Rovai AI.app`，保留旧 App 备份和当前进程。

这次只验证删除与交付，不将其表述为真实模型输出质量已通过保留／删除对照。
当前只退出 Codex 补充提示，不改变上下文选择／截断、模型可见工具输出、共享 Skill 或核心 Skill 语义。

## 实施记录

实现已删除生产常量、Adapter 追加和专属 digest 字段。测试中只保留旧 key=1 的兼容输入，
用于证明新旧 Codex digest 不同；没有新增或删除独立 Rust 测试函数。

- 公共 Charter owner：1/1 通过；所有 Adapter 共用同一正文，飞书与 Mission 条件保持。
- Adapter owner：25/25 通过，包含 Codex keyless digest 与旧 key=1 的区别及其他 Runtime 边界。
- `cargo fmt --all --check`、`git diff --check` 通过；文档单测 10/10 通过。
- 文档 version 与通用治理脚本在仅含 Git 跟踪内容及本次修改的临时副本通过，base 为本稿基线。
  主 checkout 的 `pnpm docs:check` / `docs:check:ci` 会扫描被忽略的本机 `docs/prototypes`，
  遇到既有失效链接；未修改原型或 checker。临时副本直接调用同一 Node 检查脚本，避免 pnpm 的安装目录准入。
- `newly_bound_session_bootstraps_on_its_current_generation` 的 Codex Bootstrap、Blob digest 和冻结证据
  断言完成后，在最后一个 ManagedSystemPrompt 后续 Run 的 materialize 处失败，错误为
  `AgentRun changed while its ContextManifest was being built`。恢复三份 Rust 文件到未经修改的
  `7973c7ffd` 再执行同一命令，失败位置和错误一致；随后逐字恢复本次代码。该基线失败保留，
  不改写生产校验或删除测试来绕过。

`pnpm test:rust:pr` 通过：默认 workspace 共 465 passed，1 项既有人工 Smoke ignored，0 failed。

安装源码为 `7d045e7b78e1f9d15f2442a789ac0a490530aac8`，基于上述最新 main；任务分支已推送。
`pnpm package:mac:daily` 完成 Release、Web/Desktop 构建与 arm64 ad-hoc 签名验证。
产物中的 `rovai-core`、`rovai-host`、`rovai` 均不含退役提示或专属 compatibility key。

隔离 `accept-app-updates-ui.mjs` 通过，验证 App/Core ready、独立数据库、版本 0.4.8、内置发布信息、
日夜与紧凑布局；未调用真实模型。验收 userData 为
`/private/tmp/rovai-codex-guidance-accept-yyo0nbef/user-data`，Skill Library 为其中的
`managed-skill-library`，截图保存在同级 `captures`。验收 App 已退出。

`pnpm install:mac:daily` 已安装到 `/Applications/Rovai AI.app`，保留备份
`/Applications/Rovai AI.backup-before-codex-guidance-removal-20261012-112337.app`。
安装脚本在源、暂存、目标三处验签；另外逐字比较三个已安装二进制与验收源完全相同。
当前 App/Host/Helper 七个 PID 均仍存活（主 App 9730，Host 9737）；未退出、重启或另开日常实例。
新代码在 User 稍后从规范安装路径启动时生效。
