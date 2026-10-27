---
document_type: contract
name: Runtime Launch and Verification
version: v73
status: accepted
source_version: v1.72
last_updated: 2026-10-26
---

# Runtime Launch and Verification v73

继承 [v72](runtime-launch-and-verification-v72.md)。本版替代 v64 中单项检查复用旧搜索环境、
仅在入口不存在时补充搜索的规则，统一启动、重新检测与主动检查的基础 PATH 采集策略。

## PATH 采集与入口选择

Core 沿用 Runtime Search Environment 的公共采集入口。macOS/Linux 正常采集统一使用交互式登录
shell（`-ilc`），只读取 PATH；保留现有超时、输出上限、标记解析及失败时的继承 PATH／已知目录回退。
Windows 继续使用原有 inherited／User Registry／Machine Registry／known locations 规则。
`runtime.discovery.rescan` 兼容旧客户端的可选 boolean `interactiveShell` 字段，但该字段不再选择采集策略。

自动发现继续使用既有候选集合与排序，显式程序路径保持既有优先级及失效不静默回退的规则。
不为 asdf、mise 等版本管理器解析 shim、寻找真实程序或维护环境变量名称，也不自动导入 shell 的其他变量。

## 操作范围与刷新

| 操作 | 行为 |
| --- | --- |
| 应用启动 | 采集基础 PATH，静态发现全部 Runtime，不执行版本、认证或协议检查 |
| 重新检测 | 刷新基础 PATH，重新发现全部 Runtime，保留 v64 的有界轻量版本补读 |
| 用户主动单项检查 | 无论旧入口是否存在，先刷新基础 PATH，再解析并执行选中 Runtime 的既有检查 |
| 普通运行 | 使用当前基础环境及适用的用户配置；不在每条消息前采集 shell 或全量重扫 |

同次检查的候选解析及检查进程必须使用该次刷新返回的不可变搜索环境，并叠加对应 Runtime 通用配置。
单项检查不扩大为全量检查，不增加检查深度，不把历史或全局检查成功变为执行条件。
已运行 CLI 保持原启动环境；新建 CLI 读取当前基础环境及配置。

刷新直接沿用既有输入比较、发布时重读最新保存配置、短锁及结果写回围栏。有效输入未变不推进搜索
generation；实际变化时按既有规则推进。刷新保留保存的程序路径和环境变量，不新增缓存、状态机、
完整环境持久化或第二套代次管理。

## 环境变量作用范围

- 基础环境为 Host 原生继承环境，加上统一采集的 PATH。
- 全局 Runtime 检查叠加该 Runtime 的通用环境变量，不读取队员私有变量。
- 队员新建 CLI 按继承选择叠加通用变量，再叠加队员变量；同名显式配置沿用既有覆盖优先级。

例如依赖 `ASDF_DATA_DIR` 的 shim 可以由用户填写 Runtime 通用变量，使检查和继承通用配置的队员
都获得该值；只填在队员配置中则仅影响该队员。该例沿用通用配置机制，不构成版本管理器专门适配。
