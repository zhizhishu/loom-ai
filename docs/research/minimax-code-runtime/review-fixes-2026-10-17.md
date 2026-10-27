---
document_type: runtime-research
status: partial
last_updated: 2026-10-17
---

# MiniMax Code：seq19 批复后的修复与剩余缺口

本轮接续[三项复核](followup-2026-10-16.md)。macOS arm64 / mcode 0.6.12 继续为 Preview；
以下产品改动、受控原生验收和既有真实 LLM 证据分开记账。

## 问卷：防代答已交付，默认隐藏尚未交付

共享 ACP permission 路由在创建普通执行 Approval 或进入 bypass 前识别 `questionnaire:` option ID，
返回 cancelled。legacy approve/deny 也不选择答案。混入普通 allow_once 选项的问卷仍拒绝进入普通审批。
原有文件、命令、MCP 的选项选择和免审批策略不变；原生问卷工具调用不能借“此前已 send”满足空 final 收尾。

这覆盖了上游简单单选的 permission fallback 风险；不声称前次真实问卷失败发生过自动代答。
前次普通问卷被 dismiss 是另一条原生路径。本轮没有在产品中写入 `askUser.enabled=false`，
`productDefaultChanged=false`，也没有修改用户原生配置。

已核查的官方 0.6.12 入口仍不支持 ACP 局部关闭：`--config` 仅在 exec / exec review，
ACP runtime 创建未传 configPath 或 askUser 默认值；session/new 只接 workspace/MCP，
不支持选择独立 disallowedTools Agent。内部 `parseAskUserConfig` 和 Agent tool selection
不等于可交付外部开关。要完成主方案，需要上游提供官方 ACP 进程/Session 级配置或工具排除入口；
不引入 Home/凭据/Session 副本、全局配置改写或私有 bundle patch 来掩盖缺口。

## 结束：共享规则已修改

Core 成功事务允许本 Run/epoch 有有效公开发送且原生正常结束时 finalOutput 为空。ACP 还核对
原生 end_turn、error 和未结束的工具/问卷；原有取消、Action、Approval、投递及版本栅栏继续保留。
空 final 不产生第二条消息，也不伪造正文；finalOutputDigest 为 null。

公开消息与发送 command.result 必须精确匹配 Thread、作者、Run、epoch、操作、accepted 状态和消息实体。
Single Chat、旧 epoch、别的 Run、撤回或墓碑消息不能套用这条放宽。当前发送没有最终意图分类，因此
有效进度消息也属于 accepted send；本轮不声称已识别“最终答案”。

发送后原生报错仍失败，保留消息并明确展示“消息已发送，但运行结束校验失败”；不开放整轮重放。
未发送且没有 final 仍为 runtime_missing_final_output。协议本身只要求 StopReason，不要求另一份 final 正文。
字段权威见 [Missing-Send v3](../../contracts/missing-send-recovery-publication-v3.md)。

## Usage：后台补采有界，仍不是完整账单

在既有异步 baseline 之外，终态只克隆已就绪且未占用的 reader 与本轮已观察的 ACP 显示消息身份。
后台最多三次、1.5 秒接收窗口，Run/Host/后继不等待；数据进入原有周期 Flush。

真实调查发现 ACP messageId 和 journal message_id 不相等。补采仅使用原生 SQLite 同根 Session
assistant 行的显式 canonical_message_id + turn_id 映射，随后再校验 journal 身份、文件连续性与完整行。
只查询身份字段，不读取数据库消息正文；映射缺失/歧义、其他 Session、错误 turn、历史 baseline
及下一轮消息均不能进入本轮。映射/半行迟到允许重读冻结后缀，source identity 去重。

首次受控验收证实直接比较两种 ID 无效：AFTER_EMPTY 用量仍为空。该尝试保留在证据中，
修正后另用全新 fixture 验收。无文本/思考事件的纯工具调用可能没有可映射 ID，baseline 晚建、压缩换代
和窗口外写入也可能遗漏。所有 journal 数值仍标 runtime_reported_partial；无数值保持未知，不补零或猜费用。
权威见 [Usage v10](../../contracts/runtime-usage-monitoring-v10.md)。CodeBuddy/Kimi/Qoder 等共享原则不变，
未因使用日志或协议而简单排列可靠性；本轮没有替它们授予新尾读资格。

## 本轮验收

Rust workspace 门禁 473 项通过、1 项既有 ignored；6 个定向 owner 通过，文档测试 10/10 和两项治理门禁通过。
真实 CLI 的 4 个 Run 覆盖发送后空 final、正常后继、无发送空 final 和发送后原生错误；同 Host 后继断言通过。
修正后的短 Run 观测 Input 120 / Output 5，保持 runtime_reported_partial，未观测那轮仍为空。
验收结果与失败尝试见[脱敏证据](review-fixes-2026-10-17.evidence.json)。
自动验收使用新建独立 Core/Skills/MCP/native data，真实 mcode + 本地确定性 Provider；
不消耗官方免费额度，不把该测试称作真实 LLM 资格验证。
扩展原有 Rust owner，没有新增独立 Rust 测试函数。场景包括问卷答案选项混入普通审批、
空 final/发送/错误/取消矩阵、事务内发送归属、未结束工具、native mapping/半行/重放/跨 Session/turn、
后台统计注册与 Flush 去重。保留上一轮开发 App，不声称本轮 Core 修复已经换入该窗口。

## 保留的判断

- 不新增 MiniMax 专属 Auth/Provider 内容摘要。此前 A/B 证明的是 Rovai 每轮设置 permissionMode
  的完整调用链；将来优化 setter 或升级 mcode 时重跑。启动 System Prompt 内容兼容 fence 保留，精确 resume 不变。
- 64K 自动阈值压缩、同 Host/Session 连续性、单份 Charter 和后继发送已通过；手动 compact 后 App/Core
  冷恢复也已有证据。本轮不补压缩按钮，也不外推 overflow/retry、失败/取消或默认大窗口阈值。
- 21/29 Built-in CLI operation 子集、Skills 项目读写、MCP stdio/撤销/恢复仅保留既有范围。
  全 CLI、Skills/MCP 冲突隔离/HTTP/故障、跨 Session A→B→A、并发及其余平台仍未闭合。
- 不增加 Fast，不改 Host 兼容及 Native Session 恢复机制。

## 上游依据

- [ACP Prompt Turn](https://agentclientprotocol.com/protocol/v1/prompt-turn)：StopReason 与 PromptResponse。
- [官方 CLI contract](https://github.com/MiniMax-AI/minimax-code/blob/9a935605956c4500e9cb415f29258e2887e97817/packages/tui/src/cli/contract.ts)。
- [官方 ACP 创建入口](https://github.com/MiniMax-AI/minimax-code/blob/9a935605956c4500e9cb415f29258e2887e97817/packages/tui/src/cli/run-acp-command.ts)。
- [问卷 permission fallback](https://github.com/MiniMax-AI/minimax-code/blob/9a935605956c4500e9cb415f29258e2887e97817/packages/tui/src/acp/interactions.ts)。
- [显示消息与 canonical 映射](https://github.com/MiniMax-AI/minimax-code/blob/9a935605956c4500e9cb415f29258e2887e97817/packages/local-runtime-v2/src/service/session-system/agent-projection.ts)。
