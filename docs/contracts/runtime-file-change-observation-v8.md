---
document_type: contract
contract: runtime-file-change-observation
version: v8
status: accepted
source_version: v1.72
last_updated: 2026-10-16
---

# Runtime File Change Observation v8

继承 [v7](runtime-file-change-observation-v7.md) 的全部非 MiniMax 来源、Evidence schema、归约、读取授权、
managed output 排除和界面语义。本版新增 MiniMax Code 的原生文件结果准入，不新增存储 schema 或 Renderer 分支。

## MiniMax Code

只接纳 `minimax-code-cli + acp-v1`，按既有 Session/Prompt/ToolCall owner 配对。审批 ID 与实际工具 ID
沿现有唯一完整输入匹配建立精确 alias，不能跨 Session/Prompt 复用。终态省略名称或参数时只使用本调用观察值。

- 原生 `read/write/edit` 的唯一结构化 `path | file_path | filePath` 可以补齐缺失的 location，包括相对路径；
  既有 location 不被覆盖，路径由共享 execution-root normalizer 处理。失败终态不形成成功文件操作。
- 成功 `write` 的 `rawOutput.details.created` 必须为 Boolean，且同调用的唯一输入路径与 operation path 一致，
  才可将 `true/false` 映射为 `add/update`。空文件已经存在时为 update；未知字段、路径冲突或 edit 不升级为 add。
- MiniMax 的 ACP `content.type=diff` 来自显示预览，可能带行号、省略号及截断，全部退出完整 before/after 准入。
  `old_string/new_string` 也不能回退为完整状态。
- 成功 `write/edit` 的 `rawOutput.details.patch` 才可生成内部 `minimax_file_patch` 候选；存在 `patchOmitted`
  时不生成。公共字段只包含该 patch、已证明的 operation path 与 update 类型，不复制相邻私有 details。
- 双侧 `---/+++` header 必须完全相同，且词法解析后与本调用路径一致；write 的可选 `Index:` 前缀必须与
  header 一致并有原生固定分隔线。必须含 hunk、存在增删且满足共享大小上限。错误路径、无 hunk、无变化、失败
  和被省略的 patch 保持路径级回退；不读当前磁盘、Git 或输入内容来补造 patch。
- 准入结果是既有 `unified_diff_snapshot`，保留原生 hunk 坐标和增删行，不是完整文件状态；多次操作保留历史，
  不按完整状态链合成净差异。原生 write 新建没有 patch 时可显示“新增”，但没有伪造的 Diff 或增删数。

这是新增 Runtime 的协议来源校正，沿 `activity-v4` 现有 file/write 分类，不改变既有 Adapter 的解释。
已持久化 Evidence 不回填、不重新分类。Command 与 Files Changed 使用同一成功结果，按既有 source water/revision
恢复读取。受控真实 CLI 证据与 Renderer 点击验收分开记录。
