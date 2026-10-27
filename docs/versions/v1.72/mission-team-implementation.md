---
document_type: implementation-plan
version: v1.72
status: implemented
last_updated: 2026-10-26
---

# Mission 接入 Team

User 在 Thread `rvcamp_01m579sezwfgsrrvsmhq203n8e` sequence 81 要求核对 Mission 覆盖；公开答复
`1bdb76ec-c61d-4aa7-bf28-985c9b1446f7` 明确复用 Team/Custom 默认值、创建时冻结指引、保留描述邀请。
sequence 83–89 完成默认主题 V2 交互与长指引示例，sequence 90
`6aedae9a-a035-4af8-91b0-b51d71de6772` 授权 worktree 实施、PR 与合入 main。

- Base: `31b761e3a887f5902a5e61f3913c0b21d9eb55a2` (`origin/main`).
- Branch: `rovai/mission-team`.
- Worktree: `/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-mission-team`.
- Status: ready；全部实现、构建与测试在本 worktree；不安装或重启日常 App。

## 范围与边界

新使命读取 General 的 Team/Custom 来源，保留独立 Custom 草稿；Team 名册与队长只读。
队伍选择器去掉全局 one-click 勾选；General 与普通新对话现有设置行为不变。
指引默认折叠，展开最多五行，真实溢出才出现全文入口；同一浮层提供只读单滚动正文、返回和 Escape。
布局复用既有 Mission writing plane、语义主题 Token、头像、Popover 和中英文目录，窄屏保持触控尺寸。

`MissionCreate.team?` 原样穿过 BusinessApp、普通 RPC 与附件入口。Core 复用 Thread 事务解析 Team、
校验 expectedVersion、合并描述中不同的成员 ID，再原子写入 Mission/Thread/启动材料。不存在新增 Team
同步协议、关联表、缓存或运行进程；创建后仍由 Thread 拥有实际成员与 Lead。

这是已确认 [Team 指引 R1](model-context-change-team-guidance.md) 的创建入口补齐。模型消费仍严格遵循
[Bootstrap v6](../../contracts/native-session-bootstrap-v6.md)：同一 Thread 冻结文本产生同一段
`[TEAM_GUIDANCE]`，位置在本人身份之后；空值省略、后加入成员读取会话副本、后续轮次不追加。
不修改 formatter、claim、动态上下文、恢复、预算或版本轴。旧 Mission 不补指引，旧回执与绑定不重写。
原完整上下文 Gate 仍按 [Team 记录](team-management-implementation.md) 保持 `degraded`；
本次组件与事务测试不代替真实模型 Gate，也不把合并等同于该 Gate 通过。

## 权威影响

| 范围 | 处理 |
| --- | --- |
| Architecture | Team 与 Mission 继续分工，补充创建入口复用 |
| Contract | 新增 Mission v13 / Team Templates v2；旧版本语义冻结 |
| UI | Mission Team/Custom、只读长文、移除使命内全局偏好写入 |
| 数据 | 无新表或迁移，复用当前不可变 Thread 启动材料 |
| 上下文 | 已有 Team Bootstrap 合同与所有版本轴保持 |
| Runtime | 无新启动、唤醒、命令或模型参数 |
| Skills / 工具 | Agent 工具不增加 Team/Mission 创建入口 |
| 兼容 / 恢复 | 省略空 Team 保持旧摘要；未知结果恢复原快照和命令 ID |
| 发布 / 治理 | 不改发布版本；既有 seam 的局部扩展，无新增长期取舍，不增加 Version Decision |

## 验证归属

扩展现有 Rust owner `description_members_commit_together_preserve_identity_and_never_schedule`，不增加
独立 Rust 测试函数。原输入的 Team 字段会被拒收；新用例证明 Team 的权威名册/Lead、描述去重邀请、
空指引、省略 Team、版本冲突、删除与同命令回放。Mission 插入失败同时回滚 Thread 和 Bootstrap；
因此复用该 owner 的隔离 SQLite fixture，纯函数不能证明事务边界。Bootstrap formatter/晚加入由既有
Team/context owner 保持，不复制一份黄金正文。

生产 React/Electron 复用 `mission-board` fixture 的真实 BusinessApp/NewConversationDialog 与内存 adapter：
用可控 Promise 安排列表晚于草稿、用户改选 Custom 早于列表完成；覆盖六人只读名册、Custom 往返、
长/短指引、键盘滚动/Escape、版本冲突修复、未知结果精确重试、失败列表独立 Custom 和零全局偏好写入。
此为自动验收通道，临时 userData，无 Core/SQLite/Skill Library/真实 Runtime；Core 原子性由上述 Rust owner 证明。

最小命令：

```sh
cargo test -p rovai-core --features extended-tests --lib description_members_commit_together_preserve_identity_and_never_schedule
node --test --test-name-pattern='saved Teams' scripts/lib/mission-board.test.mjs
```

## 本地验证（2026-10-26）

- `pnpm test:rust:pr`：477 passed、1 existing ignored；`cargo fmt --all --check` 通过。
- 上述 Mission 扩展 owner 与既有 `templates_preserve_custom_defaults_and_freeze_thread_guidance` 各通过。
- `pnpm typecheck`、`pnpm build:desktop`（含 Web/Execution Web）、文档普通及实际 base 的差异门禁通过。
- 全部 package `test` 子命令通过：Vitest 256 文件、3005 passed / 2 skipped；末尾 Node 378 passed / 2 平台跳过。
  初次默认并发出现 evaluation-host/file-preview 三项异步超时；64 项隔离重查通过，完整命令仅将
  `vitest run` 的 worker 数限制为 2 后通过，未改实现、测试期限或期望。跳过项不算通过。
- Mission 的 11 个 Electron 场景全部获得通过结果：初次标准场景仍断言旧版无箭头/人数节点，
  按已批准 V2 更新到 Team 入口与 checked roster 后重跑通过，其余原场景保留。新增 Team 场景再次
  验证五种配色中 Portal checkbox 的实际计算色、英文现场切换和 390×844 阅读区；没有宣称真实手机 OS 验收。
- 原 Team 创建生产回归通过 23 个既有场景，保留保存回执、晚到列表、独立 Custom、刷新/失效与长度上限保护。
- 验证使用临时 Electron userData；未启动真实 Runtime、未安装 App、未写日常数据。

截图与完整本地日志保留到当前 Thread 附件目录；PR/merge 与 worktree 清理结果在 Thread 收口报告记录。
完整上下文 Gate 保持此前 `degraded`，本轮没有重跑真实模型或改记为通过。
