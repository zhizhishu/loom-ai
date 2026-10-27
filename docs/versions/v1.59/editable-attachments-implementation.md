---
document_type: implementation-plan
authority: agent-attachment-source-path-delivery
status: in_progress
last_updated: 2026-09-16
---

# Agent 附件原路径引用实施计划

当前唯一范围是用户 2026-09-16《附件升级方案的最终调整》，字段合同见
[已确认 revision 2](model-context-change-editable-attachments.md)。revision 1 未实施并已撤销，
不再沿用复制、tmp → rename、分配命令、外部请求编号、双根模型上下文或跨 Camp 独立副本。

## 实施顺序

| 次序 | 工作 | 收敛入口 |
| --- | --- | --- |
| 1 | 路径与记录 | 统一解析/准备默认输出目录；复用 Source Ref 数据与读取能力保存 Agent 原路径和 Camp 消息关联 |
| 2 | 发布 | CLI 去掉 `.send-import`；Core 新 send 直接检查指定源、事务登记和发布；返回附件 ID/实际路径，保留内部幂等 |
| 3 | 读取 | 统一具体记录解析，Agent 历史外部源也返回位置；新文件使用当前内容，旧兼容只在实际旧记录访问内部 |
| 4 | Runtime | 顶层 attachmentOutputRoot；配置输出位置的实际访问；撤掉普通 Run 的旧附件系统前置依赖 |
| 5 | Desktop/Web | 真实位置与适用操作，图片/目录/HTML 当前内容及既有缓存更新；不以目录枚举代替附件列表 |
| 6 | 删除 | 协调 Run/发布/预览占用，精确删除 Camp 自有输出和旧文件；外部只删引用，重试失败清理并挡住迟到结果 |
| 7 | 验证与文档 | 测试 owner、隔离实例、上下文 Gate、当前合同/架构/UI/术语同步 |
| 8 | 交付 | 提交推送任务分支，PR main，Review/CI 后合并，验证 origin/main 后同步并清理 worktree |

## 固定行为

默认输出使用现有 instanceKey 和平台根，下接 attachments/<campId>；Agent 自选普通文件名和子目录，
发送时才建立身份。新发布永远不复制、链接、移动、冻结、chmod 或扫描旧附件。
工作区/外部/临时位置均保存实际引用；临时源按原生命周期清理后可失效。
跨 Camp 可引用同一物理文件，接受源 Camp 删除后的引用失效，无全局引用计数、所有权迁移或保活。

删除确认复用现有一层对话框：

> 会一并删除此对话保存的附件，包含已编辑内容。原始工作区文件和外部引用文件不受影响。

删除清理只处理实际自有目录，不逐条删除 sourcePath；目录内未发布文件也随 Camp 删除。
Run 结束、Runtime 回收、关闭预览、LRU 和删除一条消息不删除永久输出文件。

## 交接

- Task：`154b5057-1d0a-4ef9-bdd1-640d31242b25`，爱丽丝。
- Worktree：`/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-editable-camp-attachments`。
- Branch：`rovai/editable-camp-attachments`。
- Base：`243eb748bbb1609039942cccf31dcc8ece0c4c4f`。
- Governance：用户消息 `ccf1040b-6213-4ef4-af9e-dd659d2e8794` 对已审阅 revision 1 给出最终修订，记录为 revision 2。
- Status：in_progress。保留已有 PR/main 合并授权，不包含安装/重启日常 App，不自动关闭关联 Issue。
- 当前实现已完成本地开发验证；正式上下文 Gate 未执行。用户在得知该证据缺口后明确要求继续 PR/main 合并，按下文记录执行本次交付。

## 实现与验证记录（2026-09-16）

生产主路径使用既有 `source_attachments_json`，没有新建 Managed 系统。CLI `.send-import` 已退役；
新 send 在源观察后重新核对运行身份，再由原命令事务登记引用。操作回放不依赖源继续存在。
ContextManifest/Formatter 24、Run Facts 3、Built-in Contract 25、Agent Output 3 已接通；
v156/schema 106 仅调整上下文约束，原冻结 v22/v23 输入按精确旧字节续接。

既有旧记录解析、受管内容验证和恢复入口保留；新发布与普通 Run 无旧 View 健康前置。
Camp 删除复用持久清理操作，Desktop 主动删除前释放预览句柄，Web 撤销对应文件能力；
清理失败保持未完成并进入原恢复机制。仅清理计算出的自有目录，不枚举 Source Ref 删除外部文件。

| 验证范围 | 实际结果 |
| --- | --- |
| Core library 完整 default suite | 809 通过，6 个显式 ignored 未运行 |
| slow integration suite | 首轮 309 通过、1 个旧冻结上下文夹具失败；修正夹具为真实 v22/v23/v24 后，该 owner 单独重跑通过 |
| 最后附件定向 suite（含 v156 原子迁移） | 74 通过 |
| 原生派发不依赖损坏旧 View / 自有目录删除 owner | 各单独重跑通过；删除包含未发布文件、替换根及外部/其他 Camp 保留 |
| CLI / Web Rust / send 教学合同 | 28 / 7 / 3 通过 |
| Vitest 完整套件 | 204 文件、2100 测试通过；后续预览 64 项、渠道 68 项定向重跑通过 |
| TypeScript / Rust 编译 | pnpm typecheck、cargo check --workspace --all-targets 通过 |
| 构建 | Desktop、Web、Host/Core/CLI 本机构建通过 |
| 文档 | docs:test 10 项及 docs:check:ci（固定 base）通过 |
| 隔离 Host/Chrome 与清理脚本 | 最后 8/8 通过，覆盖实际相对 CSS、替换保存、交互沙箱、刷新和句柄释放 |

以上是本地软件验证，不替代真实 Runtime/Judge 的上下文 Gate。macOS 已执行隔离 Host/Chrome 验收；
Windows/Linux 尚无本轮原机验收证据，不把跨平台代码路径表述为各平台已运行通过。

证据保存在独立目录 `/Users/murray.xue/VSCodeProjects/opensource/rovai-evaluation-evidence/attachment-paths-20260916`；
记录每次实际结果，不覆盖早先失败。基线 checkout 为相邻 `rovai-ai-attachments-baseline`，
固定基线 `243eb748bbb1609039942cccf31dcc8ece0c4c4f` 已完成产品构建。

## 本次交付指令与验证缺口

2026-09-16，向用户报告实现提交 `0a40a418`、本地验证结果及正式 Judge 配置缺失后，
用户再次明确指令：“pr到main merge”。据此继续本次 PR、CI 与合并，不再等待 Judge 配置；
这项用户指令只调整本次交付前置，不修改通用[评测流程](../../development/evaluation.md#上下文改动-gate)。

正式 DEMO-101–112 对照 Gate **未执行**，没有通过结论；现有订阅 CLI Judge 不能替代固定模型版本的正式证据。
已保存的基线/候选构建和本地测试结果保留，PR 明确披露此缺口。Windows/Linux 原机验收同样保持未验证状态。
合入最新 main 的 Runtime effort 标签修复后检查 CI；通过后按用户指令合并，验证远端 main 并清理本任务两个 worktree。
不安装或重启日常 App，不自动关闭关联 Issue。
