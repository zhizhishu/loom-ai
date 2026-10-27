---
document_type: protocol-contract
contract: camp-open-projection-v29
authority: camp-open-read-model
status: accepted
version: 29
source_version: v1.72
last_updated: 2026-10-15
---

# Camp Open Projection v29

继承 [v28](camp-open-projection-v28.md) 的所有读取与模型展示规则，以及
[v26](camp-open-projection-v26.md) 的完整用户目录、直接回复选择和惰性预览边界。
本版仅为 `thread.messages.anchorPreview` 的 `firstReply` 增加回复作者展示信息，schemaVersion 仍为 1。

## 回复作者

非空 `firstReply` 增加 `author`，其值为 `{ agentId, displayName, avatarRef }` 或 null。

- `agentId` 必须来自选中回复的 `author_id`，不能取 Default Lead、被提及队员、Run 或相邻消息。
- `displayName` 与 `avatarRef` 取该作者当前 Profile，和回复摘要材料、水位处于同一个只读事务。
  离队／移除状态不改变历史回复的作者；Profile 不存在时 `author` 为 null，摘要仍返回。
- `avatarRef` 为既有受控头像引用或 null；不投影图片字节、Runtime 配置或完整 Profile。
  图片解析与无头像回退沿用 [Member Avatar v4](member-avatar-v4.md)。
- 新 Renderer 遇到旧 Host 缺少 `author` 或 null 时保留原摘要，不猜测身份；旧 Renderer 可忽略新增字段。

## 读取与失效边界

候选查询仍使用直接回复组合索引选出一条消息 ID，再仅对该条消息按主键关联作者 Profile 的三列。
完整用户目录不增加作者或头像字段，不预取全部回复，不增加数据库迁移、持久副本或业务写入。
纯摘要格式化继续在释放共享 Database 锁之后进行。

姓名变化沿用目录／预览失效；头像引用变化只清除已访问的预览缓存，下一次悬浮／聚焦再读取。
消息失效、120ms 合并触发、按访问缓存、单个独立定位窗口与正文分页保持原规则。
既有 SQL owner 验证真实回复作者、缺失 Profile、当前身份与同事务快照；生产 Renderer fixture
验证 C 方案、双主题、旧 Host 回退、头像失效不重读目录及原导航行为。
