---
document_type: protocol-contract
contract: builtin-tool-transport-v41
authority: builtin-tool-transport
status: accepted
version: 41
last_updated: 2026-10-15
---

# Built-in Tool Transport v41

继承 [v40](builtin-tool-transport-v40.md) 的完整输入／输出 shape、help、授权、版本和幂等边界，
以及 [Camp History v14](camp-history-v14.md) 的当前输出。
Transport/CLI **41**、Agent Output **14**、capability `builtin_cli.transport.v41`；IPC **3**、Envelope **2** 保持。
Core/CLI 配套发布，旧 CLI 沿用 dispatch 前版本门；Native Binding 恢复资格不变。

## 成员头像读取

`member get` 的 avatar.path/status/displayCrop 字段、必需性和封闭 Schema 不变。
对旧 schema 1/2 上传头像，path 从已裁好的 icon 改为受管源图临时副本，displayCrop 从 null
改为该源图保存的 iconCrop。与 schema 3 一样，读取和 crop-only 修改使用同一坐标参照。
源图缺失或校验失败时返回 unavailable；不以尚可读取的 icon 替代源图。
具体资源、临时文件与失败语义见 [Member Avatar v3](member-avatar-v3.md)。

完整身份、member list、内置头像、create/update、CLI help、Skill、Bootstrap、Dynamic Context、
历史结果和 Session 恢复保持；有界证据仍排除临时路径，原始摘要绑定实际完整结果。
Desktop/Web 和渠道沿用已有 icon 的取景，不随 Agent 读取改变。
