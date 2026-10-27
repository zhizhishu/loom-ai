---
document_type: contract
name: Runtime Launch and Verification
version: v70
status: accepted
source_version: v1.72
last_updated: 2026-10-22
---

# Runtime Launch and Verification v70

继承 [v69](runtime-launch-and-verification-v69.md)。本版为 Rovai 托管的 Claude Code、CodeBuddy
固定原生后台执行策略。前台命令、前台原生子 Agent 和平台同伴协作继续可用。

## 固定启动策略

| Runtime | 环境变量 | 值 |
| --- | --- | --- |
| Claude Code | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` | `1` |
| CodeBuddy | `CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS` | `1` |
| CodeBuddy | `CODEBUDDY_BASH_AUTO_BACKGROUND_DISABLED` | `1` |
| CodeBuddy | `CODEBUDDY_BASH_ASSISTANT_BUDGET_MS` | `0` |

Claude 在成员环境及设置合并后，将策略值写入已有私有 settings，并再次固定在最终子进程环境。
CodeBuddy 只在环境合并后的专属启动分支注入三个子进程环境变量，位置覆盖外部 MCP 提前返回路径。
Windows 进程环境名遵循大小写不敏感语义，Claude 私有 settings 局部移除同名等价键；用户原生配置与 Core 环境不改写。
这些开关用于关闭显式后台执行及已确认的超时、响应预算自动转后台入口；CodeBuddy 原生配置覆盖的边界见下节。
不宣称所有原生内部中断路径均已证明不可转后台。
长命令仍遵循原生前台超时，失败／超时结果由当前任务处理，不自动重复业务操作。

## CodeBuddy 原生配置边界

Rovai 保证启动时注入上述三个变量。用户原生 settings 继续由 CodeBuddy 自己读取；其中显式配置的同名变量
仍按 CodeBuddy 原生规则生效，本项策略不保证覆盖所有原生配置冲突。

本项策略不读取 user／project／local settings，不重建 env 优先级，不复制原生 env，不生成
`background-policy-settings.json` 或追加 `--settings`，也不为此分配私有 Host 目录。
因此不新增原生 env 搬运、配置解析或文件清理路径，也不为已删除的路径增加日志拦截。

## Host 与 Session

CodeBuddy 的 Host compatibility 添加 `nativeBackgroundPolicy=disabled-v1`。未加载策略的旧 Host
不再符合后续获取的复用条件，已经接受的输入不因本次策略被强行重放或中断。
标记不进入 Native Session binding／session compatibility，原生会话历史沿既有恢复机制保留。
Claude 每次 one-shot 新建进程时应用同一策略。

## 完成规则

Claude Code、CodeBuddy 的普通会话与 Single Chat 在用户指令／授权规则之后加入同一条：

> Do not background required finite commands or native subagents. If a tool backgrounds them, collect results and complete authorized follow-up before your final response. Do not assume background completion will resume your work.

此规则只约束任务所需的有限命令与原生子 Agent。Rovai 同伴等待、授权、当前输入、进度说明和 Single Chat
私有输出规则继续有效。其他 Runtime 的章程保持原字节；不建立后台完成自动唤醒机制。
本条替代 [Single Chat v9](single-chat-v9.md) 中对这两个 Runtime 的“专用 Charter 保持原字节”限制，
其余 Single Chat 输入、权限和历史边界不变。

验证与已确认的完整前后对照见 [v1.72 实施记录](../versions/v1.72/model-context-change-native-background-policy.md)。
