---
document_type: model-context-change
version: v1.59
authority: agent-attachment-source-path-context
status: accepted
revision: 2
confirmation_status: confirmed
confirmed_revision: 2
confirmed_by: local_user
confirmed_at: 2026-09-16T02:39:18+00:00
last_updated: 2026-09-16
---

# Agent 附件原路径引用：模型上下文变更说明

## 二次确认

用户在审阅 revision 1 后，亲自提交《附件升级方案的最终调整》，明确否决原样实施，
给出完整替换行为，并补充最终 JSON 字段。本 revision 2 忠实记录该次审阅修订，
确认来源是 Camp `rvcamp_01m2jqdhe8ej0vm1gef3exqkym` 的用户消息
`ccf1040b-6213-4ef4-af9e-dd659d2e8794`（2026-09-16T02:39:18.830160+00:00）。
依据是用户本次对已审阅文档的明确最终决定，不以此前笼统实施授权代替字段确认。

revision 1 从未确认、未实施，现整体撤销其中的复制、tmp → rename、双根上下文、
预分配命令、强制 attachmentId 物理层级、外部 requestId 重试及跨 Camp 独立副本设计。
原有 worktree 实施、验证、PR 与 main 合并授权继续适用。实现语义若偏离本次用户修订，
仍按[上下文治理](../../development/model-context-change-governance.md)重新说明和确认。

## 变更前

代码基线：`243eb748bbb1609039942cccf31dcc8ece0c4c4f`。现有 Run Facts 附件片段完整为：

```ts
type AttachmentFactsBefore = {
  schemaVersion: 2
  campResources: {
    campId: string
    publishedAttachmentRoot: string
    access: 'enumerate_and_read'
    scope: 'current_camp'
    mutability: 'read_only'
  }
}
```

`CURRENT_INPUT.attachments` 已使用 `string[]`。Send 的完整业务输入和 Agent 输出为：

```ts
type SendInput = {
  body?: string
  to?: string[]
  mentionUser?: boolean
  publicOnly?: boolean
  taskId?: string | null
  files?: string[]
}
type SendOutputBefore = {
  messageId: string
  agentAddressingMode: 'automatic' | 'public_only'
  effectiveRecipients: string[]
  deliveryIds: string[]
}
type CampReadAttachmentBefore = {
  attachmentId: string
  name: string
  kind: string
  fileCount: number
  mediaType: string
  byteSize: number
}
```

`files` 的完整原说明：

```text
Optional local file or directory path readable by the active Runtime. Repeat to preserve attachment order. Pass the existing path directly; Rovai privately snapshots paths outside the current AgentRun workspace and ROVAI_RUN_TMP before sending.
```

CLI 对外部来源做 `.send-import` 快照，Core 经 Managed staging/materialization 发布。
新旧附件共用旧 Runtime 根说明；历史读取不返回新 Agent 外部源位置。

## 变更后

### Run Facts 顶层只增加默认输出位置

```ts
type AttachmentFactsAfter = {
  schemaVersion: 3
  attachmentOutputRoot: string
}
```

附件字段的完整替换 JSON 片段：

```json
{
  "attachmentOutputRoot": "/.../attachments/rvcamp_xxx"
}
```

移除整个 `campResources`：不再重复 Camp ID、固定 scope、Published View 读取根或读写权限说明。
不加入 `attachments`、`legacyAttachments`，不查询旧附件以决定上下文是否显示兼容根。
`RUN_FACTS` 其他字段、可选字段条件和 section 顺序保持；附件 fact 的内部 Evidence 名称相应改为
`attachment_output_root`，证明本次投影的路径文字，不证明附件内容。

路径由统一解析入口提供，Host 准备当前 Camp 的目录：

- macOS/Linux Desktop：`~/.rovai/instances/<instanceKey>/attachments/<campId>/`；
- Windows Desktop：`<CoreDataDir>/attachments/<campId>/`；
- Server：`<ServerDataDir>/instances/<instanceKey>/attachments/<campId>/`。

它只表示最终交付文件的默认生成位置，不是附件清单、统一读取根或授权。
沿用原 instanceKey；不强制附件 ID 成为目录层级。Agent 使用普通文件名和子目录组织产物，
发送时登记身份。Runtime 仍使用现有文件访问配置和有效模式；路径不替代原生权限。
路径只在 Run Facts 提供一次，不再注入 Bootstrap 或重复教学。

### Send 原地登记与实际路径返回

`SendInput` 原样保持；不新增命令、参数、外部 requestId、分配或恢复流程。
每次新 `send --file` 都采用实际路径引用，无论来自工作区、Run Temp、永久输出目录、其他位置或其他 Camp。
只检查本次指定对象的路径、类型、存在性和可读性；不全目录扫描、全文摘要、复制、移动、硬链接、
软链接、staging、冻结、chmod、原始大小校验或旧发布准入。

```ts
type SendOutputAfter = SendOutputBefore & {
  attachments?: {
    attachmentId: string
    path: string
  }[]
}
```

有附件时按输入顺序返回 `attachments`，无附件省略；`path` 为实际登记的绝对文件/目录路径。
同 Camp 已登记同一位置可复用身份，不因编辑或替换保存生成新内容身份。跨 Camp 创建目标 Camp 的引用，
不复制物理文件；普通正文链接不登记附件。目录直接保存实际目录位置，内部相对资源关系不变。

新 `files` 完整说明：

```text
Optional local file or directory paths to attach, in order. Pass each actual path directly. Rovai registers a reference without copying, moving, linking or changing permissions. Later reads use the current file at that path. Temporary files may become unavailable when their source is cleaned up.
```

原 `--file` 的交付文件用途保留，撤销禁止显式临时文件的旧文案，与本次原路径规则对齐：

```text
Attach a recipient-facing file or directory at its actual path; repeat to preserve attachment order. Rovai references the current file without copying or changing permissions. Temporary files may become unavailable when their source is cleaned up.
```

需要长期保留的产物由 Agent 直接生成到 Run Facts 的默认输出位置；
不把整个 ROVAI_RUN_TMP 变为永久目录，也不为了显式发送临时文件延长其生命周期。
CLI 的内部请求标识、传输重试、现有命令防重复和未知结果语义保持，不承诺新增跨 CLI 调用精确重放。
发布失败或重放失败均不能删除源文件。

### 历史、当前输入与预览

`CURRENT_INPUT.attachments: string[]` 保持，由已授权记录解析具体实际位置，Agent 可直接读取。
所有新 Agent 附件，包括工作区、外部源和临时路径引用，均可通过历史记录取得实际路径：

```ts
type CampReadAttachmentAfter = {
  attachmentId: string
  name: string
  kind: string
  fileCount: number | null
  mediaType: string | null
  byteSize: number | null
  path?: string
}
```

已解析位置时返回 path；未知的观察统计为 null。元数据读取不额外访问全文、遍历 Camp 或校验首次内容。
用户 Source Ref 的原行为不变。新 Agent 引用与旧记录依据持久记录分流，不猜测路径名称、Camp 年龄或版本。
实际读取历史旧记录时才进入旧定位、内容规则和必要恢复；不把它们作为新发布或普通 Run 前置。
一个新源文件失效只影响该附件；新 Agent 路径投影不因内容修改拒绝整个 Camp。

Desktop/Web 的缩略图、大图、预览、下载使用当前文件；实际读取位置可展示和复制，
本机可定位，远程只提供适用操作。旧受管目录不因隐藏位置而禁止展示，但保留原权限/读取语义。
目录和 HTML 相对资源按实际源位置解析。列表来自记录，不能通过枚举永久输出目录替代。
缓存沿已有通知与读取版本更新，支持替换保存；切 Camp 复用有效缓存，不加全 Camp 轮询或全文检查。

## 明确不变

- Bootstrap 操作清单、章节、Session Charter revision、成员身份和权限权威保持；不增加附件系统教学。
- 用户正文、quotes、Mention、调度、Task/Gather/A2A、History 选择预算和截断保持。
- Source Ref 原文件位置、弱持久性与用户输入流程保持；外部文件不因附件登记被接管。
- 操作/Context 的现有摘要继续证明命令和投递，不用于约束新附件未来内容。
- 内容变化不触发 Bootstrap 或原生会话重建。仅实际文件访问配置/输入合同变更沿用既有会话兼容判断。
- 已冻结的旧输入与 Evidence 保持原文，旧附件文件、权限、历史引用原位保留。

## 版本与恢复

| 轴 | 基线 | 本次计划 |
| --- | --- | --- |
| Run Facts schema | 2 | 3，移除 campResources、加入顶层输出位置 |
| AgentRun Formatter / ContextManifest | 23 / 23 | 24 / 24，投影及对应 Evidence 变化 |
| Delivery Profile | 5 | 5，预算选择不变 |
| Native Bootstrap / Formatter | v3 / 3 | v3 / 3 |
| Session Charter revision | 6 | 6，撤销 revision 1 的命令清单变更 |
| Built-in Tool Contract / CLI | 24 | 25，仅实际 send/history 输出及 files 说明变化 |
| Agent Output Projection | 2 | 3，仅附件位置返回 |
| IPC / Envelope | 2 / 1 | 2 / 1 |

版本号如被其他已合入工作占用，按实际新基线顺延并记录；不能借版本顺延改变已确认语义。
数据调整仅服务实际路径引用、身份与关联以及既有删除重试，不增加内容资产库、发布事务框架或外部请求系统。
新发布复用既有命令原子性，不存在文件复制落位与消息提交的两阶段窗口。

删除 Camp 清理它实际拥有的永久输出目录（包括未发布/已编辑文件）及旧自有附件。
不得遍历 sourcePath 删除所有被引用文件。外部源仅移除引用；跨 Camp 同文件不保活、不转移所有权、
不自动复制或计数。所属 Camp 删除后其他 Camp 引用可失效，这是已接受语义。
Run 结束、预览/LRU 回收不删除永久输出；Run Temp 原清理规则继续。
既有生命周期停止在途工作、释放占用，再清理精确目录；失败持久记录并重试，迟到结果不复活已删 Camp。

## 验证

优先扩展现有测试 owner，按[Rust 测试政策](../../development/testing.md#rust-测试准入与退役门槛)选择最低成本 seam。

1. 工作区、临时、默认输出、外部和跨 Camp 路径都原地登记，无复制/链接/chmod；失败不删源。
2. 同路径编辑、大小变化、替换保存、同 Camp 身份复用、目录/HTML 相对资源及缺失/不可读状态。
3. 新发布/普通 Run 无旧 View 回执或内容扫描；旧记录显式读取兼容；用户 Source Ref 行为不变。
4. Send、History、CURRENT_INPUT 的路径一致，外部 Agent 源不能因不在 Camp 目录而隐藏。
5. Runtime 实际输出目录访问、Desktop/Web 路径操作、图像和预览刷新、跨 Camp 热缓存。
6. Camp 删除仅删除自有位置，外部与其他 Camp 自有目录保留；跨 Camp 源失效允许；清理失败和迟到写入覆盖。
7. Run Facts 顶层只有一个附件输出字段，无重复 campId/scope、旧根、权限或分配/重试教学。

执行针对性 Rust/CLI/Renderer/Web 测试、typecheck、构建、文档门禁及隔离实例验收。
真实上下文 Gate 延续 revision 1 已列的现有通用集 DEMO-101–112（suite v2.12.0），
每 Case 1 次、最多 2 次 campaign、每次 14400 秒、最多并行 2 Case，基线候选同配置；
按[双轨评测](../../development/evaluation.md#上下文改动-gate)冻结产品与可追溯 Judge 配置。
缺少平台、模型或 Judge 证据时如实报告，不把设施检查或本机模拟当作真实通过。

## 实施记录

原 worktree `/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-editable-camp-attachments`，
分支 `rovai/editable-camp-attachments`；继续原 Task `154b5057-1d0a-4ef9-bdd1-640d31242b25`。
本 revision 先替换提案及任务范围，再开始产品实现；完成后追加实际迁移与验证证据。
