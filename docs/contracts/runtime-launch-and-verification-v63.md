---
document_type: contract
name: Runtime Launch and Verification
version: v63
status: accepted
source_version: v1.72
last_updated: 2026-10-14
---

# Runtime Launch and Verification v63

继承 [v62](runtime-launch-and-verification-v62.md) 的启动、恢复、输入保护及展示边界。
本次只调整 Pi JSONL RPC 的接收预算和连接失败原因，不统一各 Runtime 的传输限制。

## Pi 单帧预算

Pi stdout 入站单条 JSONL 的默认上限为 **64 MiB（67,108,864 字节）**，按 wire bytes 计，
包括存在的 LF / CRLF 分隔符。读取时逐块检查，超限前停止追加；不预分配整份预算，不截断后继续解析。
Unicode U+2028 / U+2029 不作为分隔符，EOF 前的完整无换行记录仍可读取。

Pi 出站 JSON body 上限继续为 4 MiB，stderr 单条读取上限继续为 64 KiB；三者独立。
本上限约束编码后的单帧，不是原始文件大小或整个 Host 的总内存配额。图片 base64 和上游重复字段
都计入接收预算；不通过修改原始头像、统一压缩资源或改变其他 Adapter 的预算来满足它。

## 有类型的连接失败

stdout reader 将本地拒收原因传到 pending RPC 和带 Host / Run / epoch 身份的退出事件。
普通 EOF 继续走既有 Host 退出路径，不伪造已知原因。协议校验阈值与 request correlation 保持。

| 原因 | 公开 failure code | origin | 安全 detail |
| --- | --- | --- | --- |
| 接收帧超过预算 | `pi_rpc_frame_too_large` | `rovai` | 上限与已观察到的字节数下界 |
| 非法协议记录达到既有阈值或 response correlation 失败 | `pi_rpc_protocol_error` | `compatibility` | 固定协议校验说明 |
| stdout 读取失败 | `pi_rpc_read_failed` | `environment` | 固定连接读取说明 |

执行期 failure 的 phase 为 `execution`，retryable 为 false。公开 failure 不包含原始帧、图片、
文件内容或本机路径；非法记录诊断只记录字节数，不复制大段或敏感正文。
原生 `success: false` 仍由 RPC command rejection 拥有，不误分类为本地连接失败。

## 失败收尾与输入保护

有类型的连接失败仍使 Host 失效，并沿现有 Fleet 停止和 reap 路径清理。
`runtime_loss.reconcile` 增加可选 `failure: RuntimeFailureView`；缺失时保持旧行为，存在时校验
公开字段与当前 Run 的 Adapter。Host、Run、version、epoch 和终态 fencing 保持。

已接收、接收结果未知或已经开始发送的输入仍按
[Accepted Input Recovery v8](accepted-input-recovery-v8.md)收尾，不重新发送。
内部 `last_error_code` 继续为 `accepted_input_outcome_unknown`，公开 failure 保存上述具体原因；
这是连接丢失结算中的原因说明，不是原生终态证据，也不开放手动重试。
Single Chat 保持既有取消结算，同时保留安全公开原因。尚未发送的输入沿用原恢复规则。
迟到或旧代次的报告不得覆盖已知终态，其他 Runtime 的结算语义不变。
