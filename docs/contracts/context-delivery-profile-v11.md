---
document_type: contract
contract: context-delivery-profile-v11
status: accepted
target_version: v1.72
last_updated: 2026-10-13
---

# Context Delivery Profile v11

继承 [Profile 10](context-delivery-profile-v10.md)。新 public batch 的冻结形状为
`{"profileVersion":11,"maxSelfActiveTasks":8}`；非 batch 使用 Profile 12，保留 Profile 7 的字段/数值。
与 [Manifest 34/35](context-manifest-evidence-v34.md)配对。旧 Profile 5～10 仍可按原版本读取。

共享 Runtime payload 默认上限由 **96 KiB → 256 KiB**。显式 maxContextPayloadBytes 继续按原规则覆盖；
字节数按最终 UTF-8 序列化结果计算，不按字符数或 token 数推测。新批次领取使用最终 section formatter
计算 roster、tasks、Run Facts、workspace、additional skills 和完整 RUN_INPUT；不能让输入独占全部预算。
同包 Bootstrap 预留 **128 KiB** 正文加实际分隔符，补发另计实际 wrapper；独立系统提示不占本包预算。
不截断职责、消息或必需区段，实际装配超限按原 context_payload_too_large 失败。

Command Code 的 Rust/JS Bootstrap 正文均支持 **128 KiB**，绑定 JSON 支持 **256 KiB**，Rust 写入与 JS
读取均检查真实外层字节数。Cline Bootstrap 正文同步为 **128 KiB**；其他无此瓶颈的 Adapter、工具结果
和 IPC 限额不盲目放大。这些是 Rovai 内部容量，外部模型/CLI 的真实限制仍需实测。
