---
document_type: contract
contract: runtime-usage-monitoring
version: 10
status: accepted
source_version: v1.72
last_updated: 2026-10-17
---

# Runtime Usage Monitoring v10

继承 [v9](runtime-usage-monitoring-v9.md) 的后台统计、迟到批次、幂等和清理规则。
本版仅给具备精确本轮消息身份的 MiniMax journal 增加有界后台补采；业务终态和后继执行仍不等待统计。

## 消息身份限定的终态补采

MiniMax ACP 活动 Prompt 中的 `agent_message_chunk` / `agent_thought_chunk.messageId` 仅作为
不含正文的消息身份集合，仍先通过 Session、Prompt、Run、epoch 和 delivery 栅栏。最多保留 8192 个
不超过 256 字节的非空身份。不得从 Session 累计值、时间邻近或下一轮消息推测本轮调用。

收到匹配的 Prompt 完成事件时，仅克隆已经建立的 journal cursor、历史身份去重和该消息集合。
reader 尚未就绪、正在读取、已失效或没有消息身份时跳过补采；终态不等待 baseline、磁盘锁或读取。
后台在立即、约 250ms、约 1s 最多尝试三次，最多接收 1.5 秒内返回的结果；超时结果丢弃。
ACP 显示消息 ID 与 journal 的 canonical ID 不相同。每次仅从原生 SQLite 的同一根 Session、
assistant 行读取显式 `canonical_message_id` 和 `turn_id` 映射，不读取消息正文；映射缺失、歧义或
与 journal turn 不符则跳过，不推算。每次仍验证工作目录、路径、文件连续性和完整行，并只接纳冻结
显示 ID 映射出的消息。映射或完整行迟到时可重新扫描冻结 cursor 之后的有界后缀，既有身份去重保留。
已结束 Run 的统计注册在此窗口暂留，后台结束后由原有周期 Flush 回收；不保留 Host 或阻断新 Run。

重复的活动采样和尾读沿用原 source identity 去重。下一轮的不同消息 ID、历史 baseline、子 Session、
文件替换和半行不会借尾读归入已结束 Run。取消或错误不改变已产生用量的事实，也不由用量推断成功。
其他 journal Adapter 尚无等价尾读准入，继续按 v9 丢弃跨终态的普通采样结果。

## 完整性

补采只改善已观测消息的尾部覆盖；baseline 建立过晚、没有文本/思考消息 ID 的工具调用、压缩换代、
超过接收窗口的写入仍可能缺失。MiniMax journal contribution 继续是 `runtime_reported_partial`，
未观测字段保持未知；正常完成或几个非空数字均不能晋升为完整账单，不补零或猜费用。
