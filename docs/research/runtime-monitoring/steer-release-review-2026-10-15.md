---
document_type: research-report
authority: observed-steer-release-review
status: active
last_updated: 2026-10-15
---

# Steer 合入前自检

范围：User seq47 的 main 合入与本机安装，及 seq49 的存储精简复核。比较基线为 main
`1681b99eadf5c72f4f37baf9caeac6b566251b06`；在 Mission 064 原分支上完成合并与修复。
本文记录审查及实际验证，不扩大历史真实 LLM 测试的版本或场景范围。

## Standards

独立规范审查发现四项，均已修复：

- Desktop Main 未开放 `runtimeInputs.reconcile`，导致 Renderer 的核对结果入口被桥接白名单拒绝。
  加入精确方法，沿用 Main 的闭集授权。
- 主线紧凑格式与分支 Steer 同占 203／153；仅列存在不足以识别合法来源。
  204／154 按完整结构补齐缺项，保留两种历史 203 回执；残缺视图、格式与字段拒绝写入。
- Steer 结构识别缺少完整唯一性核验。补齐初始／来源 Manifest、输入顺序与原生初始身份索引检查，
  不接受仍保留单输入唯一约束或错误部分索引的混合结构。
- 新迁移矩阵使用完整 SQLite 夹具却进入默认层；移至 `extended-tests`，沿用原 owner，未删除合同。

没有为代码气味进行无必要的抽象改造。14 种残缺结构负向输入由同一来源识别 owner 覆盖。

## Spec

独立需求审查发现两项，均已修复：

- continuation 指向非队长时，以及编辑器 flush 前立即发送时，路线可能使用旧正文或旧目标。
  预览物化 continuation；发送按最终正文和点击时的 Run 快照逐目标计算，不转投后继 Run。
- Pi 图片 Steer 未带普通输入已经支持的图片字段。Start／Steer 现在共用授权字节读取、MIME／预算、
  模型能力检查与元数据证据，准备失败发生在原生输入写入前。

收尾补查另发现等待态准入不一致：Core 允许等待中的活跃 Run 接收补充输入，但准备步骤只接受 running。
准备步骤现仅对 Steer 同时接受 waiting，普通初始输入保持原限制；扩展同一多输入 owner，
先复现失败，再验证两条插话的接收不解除 waiting／approval。

规范轴 4 项、需求轴共 3 项（独立审查 2 项、收尾补查 1 项）；各轴最高等级问题均已修复。
CodeBuddy 连续输入业务结果异常仍由 #762 追踪；接收不等于消费或遵从，历史失败不被成功试验覆盖。

## 存储复核

- 消息正文仍由 CampMessage 拥有；每次实际输入使用共同 Builder 生成一份最终 Managed Blob。
  新 Steer Manifest 不恢复 Profile、Run Facts、Self Active Tasks、A2A 等退役正文和中间摘要。
- 来源、Run／epoch、顺序、原生关联和投递状态用于精确归属及防止重投，复用现有表。
  回执只保留关联和必要事实；原生输入回显不成为另一份执行正文。
- `canSteer` 与原因由 Core 按目标 Run 读取计算，不持久化资格快照；移除一个结果未使用的重复查询。
- 新操作继续采用主线格式 4：独立输入／结果、活动小字段、有限预览、输出裁剪、摘要标量更新。
  执行记录 writer、输出裁剪和文本归约与该 main 基线一致。
- Pi 图片准备只保存既有图片摘要／MIME／大小等关联信息，Base64 不新增到数据库或事件。
- 历史消息、Manifest、payload、摘要、接受与 unknown 证据原样保留；本次没有清理或重算旧正文。

扩展既有 `active_inputs_preserve_initial_context_and_unsubmitted_sources` 检查精简列、最终 Blob
及持久事件无输入正文。紧凑操作继续由既有 `evidence_is_durable_blob_backed_agent_inaccessible_and_cancel_fenced`
及其 compact probe 拥有，打包升级继续使用 `smoke-storage-app-upgrade.mjs`，没有另建测试框架。
独立存储专项复核未发现新增重复存储或发布阻断；此结论来自写入路径及与主线的差异检查。

## 验证

前端类型检查、2,686 项 Vitest、355 项 Node 测试（另有 2 项平台跳过）、文档门禁已通过。
Main 白名单 3 项、Steer 生产 UI 及 continuation／立即发送的日夜模式验收已通过。
默认 Rust 回归 473 项通过、1 项带既有原因忽略。扩展层另覆盖更新后的存储断言、迁移矩阵及 Adapter 进程。
`2227a9a4` 上的完整扩展 workspace 已通过：1,062 项通过、8 项带既有原因忽略。
等待态修正另外执行上述 owner 的红／绿验证，不把修正前整套结果写成修正后的完整重跑。
打包存储验收首轮在打开历史对话时超时，保留该失败记录。脚本此前只等待 Core 健康和侧栏按钮出现，
直接点击可能早于启动恢复完成；现先等待导航启用且启动遮罩退出，再操作现有按钮。
使用全新隔离夹具重跑通过：schema 149 升至 154，512 条历史操作正文及 Blob 身份不变，
40 次输出增量只保留一条命令记录，输出限于 7,680 字节，裁剪尾部未在 614 个文件中发现副本；
新操作的活动副本与历史目录副本均为零，重启后旧新证据可读且原生输入仍只投递一次。
PR CI 与隔离打包／安装的最终结果以本次 PR 检查及 Thread 交付记录为准。
