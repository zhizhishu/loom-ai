---
document_type: runtime-research
status: partial
last_updated: 2026-10-17
---

# MiniMax：局部问卷开关候选与开发包复验

User seq23 要求继续完整修复。本轮接续[批复修复](review-fixes-2026-10-17.md)，
没有将防代答兜底改称问卷默认隐藏。**官方 0.6.12 下 `productDefaultChanged=false`，
主方案仍未正式交付。** 当前 Rust 生产实现保持 e359b087；本轮新增的是可审阅上游补丁、
独立探针和最新开发包的真实模型证据。

## 官方入口与源码发布差异

重新核查 npm latest 仍是 0.6.12，官方 main 为
`9a935605956c4500e9cb415f29258e2887e97817`。发布包 ACP help、公开 CLI/ACP 创建路径
均未提供局部 ask-user 配置或工具排除入口；`--config` 仍仅用于 exec/review。
不把内部配置解析接口当作外部能力，不改写用户的原生配置。

官方公开源码 package/build 当前报告 0.6.5，和 npm 0.6.12 不同步；公开源码的 ACP
initialize 广告 image=false，而此前安装版图片输入已通过。因此，本轮源码候选不替代用户
安装版，也没有从该候选授予新的 Rovai Adapter 资格。一次独立 Core 接入候选的试验在
模型目录检查阶段返回 `runtime_alternate_candidate_probe_failed`；该失败未被改称通过，
没有推断其具体根因或借绕过准入来运行。

## 七行上游源码候选

[补丁](fixtures/minimax-acp-ask-user-opt-out.patch)在三个既有文件增加七行：

- ACP 入口读取 `MCODE_DISABLE_ASK_USER=1`，普通 TUI/exec 不读此开关。
- lifecycle 在每次读取原生配置后，仅对返回对象覆盖 `askUser.enabled=false`。
- ACP help 明示该进程局部能力。

没有复制 Home、凭据、Session 或另建配置服务，也没有改已安装 bundle。
原生配置 getter、权限 setter 触发的刷新、Native data root 和精确 Session identity 保留。
这是拟议上游接口，**不是官方 0.6.12 已有环境变量**。

源码构建、typecheck 及既有 CLI help/default-config/ACP initialize 三项 Smoke 通过。
[独立探针](fixtures/ask-policy-probe.mjs)使用源码构建与本地确定性 Provider，观察真实
模型请求里的 Tool catalog；五项通过：

1. 未设置开关时，原生配置 enabled=true，模型看到两个问卷工具。
2. 开启进程策略并精确加载同一 Session 后，`ask_user` 和 `request_feature_enable` 均消失。
3. 同 PID/Session 下，权限 setter 后的新请求使用已更新地址和合成 Key，问卷仍不可见。
4. 新进程精确加载原 Session 后，策略继续生效。
5. 不带策略启动普通 ACP，工具重新可见；整个过程原生文件中的 enabled 一直为 true。

`bash` 始终存在；本探针没有执行文件、命令或 MCP 审批，因此不据此追加审批资格。
最初探针错误处理了原生 input_tokens 预估请求，修正测试服务后通过；这不是产品缺陷修复。

官方 [CONTRIBUTING](https://github.com/MiniMax-AI/minimax-code/blob/9a935605956c4500e9cb415f29258e2887e97817/CONTRIBUTING.md)
要求外部贡献者先提交 Issue。[Issue 草稿](fixtures/upstream-ask-user-issue.md)和补丁已准备；
截至本证据写入，对外提交尚未获 User 授权，未发布 Issue/PR。

## 当前官方版本的真实开发包验收

使用 `pnpm dev` 构建并启动最新 Core，显式独立 userData、Skill Library、MCP、原生 data root
和临时项目，使用官方 mcode 0.6.12 与 Sub2API 的 gpt-6 / openai-responses。原有开发窗口和
日常 App 保持运行；本轮新窗口停留在 `MiniMax · 修复复验（官方 0.6.12）` 对话供 User 查看。

三轮均成功且各公开发送一次，没有在输入中要求非空 final：

| Run | 实际行为 | 观测用量：未缓存输入 / 缓存读取 / 输出 |
| --- | --- | --- |
| 编码 | 原生 Write 新建、Edit 修改、Node 读取并断言，公开汇报 | 19391 / 88320 / 529 |
| 连续性 | 从会话记忆公开回复 `SPRIG-6245` | 1488 / 38144 / 107 |
| 驻留后继 | 同 Host PID 12956，再次公开回复记忆标记 | 1371 / 40448 / 108 |

文件实际内容是 `color=teal` 加换行。三轮均为 `runtime_reported_partial`，不宣称完整账单。
这三轮都有非空 final，因此它们证明真实编码与后继没有回归，**不替代上一轮确定性服务的
“发送后空 final”专项证据**。本轮没有新增 App/Core 冷恢复、跨 Session A→B→A、并发、
完整 CLI/Skills/MCP 矩阵或其他平台资格。

结构化结果、Session 归属、补丁摘要及未闭合项见[脱敏证据](continuation-2026-10-17.evidence.json)。
本轮重新运行 Rust workspace：473 passed、1 项既有 ignored、0 failed；文档测试 10/10，
文档治理与带 base 的 CI 门禁通过。没有新增、删除或禁用 Rust 测试。
官方局部入口未发布前，任务不能因源码探针通过或开发界面可用而标为完成。

## 复验入口

在官方公开源码基线应用上述 patch，按其安装与构建说明生成 `dist/cli.js`，然后从本仓库运行：

```sh
node docs/research/minimax-code-runtime/fixtures/ask-policy-probe.mjs /absolute/source/dist/cli.js
```

探针自行创建临时 Native data root 与项目，只用合成凭据和 loopback 模型服务，不读取账户配置。
官方安装版现有 Core 结束矩阵继续由 `scripts/smoke-minimax-runtime.mjs --completion-only` 拥有。
