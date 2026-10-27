---
document_type: runtime-research
status: verified-with-limitations
last_updated: 2026-10-17
---

# MiniMax：问卷取消的产品结束判定与提示

User seq37 授权落实 seq35 的取消、不代答方案。基于 `2294e1b50`，本轮修改生产结束判定和
公开失败提示；[上一轮](questionnaire-cancellation-2026-10-17.md)仅验证既有取消通路，不能把
那一轮的 `runtime_unsettled_activity` 记录改写为本轮行为。

## 已交付行为

原生问卷没有得到用户答案时，当前 Run 以 `runtime_questionnaire_unsupported` 结束，来源为
`compatibility`，不提供重放。公开详情为：

> 原生问卷暂不受支持，未提交答案。请发送新消息，在对话中补充信息或继续任务。

若此前已经公开发送，详情加上“消息已发送；”，摘要仍说明“消息已发送，但运行结束校验失败”。
已经交付的消息保留；不会重跑整轮或假造答案。用户下一条指令沿既有 Native Session 继续。

生产修改只复用当前 Prompt 的未承接交互观察，不增加配置、状态表、Host fence 或上下文内容：

- 已观察到问卷时，非空结束文字也不能把该轮判为成功；已发送消息同样不能掩盖该交互。
- 原生错误和 `cancelled` 优先，不能因问卷或公开发送将其改为成功。
- 普通已发送、原生正常结束且没有未收敛活动的空 final，仍沿共享规则成功。
- 既有 `questionnaire:` permission option 防代答保留在普通执行审批之前；不会选择第一个
  `allow_once` 答案。文件、命令、MCP 的普通审批通路没有被关闭。
- 不广告 elicitation form，普通 MiniMax 问卷沿上游 dismiss。没有隐藏 `ask_user`，没有安装
  上游候选补丁，也不修改用户日常 CLI 配置。

Rovai 不会弹出原生问卷表单，也没有把问卷自动转成 Thread 消息。取消后当前轮停止，用户需发
新指令；模型仍有可能再次调用问卷工具。该限制在本轮交付后仍然存在。

## 本轮验证

全部使用官方 mcode 0.6.12、macOS arm64；机器可读结果见
[脱敏证据](questionnaire-policy-2026-10-17.evidence.json)。临时项目、Core/App userData、
Skill Library、MCP 和原生 data root 均在启动前独立指定，没有读取或写入日常 App 数据库。

| 验证 | 实际结果与边界 |
| --- | --- |
| 问卷控制矩阵 | 12 项场景、11 个 Run 通过；4 个问卷 Run 按预期失败，公开代码、来源和详情正确 |
| 单选、多选、发送后问卷、default 权限 | 原生记录均 dismissed，答案和注入字段为空，无待处理问卷审批 |
| 问卷后的新指令 | 四种后继均成功；同 Binding/Session，多选后 Core 重启仍精确恢复 |
| 普通 allow / deny | 各出现一次审批；允许产生文件，拒绝不产生文件，普通执行权限没有被关闭 |
| 共享结束控制矩阵 | 5 项场景、4 个 Run 通过；发送后空 final 成功，未发送空 final 和发送后原生错误仍失败 |
| 真实 LLM 开发 App | Sub2API / gpt-6 / openai-responses 两轮；问卷返回新错误及提示，下一轮成功取回记忆、写文件、断言并公开发送 |
| 既有 Rust extended owners | 3 项实际执行并通过；覆盖非空文字不能掩盖问卷、错误/取消优先级、精确审批 option 防代答 |

真实后继从同一 Session 取回 `ASK-CANCEL-714`，公开发送一次
`MINIMAX_QUESTIONNAIRE_SUCCESSOR_OK`；后继提示中没有要求必须非空 final。真实问卷的答案字段
结束复查仍为空。live 探针的 PID 数组为空，因此只认定 Session 与记忆连续性；控制矩阵中的
Core 直属子进程 PID 集合观察另行记账，不外推跨 Session A→B→A 或并发隔离资格。

真实开发窗口保留在“MiniMax · 问卷取消已落地”。Thread DOM 已确认问卷轮显示未完成、后继
公开结果与文件变化存在；新失败详情已从该 App 的持久化 Run 读取。原生 UI 自动化选中了同路径
较早的 Electron 实例，未完成新实例失败详情的独立可视检查，不能把旧窗口截图当成本轮证据。

本轮真实问卷未命中 permission fallback；该分支由既有 Rust owner 单独验证，不把普通
dismiss 测试算作所有原生问卷形式的资格。MiniMax 仍为 Preview；Usage、Built-in CLI、
Skills/MCP、其他平台和跨 Session/并发的已有未验范围不因本轮通过而扩大。

## 回归记录

三个 extended owner 分别为 `acp_prompt_failure_is_retryable_only_when_input_was_not_accepted`、
`final_agent_message_uses_complete_assistant_suffix_after_last_tool_activity` 和
`approval_selects_the_exact_native_option_id`，每项使用 `--exact`，各 1 passed。
没有新增、删除或禁用 Rust 测试。

完整 Rust 检查首跑在既有
`runtime_probe_process::tests::successful_leader_with_stdio_holding_descendant_finishes_bounded`
报 `runtime_probe_stdout_cleanup_timed_out`；当时 Core 426 passed、1 failed、1 ignored，命令
退出 101。相同代码下精确复跑该 owner 1 passed；随后完整复跑 **473 passed、0 failed、
1 项既有 ignored**，命令退出 0。保留首次失败，不修改与本次问卷功能无关的进程清理代码。

文档测试 10/10，普通及带真实基线 `2294e1b50` 的文档治理门禁通过；`node --check` 和
`git diff --check` 通过。三个 extended owner 与完整默认套件分别计数，不合并成新的资格数量。
