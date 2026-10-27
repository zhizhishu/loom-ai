---
document_type: protocol-contract
contract: run-process-detail-surface-v47
authority: conversation-run-presence-surface
status: accepted
version: 47
source_version: v1.72
last_updated: 2026-10-11
---

# Run Process Detail Surface v47

继承 [v46](run-process-detail-surface-v46.md) 的执行台、终态定稿和继续执行语义。
按 User 确认的 v5 HTML，在公开会话新增队员占位；替代历史版本禁止消息区 Run-local Stop 的展示限制。
停止资格、CAS、未知回执和 cleanup 仍由原命令拥有；不修改 Core、消息、Delivery 或模型上下文。

## 占位与消息顺序

实际 running Run 或已经开始执行的 waiting Run 在最新公开消息之后各有一行占位。
queued Run、未开始的等待、waiting Delivery 与 Single Chat 均不占位。流式更新不改变排序；
新消息以公开 sequence 为准推进占位。紧邻消息属于同一 Run 时省去重复头像、姓名，其他 Run
或用户消息插入后恢复身份；同一队员的另一 Run 不合并身份。消息尾部紧邻的同 Run 产物延续身份，其他 Run 产物或 Task 打断连续性。
并行时该连续 Run 排在首位，其余按开始时间、ID 稳定排序。
现有公开消息分组、复制／回复显隐、附件、文件变化与阅读位置策略保留。

内容使用执行台相同的 Evidence/live event 合并与投影，仅取最新可见正文或工具指令。
轻量 Thread open 不附带 Evidence 时，复用 ExecutionWindow 的 blocks 读取和增量水位；占位只请求一个尾块，
使用独立的阅读窗口，避免拖动执行台历史时改变占位或被占位拉回最新。不读取正文 Blob，不引入独立轮询。
正文从开头流式显示，命令保留既有规范化与工具图标，满一行后静态省略；不横向滚动、不插入时间或完成行。
点击内容精确打开该 Run 的既有执行详情。完成／取消移除活动占位，历史产物和停止标记继续只读保留。

## 停止与中断

消息区停止采用 v5 中确认的 V2 轻量方框与确认 Dialog；取消／Esc 不提交。
确认只调用目标 Run 的既有停止回调，提交期间禁用；Run 自然结束后关闭失效确认，不能按队员身份误停后继。
执行台原有直接停止不变。权威终态优先于本地提交和停止标记。

每位队员最新的公开 batch 失败 Run 可在消息区保留简短原因入口；新 Run 开始后不把旧失败重复追加到末尾。
有原业务输入时提供“重试”，使用 [AgentRun Continuation v3](agent-run-continuation-v3.md)
的独立 User 授权，不重放旧 Runtime 输入、不插入用户消息、不改写原 Run。
提交中禁用，未知结果复用同一 commandId 核对，明确拒绝保留入口并反馈；受理后收起当前中断占位，
新 Run 实际开始再显示。原失败记录与执行台继续按钮仍保留，等待本身不创建新的占位。

日夜主题共享组件和语义 token；桌面保持 30px 单行、26px 停止操作，粗指针扩展至 44px。
保留键盘可达、可访问名称与 reduced-motion。停留在历史阅读位置时，流式正文不夺取焦点或强制滚到底部。
