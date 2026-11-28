---
document_type: ui-contract
authority: web-connection-recovery-presentation
status: accepted
target_version: cross-version
last_updated: 2026-11-28
---

# Web 连接恢复

Desktop 托管和独立 Server 的 Web 共用一个可关闭的“重连中”条，宽屏与手机使用同一组件。
连接断开或原提交仍需恢复时，条固定在页面上方并避让安全区，不遮挡也不暂停业务页面：
已打开的弹窗、正在编辑的草稿和页面快捷键都保持原样。条不使用 scrim、`inert`、模态焦点陷阱，
也不注册全局捕获阶段的键盘监听；关闭 × 只隐藏这条提示，不改变恢复事务。连接恢复后条自动隐藏，
下一次断线重新出现。

条只有一个 `role="status"`、`aria-live="polite"` 区域，`data-variant` 区分三种呈现：

| 状态 | variant | 标题 | 操作 |
| --- | --- | --- | --- |
| 断线，无待核对 | reconnecting | 正在重新连接 | 关闭 × |
| 断线，有待核对 | reconnecting | 有 N 个操作等待核对 | 恢复连接并重试、关闭 × |
| 恢复中 | recovering | 正在恢复连接… | 禁用，显示正在恢复…、关闭 × |
| 恢复未完成 | failed | 仍无法连接服务 | 恢复连接并重试、关闭 × |

正文只说明页面和草稿保留；有待核对时说明只核对原提交、不会重复发送；失败时提示确认服务已启动。
条使用字面色（不消费 LOOM 应用 token）实现 day/night，顶部留出 `env(safe-area-inset-top)`，
390 宽度下换行且不产生横向溢出；减少动态效果时停止旋转。
标题、说明、按钮与恢复通知跟随现有界面语言偏好。

SSE 续传与条互补：`invalidate` 帧携带服务端进程内全局单调的事件 `id`，客户端记住最后编号，
重连时以 `Last-Event-ID` 请求头补发；服务端可连续回放时不发 `resync`，`resync` 帧本身不带 id。
游标在退出登录（`clear()`）后归零；连接旧服务端（无 id 行）时游标保持 0、不携带请求头，行为与今天一致。
页面回到前台或网络恢复时，现有 `visibilitychange`／`online` 处理立即唤醒重连，不等指数退避。

服务恢复且没有待处理提交时可自动回到原页面。有未知提交时，自动重连仅核对；
显式按钮才可使用原提交重试。成功和明确失败释放提交中状态；业务失败保留原页面的错误反馈与草稿。
刷新后上传内容丢失时，用现有通知提示重选原文件，避免无限锁住页面。
认证失效沿用登录页。领域边界由 [Host Web v4](../contracts/host-web-v4.md#web-断线恢复)拥有。

验证入口为 `pnpm test:host-web-recovery`：独立 Chrome profile、正式传输／重连条与带事件编号和
`Last-Event-ID` 回放的故障注入 HTTP fixture，覆盖 SSE 断线、条出现时页面与弹窗及草稿仍可交互、
× 关闭、唤醒后无 `resync` 的编号补发、失败状态与重试、日夜与手机布局、原提交重试及失败解锁。
该用例不启动 Core 或 Runtime，不能作为真实 Host 命令幂等或实体手机网络切换的验收证据。

`pnpm test:host-web-recovery-live` 另验正式 WebEntry／BusinessApp 和真实 Rust Host 的停止、重启、
登录态与 Composer DOM／草稿保留，以及回前台／网络恢复唤醒后重连条自动消失；刷新后公共发送成功时
编辑器与持久草稿同步清理、后续编辑保留。
同一用例还用正式 ConsoleClient 验证真实 Core 明确失败的 Promise 结算，以及提交后丢响应时只读核对、零重复发送。
运行前构建 WebUI 和 Host；
可用 `ROVAI_HOST_BIN` 指定现有 Host 二进制，报告记录其摘要。测试自行隔离数据、Skills、MCP 与浏览器，
不配置或调用 Runtime。`ROVAI_WEB_RECOVERY_OUTPUT` 可指定两种用例的截图与 JSON 输出目录。
