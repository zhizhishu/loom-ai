---
document_type: contract
contract: runtime-usage-monitoring
version: 9
status: accepted
source_version: v1.72
last_updated: 2026-10-12
---

# Runtime Usage Monitoring v9

继承 [v8](runtime-usage-monitoring-v8.md) 的数值语义、去重、归属和读取 wire；以下规则替代同步
terminal Flush、400ms 尾读和终态删除 checkpoint。取舍见 [V1.72-D36](../versions/v1.72/decisions.md#v1-72-d36)。

## Run 与后台统计

Run 的成功、失败、取消及后继执行不等待 Usage Flush、原生日志读取或费用投影。终态处理只在内存
标记采集结束；已收到的数值由既有 4 秒周期任务补写。刷盘失败保留批次供后续周期重试，不改变业务
终态，也不要求用户再次执行任务来补统计。正常退出仍尽力刷盘；崩溃可以丢失尚未持久化的统计。

`finalized_at` 表示 Run 已结束，允许之后更新 summary/hourly。周期任务落盘成功且无待写数据后，
回收该 execution epoch 的内存去重状态。Run/epoch、原生来源与当前 Session 的归属校验继续生效。

本地 journal baseline 在后台建立，prompt 不等待；无法采集时保持缺失，不切换 Token 来源补总数。
周期读取跨过完成边界时丢弃结果；终态不再强制尾读，后继 prompt 可以立即启动。接受早期、尾部数据
缺失及每轮统计切分不完全，本地 journal 的已观测 contribution 标记为 `runtime_reported_partial`。
短于一个采样周期的 journal Run 可能没有统计。未知值不补零，不由 Runtime 正常结束推断统计完整。

## 迟到批次与清理

Migration 194 将 projection schema 143 升到 144，只替换终态触发器并保留原数据。Run 结束后不再
删除 checkpoint；迟到的 cumulative/delta 批次继续沿用既有基线和幂等键，不重复累计已提交观察。
现有低频清理任务分批删除超过 72 小时、且所属 Run 非活动态的 checkpoint。长期 summary/hourly
保留规则不变，不增加永久逐调用日志或新的结果对账任务。

## 验证边界

Usage 刷盘锁被占用时，原生终态仍能结算并取得后继 lease。失败刷盘在终态后重试，不丢待写数据；
同一迟到观察重复到达不增加总量。完成回包本身缺失时仍由用户停止并按需继续，本合同不把静默推断为成功。
