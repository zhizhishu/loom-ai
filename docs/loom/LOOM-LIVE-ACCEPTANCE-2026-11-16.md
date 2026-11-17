# LOOM 真模型续建与交付验收 — 2026-11-16

> 本文记录这一轮已经实际执行的增量，优先于旧交接中“E4 全是假 Provider”“从未推送”“包内文件已完整交付”的过时快照。完整个人可用版仍未验收完成；历史失败与旧证据不删除。

## 用户执行偏好与边界

用户本轮重新明确批准继续开发和真实模型测试。开发工兵默认使用 `oct-chat/deepseek-v4.1-flash`、`--reasoning max`；实际原生客户端必须显示其支持并采用的档位，不静默换模型。优先复用本机 Base 路由、Pi Skill、既有 Runtime 与验收脚本，GitHub 编译、Bero 隔离运行；不另建执行中枢或模型循环。Root 负责文件白名单、代码集成和独立验证，工兵自报不等于验收。

未授权覆盖日常数据、现用进程、用户全局配置或五处历史 WIP；不以加速为理由绕过工具权限、复制账号秘密或代用户签收。当前能力执行调用有两处被平台阻断：手工提取/转交模型凭据、跨机发送新配对票据。没有重试同一提取/传输动作或通过其它工具绕过；正常 Pi Skill 的既有环境注入可用，真实模型验收走该正常路径。

## 本轮已经核验的事实

### E4：正式 Core → 真实 Pi → 实际文件工具 → Artifact

独立数据根在操作系统临时目录、没有 Git 仓库祖先。Core/CLI helper 来自 GitHub `5ca6028b1043f678f97dbbb0aff87cff24cb829e` 的同源 Windows 构建；Pi 来自独立完整性验证通过的现有 Pi 0.85.1 包，**不是下述缺隐藏文件的下载包**。

通过正常 Pi Skill 执行既有原生 Core 验收脚本，复用已注入的上游环境引用，无秘密文件读取/复制。Root 独立只读查验此隔离 SQLite、原生 Pi 会话元数据、Guard 日志和实际文件字节，确认：

- Core 自己创建的 Run 成功，观察到模型身份 `pi://model?provider=loom-live&id=deepseek-v4.1-flash`。
- Pi 原生会话有 `thinking_level_change: max`，不是仅在工兵命令里写 max。
- 实际 `read → write → edit → read`，Guard 两类就绪证据存在，自测失败数 0；只允许工作区内 `read/write/edit`。
- 真实文件 77 字节，Core 归档 SHA256 `a9da0b8c11552694be0fd0c8f06e72da3ce1218119227cadd542ac81b727df8f` 与实际文件一致。
- 没有使用本地模拟 Provider。这里证明上游真实调用和客户端观察到的模型身份，不额外声称已独立证明代理背后的模型权重身份。
- 本切片未创建 Candidate，未写 Owner Review，不能冒充完整双 Worker Goal/Claim/Review 自动链。

证据：`_artifacts/loom-live-resume-20261116/real-pi-file-artifact-summary.json`；完整私有报告 `real-pi-full-evidence.private.json`。测试用的原生运行脚本是既有 `live-core-write.mjs` 的有界修订，不是新通用工具。

### Codex 原生端真实响应

用全新 `CODEX_HOME`、只含环境引用的 provider 配置、原生 `codex.exe exec --json --ephemeral --sandbox read-only`，请求同一模型和 `max`。工兵执行一次 exit0，Root 独立核对最终随机标记精确一致、原生 `turn.completed`、零工具事件和空工作区。请求经 Octopus Responses 通道；此处是**原生 Codex 可连接性证明，不是 LOOM Core→Codex 的整链 E4**。native max 配置被接受，报告 usage 的 reasoning token 为 0，不能据此编造实际思考量。

证据：`_artifacts/loom-live-resume-20261116/codex-native-summary.json`。没有复制 `auth.json`，没有静默模型降级。

### E6 局部：真实成果的持久化与防篡改

Root 用上述已完成真实 Pi Run 的**同一隔离数据库**，无模型凭据、无新 Prompt，实际验证三项：正常重新启动后原 Run/Artifact 可读；主动改变测试工作区原文件后归档正文和哈希不变；仅强制终止本测试刚启动的 Core 后，从同库重新启动，仍恰好一条成功 Run、同一归档哈希、零 Review。测试工作区原文件已恢复，测试 Core 均确认退出。

证据：`_artifacts/loom-live-resume-20261116/real-artifact-recovery.json`，三个检查均 passed。仅证明已完成真实成果的恢复，不宣称运行途中副作用、物理断网、跨机旧 lease 或完整 E6 已通过。

### E5 前置：Bero 真机与 TLS 边界

在 Bero 的独立目录和受限容器用固定 `5ca6028` 编译 Linux Host/Server/Node，exit0，保存独立二进制 SHA256。Bero 实际经临时 HTTPS 通道访问 Windows 隔离 Host：首页 200、无认证 API 401。该临时 Host/通道随后关闭，日常服务未中止。

证据：`_artifacts/loom-live-resume-20261116/bero-tls-admission.json` 和 Bero 项目 `evidence/live-resume/`。配对票据跨机传输调用被平台阻断，故**尚无已配对 Node、跨机工具任务或跨机恢复成功证据**；网络连通不能记作 E5 完成。

## 已找到并处理的真实缺陷

1. **旧 E4 原因误判**：旧测试数据库中真实错误是 `workspace_unavailable`，Run 的 `started_at` 为空；Pi 没有开始，缺 Guard 日志不能证明 Guard 坏了。改用仓库之外的新隔离测试根后，真实 Core/Pi 文件链通过；没有关闭 Guard。
2. **交付包丢失隐藏文件**：GitHub Runner 上 Pi 包验证和 E3 通过，但 `upload-artifact` 默认排除隐藏文件。Root 比较下载后的闭包，6682 个期望文件中缺 55 个，全部为隐藏文件/目录里的依赖；包括 provider 的 `.manifest.json`。Core 校验正确拒绝该包，`pi --version` 成功不能替代完整闭包检查。
3. **favicon 的真实 404**：Vite 产物有图片，正式 Host 只路由 `/assets/*`，两个根路径图标未路由。已新增两个精确静态路径，仍复用原路径/类型/边界校验，未开放任意根静态文件。
4. **旧 Web 验收假设过时**：旧测试仍要求 Rovai 标题与第五运行端 Command Code 品牌图。已改成 LOOM 标题、用户批准图片的真实字节校验；ICO 类型仍以独立测试夹具验证，未删除 ICO 运输覆盖、用户头像测试或认证/撤权/事件测试。

## 提交与 CI 状态分层

- `06641c5`：精确 favicon 路由、真实 HTTP 回归、同源 Windows Node 构建/交付候选。
- `80e66ae`：只对明确组装、无凭据的预览包保留隐藏文件；新增**上传后实际下载**，逐个校验所有交付文件 SHA256、拒绝额外/越界条目，并复用完整 Pi 校验。
- `445ec2a`：更新已选品牌的 Web 验收，不再错误要求被产品范围排除的第五运行端图标。

本机工作流契约 9/9、PowerShell run 块 AST 12/12、JS 语法与 diff 检查已执行通过。对应远端 CI 的最终结果必须读取实际 run，不从静态 YAML 或上述数字推断成功。前两轮新 HTTP 门禁依次暴露旧标题/旧 Command Code 图标断言，失败日志保留，不能把失败测试报绿。

通用 CI 的两份旧 v1.72 文档仍缺精确确认元数据；不伪造 `confirmed_*`，不删除门禁。它与独立候选构建、真实模型测试的状态分开记录。

## 续建顺序和不得混报的门槛

当前已有真实 Pi Core 文件交付、原生 Codex 连接、真实成果局部恢复；DSH 正沿既有 ACP parity 脚本验证，最终以实际输出为准。下一步先确认新交付包上传/下载全闭包通过，再补 Core→Codex/DSH、双真实 Worker/Claim/待审 Candidate、四能力逐端实际加载与调用。Windows Claude 当前仍是发现而非执行；云端原生验证需合规授权通道。

E5 需要真实配对、受控跨机任务和结果；E6 需要运行中断线/旧 lease/未知副作用对账；E7 需要用户本人实际审批及正式发行条件。不得用本页局部通过把这些门槛全部标为完成。所有秘密、原始会话和测试数据只保留在本地私有证据范围，不随公开 PR 上传。
