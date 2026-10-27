---
document_type: protocol-contract
contract: run-process-detail-surface-v49
authority: conversation-run-presence-surface
status: accepted
version: 49
source_version: v1.72
last_updated: 2026-10-11
---

# Run Process Detail Surface v49

继承 [v48](run-process-detail-surface-v48.md) 的会话占位、停止区分隔及已受理重试恢复规则。
本次仅补齐单行执行预览的读取恢复，不新增界面状态或动作，不改变排队、完成、头像衔接与停止样式。

## 单行读取恢复

- 活动占位首次尾页读取失败后，后续执行更新或连接 resync 应重新请求有界尾页，即使 Run 字段没有变化。
  不需要重新打开执行台；读取错误不改变任务状态，不产生中断／重试行。
- 首次尾页在途时收到更新，保留一个合并的刷新标记；返回后自动补拉增量。首次读取失败时，
  该标记允许再读一次尾页；再次失败后等待新的更新或重连信号，不定时轮询或自行无限重试。
- 尾页与实时事件先按既有 Evidence 身份、revision、changeSequence 和同版本流式正文增长合并，
  再生成单行预览。旧读取结果不能盖过新实时内容，旧实时缓存也不能覆盖较新的恢复记录。
- 未开始可见读取的窗口保持冷态。切群、卸载及窗口释放清除待刷新标记，并丢弃旧请求结果。
  执行台历史分页失败仍保留已读内容、方向与游标，遵循既有显式重试规则。

## 验收

首次尾页失败 → 服务恢复／连接 resync → 原位恢复命令预览；Run 状态仍为 running。
慢速首次读取期间收到更新 → 首页返回 → 无须下一次通知即补拉最新内容。
有新实时正文时，旧尾页及补拉延迟期间正文不回退。持续读取失败不得自发循环，
关闭窗口后旧回执和待刷新标记不得触发新读取。
