---
document_type: model-context-change
version: v1.72
change_id: message-senders
revision: 2
confirmation_status: confirmed
confirmed_revision: 2
confirmed_by: User
confirmed_at: 2026-10-14
confirmation_message_id: 728a1602-fe39-4a19-b835-2344b1676f77
authority: proposed-model-input-change-statement
implementation_status: implemented
review_baseline: 41c8ca19238de8465c23ff0c030f5c7620dd2c02
last_updated: 2026-10-14
---

# 消息发送者统一：R2

本说明记录 User 已给出的完整方案、逐次澄清和最终实施授权。方案消息为
`12bdc05b-e18e-4280-9b7f-823b2a293a10`；User 随后放宽升级期间未执行、未领取的中间态兼容，
并确认 system 的模型 ID 固定为 `system`。在解释 Mission start 实际属于 User 消息后，
User 于 `f73896ee-7023-4548-97a4-42d2f0ca86a7` 要求“可以，那就开启wt执行”。R1 完成后，
User 在本 revision 的确认消息中明确要求删除专用名称冻结、只在实际消息组装时查询当前名称。
R2 按这份具体修订执行，不额外请求同一事项的确认。

## 变更前

公开 `RUN_INPUT.messages[]` 和 `SHARED_THREAD` 普通消息使用原始
`senderType`、`senderId`，没有发送者名称。读取、Thread 搜索和 History 搜索使用原始
`authorType`、`authorId`。原始本地用户为 `user/local_user`，渠道 Owner 为
`external_principal/<内部主体 ID>`；系统消息可能以 Automation Run ID 标识来源。

```json
{"senderType":"agent","senderId":"agent_6","body":"请验证。","mentions":[{"id":"agent_8","name":"药师寺惠"}]}
```

R1 另为非 batch 在领取时扫描历史作者，并写入专用名称快照。R2 删除这条名称处理路径；
以下字段结构与 R1 相同，只调整名称查询时机，原有完整输入保存和回放不变。

## 变更后

上述所有入口复用同一个发送者投影。以下展示完整的发送者字段集合，其余原字段保持：

```json
{"senderType":"agent","senderId":"agent_6","senderName":"爱丽丝"}
{"senderType":"agent","senderId":"agent_6","senderName":null}
{"senderType":"user","senderId":"user"}
{"senderType":"system","senderId":"system","senderName":null}
```

Agent 名称来自原作者 ID 对应的保留 Profile，不按当前在队状态过滤；缺失或空名称为 null。
系统只有既有可靠名称才输出该名称，目前没有该来源时为 null；不从 Automation ID 猜测名称。
User 不输出 senderName。模型 user/system 不是内部主体，不能反向用于认证、寻址或外发。
正常消息必含 senderType、senderId；新读取、搜索不再输出 authorType/authorId。
名称表示本次投影时的显示名，不代表发送时名称。

组装实际需要的 input、SHARED_THREAD、read/search 结果时，只查询这些消息中 Agent 的当前名称；
同一批次复用查询结果，缺失为 null。公开 batch 在原有输入组装阶段取名，完整 RUN_INPUT 仍存入
原快照，预算与最终渲染使用同一值。非 batch 领取不为名称扫描历史或查询 Profile；SHARED_THREAD
在原消息选择之后解析作者名称。实时读取/搜索在本次读取事务解析。已有输入、上下文和工具回执
继续按原机制保存及回放，不为改名新增存储、状态或恢复分支。

## 明确不变

消息正文、snippets、附件、引用及引用作者、mentions、时间、分页、可见性与选择算法保持。
撤回占位不增加发送者；CURRENT_INPUT.source、私聊专用消息结构不改。
数据库 author_type/author_id、渠道 Owner 准入、平台身份映射、回复目标、Mission start 的
User 作者事实、发送入参及回执保持。无新增提示词、Session 升级、Binding 轮换或强制压缩。

新增字段按现有真实序列化字节预算和整体摘要计入；容量边界可能容纳更少完整消息，FIFO 算法不改。

## 版本与恢复

仅调整现有 Formatter/Manifest 与 Agent Tool Output 版本轴，运输协议、Bootstrap、Charter
及所有 Runtime 的 Binding compatibility 输入保持。旧冻结输入、Manifest、成功工具回执按原结构、
字节和摘要恢复；历史 read 的 addressing 版及 mentions 版、历史搜索 author 字段版都保留严格回放校验。
新 Run 和新工具调用立即采用新格式，不以 Session 创建时间分流。未执行中间态不建立额外迁移框架。
具体版本与加性数据库约束迁移在实施记录填写，不新增名称表或第二套摘要系统。

## 验证

扩展既有 Context、claim、History、Tool Output 与迁移 owner，使用隔离 SQLite 和 Skill 目录：

- 同一消息在输入、读取、搜索中字段一致；本地/渠道用户均为 user/user，无名称与内部外部主体 ID。
- Agent 同名、改名、离队、缺失名称；同批查询复用，后续投影取当前名称，已保存输入回放不漂移。
- 作者、Mention 与引用作者分别保留自己的语义；系统与 Mission start 正确区分。
- 旧输入与成功回执恢复，闭合 schema 拒绝混合字段，空结果及撤回占位不变。
- 实际字节容量边界、完整摘要、原生绑定兼容值保持；渠道内部作者/授权/投递不变。

通用模型 Gate 按现有 DEMO-101–112 和固定 Judge 条件记录执行状态；自动化 fixture 不冒充真实模型结果。

## 二次确认

R1 的确认消息 `f73896ee-7023-4548-97a4-42d2f0ca86a7` 在完整字段方案、升级中间态简化、system 固定 ID
和 Mission start 作者解释后明确授权实施。R2 的确认消息 `728a1602-fe39-4a19-b835-2344b1676f77`
在 R1 交付结果之后直接要求简化名称处理，并明确删除专用快照、按需查询、同批复用及保持原保存/回放。
本 revision 精确落实该修订，不扩大到 Session 协议重建。

## 实施记录

Worktree：`/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-message-senders`。
Branch：`rovai/message-senders`。Base：Front Matter 中的 main SHA。Governance：none。
Status：ready。R1 已提交并推送；R2 在同一 worktree 完成名称处理简化及回归，提交后同步原分支。按现有 User 偏好不自动创建 PR。
未合入前保留本 worktree。

### 版本与实现

public Formatter/Manifest 38，非 batch 37；Profile 13/12 与 Run Facts 9/6 保持。
Agent Output 12；Transport/CLI 39、IPC 3、Envelope 2、Bootstrap/Charter/Binding compatibility 保持。
Migration 199 将 schema 148 升到 149，仅扩展现有格式约束；不改写历史输入、工具回执或内部作者。
R2 移除非 batch 的领取名称扫描、专用快照读写和对应恢复判断；只保留请求内的名称查询缓存。
字段与原完整输入保存机制未变，沿用以上版本及 Migration，不新增迁移或存储。

### R1 验证结果

日志、命令与摘要见 [验证索引](message-senders-verification.json)，各次本地失败和修正后日志均保留。
所有数据库/Skill 测试均为隔离 fixture；未启动或替换日常 App。

| 检查 | 结果 |
| --- | --- |
| 默认 Rust workspace | 471 passed，1 项既有手工 smoke ignored，0 failed |
| Context / FIFO claim | 45 / 26 passed；32、33、36、38 输入及改名后冻结字节/摘要；当时的 SHARED_THREAD 领取名称语义由 R2 替换 |
| History / Tool Output / Schema | 7 / 8 / 9 passed；各入口映射、缺名、撤回、混合字段拒绝与两代旧 read、旧 search 回放 |
| Adapter / Channel | 25 / 38 passed；共享兼容值及 Antigravity 原 digest 输入、Owner 准入、原始作者和附件路径保持 |
| Migration | 1 passed；现有 owner 扩展至 199，rollback、完整历史证据和 claim JSON 保留 |
| Rust 编译/格式 | cargo check --workspace、cargo fmt --all --check 通过 |
| TypeScript / Vitest / Node | typecheck；243 文件/2668 项 Vitest；360 项 Node 通过、2 项平台跳过 |
| 文档与合同指纹 | 文档测试 10、文档治理及合同指纹测试通过 |
| 完整真实模型 Gate | not_run：本任务未提供固定 Judge 配置，DEMO-101–112 未运行；未声称所有真实 Runtime 已复测 |

### R2 验证结果

本次只改 Rust 名称解析和当前说明，字段、Schema、Migration 与前端保持；原广泛验证保留为 R1 证据。
R2 的命令、日志与摘要追加在同一[验证索引](message-senders-verification.json)的 followUp 中。

| 检查 | 结果 |
| --- | --- |
| 默认 Rust workspace | 471 passed，1 项既有手工 smoke ignored，0 failed |
| Context | 53 passed；领取无名称快照、组包读取当前名称、同批查询复用、缺名 null 及保存后回放字节/摘要保持 |
| FIFO claim | 26 passed；原公开 batch 完整输入快照及实际大小预算保持 |
| History / Tool Output | 7 / 8 passed；按当前名称投影和原成功回执回放保持 |
| 格式与文档 | cargo fmt --all --check、git diff --check、文档测试 10 项与文档治理通过 |

专项数量与默认 Rust 有重叠，不累加为唯一测试数。本次未运行真实 Runtime 或日常 App。

### Rust 测试归属与范围复核

没有新增、删除或禁用独立 Rust test owner；扩展原消息序列化、历史读取、claim 名称、Context 恢复、
单聊输入、渠道附件、工具 Schema/golden、Adapter 兼容及迁移 owner。轻量名称/缺失缓存矩阵留在
原 serializer owner，数据库冻结/恢复由原事务测试承担。旧夹具仍用于旧回执校验，新 v12 fixture
只调整指定工具的模型输出。未改 body、引用作者、mentions、UI 或渠道授权实现。

R2 改写既有单聊组包 owner：领取不创建名称快照；领取后、组包前改名反映在 SHARED_THREAD；
组包保存后再改名，原完整输入及摘要回放保持。原领取名称冻结断言随对应生产机制退出，
没有新增或删除独立 Rust test owner。原 request-local cache owner 继续覆盖名称缺失和同批复用。

已核对影响范围：Architecture、Contract、Context 与文档路由同步；UI、Runtime 准入资格、领域术语、
版本 current 指针和根 README 不变。新名称进入现有预算/摘要，所有 Native Binding 输入仍保持原值。
