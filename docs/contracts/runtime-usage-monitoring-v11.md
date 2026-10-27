---
document_type: contract
contract: runtime-usage-monitoring
version: 11
status: accepted
source_version: v1.72
last_updated: 2026-10-18
---

# Runtime Usage Monitoring v11

继承 [v10](runtime-usage-monitoring-v10.md) 的后台统计、1.5 秒接收窗口、最多三次补采、
Run/epoch 归属与去重规则。本版补齐 MiniMax 的纯工具调用和压缩换代，不新增持久化字段或统计来源。

## 本轮原生身份

除已验证的显示消息 ID → canonical message ID / turn ID 映射外，活动 ACP Prompt 中的
`tool_call` / `tool_call_update.toolCallId` 也可以作为本轮身份。它们先经过同一 Session、Prompt、
Run、epoch 和 delivery 栅栏，每类集合最多 8192 个、每项最多 256 字节，不保留工具参数或正文。

补采仅接纳同一根 Session 的原生 assistant 数值记录：显式消息映射及 turn 相符，或结构化
`content` 中有类型为 `toolCall`、ID 精确匹配本轮冻结集合的条目，且其 turn 也属于本轮显示消息
显式映射已确认的 turn。仅有工具 ID、尚无本轮 turn 证据时保持缺失，避免历史复用 ID 被误计。已存在但 turn 冲突的显式映射
优先拒绝；不能按相邻时间、同一 turn 的其他消息或 Session 总数推测归属。

## 压缩历史

普通活动 cursor 遇到文件缩短、替换或缺口仍停止采集。只有具备冻结本轮身份的 MiniMax 终态
reader 可以重新读取 active history 及同目录原生 `history-catalog.json` 列出的 snapshot。
原生 SQLite 必须仍确认精确根 Session、工作目录和相同 history 目录；catalog schema 1、Session
身份、snapshot generation/UUID 文件名及无 symlink/path traversal 均需通过验证。

每次最多读取 active 文件与最近 63 个 snapshot，总计不超过 64 MiB，单行不超过 1 MiB，
catalog 不超过 1 MiB。active 记录优先，原 baseline 和 source identity 去重保留；旧 Run、后继 Run、
子 Session、半行和无法证明归属的记录不能进入统计。映射或完整行迟到仍只在原有有界窗口内重试。
这不是历史 Run 回填，也不重放模型输入。

## 完整性

reader 未就绪、锁忙、没有本轮身份、路径/格式不符、超过读取或接收预算时保留缺失。
业务终态和后继执行不等待磁盘。所有贡献继续标为 `runtime_reported_partial`；
没有原生 presence 证据的 reasoning、费用及其他字段保持未知，不能由几个非空数字推断完整账单。
原始文本只存在于有界解析缓冲，不进入 Evidence、Blob、日志或 Renderer。
