---
document_type: protocol-contract
contract: thread-reference-v1
status: accepted
version: 1
source_version: v1.72
last_updated: 2026-10-23
---

# Thread Reference v1

公开 Thread Composer 可以显式选择另一公开对话或使命作为参考。引用不计算接收者、不邀请来源成员、
不触发执行、不自动展开历史；普通文本、链接和来源正文不会被升级成引用。

## 内容权威

ComposerDocument 继续使用 version 2，新增两种 Atom：

```ts
type ReferenceAtom =
  | { type: 'thread_reference'; threadId: string; labelFallback?: string }
  | { type: 'mission_reference'; missionId: string; labelFallback?: string }
```

Atom 是封闭类型，不能包含 `titleAtSend`、来源正文或其他字段。身份分别采用 canonical `rvcamp_` ID、
`rvm_` 加 UUIDv7 的 32 位小写十六进制 ID；显示标签不能重绑身份。本机草稿、失败回填、输入历史与
Composer 自有剪贴板保留 Atom。labelFallback 最多 500 个 Unicode scalar，首尾无空白；
保留来源允许的内部换行等字符，避免合法使命标题使草稿无法恢复。
不增加 V3、草稿迁移或 Context serializer 兼容分支。

首次发送由 Core 在既有发送事务内转换为：

```ts
type PublishedReference =
  | { kind: 'thread_reference'; threadId: string; titleAtSend: string }
  | { kind: 'mission_reference'; missionId: string; titleAtSend: string }
```

唯一发布权威为消息的 structured_content_json。首次发布重读当前真实标题，一条消息内相同目标只解析一次。
客户端标签、历史回填标题与临时转换结果不具有发布权威。重新编辑后发送是新操作，重新捕获标题。
捕获后重新校验正式内容与大小，超限以 `camp_message.invalid_content` 拒绝且回放原拒绝，不提交消息或 Delivery。
Thread 目标必须为存续、Active、未进入删除且非使命所属的公开对话；Mission 目标必须仍存续且所属
公开 Thread 未进入删除。两类均禁止引用当前 Thread 或其使命，不接受 Single Chat、Conversation、Native Session、Run 或跨 Host ID。

任何无效目标拒绝整条消息，`reference_unavailable` 的现有结果 envelope 包含 message、segmentIndex、kind、id。
结构/ID 非法由严格入站校验拒绝。仅引用、成员及空白且无本轮文本/附件时使用 `camp_message.empty_body`。
成功或拒绝 commandId 的回放在校验、标题读取之前完成，不因来源变化改变既有回执。
Active 邀请沿用独立先加入命令；Pending 首发邀请、激活、发布和 Delivery 同一事务回滚。

## 用户目录

Desktop 与已认证 Web 使用同一 Core 只读入口，不建立 AgentRun：

- `threadReferences.list({threadId, kind: 'thread'|'mission', query?, cursor?})` 返回 `{items, nextCursor}`。
  每页最多 8 条；按当前导航活动时间倒序、稳定 ID 升序。查询与标题统一 NFKC 后做 Unicode 默认小写转换，再按顺序字符模糊匹配；
  查询忽略 Unicode White_Space 与 BOM，大小写转换不依赖系统语言；
  `%`、`_` 是字面搜索字符。游标绑定当前 Thread、类型、查询和最后排序键，不使用 OFFSET 或总数扫描。
- `threadReferences.resolve({threadId, references:[{kind,id}]})` 最多 128 项，按输入顺序返回候选或 null。
  不可读、删除、错误类型和缺失目标统一为 null。
- 候选为 `{kind,id,title,projectBindingKind,projectPath}`，不包含历史正文。

用户目录是 live 读取，且排除当前 Thread。搜索范围为完整目录，和前端已经加载的页数无关。
既有 Agent `thread.list`、read/search 的权限与时间边界不变。

草稿可用性只因目标改名、删除、使命内容更新或重新同步而刷新，不订阅运行输出等无关变化。
Desktop 按现有目录事件筛选，已知 Thread ID 时忽略无关目标；使命更新事件没有目标 ID 时刷新使命引用。
Web 的现有授权失效通知增加可选 `referencesChanged: true`，只传递失效标记，不暴露原始事件或正文；
`resync` 继续覆盖重连和丢失事件。刷新合并为单个 150ms 定时任务，已有截止时间不被延后；
读取期间最多登记一次后续刷新，传输失败保留既有可用性，不把失败当成来源删除。

## 正文投影与清理

共用正文 projector 将每个引用位置输出为 `[转义标题](rovai://thread/<id>)` 或
`[转义标题](rovai://mission/<id>)`。标题中的 ASCII Markdown 标点使用反斜线转义，
空白与控制字符在正文标签中投影为空格；结构化字段仍保留真实标题。
模型正文、Steer、历史读取、复制文本均使用已发布标题；不增加 RUN_INPUT 字段、references 数组或独立上下文块。
用户消息选文按结构化类型投影：普通 Text 保留字面 Markdown，引用段使用可见的 `titleAtSend`，
不把定位链接或转义包装带入新选文。前端标量位置与 Core 校验使用相同投影，`bodyAtSelection`
继续校验原始消息正文；已有 quote 快照不重算，模型正文和 Context 格式不变。
现有预算计算对实际投影字节计费。定位链接不代表模型已读取来源，也不是系统级 URI 协议注册。

来源是弱引用：改名/删除不会级联改写 owner 消息或使已发布输入不能 claim；来源内容继续通过既有读取操作
按调用时规则获取。已冻结最终输入保持原字节，引用不提供发送时历史快照。owner 消息撤回/删除仍由既有清理
规则擦除正文与结构化段。无新增表、强外键、全库扫描、摘要或来源副本。
