---
document_type: version-decisions
version: v1.65
lifecycle: historical
authority: decision-rationale
last_updated: 2026-09-22
---

# v1.65 版本决定

<a id="v1-65-d01"></a>
## V1.65-D01：删除恢复按 Camp→既有 cleanup journal 交接，不建立全过程 operation 表

- 状态：accepted
- 日期：2026-09-22
- 当前权威：Camp 永久删除架构与 Camp Permanent Deletion v4

可靠异步删除必须在请求返回后继续、经重启恢复，并在 Camp 聚合删除后完成资源清理。直观方案是新增
`camp_deletion_operation` 表，让一行拥有全部阶段；但现有系统已经有两个边界清晰的持久 owner：Camp 在聚合存在时
可以持有不可取消的删除意图与准入 fence，`camp_attachment_view_operation(kind='camp_delete_cleanup')` 可以在 Camp
删除后拥有附件、默认输出和 legacy View 清理，Mission Workspace 也已有 Worktree/branch 双检查点。

选择阶段交接：删库前以 Camp marker、现有 Run cleanup identity 和 accepted receipt 恢复；确认 Runtime 隔离后，在同一
SQLite 事务中先准备既有 cleanup journal，再删除 Camp 聚合并写 `camp.deleted`。删库后由 journal 与既有 Mission
cleanup owner 续跑。首个 command ID 作为三者共同的 `operationId` correlation，满足响应丢失、同 command replay 和
不同 command 去重，但不提升为新 aggregate、Task 或用户工作流。

该方案新增的字段分别避免具体故障：Camp marker 阻断重启后的新调度并保存删库前退避；journal retry 字段让 Camp 已删后
仍可自动恢复和一次性求助。拒绝纯内存 `spawn`，因为重启会丢；拒绝只保留 Camp 到全部文件完成，因为它延迟业务删除且
复制既有 journal 职责；拒绝新全过程表，因为它会与 Camp、attachment journal、Mission journal 三份状态重叠，并引入
没有额外故障收益的阶段同步。

<a id="v1-65-d02"></a>
## V1.65-D02：内部保留恢复阶段，用户只管理一次确认和同一 operation 的重试

- 状态：accepted
- 日期：2026-09-22
- 当前权威：Camp Permanent Deletion v4 与 App Shell UI

Runtime stop、业务删除和资源清理有不同安全条件，Core 必须知道当前 checkpoint；但把这些阶段直接投影成三种用户状态、
“删除任务”列表或成功通知，会要求用户理解内部所有权交接，并让“业务内容已删但文件清理待恢复”等诊断差异成为日常产品
概念。删除的用户目标只是确认不可撤销后让会话消失，后台可靠完成剩余工作。

选择让 accepted 成为唯一正常界面 cutover：关闭 Dialog、离开 Camp、从列表移除，正常完成静默。自动重试不打扰用户；
只有同一 operation 达到 attention checkpoint 时，以局部持久通知统一显示“删除未完成，请重试。”，按钮继续原 operation。
内部阶段、错误码、耗时和残留资源保留在 checkpoint、日志与诊断中，Renderer 不获得编排权。

拒绝阶段进度和任务中心，因为它们增加一套用户状态机而不提高恢复正确性；拒绝全局红色横幅，因为导航刷新或预览释放失败
不能推翻已经提交的 accepted；也拒绝受理即提示“永久删除完成”，因为那会把异步意图误报为资源终态。窗口 tombstone 仅
用于过滤迟到导航结果，重启后仍由 Core marker/read side 权威过滤，不成为第二套持久状态。
