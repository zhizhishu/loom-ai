# LOOM 落地验收书：Win11 安装 → bero 收尾 → 云端远程 → 助手注入（2026-10-29 起）

> 配套交接书：`handoff-win11-remote-2026-10-29.md`。主助手只按本表判；工兵自报、ok:true、截图文件名都不算证据。

## 0. 通用判据
- 证据 = 命令 + commit hash + 原始输出尾部 + 时间（CST）。缺一条 = 未验
- 全量 Rust 只允许基线 3 个失败（database_admission / IdentityChanged{stage:Revalidation}），第 4 个失败即 FAIL
- 每个被 push 的 commit 必须有 bero 上 `cargo fmt --all -- --check` exit 0 的证据
- 合入后对应 Actions run 必须绿；红了贴失败步与原因
- Win11 实机证据由用户截图或主助手亲见，截图须核对图内内容

## 1. 阶段 1：GitHub 出安装包
| 编号 | 项 | 命令 / 动作 | PASS 判据 |
|---|---|---|---|
| W1 | 触发打包 | `gh workflow run windows-package.yml --ref main -R zhizhishu/loom-ai` | Actions 运行绿；记 run id 与 commit |
| W2 | 产物校验 | `gh run download <run-id>` | 有 `Rovai-AI-<version>-x64.exe`；verifier 步骤通过（PE32+、manifest、hash） |
| W3 | 失败处理 | — | 失败时贴失败步与日志尾 30 行；不许改 workflow 硬凑成绿 |

## 2. 阶段 2：Win11 实装
| 编号 | 项 | 动作 | PASS 判据 |
|---|---|---|---|
| W4 | 启动 | 当前用户安装，不提权，双击启动 | 无崩溃弹窗；Core health 正常 |
| W5 | 真实链路 | 接入已装 Runtime（如 Claude Code） | 真 AI 完成一次对话；跑完一条 LOOM 链：导入计划 → 认领 → 交付 → 验收 |
| W6 | 重启持久 | 关闭再打开 | 数据仍在；无 `IdentityChanged` 报错（若出现，记录并转 B1） |
| W7 | 卸载 | 默认卸载 | 程序移除；用户数据按文档保留 |

> 上游从未验过 Win11，W4–W7 是本 fork 第一份 Win11 证据；对外口径仍为 `Windows x64 Preview — unsigned`。

## 3. 阶段 3：bero 收尾
| 编号 | 项 | 命令 | PASS 判据 |
|---|---|---|---|
| B1 | 基线失败根因 | bero 全量 cargo test | 根因写进文档；若是真缺陷，修复后全量失败 < 3 |
| B2 | 回归 | `--lib loom`、`pnpm test:loom-core`、夹具、typecheck、fmt | `--lib loom` ≥ 75 且 0 失败；其余 0 失败；最终 commit Actions 绿 |

## 4. 阶段 4：云端控制面 + 远程调本机
| 编号 | 项 | 动作 | PASS 判据 |
|---|---|---|---|
| R0 | 选型 | 调研 GitHub 自托管 agent 网关 / MCP over HTTP/SSE 桥接 | 出对比表并经用户拍板 |
| R1 | 端口不外露 | 外网端口扫描 | 公网扫不到本机端口 |
| R2 | 远程可用 | 手机经隧道访问 | 完成一次对话 + 一次 LOOM 裁决 |
| R3 | 鉴权 | 发未验证身份请求 | 被拒且有日志；`--allow-insecure-lan` 已去掉 |

## 5. 阶段 5：助手注入 skill / hook / MCP / 规则
| 编号 | 项 | 动作 | PASS 判据 |
|---|---|---|---|
| S0 | 调研 | 查 hook / MCP / 规则有无按队员入口 | 结论写进文档 |
| S1 | skill 注入 | 给一个队员选自定义 skill | 该 Run 的 ContextManifest 含此 skill |
| S2 | MCP 隔离 | 给一个助手配专属 MCP | 该助手可调用；其他助手不可见 |

## 6. 一票否决
- 碰上游 murray17/rovai-ai（PR / Issue / 分支 / push）
- 对公网裸开本机端口
- 验收进程指向日常 userData
- skill-cli 仓库 `git add -A`
- 为通过而删或禁用既有测试
- 把工兵自报写进验收结论

## 7. 记录格式（每项一行写进 skill-cli/TASK.md）
[W1] PASS | commit abc1234 | gh workflow run windows-package.yml | run 4xxxxxxxxxx 绿 | artifact Rovai-AI-x.y.z-x64.exe | 2026-10-xx hh:mm CST
