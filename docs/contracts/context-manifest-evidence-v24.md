---
document_type: protocol-contract
contract: context-manifest-evidence-v24
version: 24
status: accepted
authority: agent-run-context-evidence
last_updated: 2026-09-16
---

# ContextManifest Evidence v24

继承 [v23](context-manifest-evidence-v23.md) 的消息、quotes、Skill、MCP、Task/Gather、顺序与预算；Profile 5 不变。
新增输入使用 Formatter/Manifest 24 与 Run Facts schema 3，整个 campResources 替换为顶层 `attachmentOutputRoot: string`。
其他 Run Facts 字段不变。内部 fact 名为 attachment_output_root，只冻结这段路径文字。

新 Agent Source Ref 投影实际路径，附件 ID 稳定，contentDigest 缺省；不补空摘要。不因当前文件改变触发 Context 失败。
CURRENT_INPUT.attachments 保持 string[]。Shared Message evidence 保存记录位置及展示元数据，不证明内容不可变。
只有选中的历史 legacy_v1 记录需要旧 View receipt；没有这些记录时 Manifest 的三个 receipt 字段及 Runtime input
的三个 attachment auth 字段均为 NULL。runtime_request_digest 继续必填，证明该次投递请求而非文件冻结。

Migration 156/schema 106 在 v1.59/schema 105 上扩展约束及插入守卫，保留历史内容和回执。
已冻结 v22/v23 可以按原始 bytes/digest 精确继续；新建必须为 v24。v24 恢复仍校验 Context 本身完整性和绑定身份，
不能因为附件原文件编辑重新构造冻结消息或 Bootstrap。Runtime 的实际输出目录配置参与现有兼容判断，文件内容不参与。
Bootstrap v3/Formatter 3 与 Charter revision 6 不变。字段确认及版本轴见[revision 2](../versions/v1.59/model-context-change-editable-attachments.md)。
