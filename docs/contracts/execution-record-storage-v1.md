---
document_type: protocol-contract
contract: execution-record-storage-v1
authority: execution-record-storage
status: accepted
version: 1
source_version: v1.72
last_updated: 2026-10-14
---

# Execution Record Storage v1

本合同补充 [Run Process Detail](run-process-detail-surface-v54.md) 的保存方式，保留既有操作归并、
输出预算、活动投影及分页合同。业务 command.result 回执、审批、输入投递和 Run 结算不变。

## 新操作与旧操作

SQLite schema 150 / migration 200 的最低读取与写入实现是本合同实现版本；沿用 authority admission，
不识别 schema 150 的旧 Core 不得继续打开写入。已发布的 0.4.10（schema 149）不支持此格式；
包含 migration 200 的 Core 是最低读写实现，正式 App 版本号由发布流程分配。不支持逆向迁移。

既有 Evidence 表增加 storage_version：旧行默认 1，新创建且具有可靠操作 ID 的生命周期行写 2。
格式在创建时确定并由 SQL trigger 禁止改变。旧操作仍按 1 收尾；普通追加式 Evidence 没有重复的输入／结果，
继续原路径；不能凭相同命令文本归并不同操作。

格式 2 的 input_preview_json / input_blob_id 和 result_preview_json / result_blob_id 继续各自承载
输入和结果，payload_preview_json 只保存固定空对象；组合预览由读取层按既有“结果优先、缺值由输入补齐”生成。
分页只组合选中行的有界预览，不读取完整 Blob。单 Run 分组薄索引直接提取小字段；后台身份／状态判断和
Trace 元数据同样读取独立字段。详情仍按需读取独立 Blob；文件预览仍由 Core 校验来源和归属。

普通工具结果沿用 7,680 UTF-8 字节预算和截断标记，先裁剪再保存，不保留被裁掉的副本。完整结果替换、
有序追加、仅状态更新沿用原归约；预算用尽不停止协议接收。用户回复、文件修改详情保留各自机制。

迁移仅增加格式列、触发器，扩展 Managed Blob 元数据的 GC owner 闭集；不重写 Evidence 正文、不读取 Blob，
不为校验新列扫描历史正文。读取旧数据不迁移。历史文件和目录不因升级自动缩小。

## 正常删除的回收登记

删除会话聚合前，收集该事务实际删除的 Run Evidence、文件修改、图片、Action、ContextManifest 和
Conversation Bootstrap 的 Blob 引用，在同一事务中标记现有 managed_blob 待回收字段，owner 为 camp_deletion。
事务只处理元数据；回滚同时恢复引用和登记。没有参与此次删除的历史孤立文件不进入候选集合。

后台沿用宽限期、互斥、文件移出及恢复机制。最终引用检查保留所有外键引用，并显式保护旧的
无外键 action_execution.result_blob_id；共享或重新引用的候选退出回收队列。只有最后引用解除并经过
宽限期的文件才能删除。不得新增全局孤立文件清理、引用计数表或回收队列。
