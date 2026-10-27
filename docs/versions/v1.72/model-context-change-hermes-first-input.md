---
document_type: model-context-change
version: v1.72
change_id: hermes-first-input
revision: 2
confirmation_status: confirmed
confirmed_revision: 2
confirmed_by: User
confirmed_at: 2026-10-25
authority: confirmed-model-input-change-statement
implementation_status: implemented
review_baseline: 370727b06bf8f125ad5c17cbf5d118f51106bc5b
last_updated: 2026-10-25
---

# Hermes 首次用户输入携带协作规则：R2

User 在 sequence 56 明确选择原生会话定位、取消压缩补发，sequence 58 确认模型无新增参数，
sequence 60（message `8a9945cd-9da2-4865-b12b-cd0814de63f0`）授权验证实现。
此前 R1（sequence 27/31）的首次/更新 user 层选择继续保留，完成 Hook 补发决定由 R2 取代。
适用 [模型上下文变更治理](../../development/model-context-change-governance.md)。

## 变更前

R1 在首次、真实规则更新及官方 post_compaction 完成后下一条普通输入携带完整 B。
通过私有 Home Hook、observer/Requirement 和接受账本管理 compaction_recovery。
完整 B、P 由 Core 准备，规则处于 user 层。

## 变更后

B 是既有 Core Bootstrap 全文，P 是既有任务 Dynamic Context；二者内容、来源、段落顺序、附件不改。
首次实际任务使用以下正文，同一次 session/prompt 提交：

```text
[Rovai 协作规则]
<B 原文>
[/Rovai 协作规则]

<P 原文>
```

已经接受相同 B 的后继、原 Session 冷恢复以及压缩后输入，只提交 P。
B 内容真实变化后的下一普通输入为：

```text
[Rovai 协作规则更新]
以下规则替换此前的 Rovai 协作规则，继续当前会话与任务。

<B 原文>
[/Rovai 协作规则更新]

<P 原文>
```

删除“规则恢复”正文生成、Hermes Hook/observer 与新 compaction_recovery 投递。
既有 pending 不消费、不冒充完成；冻结旧输入和历史证据保持原义。
完整 B 摘要与接受账本继续决定 initial/update/none；准备/dispatch/unknown 不视为接受，
未知业务输入不自动重放。连接重启不导致重发规则，规则变化不强制新建 Session。

## 明确不变

这是 user 层规则，没有 system/developer 保证，不承诺原生压缩永久保留全部规则。
使用用户原生 Home 后，personality、system prompt、Skills、记忆和原生 Hook 均遵循原生配置，
Rovai 不再复制/改写配置、禁用这些能力或增加隐藏提醒。不会向模型添加逐 Run CLI 路径或原生执行标记。
CLI 通过原生逻辑 Session 自动定位 Core 活动 Run，这一 IPC 变化不改变 B/P 正文。

其他 Runtime 的 Bootstrap 和补发机制不变。不新增数据库表/字段；历史 Hermes 枚举、Blob、
Migration 保留可读，不开发未上线私有 Home 的导入、回退或双版本兼容。

## 验证与当前权威

验证首次 B+P、后继/冷恢复 P、真实变更更新块、自动压缩后仍 P、未知不重放及原生配置生效。
实际执行结果记录在[实施记录](hermes-first-input-implementation.md)，不能把旧 system 或 R1 验收当成 R2 通过。
当前合同为 [Hermes Runtime](../../contracts/hermes-managed-runtime-v1.md)，
原 R1 的历史证据保留在该实施记录及 Git 历史中。

## 二次确认

revision 2 已由 User 在 sequence 60 授权；完整方案在 sequence 56，定位语义在 sequence 58 已确认。
确认不要求恢复已取消的逐执行证明、私有 Home 兼容或压缩补发。
