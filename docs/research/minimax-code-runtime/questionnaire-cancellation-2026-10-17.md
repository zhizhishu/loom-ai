---
document_type: runtime-research
status: verified-with-limitations
last_updated: 2026-10-17
---

# MiniMax：问卷取消与后继会话验收

User seq35 提议采用“暂不支持原生问答、明确取消、不代答”。本轮验证该方向，保留当前生产
实现 e359b087，不把取消解释为默认工具隐藏，也不再要求上游局部关闭开关先落地。
官方 mcode 0.6.12、macOS arm64：**问卷关闭且没有答案，当前 Run 失败；后继新指令可继续
同一 Native Session。** 这是已验证的 Preview 边界，不是透明续跑或完整问答支持。

## 实际通路

- Rovai 不广告 ACP elicitation form。MiniMax 普通问卷没有可用的答题通路时，上游执行
  `dismissQuestionnaire`。本轮真实数据库均为 `dismissed`，`answered_at`、`reply_payload`、
  `injected_at` 全空，没有问卷表单或合成用户答案。
- 上游另有简单问卷的 permission fallback，将答案包装为 `allow_once`。现有
  `is_questionnaire_permission_request` 按 `questionnaire:` optionId 识别并返回 `cancelled`，
  在普通审批与免审批逻辑之前处理；即使普通 allow option 排在首位，也不自动代答。
- 不能把本轮普通问卷测试声称为上述 fallback 的真实命中：公开源码的 `normalizeStep`
  会设 `allowOther=true`，而 fallback 拒绝此条件。本轮未观察到待处理审批；fallback 由
  既有 Rust extended 测试覆盖，保留两种证据的区别。
- 原生 `ask_user` 创建问卷后返回 `waiting_for_user` 与 `terminate=true`，取消不会自动再次
  调用模型。没有 final 且出现未承接交互时，现有共享规则返回 `runtime_unsettled_activity`，
  不以正常 ACP stopReason 或已经发送过消息掩盖此事实。失败不可自动重放。

生产行为没有新增统一“拒绝所有问卷”的保证。工具仍可能被模型调用；用户需要再发新指令，
模型也可能再次选择问卷。需要提问时改用普通 Thread 是交互方向，当前并无自动转换桥接。

## 验收结果

控制矩阵使用实际官方 mcode、生产 Core 与本地确定性 Provider，12 项断言场景、11 个 Run：

| 场景 | 结果与边界 |
| --- | --- |
| 基线 | 成功，公开发送一次 |
| 单选、多选、default 权限模式问卷 | 各一个问卷 dismissed，答案为空；Run failed，无 pending approval |
| 先公开发送再问卷 | 一条消息已提交；Run failed 且不可重试，摘要为“消息已发送，但运行结束校验失败” |
| 四种问卷各自后继新指令 | 均成功，写文件并公开发送一次，Binding 与 Session 保持 |
| 多选后 Core 重启 | 新 Core 进程恢复原 Session，后继成功；不是跨 Session A→B→A |
| 其余后继 | Core 直属子进程 PID 集合保持；不把这一观察扩写为完整 Fleet 资格 |
| 普通命令 allow / deny | 仍各出现审批；允许产生文件，拒绝不产生文件；模型轮次均正常结束 |
| 结束复查 | 四个问卷仍 dismissed、没有迟到答案或注入，隔离原生配置未关闭 ask_user |

另在独立开发 App 使用官方 0.6.12、Sub2API 的 gpt-6 / openai-responses 执行两轮真实 LLM：
第一轮调用原生 ask_user，问卷 dismissed，Run 按预期失败；第二轮从同一 Session 记忆取出
`ASK-CANCEL-714`，写入文件、Node 断言并公开发送一次 `MINIMAX_QUESTIONNAIRE_SUCCESSOR_OK`，
Run 成功。真实 LLM 证明问卷后的记忆与编码连续性；该探针未取得有效 PID 观察，不追加真实
LLM 同 Host 资格。没有在后继输入中要求非空 final。

开发窗口保留在“MiniMax · 问卷取消与续接”，使用独立 userData、Skill Library、MCP、原生
data root 和临时项目；日常 App、日常 MiniMax 配置与此前验收 Thread 不变。
机器可读结果及校验范围见[脱敏证据](questionnaire-cancellation-2026-10-17.evidence.json)。

## 与已有实现的区别

以下是当前代码核查，除 MiniMax 外没有新增真实 Runtime 资格：

| Runtime | 当前处理 | 不能据此宣称 |
| --- | --- | --- |
| MiniMax | 上游 dismiss；问卷 permission fallback 由 Rovai 明确 cancelled；保留失败终态 | 工具已隐藏、当前轮自动继续、自动改发 Thread |
| Pi | 不支持的 Extension UI 返回 cancelled；confirm 返回 false | 所有原生提问都被统一禁用 |
| Cursor | ask_question 返回 skipped；有自己的原生返回语义 | MiniMax 可以复制此返回值 |
| ZCode | `askUserQuestionAutoResolutionEnabled=false` | ask-user 工具已移除 |
| Claude Code | 当前启动策略未发现统一禁止 AskUserQuestion；部分受限模式禁文件工具 | 已经全面关闭问卷 |

对应实现位于 `pi.rs` 的 `unsupported_extension_ui_cancellation`、`application.rs` 的 Cursor 和 ACP 请求处理、
`zcode.rs` 的 Session 创建、`claude.rs` 的启动参数。本轮不修改它们。

## 复跑与剩余范围

```sh
node scripts/smoke-minimax-runtime.mjs /absolute/path/to/mcode --questionnaires-only --fixture-root /absolute/empty-fixture
cargo test -p rovai-core --lib --features extended-tests approval_selects_the_exact_native_option_id
cargo test -p rovai-core --lib --features extended-tests unsupported_native_extension_ui_is_cancelled_without_managed_interpretation
```

新矩阵扩展既有脚本，没有新增、删除或禁用 Rust 测试。问卷不可代答的生产修复、共享结束语义
与有界 Usage 补采沿用[批复修复](review-fixes-2026-10-17.md)。Usage 仍按部分/未知记账，
没有完整费用保证；21/29 Built-in CLI、Skills/MCP 子集和 macOS arm64 Preview 等已有边界不变。
工具隐藏、完整问答 UI、透明续跑、跨 Session/并发及其他平台不在本轮通过范围。

提交前 `pnpm test:rust:pr` 为 473 passed、1 项既有 ignored、0 failed；上述两个 extended
owner 各实际运行 1 项并通过。文档测试 10/10，普通及带真实 base 的文档治理门禁通过，
`node --check` 与 `git diff --check` 通过。

上游依据固定于公开源码
[`interactions.ts`](https://github.com/MiniMax-AI/minimax-code/blob/9a935605956c4500e9cb415f29258e2887e97817/packages/tui/src/acp/interactions.ts)、
[`normalize.ts`](https://github.com/MiniMax-AI/minimax-code/blob/9a935605956c4500e9cb415f29258e2887e97817/packages/local-runtime/src/questionnaire/normalize.ts) 与
[`local-ask-user.ts`](https://github.com/MiniMax-AI/minimax-code/blob/9a935605956c4500e9cb415f29258e2887e97817/packages/agent-tools/src/desktop/local-ask-user.ts)。
公开源码版本与 npm 发布不同，因此本地安装版的结论以本轮实际数据库和 Run 记录为准。
