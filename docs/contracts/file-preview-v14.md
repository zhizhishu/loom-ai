---
document_type: contract
contract: file-preview
version: 14
status: accepted
authority: desktop-file-preview-wire
source_version: v1.59
last_updated: 2026-09-16
---

# File Preview v14

继承 [v13](file-preview-v13.md) 的窗口预览会话、容量、LRU、文件能力与候选刷新合同。本版明确受管 HTML
站点无空闲到期，并分离页面消息通信与 HTTP 资源诊断；不增加保活、页面冻结或监控系统。

## 受管站点

`HtmlPreviewSiteOptions.idleTimeoutMs` 支持 `number | null`；`null` 不创建空闲关闭计时器，省略时保留独立站点
原有 30 分钟默认值。Desktop Main 为受管站点显式传 `null`。切 Camp、隐藏或没有资源请求均不关闭站点。
关闭标签、LRU、Camp 删除、窗口退出、访问撤销或刷新成功替换旧版本时，沿用原资源层释放入口。
未完成操作、文档握手和加载超时保持独立，不能借此取消。

## 页面通信与资源诊断

页面 `postMessage` 继续负责文档状态、脚本错误、查找、滚动与导航。HTTP 诊断流只补充服务器资源错误。
已有受校验的 `source/origin/previewId/generation/connectionId/documentId` 消息封装新增：

```ts
{ type: 'server-diagnostics', state: 'waiting' | 'connected' | 'unavailable' }
```

宿主只接收当前已认证根文档的状态；断开或恢复不修改页面通信、已确认文档状态、焦点或 iframe。
无 HTTP 诊断流的 Web 静态壳预览不启动连接，也不因缺少该流显示故障。
HTTP 断流不再发送含糊的 `channel-unavailable`，不写入永久问题列表；恢复清除对应暂态故障，保留真实脚本和资源错误。
辅助故障仅进入默认折叠的中性详情，文案与呈现见[文件预览区](../ui/components/file-preview.md#html-运行反馈)。

## 有限恢复与刷新

每个根文档最多重连三次（1、2、4 秒退避）。同页重复握手、后台显示切换或重连成功均不重置额度。
每次连接建立有 12 秒超时，已建立的空闲诊断流没有固定到期。先释放失败请求及 reader，再创建下一个请求；
每个根文档同时最多一条流，子页面继续经页面通信转发错误。
权限拒绝或站点不存在（403、404、410）停止重连；页面离开、关闭或淘汰取消请求、reader 与待执行重连。
不添加心跳，不重建页面，不用新的页面握手恢复 HTTP 诊断。

候选刷新仍要求根文档 `loaded` 且页面通信有效；HTTP 诊断健康不参与提交或失败判断。
候选加载失败保留旧页面及资源，新旧资源短暂共存继续计入原容量限制。
