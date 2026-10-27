---
document_type: research-report
authority: observed-runtime-evidence
status: completed-with-qualified-boundaries
last_updated: 2026-10-15
---

# Steer 合并、产品收口与完整清单

本轮执行 User seq40：合并 main `d6ae891fcfb4a4a4e4ab41865fc47456b74413a8` 与
Mission 064 `b834998599c6624003c7106cb5cf475eb9a64e37`，在合并工作树构建真实 Core／Adapter。
验收期间主线又合入日期标记和锚点作者读取，最终同步到 `2d4c61af7`；两项不改变迁移身份、模型上下文
或九种 Steer 传输，合入后另做普通测试、锚点读取及界面回归。真实 LLM 的逐次二进制摘要仍按实际执行记录。
**产品现支持九种 Runtime 的用户 Steer，包含 TRAE CLI CN。** Agent 消息仍走普通投递。
仅在本次活跃 Run 满足 Core 资格时开放插话；普通执行资格独立。

[逐次脱敏证据](steer-hardening-2026-10-15.evidence.json)记录每个实际 Core／程序摘要、版本、模型、
消息和原生输入身份、时间、归属、回执、结果、失败及补测。平台均为 macOS arm64，采用隔离数据、
Skills、MCP、原生配置副本及测试项目；未升级或操作日常 App 数据。Claude 明确使用 sub2api。

后续 User seq44 的连续版本政策、新版 CodeBuddy 适配及 TRAE 0.207.1 产品验收，见
[版本复核报告](steer-version-followup-2026-10-15.md)。以下保留本轮原始准入与实测范围。

## 当前支持清单

“本轮通过”只覆盖表中场景。Steer 门槛是当前接线的资格策略；最早已测通过值来自
[低版本报告](steer-low-versions-2026-10-15.md)，不能理解为所有更高版本都逐一实测。

| 智能体 | 当前通道 | 本轮真实产品结果 | 当前 Steer 资格及边界 |
| --- | --- | --- | --- |
| **Codex** | App Server `turn/steer` | **0.162.1**：同轮文字、纯附件、普通队列、多队员混合通过 | 0.162.1 起；0.99／0.100 仅原生通过，保留当前完整启动／工作区要求 |
| **Claude Code** | Stream JSON 追加 user＋UUID 回显 | **2.1.287**：连续 A/B 同轮通过，sub2api | 2.1.83 起；该低版本此前完整通过，依赖必传参数、回显与结束事件 |
| **Pi** | 原生 JSONL RPC `steer` | **1.1.0**：连续 A/B、两种停止时点、普通续接、结束边界通过 | 0.99.0 起；本轮 **0.87.0 普通执行和排队通过，零 Steer 写入** |
| **CodeBuddy** | ACP 并发 `session/prompt` | **2.132.0**：新建 Thread **3/3** 连续 A/B 通过；停止／结束另组通过 | 仅已观察的 2.109.1、2.111.0、2.132.0、2.133.1；原异常保留，见 #762 |
| **Qwen Code** | ACP `craft/drainMidTurnQueue` | **0.25.0**：当前结构化载荷连续 A/B 同轮通过 | 0.18.4 起；0.18.3 回包不兼容。0.18.4 旧鉴权配置条件仍适用 |
| **Grok Build** | ACP `_x.ai/interject` | **1.0.50**：连续 A/B 同轮通过 | 1.0.14 起；1.0.13 有停止续接异常，不据此称其完全没有 Steer |
| **Kiro CLI** | 现有 v2 引擎、ACP `_session/steer` | **2.21.1**：连续 A/B 同轮通过 | 2.21.1 起；本轮 **2.7.0 普通执行和排队通过，零 Steer 写入**，保留其原生正例 |
| **ZCode** | 官方内核 App Server `sendText → guide` | **App 3.12.2／内核 0.16.5**：连续 A/B 同轮通过 | 按内核 0.16.5 起判断；同时冻结安装、构建摘要与协议，App 版本不能替代内核 |
| **TRAE CLI CN** | CN ACP `_session/steering` | **0.209.1：产品 3/3 同轮通过**，两种停止时点、普通续接、结束／失效目标通过 | 已完成产品适配；0.207.1 为此前通道正例，不能写成本轮该低版本已完成产品验收 |

上述范围同时限定当前协议族和已知 major，未知版本／协议保守排队。没有下调全局 Runtime 最低版本。
TRAE 与 CodeBuddy 各做三次独立同轮试验，其余文字正例各一次；Codex 另外覆盖完整三场景。
未声称九种 Runtime 都在本轮重跑全部附件、全部停止场景或全部历史版本。

| 当前未开放 Steer 的智能体 | 当前通道与已有实测结论 | 本轮处理 |
| --- | --- | --- |
| Qoder | 官方 ACP；1.1.65／升级后 1.1.71 的补充消息进入后继轮 | 保持普通投递，未重新跑 LLM |
| Kimi Code | ACP；2.1.1 拒绝活跃补充请求 | 保持普通投递，未重新跑 LLM |
| OpenCode | ACP；2.0.25 拒绝，之前源码核查到 2.0.29 仍有 busy guard | 本轮作为忙碌普通目标参加 Codex 混合投递通过 |
| DeepSeek Harness | 官方 ACP profile；0.2.1-alpha.1 拒绝，alpha.3 源码仍有 inflight guard | 保持普通投递，未重新跑 LLM |
| GitHub Copilot | 官方 ACP；1.0.83／launcher 1.0.91 为取消原轮后替换 | 保持普通投递，未重新跑 LLM |
| Antigravity | 官方 CLI Stream JSON；1.3.5 普通输入进后继轮，steer 被忽略 | 保持普通投递，未重新跑 LLM |
| Cursor、Cline、Command Code | 用户排除的三种 | 本轮未测试、未新增 Steer 接线 |

未开放项目的证据沿用[当前通道记录](steer-current-transport-2026-10-14.md)和
[Qoder 升级清单](steer-minimum-versions-2026-10-15.md)，不是对其其他通道、IDE 或未来官方版本的否定。

实际模型：Codex／Claude／CodeBuddy／Grok 为 `gpt-6.1-sol`；Pi 为
`pi://model?provider=sub2api&id=gpt-6.1-sol`；Qwen 为 `gpt-6.1-sol(openai-responses)`；
ZCode 为 `new-provider/gpt-6.1-sol`；TRAE 为 `glm-5.3/high`。Kiro 只报告 `auto`，
未据此猜测内部模型。TRAE 沿用本机企业登录授权的隔离副本。
ZCode 内核 `glm/zcode.cjs` 本轮重新计算的 SHA-256 为
`da61b0663336a65f7cce3dec223678794ccaa58158e304fc0d97b695434a8f01`；App 入口和安装整体摘要在 JSON 中分列。

## 数据、资格和上下文

| 用户要求 | 已落地内容与验收 |
| --- | --- |
| 两条 199 冲突 | 新增 **Migration 203／schema 153**；实际列、唯一性、来源触发器、格式元组及迁移链识别两类来源。148、主线 149–152、分支 149、fresh 153 均覆盖 |
| 历史数据保全 | 分支夹具含 initial、accepted Steer、unknown、prepared、未生成 Manifest 的 Delivery；逐列比较迁移前后数据及 claim JSON，重复迁移与恢复不重写载荷、不增加 Run、不丢归属 |
| 格式冲突 | 新 public **Manifest／Formatter 39、Profile 14、Facts 10**；历史分支 37／14／10 与主线 37／12／6、38／13／9 原样保存；旧最终 payload 从存储读取 |
| 活跃 Run 资格 | Core 使用冻结安装／generation、程序路径／摘要、实际版本、通道、binding、epoch、状态与初始回执；配置修改和磁盘程序替换不能把旧 Host 改成新程序 |
| UI 与 API 一致 | Read Model、直接 API 准入、异步附件解析后实际发送前复查同一 Core 入口；前端无版本表。默认优先插话，单目标不兼容原因放入既有发送菜单 |
| 多目标隔离 | 同一公开正文逐目标选择插话、排队或普通启动；Core API 矩阵及真实 Codex／OpenCode／空闲 Codex 三目标通过 |
| 共同上下文 | 相同 Builder／Formatter，Steer RUN_INPUT 只有本条，初始 Manifest 不被覆盖，普通 waiting 消息不夹带；引用投影、不可用 Skill 不扩权、实际字节预算失败无半份 Manifest 均有断言 |
| 结构化输入 | 共享引用／附件／授权 Skill 投影 owner 保留；本轮真实 Codex 纯附件可插话。没有给 Runtime 拼接 Steer 专用提示词 |

普通输入和 Steer 合并主线发送者投影的[逐段前后对照](../../versions/v1.72/model-context-change-steer-merge.md)
保持相邻排列。没有新增快照教学、协议标签或上下文裁剪策略。

合并回归还修复了历史 Formatter 38 恢复断言遗漏，以及主线 Antigravity binding 意外随 Tool Transport
版本变化的问题；后者按原合同固定历史兼容输入 39，现有 Session 不因纯工具输出格式修订轮换。
这不增加 Antigravity Steer 能力。

## 接受证据、停止、结束与崩溃

界面将统一 `accepted` 改为 **运行时已接收**。原生明确消费事件才可称消费，文件／回复决定业务是否满足。
TRAE `injected`、CodeBuddy supplemental prompt 回执、Grok `queued` 不被自动解释为模型完成要求。

结束断言区分三种合法结果：原执行收到且没有额外 Run；明确未接受后仅一次普通投递；unknown 原样保留、
无自动重发或补任务。反向夹具故意重复输入、错误归属、额外后继、全部失败、缺原生 ID 或 unknown 重试，
均被断言拒绝，避免“全部进入终态就算通过”。本轮三组真实结束竞争均落到原执行接收，另外用失效目标
验证一次普通投递；其余合法窗口由确定性夹具覆盖，不声称真实模型恰好跑遍所有调度。

停止后的普通续接不包含“忽略旧任务”提示。TRAE／CodeBuddy 对照原工具祖先进程，确认使用过 Steer 的
目标 Host 退出再启动后继；Pi 保持 `clear_queue` 和消费关联路径。保存停止时逐输入状态、停止后进程、
后继输入和文件结果。检查的是未消费队列不继续执行，不要求模型忘记已进入历史的内容。

Core 事务故障夹具覆盖发送前退出、native 已收但 ACK 丢失、保存 ACK 前事务失败、旧执行结束后的迟到
ACK、unknown 时新消息继续到来。重复恢复不重发、不把 unknown 改成未发送，旧 ACK 不改变后继 Run／水位。
ACP 假 Runtime 另覆盖 TRAE 正常回执、明确拒绝、迟到回执与 Prompt 生命周期；不靠 LLM 偶然性覆盖这些窗口。

## CodeBuddy 独立问题与发布决定

[问题 #762](https://github.com/murray17/rovai-ai/issues/762)保留原版 2.132.0 的第三次失败：
A、B 两条均 accepted，文件与回复仍停在 A。原始 Run、两条 message ID、ACP 请求 ID 和投递时间均保留。
上一轮清理已移除原异常轮的原生消息历史，因此不能区分未在原轮消费、错后继或模型未遵从，**根因仍未知**。

本轮同版本三个独立 Thread 均产生 A、B 的原生 user 记录和对应文件调用，最终 B 正确；它们有原生日志
SHA、id、parentId、时间及 Rovai message ID 映射。新成功不覆盖旧失败，也不宣称修好了未定位的 Runtime bug。

发布决定：保留 2.132.0 的已观察协议准入，不因单例全面封禁；不外推全部更高版本；显示真实证据强度，
unknown 不重发；问题保持打开，后续异常保留原生轨迹。独立问题和证据缺口已闭环记录，根因尚未闭环。

## 尝试记录与验证边界

本轮全部真实尝试都进入 JSON，包括首次 CodeBuddy／TRAE 脚本误读不存在的 SQL 字段，以及两次 TRAE
Host 检查分别误认 launcher 名称、包含无关 warm Host。它们标为验收脚本失败；修正脚本后用新目录重跑，
没有改生产接线来凑通过。CodeBuddy 首轮新报告的 `/tmp` 与 `/private/tmp` 路径差异导致 JSONL 查找失败，
后续根据实际 Session 找回原文件并单独导出摘要，不修改原报告。旧版原始业务失败也完整保留。

验证入口及结果在提交前落入下面的检查记录；UI 截图使用生产 ThreadWorkspace，覆盖单目标、多目标、
未知回执、执行结束路线变化及日／夜主题。截图不代表九种 Runtime 都经过手工 UI 操作。

| 检查 | 结果 |
| --- | --- |
| `cargo test --workspace` | 472 passed，1 个手动 Runtime smoke ignored |
| `cargo test -p rovai-core --lib --features extended-tests` | 首轮 990 passed／24 failed／8 ignored；下述修复后 **原 24 项一起复验 24/24 通过**，未把定向复验写成第二次全量通过 |
| ACP／Runtime 受影响 owner | 68 passed／2 个手动 smoke ignored；恢复与取消 owner 27 passed |
| 迁移来源、已填充分支库、崩溃窗口、冻结资格、共同上下文 | 定向通过；新增合同 owner 均在 `extended-tests`，SQLite／恢复状态无法由纯 parser 测试替代 |
| `pnpm test` | Vitest 2686 passed；末尾 Node suite 355 passed／2 个 Windows 场景 skipped；文档、Skill、sandbox 检查通过 |
| `pnpm test:steer-ui`、竞态反例测试 | 通过，日／夜主题、单／多目标、unknown 与结束路线；人工复核截图后修正排队按钮换行 |
| `pnpm typecheck`、`pnpm build:desktop` | 通过 |
| `cargo check --workspace --all-targets --features extended-tests`、Core／CLI build | 通过 |
| `pnpm docs:test`、`pnpm docs:check`、指定合入主线基线的 `pnpm docs:check:ci` | 通过 |
| 最终同步 main `2d4c61af7` 后的增量复验 | 普通 Rust 472 passed／1 ignored；`pnpm test`、类型检查、桌面构建、Steer UI 及锚点端到端通过；锚点后端 `slow-tests` 两项通过 |

扩展首轮的问题包括 TRAE 初始 ACK 顺序断言、历史格式名单／触发器名称、升级测试链重复执行、
旧夹具的 `now` 时间字符串与新增索引不兼容、最小读取夹具缺新列，以及恢复夹具的虚构 Manifest
受到新增来源约束阻止。修正最低层 owner；恢复夹具只在准备孤立旧输入时临时拆装原样触发器，运行恢复
逻辑时完整约束已恢复，生产约束没有放宽。macOS 自动给新文件附 provenance 的环境下，显式控制
测试的初始观测，仍保留真实 inode、时间、权限与后续 OS 探测。一次并发构建影响 Core 路径解析的测试
也已独立及组合复验通过。原始失败日志摘要保留在 JSON，不删测试、不新增 checker 例外。

每次真实试验保存对应 Core 二进制摘要；最后构建另含 Antigravity 历史兼容输入修正，九种 Steer
传输未因该修正改变。最终同步主线后的首次普通 Rust 回归发现兼容性登记页的证据摘要未随登记更新，
按实际文件字节更新对应 revision，保留摘要校验；逐次检查结果在 JSON 中分列。
原始报告及原生 JSONL 保留在私有诊断目录，已移除本轮 **50 项配置／凭据副本**，
公开附件只含白名单导出的结构化证据和截图。

TRAE 产品适配已完成。更早 Codex／Kiro 的协议适配仍为后续扩展，不通过删参数、放宽回执或降低全局
门槛冒充兼容。本轮没有重构消息存储为另一套 Steer 指令，也没有替换已确认的降级合同。
