---
document_type: research
status: not_qualified
reviewed_at: 2026-10-12
baseline_ref: bc317de1a4480b02bc941041622fd5ced23c84ca
---

# 15 类 Runtime 原生恢复与历史删除实测

在 macOS arm64、合并 PR #714 的 Core 上执行真实 CLI 验收。按用户要求排除 Cursor、Cline、
Command Code。15 类 Runtime 都观察到了携带原 Session ID 的冷恢复调用和随后成功完成的新一轮；
**历史丢失后的自动降级只有 Pi 完整通过，CodeBuddy 出现空历史假恢复，其余 13 类报错。**

[脱敏协议证据](native-session-resume-2026-10-12.evidence.json)记录恢复入口、原 ID 是否保留、
结构化错误、业务输入提交次数和连续性提示数量。
[实测脚本](../../../scripts/probe-native-session-resume.mjs)复用现有 qualification Core 启停、
消息发送和临时文件清理工具。以上是修复前审计；后续修复与复测另记于文末，不改写基线结果。

## 验证方法与边界

1. 每个 Runtime 使用独立 Core 数据、Skill、MCP、项目和 Camp，调用已安装的真实 CLI。
2. 建立原生会话，发送另一条消息检验同一 Core 内继续使用，再停止 Core、重新启动并发送新消息。
3. 停止本次测试进程，备份并删除本次生成的原生历史，保留 Core 的当前原生绑定，然后再次启动。
4. 观察实际 `resume` / `load` / CLI 恢复参数、原生错误、当前绑定、输入交付和提示事件。

配置和凭据只复制到私有临时夹具。TRAE、Antigravity 使用各自原生目录，只删除本次新生成的
精确 Session ID 对应文件。OpenCode 和 ZCode 删除的是隔离夹具中的 SQLite 存储及 sidecar；
不触及日常原生数据库。私有原始结果、配置和历史备份不可提交到仓库。

这里的正常恢复通过表示“确实向原 ID 发起恢复且后续新输入成功”，不保证每一条历史内容完整一致。
这是 Core / 真实 Runtime 验收，不覆盖 Renderer、跨版本数据库迁移或新一轮权限差异。

## 逐 Runtime 结果

所有行均已成功执行正常冷恢复。最后一列是删除原生历史后实际提交的业务输入次数，含新建降级。

| Runtime / 实测版本 | 冷恢复入口 | 删除历史后的原生结果与 Rovai 行为 | 输入次数 |
| --- | --- | --- | --- |
| Pi 1.1.0 | `switch_session`，路径包含原 ID | 既有目标检查发现缺失，创建新 ID、成功执行，发出一次连续性丢失提示 | 1 |
| CodeBuddy 2.133.1 | `session/load` | 返回成功；同一 ID 新建空历史，Rovai 继续执行且没有提示 | 1 |
| Copilot 1.0.83 | `session/load` | `-32002`，`data.uri` 指向请求的 Session；保留原 ID 报错，没有新建 | 0 |
| Qwen Code 0.25.0 | `session/resume` | `-32002`，`data.uri=session:<原 ID>`；保留原 ID 报错，没有新建 | 0 |
| Qoder 1.1.65 | `session/resume` | `-32602` + `data.code=INVALID_SESSION_IDENTIFIER`，Session 与项目均匹配请求；保留原 ID 报错 | 0 |
| ZCode App 3.14.5 | 官方 `session/resume` | 原生 `-32004 sessionUnavailable` 被桥接为通用 `-32000`；保留原 ID 报错 | 0 |
| Codex 0.162.1 | `thread/resume` | `-32600`，文字说明没有 rollout；没有专用结构化原因，保留原 ID 报错 | 0 |
| Claude Code 2.1.287 | `--resume <原 ID>` | 初始化控制响应报错，文字说明找不到会话；保留原 ID，没有发送 user 输入 | 0 |
| OpenCode 2.0.25 | `session/resume` | `-32602` + `data.sessionId`，没有专用原因码；保留原 ID 报错 | 0 |
| Kiro 2.21.1 | `session/load` | 普通 `-32603`，无结构化详情；保留原 ID 报错 | 0 |
| TRAE 0.120.52 | `session/load` | 普通 `-32602`，无结构化详情；保留原 ID 报错 | 0 |
| Kimi Code 2.1.1 | `session/resume` | `-32602` + `data.sessionId`，没有专用原因码；保留原 ID 报错 | 0 |
| Grok Build 1.0.50 | `session/resume` | `-32603` + `FS_NOT_FOUND`；detail 只有系统文件缺失错误，未指明原生目标；保留原 ID | 0 |
| DeepSeek Harness 0.2.1-alpha.1 | `session/resume` | 普通 `-32602`，只有文字说明不可恢复；保留原 ID 报错 | 0 |
| Antigravity 1.3.3 | `--conversation <原 ID>` | CLI 初始化返回另一个 ID，Rovai 在发送输入前拒绝；原绑定保留 | 0 |

ZCode 使用官方 App 的 Node bundle，版本取自 App 的 `CFBundleShortVersionString`。
机器上独立 PATH CLI 的 0.16.9 不是本轮被测实现。

## 两项确定的实现缺口

### CodeBuddy 的成功响应不能证明恢复了历史

删除前原生文件有 6 条 message，涵盖 seed、warm、cold 三轮。删除后 `session/load` 成功，
随后保存的文件只有本轮 2 条 message，没有旧 message ID，也没有前三轮的人工标记。
当前绑定仍是原 ID，连续性丢失提示为 0。它是真实的空历史假恢复，不能算通过。

需要在 CodeBuddy Adapter 的这条已证实路径接入可靠的精确目标核验，明确缺失后走一次正常新建。
不能因 CLI 返回成功就宣布旧上下文续接，也不需要扩展成全历史扫描或内容摘要检查。

### 具体的恢复拒绝尚未进入降级决策

`acp.rs` 的恢复错误分支目前只特别处理与该次 RPC 关联的 `-32601`，其余返回普通恢复错误。
Copilot、Qwen 的资源缺失响应以及 Qoder 的专用 Session 拒绝未进入自动新建路径。
补采无业务输入的原生恢复请求，确认 Copilot / Qwen 的 URI 包含精确目标，Qoder 的
`data.sessionId` 和 `data.projectRoot` 均与请求一致。

ZCode 的缺口更早：官方 bundle 定义 `sessionUnavailable=-32004`，并在
`session.resume_persisted_missing` 分支返回此码。实际恢复请求收到了它；
`zcode/transport.rs` 把原生错误转换为通用字符串，再发出 `-32000`，上层失去机器可读依据。

修正应位于各 Adapter 的具体恢复调用和桥接处，保留请求关联、专用错误信息与目标对应关系，
复用现有恢复失败类型。无需增加全局文字匹配、数据库状态或恢复账本。

## 其余报错是保守边界，不能一律改成自动新建

另外 9 类在本轮缺失注入后无法继续，但当前观察到的协议信息不足以仅凭错误码证明原生目标失效。
普通参数错误、内部错误、文件缺失、无专用类型的文字错误，都可能有其他原因。
Antigravity 返回另一个 ID 只证明没有加载请求的目标，不能单独证明旧历史不存在。

因此这些路径保留原 ID、停止当前执行符合已确认的“未知错误不猜测”边界。要提高可用性，
需在对应 CLI 已有的稳定结构化能力或可靠目标核验上获得依据，不能把这 9 类改成捕获异常后新建。
尤其不能把 `FS_NOT_FOUND` 直接视作 Session 丢失：补采的 Grok detail 并没有目标路径或 ID。

## 超时、补测与防重证据

- Claude 首次 warm、Kimi 首次 cold 达到验收超时后取消；随后发送的是不同的新消息，冷恢复成功。
  因此不声称 Claude 首次 warm 通过，也没有自动重放取消前已接收的输入。
- Codex 首次 cold 在 `account/read` 阶段发生 routing discovery 超时，尚未调用恢复。原 ID 保留，
  没有新建。之后用新的独立输入成功恢复原 ID，再执行历史删除测试。
- ZCode 最初只删除 rollout 日志，原生数据库仍存在，该结果不计入缺失测试。表中采用随后删除
  隔离 `sessions.sqlite` 及 sidecar 后的 `missing-store` 结果。
- 13 条最终失败路径没有业务输入提交，也没有新建请求。Pi 降级只新建一次、提交一次、提示一次。
  CodeBuddy 提交一次，但错误地把空历史当作原生恢复。没有观察到本轮输入因恢复失败而被重复提交。

## 复现

先按本仓库本机工作流构建 Core，然后在准备好相应 CLI 的环境执行：

```sh
cargo build -p rovai-core --bins
node scripts/probe-native-session-resume.mjs <adapter-kind> <已创建的私有绝对路径>
```

脚本会发起真实模型调用，并删除它创建的原生历史。输出目录会包含私有配置和历史备份。
它记录观察结果，不把所有运行失败当成脚本异常，也不把所有完成状态当成恢复验证通过。
中断后的 `--continue` 使用新的验收输入；`--missing-only` 用于完成冷恢复后补测实际存储缺失。

## 五类 Runtime 修复与复测

候选基于 `d41778bfcc71d0223e70cbbdd442c3e500eb3559`，按本轮 User 授权修复前述明确缺口。
未放宽另外 9 类未知错误的分类；没有环境快照、配置摘要、数据库迁移或新的恢复状态。

- CodeBuddy 冷恢复前核验其精确原生文件，复用既有路径规则；配置目录取自子进程已组装的启动环境，
  Windows 环境键沿用受管进程的大小写语义，Warm 不重新检查或读取最新队员环境。
- Copilot / Qwen 只接受对应恢复请求的 `-32002`，并要求 `data.uri` 完整匹配本次 Session 的资源标识。
  Copilot 实际 URI 为 `Session <id> not found`，Qwen 为 `session:<id>`；不匹配 error.message 或关键词。
  缺字段、错目标或其他资源缺失均保留未知错误。
- Qoder 要求 `-32602`、`INVALID_SESSION_IDENTIFIER`、原 Session ID 和项目目录同时匹配。
- ZCode 保留既有类型中的原生机器码，只在原生 resume 调用处解释 `-32004` / 方法不可用。
  初始化、订阅、权限与模型错误不能借桥接响应触发替换。

五款均在新隔离夹具中完成 seed → Warm → 重启恢复 → 删除历史 → 再次发送。每款正常冷恢复请求
携带原 ID，Warm 复用同一进程；缺历史时只新建一次，提交一次当前输入并成功完成，切换新 ID 后提示一次。
CodeBuddy 不再对缺文件的旧 ID 发送假成功的 load。机器证据保留原审计与独立的 `fixVerification`，
不发布凭据、聊天正文、用户目录或真实 Session ID。

确定性验收继续复用 Core 的 `--adapter-regressions`，覆盖降级新建失败保留旧目标、初始化/模型/MCP
错误、取消、超时及输入结果未知不重放；Pi 公聊/单聊在 Warm 和重启后各保留自身原 ID。
ACP 67 项、ZCode 桥接 4 项、原生 usage 3 项定向回归通过。新增 Rust owner 的准入理由与最低命令见
[测试指南](../../development/testing.md#原生会话恢复-owner2026-10-12)。
Copilot / Qwen 在精确 URI 核验收紧后各重跑一套真实验收并通过。最终 `pnpm test:rust:pr`
通过 465 项、1 项既有人工测试忽略；Node 定向测试 4 项、语法/格式检查和通用文档门禁通过。
Spec / Standards 静态复核无剩余核心发现；未宣称执行完整 extended / slow suite。

实测脚本的共享目录删除边界另由 `node --test scripts/lib/native-resume-probe-history.test.mjs` 验证：
TRAE 核验精确 ID 与原生 cwd；Antigravity 核验精确原生数据库 ID 与本轮 fixture 绑定/启动来源；
错目标、错目录、软链接均拒绝，不按 ID 子串递归删除共享目录。
本轮未安装或重启日常 App，也未验证 Windows 真机、Renderer 或全部历史内容的完整性。

### PR #721：结构化字段与展示脱敏分离

User 对 `c9c106bd` 的审查指出：短凭据可能是原因码、Session ID、URI 或项目路径的子串，
`complete_pending()` 先脱敏这些字段会破坏后续精确匹配。本次保留内存中的原生机器字段，仅脱敏
message / provider detail；自定义 Debug 只保留数值错误码，不输出原始机器字段。
扩展既有协议传递 owner，在修复前复现 Qoder 的目标拒绝被误判，覆盖凭据 `test` 与
`/work/test/project`、Session / URI 的碰撞，以及原因码碰撞与各种错误格式化的脱敏。
本次是错误传递链的确定性补正，未重新运行五类真实 CLI，不改写此前的实测结果。
补正后 ACP 67 项、ZCode 桥接 4 项、默认 Rust 465 项通过（1 项既有人工测试忽略），
定向 owner 在 `RUST_BACKTRACE=1` 下通过；格式及文档门禁通过。
