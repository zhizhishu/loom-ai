---
document_type: interface-contract
contract: camp-composer-draft
version: 19
status: accepted
authority: client-local-public-camp-composer-recovery
last_updated: 2026-10-22
---

# Camp Composer Draft v19

继承 [v18](camp-composer-draft-v18.md)。单次长文本附件化扩展到浏览器远程连接的公屏 Composer，
已有 Active、普通弹窗创建的零消息 Active 与一键 Pending 均覆盖；使命描述与单聊不启用。
阈值、码点计数、文件/图片及真实 Atom 优先级、文件卡片、失败回填与本机草稿权威不变。
不增加成功 Toast、正文占位符、累计长度检测或发送预算预判。

## Web 接入

浏览器提供现有可选 `preparePastedText/removePastedText/discard` 接口。粘贴 File 通过既有上传队列、
进度和未知结果恢复送到 Host；上传回执只代表文件准备完成，原浏览器草稿成功保存才代表内容已接纳。
正文、附件清单和原文回填仍由共享 Composer 及浏览器 localStorage 负责，Core 不保存第二份全文或正文草稿。

文件直接写到所属 Host 的 Thread 输出目录 `<UUID>.txt`，不写客户端磁盘，不经过系统临时文件再搬迁。
同一编辑身份重登/刷新使用既有上传回执恢复；不同编辑身份不能凭 ID 取得移除资格。
卡片前缀沿用 [Camp Attachment v12](camp-attachment-v12.md)，由 Host 接收 UTF-8 时有界提取。

用户移除先保存不含该附件的最新草稿，再等待 Host 的异步清理结果。尚未进入发送流程才删除生成文件；
受保护或资格未知时只移除引用。删除失败报告清理失败并接受残留，不回滚草稿、不锁住输入框。
发送成功先保存新草稿，再释放不再用于恢复的登记；文件保留。

准备结果未知复用既有上传回执核对、显式重试与离开保护；原 Promise 和原编辑器持有输入，不能当作失败回填。
明确未接纳时先回填原文，再清理已取得身份的生成物。用户取消上传仍沿用原取消行为：未接纳正文可回填，
Host 无法确认未绑定的文件暂留；不为这类残留新增恢复事务或后台清理。

## 权威与生命周期

Desktop 继续使用 Main 登记与串行队列。Web 的上传回执不可变，额外的可删除资格存在 Core 既有 SQLite
的 `web_pasted_text_attachment` 表中；表只存附件/Thread/编辑身份/源路径及单向 `entered_send_flow`。
迁移 212 将 v1.72/schema 161 升为 162，不迁移或扫描既有外部附件。

Core 在发布前独立提交保护标记，随后继续原消息事务；只按最终发送快照的实际源路径匹配生成登记，
包括跨 Thread 复用。空清单直接返回，后续失败不解除保护。物理删除与带附件发送共用 Core 内的小范围附件操作锁，先取附件锁再取数据库锁；
空附件发送绕过附件锁。删除走现有独立请求路径，磁盘等待不占数据库锁或普通请求队列。具体运输与错误见 [Host Web v9](host-web-v9.md)。

生成登记不参与普通缓存淘汰。未保护文件删除成功后释放；受保护文件从草稿移除或发送后新草稿保存成功，
可以释放登记并保留文件。Thread 删除级联释放登记，目录仍由既有生命周期清理。
Active 清空后保留会话；Pending presence、离开与启动清理不增设新状态。
没有定时任务、扫描、引用计数、发送关联或后台对账；未确认与删除失败残留允许留到 Thread 删除。
