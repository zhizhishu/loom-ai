---
document_type: model-context-change
version: v1.72
change_id: team-guidance-limit
revision: 1
confirmation_status: confirmed
confirmed_revision: 1
confirmed_by: User
confirmed_at: 2026-10-25
authority: confirmed-model-input-change-statement
implementation_baseline: 51da43668fa9b9e50cd94c86a29825db8666f79a
implementation_status: implemented
last_updated: 2026-10-25
---

# Team 指引长度上限 R1

## 二次确认

Thread `rvcamp_01m579sezwfgsrrvsmhq203n8e` sequence 75 询问从 1000 改为 10000 的影响。
公开答复 `edebfc84-f840-4837-baf3-d7b1eedd82f6` 已说明前后端校验、两处 SQLite 约束迁移、
每位成员读取完整指引带来的输入成本、旧 Thread 冻结原文不变，以及 Unicode 边界和预算验证。
User 随后在 sequence 77（`598319ce-7bfe-4937-8741-5ad369f82d2a`）明确要求“改完pr到main merge”。
本文件收录该已说明并获准实施的范围；不追溯声称 User 阅读过本文件，也不扩大原来的批准内容。

## 变更前

Team 保存时，去除首尾空白后的指引最多 1000 个 Unicode scalar；UI/Core 和 SQLite 拒绝超限。

## 变更后

同一位置的上限统一为 10000；仍拒绝超限，不截断、不摘要，保留内部换行。
Bootstrap 的全部区段及出现条件在前后均为：

```text
[SESSION_CHARTER]
<现有章程>
[/SESSION_CHARTER]

[MEMBER_IDENTITY]
<现有身份 JSON>
[/MEMBER_IDENTITY]

[TEAM_GUIDANCE]
<Thread 创建时固定的非空原文；仅允许的最大长度由 1000 变为 10000>
[/TEAM_GUIDANCE]

[ROVAI_PLATFORM_SKILLS]
<现有 Skills 索引>
[/ROVAI_PLATFORM_SKILLS]

[MEMORY_ENTRYPOINT]
<现有非空记忆入口>
[/MEMORY_ENTRYPOINT]
```

TEAM_GUIDANCE 仅在固定原文非空时出现，MEMORY_ENTRYPOINT 仍仅在非空时出现。
对于同一份原先合法的输入，格式化结果逐字节相同；新允许的长指引由同一 formatter 完整输出。
不增加任何模型可见字段、提示文案、工具、动态上下文段或唤醒行为。

## 明确不变

- Team 在创建 Thread 时固定原文；后来加入成员仍读取此副本。编辑或删除 Team 不更新已有 Thread。
- Custom、无指引、历史 Thread 和 Single Chat 的省略规则不变。
- Bootstrap contract/formatter v6/6、Charter 25、Binding compatibility 16、动态 40/42、Profile 15/16 不变。
- 实际 UTF-8 字节仍计入现有输入预算。预算数值、选择策略、超预算失败和 Runtime 补发条件不变。
- 10000 scalar 最多 40000 个 UTF-8 字节；实际成本取决于正文和 Runtime，容量提高不等于自动多注入内容。
- Migration 214 / projection schema 164 只扩宽两张表的 CHECK；沿用 v1.72 data contract，事务失败全部回滚。
  Team、创建偏好、冻结 Thread 文本、原生绑定、既有 Evidence/Manifest/Blob 和命令回执原样保留。
  旧二进制不能读取新 schema，沿用现有 future-schema 拒绝规则；不新增降级迁移。

## 验证与通过标准

扩展既有 Team/Core、数据库准入、Bootstrap 物化及生产 React 夹具 owner，不新增模型机制：

- 10000 个 Unicode scalar（含中文、emoji）可完整保存和创建；10001 拒绝且草稿不截断。
- 旧 schema 163 可升级，失败回滚，重开仍保留 Team、偏好及已冻结文本；immutable trigger 和外键保持。
- 长指引在 Bootstrap 中完整出现一次，动态内容不重复，恢复原字节；现有实际字节预算仍生效。
- 类型、默认 Rust、前端及文档门禁通过；运行命令与结果记录在 [Team 实施记录](team-management-implementation.md)。

本轮为长度准入扩展，不变更上下文格式、选择或预算算法；不以边界测试宣称长指引具有更好的模型遵循效果。
此前完整上下文 Gate 的 `degraded` 状态保留，未重跑的真实模型对照不记为通过。
