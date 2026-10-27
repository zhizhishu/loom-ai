---
document_type: contract
contract: file-preview
version: 18
status: accepted
authority: file-change-review-version-refresh
source_version: v1.64
last_updated: 2026-09-22
---

# File Preview v18

继承 [v17](file-preview-v17.md) 的文件来源、授权、恢复、Viewer、共享标签集合和分栏宿主。本版只增加
[Runtime File Change Observation v6](runtime-file-change-observation-v6.md) 的可变 projection 刷新语义。

已打开的 `File Change` Tab 以 exact `campId + agentRunId + executionEpoch` 保持身份，并记录当前
`sourceChangeSequence + revision`。同一 projection 的较新卡片到达时，Renderer 原位同步摘要并使旧 detail 失效；
不得通过关闭、重建或重新激活 Tab 刷新。当前文件选择只要仍存在就保留，否则选择第一个可审查文件；Tab 的展开、
滚动、文件搜索和 pane 比例保持不变。

detail 响应必须携带同一 projection 版本。低于当前卡片或 Tab 版本的异步响应直接丢弃，不能覆盖新结果；新版本
失败时保留上一份可读 detail，显示待更新状态并允许重试。`isStale=true` 的旧 projection 可读但不是最新，下一次
详情读取会先尝试定向重算。普通文件 Tab、Activity/Execution 合成 Tab 和历史 schema 1/2 Review 行为不变。

## 验收

- 同 Run/epoch 的 Diff 内容更新后，已打开 Tab 不卸载、不抢焦点并刷新 detail；
- 较旧异步 detail 不覆盖新 revision；
- 文件 ID 稳定时保持选择和滚动，文件消失时才执行确定性回退；
- 重算失败仍能阅读上一版，不显示虚假 `no_changes`。
