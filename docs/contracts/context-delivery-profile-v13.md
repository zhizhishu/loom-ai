---
document_type: contract
contract: context-delivery-profile-v13
status: accepted
target_version: v1.72
last_updated: 2026-10-14
---

# Context Delivery Profile v13

继承 [Profile 11/12](context-delivery-profile-v11.md)。新 public batch 冻结
`{"profileVersion":13,"maxSelfActiveTasks":8}`，配对 [Manifest 36](context-manifest-evidence-v36.md)。
非 batch 仍使用 Profile 12；旧 Profile 和已领取输入沿原版本恢复。

默认上限仍为 256 KiB，显式 `maxContextPayloadBytes` 继续覆盖。claim 在同一事务读取并保存
本 Run 的 Bootstrap 内容、协作投影、Tasks、Run Facts、workspace、additional Skills 与正式
RUN_INPUT 投影。预算采用最终 formatter 的 UTF-8 字节，包括可能重新出现的协作和 workspace。
完整消息优先于可选 Tasks；FIFO 最大连续前缀以这一完整预算选择，剩余消息保持 waiting。

FirstPayload 或允许同包补发的 Adapter，为冻结 Bootstrap 的实际长度加完整 redelivery
wrapper 和分隔符预留空间，覆盖摘要变化、claim 后补发和恢复失败后的新 Session。独立系统层
且无同包补发可能时不扣 Bootstrap。预留不改变实际发送条件，不强制每轮发送。
同一 Run 的后续 Binding 使用这份启动内容，身份和 Memory 索引的后续编辑进入下一 Run。
实时 Memory 读取授权不受索引快照影响。

组包消费同一份快照，不重新扩充模型输入。必要的 Runtime、附件授权、Binding 和 accepted
检查保留。最终完整输入仍检查实际字节数；单条或原子续做集合无法装下时明确
`context_payload_too_large`，不截断、不把已领取输入退回 waiting、不自动重播。

Mission 的实际 WORKSPACE 在异步准备和 Git 观察完成后传入 claim；不得在 SQLite 事务内执行 Git，
不得用源目录或 managedBranch 代替实际执行目录和 checkout。准备中的 Mission 不阻塞普通 lane。
结果在 claim 事务验证 workspace 身份／代次／token／路径；失效时重新准备，消息仍为 waiting。
RUN_INPUT 中已失效的 Skill 链接可按既有授权／可用性检查移除；不得在 claim 后添加链接。
