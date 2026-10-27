---
document_type: protocol-contract
contract: message-delivery
version: 16
status: accepted
authority: public-message-delivery-route-reconciliation
source_version: v1.72
last_updated: 2026-10-15
---

# Message Delivery v16

继承 [v15](message-delivery-v15.md)。普通执行资格与 Steer 资格分别判断；新 Manifest 采用
[v39](context-manifest-evidence-v39.md)。仅用户消息可以 Steer，正文、附件、引用和 Skill 授权仍走共同路径。

## 统一资格

Core 根据目标活跃 Run 冻结的 Adapter、安装身份／generation、程序路径／摘要、实际版本、协议和
binding 判断，不能读取队员当前配置代替。替换磁盘程序或修改队员默认值不改变已经运行的 Host。
缺少身份、版本未知、协议不兼容、初始输入尚未接受、取消中、epoch 过期或前一输入结果未知均不开放。
实际写入只能使用同 Run／epoch 的已存在 Host，并继续校验原生 turn／Prompt 与 owner。

Read Model 的 `canSteer` 和 `steerUnavailableReason` 来自同一 Core 入口；消息准入与实际投递前
复查。Renderer 只展示结果，不维护 Runtime 版本表。多目标逐一选择插话、排队、普通启动。
过期 UI 或直接 API 不能绕过检查；不支持插话不会降低其原有普通执行资格。

当前接线所依赖的 ABI 策略独立于全局 Runtime 最低版本：

| Adapter／通道 | Steer 准入边界 | 必要语义 |
| --- | --- | --- |
| Codex App Server v2 | 0.162.1 起、当前 major 0 | 当前启动和工作区能力、expectedTurnId、接受回执 |
| Claude Print v1 | 2.1.83 起、major 2 | 必传启动参数、UUID 回显及结束状态 |
| Pi JSONL RPC v1 | 0.99.0 起、major 0/1 | disposition、user 消费关联、clear_queue |
| Qwen ACP v1 | 0.18.4 起、major 0 | 结构化 drainMidTurnQueue items/content |
| Grok ACP v1 | 1.0.14 起、major 1 | interject 原子投递修复及 queued 回执 |
| Kiro ACP v1／v2 引擎 | 2.21.1 起、major 2 | queued／injected 的 messageId 与正文关联 |
| ZCode App Server v1 | 官方 App 3.12.2 为最早已测包；内部核验内核 0.16.5 起、major 0 | 捆绑内核身份及 guide queued／drained 关联 |
| TRAE CN ACP v1 | 0.207.1 起、major 0 | 活跃 Session steering 的 injected 回执 |
| CodeBuddy ACP v1 | >=2.109.1 | 专用 steer 的 owner 回执；无该方法的旧版使用并发 prompt |

这是当前实现的准入策略，不是所有区间版本都实测通过的声明。预发布、未知协议保守排队；
CodeBuddy 仅设最低版本，其余 Adapter 仍按表内 major 范围判断。ZCode 对 User 使用 App 版本说明；Core 继续核验实际捆绑内核与可执行文件摘要，
不新增另一套 App 版本门禁或存储字段。
CodeBuddy 2.132.0 的业务结果异常独立追踪；单个未遵从样本不等于已证明协议不兼容，也不能用
低版本成功外推全部后续版本。真实结果和发布决定另记验收报告。

## CodeBuddy ACP

保持 ACP stdio，优先 `session/steer`，以原 Prompt 观察到的根 `conversationRequestId` 作为
`expectedRequestId`，以当前输入 ID 作为 `clientUserMessageId`。回执必须是 `steered: true` 且
`ownerRequestId` 匹配；没有观察到原生 request ID 时不能确认专用方法的接受归属。
只有该请求明确返回 `-32601`（方法不存在）时才重新核验原 Run／epoch／Prompt，并使用旧版并发
`session/prompt`。明确 `steered: false` 转普通投递；其他错误、归属不匹配、超时或迟到回执保持未知，
不尝试第二种方法。两条路径都在结束／停止后回收使用过插话的 Host。

`_codebuddy.ai/modResidentInvalidate` 是原生界面缓存失效通知，只在 CodeBuddy 的无 ID notification
中作为 Session metadata 处理；不充当初始输入或插话的接受证据，也不放行未知 method 或 request。

## TRAE CLI CN

沿用 CN ACP 通道和全局启动参数顺序。向原活跃 Session 发送 `_session/steering`，prompt 是
当前完整动态上下文的文本 Content Block；只把 `outcome: injected` 作为相关请求的运行时接收证据。
原 `session/prompt` 生命周期继续拥有 Run 终态。明确的无活跃请求、方法不存在或错误 Session 拒绝
可转普通队列；不认识的错误、回包、超时和结束后的回执为 unknown。

它没有 Codex 式原生 expectedTurnId。Core 在活跃 owner 内发送，使用过插话的 Host 在原执行
结束／停止后回收，不复用于后继 Run；逻辑 Session 恢复遵守原合同，不声称存在原生原子 turn fence。

## 回执与失败语义

`accepted` 的共同含义是“运行时已接收”。只有 Adapter 有明确消费事件时才能描述为已消费；
消费也不保证业务要求完成。CodeBuddy steered／supplemental end_turn、Grok queued、TRAE injected 不统一
解释为模型已经读取并执行。界面简短摘要“已插话”表示同一接受事实，详情保留“运行时已接收”；
不得把摘要理解为已消费或完成。

可证明未写入或明确未接受时，按既有合同转普通投递且只投一次；提交后结果未知不重发、不补建任务、
不显示成功。前一输入未知时新消息仍能普通排队，不会清除旧未知。停止后不能把未消费队列带到
下一 Host；保留历史对话不等于允许重放队列。迟到 ACK 精确补充原输入，不更新后继 Run 的接受水位。

Pi 停止先关闭当前 Runtime 的插话准入，等待已准入输入完成原生写入，再由停止路径明确执行
`clear_queue` 后 `abort`。队列精确取回的未消费输入按既有 not-accepted 处理；等待模型消费或
Steer ACK 不占提交锁。未使用插话的普通执行不依赖新增队列接口。
Claude 的待确认 UUID 只属于其原前台执行阶段；该阶段的 result 可用明确 UUID 完成接受，余下
已开始写入的输入保持未知、尚未写入的输入明确拒绝。同 Session 后续回显不改变原轮归属，
后台任务与 Session idle 的完整 Run 结束规则不变。关联状态只在内存保存。

Steer 领取与普通领取一样关闭消息的现有撤回标记；旧记录仍按真实 Delivery／Run 输入归属投影
`canWithdraw`，不补写历史标记。任一目标已领取后整条消息不能撤回。
