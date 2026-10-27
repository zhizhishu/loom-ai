---
document_type: contract
name: Runtime Launch and Verification
version: v71
status: accepted
source_version: v1.72
last_updated: 2026-10-22
---

# Runtime Launch and Verification v71

继承 [v70](runtime-launch-and-verification-v70.md)。本版扩展通用 ACP Host 的 Provider detail
白名单，兼容 TRAE CLI 0.209.1 返回的字符串 `error.data`；替代 [v42](runtime-launch-and-verification-v42.md)
中只接受 `error.data.error` 的限制。

## ACP Provider detail

匹配请求的 JSON-RPC error 继续保留数字 `error.code` 与顶层 `error.message`。Provider detail
只接受以下两种互斥形状，不递归搜索任意对象字段：

- `error.data` 本身为 JSON string；
- `error.data` 为对象，且其精确路径 `error.data.error` 为 JSON string。

其他对象字段、数组、数字、布尔值和 null 不作为 detail；不序列化整个对象，也不解析字符串中的 JSON。
两种字符串共用现有公开 Runtime 错误清洗：去除 ANSI 与不允许的控制字符，排除 Prompt、用户正文、
Tool input/output 标签行，脱敏凭据与本机路径，并保持现有行数和字符上限。
清洗后为空或与顶层 message 相同的 detail 不追加。最终诊断仍依次包含 code、message、清洗后的 detail。
Host 关联凭据的额外脱敏保持不变；原始 `error.data` 不持久化、不交给 Renderer。

规则由共享 Host 拥有，不增加 TRAE 专属解析分支。详情沿现有 RPC response、输入 disposition、
Prompt completion 与 `RuntimeFailureView` 路径传递。Quota 等分类继续由统一错误分类器负责；
accepted/not-accepted 与防重放门禁不因详情形状改变。

## 历史与验证

旧 Run 不回填错误详情，不从相邻 Session、stderr 或当前 Runtime 推断历史原因。无新增公开字段或 Migration。

扩展已有解析矩阵，覆盖两种字符串、脱敏、去重、空值及非白名单形状；已有合成 ACP 进程 owner
覆盖两种格式在 Prompt activity 前后的完成与输入 disposition。测试不调用真实模型。
TRAE 0.209.1 的无网络隔离探针验证原生字符串形状；该探针的启动错误不冒充配额 Prompt 的原始 wire。
