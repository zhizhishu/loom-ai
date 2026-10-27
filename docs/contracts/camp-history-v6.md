---
document_type: protocol-contract
contract: camp-history-v6
version: 6
status: accepted
authority: camp-history-retrieval
last_updated: 2026-09-16
---

# Camp History v6

继承 [v5](camp-history-v5.md) 的身份、publication fence、quotes、分页和预算。
`camp.read` 附件条目为 `{attachmentId,name,kind,fileCount,mediaType,byteSize,path?}`：
fileCount/byteSize 为 `number | null`，mediaType 为 `string | null`；未知观察信息不伪造为首次内容回执。

Agent Source Ref 的 path 是实际登记的绝对源路径，包括工作区、Run Temp 和其他外部位置；不限定 Camp 自有目录。
旧记录可解析时同样返回实际读取位置。位置解析不读取全文、不遍历目录、不以目前文件失效拒绝整条历史。
用户 Source Ref 原历史条目不变。文件内容访问仍由具体读取入口按记录种类验证。
