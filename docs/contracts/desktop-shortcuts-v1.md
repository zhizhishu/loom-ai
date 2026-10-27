---
document_type: contract
contract: desktop-shortcuts
version: v1
status: accepted
last_updated: 2026-10-15
---

# Desktop Shortcuts v1

快捷键属于本机 Desktop 偏好。Main 是保存权威，Renderer 的录制、显示与触发共用
`apps/desktop/src/shared/shortcuts.ts` 的命令目录、默认值与校验；按键身份由
`packages/contracts/src/shortcut-key.ts` 统一规范化，HTML 预览桥接复用同一函数。
不进入 Core、Thread、模型输入或跨设备同步；Web 未提供此 capability 时沿用原交互。

## 配置与并发

`userData/shortcuts.json` 保存 `schemaVersion: 1`、`bindings`、`mouse`、`sendMode`：

- `bindings` 为全部 23 个 `ShortcutActionId` 到规范化组合或 `null` 的完整映射；每个键盘组合最多属于一个动作。
- `mouse` 只有 `side1` / `side2`，值为动作 ID 或 `null`。两侧默认均为 `null`；一个动作可同时拥有键盘和两侧绑定。
- `sendMode` 只有 `enter` / `primary-enter`，默认 `enter`。
- `Mod` 表示当前平台主修饰键；macOS 的 `Ctrl` 单独表示 Control，不能与 `Mod` 归一。Windows 的 `Meta` 不获准保存。

`ShortcutPreferencesApi.get()` 返回 `{ revision, preferences, degraded }`。revision 是 Main 会话内的并发令牌，
不是磁盘 schema；`save({ expectedRevision, preferences })` 必须匹配当前 revision。Main 串行校验并原子写盘，
成功后才增加 revision、广播 `onChanged` 并替换触发中的配置。读者得到副本，不能原地修改权威值。

未知字段、未知动作、重复键盘组合、非法修饰键和发送方式拒绝保存。旧 revision 拒绝覆盖；Renderer 重新读取，
保留录制候选并让用户确认后再保存。写盘失败不更新当前生效值；重试沿用当前录制候选。
缺失文件使用默认值，损坏/不可读文件保留原件并标记 degraded；只有显式成功保存才替换它。

## 按键校验

普通字母、数字、标点单独或只搭配 Shift 时不获准绑定：macOS 至少包含 Command、Control、Option 之一；
Windows 至少包含 Ctrl、Alt 之一。Shift 可以叠加；macOS Control 与 Command 分别记录、显示、匹配。
只按修饰键、IME 组合输入或自动重复不生成候选。F1–F12 和既有保留组合沿用命令目录规则。
本机窗口关闭、缩放、编辑、系统保留组合不可覆盖；发送组合由 `sendMode` 管理。
缩放校验复用 Main 的实际输入判定，包括带 Shift 的 0、加减号及数字小键盘产生的同义组合。

发送仅接受所选精确组合：Enter 模式不带修饰键；primary-enter 模式只带平台主修饰键。
Shift+Enter 及其他未匹配 Enter 组合换行，IME、自动重复和 Mobile 原交互不提交。
Mission 描述编辑器继续按 Enter 换行。

## 输入与作用域

只在当前 Desktop 窗口分发，不注册全系统热键。动作调用已有命令入口及离开/草稿守卫。
启动未完成、关闭中、模态弹窗、打开的菜单、终端、inert 区域不执行全局动作。
后退/前进等非编辑动作不在输入框、编辑器内分发；会话工作区、查找与 Composer 按命令目录的作用域分发。
会话/单聊/执行台的最新位置按当前阅读区恢复；文件查找优先于会话查找。
HTML 预览在连接、改绑及清除后同步已保存的 `find` 绑定（包括 `null`），并传递给已连接与新连接的内部 iframe。
查找请求携带匹配的绑定与平台，宿主重验当前配置后进入同一分发器；旧绑定、隐藏预览和模态边界不能绕过分发。
未提供 Desktop 快捷键 capability 的 Web 继续使用原查找交互。

`setRecording(boolean)` 是当前窗口的临时录制状态。录制期间不分发已绑定动作，并暂停原生菜单、关闭标签和缩放快捷键；
结束、卸载、窗口失焦、导航或 Renderer 消失时释放。Renderer 录制候选不会提前变成已保存的触发绑定。

macOS/Linux 通过当前窗口的 DOM button 3/4 录制；Windows 通过 Main 的 `app-command` browser-backward / browser-forward
转为 `onMouseSide(side)`，Renderer 不再从 Windows DOM 同时触发，以免一次点击执行两次。
未绑定且不在录制时不消费或转发侧键命令。可见的后退/前进与原生 Mac swipe 继续使用原导航入口。

## 验证入口

共享模型、Main 持久化与 native input 的 Vitest，以及 `pnpm test:shortcut-settings` 的隔离 Electron fixture。
后者使用生产设置页、IPC、持久化、按键分发、原生缩放处理器、HTML 预览站点、会话组件和 Lexical Composer；
HTML 路径以可信指针进入 iframe 后按键，侧键由合成 DOM/native 事件模拟。
Windows 规则在 macOS 上的 Electron fixture 执行，不等同于 Windows 设备或实体鼠标验收。
