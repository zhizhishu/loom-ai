# LOOM 当前实现与 E0–E7 验收

> **CURRENT IMPLEMENTATION STATUS · 2026-11-17 续开发，未签收。** 本页是 LOOM V2 **实现进度、失败和真实验收唯一汇总**，不是架构规范、第二开发书、发布声明或用户审批。最新状态看下面续开发实测；原固定 SHA 的历史证据保留，不冒充本次全量回归。

产品要做什么看 [PRODUCT.md](PRODUCT.md)，已选 Mikka/PiBot 三栏 UI 与用户指定猫耳品牌看 [DESIGN.md](DESIGN.md)，具体 Runtime/能力/设备接口看 [productization-interfaces](docs/loom/productization-interfaces-2026-11-13.md)，13 个参考项目看 [参考锁](docs/loom/LOOM-V2-REFERENCE-LOCK.md)。P0–P14 原设计保留于 [冻结蓝图](docs/loom/LOOM-V2-MASTER-PLAN.md)，不在本页重复叙述。

## 给云上施工 Agent 的用户建议（2026-11-17，非规范）

> 下面是 User 给任何来仓干活的 Agent（含云上长跑任务）的三条建议。**是建议、不是规范；User 明说可能讲错**——与仓内文档或实测证据冲突时，以文档和实测为准，并把冲突点在交付报告里指出来，别静默二选一。

1. **放心学参考项目，别不舍得花时间。** 已批准的 13 个参考项目与"借什么、不许借什么"逐条写在 [docs/loom/LOOM-V2-REFERENCE-LOCK.md](docs/loom/LOOM-V2-REFERENCE-LOCK.md)，施工前把对应条目读透再动手，研究比闷头写代码值钱。注意：固定镜像在本机 `_artifacts/reference-repos/` 与父仓 `_references/`、**不随仓库分发**；云上环境若读不到镜像，以锁定文件里的固定 SHA 和第二节研究结论为准，能溯源公开上游时自行核对。
2. **别把本机环境当成通用平台事实。** 本机 Claude/Codex/DSH/Pi 四端的 Skill/MCP/Hook/Rule 是以本机 `~/.claude` 为源本定制适配过的，行为特殊。你在本机观察到的某个端的行为（如原生 skill()/hook 不触发）可能是这份适配造成的；给 Runtime 接入或探测下结论时按目标端的官方文档和通用默认环境判断。
3. **Runtime 对接优先走 ACP 通用协议。** 尽量按 ACP（Agent Client Protocol）公开文档的通用规范实现，ACP 覆盖不到的端能力再考虑该端私有 SDK。注意 **ACP ≠ ACCP**：ACP 是线协议，ACCP 只是参考项目里的协作控制面，两者不得合并成"第五 Runtime"。

## 2026-11-17 续开发实测（未签收）

**2026-11-17 本轮个人版收尾（以下新证据优先）**：c399 的 Windows E3 `44158565571` 已通过；本节修复与该旧包分开记录，新源码候选须另行构建验证。

- **真实返工卡点已修，整链复验继续**：`web-refresh-ui-04` 暴露同路径新内容被 Core 拒绝登记，Worker 改用新文件名又被审核要求原路径，A 任务耗尽返工次数。现按 Task/生产 Run/作者/SHA 保留同路径的不可变版本，旧 Candidate 继续指向旧归档；schema 185 / receipt 235 迁移不改历史记录。18 项针对性 Rust、68 项验收脚本与真实旧 SQLite 只读迁移核对通过，来源见 `resume-05/artifact-version-core-build.json`。整链要求两项任务最新稿都通过独立审查、原路径返工、旧归档仍可读，不能用一项任务成功代表整体通过。
- **成果界面与连接入口已修**：持续更新时不再漏文件，同一工作刷新不清掉控制表单草稿；最新版先显示，历史版保留，卡住直接显示原因。实际 Electron 29 项交互与 10 张桌面/手机日夜截图通过，见 `_artifacts/loom-v2-user-authorized-20261115/ui/run-kI0HTs/screenshots/report.json`。原连接配置编辑器已接回新壳，四运行端入口、保存后读回、草稿保留、冲突处理和桌面/手机日夜布局等 8 项通过，见 `resume-05/runtime-settings-ui/run-TcZkwH/screenshots/report.json`。两组使用生产界面和合成传输，不代替真实模型链；类型检查与生产 Web 构建已通过。
- **安装与电脑运行包已补齐**：`resume-05/personal-install-live.json` 用当前安装器配 c399 实包，实际安装、原 Start-Loom.cmd 启动、登录、重启后身份/助手/偏好保持通过。程序与个人数据分开，跨数据格式降级拒绝，启动前核对完整文件清单；缺管理脚本时明确报包不完整。原候选遗漏的 helper/bridge/Python/Pillow 已加入固定版本、哈希和许可证打包；当前电脑授权 Rust 27/27、包内 Python 43/43（另 1 项非 Windows 适用项跳过）、专用测试窗口截图/点击/输入/停止 4/4 通过。页面授权与助手真实桥接仍在验证，不能把本机 helper 成功当作整段已通过。
- **运行端结果按实际记录**：`resume-05/dsh-diagnostic-03/evidence.json` 的 Rule、MCP、原生 read 读取冻结 Skill 与反选新 Run 通过；原生 Skill 注册表仍未验证，Hook 仍 NOT_RUN。健康失败诊断修复的两条远端测试通过，见 `dsh-health-regression.json`。`resume-05/codex-capabilities-02/evidence.json` 的原生读取冻结 Skill、Rule 与反选通过；原生 MCP 目录和首轮工具声明存在，但模型实际调用为 0，MCP 不通过。Windows Claude 保持既有准入边界。旧受管接线写入的安全拒绝保留，不绕过。

**测试入口纠正**：`current-ui-versioned-01` 已停止并作废。Host 静态内嵌 Core，旁置新 Core.exe 不会替换 Host 内部实现，该轮实测库仍为 schema 184。新编译 Host 在 `current-ui-versioned-02` 已通过实际数据库 185/235 检查，但发现本机 GNU 构建主线程栈只有 2 MiB；该轮在打开 UI 前停止。现已将项目 build.rs 的既有 Windows 8 MiB 设置补齐到 GNU 与 MSVC，四个二进制重链 exit 0，PE 实读均为 8388608，见 `computer-current-host-build.json`。新增入口缺管理脚本拒绝、双工具链栈检查以及 11 项 workflow 契约回归通过。正式再跑前同时检查二进制、实际库版本和生产 Web 来源；只复用经核验未变的 Pi 运行包。新增 Host 版本与 Lead 失败提前结束检查 24/24 通过，见 `host-schema-lead-guard-result.json`。旧失败原样保留，脚本不代用户接受成果；同源候选须从本轮提交重新构建。

- 已推送 `50c998f`（容器健康探针）、`9dcbd86`（原生接力范围 UI 与候选下载核验）、`ab22407`（调度尾项结算及显式受限 Pi 工作流工具）。当前未提交修复继续保留，不等于上述提交已经包含全部后续改动。
- 本机新 Core/Host 编译完成，生产 Web 构建与类型检查完成。DE-BERO 对固定 `ab22407` 曾为 **631 passed / 5 failed / 1 ignored**，原失败保留于 `bero-core-final.json`；后续限定修复经 `resume-02/full-r2-device-observe.json` 复核为 **636 passed / 0 failed / 1 ignored**，Web Node 专项 **22/22**。这是带记录补丁的工作树验收，不伪称原 `ab22407` 已自动变绿；原 SHA Windows E3 仍失败，无最终候选包。
- 真实模型首次服务旅程曾因尾项调度未结算和错误使用可变工作区校验旧归档而失败；旧失败保留于 `_artifacts/delivery-20261116/live-lead-01/`。后续修复已由下述 `ui-07` 的同次正式 UI 旅程及独立归档复核验证，旧失败仍原样保留。
- **节点回归已取回终态**：`resume-03/bero-regression-readback.json` 确认同一限定补丁全套执行退出 0：Core 636/0/1、Web Node 22/22、Linux B1–B6 六个真实二进制进程级验收全部 exit 0。它们涵盖配对/拒绝、恢复、能力、shim、执行主机和文件，不替代当前另跑的商用模型 DevicePort 跨物理主机闭环。
- **正式 UI 同次真实旅程已通过**：`resume-02/ui-07/report.json` 证明页面创建并启动工作、模型 Lead 建两个任务、页面明确批准范围与独立 reviewer、两 Worker 首稿与返工、真实归档预览；`supervisor-verification.json` 另以只读 SQLite + 原始归档独立核对 **13 Run 全成功、4 Claim、4 Artifact/4 Candidate、REQUEST_CHANGES 2 + PASS 2、10 dispatch 全 SETTLED、重复派发 0、批准前 Worker 0**。四份归档 SHA 与字节完整，Candidate 全 PENDING，**Owner Review 0**。真实截图已检查；早期 `ui-01` 至 `ui-06` 失败原样保留。测试模型配置由隔离 setup 准备，不冒称用户从空白安装完成全部配置。
- Windows Node 真配对已证实。跨机验收首次因脚本标签非法而失败，修正后到达文件读取并暴露 Linux Host 用本机 Path 解释 Windows 根路径的缺陷；修复保留设备端路径围栏，尚待回归。证据：`bero-mission-readback.json`、`cross-workspace-valid.json`。不把 pairing 当作完整 Grant/Artifact/执行中恢复通过。

- **现代 DevicePort 真实跨机与运行中恢复已通过**：`resume-02/device-model-05/report.json` 和 `supervisor-verification.json`。Windows 本地商用模型在真实 Run 内通过已授权 Workspace RPC 读取 DE-BERO 的 device-only Node；同一 Run 在 online generation 1/2 各完成一次读取，掉线期间保持运行，重连后同一 Node 执行 `git.status` 并再次读取。主管从只读 SQLite、4 条真实 completed RPC 和原始归档独立核对：两次远端读取与源文件及 116 字节归档 SHA 完全一致，Candidate PENDING、Owner Review 0。模型凭据未发到远端；这是本地 Runtime + 远端 DevicePort，**不是远端模型推理，也不是 UI 发起的跨机用例**。本轮的旧失败（属主、回执误判、新隧道 DNS 尚未就绪）全部保留。

### 本批集成提交与当前阻断（resume-04）

- **已独立提交并推送 `b9b5f82`（40 文件）**：正式 UI 接力、现代 DevicePort 恢复、迁移修复、缓存代次和跨 OS 预览。源码核对、提交范围与测试回执分别在 `resume-04/integration-commit.json`、`tested-source-verification.json`。原 WIP、私有配置和其他研究没有打包混入。
- 第二视角指出的预览缓存目录拼接与客户端限额问题已修；主管复跑 DE-BERO Web 全库 **132 passed / 0 failed / 0 ignored**，原生 UI **322/322**、辅助验收 **107/107** 和类型检查通过。独立安全复核仅批准该两处，不冒充完整产品安全认证。
- **DSH 真实 relay 模型、Rule、MCP 和反选负例通过**：`resume-02/dsh-07/supervisor-verification.json` 独立核对原 Run 的持久 Bootstrap 原文/哈希与回复；原失败报告未覆盖。`dsh-08` 使用正式证据读取器，在运行期间捕获了选中 Skill 的冻结正文与版本，但原生 `skill()` 未加载它，Skill 仍不通过；Hook 尚无已验证传输。55 项路由/证据单测通过不能替代这两格实测。
- `b9b5f82` Windows E3 在全库门得到 **645 passed / 11 failed / 8 ignored**，没有生成个人版包。正修测试目录创建前置和 Windows 路径夹具；产品权限检查和原断言未关闭。两份 v1.72 模型上下文变更的真实人工确认仍缺失，未伪造确认字段。
- 原生 DSH Skill 接线改写的工具请求被安全检查拦截，未重试或绕过；诊断与上游原生 Provider 接口依据留在 `resume-04/dsh-skill-native-conclusion.json`。这部分未实现、未验收，不能用已有文件物化替代原生加载。

本批主要证据目录 `_artifacts/delivery-20261117/`；已通过 UI、Core 与跨机复测位于 `resume-02/`，继续施工位于 `resume-03/`。当前剩余是四端实际支持矩阵、同源候选和完整门禁；扩大 Web 全库曾得 117 PASS / 13 FAIL；限定测试前置/契约黄金值/夹具语法修复后，已从 DE-BERO 取回 **130 passed / 0 failed / 0 ignored、容器 exit 0**（`resume-04/bero-web-final.json`）。原生 UI 全量 **24 文件 / 322 测试通过**（`resume-03/native-ui-full.log`）。这些是当前带记录补丁的回归，不把旧 Git SHA 的 CI 失败改写为成功。以下 2026-11-16 的 E0–E7 表及固定 SHA 分项作为历史基线保留；本节新失败与实测优先，**不代表正式发布或最终签收**。

## 2026-11-16 历史交付位置

LOOM V2 已有 Windows 隔离预览、双真实 Core→Pi Worker、Codex 原生文件 Artifact、DSH 原生压缩、正式 Web 的两份待审结果和 GHCR→DE-BERO 隔离 Host/Web 镜像；**尚未通过完整四端能力矩阵、真实设备配对与跨机任务、运行中断线恢复、真人 Owner 验收或正式发行**。最近一次只读巡检未见日常 `64851` 监听，原因未知；本轮文档收口不更改或替换原服务与用户数据。当前已发布版本指针仍是 `v1.72`，V2 开发分支不自动切版。

## E0–E7 核验表

| Gate | 已确认的实证范围 | 尚未通过 / 不可冒称 |
|---|---|---|
| **E0 · 初始设计/合同** | 产品边界、V2 阶段蓝图与首批设计合同已建立 | 设计蓝图不等于全部 V2 正式 IDL 和数据迁移冻结 |
| **E1 · Core 与 UI** | 新 Core/协调器/Adapter、`loom-native` 工作台、能力/任务只读投影有实际实现 | 旧用户数据到 V2 的完整迁移与产品所有闭环尚未验收 |
| **E2 · 基线测试** | 此前有 Rust **76/76**、Node **78/78**、UI **67/67** 通过的阶段基线 | 此处不是对每次新改动重新跑过的全量通过声明 |
| **E3 · Windows/Linux 隔离候选** | Windows E3 [#43864920990](https://github.com/zhizhishu/loom-ai/actions/runs/43864920990)、Linux 容器 [#43864912038](https://github.com/zhizhishu/loom-ai/actions/runs/43864912038) 对 `e4a0aea` 均 **success**；`8310fcd` 预览包 **6786 文件 SHA256 一致**；旧 `7ee4fdf` E3 亦通过 | E3 主要是候选构建/模拟 Provider，非正式 Release；Linux debug Host/Web **未封包 Pi**，不代表四 Runtime 已可用 |
| **E4 · 真实模型/多 Worker** | 旧 `7ee4fdf` Pi Purge 单 Run 通过；`8310fcd` 同 Mission **两个真实 Core→Pi→DeepSeek/max Worker**，执行前 Claim/Fence、108/147 字节 Artifact、错误 Fence 拒绝、人格隔离及两份 PENDING Candidate；`6150aed` Core→原生 Codex `workspace-write`→78 字节 Artifact 通过 | **部分通过**：Candidate 由受信 Host 录入，不是自动 Lead 审查返工；正式 Web 只读查看，未从 UI 点击启动整链；DSH 原生压缩不等于 Core→DSH，Windows Claude 仅发现，四端四能力尚未全验 |
| **E5 · 跨机** | GHCR 固定 digest 镜像已在 DE-BERO 真实拉取并以 uid 10001、本机回环运行，实际认证、Mission 写入读回、未认证 API 401、受控退出和同卷重启持久化通过 | **未通过**：镜像不含 Pi；没有 Windows Node 真配对、授权跨机工作区/工具任务、Artifact 回传及失联恢复 |
| **E6 · 恢复/副作用** | 已完成 Pi Artifact 恢复 **3/3**；DE-BERO Host/Web 同卷重启后 Mission/Thread 与登录数据保持 | **部分通过**：已完成成果与 Host 存活性，不代表执行途中断线、旧 Lease/Fence、未知副作用及跨机续执 |
| **E7 · 用户验收/发行** | Windows 候选和 Linux debug 镜像已出；正式 Web 能读两份真实 Artifact 并显示 Review 控件，Candidate 仍为 PENDING；[PR #17](https://github.com/zhizhishu/loom-ai/pull/17) 为 Draft | **未通过**：Owner Review=0、尚无正式 Release、日常升级/回滚及真人签收；自动化鼠标不代用户接受 |

## 跨仓接口与个人版门禁分项（2026-11-16；基于既有证据，非新运行）

> 以下 PASS 仅指固定源码或原生专项的**单切片**；本轮更新计划和接口文档，没有再次启动模型/设备。FAIL / NOT_RUN 不得折算成整体百分比，用户 Owner 仍未签收。

| 验收切片 | 状态 | 证据及不应扩大的边界 |
|---|---|---|
| E4-A 双 Pi Worker、执行前 Claim/Fence、108/147 字节真实 Artifact | **PASS** | `8310fcd`，`_artifacts/loom-personal-delivery-20261116/dual-supervisor-verification.json`；Candidate=PENDING |
| E4-B Core→Codex 原生 workspace-write 真实文件 | **PASS** | `6150aed`，`codex-supervisor-verification.json`；不等于 Codex 全场景可写 |
| E4-C DSH 原生压缩和故障专项 | **PASS（原生专项）** | `dsh-supervisor-verification.json`，`CoreIntegrated=false` |
| E4-D 生产 Web 已有 Artifact 的正文和 Review 控件展示 | **PASS（只读展示）** | `production-ui-verification.json`；不含 UI 发起真实 Run 和 Owner 接收 |
| E4-E Lead 自动拆 Goal / 从正式 UI 发起全旅程 / 自动返工 | **NOT_RUN** | 两个 Host 受信启动 Worker 不能替代此项 |
| E4-F 四 Runtime × 四能力完整 Loaded/Invoked/Evidenced | **NOT_RUN（完整矩阵）** | Pi/Codex/DSH 分项不代表全部 16 格；Windows Claude 仍不执行 |
| E5-A DE-BERO Linux Host/Web 登录与 Mission 持久化 | **PASS（分项）** | `e4a0aea`，`bero-container-supervisor-verification.json`；镜像无 Pi |
| E5-B Device Node 真 pairing、Grant、跨机工具、Artifact 回传 | **NOT_RUN** | TLS/登录不能当配对 |
| E6-A 已完成 Artifact 与 Host 重新启动持久化 | **PASS（分项）** | 已有 3/3 已完成 Pi 成果恢复和 Linux 重启证据 |
| E6-B 执行途中掉线、旧 Fence、未知副作用对账 | **NOT_RUN** | 完成后能读不代表中断时安全恢复 |
| E7 Owner 真人 Review、正式 Release、升级与回滚 | **NOT_RUN** | Owner Review=0；不以脚本代签 |
| 旧 v1.72 通用文档 CI 人工确认 | **FAIL（历史已知）** | 两份 `model-context-change-loom-*` 缺真实 `confirmed_*`；不得自动造批准 |

今后每条验收至少绑定 **Git SHA、实际 Runner/Runtime、Run/Grant/Fence、原生结果、Artifact SHA、PENDING/Review 状态、负例与退出码**。正式字段/错误码只能在既有 Contract 内冻结；不能因为这份治理附注出现某词，就宣称新字段/新功能已实现。


## 2026-11-16 最新分项实测（固定源码 `6150aed` → `8310fcd` → `e4a0aea`）

> 以下结果取自本机 `_artifacts/loom-personal-delivery-20261116/` 的**主管复核 JSON**及相应 GitHub SHA；与后面的 `7ee4fdf` 历史单 Run 记录分开保留。原始会话/凭据不上传 Git。

| 验收切片 | 实际证明 | 未证明 |
|---|---|---|
| **双 Pi Worker** · `8310fcd` | `dual-supervisor-verification.json`：同一 Mission 两个 Core 创建的真实 Run，`deepseek-v4.1-flash/max`，两个 Claim **都早于 Prompt/文件写入**，14.8 秒执行重叠，108/147 字节独立 Artifact；错误 Fence 被拒、人格隔离，两份 Candidate **PENDING**，Owner Review=0 | Candidate 由受信 Host 提交，非自动 Lead 规划与审查返工 |
| **Core→Codex 文件** · `6150aed` | `codex-supervisor-verification.json`：真实原生 `workspace-write`（无网络），78 字节真实 Artifact、输入标记、Run succeeded，权限冻结与有效回读一致 | 只是一个真实文件任务，不等于全机权限或四能力可用 |
| **DSH 原生压缩** | `dsh-supervisor-verification.json`：压力触发、溢出自动重试、usage、取消/失败不破坏状态、冷启动恢复六类检查通过 | `CoreIntegrated=false`，不能冒充 Core→DSH |
| **正式 Host/Web 待审 UI** · `8310fcd` | `production-ui-verification.json`：真实 Bearer 登录，两个已生成的实际 Artifact 可预览正文和 Persona/nonce，Review 控件可操作，未认证 API 被拒 | **只读查看**，不包含 UI 发起模型任务，未代用户点击接受 |
| **候选构建与实机 Linux** · `e4a0aea` | Windows E3 [#43864920990](https://github.com/zhizhishu/loom-ai/actions/runs/43864920990) 与 Linux 镜像 [#43864912038](https://github.com/zhizhishu/loom-ai/actions/runs/43864912038) completed success；`download-verification-8310.json` 证明 6786 文件闭包完整；`bero-container-supervisor-verification.json` 证明 DE-BERO 按 digest 拉取、登录/真实 Mission、同卷重启保持 | Host/Web debug 镜像无 Pi；没有设备 pairing、跨机工具；同 SHA 通用 [CI #43864920977](https://github.com/zhizhishu/loom-ai/actions/runs/43864920977) 仍失败 |

**实际镜像不可变引用**：`ghcr.io/zhizhishu/loom-ai-server-candidate@sha256:82a58638f459ef679f68315c03d96b9abfaf044ff4d0e64d4981421d6674cee0`。仅作为已部署的 **Host/Web candidate**，不是全功能个人版发行包。
## `7ee4fdf` 阶段：Pi Purge 与真实上游原始实证（历史记录）

| 交付 | 实际结果 | 边界与证据 |
|---|---|---|
| 本地架构图 | 已原位写入 `LOOM-V2-MASTER-PLAN.md` 的 B 节，Pi Purge 独立列入 4–6 周范围 | 产品目标图，不是所有功能已交付的状态图 |
| 原生上游协议 | DeepSeek V4.1 Flash/max 的 Chat、Responses、Anthropic **3/3** 真实请求通过 | 是三个协议通道，不是四个 Core Runtime 已完成；`provider-matrix-results.json` |
| 受管 Pi Purge 原生适配 | 新 `scripts/loom-v2-pi-purge-extension.ts` 与对应测试；固定原版 v0.3.0/SHA，Off/Append，按运行身份校验，重启后重新激活、拒绝漂移 | **78/78** 适配/桥/原钩子/stage 回归通过（含回执失败时不应用 Persona）；原有模拟桥仍明确模拟 |
| Pi Purge 真模型效果 | 早期原生三协议 Append + Chat Off **4/4**；本轮另完成真实 Core Append 与 Off/冻结控制各一例 | 早期 4/4 使用测试 Binding；本轮 Core 自建 Binding 证据单列下行，不能把几种不同验收相加为全产品完成 |
| Codex 权限事实修复 | 无模型请求的原生探针复现：workspace-write 请求返回 readOnly；已新增线程绑定/发 Prompt 前拒绝不一致的补丁 | 不修改原生权限、不强行开启写入；Bero 同提交的纯策略与进程边界回归 **2/2**，GitHub Windows 同一策略回归亦通过 |
| 可选扩展候选封包 | 保留上游 LICENSE/源码/SHA；默认 Off；`7ee4fdf` 下载包包含正确的 `runtime/extensions/pi-purge` 布局并通过全闭包哈希校验 | 不复制真实 Persona/账号/会话；不等于正式安装或日常升级 |
| Mindkit | TASK/PROJECT_CONTEXT 只留当前工作流与稳定约定，旧原字节与哈希归档；写入门/完整性检查通过 | 只写 LOOM 子项目，不写父 skill-cli 或全局默认 |
| **本轮 Pi Purge 接线与隔离闭环已验** | 助手服务 UI 34/34、原生78/78、新增 Rust 库测试1/1；Core 保存/冻结 Persona、真实新会话激活和 applied 回执、真实文件、Artifact 及 PENDING Candidate 均已核验 | Mindkit 本次冲刺 **5/5（100%）**；不是全个人版。UI自动测试/E3与真模型Core API切片分别记账，未冒充同一次真实UI点击旅程；TypeScript/Web构建属于此前同源码已通过记录 |

先前源码已分两次提交并推送：`d666c51`（适配器/权限回读/候选包）和 `5fc9142`（回执不可写时拒绝应用）。两次提交各自的完整 Windows E3 均通过；此前 `5fc9142` 本机 **78/78 + 新隔离目录真模型4/4**，GitHub run `43835826323` 的固定源码编译、Codex 策略回读回归、正式 Host/Electron E3、含隐藏依赖的 **6786 文件下载后闭包校验**全部通过，证明文件已取回本机。通用 CI 仍因既有 v1.72 真实人工确认元数据缺失而红；没有伪造批准或把 E3 写成完整 E4/E7。

上述早期原生增量的原始结果在 `_artifacts/loom-purge-next-20261116/`，不再新建交接书。`provider-matrix-results.json`、`purge-live-results.json`、`purge-unit-final.log`、`codex-policy-probe.json` 是相互独立的证据；本轮过程保存了实际失败与 Root 修正，不以工兵自报代替结果。

### 本次闭环收口证据（固定源码 7ee4fdf）

现有认证通过正常 Pi Skill 环境引用复用；未提取、外发或替换日常凭据。主管只读核对隔离 SQLite、原生 Pi 会话和实际文件：Append 的 Persona 随机标记未出现在用户消息中，却进入真实 **122 字节**成果；原生模型记录为 `deepseek-v4.1-flash`、思考档位 `max`。Artifact/归档预览/Candidate 哈希均为 `73cb63c2fe89bf117bcc6187769e804a53c74d94e75c8e0a04a2ded002e7f2aa`；Candidate 为 PENDING/UNVERIFIED，Owner Review 为 0。另一个独立 Off 用例在运行中保存 Append，数据库确认当前 Run 仍冻结 Off，成果无 Persona 标记，Candidate 同样待审。

原始证据与主管复核在 `_artifacts/loom-purge-ui-core-20261116/`：`supervisor-verification.json`、`off-freeze-verification.json`、`real-artifact-recovery.json`、`download-verification.json`；Rust/UI/Node 日志分别为 `rust-purge-resume.log`、`ui-resume.log`、`native-resume.log`。Host 配置目录可能在恢复启动时清理，激活及 applied 原始回执保存在归档的 `live-evidence-r2.private.json`，不声称重启后又读到了已清理原文件。原始会话与私有报告不随公开 PR 上传。

保留失败边界：首次在 `runtime.product.check` 超时，未创建 Run；编译结束后同命令、同安全门、全新隔离根重试通过，不能据此断言超时根因。补充 Host Rust 过滤命中 **0 测试**，不记作回归通过。本轮 Claim 为完成后取得、Artifact/Candidate 由受信本地 Host 验收入口提交；不代证执行前租约、自动 Lead 派工或用户最终认可。既有 7 个受保护文件哈希及日常监听归属未变。

## 下一段执行工作流（旧 P0 双 Worker 已实测，继续完成用户旅程）

**当前链路**：助手选择 Persona/Purge → Core 校验并冻结 Run Binding → 原生 Pi 激活 → 真实模型与授权工具 → Artifact/Candidate → 用户 Review。

| 顺序 | 实施位置 | 下一项必须实际出现的结果 |
|---|---|---|
| 1 | Lead 自动规划 / Review 返工 | 在已通过的两个真实 Worker 及执行前 Claim/Fence 之上，证明 Lead 可以按用户 Goal 自动拆分、分配、拒绝及重新派工，不重复做已完成的受信 Host 双 Worker 测试 |
| 2 | 同一次正式 UI 用户旅程 | 从助手/能力/Persona 保存→真实 Core Run→两个 Artifact→用户 Review；补 Pi Purge 无 Guard、错 Bot、旧 epoch/Applied 回执失败反馈 |
| 3 | 四端 × 四能力 | Pi/Codex/DSH/Claude 按平台实际支持，分别验证 Skill/MCP/Rule/Hook 选择→冻结→装载→调用→证据；DSH 单独压缩与 Codex 单文件已通过，不能代替整矩阵 |
| 4 | 真设备与恢复 | DE-BERO Host/Web 已部署；继续 Windows Node pairing、Grant、真实跨机工具回执、Artifact 回传、断线与旧 Fence/未知副作用 |
| 5 | 个人版发行收口 | 安装迁移与 dry-run、升级/回滚、日常实例状态确认、真人 Owner 审阅；完整 E7 未通过前不得标 100% |

## 阻塞和独立待验（不重复创建交接）

- **Codex 实效已补单切片**：先前 workspace-write 请求被原生回报 readOnly 的失败历史保留；`6150aed` 经独立受控 unelevated 原生沙箱得到真实 `workspace-write`，写入 78 字节并归档。尚不能推广到任意主机或完整四能力。
- **协作下个缺口**：`8310fcd` 双真实 Worker、执行前 Claim/Fence、两份独立 Candidate 已核验；仍欠自动 Lead 规划/返工、从正式 UI 启动的完整操作链、四端四能力实际 Load/Invoke 证据。
- **Purge 配置与反例**：当前通过用例显式使用 Core workspace 文件 Grant；Append 与无 Grant 的原生权限组合仍是运行时拒绝，配置期反馈待补。只读审查提出激活回执缺专属代次、Core 未将 applied 回执作为强制门禁的风险，尚未完成相关故障反例；不以本次正向通过消除此风险。
- **DSH/跨机恢复**：DSH 原生 0.1.5-rc.2 的自动压力压缩、溢出重试、用量、取消/失败隔离及冷恢复 **六类通过**；`CoreIntegrated=false`。跨机配对/工作区 Grant/真实工具任务与运行中故障恢复依然缺证。
- **治理门禁**：Windows E3 与 Linux 容器对 `e4a0aea` 均通过；通用 [CI #43864920977](https://github.com/zhizhishu/loom-ai/actions/runs/43864920977) **failure**，两份旧 v1.72 `model-context-change-loom-{productization,run-bundle}.md` 缺真实人工确认元数据，不得伪造 `confirmed_*` 消红。
- **发布边界**：GitHub 候选与 GHCR Linux debug Host/Web **不等于正式 Release**，镜像不含 Pi。最近 64851 监听缺失原因未明，不因文档整理启动替换日常进程；User Owner 必须亲自审阅。

## 证据、历史与更新规则

- 真实模型及恢复原始记录：[LOOM-LIVE-ACCEPTANCE-2026-11-16.md](docs/loom/LOOM-LIVE-ACCEPTANCE-2026-11-16.md)；本机隔离证据位于 `_artifacts/loom-live-resume-20261116/`，包括 `real-pi-file-artifact-summary.json`、`real-artifact-recovery.json`、`codex-native-summary.json`、`fixed-package-local-verification.json`、`bero-tls-admission.json`；含私有数据的文件不可随 PR 上传。
- 早期 P0–P7 产品化阶段、旧施工/交接和实验纪录已 [归档](docs/loom/archive/legacy-plans-2026-11-15/README.md)，其中 [旧版实施全文](docs/loom/archive/legacy-plans-2026-11-15/LOOM-IMPLEMENTATION-history-2026-11-13.md) 只用于来源追溯。
- 后续**只更新本页当前状态及证据链接**；产品边界归 PRODUCT、UI 归 DESIGN、接口归 productization-interfaces、参考 SHA 归 REFERENCE-LOCK。不要再开新的“总交接”“最新计划”“进度看板”抢占权威。
