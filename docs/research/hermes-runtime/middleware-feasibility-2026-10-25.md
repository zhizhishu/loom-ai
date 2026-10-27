---
document_type: research-note
authority: non-normative
status: experimental
last_updated: 2026-10-25
---

# Hermes 原生中间件注入 CLI 环境：可行性边界

User sequence 54 要求不补丁 Hermes、不扩展 ACP、不创建生产私有 Home，先证明执行归属，再接入真实
CLI 授权。本轮使用未修改的官方 0.22.4 源码，完成原生标识观察、无权限环境注入及前后台终端探针。

**命令改写和变量注入成立；原生执行与 Core Run 的可靠绑定尚未成立。因此没有提供真实 CLI context，
没有把 `rovai send`、Run 轮换或完整协作接入标为通过。** 这是探索结束于明确缺口，不是生产切换。
生产源码、正式能力声明、B/P 投递、压缩策略及旧 Home 数据均未改动。

## 基线与交付

- Rovai 基线：`ba136f0ca2778f3c85c02eb64484ebb648121730`；本轮只新增研究资料。
- Hermes：0.22.4，固定源码 `4d04303818b61bf3aa09278af48356315515965b`；最终探针中的独立 clone
  在运行前后没有 tracked 改动。没有应用此前的上游环境补丁或 ACP `_meta` 扩展。
- macOS arm64，本机 `terminal` / `/bin/bash`，`terminal.persistent_shell: true`。
- 插件 0.1.0：[manifest](middleware-probe-plugin/plugin.yaml)、[实现](middleware-probe-plugin/__init__.py)。
  只注册现有 observer 与 `tool_request`，不 monkey-patch、不直接调用业务 CLI、不另行执行终端。
- [可复现探针](middleware-feasibility-probe.mjs)、[脱敏结果与标识样本](middleware-feasibility-2026-10-25.json)。
  原始模型 wire、ACP frames、配置快照及日志只留在临时夹具。

所有 ACP 客户端共用同一临时环境的一份原生 `.hermes`，Gateway 先启动。模型为本机受控 Responses
端点，无付费模型。夹具中的场景名称只决定测试模型返回哪些工具调用，绝不参与权限绑定。
两个 ACP 会话不等于两个真实 Core 成员；本轮没有启动 Core，故没有需要接入的 Core 授权补丁。

## A：原生标识存在，但缺少到本次 Core 输入的连接

| 字段 | 本次真实调用的观察 | 能否直接作为 Run 绑定 |
| --- | --- | --- |
| `session_id` | 不同会话不同，冷恢复及续轮不变 | 不能区分同 Session 的不同 Run |
| `task_id` | Gateway 路径中等于 Session ID，下一轮仍相同 | 不是逐 Run 身份 |
| `turn_id` | 同一轮两次工具调用一致；下一轮变化 | 插件可见，但观察阶段 ACP 不传出此值 |
| `api_request_id` | 同一轮不同模型调用变化，包含 turn 前缀 | 不是整次已接受输入的标识；ACP 不传出 |
| `tool_call_id` | 插件与 ACP 工具通知均有同一值 | 关联某次工具通知，不证明是哪个客户端提交的输入 |
| admission / native request ID | 原生 admission 表有独立字段 | ACP 内部生成/消费；本次标准响应没有暴露给 Core |

这里没有将 `turn_id` 与 admission ID 视为同一概念。原生 `turn_id` 在执行入口生成，工具回调从 Agent
当前字段读取；是否能在旧执行、子任务、压缩和恢复的全部路径中作为冻结身份，还需独立验证。

**反例：只 `session/load`、从未提交 prompt 的第三个 ACP 客户端，收到了另一个客户端任务的相同
`toolCallId`。** 因此把“本连接收到该 Session 的工具通知”解释为“属于本连接当前 Run”没有依据。
源码的 `_project_tool()` 将原生 admission 用于内部记账，向 ACP 发送的仍是 Session/tool 投影。
`tool_request` 又处于原生检查、审批与实际工具启动之前；不能把稍后的通知当成已完成的首次工具前绑定。

已核对的链路：

- [ACP `_prepare_submit()` / `prompt()`](https://github.com/NousResearch/hermes-agent/blob/4d04303818b61bf3aa09278af48356315515965b/acp_adapter/gateway_server.py)：内部生成 input ID、处理 admission，终态返回 stop reason / usage。
- [ACP 工具投影](https://github.com/NousResearch/hermes-agent/blob/4d04303818b61bf3aa09278af48356315515965b/acp_adapter/gateway_reply.py)：工具通知不附带本次 ACP 请求或 admission。
- [原生 turn 身份](https://github.com/NousResearch/hermes-agent/blob/4d04303818b61bf3aa09278af48356315515965b/agent/turn_context.py)与[Gateway turn task](https://github.com/NousResearch/hermes-agent/blob/4d04303818b61bf3aa09278af48356315515965b/gateway/run_turn.py)。

读取原生数据库能看见 admission，并不能补出 Core 本来没有拿到的本次请求关联；本轮只做只读诊断，
没有用正文、时间、工作目录、Session 最新值或“只有一个 Run”去决定授权。也没有加入私有 ACP 字段、
隐藏 prompt 标记、执行等待代理或新的身份握手系统。结论限定为**在本次原生公开链路与约束下未建立绑定**，
不声称所有未来插件接口都不可能做到。

## B：注入机制成立，同时复现快照与可见性问题

插件给选中的测试会话注入原生 turn 标记，以及不存在的 `no-authority/.../context.json` 路径。
这些路径没有凭据、没有有效 Core endpoint，也不被包装成真实 Run 绑定。未选中的普通原生会话不改写命令。

实测结果：

1. 两会话并发，各自终端读到自己的原生 turn 标记；引号、美元符号、空白和换行经过 Shell 转义后保持原值。
2. 本机后台终端的 `background`、`timeout`、`workdir` 保留。后台命令在下一原生轮开始后才继续运行，
   仍持有启动时的旧标记；新轮获得新标记。**这只验证已启动进程，不验证旧执行后来新建工具。**
3. 直接前置 `export` 会被持久 Shell 快照保存。插件改为不注入后，旧 `ROVAI_CLI_CONTEXT` 仍可读；
   原生禁用插件并热重载后也仍可读。不能仅靠插件停用或找不到绑定来保证旧环境消失。
4. 实验性子 Shell 包裹 `(...)` 可以隔离这次注入，但也丢失原命令有意执行的 `export`。
   本轮没有将这种行为变化定为方案，也没有关闭原生持久 Shell 或补丁 snapshot。
5. 中间件故意抛异常后，原生仍执行原命令。插件不能充当可靠的授权拒绝关口。

[原生命令快照](https://github.com/NousResearch/hermes-agent/blob/4d04303818b61bf3aa09278af48356315515965b/tools/environments/base_session_env.py)
在命令后保存导出变量；[中间件合同](https://hermes-agent.nousresearch.com/docs/developer-guide/middleware)
明确了改写先于检查/审批，以及异常继续执行的语义。前述问题已用实际执行验证，没有仅凭文档推断。

### 模型与审批看到什么

最终探针捕获了 5 次包含注入路径的原生命令风险评估模型请求，以及 6 次包含路径的 ACP 审批请求；
ACP 工具展示也包含改写命令。未在该夹具的其他模型请求中发现注入路径；不能扩大为所有工具/错误路径的保证。
模型最初返回的命令仍是普通命令，客户端没有给它追加专用 CLI 路径，但**改写内容会进入后续原生风险评估**。

没有发送 token 或 `context.json` 正文；本轮根本未创建授权文件。结论不是“凭据已泄露”，而是不能宣称
执行侧路径完全不进入模型、日志或展示。若以后采用，必须保留这个区别并继续测试真实授权路径的可见面。

## C：真实授权验收因前置绑定缺口未进入

| 验收 | 本轮结果 |
| --- | --- |
| 两会话、本机前台和后台变量注入 | 无权限标记通过 |
| 原 Session 冷恢复及新的原生 turn | 通过 |
| 两个真实 Core 成员直接 `rovai send` | 未执行；没有可靠关联就不提供有效授权 |
| 下一 Run 正确 lease，旧路径和旧凭据副本拒绝 | 本路线未执行；此前上游补丁实验不能挪用 |
| 旧执行在下一 Run 后新建工具 | 未验证；后台进程保留旧标记不替代此项 |
| 插件未加载/绑定缺失/异常 | 无注入及异常继续执行已观察；有效凭据串用防护未取得资格 |
| 普通用户 Hermes 会话并存 | 选中会话之外未改写、无标记；仍是隔离环境中的原生会话 |
| 自动压缩、execute_code、直接 subprocess、子智能体、managed worker | 未验证，不通过关闭这些能力补齐 |
| Run/Core 结束与授权撤销 | 未运行 Core；只观察 ACP 退出后共享 Gateway 继续存活 |

## 采用条件与文件变化

插件不是零安装。需要安装 `plugins/rovai-middleware-probe/` 中两个文件，并用原生配置显式启用；
探针另在 `plugins.entries.rovai-middleware-probe.settings.probe_root` 指定其私有观察目录。
该字段是实验日志位置，不包含 CLI 凭据。真实产品若仍要求用户配置绝不变化，此路线存在采用障碍。

第一次探索实际执行了官方 `hermes plugins enable`：修改插件配置并热加载已有 Gateway。
最终可复现脚本显式编辑隔离配置的原生 `plugins.enabled/disabled`，再调用官方
`reload_gateway_plugins()`；没有绕过插件发现或直接向注册表塞回调。启用和禁用均不需要本次 Gateway 重启，
普通任务前后配置 hash 相同，`.env` 未变。不同版本、plugin host 隔离模式和其他执行路径未取得同样保证。

插件的配置变化与原生正常会话/日志/快照写入分开记录。最后由夹具停止自己创建的 Gateway；
ACP 客户端退出本身没有停止它。没有用此实验宣称解决共享 Gateway 的逐 Run 回收。

### 夹具隔离修正

早期一次探针把依赖缓存链接到了已有安装。官方插件启用会准备 PM runtime，导致共享缓存中出现新一代
依赖及 `selected.json` 更新。发现后已恢复唯一的此前选择，并在原生准备锁下确认新一代没有 lease，
将仅由本探针创建的那一代移入临时证据目录。日常 Hermes 源码、插件选择和用户配置没有修改。
这项意外缓存写入不是“全程零写入”，已在脱敏证据中保留。

最终脚本使用干净源码 clone、已有测试解释器和完全独立的 Home，不再链接可写日常安装缓存，不运行
依赖安装/更新。复制的 `install-stamp.json` 仅来自同一基线，是 ignored 版本元数据；没有改写 tracked 源码。

## 复现与检查

在本仓库已安装 Node 依赖、存在与基线兼容的 Hermes 测试解释器时：

```sh
node docs/research/hermes-runtime/middleware-feasibility-probe.mjs \
  /absolute/path/to/unmodified/hermes-agent \
  /absolute/path/to/prepared/hermes-test-python
```

脚本只接受绝对路径，打印一次性 fixture；源 checkout 应有真实同版本 `install-stamp.json`。
脚本启动原生 `hermes_cli.main` / ACP，配置本机响应端点，不修改用户启动器。
原始日志含临时路径，只发布脱敏证据。原生方法的调用没有被测试替身替换。

最终完整探针完成 15 次原生 prompt、19 条观察断言，包括“残留存在”“异常后继续执行”等边界事实，
不能把这些数字称为 19 项产品能力通过。前一版同样完成前后台流程，最终版本另明确断言观察阶段 ACP
缺失 turn ID。已执行 Node 语法检查、Python 编译检查、证据/插件 hash 核对、`git diff --check`；
`pnpm docs:test` 10 项通过，`pnpm docs:check`、以 PR base 执行的 `pnpm docs:check:ci` 通过。
本轮没有生产 Rust 改动，不运行或宣称新的 Rust 全量回归、真实付费模型、压缩矩阵或其他平台验收。

**采用结论：可以保留为中间件机制研究，尚不能选作逐 Run CLI 身份运输方案。** 下一步需要解决的是
可在首次工具之前取得的、不会随下一 Run 改变的请求/执行关联；Shell 快照和路径可见性也仍需明确方案。
在这些条件满足前，不扩大生产改造、不用 Session 最新值或此前上游补丁的成功结果填补缺口。
