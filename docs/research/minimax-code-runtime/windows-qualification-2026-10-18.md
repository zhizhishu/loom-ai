---
document_type: research-report
authority: observed-minimax-code-runtime-integration
status: verified-with-limitations
last_updated: 2026-10-18
---

# MiniMax Code 0.6.12：Windows x64 完整资格验证

本轮由 User 要求完成 Windows 本机验真，并允许使用 sub2api。目标是正式产品路径的资格闭合，
不是把一次回复或 `initialize` 当作完整验收。十四轴及九个 Golden Flows 已闭合，Windows x64
提升为 Qualified，绑定[冻结资格记录](../../../qualification/runtime-platform/windows-x64-minimax-code-v1.json)
的 SHA-256；普通机器安装、认证、模型和 Ready 检查继续独立生效。

## 主机、版本与证据边界

- Windows 10 Pro x64，10.0.19045，NTFS；不外推至 Linux 或其他 Windows 文件系统。
- 官方 npm `@minimax-ai/code` **0.6.12**，`mcode acp`；安装在隔离目录，未替换用户的原生配置。
- 真实模型经用户授权的 sub2api，通过 MiniMax 原生 BYOK Provider 使用 `openai-responses` 和
  `gpt-6.1-sol`。不是借用另一个 Runtime 的身份。官方 MiniMax 账号返回余额不足，未计为通过。
- 初始 main 为 `92736d707c9162133a93b7720ae826e7dad90e8a`；后同步至
  `102b24f12a66af8151cb5b43cc4bb8e5feaafa69`。后者重跑当前 29 项 CLI、原生模式/配置刷新；
  最终组合和验收包使用后者加本轮修复。交付前再同步 UI 变更 `7cf1abb1c` 并重建桌面资源。
  不同批次分别保留二进制摘要，不宣称全部来自同一构建。
- 所有 Core、原生 data root、Workspace、MCP 和 Electron userData 都独立隔离。
  App 在 `dist/` 外的独立副本运行，不访问日常数据。退出检查使用进程 PID 加创建时间身份。

真实模型与受控模型分别记账：Fleet、真实编辑、图片、Skill/MCP、配置刷新、压缩和 App 使用真实模型；
确定性输出、文件失败、问卷、精确缺失 Session 和结束边界使用**真实官方 CLI + 受控 Provider 响应**。
受控服务没有模拟 ACP Runtime；其结果也不冒充真实模型行为。overflow 故障仅注入一次 HTTP 400，
随后摘要与重试继续使用真实模型。

## 验证发现的三个实现问题

1. Windows 私有 Bootstrap 目录未使用受保护目录准备流程，写入 System Prompt 被 DACL 检查拒绝。
   改为复用 `platform::private_storage::prepare_private_directory`，没有放宽 ACL。
2. Core 的 Windows verbatim cwd 与原生 SQLite 的普通盘符路径比较不等，导致可采集 Usage 全部缺失。
   仅在 Windows 比较等价路径时使用 `dunce::simplified`，精确 Session、root 和子会话排除保持不变。
3. Current Input Skill 和受管 Skill 索引把 `\\?\C:\...` 暴露给模型，原生 Read 将其误判为 UNC 路径。
   仅规范化模型可见链接/索引路径，冻结 sourcePath、Skill ID 和审计摘要保留原始 canonical 身份。
   原生拒绝及两个现有 Rust owner 的修复前失败均保留；不依赖模型自行修正路径。

## 十四轴 Parity Matrix

| 轴 | 目标机证据与判定范围 |
| --- | --- |
| Identity / configuration | 独立 `minimax-code-cli`；官方 Provider/default model；真实不透明 catalog ID 显式选模；外部 endpoint/key 修改下一 Run 生效，错误 key 失败、恢复后同 Session 续接 |
| Host / Fleet / LRU | A/B 并发使用独立 Host，A→B→A→B 精确恢复且 marker 不串线；生产 TTL 实际观察 **1,824,199 ms** 后回收，随后同一 Native Session 恢复 |
| Native Session | warm、Host restart、Core crash/cold resume；精确 Session 缺失受控用例最多替代一次；不用 latest Session 或输入重放 |
| Bootstrap / Context | 实际 Provider 主 Agent 请求均含唯一 system 层 Session Charter；Session 切换、配置更新与 cold resume 保持，native 标题生成另计 |
| Compaction | 真实 manual compact、自然 threshold、overflow+retry；401 摘要失败不算成功；产品 Run 在自动摘要中取消 **235 ms** 收敛，之后 cold resume 回到原 Session |
| Skills | 当前 Skills v2；同名原生/project 来源 ID 分离，显式选择、更新、删除、恢复；Toolbox assignment 撤销；删除所选来源不按同名回退 |
| External MCP | 实际 echo 调用、定义更新、assignment 撤销、邻会话隔离、cold resume；与原生文件/命令工具并存；压缩后继续调用，取消持有调用后精确 Server 进程退出，21 秒无延迟副作用 |
| Tool / Action / output | 23 项受控完整场景；stdout、stderr、mixed、empty、nonzero、large 均有 Action output；独立文件批次 10 项原生 Read/Write/Edit 和失败场景，含中文空格路径 |
| Narration / final | zero-send recovery、已 send 后空 final、不重复发布、空 final 无 send 失败、send 后错误仍失败；公开文本与终态分别断言 |
| Permissions / workspace | 实际 allow-once/deny 与零副作用；auto、default、bypassPermissions 和 plan 原值传递；没有 `additionalDirectories` 或额外只读沙箱的支持声明 |
| Built-in CLI | 最新 main 当前正式 **29 项 operation** 真实 Runtime 调用；当前绑定、命令目录和任务开关 fixture；旧 help/旧创建 API 的 harness 已修正 |
| Usage / cache / cost | 原生精确 message/call identity checkpoint 归约至 Run；重复身份为 0；短 Run 与压缩替换 journal 后缺失保持 NULL，reasoning/cost 未估算 |
| Retry / queue / cancel | 原 Run/epoch 图片 Steer ACK，真实像素识别；原生命令及 MCP 调用取消后进程退出且无延迟副作用；Core crash 和正常退出清理 |
| Ready / version / platform | 资格只针对官方 0.6.12 × Windows x64；安装、认证、模型和 Ready 仍独立检查；包为本机未签名构建，不宣称正式签名发布 |

## 九个 Golden Flows

First Run、Warm Host、Multi-Session / Concurrency、Cold Resume、Context / Compaction、
Skill / MCP Projection、Safety / Output、Monitoring、Failure / Cleanup 均通过并映射上述证据。
最终 64K 组合实际触发 threshold summary，随后原生 Skill Read、MCP 和 **3 次原生审批**生效，
Native Binding 不变。最新 Core 的打包 App 通过真实流式运行、正常退出、草稿/部分文本保存与冷恢复。
15 份独立批次证据、原始报告状态和各自摘要在冻结记录中列明。

## 审计纠正与保留的限制

- 早期 compaction-edges 与 capabilities 报告末尾误把 native 标题生成请求纳入主 Agent Bootstrap
  断言。保留原失败报告，另存 post-capture audit：主 Agent 请求分别 10/26，Charter 均为 1；
  排除的独立标题请求分别 1/2。新 harness 以主 Agent 的原生 `bash` tool schema 确认请求类型。
  最终修复后的 capabilities 全量重跑直接通过，24 个主 Agent 请求各有一份 Charter。
- 首轮图片 Steer 已通过，后续 auto permission 因 harness 未处理审批而超时；图片仅按独立 case
  计入，模式用修正后的单独批次复验，不把整轮失败改写为通过。
- 早期 idle fixture 漏存创建时间；原 PID 后验全部不存在，与后继新 Host 分开记录，未把 PID
  复用当作旧进程存活。当前 harness 保存创建时间。
- 32K 的 Skill/MCP 组合 fixture 在完成首轮工具前触发摘要，该次未计通过；保留其结果。
  64K 重跑仍要求实际观察 threshold summary，而不是移除压缩条件或只验证普通能力。
- 原生 ACP 直接执行 `/compact` 时，其 `session/cancel` 在 10 秒内未结束。产品没有这个直接
  `/compact` 入口；产品 Run 自动摘要中的取消已验证可收敛并清理 Host。不能宣称上游直接取消已修复。
- Usage 是部分观测。审计中完整受控场景 14 Run 有值/1 未知，结束边界 3/1，压缩批次 1/2；
  journal 被压缩替换后不从历史重建或估算费用。未知不是零。
- 原生问卷沿已接受的[取消、不代答政策](questionnaire-policy-2026-10-17.md)，Run 明确失败、
  已发消息保留、后继同 Session 继续。没有 Fast，也不承诺原生 `additionalDirectories`。

## 可重跑入口

使用显式 `ROVAI_QUALIFICATION_CORE_BIN`、`ROVAI_MINIMAX_NATIVE_SCRIPT`、
`ROVAI_MINIMAX_LIVE_BASE_URL`、`ROVAI_MINIMAX_LIVE_MODEL` 和仅环境提供的
`ROVAI_MINIMAX_LIVE_API_KEY`。`scripts/smoke-minimax-windows-*.mjs` 各自建立隔离正式根，
使用官方 Provider CLI 配置并在退出时删除临时凭据；输出 report、事件和无认证头的请求记录。
`smoke-minimax-runtime.mjs` 的 `--files-only`、`--completion-only`、`--questionnaires-only`
明确表示子集，不能把子集绿色当作完整运行绿色。

Rust 回归扩展既有 owner，不增加或退役 Rust test。Skill/Usage/ACP 定向 owner 25 项通过，
Fleet 23 项、Node harness 11 项、文档治理测试 10 项通过；当前平台资格矩阵和包校验独立执行。
