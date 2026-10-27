---
document_type: protocol-contract
contract: builtin-tool-transport-v42
status: accepted
version: 42
source_version: v1.72
last_updated: 2026-10-17
---

# Built-in Tool Transport v42

继承 [builtin-tool-transport-v41](builtin-tool-transport-v41.md) 未被下述条款替代的规则。

Transport/CLI **42**，capability `builtin_cli.transport.v42`；IPC **3**、Envelope **2**、Agent Output **14** 不变。

CLI context 增加 `tasksEnabled:boolean`。发现值仅用于过滤静态目录：只有有效当前合同、活跃公开 Run lease 且 Core 启用时为 true；缺失、旧版本、不合法或未知均为 false。help 只读本地安全投影，不要求 IPC 或身份验证。关闭时 root help 和 tool list 无 task；直接 task help/describe 返回同一局部错误：

```json
{"error":{"code":"task.feature_disabled","message":"Tasks are disabled. Continue with messages.","recovery":"stop"}}
```

Task CLI 错误退出码 2。错误不终止 Session/Run、不宣告整个工作失败、不教学如何开启。
每次保存开关（包括同值保存）和 Run bind 后刷新 registry 的活跃发现文件；失败不能回滚设置、撤销 lease 或取消 Run。
保存触发的刷新失败最多补偿三次，每次重新读取 Core 当前值；等待期间不持有调用锁。耗尽后再次同值保存仍可修复投影。
最终执行仍按 Core 当前值判断。

所有状态使用同一份 Send schema、help 和 Skill；public schema/help 不公开 taskId / --task-id。旧 CLI flag 与 IPC 可选 string/null taskId 作为输入兼容被忽略，原请求摘要与幂等身份保留。非法类型与缺值仍按参数错误处理，不猜测接收者。
