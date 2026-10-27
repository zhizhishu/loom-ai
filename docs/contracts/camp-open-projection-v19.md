---
document_type: protocol-contract
contract: camp-open-projection-v19
authority: camp-open-and-execution-window-read-boundaries
status: accepted
version: 19
source_version: v1.58
last_updated: 2026-09-19
---

# Camp Open Projection v19

继承 [v18](camp-open-projection-v18.md) 的 Open schema 7、业务集合和原始 Evidence 边界。
本版将首屏读取、连续记录缓存与 DOM 渲染分离，增加展示增量和淘汰后向前读取；Snapshot 34、Data Contract 99 不变。

## 首屏与刷新

`camps.enter`、`camps.open` 返回的 `executionEvidence` 为空；coverage 的 `loadedCount` 为 0，
`totalCount` 仍是该 Camp 的原始持久 Evidence 行数，`complete` 仅在总数为 0 时成立。
`agentRuns[].executionEvidenceCount` 保留原始行数；它不是正文段落数、可见步骤数或分页项数。
其他业务集合沿用既有窗口。Open 及嵌套 loader 不访问 `event_log`，也不读取执行正文和完整 Diff。

执行台或 Inspector 中真正打开的 Run 首先请求一页执行窗口；关闭的 Run、Drawer、隐藏 Inspector
与地图不读取该 Run 的历史。Run 状态、等待原因、停止和审批入口来自业务投影，独立于详情读取。

## 执行窗口

本地 typed method `agentRunExecution.page` 参数：`campId`、`agentRunId`、可选
`beforeSequence: number | null`、可选 `afterSequence`、可选 `limit`。缺省 limit 为 24，Core 限制为 1–96。
Core 验证 Run 属于目标 Camp，非空 cursor 必须为正整数；before 与 after 互斥。after 按逻辑展示位置升序读取，仅在较新缓存已淘汰时使用。

响应 `AgentRunExecutionWindowPage`：

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 1 |
| `campId` / `agentRunId` | 精确读取目标 |
| `requestedBeforeSequence` | 回显请求 cursor；null 为最新窗口 |
| `throughSequence` | 同一事务读取到的 Run 原始 Evidence 最大 sequence |
| `evidence` | 依逻辑首 sequence 升序排列的一页展示记录 |
| `hasMore` | 请求方向还有展示记录 |
| `requestedAfterSequence` / `nextAfterSequence` | 向前读取回显与后续逻辑位置；未采用向前读取时为 null |
| `nextBeforeSequence` | 有更早页时为当前页最小逻辑首 sequence，否则 null |
| `activeEvidence` | 最新页之外仍未结束的 Canonical 操作；只在非终态 Run 的最新请求返回 |

按操作与 execution epoch 分页；同一 Canonical 操作的开始、完成及补充证据不拆成两页。
对外保留最新 Evidence ID 用于完整内容读取，展示 sequence 取该操作的首 sequence；补齐较早输入与
最新结果状态。正文 block、同 item 的旧 text delta、计划、诊断及 compaction 保留各自语义身份。
reasoning 和不进入执行台的传输增量不占分页项。`activeEvidence` 不推进历史 cursor，避免漏掉中间历史。

分页选择先查询身份与顺序，再 hydration 当前页；Canonical source IDs 一次展开后按 Evidence ID 关联，
不对每个 Evidence 重扫整个 Run 的所有操作来源。完整输出、Diff 正文和 Core Envelope 不随窗口传输。
文件行携带路径与增删数，Diff 字符串为空，延后到用户展开。窗口记录标记需要 content 读取，不能据此声称
原始 Evidence 或 Blob 被截断、修改或丢失。

已成功的纯 CLI 载体可以携带临时 `payload.executionWindowBuiltinOperation` 关联：Core 仅在完整 JSON
输出精确匹配生命周期内唯一可信 Core 操作的 Agent Result Projection 时提供；Renderer 仍验证 CLI 操作和
纯命令语法后才折叠。此关联支持相邻页边界，不返回用于比较的结果正文，不写回 Evidence 或 Canonical。

## 展示增量

`agentRunExecution.changes` 接受 `campId`、`agentRunId`、非负 `afterSequence`、`limit`（缺省 96，限制 1–96）
及 `refreshEvidenceIds`（最多 256 个已加载未完成记录 ID）。Core 验证 Run/Camp 归属与 cursor 不超过当前原始水位。

响应 `AgentRunExecutionWindowChanges` 的 `schemaVersion` 为 1，回显目标与 `requestedAfterSequence`。
`evidence` 返回原始证据变化水位之后的逻辑操作，按变化水位选择，仍携带稳定的逻辑首 sequence；
`nextAfterSequence` 是本批最后的原始变化水位，`hasMore` 为 false 时推进到 `throughSequence`。
不能使用展示 sequence 作为增量水位，否则旧 command 的新完成记录会丢失。
`refreshedEvidence` 单独重读指定 ID 所属逻辑项，并叠加内存中尚未持久完成的正文；正文完成时原地修改
同一 Evidence，因此原始水位未变化也必须刷新未完成记录。所有选择与持久投影在同一事务中完成。
正文、完整输出、Diff 的延后读取与普通展示页相同；不扫描 event_log，不返回整个 Run 的内容。

## 阅读、缓存与失败

Renderer 首次按视口估算 12–48 项；上翻按 64 项读取，只预取相邻更早一页，不递归预取。
已加载记录组成连续区间。新记录追加，已存在记录按稳定逻辑 sequence 更新；刷新不能重置为最后一页。
历史边界固定在连续区间最早位置，实时尾部前进不改变该边界，也不重复预取同一个相邻页。

执行详情缓存独立于 React 组件生命周期，按 Camp、Run、execution epoch 隔离。Renderer session 保留最近 8 个 Run、
合计 24 MiB 估算预算，优先淘汰未挂载 Run。单 Run 展示记录目标为 2048 项、8 MiB；完整正文、工具结果、
Diff 和展开状态使用另一个 256 项、8 MiB LRU 预算。预算是序列化 UTF-16 估算，不等于精确 JS heap。
最新小窗口和相邻预取页单独保留；单个超大记录及正在阅读的可见范围优先于目标预算。
超过展示预算时，从阅读范围之外的旧端或新端淘汰；新端被淘汰时暂停连续增量，待滚到该边界按需向前恢复，
或显式回到最新时读取有界最新窗口。跟随最新时，原始变化水位差超过展示项预算，直接重读最新窗口，
不逐页补齐长时间离开期间的全部变化。不得在后台逐页补齐未读的整段历史。

DOM 使用实测高度的虚拟列表，只挂载视口及相邻缓冲区；屏幕外用高度占位保留连续滚动空间。
工具组收起不创建子行，展开后的长组也按可见范围渲染。正文只在对应行挂载时读取，缓存命中直接恢复；
在途正文请求复用，迟到结果可以完成已发起的缓存填充，但不能更新已卸载组件。
翻页、虚拟行尺寸变化保留阅读锚点，滚动补偿不触发新一轮历史分页。用户主动滚到未加载边界或点击文字入口
才继续读取。加载入口沿用会话区文字箭头和原位重试样式，计数表示已加载展示项，不是 DOM 或缓存总量。
缓存内回看没有加载入口；底部不提供“加载较新记录”按钮，“回到最新”采用已有缓存并定位。

切换 Camp 或关闭 Run 释放订阅、停止预取和增量追读，并拒绝迟到的页面/增量响应。回到正在执行的 Run
优先呈现缓存最新位置，再异步补齐变化。首次异步页面、完整正文与高度测量完成后仍须保持跟随最新。
错误保留成功内容；分页显式重试同一方向。目标、cursor、页内顺序或增量水位不兼容的响应不应用。

完整详情沿用 Camp-scoped `agentRunEvidence.getContent`，新增可选 `canonical` 返回当前操作的 Diff。
原始 `agentRunEvidence.list`、完整 Snapshot、Blob、审计和模型观察语义保持原边界。
渲染规则见 [Run Process Detail Surface v35](run-process-detail-surface-v35.md)。
