---
document_type: architecture
architecture: camp-attachments
authority: live-source-references-and-legacy-attachment-reads
status: accepted
last_updated: 2026-10-21
---

# Camp Attachments：原路径引用、默认输出与历史读取

新用户输入和新 Agent 发布复用 `LocalAttachmentSourceRef`；历史 Managed/Prepared/Message Attachment 保留原位读取。
[Camp Attachment v12](../contracts/camp-attachment-v12.md) 拥有当前合同；
[V1.59-D08](../versions/v1.59/decisions.md#v1-59-d08) 解释从复制快照转为原路径的选择。

## 发布和身份

```text
Desktop native path ──────────────┐
Desktop bytes / Web upload       │
  -> existing temporary source ──┤
Agent send --file actual path ───┤
                                 v
                  LocalAttachmentSourceRef in owner JSON
                                 |
                     transaction -> CampMessage
                                 |
                   actual path -> later current reads
```

CLI 只传指定路径，Core 在锁外观察此对象，提交前再次核对 Run/lease，沿用原消息事务和内部命令防重复。
没有 CLI import、Core staging/复制、Runtime View 内容副本、只读化或首次摘要。
既有 `source_attachments_json` 明确选择新读取语义；旧关系表选择旧读取语义，不猜测目录名字。
同 Camp 相同 sourcePath 可复用附件 ID，内容编辑不换身份；跨 Camp 分别保存引用，物理文件仍为同一份。
目录仅保存位置，不遍历整树分配身份。失败不删除源文件。

Source Ref 显示名只承担展示元数据职责：检查非空、120 码点上限及控制字符，保留冒号等原始字符，
不再复用落盘文件名的规范化相等检查。实际读取始终使用原 sourcePath；渠道下载、历史受管文件等
创建文件的入口仍负责安全目标名称。已有记录和 Desktop 本地恢复绑定不重写。

用户 Composer/Pending/单聊的 owner、发布前重检、编辑隔离和弱持久性保持原合同；
Agent 新发布直接使用消息 source refs，不建立另一个资产实体或内容版本库。

## 默认输出与 Runtime

`storage_layout` 在已有 instanceKey 下统一推导 `attachments/<campId>/`，是旧 runtime-files 的同级目录。
Windows 位于 CoreDataDir，Server 完整归属自己的 data-dir，Desktop 根不变。
Host 准备普通目录，Agent 可用正常名称直接生成长期交付，再 send 原地登记。Run Temp 仍可被清理。

Run Facts 只投影顶层 attachmentOutputRoot，含义是默认输出位置；不代表清单、读取根或权限授予。
现有 Runtime additional directories 接入它，遵循原生模式。文件内容不参与 Bootstrap 或会话兼容摘要。
普通 Run、新建 Camp、自动任务和新发布不依赖旧 View 的状态或回执。

## 读取与预览

公开 Camp 模型在每条 `RUN_INPUT.messages[].attachments: string[]` 接收路径；Single Chat 继续使用
`CURRENT_INPUT.attachments`。用户 Source Ref 保持原 Run 前宿主重检；新 Agent 引用
直接投影记录位置，单个源失效由实际读取报告。History 为 Agent 外部源返回路径，列表从记录读取。
路径元数据查询复用 exact owner 授权，不读取全文；本机可显示/复制/定位所有已解析位置，远程标为服务器路径。
新文件读取当前内容，包括替换保存；旧文件仍按历史合同验证，展示路径不会改变旧权限。

Desktop/Web 复用现有预览缓存与更新反馈，候选刷新失败保留旧内容，切 Camp 不冷加载。
HTML 按真实来源目录解析资源；Web 资源能力绑定已有句柄、Session 和源记录，每次限制在授权目录，
不授予页面业务凭据，iframe 和直接资源导航均保持 CSP 沙箱。细节见 [File Preview v18](../contracts/file-preview-v18.md)。

## 归属与生命周期

Camp 拥有 Authority 附件根、默认输出目录及历史自有附件，不拥有任意 sourcePath。异步删除先以 Camp marker
等待 Runtime 停止/隔离，再在聚合删除事务内把三个受管目录的清理义务交给既有
`camp_attachment_view_operation(kind='camp_delete_cleanup')`；Camp 删除后该 journal 独立恢复，精确删除自有目录
（包括未发布和已编辑内容），失败自动退避并可继续同一 operation。Mission Worktree/branch 仍由自己的 cleanup owner
负责，journal 只等待其检查点，不复制 Git 清理状态。完整流程见 [Camp 永久删除](camp-deletion.md)。
Run 结束、消息删除、预览关闭/LRU 不删除永久输出。外部原文件不删除；跨 Camp 引用在拥有者删除后可失效。
不增加引用计数、保活、迁移、回收站、全盘路径/内容去重或无引用垃圾扫描。

## 历史兼容

只有访问历史记录时进入 Managed/legacy 定位、必要恢复和原完整性校验。历史文件不迁移、不批量 chmod，
消息引用与已冻结 Context 不重写。数据库 Migration 156 仅放宽新 Context 的明确版本/可选旧回执组合，
保留原约束分支；新记录不为适配旧表制造摘要。用户旧 Prepared Draft 的原互斥兼容流程保持。
