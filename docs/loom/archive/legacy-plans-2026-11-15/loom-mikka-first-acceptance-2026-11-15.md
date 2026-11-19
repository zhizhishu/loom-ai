# LOOM Mikka-first 实机验收合同与状态矩阵

> **历史归档 / LEGACY_TEST_MATRIX / 不再作为 Core V2 施工指令。** 用户最新要求「本轮只整理架构、不开工」，后续唯一入口：[LOOM V2 总计划](../plans-2026-11-18/LOOM-V2-MASTER-PLAN.md)。此文件原始正文与当时测试结论仅作历史证据；原字节 SHA256 快照在 [历史归档](README.md)。**不得依据下文旧“已授权开工/唯一入口”重新派工**。

> 2026-11-15 开工版本。此表 **不是整体验收完成表**；只对本轮确有回执的局部 E2/E3 项标 `PASS`，其余保持 `NOT_RUN`。历史旧版本测试另列。优先 T2/T4 主线；用 E0 方案、E1 源码、E2 单测、E3 双进程集成、E4 真 Runtime、E5 真跨机、E6 故障注入、E7 生产观察区分证明等级。

| ID | 验收场景 | 必须有的真证据 / 成功标准 | 最新本轮状态 |
|---|---|---|---|
| T0 | Bot identity | 两个终端登录同一用户，Bot/Goal/Memory ID 一致；退出重登状态不丢 | NOT_RUN |
| T1 | Goal/Step/RunAttempt | 同 Goal 多 Step、多可区分的 RunAttempt，用户接受与模型完成分离 | NOT_RUN |
| **T2** | **B 无 Harness 的 Device Node** | Win B 上 **无 Pi/DSH/Codex 安装或进程**；A 的真正 Runtime 调用 B 的文件工具；B 提供原始回执 | **E3 子集 PASS**：同 Windows Host/Node 双进程读真实文件，Node `clis=[]`；**A Cloud→物理 B + AgentRun 的 E5 仍 NOT_RUN** |
| T3 | B 受限终端 | A→B 的真实命令，cwd 指定、输出大小受控、timeout/取消/exit code 一致；不得直接任意高危 Shell | NOT_RUN |
| **T4** | **Artifact/Review** | B 文件/命令产生 `InvocationReceipt` → LOOM Core Evidence → Artifact/Review 实际读回，有设备/trace/hash | **NOT_RUN / W12 SAFE_BLOCKED**：Run target 强制 CLI installation 且 E3 FilePort 与 archive transport 分离，见 [W12A/B/C](loom-mikka-first-device-invocation-seam-2026-11-15.md) |
| T5 | Grant deny | Device 无授权/过期 Grant/切换 Workspace 时明确拒绝，不能无声 fallback | NOT_RUN |
| T6 | Path escape | `..`、junction/symlink、相对路径和间接 shell 路径试越界一律拒绝 | **E3 `..` 拒绝 PASS；junction/symlink/shell 全矩阵 NOT_RUN** |
| T7 | Unknown Outcome | 执行中断网/请求超时/重复 invocation 时幂等；危险副作用先 reconcile 不盲重发 | NOT_RUN |
| T8 | Local Runner | B 本地 Pi/DSH/Codex 可选注册，云端不用为了“有设备”而强制装 CLI | NOT_RUN |
| T9 | Hybrid goal | 同一 Goal 关联 Cloud Pi + Win Device + Mac local Runner 多 Run 与 Review | NOT_RUN |
| T10 | Windows Computer | DXGI/虚拟屏/RDP 输入支持与禁用条件区分；锁屏/UAC 降级，不能绕过 | NOT_RUN |
| T11 | macOS Computer | TCC 屏幕/辅助功能缺项有精确能力状态，真实授权通过才操作 | NOT_RUN |
| T12 | Linux Computer | X11/Wayland/纯 headless 能力分别探测，unsupported 不伪装 enabled | NOT_RUN |
| T13 | Human takeover | 旧 controller epoch 输入被拒，暂停 Bot、归还后新 epoch 才允许 | NOT_RUN |
| T14 | Needs-you / Attention | worker question/审批/结果项进入 Bot 注意力流，回复触发 wake、重复事件只处理一次 | NOT_RUN |
| T15 | 4 能力与记忆 | Skill/MCP/Rule/Hook 每类需 `discovered/selected/configured/loaded/invoked/evidenced` 独立回执；Memory 独立 | NOT_RUN |
| T16 | Pi/DSH bake-off | 相同 DeepSeek V4.1 Flash/max、相同 Repo/权限/任务，比较成功/成本/恢复、无 fallback | NOT_RUN |
| T17 | 多用户/租户 | 用户 A 不能访问用户 B 的 Bot/Workspace/Device/Memory/Artifact/Grant | NOT_RUN |
| T18 | 当前 UI 回归 | 原有 3 栏/Tab/群聊/任务不回退；大头像 1/3、眼随鼠标、窄屏/可拖、reduced-motion | NOT_RUN |
| T19 | 品牌图三 | 用户指定粉发绿眼猫耳源图可追溯；真 RGBA、明暗底边缘、favicon静态、左上品牌与 Bot 身份分离 | BLOCKED: 原素材不在已核验本地项目 |
| T20 | 代码与凭据隔离 | 不读取/回显 API Key，Win 本机 Claude Code 不启动，Bero Docker 不挂真实 key/home | 本轮执行守卫；完整测试 NOT_RUN |
| T21 | 并发稳定性 | 2 台 Device 并发 20 requests 无身份串扰，失败可重放/对账，日志不含密钥 | NOT_RUN |
| T22 | 性能与费用 | p50/95/99 RPC、PTY startup、Coordinator wake、React resize FPS、model tokens、费用归因 | NOT_RUN |

## 本轮已证据化的新结果（E2/E3，不代替 E5）
- `_artifacts/loom-execution-20261115/pure-device-runs/3d1ec28e1a214fc5827c11a678b4c795/pure/evidence/e3-proof.json`：`status=PASS`、`clis=[]`、`activeRunCount=0`、真实 File list/read 往返 `44 bytes`、`../outside` 返回 `path_rejected`。真实 Host/Node/WebSocket 两进程在**同一 Windows 机器**、临时 loopback/隔离 DB，**没有 AgentRun 或 Artifact 回写**。
- `_artifacts/loom-execution-20261115/node-build.log`：Node 本轮隔离候选编译 exit0。其扩展 `git.log`/ `git.diff.stat` 的新单测仍 **NOT_RUN**（Rust Core dev 依赖编译超时）。
- `_artifacts/loom-execution-20261115/protocol-tests.log`：新增 grant/receipt 草案 4/4 PASS；`protocol-full-tests.log`：整 Protocol 33/33 PASS。只是候选协议校验、**还没有接入实际设备授权链**。
- `_artifacts/loom-execution-20261115/node-prebuilt-full-baseline.log`：旧预编译 Node 用例 55/0/2，非本轮新源码测试；历史 10053 尚不能宣告销项。
- Bero 根分区 100%，Docker 编译阻塞；`pnpm docs:check` 本轮 FAIL 是两份旧 v1.72 版本文档的确认元数据未满足。见本轮执行看板。

## 目前已有的历史观察，不能推广为本轮 PASS

- **Windows 64851 服务**：本轮探针返回 reachable=true；只是本地现有服务可连，不等于新设备功能可用。
- **Hero 旧实验**：`Inspector.tsx/product.css` 方向性 Vitest 30/30、Web 构建 exit0（旧独立预览）；本轮未复测，品牌图未实现。
- **Device-only 旧实验**：Rust `loom-node` 54 通过/1 失败（Windows socket 10053）/2 忽略；双节点 T0–T7 fixture AST 通过但未执行；不得报完成。
- **模型/工兵**：本轮 Pi Skill doctor 显示模型目录 drift；只有 run 的成功回执及真正 tool events 才是 E4。安装 Python、Pi CLI 不是模型通过。
- **Bero**：本轮 Komari 一次性远端只读命令 `uname -s; id -u; command -v docker; command -v cargo; uptime` 成功；返回 Linux/root/Docker 可用、Cargo 未报告。它只是环境探针，不是 LOOM 云端部署。

## 最小纵切验收日志模板

```text
CASE T2/T3/T4:
HOST_A=os / instance-id / isolated_data_root / runtime-version
DEVICE_B=os / device-id / running-processes prove NO Pi/DSH/Codex
NETWORK=transport / route / auth / grant scope
GOAL_ID / RUN_ATTEMPT / INVOCATION_ID
REQUEST=operation+bounded cwd+safe fixture data
DEVICE_RECEIPT=status+exit+stdout_digest+observedGrantVersion
CORE_READBACK=Artifact/Evidence ID+hash+Review state
NEGATIVE=grant deny / replay / disconnected unknown_outcome
COMMANDS=exact executed commands and exit codes
RESULT=PASS / FAIL / NOT_RUN
LOGS=relative immutable evidence paths
ROLLBACK=exact flag / branch / snapshot
```

## 强制安全负例

- 与外网/真实凭据/真实用户数据库彻底隔离；真用 Windows B 只在独立 fixture root，且默认先 read-only。
- 未授予 `file.write` 不允许写；`shell.exec` 即使工作区允许也必须经过命令枚举/路径与会话 token 双侧校验；防符号链接/junction 和 TOCTOU。
- 注销设备或撤销 Grant 后，已经排队但尚未执行的请求须拒绝；“收到了 ping”不是最终授权。
- 屏幕/控制始终经过用户本机同意，不能借 UI “看屏”偷授输入权；锁屏/UAC/TCC 限制不能规避。
- 凭据作为敏感进程环境值，不进 argv/log/截图/Artifact；所有日志 redaction 测试不可省略。

验收独立于任务板上的“工兵做完”：用户最终接受与内部 `accepted` 也分别记录。待 T2/T4 E5 通过后，才可把首条链称为真实跨设备可用。
