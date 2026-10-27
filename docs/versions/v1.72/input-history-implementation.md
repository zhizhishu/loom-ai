---
document_type: implementation-plan
version: v1.72
authority: version-implementation-and-acceptance
status: implemented
last_updated: 2026-10-21
---

# 输入框上下键历史

User 于 2026-10-21 确认并授权在 `ddd445673e2b12e78dde5383df96f28e4f748391` 的交互实现上简化：
首次 ↑ 从现有消息提取本轮固定内容，退出即释放；删除历史专用查询、分页和跨会话缓存。
当前行为由 [Input History v1](../../contracts/input-history-v1.md) 拥有。

Worktree：`/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-input-history`；
分支：`rovai/input-history`；分支起点：`ce8351dad894a643ce9eabb8fc540385ac8c8d9b`。
完成后提交推送该分支；不自动创建 PR。

## 实现边界

- 公共输入从 `visibleThreadMessages` 提取独立 `ComposerDocument`，复用消息模块的顺序与去重。
  先过滤不可编辑片段；原结构化内容过滤为空不能通过 body 复活引用。
- 单聊从当前快照依次提取正式 User 消息和活动 Pending 的正文，反向浏览；不追加查询、排序或身份映射。
- `InputHistoryNavigation` 只持有本轮内容数组、下标、原草稿/选区；操作同步，普通刷新不重建。
- Public Lexical / Single Chat textarea adapter 通过最新的同步回调提供数据。切换目标、显式替换草稿、
  编辑与发送结束浏览，普通消息更新保持当前内容。等于原稿的显式替换也主动 reset。
- 原 `ComposerDraftSync`、有效输入与发送捕获继续复用；单聊显式修改引用时也接管当前预览。
- Core 查询模块、Desktop/Web 路由、协议类型、缓存激活/LRU/裁剪、回执 record 与异步读取均退出。

历史覆盖和新提交出现时间跟随现有消息；不改变聊天加载范围、队列、发送和草稿存储。
没有数据库 schema 迁移、模型上下文、Built-in CLI、Skill、Runtime 或发布版本变化。
旧方案尚未提交的分页/索引修复已移出本次改动，不带入 migration 或无关测试夹具调整。
本项为可逆的局部交互和读取来源调整，未新增 Version Decision。

## 验证归属

| Owner | 当前覆盖 |
| --- | --- |
| `input-history.test.ts` | 当前 User 筛选、原文/Atom 独立快照、引用过滤、相同正文保留、空列表、固定轮次、边界、pending 发布/取消、下一轮更新及退出 |
| `composer-draft-sync.test.ts` | 预览驱动接收者；自动保存/leave flush 保留原稿；编辑/发送接管 |
| CampOpen Electron fixture | 空列表不接管、原生键盘优先级、结构化预览、零消息加载、固定轮次/下一轮更新、Undo/Redo、重挂载与显示/发送一致 |
| Single Chat Electron fixture | Pending 排序与发布、等于原稿的显式替换、引用变更接管、Esc 不关闭、停止/发送切换、原稿恢复与编辑 |

退役两个 Rust owner：`public_input_history_pages_only_recallable_current_user_submissions`、
`single_input_history_keeps_pending_identity_across_publication_and_cancellation`。
其专用 SQL / keyset / pending 身份映射合同与生产模块在同一变更中删除，没有关闭仍在使用的消息或迁移测试。
回填内容筛选移交前端纯函数 owner；消息查询、发送事务、队列和草稿存储继续由原测试拥有。
原前端 9 项缓存/异步导航测试改为 7 项内容/同步导航测试；保存器 11 项测试继续保留。

最小命令：

```sh
pnpm exec vitest run apps/desktop/src/renderer/src/input-history.test.ts apps/desktop/src/renderer/src/composer-draft-sync.test.ts
node --test --test-concurrency=1 --test-name-pattern='input history' scripts/lib/camp-open-projection.test.mjs scripts/lib/single-chat-panel.test.mjs
```

## 验证结果

| 命令/范围 | 结果 |
| --- | --- |
| 历史/草稿定向 Vitest | 18 项通过（历史 7、保存器 11） |
| `pnpm test` | 247 个 Vitest 文件、2,812 项通过；Node 357 passed、2 个平台限定 skip；文档 10、Skill 3、sandbox 7 项通过 |
| `cargo test --workspace` | 474 passed、1 个既有 ignored；删除专用 SQL 后 Core/CLI/Host/Web 默认回归通过 |
| `cargo test -p rovai-web` | 最终删除 Web operation 后 11 项通过 |
| 公共/单聊输入历史 Electron | 两个生产组件场景通过；单聊包含同文替换与引用接管回归 |
| `pnpm typecheck`、`pnpm build:desktop` | 通过，构建包含 Web 与共享 Renderer |
| `cargo fmt --all -- --check`、`git diff --check` | 通过 |
| `DOCS_BASE_REF=ddd445673e2b12e78dde5383df96f28e4f748391 pnpm docs:check:ci` | 通过 |

Rust 两个查询测试及前端缓存测试的数量变化来自上述合同退役；未用旧方案的分页/索引测试结果替代当前验收。
Electron 使用脚本生成的独立绝对 userData；这些输入历史夹具不启动 Core、SQLite、Skill Library 或模型。
没有启动日常 App、写入日常数据库或执行真实 Runtime。

## 预览中撤销/重做修正

在 `d8a39c3087af40c205f479d08d16824ead61d9fa` 上复现：公共输入从草稿 A 改为 B，进入历史预览、
仅移动光标后直接 Undo / Redo，Redo 会恢复历史正文；单聊 Esc 恢复未变化的原稿会额外写一次 editing recovery。
修复前新增的两个生产组件回归场景均失败，分别命中上述结果。

- 公共插件消费预览中的 Undo / Redo，结束本轮并恢复原 EditorState；通过 Lexical `$onUpdate`
  在恢复提交完成后转交同一命令，沿用已有撤销栈。未浏览时直接放行，不增加历史或恢复状态。
- 单聊仅在当前草稿正文不同于快照时调用 `setDraft`；选区与预览清理保持原流程。
- CampOpen fixture 增加预览中直接 Undo / Redo、反向操作及空 Redo 栈覆盖；Single Chat fixture
  验证 Esc / ↓ 越过最新条目不增加 recovery 写入。

修复后两个输入历史 Electron 场景、18 项历史/保存器 Vitest、`pnpm typecheck` 均通过。
本次验证沿用隔离 Renderer fixture，不启动 Core 或 Runtime。
