---
document_type: interface-contract
contract: message-reedit
version: 1
status: accepted
authority: client-withdrawn-message-reedit
source_version: v1.72
last_updated: 2026-10-23
---

# Message Reedit v1

公共 Thread 的本地 User 撤回消息后，可在保存副本的当前客户端短期重新编辑文字。
本合同只拥有客户端恢复副本与显式回填；Core 的撤回准入、原文擦除和命令回放仍由现有合同拥有。
不修改已撤回消息，不恢复原 Delivery；再次发送是一次新提交。

## 保存与内容边界

撤回前从原消息构建独立 `ComposerDocument`，只保留 Text、显式 Member Mention 和 All Members Mention。
仅当原始结构化内容为空时才回退 `body`；过滤后为空不回退。界面自动显示的默认队长前缀不属于原文。
纯附件、空白正文不创建恢复副本。附件、引用、回复关系、Skill 和对话／使命 Atom 不随本功能恢复。

副本使用独立 `localStorage` 命名空间，每条消息一个 key：

```text
rovai.message-reedit.v1:<encodedScope>:<encodedThreadId>:<encodedMessageId>
```

Desktop 的 profile / Core 由 Electron userData 隔离，scope 为 `desktop:local_user`；Web 复用现有
Host origin / Owner / editor client 身份作用域。缺少稳定 scope 时禁用副本持久化，撤回仍可执行。
不同 scope 不能读取或回放彼此的记录；普通草稿使用自己的存储机制。

| 字段 | 含义 |
| --- | --- |
| `version: 1`、`scope` | 本机格式与身份作用域 |
| `request.commandId` | 原撤回命令身份 |
| `request.command` | 原始 `threadId`、`messageId`、`expectedVersion` |
| `document` | 可回填的结构化文字副本 |
| `state` | `pending` 或 `ready` |
| `pendingExpiresAt` | 发起前保存时的本机时间 + 120000ms |
| `expiresAt` | pending 为 null；ready 的固定截止时间 |

## 状态与有效期

| 情况 | 处理 |
| --- | --- |
| 发起撤回前 | 尝试写入 pending；不展示重新编辑 |
| 正常首次成功，pending 仍有效 | 转 ready，`expiresAt = 本客户端首次确认时间 + 120000ms` |
| ready 刷新、重启、重复回执 | 沿用原 expiresAt，不续期 |
| 请求超时／断线 | 保留 pending，结果尚未确认；不能按明确失败删除 |
| 异常补查成功，无法证明原始成功时间 | 使用 pendingExpiresAt 的剩余窗口，不补发两分钟 |
| 明确业务拒绝 | 删除对应命令的副本 |
| 记录过期、已删除或命令不匹配 | 不能由迟到回执及闭包中的旧正文重新创建副本 |

补查仅复用持久记录中的原撤回命令与参数，遵守 [Domain Command Result v1](domain-command-result-v1.md)。
在启动、恢复连接、回到前台及客户端失效通知时核对现存 pending，当前实例对在途相同命令去重。
不建立通用持久命令队列、循环重试平台或独立业务状态机；副本过期后不再由本功能补查。

命令成功一经确认就确定撤回成功，随后更新副本；列表刷新另行捕获错误。
pending 保存失败时撤回继续，提示本次无法重新编辑；ready 写入失败时删除可用入口并提示
“已撤回，本次无法重新编辑”。列表刷新失败不能删除有效 ready 副本或提示撤回失败。

## 读取、清理与容量

入口显示、点击和最终回填均调用同一个 `readReady(threadId, messageId)`，验证格式、scope、消息身份、
ready 状态与 `now < expiresAt`。恢复资格由读取校验保证，定时器只负责物理清理和刷新入口。
第 119 秒打开确认框、第 125 秒确认时拒绝回填并保留草稿，不暂停倒计时或锁定资格。

每个运行该功能的前端实例最多维护一个下一到期定时器。启动、前台、写入前及其他窗口 storage
事件补充清理；当前窗口写入直接通知自身。清理遍历本功能独立命名空间，包括旧 scope 的过期副本；
活跃副本的读取、回放和会话删除仍按当前 scope 隔离。没有副本时停止定时器。
应用关闭／系统休眠时不承诺准点物理删除，重启先清理再展示；不承诺底层存储安全擦除。

单条序列化记录上限 64 KiB；本功能命名空间最多 100 条、序列化值估算总量 512 KiB，包含 ready
时间字段的少量余量。仅在副本操作和生命周期事件统计，不在每次输入或渲染时全量扫描。
先清理过期副本，仍超限或写入失败就放弃新副本，不提前淘汰有效副本，不删除普通草稿。
两者仍共享 origin 存储配额，独立命名空间不提供草稿配额预留。

多窗口逐条写入并监听 storage；重复删除同一 key 按幂等操作处理。localStorage 不提供跨窗口锁／事务，
因此容量是最佳努力上限，也不承诺任意并发下删除与迟到回执的严格线性一致性。不得为此引入全局主进程调度。
显式删除 Thread 时清理该 scope 下对应副本。旧撤回没有副本，不提供入口或迁移恢复。

## 输入框交互

- 有效副本在撤回提示旁显示蓝色“重新编辑”，普通与 hover 均无下划线。
- 输入为空直接回填；有当前文字、历史预览背后的草稿或现有草稿资源时，先确认替换文字。取消保留原状。
- 成功回填只替换文字，现有附件、引用和回复元数据不受影响；副本自身不恢复这些资源。
- 回填结束当前历史预览，将文字交给普通草稿机制，光标置于末尾；到期不删除已回填的草稿。
- 撤回动作及副本到期本身不强制结束 ↑↓ 历史预览，不把副本接入历史数据源。
  本轮固定内容仍按 [Input History v1](input-history-v1.md) 处理，下一轮从最新消息提取。

存储与撤回适配的风险验证由 `message-reedit.test.ts` 拥有；真实组件、确认跨期、默认／显式 @、
历史导航和实际同源多窗口由 `pnpm test:message-reedit-ui` 验证。
