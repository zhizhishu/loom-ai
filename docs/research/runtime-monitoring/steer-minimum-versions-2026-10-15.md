---
document_type: research-report
authority: observed-runtime-evidence
status: completed
last_updated: 2026-10-15
---

# Qoder 本机升级复测与 Steer 版本清单

范围：User seq34（`2c16d225-ec63-4d45-9997-b17aefb88df4`），macOS arm64，
基线 `251117f0124f1992f63fd1c334443283a57a9998`。只按 Rovai 实际接入通道判断，
继续排除 Cursor、Cline、Command Code。

**Qoder 已从 1.1.65 升级到官方当前原生版 1.1.71；真实 LLM 复测仍是下一轮处理补充消息，未通过同轮 Steer。**
Rovai 产品已接入的八种 Runtime 不变，TRAE 仍为通道已验证、产品待适配。

## Qoder 升级与真实复测

执行官方 `qodercli update --check` 和 `qodercli update`，更新源返回 1.1.71，安装成功。
当前入口仍为 `~/.local/bin/qodercli`，指向 `~/.qoder/bin/qodercli/qodercli-1.1.71`；
旧二进制保留，并另存私有备份。没有改写用户原生模型配置或要求重新登录。
这是本机官方原生包；seq30 的 1.1.71 是隔离下载的 npm 包，两次证据不混用。

按[官方 ACP 启动方式](https://docs.qoder.com/cli/acp)使用 `qodercli --acp`。
自动验收采用独立原生 Home、项目与工具夹具；Core 检查另用独立 data、Skill Library、MCP 和缓存目录。
真实模型沿用本机配置的 `gpt-6.1-sol`，没有修改日常 Rovai App。

| 步骤 | 本次观察 |
| --- | --- |
| 原任务 | 读取并运行可控等待脚本，结束后回复 `ORIGINAL_034` |
| 插话时点 | 脚本已生成 ready 文件，原 `session/prompt` 仍未返回 |
| 专用接口 | `_session/steer`、`_session/steering`、`session/steer` 均返回 `-32601 Method not found` |
| 并发普通输入 | 在同一 Session 发送第二个 `session/prompt`，要求改为回复 `STEER_034_成功` |
| 实际顺序 | 原轮回复 `ORIGINAL_034` → 原请求 `end_turn` → 补充回复 `STEER_034_成功` → 第二个请求 `end_turn` |
| Rovai 检查 | `runtime.product.check` 为 `ready:true`，snapshot 为 `ready`，报告版本 1.1.71，隔离 Core 正常退出 |

本轮真实模型实验为一次、含两个 prompt。结果证明补充落在后继轮；不能因为最后出现了新标记就计为 Steer 通过。
原生包 SHA-256、关键事件顺序和检查结果见[结构化证据](steer-minimum-versions-2026-10-15.evidence.json)。
[官方 CLI 发布记录](https://docs.qoder.com/release-notes/qoder-cli)中，1.1.71 发布于 2026-10-14，
更新项是模型列表与更新体验，没有宣布 ACP Steer。IDE 1.10.1 的 Steer 版本不能作为 CLI ACP 的最低版本。

## 完整清单

“协议门槛”指当前 Rovai 投递代码依赖的接口或字段，不代表该旧版本已完成完整产品验收。
“首次支持”只在发布记录和版本产物能互相印证时填写；本机实测版本不冒充最低版本。
除 Qoder 外，下表真实 LLM 版本继承 seq28–32 的验收，本轮主要做版本源码、发布包与协议边界核查。

| Runtime | Rovai 当前通道 | 最低版本核查结论 | 已有真实 LLM 通过版本 | 产品状态 |
| --- | --- | --- | --- | --- |
| Codex | app-server `turn/steer` | 首次版本未锁定；官方当前文档没有首发版本号 | 0.162.1 | 已接入 |
| Claude Code | Stream JSON 追加 user 与输入回显 | 完整最低版本未锁定；不能把交互界面首发版本当作当前接线门槛 | 2.1.287，sub2api | 已接入 |
| Pi | 原生 RPC `steer` | **当前接线所需协议从 0.99.0 齐备**；命令本身始于 0.32.0 | 1.1.0 | 已接入 |
| CodeBuddy | ACP 并发 `session/prompt` | 首次版本未锁定；保留已验证版本。2.140.0 是另一通道新增功能 | 2.133.1 | 已接入 |
| Qwen Code | ACP `craft/drainMidTurnQueue` | **当前结构化投递从 0.18.4 可匹配**；旧字符串接口始于 0.18.0 | 0.25.0 | 已接入 |
| Grok Build | ACP stdio `_x.ai/interject` | **Rovai 整体接入门槛 1.0.0**，同版本源码已含此接口；不是 Steer 首发版本 | 1.0.50 | 已接入 |
| Kiro CLI | v2 ACP `_session/steer` 与注入事件 | 2.7.0 发布插话、原生包新增接口；旧版探针未取得成功回执，完整最低版本未确认 | 2.21.1 | 已接入 |
| ZCode | 官方 App 内核 app-server `sendText` / guide | 首次内核版本未锁定，不能用界面版本替代内核协议版本 | App 3.14.5 / 内核 0.16.9 | 已接入 |
| TRAE CLI CN | ACP `_session/steering` | 首次版本未锁定；0.209.1 已通过，旧 0.120.52 不支持 | 0.209.1 | 通道通过，产品待适配 |
| Qoder | ACP | 未找到已支持版本；本机升级到 1.1.71 后仍为后继轮 | 无；1.1.65、1.1.71 为负例 | 暂不支持 |
| Kimi Code | ACP | 无已确认版本；2.1.1 不支持，已有 steering 提案未合并 | 无 | 暂不支持 |
| OpenCode | ACP | 无已确认版本；2.0.25 实测拒绝，源码核查至 v2.0.29 仍有 busy guard | 无 | 暂不支持 |
| DeepSeek Harness | 官方 ACP profile | 无已确认版本；0.2.1-alpha.1 实测拒绝，alpha.3 源码仍有 inflight guard | 无 | 暂不支持 |
| GitHub Copilot | 官方 ACP | 无已确认版本；1.0.83 / ACP launcher 1.0.91 实测为取消原轮后替换 | 无 | 暂不支持 |
| Antigravity | 官方 CLI Stream JSON | 无已确认版本；1.3.5 普通输入为后继轮，steer 被忽略，control 不支持 | 无 | 暂不支持 |

负例只覆盖表中的通道与版本，不推断这些产品的所有界面或未来版本都不支持。
原有十五种通道实测及六种负例依据见[seq28 清单](steer-current-transport-2026-10-14.md)、
[seq30 源码与产品验收](steer-kiro-zcode-2026-10-14.md)和[seq32 TRAE 复核](steer-trae-upgrade-2026-10-14.md)。

## 版本依据与容易混淆的边界

### Pi：命令存在不等于当前投递能完成

[官方 changelog](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/CHANGELOG.md)
记录 0.32.0 将 RPC `queue_message` 拆分为 `steer` / `follow_up`；0.84.4 增加 `clear_queue`；
0.99.0（2026-09-29）才为 RPC 输入回执增加 disposition。
[0.87.0 源码](https://github.com/earendil-works/pi-mono/blob/v0.87.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
的 steer 成功回执没有该字段，
[0.99.0 源码](https://github.com/earendil-works/pi-mono/blob/v0.99.0/packages/coding-agent/src/modes/rpc/rpc-mode.ts)
会返回它；Rovai 的 `pi/host.rs` 明确要求 `data.disposition == "queued"`，然后再等消费证据。

因此 **0.99.0 是当前 Steer 接线的协议门槛**。代码中 0.84.4 的整体 Runtime 门槛只代表普通接入要求，
不足以证明 Steer 可用；不能向低于 0.99.0 的旧版用户宣称当前接线已兼容。
本轮没有把整体门槛直接升高，以免连普通执行一起禁止；0.99.0 历史版本没有另做真实模型全量验收。

### Qwen：同名方法也有两个回包格式

[PR #4728](https://github.com/QwenLM/qwen-code/pull/4728)于 2026-06-09 合入 ACP drain 方法。
官方 v0.17.1 源码和 npm 发布包均无该方法，v0.18.0 两者均已有；0.18.0 为 2026-06-12 发布的首个稳定版本。
更早的 0.14.1 / [PR #2854](https://github.com/QwenLM/qwen-code/pull/2854)修改的是终端 UI，不能算作 ACP 首发。

在 [v0.18.3](https://github.com/QwenLM/qwen-code/blob/v0.18.3/packages/cli/src/acp-integration/session/Session.ts)，
原生只读取 `{messages:["文本"]}`；
[v0.18.4](https://github.com/QwenLM/qwen-code/blob/v0.18.4/packages/cli/src/acp-integration/session/Session.ts)
新增 `{items:[{content:[{type:"text",text:"…"}]}]}` 解析。相邻两个官方 npm 发布包也核对了同一差异。
Rovai 当前发送后一种结构，因此协议门槛是 **0.18.4（2026-06-20）**，而非 0.18.0。
本轮没有改为兼容旧格式，也没有将源码对照标成旧版真实模型通过。

### Grok：可确认 1.0.0 具备接口，但不能称其首次支持

[官方发布记录](https://x.ai/changelog/build)早在 0.2.8 就记录了队列的 interject 操作，
但界面操作不能独立证明 ACP 私有方法的首发版本。
固定官方提交 `afbc0fb710320c7add294c2106d447ecc3e3af2e` 的
[版本文件](https://github.com/xai-org/grok-build/blob/afbc0fb710320c7add294c2106d447ecc3e3af2e/crates/codegen/xai-grok-shell/Cargo.toml)
为 1.0.0；同一提交的[方法处理器](https://github.com/xai-org/grok-build/blob/afbc0fb710320c7add294c2106d447ecc3e3af2e/crates/codegen/xai-grok-shell/src/extensions/interject.rs)
接收 sessionId/text，把输入加入运行中缓冲，返回 queued。
结合现有 Rovai 1.0.0 整体门槛，可记录此协议下界；完整真实模型证据仍是 1.0.50。

### Kiro：2.7 是功能发布边界，历史 ACP 成功尚未证明

[官方 2.7.0 发布说明](https://kiro.dev/changelog/cli/2-7/)于 2026-06-12 宣布工具边界插话。
本轮下载官方 2.6.0、2.7.0 macOS 安装包，只读挂载，复制 CLI 到独立临时目录；未安装或替换本机 Kiro。

- 2.6.0：ACP initialize 成功；`_session/steer` 返回 Method not found，原生包没有对应方法和 queued/injected 事件符号。
- 2.7.0：原生包出现该方法与 queued/injected/cleared 符号；initialize 和新建隔离 Session 均成功。
  无效 Session、空参数及 idle Session 的三个 steer 探针均未在 15 秒内取得回执。
- 这些探针没有运行模型任务，不能算作同轮 Steer 成功，也不能将超时外推为活跃轮必然失败。
  因而保留“2.7 首发线索、2.21.1 真实通过、完整最低版本未确认”。

[官方 V3 ACP 迁移文档](https://kiro.dev/docs/cli/v3/acp-migration/)也说明 v2/v3 启动参数、能力协商和事件格式不同。
本清单沿用已接入的 v2 通道，不自动把新版 V3 归入已通过范围。

### 尚不能精确定位首发的四种已接入 Runtime

- **Codex**：按 OpenAI Docs 查询了[官方 App Server 文档](https://learn.chatgpt.com/docs/app-server)
  与[官方 changelog](https://learn.chatgpt.com/docs/changelog)。可以确认指定活跃 turn 的接口语义，
  未获得足以锁定首次发布版本的官方版本证据，因此保留 0.162.1 真实通过值。
- **Claude Code**：[官方 changelog](https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md)
  在 0.2.108 介绍实时引导、1.0.86 增加输入回显、1.0.109 记录 partial-message streaming。
  官方 1.0.86 包已有回显和运行中队列桥接，却没有 Rovai 必传的 `--include-partial-messages`；
  1.0.108 发布包已经包含该参数，说明不能机械地拿 1.0.109 发布说明当首次实现边界。
  全部启动参数、输入回执和同轮消费的历史下界尚未闭合，保留 2.1.287 / sub2api 的真实通过值。
- **CodeBuddy**：读取官方站点中至 2.143.1 的 319 份可用历史发布页，未找到当前并发 `session/prompt`
  首次支持的明确声明。[2.140.0](https://www.codebuddy.ai/docs/cli/release-notes/v2.140.0)
  新增的是 Stream JSON control steer；[2.143.1](https://www.codebuddy.ai/docs/cli/release-notes/v2.143.1)
  改进专用 ACP steer 的消费通知与目标轮约束。这些不能替代当前已验证的 2.133.1 并发 prompt 路径。
- **ZCode**：[官方 App 发布页](https://zcode.z.ai/cn/changelog)没有给出 guide 线协议与内核版本的首发映射。
  保留 App 3.14.5 / 内核 0.16.9 的配对实测，不根据 App 的界面更新反推内核最低版本。

TRAE 的[官方 ACP 文档](https://docs.trae.cn/cli_agent-client-protocol)与
[企业更新日志](https://docs.trae.cn/enterprise_release-notes)同样没有明确给出 `_session/steering` 首发版本。
0.209.1 是已验证版本；0.120.52 的失败只构成一个旧版负例，不能据此声称中间所有版本都不支持。

## 收口与验证

本轮变更为版本研究、兼容性记录与其绑定摘要；没有更改 Runtime 投递、整体版本门槛、提示词、RUN_INPUT、消息结构或 UI。
本机仅升级 Qoder，保留配置及旧版；Kiro 历史安装包只用于隔离协议探针。
公开证据只包含版本、接口结果、产物摘要和来源，不包含认证副本、原始 wire、账号配置或模型服务地址。
`pnpm docs:test` 为 10 passed；`docs:check` 与按本轮基线运行的 `docs:check:ci` 通过。
兼容性摘要的既有 Rust owner 为 1 passed、0 failed；diff 空白检查通过。没有新增或删除 Rust 测试，
也没有把未重跑的完整 workspace 测试算作本轮通过。两份 Qoder 隔离认证 / 配置副本已移除，
Kiro 历史 DMG 和临时二进制已清理；本机 Qoder 配置、登录与旧二进制保留。
