---
document_type: contract
name: Runtime Launch and Verification
version: v68
status: accepted
source_version: v1.72
last_updated: 2026-10-21
---

# Runtime Launch and Verification v68

继承 [v67](runtime-launch-and-verification-v67.md)。本版增加按 Host＋Runtime 保存的通用环境配置，
替代 v57/v59 中“只有队员配置、全局环境入口退役”的限制；旧配置归档仍不生效。

## 层次与进程生命周期

真正新建 CLI 时按 Host 环境、当前 Runtime 通用变量、队员变量依次合并；同名由后者覆盖，其余保留。
队员可关闭通用继承，此时仍继承 Host 原生环境。删除队员条目恢复下层值，空字符串是显式覆盖。
通用配置不跨 Runtime 共享，不扫描交互式 Shell alias，不改写原生配置文件。

新队员默认继承。升级前已有非空队员配置默认独立；空配置默认继承。以后保存的继承选择独立于变量
是否为空，不因清空或新增通用变量而改变。变量仍使用原有名字、字符串、Windows 大小写和保留名校验；
合并后的配置覆盖层也须满足 128 项和 128 KiB 限制。Claude 的显式模型不能与合并后的 ANTHROPIC_MODEL 并存。

沿用 v59：健康 Warm 不重新读取配置，保存不终止现有 CLI，不改变 Native Session 归属、Host compatibility
或已接收输入。新 CLI 才读取当前配置，原生会话仍按既有恢复规则续接；环境明文不进入 Run 或 Conversation。

## Owner 管理接口

- `runtime.environment.get { runtimeKind, reveal? }` 返回 `{ revision, environment }`，默认隐藏凭据。
- `runtime.startup.get/save` 额外返回相同的遮蔽 `commonEnvironment` 快照。
- `runtime.startup.save` 的字段编辑格式可附带 `commonEnvironment: { expectedRevision, json }`。
  路径与通用变量在同一事务保存；revision 冲突、解析失败或数据库失败均不部分提交。
  原 `configuration.environment` 与逐字段环境编辑保持拒绝，不复活旧版全局明文存储。
- `runtime.startup.inspect/check` 接受相同的私有 `commonEnvironment` 草稿；省略时使用已保存通用配置。
  草稿检查不保存、不发布全局健康或目录结果。
- `member.runtimeEnvironment.get` 增加 `inheritCommon` 和遮蔽的 `common` 快照。
  `members.runtime.set.command.environment` 可带 `inheritCommon`，省略时保留原选择。
  环境与继承选择随运行配置原子保存，领域回执只保存 revision 和可选布尔选择，不能包含值。

`<saved>` 仅引用同一配置来源、同一 revision 已有凭据；不能从通用配置借用标记写入队员，也不能创建密钥。
显式查看需通过既有 Owner Desktop/Web 管理权限。公开成员资料、模板、应用到其他队员、事件和诊断不复制变量。
通用值复用 AES-256-GCM 与 Host 私有 key；没有明文或凭据摘要进入配置 JSON、日志及公开回执。

## 检测与模型目录

正式检测和模型目录使用 Host＋当前 Runtime 通用环境，不叠加任一队员变量。保存通用配置推进检查环境代次，
使该 Runtime 的健康与模型缓存失效；迟到的旧检查不能覆盖新配置。只改通用变量不推进安装代次，不主动替换 Warm。
同值保存不推进通用 revision。启动设置的原路径检测、检查队列容量和程序身份校验保持。
通用密文或私有 key 不可读时，Host 仍可启动；对应 Runtime 的共享检查和目录读取失败，不回落到另一套凭据。
不继承通用配置的队员不读取通用记录；它自己的密文和所需 key 仍须可读。健康 Warm 仍使用已捕获的配置。

## 升级与界面

Migration 211 从 v1.72/schema 160 升到 161，新增通用加密版本表及队员继承选择表。通用表初始为空，
不读取旧 key，不解密或启用归档，不修改旧队员 ciphertext、原生会话、消息或运行历史。缺少继承记录时按
该旧 revision 的变量是否为空解释默认值；新保存记录明确的选择。

界面使用 [队员环境变量](../ui/components/member-identity.md#队员环境变量)及设置工作区 brief。
原地只读合并预览不参与保存；进入对应智能体设置保留队员草稿，顶部提供具名返回入口。
