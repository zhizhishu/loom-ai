---
document_type: contract
name: Runtime Launch and Verification
version: v58
status: accepted
source_version: v1.72
last_updated: 2026-10-11
---

# Runtime Launch and Verification v58

继承 [v57](runtime-launch-and-verification-v57.md)，以下规则取代其中按 Run 更新环境、环境兼容摘要、
地址与凭据确认和宽范围 Warm 共享。程序安装、协议兼容、并发、Run 身份和消息归属保护不变。

## 会话固定环境

环境编辑仍属于 Host + 队员实例 + Runtime，采用 Host 环境叠加队员 JSON，同名覆盖、不同名继承；
删除队员条目恢复继承，空字符串为显式覆盖。保留 JSON 形状、名称/大小、重复名、NUL、保留字段和
现有模型选择规则；值不进行 Shell 展开，不改变已选定的 CLI 可执行文件。

第一次为 Camp 中的队员会话准入运行时保存完整合并环境及队员覆盖的私有快照。
会话由现有 Conversation 拥有；同一 Camp 的不同队员、不同 Camp 和独立 Single Chat 不能互相借用。
后续 Run、重试、辅助启动、Warm 回收及 App 重启后的冷恢复都读取原快照。保存最新配置不更新会话，
不停止进程，不在下一条消息自动切换。恢复失败明确报错，不重新合并当前 Host 环境。

快照沿用 Host 私有加密存储，使用随机引用标识，没有环境内容摘要或凭据指纹；原有 Run 配置身份、
命令幂等和 CAS 保持。私有更新回执只携带 expectedRevision；历史版本的私有值直接比较保护重放冲突，
不将值或其普通哈希放进领域命令。早期加密计划的 identity 列只兼容其解密上下文，新快照使用随机引用。
Migration 192 在 schema 141 上增加 Conversation 快照关联，发布 schema 142，不删除历史 Run 快照。
已有原生会话只在原 Run 快照可恢复时续用；没有可恢复快照时要求显式重置，不猜测旧环境。

## 配置透传边界

Rovai 不自动判断凭据属于哪个 Provider，不清理继承凭据，不记录地址/凭据组合确认，不在启动时重验确认。
只覆盖地址而继承 Host 密钥属于用户管理的配置语义；延后生效不消除该风险，也不得记为原 P1 已修复。
保留 Owner 配置权限、私有存储和默认遮蔽；普通消息和 Agent 工具不能修改环境。

`members.runtime.set` 的私有 environment 输入为 `{ expectedRevision, json }`。`confirmTargetChange` 退出。
保留 Claude 原生 settings 优先级适配和已验收 CLI 版本门槛；认证字段与 Provider 开关由 CLI 按透传值处理，
Rovai 不执行认证变量自动配对或互斥组合检查。原生权限、安全规则、认证头和模型家族映射不改写。

## 重置和进程归属

Owner 通过既有 `conversations.restartNativeSession` 显式重置，沿用 Conversation expectedVersion、
命令幂等及活动任务拒绝规则。重置在同一事务清除原生绑定及该 Conversation 的环境快照关联；
下一次准入读取最新配置。历史 Run 保留原快照。环境已建立但原生绑定尚未建立时也能重置。
`conversations.memberSession.get` 以 campId + agentId 读取该 Camp 队员的 conversationId、version、active，
仅供 Owner 界面，返回值不含环境。没有会话时返回 null；不暴露给 Agent 工具。

Fleet 的复用范围统一为 Camp + 队员 + 当前会话引用 + Runtime；再沿用原进程配置兼容、健康和租约条件。
Pi 不再按工作区跨队员/Camp 共享，ZCode 不再按 Camp 跨队员共享。实际工作目录仍参与既有兼容判断。
显式重置后新的会话引用不能复用旧环境进程。保留 Pi session 切换/恢复、ZCode 后台与迟到消息保护，
Kiro/Cursor 的 Stop 策略、Claude print 进程、Antigravity 独立执行及所有原有容量、回收、关闭行为。

## 界面

保留紧凑双语 JSON 编辑器、自适应短框、无点击高亮、密钥显隐、保存/放弃和离页保护，不提供检查连接。
固定显示：

> 环境配置将在新建或重置该队员会话后生效，已有会话保持不变。
>
> 未配置的变量会继承宿主环境。修改服务地址时，请核对同时使用的凭据。

Camp 队员操作提供“重置队员会话”，明确不再续接原生历史、Camp 消息仍保留，活动工作期间不可重置。
Desktop 与 Web 共用组件，移动端保留可达入口。旧 Agents 环境只读迁移与“标记已处理”行为不变。
