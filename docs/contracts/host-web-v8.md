---
document_type: protocol-contract
contract: host-web-v8
authority: shared-host-web-transport
status: accepted
version: 8
source_version: v1.72
last_updated: 2026-10-18
---

# Host Web v8

继承 [v7](host-web-v7.md)，仅替代继承自 v2 的“分页、行号定位每次重新读取全文并校验 SHA-256”规则。
`protocolVersion` 保持 5，所有请求和响应字段保持原状。

## 候选内分页与行号定位

新候选继续完整分析一次，建立既有 SHA-256 generation、UTF-8 判定和每 64 KiB 一项的块行号。
Analysis 在现有句柄内保留大小与原始精度的修改时间，不保存全文字节，不跨候选或重启复用。

同一候选的 `resolveLine / readPage` 只读取所需范围，不再执行全文摘要。
读取前后分别检查文件大小和原始修改时间仍与 Analysis 一致；缺少匹配 generation 的 Analysis、
属性变化、短读或其他读取错误直接走既有失败出口，不重新分析、不回退全文哈希、不自动重试。
来源重验、no-follow 打开、普通文件、20 MiB 预览上限与 generation 请求校验保持。

行号定位从现有块行号选定的位置开始，必要时跨多个块读取，直到目标行或 EOF。
分页允许为了绝对起始行号读取块内前缀，正文最多 256 KiB 加三个 UTF-8 边界字节；
非字符边界起点仍拒绝，页末保持完整字符且小页面保证前进。缩短后在新候选定位最后有效行，空文件保持可读。

本版接受：候选建立后的等大小、等修改时间原地改写，可能不被这两个接口识别；
它们返回候选的既有 generation，不宣称本次读取重新验证了摘要。
新候选仍计算真实摘要，属性相同但摘要不同不能被同版本刷新去重。
普通全文、HTML、二进制及父 generation 检查保留既有读取和摘要规则；下载继续遵循 v7 的独立约定。
