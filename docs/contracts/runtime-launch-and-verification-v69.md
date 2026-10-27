---
document_type: contract
name: Runtime Launch and Verification
version: v69
status: accepted
source_version: v1.72
last_updated: 2026-10-22
---

# Runtime Launch and Verification v69

继承 [v68](runtime-launch-and-verification-v68.md)。本版替代环境编辑器的凭据遮蔽、保留标记和独立数量／名称长度限制；
输入转换只由 Renderer 公共解析函数拥有，Core 持续使用字符串映射。决定理由见
[V1.72-D56](../versions/v1.72/decisions.md#v1-72-d56)。

## Owner 环境读取与保存

- `runtime.environment.get { runtimeKind }` 返回 `{ revision, environment }`，值为完整字符串。
- `member.runtimeEnvironment.get { memberId, adapterKind }` 返回队员字符串映射、revision、inheritCommon 及当前完整 common 快照。
- `runtime.startup.get/save` 的 `commonEnvironment` 同样返回完整值。
- `runtime.environmentLegacy.get { runtimeKind }` 返回完整的只读归档；不启用、不迁移、不改写归档值。
- 上述读取不再接受 `reveal`。编辑和合并预览不遮蔽变量，不提供显示／隐藏密钥状态或额外请求。
- `<saved>` 不再是保留凭据的特殊标记，是普通字符串；缺省条目仍表示删除该层覆盖，空字符串仍是显式覆盖。
- `members.runtime.set.command.environment.json` 及 `runtime.startup.save/inspect/check.commonEnvironment.json`
  均为字符串映射 JSON。Core 不接受 number、boolean、null、数组或对象值，也不建立第二套数值转换规则。

Owner Desktop/Web 访问边界、AES-256-GCM 私有存储、revision 冲突、原子保存和日志脱敏保持。
公开资料、模板、跨队员应用、事件、诊断及命令回执仍不能携带环境值。无需数据库迁移。

## JSON 输入转换

通用和队员编辑器复用 `parseMemberEnvironment`，返回 `Record<string, string>`。
字符串原样保留；有限数字和布尔值使用 `String(value)`。`0`、`false`、`""` 都保留，`"00123"` 不移除前导零。
非有限数字及超出 JavaScript 安全整数范围的整数须提示使用字符串；null、数组和对象值须指出变量名并拒绝整次提交。
需要传递 JSON 内容时显式填写字符串。重复变量检查针对原始 JSON 文本执行，包含转义解码及 Windows 大小写别名。

输入、失焦和进入预览均不改写原始草稿。合并预览使用转换后的字符串，沿用通用配置与队员同名覆盖、其余保留的规则。
提交使用 `JSON.stringify(parsed)`；成功后显示保存的字符串快照并清除脏标记，失败保留原始草稿。
新队员创建后的运行配置与已有队员共用此路径。

## 保留的限制

取消独立的 128 项上限与 256 字符变量名上限；单值 64 KiB、配置覆盖层合计 128 KiB 的 UTF-8 容量限制保持，
通用与队员合并结果也须满足总容量限制。名称仍须满足 `[A-Za-z_][A-Za-z0-9_]*`，拒绝重复名、NUL 和应用保留名。
Windows 名称按大写持久化；Claude 显式模型与合并后的 `ANTHROPIC_MODEL` 仍互斥。
三层优先级、关闭继承、Host 字面值、新进程读取和健康 Warm 生命周期沿用 v68，不进行 Shell 展开。
