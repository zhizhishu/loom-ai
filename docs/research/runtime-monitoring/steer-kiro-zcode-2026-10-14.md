---
document_type: research-report
authority: observed-runtime-evidence
status: completed
last_updated: 2026-10-14
---

# Steer 完整清单：Kiro / ZCode 接入与版本核查

> 后续 seq32 [TRAE 升级复核](steer-trae-upgrade-2026-10-14.md)已完成本机 0.209.1 升级、企业登录与 ACP
> 同轮实测。本报告的认证失败仅代表当时隔离探针，不能推断本机没有企业登录态；原失败记录保留。
> Qoder 官方 IDE 已有 Steer；以下否定结论限于已测试的 CLI / 接入通道，不代表整个官方产品。

**当前分支支持八种：Codex、Claude Code、Pi、CodeBuddy、Qwen Code、Grok Build、Kiro、ZCode。**
Kiro 和 ZCode 本次补齐产品投递，使用真实 Core、正式 Adapter 与真实模型验证。
“排到下一轮”描述上游收到补充消息后的执行行为，并非把 Qoder、Antigravity 的测试推迟。

范围：User seq30（`18866fe0-534a-465b-9aa4-c925af397f06`），基线
`d6afc8c484b1d30dfe5cf112a05e9ce7169097dc`，macOS arm64。
继续只按 Rovai 当前接入通道判断，排除 Cursor、Cline、Command Code。
未修改日常 Runtime 安装；Qoder 1.1.71 和 TRAE 0.209.1 下载到隔离目录，未覆盖原版。
日常 Rovai App 未安装、重启或升级，以下“已接入”指本分支代码。

## 完整清单

| Runtime | 已核验版本 | Rovai 实际通道 | 当前产品 Steer / 证据 |
| --- | --- | --- | --- |
| Codex | 0.162.1 | app-server | **已支持**；`turn/steer`，此前产品与同轮实测通过 |
| Claude Code | 2.1.287 | Stream JSON | **已支持**；追加 user / 原生输入回执，此前使用 sub2api 实测通过 |
| Pi | 1.1.0 | RPC | **已支持**；`steer` 后的消费证据，此前实测通过 |
| CodeBuddy | 2.133.1 | ACP | **已支持**；补充 `session/prompt`，此前实测通过 |
| Qwen Code | 0.25.0 | ACP | **已支持**；`craft/drainMidTurnQueue`，此前实测通过 |
| Grok Build | 1.0.50 | ACP stdio | **已支持**；`_x.ai/interject`，此前实测通过 |
| Kiro CLI | 2.21.1，默认 v2 引擎 | ACP | **本次接入并通过产品验证**；`_session/steer` 与 queued/injected 关联 |
| ZCode | App 3.14.5，内核 0.16.9 | 官方 bundled app-server | **本次接入并通过产品验证**；`sendText` 的 guide 与原 Turn 的 queued/drained 关联 |
| Kimi Code | 2.1.1 | ACP | **未支持**；忙碌 prompt 拒绝，专用扩展探测返回 method not found |
| OpenCode | 本机 2.0.25；源码核查至 v2.0.29 | ACP | **未支持**；本机扩展不存在，v2.0.29 仍拒绝同 Session 重叠 prompt |
| DeepSeek Harness | 本机 0.2.1-alpha.1；源码核查至 0.2.1-alpha.3 | 官方 ACP profile | **未支持**；官方桥仍限定一个在途 prompt |
| TRAE CLI CN | 本机 0.120.52；隔离探测 0.209.1 | ACP | **Rovai 未接入**；旧版扩展不存在，新版声明支持 steering，但企业认证阻断真实模型验证 |
| GitHub Copilot | ACP 1.0.83；启动器 1.0.91 | ACP | **未支持**；此前实测是取消原执行再替换，不是同轮注入 |
| Qoder | 1.1.65、1.1.71 | ACP | **未支持**；两版真实模型均先结束原轮，再处理补充消息 |
| Antigravity | 1.3.5 | Stream JSON | **未支持**；追加 user 进入下一轮，steer 事件被忽略，control_request 明确不支持 |
| Cursor | — | — | 按用户要求排除 |
| Cline | — | — | 按用户要求排除 |
| Command Code | — | — | 按用户要求排除 |

前六种和 Copilot 的结果继承 [seq28 同通道复测](steer-current-transport-2026-10-14.md)，
其产品验收来源见 [五种 Runtime 扩展](steer-five-runtimes-2026-10-14.md)。本次没有重新声称全十五种都跑了新的真实模型。

## “哪个版本开始支持”的核查

| Runtime | 本次官方版本依据 | 能可靠给出的结论 |
| --- | --- | --- |
| Kimi | 最新 Release / npm latest 为 2.1.1；`_session/steering` 提案 PR #2514 已关闭且未合并；当前文档没有该入口，本机方法探测亦拒绝 | **未查到已经发布的 ACP Steer 支持版本**。不能把 SDK 的能力或未合并 PR 当作起始版本 |
| OpenCode | v2.0.29 标签的 `packages/cli/src/acp/turn.ts` 仍在已有 active ACP prompt 时返回 ServiceFailureError；agent 请求注册没有专用 steering 方法 | **核查至 v2.0.29 仍无可确认的 ACP 支持版本**。内部 HTTP 的 delivery=steer 不改变 ACP 外层拒绝 |
| DeepSeek Harness | 官方 alpha 标签 0.2.1-alpha.3 的 `AcpSession.prompt()` 仍在 `inflight` 非空时拒绝；官方 ACP 文档也限定一个在途请求 | **核查至 0.2.1-alpha.3 仍无可确认的官方 ACP 支持版本**。第三方 ACP 包不在 Rovai 当前通道内 |
| TRAE CLI CN | 官方安装源最新 public 包为 0.209.1，2026-10-10 发布；实际 initialize 返回顶层 `_meta.steering.supported:true`；`_session/steering` 进入认证检查，`_session/steer` 返回方法不存在 | **0.209.1 已声明支持**，但缺少公开的首次引入记录，不能说它是“第一个版本”。当前环境无该新版要求的企业认证，因此只确认到协议声明与入口，未确认同轮模型行为 |

原始依据：
[Kimi 2.1.1 Release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.1.1)、
[Kimi PR #2514](https://github.com/MoonshotAI/kimi-code/pull/2514)、
[Kimi ACP 文档](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/reference/kimi-acp.md)；
[OpenCode v2.0.29 ACP Turn](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/acp/turn.ts)、
[ACP agent 注册](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/acp/agent.ts)；
[DeepSeek Harness alpha.3 ACP 源码](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.2.1-alpha.3/packages/acp/acp/src/session.ts)、
[官方 ACP README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/acp/acp/README.md)；
[TRAE 官方 ACP 文档](https://docs.trae.cn/cli_agent-client-protocol)、
[官方 public 发布 Manifest](https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/public/stable/latest.json)、
[TRAE 2.0 使用范围](https://docs.trae.cn/cli_about-trae-code-cli-2)。
动态页面与源码下载的 SHA-256 保存在结构化证据中，避免将以后变化的 latest 页面当作本次快照。

## Qoder 与 Antigravity 实测

Qoder 两版均在真实工具已经启动、原 `session/prompt` 尚未返回时发送补充。
结果都是先回复 ORIGINAL_028，原请求 end_turn，再回复 STEER_028_成功，并结束第二个请求。
三个候选方法 `_session/steer`、`_session/steering`、`session/steer` 均返回 -32601；没有找到当前
ACP 文档公开的其他专用插话入口。这只能证明已核验的通道和版本，不能排除未来新增方法。
1.1.71 是核查日刚发布的版本；其发布项为模型列表加载与更新体验。
[官方 ACP 文档](https://docs.qoder.com/cli/acp)、[版本记录](https://docs.qoder.com/release-notes/qoder-cli)。

Antigravity 保持与 Rovai 相同的 Stream JSON 通道，并保持 stdin 开放来排除产品关闭 stdin 的影响。
在真实工具边界插入 `event:steer` 后，CLI 记录“不支持的事件”并跳过；普通 user 补充仍分别产生
num_turns=1 和 2 的两个 SUCCESS result。另一次在同样边界发送 control_request，原轮先完成，
随后返回 ERROR，说明该事件不支持；未把它当作取消替换或同轮插话。
这与[官方 Headless 文档](https://www.antigravity.google/docs/cli/headless/)的一条 stdin prompt 对应
一轮结果，以及不支持 control_request 的说明一致。两次二进制哈希前后一致，版本均为 1.3.5。

## 本次实现与产品验证

Kiro 只改 Runtime 运输与回执匹配：queued 不是消费；匹配原生 messageId、正文、Session 和活跃
Run/epoch 后等待 injected。原生通知裁掉首尾空白，回执比较兼容这个行为，发送内容不裁剪。
不支持方法的明确拒绝可以回普通投递；写入后无法确认消费的情况不自动重发。

ZCode 在同一原 input/turn 内发送 guide，以精确 queued/drained 事件确认消费。
补充回执不会结束原 Prompt；取消与提交互斥，取消不被等待消费阻塞。发生插话的 Host 不再复用，
避免残留原生队列进入后继。修复了取消时错误等待“可复用 Host”条件的问题。
同时修复 Node owner 的 macOS EPERM 假阴性：仍须观察所有自有进程组确实不存在才确认清理；
若信号真正失败且进程仍存活，保持不确认。原信号错误继续记录，不隐藏故障。
验收还发现既有 ZCode 可用性 Probe 杀掉了同属进程树的 watcher，却仍等待该 watcher 写入清理报告，
导致真实执行可用但检查返回 stable_failure。macOS/Linux Probe 现沿用执行 Host 的自有进程树退出证据，
同时要求终止成功和主进程回收；不再依赖已被回收进程的文件。独立无模型复测返回 ready。

产品场景沿用 `scripts/smoke-steer.mjs`，使用正式 RPC、Core Scheduler、SQLite 投递证据与真实 Adapter：

- 原 Run 正在执行工具时，发送文本插话和纯附件插话；均由原 Run 消费，文件内容与来源消息精确匹配。
- 普通消息在原 Run 结束前保持 waiting，随后独立执行；没有被混入 Steer。
- 同一条多队员消息分别走支持插话的忙碌队员、不支持插话的忙碌队员和空闲队员，三条路由独立。
- 插话发送后取消原 Run，没有后继 Run，也没有要求的后续文件副作用。
- Host 收尾后检查自有进程；不启动或写入日常 Rovai 数据。

提示词、Builder、Formatter、RUN_INPUT、historyHint、消息正文、数据库 Schema、UI 均未改变。
因此没有新的上下文前后差异；已确认的 [R3 对比报告](../../versions/v1.72/model-context-change-steer-shared-input.md)继续适用。
当前运输合同为 [Message Delivery v15](../../contracts/message-delivery-v15.md)。

## 失败记录与验证范围

逐次结果见 [结构化证据](steer-kiro-zcode-2026-10-14.evidence.json)。本次产品夹具共 10 次尝试，
6 次整体通过、4 次失败；Kiro 的各场景由 full 中已通过的子场景、mixed-only 和 cancel-only 合并覆盖，未把该 full 记为整体通过。
协议探针另有 13 份报告，TRAE 被认证拦截的尝试未计为模型通过。不删除失败尝试：

- Kiro 前两次在文本回执等待超时；诊断确定是通知正文的首尾空白被原生裁去。修正匹配后文本、附件、普通队列通过。
- Kiro 后一次 full 的插话与队列验证通过，但空闲队员没有按夹具意图写入固定标记；明确夹具要求后 mixed-only 通过。该 full 尝试仍记 failed。
- ZCode 首次 full 与 cancel 通过；取消过程曾重复报告清理未确认，已修正退休 Host 的取消分支并复测。
- ZCode 一次复测在首个工具执行前由原生 Turn 报错，未达到 Steer 测试边界，保留为失败，未计作插话失败或通过。
- ZCode 原生 owner 曾出现 EPERM 后 pendingGroups=0 却 confirmed=false；清理修复的确定性测试同时覆盖信号生效后报错、真正拒绝信号，以及正常关闭。
- ZCode 产品夹具当时的 Runtime 检查返回 stable_failure；没有把这项结果写成 ready。后续定位并修复 Probe 清理判定，修复前后独立检查分别保留，补充检查不调用模型。
- Node owner 回归有一次在读取未完成的夹具文件时失败；补上子进程 close 握手后通过，未放宽 JSON 或进程归属断言。
- TRAE 0.209.1 真实模型尝试在 session/new 返回 Authentication required；没有模型消费证据。

真实模型结论限定于本机 macOS arm64、上述版本及现有配置，不冒充 Windows/Linux 的 Steer 现场验收。

## 回归与交付核对

- `cargo test --workspace`：471 passed、0 failed、1 ignored。
- ACP 扩展 owner：77 passed、0 failed、2 ignored；最终 Kiro 显式不支持方法与回执隔离 owner 单独复跑通过。
- ZCode owner：8 passed；Node 清理进程边界：2 passed、1 Windows-only skip，包含正常、迟到 EPERM、真实权限拒绝三种信号情形。
- `cargo check --workspace`、Rust 格式、JS 语法和 diff 空白检查通过。
- `pnpm docs:test`：10 passed；`pnpm docs:check` 与基于上述基线的 `docs:check:ci` 通过。

首次 workspace 回归发现基线中 Runtime 兼容登记摘要与文件不一致，未绕过该门槛；随当前兼容登记
一起更新摘要后，全量重跑通过。本次只扩展已有 Rust 合同 owner，没有新增或删除 Rust 测试。
