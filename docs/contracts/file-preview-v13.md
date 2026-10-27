---
document_type: contract
contract: file-preview
version: 13
status: accepted
authority: desktop-file-preview-wire
source_version: v1.59
last_updated: 2026-09-15
---

# File Preview v13

继承 [v12](file-preview-v12.md) 的来源、文件能力、HTML 站点隔离、诊断与读取一致性。本版替换预览随 Camp
切换失效、逻辑句柄/token 空闲过期，以及原地刷新资源的生命周期。理由见 [V1.59-D07](../versions/v1.59/decisions.md#v1-59-d07)。

## 窗口保留与容量

`file-preview-retention.ts` 集中定义：24 个 Camp 状态快照（包含热 Camp）、8 个热 Camp、128 MiB 后台正文
估算、4 个 HTML 活实例、64 个 Desktop Main 逻辑句柄。没有预览的 Camp 不占热名额。不增加完整 Camp 页面、
Runtime 常驻或正文持久化。缓存只属于当前窗口生命周期。

快照保存标签身份、来源与呈现、顺序、活动项、面板显隐及滚动/分页/图片缩放和位置/源码模式。
窗口资源层独立持有正文、分页、图片 Blob URL、文件句柄、Markdown 映射、HTML 页面与站点、加载请求；
File Change 的不可变 detail 也归该层。快照不复制正文、token 或底层文件对象。

用户切回有预览的 Camp、打开文件、激活标签才提升 LRU。监听事件、写文件、自动快照、异步完成只更新原标签。
超过热 Camp 数量时淘汰最旧非当前 Camp 的可恢复热资源；超过正文预算时按标签 LRU 回收不可见的可恢复内容，
当前 Camp 的非活动标签也参与。正文估算分别计字符串和 Blob，共享分页引用不重复计量；不宣称是进程内存上限。
HTML 页面与其站点共同计活实例，超过上限回收不可见最旧实例，保留源码及阅读快照。当前可见资源、必要操作和
没有其他来源的临时内容受保护；无安全候选时返回资源不足，不拆毁被保护预览。
快照超限先淘汰冷快照，不移除当前或仍持有热资源的 Camp。

## 场景接口与归属

Desktop 新增 `updateRetention(state): Promise<void>`：

```ts
{
  sessions: Array<{ campId: string; previewSessionId: string }>
  handles: Array<{
    handleId: string; previewSessionId: string; tabId: string
    lastUsed: number; visible: boolean; busy: boolean; recoverable: boolean
  }>
}
```

Preload 只接受有界、类型校验后的结构。Main 复核句柄所属窗口、Camp 和 session，再接受回收提示；
Main 保持 64 个逻辑句柄的权威统计，满额先同步选取和摘除最旧可恢复、不可见、非必要操作的句柄，再分配。
没有候选才返回 `too_many_open_files`。`onResourcesReleased` 投影 `{handleIds: string[]}` 到同一窗口；Renderer
幂等移除对应能力，能独立显示的文本/图片保留，依赖该句柄的站点与映射同时释放。并发打开不重复占位或选中同一候选。
这些方法在共享适配接口上可选；Web 保持 Host 原有的客户端资源限额，通过已有 restore 准备独立刷新候选，
不把 Desktop 的本机句柄权威复制到浏览器。

`bindCamp(campId)` 只选择当前显示和原生交互来源，不释放旧 session，也不等待旧站点关闭。读取与资源访问按
存活的 session 绑定检查，不要求其 Camp 当前可见。原生目录选择、系统打开等用户效果仍校验发起时的导航身份。
保留集合中的逻辑句柄和 token 不按空闲时间撤销；底层空闲描述符可关闭，下次实际读取按原来源和版本重验。
未完成打开、站点准备、文档/通道确认的原有期限保持独立。

加载身份为 Camp、previewSessionId、tabId、requestGeneration。切 Camp 不使请求失效；后台结果写回原 session，
不抢焦点或活动标签。同一加载复用请求。关闭、session 淘汰或更新代次拒绝迟到结果并释放新生成的资源。
热命中直接显示，不 open/restore、不读正文、不重建 Blob/iframe/站点，也不等待来源/版本检查。
冷恢复只加载实际可见的活动标签。新显式定位才能覆盖已保存阅读位置。

## 刷新与 HTML 保留

文件变化只设置 `hasExternalUpdate`、`externalUpdateVersion`，不清空或批量重读。刷新期间设置 `isRefreshing`，
失败保留旧副本并设置 `refreshError`；文件外部删除也不主动抹去已加载内容。新分页/资源读取继续检查版本，
句柄被回收后重新取得的版本不同，不与旧分页拼接，提示刷新。

`reload` 返回独立候选句柄，旧句柄、内容和资源仍有效。候选准备不能撤销旧 Markdown token 或旧 HTML 站点。
成功时同一标签一起切换句柄、内容和资源；显示提交后释放旧版本。失败/关闭/淘汰只丢弃候选，清理可重复调用。
HTML 候选必须通过已有通道达到根文档 `loaded` 且连接有效，URL 返回或 iframe load 本身不代表可展示。
不等待所有网络或所有脚本无异常。新旧实例、句柄共存计入上限，不能为候选先回收旧可见版本。

保留 HTML 必须保留实际 iframe 和站点；宿主容器身份跨 Camp 稳定，后台退出焦点和键盘范围。
最多 4 个活实例是有界保留策略，接受其脚本、轮询、网络继续运行，不是 CPU/网络硬上限。
不劫持作者 API、不伪造冻结，也不引入重页面监控调度。宿主不因隐藏主动刷新或重复准备站点。
通过原有认证通道接收 `reading-position {top,left}`，冷页面用 `restore-reading` 恢复有限滚动状态，不承诺任意页面状态回滚。

标签关闭、LRU、Camp 删除、窗口关闭、显式撤销相关访问时释放对应资源。普通回收不删除文件、Camp 或任务，
不停止 Runtime；外部已删除文件和页面脚本业务副作用不在刷新回滚保证内。
