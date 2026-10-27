---
document_type: contract
contract: file-preview
version: 16
status: accepted
authority: desktop-file-preview-wire
last_updated: 2026-09-18
---

# File Preview v16

继承 [v15](file-preview-v15.md) 的窗口保留、附件位置、HTML 资源与 Run Evidence `open_current` 合同。

Command View 中由 canonical diff 产生的修改文件行使用新的封闭来源 `run_activity_file`：

```ts
{
  kind: 'run_activity_file'
  campId: string
  agentRunId: string
  executionEpoch: number
  evidenceId: string
  rawReference: string
}
```

Core 必须同时证明 `evidenceId` 属于 exact Camp、AgentRun 与 execution epoch、列在该 canonical diff projection 的
`sourceEvidenceIds` 中，且 `rawReference` 是同一 available diff projection 中的精确相对路径。绝对路径、父目录跳转、缺失或冲突的
diff projection、错误的 Evidence/Run/epoch/Camp 均不得产生文件目标。Renderer 不能用 Command 文案、文件名或
当前 Camp 路径代替该证明。

授权成功后，Core 优先使用来源 AgentRun 冻结在 `workspace_json.executionRoot` 中的有效绝对路径；只有历史 Run
缺少有效值时，才回退到 active directory Camp 的绝对 `project_path`。Desktop Main 与 Web Host 继续执行 reference parsing、realpath、
普通文件与预览安全校验；该来源不支持目录操作。请求可以随 Camp 预览 session 恢复，每次恢复都必须重新验证上述身份与路径。

缺少 Evidence identity 的历史 Command presentation 可以保留 `camp_workspace` 兼容回退；新 canonical activity
不得使用该回退。已解析 Tab 的去重以 Main 签发的 canonical `previewKey` 为准；不同实际根目录中的同名相对路径
不得因显示路径相同而合并。冷恢复 Tab 仍可在尚无 `previewKey` 时使用 Main 签发的稳定来源路径匹配。
