---
document_type: model-context-change
version: v1.72
change_id: team-guidance
revision: 1
confirmation_status: confirmed
confirmed_revision: 1
confirmed_by: User
confirmed_at: 2026-10-18
authority: confirmed-model-input-change-statement
implementation_baseline: 9a5127ed8a26531808a61c62565c097cf498fd43
implementation_status: in_progress
last_updated: 2026-10-18
---

# Team 指引的 Bootstrap 注入 R1

## 二次确认

User 在 Thread `rvcamp_01m579sezwfgsrrvsmhq203n8e` sequence 27 要求简洁有效的上下文方案。
完整方案通过公开消息 `db8303ee-a546-411b-88af-7eb5b9cbc531` 展示：唯一新增可选 TEAM_GUIDANCE、
创建时固定来源、后续不追加、恢复只复用原文、无团队省略、1000 字符上限和负向验收。
User 随后在 sequence 29（`afce2cf1-0de6-4155-8d5e-3ca6d7ca21ce`）明确回复
“可以 开启wt开始执行”，确认实施该方案。本文件把已展示的 R1 收录为正式变更说明；
没有新增模型可见事实、提示教学或团队动态同步语义。

## 问题与范围

Issue [#504](https://github.com/murray17/rovai-ai/issues/504) 的团队创建预设增加可选工作指引。
Team 是创建输入模板；成员关系与队长在 Thread 创建后继续由现有领域管理。
指引只服务团队创建的公开 Thread，Single Chat 的专用上下文保持原样。

## 变更前

当前 Bootstrap 的完整区段结构如下，MEMORY_ENTRYPOINT 仅在非空时出现。

```text
[SESSION_CHARTER]
<现有章程原文>
[/SESSION_CHARTER]

[MEMBER_IDENTITY]
<现有本人身份 JSON>
[/MEMBER_IDENTITY]

[ROVAI_PLATFORM_SKILLS]
<现有平台 Skills 索引>
[/ROVAI_PLATFORM_SKILLS]

[MEMORY_ENTRYPOINT]
<现有非空记忆入口>
[/MEMORY_ENTRYPOINT]
```

新 Run 在 claim 冻结 Bootstrap 材料。运行准备及部分恢复会重新组装 Bootstrap；仅把实时 Team
读取塞进 formatter 会令旧 Thread 在后续准备时读到修改后的指引。

## 变更后

完整结构只在 MEMBER_IDENTITY 后增加下述可选区段，其余区段的内容、顺序及出现条件保持。

```text
[SESSION_CHARTER]
<现有章程原文>
[/SESSION_CHARTER]

[MEMBER_IDENTITY]
<现有本人身份 JSON>
[/MEMBER_IDENTITY]

[TEAM_GUIDANCE]
<创建 Thread 时固定的团队指引正文>
[/TEAM_GUIDANCE]

[ROVAI_PLATFORM_SKILLS]
<现有平台 Skills 索引>
[/ROVAI_PLATFORM_SKILLS]

[MEMORY_ENTRYPOINT]
<现有非空记忆入口>
[/MEMORY_ENTRYPOINT]
```

模型可见正文的具体示例：

```text
[TEAM_GUIDANCE]
- 接口变更先明确调用方和兼容影响。
- 审查发现需写明位置、影响和修改建议。
- 交付时说明改动、验证结果和未解决的问题。
[/TEAM_GUIDANCE]
```

正文只移除首尾空白，保留内部换行及原意；最多 1000 个 Unicode 字符，保存时拒绝超长，
不截断、不自动摘要。空白指引、Custom 创建、旧 Thread 和 Single Chat 省略整个段，
不输出空字符串、null 或占位解释。模型输入不增加 Team ID、名称、版本、时间戳、成员列表或指引使用教程。
当前 User 明确要求优先于 Team 默认约定；不赋予工具权限、不改本人身份，不形成第二份 Memory。

## 明确不变

- SESSION_CHARTER、MEMBER_IDENTITY、平台 Skills 和 Memory 入口各自仍由原 owner 管理。
- COLLABORATION_STATE 仍拥有当前 peer/Lead；不增加 Team 字段，不复制名单或职责。
- RUN_FACTS、RUN_INPUT、WORKSPACE、Additional Skills、Tasks、历史选择与动态 section 顺序保持。
- 常规后续轮次和 Steer 不追加 Team 指引；不新增同步消息、工具读取要求或队员唤醒。
- Runtime 的系统层重装载、Bootstrap redelivery、binding continuity 和 accepted/unknown 防重继续沿用。
  这些路径需要 Team 内容时复用固定原文，不因 Team 编辑产生投递或 Session rotation。

## 来源与事务

Core 在创建 Thread 的同一事务中解析所选 Team、复验成员和 Lead，并保存不可变启动材料。
所有队员首次启动、晚启动、后来加入及重建 Native Session 都读取该材料。它不是会话级可编辑指引：
不增加编辑接口、模型可见 Team 关联或跟随更新行为。Team 改名、编辑和删除不改变旧材料。
新 Run claim 冻结同一来源，之后的 preparation 和重试只消费已冻结值。

## 版本与证据

基线 Bootstrap contract/formatter 为 v5/5，新增段升级为 v6/6；Charter revision 24 和 Binding
compatibility revision 16 保持，版本变化本身不轮换 Session。Dynamic formatter 的公开 40、non-batch 42
及 Profile 15/16 不因本改动单独更改，因为动态 section 和预算算法没有变化。

新段纳入既有 Bootstrap 的实际 UTF-8 字节预算、稳定证据与最终输入保存；不把生成成功当作 Runtime
已接收。同次 Run/Binding/generation 的重试恢复完整原字节；旧已冻结 claim、Bootstrap、Manifest 和 Blob
保持其既有版本路径，不以新 renderer 重新生成旧输入。需要扩充持久化准入时只增加兼容版本约束。

## 迁移与恢复

迁移保留旧 Thread、原生 Session、冻结输入、成员和已保存 Custom/one-click 偏好。旧偏好不会生成
Team；旧 Thread 没有启动材料时省略 TEAM_GUIDANCE。Team 删除后默认选择回到 Custom 并关闭
one-click，已有 Thread 的材料继续保留。不得从删除后的 Team 或最新 Team 猜测旧输入。

## 验证与预算

扩展现有唯一 owner：Team CRUD/创建事务拥有成员复验与快照原子性；Context claim/formatter 拥有
省略、排序、Unicode 上限、真实预算和冻结回放。SQLite 的新事务覆盖进入 extended-tests，不为文案再建
重复 golden。目标命令和结果记入 [实施记录](team-management-implementation.md)。

关键负向案例：空白、Custom、历史 Thread 和 Single Chat 无新增段；多队员分时启动仍相同；
编辑/删除 Team 后旧 Thread 续聊、压缩补发及加入队员仍用原文；新 Thread 使用新文案；
重复 Run 不向动态输入追加；超长显式失败；预算不足不部分投递；accepted/unknown 不重放业务输入。

真实任务按 [上下文 Gate](../../development/evaluation.md#上下文改动-gate)冻结既有 12 个通用 Case、
新旧构建、Runtime/模型和预算后运行，保留全部尝试，最多两次 campaign。另以明确团队约定与本轮 User
覆盖要求验证行为；不把静态字节检查当作模型遵循证明。缺少运行证据时记录未验项，不声明 Gate 通过。

## 冻结的回归执行配置

2026-10-18，在查看候选真实执行结果前冻结：既有 12 个通用 Case，每侧一次，三个 Codex CLI 队员，
模型 `gpt-6.1-sol` / reasoning medium，显式 danger-full-access / never；并发 Case 2，总预算 14400 秒，
同一 campaign 最多两次，沿用仓库 POLICY，不改 rubric 或筛除失败。权限复用本机既有 Qualification
可运行配置，自动验收使用各 Case 独立 data / Skill Library / MCP / workspace，非操作系统沙箱隔离。

当前没有可证明固定模型快照的 Judge 配置，使用 `judge: null`。因此即使执行和规则通过，也仅记录
真实执行证据，不能声明语义 Gate 通过。静态字节和真实任务报告分别保存；最终结论见实施记录。
基线 checkout 为独立 `rovai-ai-team-baseline` / `9a5127ed8a26531808a61c62565c097cf498fd43`。

## 2026-10-22 主线整合

保留主线已确认的 Charter revision 25（含 native background policy），本次仍只叠加 R1 的可选
TEAM_GUIDANCE。Bootstrap/formatter 为 v6/6、Binding compatibility 16；不重写旧输入或新增动态段。
团队迁移顺延为 213 / schema 163，接在主线 212 / schema 162 后。此记录不改变 R1 的确认范围。
