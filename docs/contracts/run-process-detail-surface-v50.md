---
document_type: protocol-contract
contract: run-process-detail-surface-v50
authority: conversation-run-presence-surface
status: accepted
version: 50
source_version: v1.72
last_updated: 2026-10-12
---

# Run Process Detail Surface v50

继承 [v49](run-process-detail-surface-v49.md) 的资格、停止、重试与读取恢复。本次替代
消息尾部统一占位、正文合并换行及左侧进行中转圈，采用 User 确认的 v12。

## 每 Run 的位置

- 尚未公开回复时，使用 Run 已领取输入的不可变 anchorMessageId 固定位置；其他人的消息、
  追加输入和发送失败不移动执行行。旧 Run 无输入锚点时按 startedAt / createdAt 恢复开始边界。
- 自己的已提交公开消息按 sourceAgentRunId 归属，以最高 sequence 决定新位置；不按正文、
  队员名称或消息时钟推断，不跟随乐观消息或已撤回消息。
- 执行行接在自己的消息和附属产物之后，不拆开产物组，不改变已有消息或 Task 顺序。
  紧接同 Run 的消息／产物时省去重复身份；同位置其他 Run 按开始时间和 ID 稳定排列。
- 切回或刷新使用已有 Run / Message 投影恢复位置，不依赖 Renderer 首次观察时的最新消息。
  初始锚点不在加载范围时保留在对应历史边界；补入历史时按锚点恢复，不移到当前末尾。
- 行的 React identity 按 Thread 内 Run ID 保持，位置变化不清空执行读取、停止确认或按钮焦点。
  缓存预览不复活失败重试；已受理续做和自然结束沿用原规则收起。

## 同一物理行内推进正文

只用已有 Narration Evidence 的原始换行推进：当前行随增量增长，下一个非空行出现后替换当前行。
CRLF / CR 视作源换行；尾部换行和空行暂留前一个非空行。行高始终固定，长单行静态省略，
不按标点、字数或可用宽度自行拆段，不滚动文字。完整正文仍由原执行详情拥有，Evidence 不改写。

运行中直接使用 RunCard 的 RunningText 高亮与时序，移除左侧转圈。命令保留原工具图标；
等待、失败和停止提交不扫光；减少动态效果与强制颜色时关闭高亮层。停止区、默认色、
确认交互、重试授权和 36px / 粗指针 48px 行高不变。思考内容展示不在本次范围。

## 验收

并行开始 → 他人发送 → 自己发送 → 他人再次发送 → 自己再次发送，只有成功发送者更新位置。
覆盖同队员不同 Run、追加输入、失败／重试、切群／刷新、分页恢复和消息附属产物。
流式正文覆盖原始换行、空行、CRLF、长单行、工具切换；两主题、窄窗口、200% 等效布局、
粗指针与 reduced-motion 保持布局和停止入口，详情保留完整原文。
