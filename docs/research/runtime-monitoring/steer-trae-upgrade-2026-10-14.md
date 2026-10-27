---
document_type: research-report
authority: observed-runtime-evidence
status: completed
last_updated: 2026-10-14
---

# TRAE CN 升级与 Steer 支持边界复核

范围：User seq32（`800a971c-85e3-4baf-b315-2b66691bb8bc`），macOS arm64，
基线 `2f57544e26cfcffdb00a9822dd59270f31e2e02f`。本轮授权升级本机 TRAE CN，并继续使用真实 LLM。

**TRAE CLI 已由 0.120.52 升级至官方 public 0.209.1，企业登录成功，ACP 同轮 Steer 真实模型验证通过。**
本轮没有新增 Rovai 的 TRAE Steer 投递分支；产品支持数量仍为八种。
同时修正了新版 CLI 的全局参数顺序，确保可用性检查与正式执行遵守同一启动规则。

## 本机升级与登录

- 使用 [TRAE 官方安装脚本](https://trae.cn/trae-cli/install_v2.sh) 与
  [public stable Manifest](https://lf-cdn.trae.com.cn/obj/trae-com-cn/trae-cli/v2/public/stable/latest.json)。
  核查时 latest 为 0.209.1，发布时间 2026-10-10；没有证据表明这是首次支持 Steer 的版本。
- 新版安装为 `~/.local/bin/traex`；原有 `traecli`、`trae-cli`、`trae-agent`、`ta` 别名更新到新版。
  旧二进制和旧 YAML 保留，另有私有备份；没有删除其他软件或原生历史。
- 执行官方 `traecli migrate`。工具迁移了模型、工具规则与原生历史，但跳过旧 YAML 的
  `trae_login_base_url`，企业登录态也未自动继承。将原值补入新 TOML 后，走官方企业 SSO，
  继续使用浏览器已有账号完成授权；`traecli login status` 返回成功。
- 旧报告的“当前环境无该新版要求的企业认证”表述过宽。准确说法是：**当时的隔离探针未取得新版
  可用的认证**。这不能证明本机没有企业账号或旧版登录态。原失败记录继续保留。

原生升级与登录按用户指令作用于本机；后续协议和 Core 验收使用独立 `TRAE_HOME`、项目、
Core data、Skill Library、MCP 与缓存目录。只复制本次所需的原生配置及 CLI 认证，不复制用户历史。
凭据、企业配置值、浏览器账号和私有 wire 不进入本报告或公开附件。

## ACP 同轮实测

通过安装后的 `traecli` 启动官方 `acp serve`，使用企业配置中的 GLM-5.3。
只测试 Rovai 所用的 ACP 通道，没有改用其他 SDK、HTTP 或 IDE 内部接口。

| 边界 | 实际观察 |
| --- | --- |
| 握手 | ACP v1，agent 版本 0.209.1；顶层 `_meta.steering.supported:true` |
| 原任务 | `session/prompt` 要求读取并执行可控等待脚本，结束后回复 `ORIGINAL_032` |
| 插话时点 | 已观察到脚本创建 ready 文件；原 `session/prompt` 尚未返回 |
| 插话请求 | `_session/steering`，参数为同一 `sessionId` 与 `prompt:[{type:"text",text:…}]` |
| 回执 | `{outcome:"injected"}`，位于原 prompt 终态之前 |
| 模型行为 | 原轮回复 `STEER_032_成功`，没有回复旧标记；随后原 prompt 返回 `end_turn` |
| 重启 / 取消替换 | 没有发送第二个 `session/prompt`，没有发送 cancel，也没有新建后继 Session |

这是一次真实模型正向尝试，证明该版本的 ACP 可以同轮注入文本。它不代替 Rovai 产品层的多队员、
纯附件、取消竞态和输入回执验收，也没有把协议声明直接计作产品支持。
逐次结果与摘要见[结构化证据](steer-trae-upgrade-2026-10-14.evidence.json)。

## 升级发现的启动兼容问题

原调用：

```text
traecli acp serve --permission-mode default
```

新版直接拒绝 `--permission-mode`。根据[官方 ACP 参数说明](https://docs.trae.cn/cli_agent-client-protocol)，
全局参数必须放在子命令前；本轮同时修正 Runtime 执行和 Health/Dispatch Probe：

```text
traecli --permission-mode default acp serve
```

保留配置中的实际权限值，只调整顺序；没有放宽权限或增加版本特判。
保留的 0.120.52 二进制也用新顺序完成 ACP initialize，避免仅修好新版却破坏旧版。
原有三个测试 owner 覆盖正式启动、Warm Host 复用计数与 Availability/Dispatch 启动约束；
不新增或删除 Rust 测试。

Rovai 日常 App 没有安装或重启。上述启动修正在本任务分支；日常 App 需要采用该修正的构建，
才能使用新版 TRAE 的正式执行路径。不能把本机 CLI 升级等同于日常 Rovai App 已更新。

## 官方产品能力与 Rovai 接入通道

| Runtime | 官方产品 / 版本依据 | Rovai 当前通道结论 |
| --- | --- | --- |
| Kimi Code | 2.1.1 ACP；steering 提案未合并 | 当前 ACP 暂不支持；不能外推为所有产品接口或未来版本都不支持 |
| OpenCode | 本机 2.0.25 ACP；源码核查至 v2.0.29 仍拒绝重叠 prompt | 当前 ACP 暂不支持；HTTP 内部能力不计入当前接入范围 |
| DeepSeek Harness | 官方 ACP profile：实测 alpha.1，源码核查至 0.2.1-alpha.3 | 当前官方 ACP 暂不支持；第三方 ACP 包不作为官方接入证据 |
| Qoder | **官方 IDE 有 Steer**；1.10.1（2026-06-23）发布记录明确新增该功能，当前界面文档也说明 Steer 按钮 | CLI 1.1.65、1.1.71 的 ACP 实测仍先结束原轮，再处理补充；三个候选扩展均不存在 |
| Antigravity | 官方交互界面提供 Artifact 评论反馈 / steering；文档描述了中间节点暂停审阅，不能直接等同于同轮消息注入 | 官方 CLI 1.3.5 的当前 Stream JSON 接口未通过同轮注入；普通 user 是后继轮，未知 steer 被跳过，control_request 不支持 |
| TRAE CN | 官方 CLI 0.209.1 ACP **本次同轮通过** | 原生通道已证明可接入；Rovai 的 Steer 投递尚未实现 |

Qoder 依据：[IDE 1.10.1 发布记录](https://docs.qoder.com/zh/release-notes/desktop)、
[界面工具与排队 / Steer](https://docs.qoder.com/zh/user-guide/chat/tools)、
[CLI ACP 文档](https://docs.qoder.com/cli/acp)。不应将“Rovai 当前 ACP 未支持”写成“Qoder 官方版本都不支持”。

Antigravity 的[官方 Artifact 文档](https://antigravity.google/docs/artifacts)明确提供交互式 steering 与反馈，
其描述包含中间节点暂停审阅；[官方产品示例](https://antigravity.google/use-cases/marketer)也介绍了执行期间的评论反馈。
本轮没有做官方界面的同轮消息注入验收，不将这些描述当作 ACP / Stream JSON 输入消费证明。

当前接入依据：[官方 Headless / Stream JSON 文档](https://www.antigravity.google/docs/cli/headless/)。
文档要求等待当前 result 后再发下一条 prompt，逐条 user 对应不同轮，并列出未知事件和 control 事件的处理方式。
这和此前官方 CLI 实测相符；**不足以断言整个官方产品没有任何引导或反馈功能**。
本轮没有重复运行未升级的 Qoder / Antigravity 模型测试；实测版本、逐次 wire 结论继承
[seq30 报告](steer-kiro-zcode-2026-10-14.md)，Kimi / OpenCode / DeepSeek 的官方源码依据也在该报告中。

## 完整产品清单

| Rovai 状态 | Runtime |
| --- | --- |
| 已接入并通过先前产品实测（8 种） | Codex、Claude Code、Pi、CodeBuddy、Qwen Code、Grok Build、Kiro CLI、ZCode |
| 当前接入通道同轮通过，产品待适配（1 种） | TRAE CLI CN 0.209.1 |
| 已核验的当前通道暂不支持（6 种） | Kimi Code、OpenCode、DeepSeek Harness、GitHub Copilot、Qoder、Antigravity |
| 用户要求排除 | Cursor、Cline、Command Code |

本轮没有改动提示词、Builder、Formatter、RUN_INPUT、消息存储或 UI；没有新增上下文差异。

## 验证与保留的失败

- 修正前两次隔离 Core 检查均未就绪；修正后 `runtime.product.check` 返回 `ready:true`，
  snapshot 为 `ready`，版本为 `traecli 0.209.1`，Core 正常退出。
- 正式普通消息执行使用现有 `smoke-acp-runtime.mjs` 的单轮模式及产品默认权限，返回
  `ROVAI_TRAE_ACP_OK`。首次模型执行通过，但夹具放在 `/tmp`，不属于该机器的系统临时目录，
  收尾安全检查拒绝清理，整体退出 1；未算作整体通过。改用系统临时目录的新夹具后完整退出 0。
- TRAE 相关扩展回归：首次 9 passed、1 failed、1 ignored，失败是 Warm Host owner 仍按旧参数顺序
  计数；更新该断言后 10 passed、0 failed、1 ignored。ignored 是独立人工原生 Smoke，
  本次真实验证使用上述隔离 Core 与协议夹具，不将 ignored 算作通过。
- 原生 ACP 正向尝试共一次；没有将失败的认证探针、Core 可用性检查或普通消息验证算作 Steer 正向次数。
- `cargo test --workspace`：471 passed、0 failed、1 ignored；Rust 格式与 diff 空白检查通过。
- `pnpm docs:test`：10 passed；`pnpm docs:check` 和以本轮基线运行的 `docs:check:ci` 通过。
- 验收结束后移除六份隔离认证副本，保留本机正式登录；所有本次 Runtime 进程已结束，隔离 Runtime Files 已清理。

没有新增或删除 Rust 测试；没有更改权限值、接收者路由、Steer 回执状态或共享上下文。
