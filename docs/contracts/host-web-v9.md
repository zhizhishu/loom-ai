---
document_type: protocol-contract
contract: host-web-v9
authority: shared-host-web-transport
status: accepted
version: 9
source_version: v1.72
last_updated: 2026-10-23
---

# Host Web v9

继承 [v8](host-web-v8.md)，仅补齐 [Composer Draft v19](camp-composer-draft-v19.md) 的 Web 长粘贴入口。
`protocolVersion` 保持 5，普通文件、图片及 Single Chat 上传规则保持。

## 生成文本上传

既有 `POST /api/v1/uploads` 的 UploadIntent 增加 `target: { kind: "pasted_text" }`。
该种类要求 intent 在 file 之前，复用原 commandId、摘要、verified editor、回执与重试语义。
Host 通过内部 `host.upload.pastedTextRoot` 让 Core 校验 Thread 与编辑身份并解析规范输出目录，
不接受浏览器指定路径、不重建已经删除的 Thread 目录。

Host 在该目录独占新建 UUID `.txt`，按块验证 UTF-8、计算摘要、写入全文并提取最多 160 码点展示前缀。
限制为 25 MiB，浏览器在摘要计算前检查，Host 接收过程中最终检查；普通上传仍为 30 MiB。
换行和空白原样保存，只有卡片前缀折叠空白。有效来源返回 `generatedBy: "long_text_paste"`
与 `pastedTextPreview`；生成来源不是浏览器自报的删除权限。

Core 在原上传绑定事务内同时保存上传回执和可删除资格。回执已存在时复用原来源，清理重复未绑定文件；
结果未知保留可能绑定的文件，沿用已有 reconcile/显式重试。断开、取消或明确未绑定的生成文件采用
单次异步清理，不新增清理队列；无法确认或清理失败允许残留到 Thread 删除。

## 移除与登记释放

既有认证 `POST /api/v1/files` 增加两种 action，request 均为 `{ threadId, attachmentRefIds }`：

- `removePastedText` 只接受一个 ID。Core 校验原编辑身份/Thread/生成登记；缺登记返回 `"retained"`。
  未保护时校验规范 UUID 路径并等待异步 unlink，再清登记并返回 `"deleted"`；已经不存在也算删除成功。
  已进入发送流程只清登记、保留文件并返回 `"retained"`。失败沿用 files 的失败 envelope，adapter 必须抛出清理错误。
- `discardPastedText` 最多 10 个 ID，只释放已保护的登记并返回 `{ released: true }`，永不物理删除；无 ID 时客户端直接返回。
  未保护登记不能被通用 discard 释放。发送后只在本机新草稿保存成功后调用。

内部 `host.upload.*` 方法不进入公开 RPC allowlist。正常恢复与预览继续按不可变上传回执授权、重验文件，
删除资格使用专用表，不从后缀、显示名、卡片前缀或可恢复回执推断。Core 的附件操作锁协调发送保护与删除，统一先取附件锁、再取数据库锁；
保护先持久保存，再进入原发送事务，不建立每次发送关联。空附件发送不取附件锁。
删除复用现有独立请求调度；数据库锁只覆盖读取归属/路径和更新登记，路径校验与异步 unlink 在锁外进行。
删除失败保留登记，客户端仍等待真实结果，不引入后台清理或持久任务。

## 引用目录失效

现有授权 SSE 的可选 `referencesChanged` 标记由 [Thread Reference v1](thread-reference-v1.md#用户目录)
定义。它只通知已选引用的展示状态需重读；不传原始 Core 事件、标题或正文，重连仍使用 `resync`。
此可选字段不改变 Host protocolVersion。
