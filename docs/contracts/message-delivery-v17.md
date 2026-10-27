---
document_type: protocol-contract
contract: message-delivery
version: 17
status: accepted
authority: public-message-delivery-route-reconciliation
source_version: v1.72
last_updated: 2026-10-15
---

# Message Delivery v17

继承 [v16](message-delivery-v16.md) 的消息、逐目标投递、版本门槛、接受含义和停止规则；以下条款
替代其 Claude 前台轮次限制、启动期准入和补充输入终态门禁。其余 Runtime 的原生回执要求保持。

## Claude：受管执行内追加

沿用 Stream JSON，使用既有 Runtime Input Delivery ID 作为输入 UUID，不生成第二个消息编号。
UUID 只关联逐条回执；同一受管 Run／epoch／Host／Session 内的精确 user replay 或 result UUID
可确认“运行时已接收”，不要求出现在前一段前台 result 之前，不承诺同一个原生 turn。
输入按现有 writer 顺序提交；中间 result 不拒绝排队帧、不移除待确认 UUID。

Run 生命周期依然由原生工作、权限、后台任务、完整 idle 和进程／输出结束决定，不由 UUID 是否全数
确认决定。先前 result／idle 不能越过新写入；停止或关闭仍封住零字节写入，部分写入不视作未发送。
进程退出先封住新输入并收集输出，输出结束时才结算剩余回执，避免丢掉管道里最后的匹配回显。
没有回执但执行仍在处理时保持发送中；真正断连或结束后仍无法确认的已提交输入保留 unknown，
不自动重发。未写出的帧可证明未接受，按既有停止／普通降级规则处理。

可靠成功／失败不再被 prepared 或 unknown 的补充输入阻塞；初始输入、安全动作及审批的既有终态
约束保留。结束事务分别结算 Run 和补充 Delivery：已接收保留，已提交未确认保留未知，可证明未提交
才按原合同处理。迟到证据只能补齐原输入，不能更新后继 Run。

## 启动期待插话

Core 将“可提交给本次任务”与“现在可以写入”分开。目标 Run 已确定、冻结版本与协议支持且未取消时，
queued／连接／初始化阶段也可接受插话意图；尚无 Run 时仍使用原有普通批量领取。
queued Run 绑定即将领取的 execution epoch，已运行 Run 绑定当前 epoch，不能改投其他 Run。

意图只复用 CampMessage 和 claimed Delivery，不提前生成额外 Manifest、不覆写初始快照。
初始输入在当前 binding 上 accepted 后唤醒既有 Scheduler，再构建本次动态上下文并投递；
此前不会调用原生 Steer。版本／协议不支持继续普通队列；启动失败或停止结算已绑定意图，不自动续跑。

Read Model 的 `canSteer` 表示可提交意图，Renderer 不维护另一套资格规则。等待实际投递显示“待插话”，
开始投递但尚无回执显示“发送中”，精确接收后显示“已插话”，详情为“运行时已接收”；混合目标逐一计数。
投递阶段复用已有 dispatch 时间投影，不新增持久状态。

## 实际版本与存储

冻结配置缺版本时，在已授权启动中从该路径读取有界 `--version`，只采用与冻结程序摘要匹配的结果或
已有内存发现缓存。版本读取失败只影响 Steer，不阻止原本可用的普通执行；不执行模型或完整健康探测。
已运行的 Host 不随队员配置或磁盘更新重新解释版本。

无迁移、独立核对服务、额外模型调用、额外正文或新提示词。普通消息与 Steer 继续共用 Builder、
Formatter 和 RUN_INPUT；每次只包含本次投递的消息，历史载荷和接受证据保持原样。
