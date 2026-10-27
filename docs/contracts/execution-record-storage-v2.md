---
document_type: protocol-contract
contract: execution-record-storage-v2
authority: execution-record-storage
status: accepted
version: 2
source_version: v1.72
last_updated: 2026-10-14
---

# Execution Record Storage v2

继承 [v1](execution-record-storage-v1.md) 的独立输入／结果、读取时组合预览、输出预算及正常删除回收。
本版仅收敛新操作的活动展示存储，不改变 command.result、审批、输入投递、运行结算或未知结果不自动重放的规则。

## 创建与兼容

migration 202 / schema 152 是最低读写实现；旧 Core 由现有数据库版本准入拒绝继续写入，发布 App 版本号由发布流程分配。
格式 1、2 已创建操作继续旧生命周期与其冻结 classifier 收尾，旧活动表、旧正文与 Blob 不回填、不删除。
新操作首次写入格式 3，之后不可改变。没有可靠操作 ID 时每次观察创建独立操作；仅精确事件 ID 重放可去重，
不能按命令文本关联。Run 目录模式与此格式独立。

迁移只增加三个可空小字段、触发器和不物化的只读 SQL 视图；不扫描／复制历史正文，也不建立通用迁移框架。
已有 schema 不认识新格式的实现不得继续写入；没有逆向迁移和任意旧 App 降级承诺。

## 一条操作支撑展示

格式 3 沿用 Evidence 表的一份输入、一份结果、状态、时间、顺序和变更版本；组合预览仍读取时生成。
activity_meta_json 只承载 classifier、类别、工具名、展示标题（至多 256 字符）、阶段、结论、可信度、来源、
覆盖范围与文件路径／增删行数／diff 状态等展示元数据。输入、输出和修改正文不写入此字段。
started_at / terminal_at 对应小字段记录实际观察时间。操作 ID、Evidence ID、顺序与 revision 直接来自同一行。
新操作禁止写入 canonical_runtime_activity，格式 1、2 继续原表。

execution_activity 是旧活动行与格式 3 小字段的只读 UNION ALL 视图，不保存任何行或正文。
活动分页、筛选和 Trace 从兼容读取路径获得事实；后台 ZCode 身份／结束判断继续读取独立输入／结果的
既有结构字段。分类器和生命周期归并复用原逻辑，冲突终态仍为 unsettled，不从截断输出推断成功。

单文件预览授权先按 Evidence 主键核对会话、Run 与 epoch，再按创建格式读取，不经过 execution_activity 联合视图。
格式 3 只读选中行的活动小字段；无 diff 的成功 Read/Write 再从该行的有限预览 JSON 取 runtimeFileOperation 小对象，
复用既有逐字段归并（包括稀疏结果与 null 规则）。格式 1、2 先在旧活动表定位小主键，再读取选中旧 projection；没有可靠操作 ID 的
旧 append-only 记录仍用原 source Evidence 归属查找，不推断命令相等。整轮旧 diff 不进入临时联合表。
工作目录、请求来源与路径校验保持，查询优化不新增或取消权限机制。

文件 diff 展示只保存路径、计数和状态，不另存 patch。点击展开时复用该次已授权的完整 Evidence 读取，
按现有 Runtime diff 解析器恢复 patch；冲突／不可用状态不得借重新解析恢复为成功。权限判定仍在 Core，
绑定准确的会话、Run、epoch、Evidence 和路径，保留删除、工作目录与越界过滤。

## 分页与输出

保留 Run Process Detail v54 的主线折叠、组计数、组内分页、变更游标与 Renderer 展开／滚动状态。
沿用单 Run 轻量元数据扫描和已有 Run／操作索引，不扫描全库生成列表，不为展示读取整轮 Blob。
本页只组合选中行的预览；文件行只带路径和计数，完整正文仅所选结果／文件展开读取。

普通工具输出沿用 7,680 UTF-8 字节预算、完整字符边界与截断标记。先裁剪再保存，累计进度、结果替换和
仅状态更新继续原归约。预算耗尽仍消费 Runtime 协议；被裁剪后缀不进入数据库、Blob、持久事件或生产日志。
用户回复及合法的代码修改内容保持独立长内容机制，智能体实际接收的工具结果不变。

正常删除的引用收集、事务登记、宽限期、共享／重新引用保护和中断恢复保持 v1；不扫描清理历史孤立文件。
