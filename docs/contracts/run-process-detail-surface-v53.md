---
document_type: protocol-contract
contract: run-process-detail-surface-v53
authority: conversation-run-presence-surface
status: accepted
version: 53
source_version: v1.72
last_updated: 2026-10-13
---

# Run Process Detail Surface v53

继承 [v52](run-process-detail-surface-v52.md) 的活动预览、单行推进、4.8 秒高亮、菜单、停止、重试与恢复。
本次调整公开会话执行行的位置；Desktop 与 Web 共用相同投影。

## 初始位置与公开回复

- 未发送自己的公开消息时，以 Core 领取本次 Run 输入时冻结的公开消息末尾为边界，使用
  [Camp Open Projection v27](camp-open-projection-v27.md) 的 `publicTailSequenceAtStart`。
  先前 Run 在输入排队期间发出的回复属于此边界，不把新执行行插回触发输入之后。
- 在已加载的已提交消息中，取 sequence 不大于此边界的最后一条作为展示锚点；没有符合消息时
  放在当前消息窗口之前。刷新、切回会话与加载历史使用同一冻结值，不缓存前端首次观察位置。
  时钟回拨、后来输入、他人发言和同一队员另一个 Run 的新消息不能移动此边界。
- 自己成功发布公开消息后，按精确 `sourceAgentRunId` 与最高公开 sequence 移动到自己的最新回复后。
  撤回与尚未提交的乐观消息不作为自己的回复锚点；发送失败不移动位置。
- 历史 null／缺字段沿用既有兼容规则：有输入锚点时使用该锚点，没有时按开始时间恢复。
  锚点未加载不改用当前末尾，不为定位额外读取历史。

## 回复与附属卡片

任何执行行都必须插在锚点回复及其连续附属产物之后，包括另一个 Run 的回复。
新队员入队、Runtime 图片与 Files Changed 保持现有 Run 归属和顺序，不拆开同一回复输出组。
失败且没有公开回复的 Run 继续放在自己的独立产物组之后；未发布回复的普通执行不会因中间产物
单独出现而移动。公开消息、任务卡片和产物本身不重新排序。

身份衔接仍只取精确 Run：前一个完整输出组属于自己时可以省略重复身份，
新 Run 即使与上一轮为同一队员也显示自己的身份。多个执行行共享位置时，所属输出组的 Run 优先，
其余按开始时间与 Run ID 稳定排序。

## 验证

投影 owner 覆盖排队输入早于上一轮回复、后来插话、时钟回拨、分页与重入、旧字段、同一队员不同 Run、
本 Run 连续回复，以及跨 Run 插入不拆卡片。生产组件浏览器夹具用明确 DOM 顺序核对
“上一轮回复 → 入队卡片 → Files Changed → 新执行行 → 后来插话”，并验证自己的回复成功后再移动。
