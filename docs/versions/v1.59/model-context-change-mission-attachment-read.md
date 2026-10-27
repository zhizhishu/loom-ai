---
document_type: model-context-change
version: v1.59
change_id: mission-attachment-read
revision: 1
confirmation_status: confirmed
confirmed_by: local_user
confirmed_at: 2026-09-17T08:04:01+00:00
confirmed_revision: 1
authority: confirmed-model-input-change-statement
implementation_baseline: 717f198794d7514c022e6fad133bd63729cbf7d0
implementation_status: implemented
last_updated: 2026-09-17
---

# Mission 附件读取投影（revision 1）

本说明解决 Mission 定义已经保存、编辑并以 `details_version` 触发更新提醒，但当前 Agent 的
`mission get` 无法发现现行附件的问题。它只扩展当前公开 Mission Camp 中已认证 Agent 的显式读取结果；
不会把附件路径自动注入每轮上下文，也不会改变 Desktop/Web 的无路径展示投影。

## 变更前

Agent 执行：

```text
rovai mission get
```

输入为闭合空对象 `{}`，成功输出的完整形状为：

```ts
type MissionInfoBefore = {
  missionId: string
  title: string
  description: string
  status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
  sourceMessageId: string | null
}
```

Mission 数据库记录另有有序的 `source_attachments`，Desktop `missions.list|get` 只取得无路径
`LocalAttachmentSourceView[]` 元数据。`mission get` 当前直接序列化 `mission.info`，因此不读取
`source_attachments`，也不返回附件路径。附件编辑会推进内部 `details_version`，下一轮可以出现既有
`RUN_FACTS.mission.updateNotice`，但 Agent 调用 `mission get` 后仍只能看到上面的五个字段。

## 变更后

`mission get` 输入仍是 `{}`。成功输出完整形状改为：

```ts
type MissionInfoAfter = {
  missionId: string
  title: string
  description: string
  status: 'needs_you' | 'not_started' | 'in_progress' | 'completed'
  sourceMessageId: string | null
  attachments: string[]
}
```

`attachments` 的精确语义如下：

- 字段始终存在；当前 Mission 没有附件时返回 `[]`。
- 每一项是当前 Mission source attachment 保存的原始绝对 `sourcePath`；文件和目录都使用同一种字符串。
- 顺序与当前 Mission 定义中的附件顺序一致。删除附件后该路径不再返回；新增附件在成功提交后出现。
- 不展开目录，不返回子文件，不复制或移动原文件，不把路径改写成 workspace、附件输出目录或展示名。
- 读取不执行 `stat`、目录枚举或可用性探测。原文件随后移动、删除、改类型或失去权限时，仍返回已保存的
  原始路径；实际读取失败由 Agent 当前文件能力如实报告。
- 不同时返回附件 ID、显示名、类型、大小、可用性或 `detailsVersion`。需要这些展示字段的用户界面继续读取
  无路径 `LocalAttachmentSourceView[]`。

Core 新建独立的 Agent 读取投影（例如 `MissionAgentInfo`），由当前 Mission record 的 `info` 与
`source_attachments[].source_path` 组成。不得向共享 `MissionInfo` 或 `LocalAttachmentSourceView` 塞入路径，
以免 Desktop/Web `missions.get`、Renderer 日志或普通用户投影意外获得 raw path。

## 授权与隐私边界

现有授权不变：调用者必须是当前 AgentRun、当前公开 Camp 的 active member，且该 Camp 必须关联 Mission。
接口仍不接受 `missionId`、`campId`、路径或版本输入，不能枚举其他 Mission。Single Chat、普通 Camp、已移除
成员与过期执行继续拒绝。返回路径只来自当前 Mission 已提交的 source refs，不从消息、历史、工作区或文件系统
推断新路径。

这是一次有意的路径披露扩展：Mission v1 中“raw paths remain Core-private”的旧结论被 Mission v2 对
`mission get` 这一条受认证 Agent seam 局部替代。Renderer、Web API、活动历史、领域事件、日志、错误和
命令回执仍不得携带这些路径。

## 明确不变的模型输入

- Native Session Bootstrap、Session Charter 正文与版本不变。
- Dynamic Context section 顺序、`RUN_FACTS`、`WORKSPACE`、`CURRENT_INPUT`、历史选择和预算不变。
- `RUN_FACTS.mission` 仍只有 `missionId`、`title`、`status` 和条件 `updateNotice`；不新增附件字段。
- 既有 `updateNotice` 文本与 accepted-delivery 消除条件不变；`mission get` 仍是纯读取，不确认或清除提醒。
- `details_version` 继续由标题、描述和源附件集合的有效编辑推进；不进入 Agent 输入、输出或错误。
- Mission 开始时发布到委托消息的附件、普通消息附件、Agent 输出目录和 `CURRENT_INPUT.attachments` 均不改变。
- `mission update` 仍不能增删附件；Agent 只读取用户已提交的当前 Mission 附件。

## 版本、兼容与恢复

| 版本轴 | 变更后 | 原因 |
| --- | --- | --- |
| Mission contract | v2 | 局部替代 v1 的 raw-path 私有结论，限定到 authenticated `mission get` |
| Built-in Tool Contract／CLI Command | 27／27 | `mission.get` closed result schema 与 catalog digest 改变 |
| Runtime capability | `builtin_cli.transport.v27` | Core 与 bundled CLI 必须原子匹配新 catalog |
| Agent Output／IPC／Envelope／Receipt | 3／2／1／1 | 投影框架、wire envelope 与回执不变，仅一项 canonical result 扩字段 |
| Bootstrap／AgentRun Formatter／Manifest／Delivery Profile | 3／25／25／6 | 动态上下文字节、选择与证据不变 |
| Database schema | 111（不变） | 路径已在 Mission source refs 中持久化，无迁移 |

旧 Core/CLI 组合保持 v26；新 Core/CLI 组合只广告 v27，不提供 v26 Core 配 v27 CLI 的混合模式。
冻结的历史 Runtime Input、ContextManifest 与已接受 Delivery 不重写。升级后第一次显式 `mission get` 即读取
当前记录；回滚到 v26 只会恢复五字段结果，不修改 Mission 附件数据。

## 验证

1. 扩展既有 Mission built-in 调用 owner：建立同时含文件和目录的 Mission，调用 `mission get`，断言
   `attachments` 始终存在、保持定义顺序且值为原始绝对路径；空 Mission 返回 `[]`。
2. 同一 owner 删除一个附件并新增另一个后再次读取，断言只返回当前集合；源路径消失后读取仍不触发文件系统
   观察，并返回保存的引用路径。
3. 保留现有普通 Camp、Single Chat、离队、伪造 `missionId` 与未知字段拒绝用例，证明没有新增枚举入口。
4. 扩展唯一 catalog/output golden owner，验证 `mission.get` 的 required `attachments.items=string`、v27 digest、
   capability 与 CLI 输出；缺字段、非数组或非字符串项必须被 closed schema 拒绝。
5. 验证 Desktop/Web `missions.get` 仍只有无路径附件元数据，活动、错误、证据和日志中不存在 source path。
6. 运行 Mission smoke、Core 定向测试、bundled CLI 测试、文档门禁；模型可见工具结果按现行双轨评测流程使用
   已冻结 Suite 2.12.0 / scoring 2.10.0 的通用 Case，未知或未运行不计通过。

Rust 测试优先扩展既有 Mission 调用与 catalog/output golden owner，不为同一字段另建平行数据库 fixture。

## 二次确认记录

开发者 `local_user` 在阅读完整 revision 1 后，于 2026-09-17T08:04:01.351872+00:00 通过 Camp
`rvcamp_01m2nabz5gfd0s6ppnsp9gy3s8` 的消息 `a10d54f9-5bd5-4f0d-a112-137d2fe62a8b`
要求“完成后pr到main merge”，明确授权继续完成本 revision 的实现、PR 与 main 合并。此前原始缺陷描述与
提案起草不计作二次确认；本条发生在完整变更说明交付之后，是 revision 1 的实施确认。

## 实施记录

- Core 新增独立 `MissionAgentInfo` 投影，`mission get` 始终返回按 Mission 当前定义排序的
  `attachments: string[]`；读取不访问文件系统，删除源文件后仍返回已保存路径。
- `mission.get` 的 catalog、closed result schema、golden 与 bundled transport 同步升级到 27；共享 Renderer
  Mission 投影、证据投影与动态上下文继续排除 raw path。
- Mission 新建／编辑器和 Mission 会话卡片复用会话输入框的附件卡片与可访问横向导航；目录显示为 `DIR`，
  隐藏滚动条，并支持 `ArrowLeft`、`ArrowRight`、`Home`、`End`。
- 数据库结构不变；实现覆盖空集合、文件与目录顺序、增删、源文件消失、closed schema、隐私边界与 UI
  交互，并通过 Rust、TypeScript、Renderer、文档与构建门禁。
