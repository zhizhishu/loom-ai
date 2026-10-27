---
document_type: protocol-contract
contract: camp-open-projection-v20
authority: camp-open-and-execution-window-read-boundaries
status: accepted
version: 20
source_version: v1.62
last_updated: 2026-09-20
---

# Camp Open Projection v20

继承 [v19](camp-open-projection-v19.md) 的 Open schema 7、Snapshot 34、Data Contract 99、
业务集合、执行窗口、连续缓存与虚拟滚动合同。本版只收敛读取与维护职责；Renderer wire、分页字段、
Evidence 身份和数据库合同均不变。

## Open 与 Enter 的持久化边界

`camps.open` 只在一个一致读取事务中组装并返回目标 Camp 投影。该入口及其嵌套 loader 不得：

- 执行 INSERT、UPDATE、DELETE、DDL 或领域命令；
- 结算取消、Run 终态、Delivery、Task、审批或 Channel request；
- 定稿执行文本、创建或更新 Managed Blob，或写入任何文件；
- 通过 `events.subscribe`、执行窗口读取或另一个前置读取请求间接完成上述维护。

Rust 接口为了建立读取事务仍可接收 `&mut Database`；只读以实际 SQL、领域和文件系统副作用为准，
不以引用类型为准。

`camps.enter` 继续拥有既有 activation、权限、命令回执和 Default Lead reconciliation 语义：Pending 直接读取；
Active 先重放原 reconciliation receipt，当前 Lead 有效的新 User enter 只读，只有确需修复时才提交原有
reconciliation 命令。reconciliation 完成后的投影阶段与 `camps.open` 使用同一只读边界。
`camps.enter` 不承接从 `camps.open` 移出的取消修复或文本定稿。

## 取消与终态的 owner

- 用户取消继续由现有取消命令事务立即提交，并使用统一 settlement 同时收敛 Run、Turn、Task、Delivery、
  Channel request 与审计；不依赖页面打开、维护扫描或 Runtime 退出。
- 成功、失败和普通取消命令继续由 `DomainCommandGateway` 在无待重试失败时收拢既有终态文本，并在业务事务
  提交后再次收尾。已进入退避的文本只归 maintenance tick；命令回放直接返回首次回执，不越过到期时间。
  Adapter 不增加平行终态实现。
- 绕过 Gateway 的受控关闭和 planned-shutdown 终态继续在其原事务提交后调用同一文本收尾入口。
- 退役两阶段取消协议留下的精确中间态由 Full Core 启动的 mandatory authority recovery 拥有：数据库打开或
  migration 完成后、通用 execution/input/delivery recovery 与正常准入之前，一次查询全部匹配 Camp，并在统一
  settlement 中结算。重复启动不再次结算；失败沿用 `authority_recovery_failed` 的 fail-closed 边界。

启动修复只依据持久取消意图和未完成关联状态。它不遍历 Camp 调用 `open`，不匹配普通 waiting/recovery，
也不从尚未落盘的进程内文本推断可恢复事实。

## 文本收尾失败重试

执行文本仍由原进程内 block buffer 唯一拥有。终态业务已提交而文本定稿失败时：

1. 已接受但未完成的 block 与临时 spool 原样保留；已成功定稿的 block 不回滚或复制；
2. 同一 buffer 只记录失败次数与单调 `retry_not_before`，不创建数据库表、任务、缓存或第二份文本；
3. 既有 `process_agent_run_maintenance` 的 500ms tick 只做内存到期检查；没有失败或尚未到期时不查询 Run/Camp；
4. 到期时只调用一次现有文本收尾判断。成功清除 retry 并复用对应 `agent.*.block` 事件刷新已打开执行台；
   失败按 500ms 起步、最高 30s 的退避延后；
5. 重试只读取 Run status、cancel marker 与 execution epoch 来判断哪些 block 应结束，绝不重放取消、成功、失败、
   Delivery 或其他领域命令。

旧 epoch、已不存在 Run 和已终态 Run 的 block 以 interrupted 定稿；仍活动且 epoch 匹配的 block 保持打开。
迟到输入继续由 ingress fence 拒绝。命令回执已提交时，相同命令身份只重放首次结果，不增加业务事件、文本、
Blob 或输入。

该 retry 状态有意不持久化。进程重启只能修复已有持久证据；不能声称恢复仅存在于旧进程内存或临时 spool 的正文。

## 验收边界

- 从未被打开的 Camp 仍可在取消命令、成功、失败或受控关闭时完成业务与文本收尾；
- 启动修复覆盖多个 Camp 的精确旧取消中间态，第二次运行零写入；
- 业务提交后的文本失败保留唯一回执和终态，维护 retry 成功后只新增文本/Blob 收尾；
- 打开 Camp A 时，即使 Camp A 有旧取消标记、Camp B 有待收尾大文本，也没有 SQL 或文件/Blob 写入；
- 没有 retry 时不增加全局查询、timer、worker、数据库连接或前端轮询。
