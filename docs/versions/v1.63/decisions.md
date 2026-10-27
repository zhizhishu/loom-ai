---
document_type: version-decisions
version: v1.63
lifecycle: historical
authority: decision-rationale
last_updated: 2026-09-22
---

# v1.63 版本决定

<a id="v1-63-d01"></a>
## V1.63-D01：Task 以单一 description 承载范围与要求，历史结构只读合成

- 状态：accepted
- 日期：2026-09-21
- 当前权威：Durable Task v4

结构化验收条件和自由正文表达同一责任定义，却要求 Tool、Host、Renderer、测量与 Agent 教学长期维护两套
输入、显示和编辑语义。选择让当前 `description` 统一承载 scope and requirements，并把上限扩到 16000；
旧数组只作为历史存储存在。读取从原始两列确定性合成，不回写、不增加版本，因而历史内容不会消失，也不会
因查看而制造 mutation。

编辑以当前合成正文为比较基准：相同值保留原始两列，真正改变时才把完整新正文写入并原子清空旧数组。这样
既避免打开并保存造成无意义转换，也保证后续读取不会重复拼接。状态、负责人和标题的独立更新不承担数据清理。
拒绝启动时批量改写，因为它扩大迁移写面并丢失“用户是否真正编辑”的边界；拒绝继续公开 deprecated 字段，
因为那会让所有当前 caller 永久维护双模型。

<a id="v1-63-d02"></a>
## V1.63-D02：Task surface 以一次版本化 clean break 发布，不保留旧 reconciliation decoder

- 状态：accepted
- 日期：2026-09-21
- 当前权威：Built-in Tool Transport v31 与 Host Web v3

删除 create/update 字段、缩小 get Agent stdout、增加 Task family help 和修改 Session Charter 都会改变实际
协议或模型可见字节，不能在 v30、Agent Output 3 和 Charter 11 的同一身份下原地替换。选择原子轮换
Built-in/CLI/capability 31、Agent Output 4 与 Charter 12；数据库使用 Migration 167/schema 117，Durable
Task 使用 v4，Host Web 使用 v3，Host/Web HTTP 登录与 Session `protocolVersion` 同步轮换到 3。IPC、
Envelope、receipt、Formatter、Manifest 和 Profile 没有变化，不随版本号机械递增。

Host 的旧 Task command 可能在断线后需要用原 payload 核对 receipt，但其发生概率低，且为它保留专用
legacy decoder 会延长已经移除的当前字段和 digest 语义。明确选择直接拒绝此类 reconciliation payload：
拒绝不证明旧命令未提交，也绝不触发重新 dispatch。当前客户端只能读取 Task 当前状态后由用户决定恢复。
拒绝静默忽略旧字段，因为这会用不同 payload 冒充同一命令；也拒绝自动转换并重发，因为它可能重复副作用。
