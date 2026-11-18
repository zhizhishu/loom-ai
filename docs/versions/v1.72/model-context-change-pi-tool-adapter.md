---
document_type: model-context-change
version: v1.72
revision: 1
confirmation_status: implementation_authorized_by_current_session
confirmed_revision:
confirmed_by:
confirmed_at:
last_updated: 2026-11-17
---

# Pi 原生工具：补全既有参数并正确传递失败

本次修复 Pi 适配器的两个实际缺口：`rovai_loom` 没有把 Core 已定义的参数形状交给模型；Pi 0.85.1 把正常返回的工具结果记为成功，因此适配器返回的 `isError: true` 没有成为原生失败。

## 二次确认

本轮用户已授权继续完成个人版并修复真实运行中的问题，实施按该授权进行。上方人工确认字段保持空白；本记录没有人工二次确认签名。

## 基线与依据

基线为 `915ffa1` 中的 Pi 适配器。后续 UI 提交不改变该基线的 Pi 工具实现。真实 Pi UI 03 中，模型调用了正确的操作名，却先后猜测 `path`、`files`、`filePath`、`paths`，没有使用 Core 要求的 `relativePath`；计划、认领及提交没有形成有效任务成果。该失败记录继续保留。

参数唯一来源是 [`loom_tool.rs::tool_definitions`](../../../crates/rovai-core/src/loom_tool.rs)。既有合同见 [LOOM 编排入口](model-context-change-loom-accp.md)、[Built-in Tool Transport v45](../../contracts/builtin-tool-transport-v45.md)；Pi 生命周期遵循 [Runtime Launch and Verification v73](../../contracts/runtime-launch-and-verification-v73.md)。

完整的模型可见前后正文、JSON Schema、八个 Core inputSchema，以及 MCP 前后执行函数，均保存在随 Git 评审的 [固定对照 JSON](../../../scripts/fixtures/pi-workflow/model-context-before-after.json)。它是本 revision 的评审快照。生产代码直接消费 Core 定义；[Core 输入夹具](../../../scripts/fixtures/pi-workflow/core-input-contract.json)由既有 Rust owner 与实际定义逐值比较。

## 变更前

### `rovai_loom`

工具名为 `rovai_loom`，操作集合为以下八项：`loom.status`、`loom.plan`、`loom.release`、`loom.claim`、`loom.evidence`、`loom.submit`、`loom.inspect`、`loom.stage-review`。

其模型可见参数为：

```json
{
  "type": "object",
  "additionalProperties": false,
  "required": ["operation"],
  "properties": {
    "operation": {
      "type": "string",
      "enum": ["loom.status", "loom.plan", "loom.release", "loom.claim", "loom.evidence", "loom.submit", "loom.inspect", "loom.stage-review"]
    },
    "input": {"type": "object"}
  }
}
```

`input` 没有提供任何字段、嵌套结构或必填要求。完整旧 description 在对照 JSON 的 `before.description`；原生工具执行器对 Core 拒绝返回 `{content: [{type: "text", text}], details: undefined, isError: true}`。

### MCP

成功和显式失败均正常返回 `{content, details: undefined, isError: result.isError === true}`；传输异常也正常返回脱敏文字和 `isError: true`。Pi 0.85.1 的 `executePreparedToolCall` 对正常返回固定给出 `isError: false`。该行为已由安装的真实 SDK、合成输入流及实际适配函数离线复现。

## 变更后

### 参数与说明

Core 将八个既有 `inputSchema` 写入当前 Host 私有配置目录的 `loom-workflow-contract.json`，与 binding 相邻。该文件只含公开参数定义，结构是 `{schemaVersion: 1, operations: [{operation, inputSchema}]}`。

Pi 注册同名工具时读取此文档，检查八项操作及既有封闭键集合。模型可见的外层仍为 `{operation, input}`；两项都必填，`loom.status` 传 `input: {}`。`input.properties` 是八个 Core 定义的字段并集，保持原类型、枚举、上下限、数组元素和嵌套必填字段，且 `additionalProperties: false`。完整展开结果是对照 JSON 的 `after.parameters`，没有额外条件式 Schema 或第二套业务字段。

每个操作的必填项来自同一 Core 定义，并进入 description 与调用前校验：

| 操作 | 必填 input 字段 | 可选字段 |
| --- | --- | --- |
| `loom.status` | 无 | 无 |
| `loom.plan` | `goal`, `criteria`, `tasks` | `acceptanceCriteriaVersion`, `dependencies` |
| `loom.release` | `taskId` | 无 |
| `loom.claim` | `taskId` | `leaseSeconds` |
| `loom.evidence` | `relativePath` | `taskId`, `contentType` |
| `loom.submit` | `taskId`, `evidenceIds` | `previousCandidateId` |
| `loom.inspect` | `taskId` | 无 |
| `loom.stage-review` | `taskId`, `candidateId`, `policyRevision`, `manifestHash`, `verdict`, `reason`, `criteriaResults` | 无 |

完整新 description 在对照 JSON 的 `after.description`，包括八项最小 JSON 示例、先读取状态、计划与认领的既有权限、登记实际文件、使用实际返回 ID、提交后等待 User 接受。示例 ID 明确要求替换为当前真实值。`input` 为并集，具体操作的键与顶层必填项仍由适配器校验，Core 保持最终校验权。旧低层调用对 `loom.status` 缺省 input 的归一化行为保留。

按 UTF-8 与紧凑 JSON 计，description 从 392 增至 2,496 字节，参数 Schema 从 270 增至 2,557 字节。这是工具定义补全的实际增量；没有调整 Bootstrap 或 Dynamic Context 的内容预算。

### 失败协议

`rovai_loom` 的明确拒绝及结果未知均通过抛出 `Error` 进入 Pi 原生失败分支，message 为：

```text
<code>: <bounded result text>
```

结果未知时追加以下原文，保持原调用身份且不重新派发：

```text
 Outcome unknown; do not replay this call. Read LOOM status before recovery.
```

binding、grant、必填参数及 spawn 前置失败也抛出已有的有界错误说明。成功结果继续返回原文字。

MCP 成功结果仍经过同一 `toLlmContent` 和 `boundContent`，保持文字、图片结构及大小限制。客户端已有 content 时优先使用该 content；仅有 structuredContent 时使用原客户端的文字转换，优先级不变。

MCP 显式 `isError: true` 时，将已限制大小的文字块用换行连接，再限制为最多 65,536 个字符，作为 `Error.message` 抛出。Pi 0.85.1 的失败协议产生一个文字块；失败结果中的图片因此省略，只有图片的失败使用完整固定文本 `MCP tool reported an error`。该限制不影响成功图片。传输异常继续只产生既有脱敏格式 `server "<serverName>" failed (<kind>[:<code>])`，不回显原始异常正文。单次执行最多调用服务一次。

## 明确不变

Bootstrap、`SESSION_CHARTER`、`MEMBER_IDENTITY`、Memory Entrypoint、Dynamic Context 的内容、选择、顺序和预算均不变。ContextManifest、formatter、delivery profile 版本不变。

工具名、八项操作、Core 认证的 Run/Member/Mission 身份、文件范围、claim 与 User 接受权不变。固定可信 CLI、固定 argv、每次调用的确定性 request ID、stdin/输出限制、超时和不自动重试的边界保持。没有新增工具、操作、权限或数据库迁移。

## 兼容、失效与恢复

`runtime_compatibility_digest_with_mcp` 新增 `managedWorkflowContractDigest = canonical_json_digest(managed_workflow_contract())`。既有 managed Host 与 workflow 源码 digest 随实际修改变化；启用 MCP 的 Host 也使用重新生成的 MCP bundle digest。旧兼容身份不能复用为新 Host，沿现有生命周期重建原生会话。

数据库仍为当前 projection schema 185 / migration 235，本修复不写旧成果、冻结记录或会话文件。新的工具合同文件由每个新 Host 启动时生成；错误恢复仍读取真实状态，不凭失败消息扩预算或重放未知结果。

## 验证

- 既有 Rust owner `workflow_tool_sources_agree_on_one_tool_name_and_the_eight_operations` 已通过；它比较 Core 实际定义和 Node 夹具。
- workflow 17 项离线 owner 通过，包含真实 Pi 0.85.1 SDK 的旧返回 flag / 新抛错对照。既有参数 owner 后续覆盖实际 `managed-host.ts` 注册入口、相邻文档加载与空计划拒绝，定向通过。
- MCP 21 项既有 owner 通过。新增 SDK owner 定向通过：显式拒绝、structured-only 拒绝、图片失败、65,536 字符边界、传输脱敏、成功图片结构和不重试。首次运行中的客户端内容优先级断言错误已修正，原失败日志保留，生产实现没有为该断言改动。
- UI 夹具的 29 个页面表达式按实际浏览器包装全部通过语法检查；新版标签及最高思考档前置已经更新。

```powershell
cargo test -p rovai-core --lib workflow_tool_sources_agree_on_one_tool_name_and_the_eight_operations
$env:LOOM_PI_AGENT_LOOP_MODULE = (Resolve-Path '_artifacts/kit-74a8fe7/runtime/pi/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js').Path
node --test --test-force-exit --test-timeout=120000 scripts/loom-v2-workflow-tool.test.mjs scripts/lib/pi-mcp.test.mjs
node --test --test-force-exit scripts/lib/loom-pi-purge-page-scripts.test.mjs
```

SDK 模块路径必须指向实际安装版本；未提供该环境变量时 SDK owner 会明确跳过，不能算 SDK 协议验证。MCP bundle 由 `node scripts/build-pi-mcp.mjs` 生成，不手工修改生成文件。

真实 Pi UI 03 的失败继续有效。下一次独立 UI 04 验收将使用本轮同源 Host/Core/helper 和生产 Web，检查实际运行的 schema、UI 保存 Append、当前 Run 的冻结与激活、真实文件、Artifact、PENDING Candidate 及 UI 预览；本说明当前不把这条尚未执行完的真实链记为通过。人工确认字段为空，通用文档确认门尚未满足。
