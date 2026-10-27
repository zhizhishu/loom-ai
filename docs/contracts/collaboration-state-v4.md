---
document_type: interface-contract
contract: collaboration-state
version: 4
authority: agentrun-peer-routing-identity-projection
status: accepted
last_updated: 2026-10-13
---

# Collaboration State v4

继承 [v3](collaboration-state-v3.md) 的 peer 选择、排序、排除 self、Lead 派生、section 出现条件和
accepted ACK。只删除每个 peer 的 `professionalResponsibilities`，不增加摘要或替代字段：

```json
{
  "peers": [{"agentId":"agent_2","name":"Peer","teamRole":"Reviewer"}],
  "defaultLeadAgentId":"agent_1",
  "selfIsDefaultLead":true
}
```

peer 恰好三个字段；`peers` 可为空。顶层没有 schemaVersion。摘要仍从最终投影计算；只编辑职责、
性格、工作准则、成长课题或 Profile version 不改变摘要。名称、团队角色、成员关系或 Lead 的变化
只有在最终投影变化时才刷新。名单读取不加载职责列，不读取完整 Profile 后再丢弃。

新 Run 使用 [Manifest 34/35](context-manifest-evidence-v34.md)。有 peer 的旧 accepted 摘要通常与新
投影不同，按原 ACK 机制自然发送新名单；空 peers 不因字段删除强制重发。旧冻结输入复用原字节，
旧 claimed RunInput 保留旧 serializer，不影响 Native Session resume，不扫描或修补历史名单。

`MEMBER_IDENTITY` 继续完整提供本人职责，遵循既有 Bootstrap、恢复和补发生命周期。详情可通过
[member get](builtin-tool-transport-v39.md)按既有目标授权读取；返回的是目标配置，不是调用者身份指令。
当前协作名单与 member list 的成员筛选差异保持：前者排除 self，离队请求在关系仍 active 时仍可见；
后者包含 self/away，排除离队请求、已离队和全局移除。
