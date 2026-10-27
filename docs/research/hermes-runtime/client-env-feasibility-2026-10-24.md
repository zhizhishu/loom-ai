---
document_type: research-note
authority: non-normative
status: experimental
last_updated: 2026-10-24
---

# Hermes ACP 客户端环境：上游最小修复可行性

User sequence 50 明确保持 CLI，不切 MCP，也不把逐 Run 向模型提供专用 CLI 包装路径作为正式方案。
本次结论：**方向可行，隔离开发原型已通过真实 Core、两个成员、两轮 `rovai send` 与旧 lease 拒绝验证。**
这不是未修改的 Hermes 已支持，也不是 R2 原生 Home 切换已经完成。生产启动路径、当前合同与正式能力声明未变。

## 上游关联与必要区别

- 环境缺口关联 [Issue #142671](https://github.com/NousResearch/hermes-agent/issues/142671)：
  ACP 没有像 CLI/TUI 一样把客户端环境交给已有 Gateway；只给 ACP 进程设置环境，不能改变工具端环境。
  2026-10-24 核对时仍 open；这次只读取上游，没有代 User 发布 Issue 评论或 PR。
- [PR #142008](https://github.com/NousResearch/hermes-agent/pull/142008)，核对 head
  `a826108edf7a6d9686b53df7a1cb1278047dcb16`，仍未合并。参考的是在子进程启动处注入，以及避免 shell
  snapshot 覆盖新值；没有安装其 plugin，也没有修改用户插件配置。
- 该 PR 的 resolver 按 Session ID 查询。Session 在下一 Run 仍相同，因此“查询该 Session 最新值”
  不足以区分旧执行和新 Run。旧执行稍后启动子工具时，也可能查到新权限。
- 现有 `session_client_env` 的环境冻结在 Session policy 中。仅让 ACP 在 `session/new` 填上此字段，
  可以修第一次传递，却不能单独完成原 Session 的 Run 身份轮换。

需要固定的是：**本次已接受任务的工具环境快照**，而不是整个 Session 永久不变的环境，或 Session 的当前最新授权。

## 原型改动及复用边界

开发原型在现有函数内接通以下路径，没有新数据库表、常驻代理、轮询或全局环境改写：

```text
Core 为本 Run 配置的 ACP 环境
  → ACP prompt 声明需要传递的变量名称
  → ACP 从自身环境取值
  → 原有 prompt admission 保存环境快照与请求身份
  → 原有执行 ContextVar 绑定该快照
  → 工具启动时注入，并从 shell snapshot 中排除这些名称
```

1. 在 `agent/session_client_env.py` 复用现有有界环境 map、非 secret 名称过滤。
   ACP 的试验性 `_meta["hermes.clientEnv"]` 只声明名称，不把路径或凭据写进模型正文。
   此字段是**本地原型接口，不是现有官方 ACP 能力或已经确定的上游合同**。
2. `prompt.submit` 将 `client_tool_env` 纳入现有 `cli_turn_v1` admission payload 和重试比较。
   Gateway 使用现有 native transport 身份及 Session 归属检查；没有向任意远端客户端开放宿主环境覆盖。
3. 复用现有 `cli_turn_scope`，在实际子进程启动处读取本任务快照；不按 Session ID 查可变的最新 Run。
   使用原生过滤逻辑，不改 personality、`agent.system_prompt` 或 system overlay。
4. 本地 shell snapshot 排除这些名称。受控测试先复现了“新值被旧 snapshot 覆盖”，补齐排除后通过。
5. ACP 丢失提交 ACK 后保留原环境和原 input ID。即使进程环境已经变化，同一输入的重试也不获得新授权。
   这不授权 Rovai 自动重放结果未知的输入。

本次 Core 只在一次性源码副本中切到直接 ACP，跳过旧私有 `prepare_session`，并发送上述元数据名称。
内置 CLI、公开 Send、Run/epoch/Binding 校验及 lease 撤销均使用真实的现有实现，没有替换成假认证服务。
保留 B/P 正文，不执行压缩策略或旧 Home 迁移改动。

试验文件：

- [Hermes 原型补丁](native-client-env-prototype.patch)：基于官方 0.22.4 source
  `4d04303818b61bf3aa09278af48356315515965b`；含对应测试和生成的 RPC schema。
- [Core 验证接线补丁](core-client-env-probe.patch)：基于 Rovai
  `269d73b862bc7cf1a7a42f5a398ec7a203cbba8a`；只用于隔离验证，不是可发布的 R2 实现。
- [端到端探针](client-env-feasibility-probe.mjs)及[脱敏结果](client-env-feasibility-2026-10-24.json)。

## 隔离验证与结果

macOS arm64；模型使用受控 loopback Responses。整理后的提交版探针独立复跑一次，同样通过。测试者预先准备唯一的临时原生 `.hermes`，
两个成员共用它；每个成员保有不同 Session。这里的 `HERMES_HOME` 只用于测试隔离，不是生产创建私有 Home。
预先启动共享 Gateway 时没有 Rovai Run 环境，再启动隔离 Core；Core 数据、Skill Library、工作目录全部独立。
没有补丁日常 Hermes 安装，没有使用日常 Electron 数据或真实付费模型。

Hermes 从一次性源码副本运行，使用已准备的依赖。源码 clone 不含忽略的 `install-stamp.json`，
官方 ACP 因而报告 `0.0.0`；测试副本复制了同一 0.22.4 安装的 stamp，未绕过 Core 最低版本检查。
测试 launcher 只解决源码副本的解释器/依赖入口；它不是向模型投递的专用 CLI 包装路径。

| 检查 | 结果 |
| --- | --- |
| 两个成员、不同 Session、同时执行 | A0/B0 的真实 Run 执行区间重叠；互不串会话 |
| 直接执行 `rovai --version` 与 `rovai send` | 四轮都找到 `rovai 0.4.16 contract-v43 ipc-v3`，四次 Send 成功 |
| 模型正文 | 检查真实请求，未出现逐 Run 的 context 文件路径；命令仍直接使用 `rovai` |
| 公开消息归属 | 逐条核对 Core 数据库的 Thread、author、source Run；全部精确匹配 |
| 下一轮与冷恢复 | A1/B1 使用新的 Run 上下文，分别保持 A0/B0 的原 Session ID |
| 旧后台执行跨到 A1 期间 | 旧进程继承的上下文路径发送失败，退出 2；未取得 A1 权限 |
| 保存第一轮有效凭据再尝试 | 冻结的旧 context 副本也被 Core 拒绝，退出 2；不是只靠删除旧文件使测试通过 |
| 旧消息 | `STALE_SHOULD_NOT_SEND` 在 Core 中为 0 条 |
| 用户配置边界 | 测试原生 `config.yaml` 与 `.env` 前后字节一致 |
| 共享执行端 | 四轮和 Core 正常关闭后原 Gateway 仍存活；随后测试显式清理自己启动的 Gateway |
| 原生相关测试 | 4 个现有入口、30 项通过；包含旧执行快照、shell 覆盖、丢 ACK 重试、环境隔离与生成 schema |

旧 context 的**路径和所指授权都不能被后续 Run 换成新授权**。当前逐 Run 冷启动提供不同进程上下文路径；
现有 Core lease 撤销进一步拒绝旧凭据副本。这个结论不推广到未来 warm 复用同一个可变 context 文件的设计。
也不是对同一操作系统用户下任意恶意读取其他文件行为的隔离证明。

正式采用前仍须完成上游接口与支持范围确认；本次没有证明未经补丁的 0.22.4 已修复。
未验证远程 terminal backend、`execute_code` 专门路径、所有 managed worker/子智能体路径、新 Gateway 自动启动时的环境继承、
MCP 变更、多平台或付费模型。R2 的压缩策略退役、旧 Home 会话切换及完整进程回收调整仍是独立待实施工作。

复现时，补丁使用零上下文格式，以 `git apply --unidiff-zero <patch>` 应用于各自精确基线的源码副本。
在一次性目录准备相应 Hermes/Core 源码和开发二进制：`hermes-dev`、`rovai-core`、
`rovai`；`hermes-dev` 使用该源码版本的原生入口，具备同版安装 stamp 和已准备依赖，不修改日常安装。
然后运行 `node client-env-feasibility-probe.mjs <sandbox-root> <Rovai-source> <dependency-Home>`。
最后一个参数只读取 `installs/` 依赖位置。原始 wire、临时 context 凭据及个人绝对路径不提交到仓库。
