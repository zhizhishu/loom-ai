---
document_type: contract
contract: file-preview
version: 23
status: accepted
authority: desktop-file-preview-wire
source_version: v1.72
last_updated: 2026-10-18
---

# File Preview v23

继承 [v22](file-preview-v22.md) 的自动刷新、可见性、失败阻断、候选提交和生命周期规则。
本版只减少候选读取与同版本内容准备，不增加 API、配置、调度层或持久状态。

## 句柄内定位复用

Desktop 在现有句柄内只保存最近一次成功 `resolveLine` 的 `{offset, line}`。
紧接着的 `readPage` 起点命中该 offset 时直接使用其行号，正文仍经过原有读取前后版本校验；
其他起点仍按原逻辑定位。新候选不继承旧句柄的定位记录，句柄释放时记录一起释放。
Web 的候选内分页读取约定由 [Host Web v8](host-web-v8.md) 拥有。

## 同版本自动刷新

只有自动刷新且刷新前已有有效句柄、可显示内容、没有刷新错误时，才允许在取得候选后短路。
先确认同一 `previewKey`，再比较现有版本属性：Desktop 比较 `size / mtimeMs / fileId`，
不比较每次新建的 UUID generation；Web 比较 `contentVersion` 及已经计算的 SHA-256 `contentGeneration`。
无法确认一致时继续完整读取。属性相同但 Web 摘要不同不能跳过。

相同版本在 HTML 容量预留之前结束：释放候选，保留当前内容、句柄、阅读位置和 HTML 实例，
不调用正文读取或 HTML 准备。只消费本轮开始时的更新水位，期间的新通知仍由既有调度合并处理。
手动刷新、错误恢复、无句柄恢复继续完整加载；判断使用刷新前的错误状态，不新增持久标记。

## 验收

扩展已有句柄、共享控制器和 Web 读取测试。记录实际读取字节数、完整摘要次数及 HTML 准备次数；
保留长行、UTF-8、缩短/空文件、后台不读、失败不重试、新通知水位及关闭后释放迟到候选的断言。
