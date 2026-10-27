---
document_type: implementation-record
version: v1.72
status: completed
last_updated: 2026-10-20
---

# 原生问卷验证

首批按 User 确认仅修改 Claude Code、Copilot、Kimi、Qwen，并明确不再尝试通过修改本机配置关闭 MiniMax。
基线为 `7a447be53dad78e5dcd0c180b42e23bbfa690a37`，分支 `rovai/native-questionnaire-policy`，
worktree 为同级 `rovai-ai-native-questionnaire-policy`。首批合同为
[Runtime Launch v65](../../contracts/runtime-launch-and-verification-v65.md)，后续 Qwen 增量由
[v66](../../contracts/runtime-launch-and-verification-v66.md) 拥有。
这是现有问卷/审批分离原则的适配器补齐，未引入新的产品交互、持久状态或决策分歧，故不新增 Version Decision。

## ZCode/OpenCode V2 禁用增量（2026-10-20）

User 在原生对照验证后授权禁用两家问卷。实际基线为
`dacb9622f60e07f4fe2b7165ad64b6d4f8cd5698`，分支 `rovai/disable-zcode-opencode-questionnaires`，
worktree 为 `/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-disable-native-questions`。
范围由 [Runtime Launch v67](../../contracts/runtime-launch-and-verification-v67.md) 拥有。
不改 MiniMax 本机配置，不扩展此前四家适配器、问卷兜底、Run 终态或自动继续。

| 适配器与本机版本 | 正式策略 | 实测结果 |
| --- | --- | --- |
| ZCode App 3.14.5 / 内核 0.16.9，原生 app-server | create/resume 的 `toolDenylist: ["AskUserQuestion"]` | 工具已禁用；9 次业务模型请求均为 20 个工具，无 AskUserQuestion；ExitPlanMode、Bash、读写等保留 |
| OpenCode 2.0.26，ACP V2 | 全局、build、plan 规则末尾 `question / * / deny` | 工具已禁用；6 次业务模型请求均为 11 个工具，无 question；shell、skill、读写等保留 |

两组均通过生产 Core 的 NORMAL、FOLLOWUP、AFTER_RESTART 三轮，实际执行 Shell 写文件并通过绑定 CLI
公开发送；没有普通 Approval 或问卷请求，每组始终保持同一个 Native Session。
ZCode 正式 wire 为一次 create、两次 resume，逐次携带精确拒绝名单；后继轮实际重建 Host，
不混称热 Host 复用。OpenCode 正式 wire 为一次 new、后继 Host 复用及重启后的 resume。
两项策略只进入 Host compatibility，ZCode bridge revision 与 Native Session binding 构造保持不变。

验收复用 `scripts/smoke-native-questionnaires.mjs`，独立 Core data、Skill Library、MCP、
队员原生 Home 与 Provider 配置；使用未修改的官方内核和本地脚本化 Provider，不是真实外部模型评测。
目录为 `/private/tmp/rovai-questionnaire-{zcode,opencode}-20261020-disable-c`，
Core SHA-256 为 `24d94654ef0987de50f43b079095a5788de1d4f0446e10b5031dcdce2f0cd2b2`。
OpenCode 来自官方 `@opencode/cli-darwin-arm64@2.0.26`，下载时核对 npm SHA-512，
二进制 SHA-256 为 `1b6418a3bd4211344d8a2b75d7d4367b24283ae548bd6b896cf717f6f8858f26`。
前两轮准备阶段分别遇到隔离 Home 与 Core 附件根不一致、版本显示格式、已退役的启动环境编辑接口；
修正验收脚本后完成上述六轮，不将准备失败记作原生或生产功能失败。

先前无禁用的原生对照中，ZCode 提供 21 个工具，OpenCode V2 提供 12 个工具；
仅移除对应问卷。ZCode 的自动继续偏好不是工具禁用开关；OpenCode V2 的
[无表单原生取消](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/cli/src/acp/elicitation.ts#L31-L64)
仍存在，禁用使用其[有序权限工具过滤](https://github.com/anomalyco/opencode/blob/v2.0.26/packages/core/src/tool.ts#L212-L280)。

确定性回归扩展既有 `provider_registry_protocol_uses_native_model_selection`
（build/plan/yolo、Probe、新建和恢复）、`opencode_detector_plugin_is_additive_to_runtime_config`
（三种权限值、全局/build/plan、其他用户字段与 V1 保持），以及
`warm_compatibility_matches_process_inputs_across_acp_adapters`（仅 V2 的旧 Host 摘要失效）。
没有新增 Rust 测试 owner。正式原生验收仅覆盖 macOS arm64 上述版本、ZCode yolo 和 OpenCode build；
OpenCode plan 的配置由确定性 owner 覆盖，旧内核、其他平台、自定义/子 Agent 与插件改写工具集合未实测。

`pnpm check:rust`、`pnpm test:rust:pr`（474 passed、1 个既有 ignored），上述三项
`extended-tests` owner、格式与脚本语法检查通过。文档通过 `pnpm docs:test`（10 项）、
`pnpm docs:check` 与基于上述实际基线的 `pnpm docs:check:ci`。
另以 `slow-tests` 运行既有 `warm_hosts_never_cross_camp_compatibility_keys` 和
`accepted_send_suppresses_missing_send_recovery_for_recipient_matrix`，两项均通过。
兼容性记录新增证据后同步更新其 SHA-256 常量，平台准入状态不变。
原生验收进程均正常退出；只清理本次临时配置、附件根与下载二进制，脱敏结果另存于本 Thread 附件。

## 原生证据（PR #829）

| 适配器 | 本机版本 | 处理 | 验证状态 |
| --- | --- | --- | --- |
| Claude Code | 2.1.287 | 统一禁用 AskUserQuestion；控制请求 deny，普通输入保护不变 | 工具已禁用；正式新建、恢复、Core 重启后恢复均验证 |
| Copilot | 1.0.91 | 正式 ACP --no-ask-user；Host compatibility 纳入策略 | 工具已禁用；新建、热 Host 复用、Core 重启后恢复均验证 |
| Kimi | 2.1.1 | AskUserQuestion + q0 选项；ACP cancelled | 请求已取消；yolo、先发送再提问、后继输入、Core 重启后原 Session 恢复均验证 |
| Qwen | 0.25.0 | ask_user_question + Qwen 专用元数据；ACP cancelled | 请求已取消；yolo、先发送再提问、后继输入、Core 重启后原 Session 恢复均验证 |
| MiniMax | 本轮不复测 | 保持原有取消、不支持终态及禁止重放 | 用户确认禁用需要改本机配置，本轮不做 |

Kimi 的安装包 `@moonshot-ai/kimi-code/dist/main.mjs` 中，
`questionItemToPermissionOptions` 生成 `q0_opt_* / q0_skip`，
`outcomeToQuestionAnswer` 将 cancelled 映射为未回答；ACP fallback 的工具身份是精确 title。
Qwen 的 `acpAgent` bundle 通过 `interactionMetaFields`、`toPermissionOptions` 和
`resolvePermissionOutcome` 生成专用元数据与 Submit/Cancel，并接受 cancelled。
夹具位于 `crates/rovai-core/tests/fixtures/runtime-questionnaire/`，来自真实 CLI 的原生帧，
使用合成问题，仅替换 Session/toolCall ID；它们本身不宣称真实模型验证。

原生冒烟使用 `scripts/smoke-native-questionnaires.mjs <adapter> <absolute-cli> <fresh-absolute-fixture>`，
复用生产 Core 与 qualification 启动器，独立 data、Skill Library、MCP、原生配置目录，使用本地脚本化 Provider。
透明 CLI 包装只记录原生参数与问卷取消线，不生成协议回执；测试配置只写入新建临时目录。
这证明实际 CLI 协议与生产分派，不是实模型行为评测。

macOS arm64 最终验收目录为 `/private/tmp/rovai-questionnaire-{claude,copilot,kimi,qwen}-20261020-g`。
四份报告均通过，共 16 个正式 Run；执行的 Core SHA-256 为
`dfbaa0be2960a368be88a174a16cd0e5fe6832173b8c377323bf564d0509fe13`。

- Claude、Copilot 各 3 轮、6 次模型请求，模型实际工具集合中分别无 AskUserQuestion/ask_user；
  普通 shell、文件效果与绑定 CLI 发送正常，三轮保持同一 Native Session。
  Claude 正式启动记录为一次新建、两次 `--resume`，均有禁用参数；Copilot 正式 Host 两次启动，
  中间复用，重启后重新加载原会话，均有 `--no-ask-user` 且未带空工具限制。
- Kimi、Qwen 各 5 轮；两次真实问卷都收到唯一 cancelled 回执，没有原生选项选择或 Core answers 提交，
  数据库未创建普通 Approval。ASK 和 SEND_ASK 均为 `runtime_questionnaire_unsupported`；
  SEND_ASK 的已发公开消息和文件保留，FOLLOWUP 与 AFTER_RESTART 成功且保持原 Session。
- Kimi 使用 `multi_select` 工具入参，ACP fallback 仍为 `q0_opt_*`；取消后原生自行生成
  empty-answer/dismissed 工具结果，不能把它记为 Core 提交空答案或真实用户拒绝。
- 原生冒烟覆盖上述本机版本及权限绕过模式；其他权限模式、旧只读、损坏/冲突、稀疏元数据、
  重复与外来 Session 的确定性覆盖由下列 Rust owner 提供，不宣称其他版本或平台已验证。

另用 `--duplicate-questionnaires` 在 Kimi/Qwen 原生问卷输出之后注入一份相同 request ID 的重复帧。
两组额外的 5 轮验收均通过，每个真实问卷仍只有一次 cancelled 回执，后继消息及 Core 重启后的恢复保持；
目录为 `/private/tmp/rovai-questionnaire-{kimi,qwen}-20261020-duplicates`。
这是明确标记的传输故障注入，与上述未修改原生帧的 16 轮证据分开，不生成问卷响应或用户答案。

## 确定性测试 owner

- `approval_selects_the_exact_native_option_id`：新增 Kimi/Qwen 原生形状、损坏与冲突、普通权限和适配器边界；
  MiniMax 原案例保留，代答会在旧版本直接选择 allow_once。
- `warm_compatibility_matches_process_inputs_across_acp_adapters`：Copilot 策略变更只影响 Host 摘要，
  隔离参数用途保持；其余适配器输入摘要保持原断言。
- Claude 原启动进程矩阵：普通/只读限制合并，权限模式与新建/恢复共用正式构造。
- `incompatible_initialization_and_missing_tool_identity_never_admit_permission` 与
  `native_permissions_do_not_block_stdout_or_replace_the_last_result`：拒绝、一次回执、外来 Session、
  持续 stdout、普通审批、非空 final 后仍失败；原输入精确匹配测试保留。
- 既有 ACP 终态优先级与 accepted-send owner 回归，不创建平行测试体系。

## 门禁

最终 Rust 代码通过 `pnpm check:rust`、`pnpm test:rust:pr`（474 passed、1 个既有 ignored）、
10 项 `slow-tests` 定向 owner（含 extended owner）。`pnpm docs:check`、`pnpm docs:test`
及基于实际修改基线的 `pnpm docs:check:ci` 通过；`git diff --check` 和冒烟脚本语法检查通过。
Rust 测试仅扩展已有 owner，没有新增独立 Rust 测试。
原生版本/平台的未覆盖项继续记为未验证，不用参数测试替代。

## Qwen 启动禁用增量（2026-10-20）

User 确认保留 PR #829 主流程，本轮不扩展边缘处理。基线为合并提交
`37613fd4281e7fc3d0aa12280767b391ebe0b714`，分支 `rovai/qwen-questionnaire-disable`，
worktree 为同级 `rovai-ai-qwen-questionnaire-disable`。生产变更只有 Qwen 正式 ACP 命令的
`--exclude-tools=ask_user_question` 和 Qwen Host compatibility 的策略项。普通审批、问卷取消、
Run 终态以及 Claude/Copilot/Kimi/MiniMax 代码保持原状。

上游 v0.25.0 的[参数处理](https://github.com/QwenLM/qwen-code/blob/6788c035698a0ada471c958d1e789e96c6cddd9b/packages/cli/src/config/config.ts#L1968-L2015)、
[ACP 参数继承](https://github.com/QwenLM/qwen-code/blob/6788c035698a0ada471c958d1e789e96c6cddd9b/packages/cli/src/acp-integration/acpAgent.ts#L15319-L15337)
和[工具注册拒绝](https://github.com/QwenLM/qwen-code/blob/6788c035698a0ada471c958d1e789e96c6cddd9b/packages/core/src/permissions/permission-manager.ts#L930-L947)
仅作为调查起点；以下为本机 macOS arm64、Qwen **0.25.0** 的实际运行证据。

| 验证入口 | 实际结果 |
| --- | --- |
| 原生 ACP 对照，无排除参数 | 模型请求包含 `ask_user_question`；普通 Shell、同进程后继输入和新进程 `session/load` 均成功 |
| 原生 ACP 对照，有排除参数 | 10 次模型请求均不含 `ask_user_question`；普通 Shell 写文件成功，同进程后继输入和新进程 `session/load` 均为 `end_turn` |
| 正式 Core / NORMAL、FOLLOWUP、AFTER_RESTART | 三个 Run 全部成功；12 次模型请求均无问卷工具，三次文件写入和公开发送保留，普通 Approval 为零 |
| 正式启动与恢复 wire | 三个正式 Host 均带精确排除参数及原 `--approval-mode yolo`；首次 `session/new`、后继与 Core 重启后两次 `session/resume` 保持同一原生 Session |

正式 smoke 使用现有 `scripts/smoke-native-questionnaires.mjs`，Qwen 转入工具已禁用断言，
仍检查真实模型工具集合、普通工具效果、公开发送、问卷回执为零和原 Session 恢复。
本次正式后继输入发生原生恢复；同进程复用由上表的直接 ACP 对照验证，不混称为 Core 热 Host 实测。
原生对照和正式 smoke 均使用真实 CLI 与本地脚本化 Provider，不是外部真实模型资格验证。

隔离目录分别为 `/private/tmp/rovai-native-questionnaire-probe-20261020-b` 与
`/private/tmp/rovai-qwen-excluded-core-20261020`；正式 Core 二进制 SHA-256 为
`547b985a0ed91212b0f7427480b1eaaa1dec3c1f333a3a54f2130f9576fcfb06`。
Qwen Home、Core data、Skill Library、MCP config 均单独隔离，不修改用户本机配置。
旧版及其他平台不由本次结果推导支持。

扩展既有 `warm_compatibility_matches_process_inputs_across_acp_adapters`，核对旧摘要失效、
精确新摘要和统一命令构造；既有普通权限/问卷 owner 继续验证取消兜底。没有新增独立 Rust 测试。
增量通过 `pnpm check:rust`、`pnpm test:rust:pr`（474 passed、1 个既有 ignored），以及
上述 Host owner 和 `approval_selects_the_exact_native_option_id` 两项 `extended-tests` 定向测试。
`pnpm docs:check`、`pnpm docs:test`、实际基线的 `pnpm docs:check:ci`、格式与脚本语法检查通过。

## Kimi 拒绝语义核查（2026-10-20）

仅核查 Kimi **2.1.1**，不改变策略。原生 ACP 问卷的 `q0_skip` 是 `reject_once`；
安装包 `outcomeToQuestionAnswer` 将选中 Skip 与 `outcome=cancelled` 都映射为未回答。
两组隔离对照各发送问卷，分别回 `selected/q0_skip` 和 `cancelled`，之后由脚本化 Provider
调用真实 Shell 写入 `continued.txt`，再返回 final；两组均写入成功、原生 `end_turn`、
进程仍存活，下一条真实协议输入在原 Session 成功。

因此拒绝当前问卷本身不会触发 `session/cancel` 或杀进程；模型可以继续执行其他工作，
但不保证真实模型一定选择继续。原生生成的 `answers:{}` 加 dismissed note 是其工具结果，
不是客户端提交空问卷。Rovai 按 v65 在原生结束后把未承接问卷判为
`runtime_questionnaire_unsupported`，仍保留已发消息、文件和后继用户会话，不增加自动继续机制。
