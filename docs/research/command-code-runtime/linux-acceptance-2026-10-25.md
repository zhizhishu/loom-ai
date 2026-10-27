---
document_type: research-report
authority: observed-command-code-linux-acceptance
status: preview
last_updated: 2026-10-25
---

# Command Code Linux x64 验收

本轮在 Ubuntu 24.04.5 GNU x86_64、Node 24.21.0 使用官方 `command-code@1.88.0`、
原生 ACP、原生 `providers.json` / `config.json` 和真实 Sub2API `gpt-6.1-sol`。
Core 基线为 `179289b080d74a8868c7d7de8bfb5dd99508a292`；隔离候选只把 Linux 准入改成 Preview，
Host SHA-256 为 `93f86f90195dc4bfc49d4aba872165b01c9e825f3fa64f5423e2ec64c479de19`。
生产 Server、历史、token、原生配置、QQPW、Sub2API 和 Caddy 均未改变。

本轮目标主机验收完成。公开范围采用既有 Preview，最低要求为官方稳定版 ≥1.88.0；不绑定虚构的 qualified evidenceRevision。
取舍见 [V1.72-D61](../../versions/v1.72/decisions.md#v1-72-d61)。本页逐项报告已测范围，
不把单机验收外推为其他发行版、musl、ARM64、Windows、子代理或未来版本的资格。

## 证据边界

真实 Core 的 Data、Skills、MCP、HOME、工作区和浏览器 profile 全部独立。测试使用经授权的原生
认证副本，结束后删除；密钥仅在进程环境中传递。透明回送服务逐字节转发实际 Provider 请求，
保存脱敏元数据，分别标记受控 401/503、断开与 context overflow；故障注入不代替真实模型成功。
压缩测试通过原生 Provider 配置使用 32K 阈值、128K 手动及 16K 取消窗口，实际调用模型生成摘要；
受控 overflow 不等于自然耗尽远端模型窗口。浏览器验收使用 Linux Chromium 和生产 WebUI，实际点击文件卡、Diff 及当前文件入口。

## 已验证能力

| 能力轴 | 实测结果 |
| --- | --- |
| Auth / Model | 官方登录与原生 BYOK；ACP 返回 `sub2api/gpt-6.1-sol`，Core 原样显式选择，默认最高权限采用原生 bypass。 |
| Host / Session | first/warm、A→B→A、并发、编辑成员后新 Bootstrap、Core cold resume；身份、原 Session 和记忆均保持。 |
| Fleet | 21 个实际 Session 触发生产 20 Host 上限，正确淘汰 LRU；回收后精确恢复原 Session 和记忆。生产 30 分钟 idle TTL 真实等待后在约 30 分 18 秒回收原 Host，后继恢复同一 Session 和记忆；未改时钟或 Fleet 上限。 |
| Bootstrap | 根模型请求中恰好一份 System Charter，成员隔离；原生问卷 `ask_user_question` 不进入实际工具集。 |
| Skills | user/project 原址、平台/工具箱均真实读取；更新、同名来源、删除引用不重绑、相邻成员和 cold resume 通过。 |
| External MCP | 原生与分配的 stdio/HTTP 实际调用；native 同名优先、cwd、字面 env/header、更新/删除/重新分配和成员隔离通过。 |
| Files / Web | Native Read/Edit/Add；中文空格路径字节正确；WebUI 实际打开修改 +1/-1、新建 +1/-0 Diff 和当前文件内容。 |
| Commands | stdout、stderr、混合、空与大输出保持唯一 Tool ID；131072 字节原生输出按当前合同限制显示为 7680 字节。非零退出见下文。 |
| Permissions / Cancel | 原生 allow/deny 和对应副作用通过；取消 native shell/MCP 后观察至少 37 秒，无迟到写入；队列后继仅执行一次。 |
| Built-in CLI | 当前全部 30 个正式操作有真实 Core Evidence，包括私有 Single Chat；过期 lease 拒绝，后继新 lease 可用。 |
| Usage | 8 个基线 Run 与真实 Provider input/cache/output 逐 Run 对账；压缩、重试及冷恢复另外 21 个可唯一归属 Run 的根模型请求三桶全部相等；未知费用保持 NULL。原生 ACP 不上报标题/摘要辅助请求用量，不能把根请求统计当作完整消费账单。 |
| Failure / Cleanup | 受控 503 后只提交一次文件/公开回复；认证失败与 Runtime/Core SIGKILL 后精确恢复，无中断输入重放；Core 崩溃后所属子进程全部退出。 |
| Protocol / Probe | 实际 ACP initialize 回复版本被故障注入改为 999，Core 在模型输入前失败、回收 Host，干净后继成功；实际官方 `--version` 输出被挂起后超时，Ready 为 false，探测进程全部退出。 |
| Compaction | 自动阈值真实 summarized 后身份/记忆不丢；一次受控 overflow 后原生先返回 too-small，再成功重试并在同 Run 后续阈值 summarized。官方 ACP `/compact` 实际 summarized、节省 10,393 tokens，随后 Core cold resume 保持原 Session、记忆、System 身份、Skill 读取与 MCP 调用；实际摘要认证失败报告 failed、tokensSaved=0，冷恢复仍保持身份/记忆；Core 在自动摘要请求挂起时取消，Run 为 cancelled，原 Session 后继成功且没有重播取消的输入。 |

## 已接受差异

官方 1.88.0 的 ACP 将 shell `exit 7` 报为 `completed`，输出保留 `Exit code: 7`，Core 映射为 succeeded。
独立原生 wire 对照得到相同结果。维护者明确表示该项不是问题，允许继续验收；本轮保留真实状态，
不从输出文字推算退出码，不为它添加专属解析器。该接受不覆盖其他故障或未知项。

## 自动化回归

在 macOS 开放分支同步 main 的 `081b9862937b9f9190177b1e44e19793012fd5e7` 上补入 Linux，
保留同期的 UI 主题与文档整理。`cargo test --workspace`：477 项通过、1 项既有忽略，doc-tests 通过；
其中平台准入 5 项 owner 通过。前端全套 256 文件、3005 项通过、2 项既有跳过；TypeScript、
10 项文档治理测试、当前版本检查与基于上述 base 的差异文档门禁通过。
本次产品行为仅增加 Linux Preview 准入；Renderer 生产组件没有另加分支。

## 回归归属

平台矩阵扩展既有 `runtime_platform_admission` owner；Linux 进入共享 Preview 路线，
Renderer 的既有新手引导、Runtime 应用和目录夹具增加 Linux 数据行。没有新增 Rust 测试函数、
Runtime 管理文件、配置镜像、进程池、锁、watcher 或生命周期状态。

私有原始报告保留失败尝试。压缩脚本最初过严地要求首次 overflow checkpoint 必须立即 summarized；
真实结果是 too-small，随后同 Run 重试成功并再次 summarized，文件与公开回复均只有一次。续跑另修正
SQLite null-prototype row 与 JSON object 的断言差异，始终逐字段比较原 Session/Binding 值。
非法 JSON 行与协商错误分别观察：共享 reader 会诊断并丢弃非法行，丢失 session/new 回复后本轮超时失败，
关闭 Core 后进程全部回收；本轮不把它写成“所有损坏协议都即时杀掉 Host”。协商版本错误有独立回收证明。
只发布本页的白名单结果，原始认证、模型正文、用户路径和日志不入库。

测试结束后所属 Runtime、MCP 与探测进程为零，临时认证/Provider 配置已删除；原生认证源未改变。
生产 Server PID 未变化，HTTPS 与 Sub2API、QQPW、Caddy 均正常。
