---
document_type: contract
contract: file-preview
version: 12
status: accepted
authority: desktop-file-preview-wire
source_version: v1.58
last_updated: 2026-09-13
---

# File Preview v12

继承 [v11](file-preview-v11.md) 的来源、具体文件能力、路径呈现、Tab、源码预算和其他文件类型行为。
本版替换 HTML 的 srcdoc、资源改写及禁止网络/子 frame 策略；Markdown 保留既有资源协议。

## 场景接口与运行环境

`prepareHtmlSite({handleId, expectedGeneration})` 返回既有 OperationResult，成功值为：

```ts
{
  previewId: string
  generation: string
  origin: string
  entryUrl: string
  documentUrl: string
  contentGeneration: string
  contentVersion: FileContentVersion
}
```

`releaseHtmlSite({previewId})` 幂等释放同窗口实例，返回 `{released:true}`。它用于丢弃晚到内容，不能扩大或
替换文件能力。宿主生成并验证 origin，Renderer 在加载前再次检查 HTTP(S)、与主应用不同源、两个 URL
同属该 origin。正式 iframe 只使用 `src=entryUrl`、`sandbox="allow-scripts allow-same-origin"` 和
`referrerPolicy="no-referrer"`。默认执行作者脚本，无信任、交互或资源授权操作；不使用 History shim。

共享 `packages/html-preview` 拥有实例、资源读取接口、静态响应、注入位置映射和浏览器消息协议，不导入
Electron。Desktop Main 通过已有 handle、source authority、binding generation、content version 和 canonical
root 适配本地文件。未来 WebUI/MobileUI 可使用相同 descriptor、诊断和宿主 transport 接入可访问的 HTTP(S)
服务；本次没有远程分享、云部署或离线移动服务。

Desktop 每实例在 `127.0.0.1` 监听独立服务，使用唯一 `.localhost` 主机名维持 origin 隔离，即使端口复用也
不复用 origin。入口 capability 兑换独立的 HttpOnly、Secure、SameSite=None、Partitioned、host-only cookie，
跳转至不含凭据的文档 URL。每次读取仍检查 Host、cookie、请求来源与有效文件上下文；随机端口或主机名
不是访问授权。入口跨站重定向有仅针对该文档的一次导航窗口，之后子资源只接受同源请求。页面正常调用
replaceState、根相对 fetch 或 `?canvas=1` 均不依赖入口 query token。

## 资源与响应

站点根使用当前具体文件能力的 canonical root，保留入口在根内的位置；外部具体文件沿用既有临时目录范围。
`allowChildren=false` 时仅服务同一文件（含不同 query），不因 HTML 自动依赖扩张到附件父目录。
Desktop 还投影主应用私有目录排除项（userData、Core 数据和自动化服务目录），即使这些目录落在
较宽的既有文件范围内，也不能成为网页依赖；检查解析前路径和 realpath，返回 403。已明确打开的入口文件
仍可读取，确保托管附件入口可用；这一例外不扩大其依赖范围，不产生新的用户授权操作。

浏览器原生解析 `./`、`../`、根相对路径、CSS import/url、脚本、ESM/import map、动态 import、fetch、图片、字体
和内部 iframe。query 不进入磁盘文件名。资源服务逐段一次解码，拒绝编码分隔符、非法路径与向上越界；使用
realpath、打开后文件身份复核和实际相对路径 containment 检查 symlink，拒绝特殊节点。HTML 不写回磁盘；
不重排作者脚本、不扫描注入目录、不预先内联资源、不改写 DOM setter、不注入主应用样式。

GET/HEAD 提供真实状态、MIME、nosniff；HTML 上限 32 MiB、UTF-8 严格解码并 no-store，其他受支持静态资源
上限 256 MiB，以可取消流读取，支持 ETag/304 和单 byte range/206/416。不存在返回 404，范围外 403，未知
资源类型 415，超限 413，上下文失效 410。默认没有 SPA 回退；只有服务端配置明确给出 SPA entry，且为无
扩展名的缺失导航时才回退，缺失 JS/CSS/JSON 保持错误。

CSP 允许作者内联脚本/样式、HTTP(S) 依赖、网络连接和必要 frame，禁止 object，并限制 frame ancestors 为本实例
与宿主。Origin-Agent-Cluster 保持文档域隔离。保留浏览器 CORS、证书、混合内容和第三方嵌入限制，不关闭
webSecurity、不忽略证书、不做代理。普通网页失败不触发授权、依赖安装、构建或自动刷新。

## 诊断协议

服务在作者脚本前插入一个同步诊断脚本标签，保留所有原文字符及换行。记录插入行、列和长度，映射错误位置及
栈位置回原稿；落在注入区间中的位置为未知。注入代码不覆盖 History、fetch 或其他作者 API。

```ts
{
  previewId: string
  generation: string
  kind: 'script' | 'promise' | 'resource' | 'policy' | 'document' | 'channel'
  message: string
  resourceUrl: string | null
  line: number | null
  column: number | null
  stack: string | null
  timestamp: string // ISO timestamp
  status?: number | null // 仅资源服务实际观察到的 HTTP 状态
}
```

同步异常、unhandled rejection、资源 error、securitypolicyviolation 与站点失败统一到上述结构。服务端失败通过
同源、cookie 保护的 NDJSON 通道送入根页面 bridge；子 frame 不各自占用长连接，避免耗尽 HTTP/1 连接槽。浏览器不提供的状态或源码位置保持未知；捕获不代表脚本恢复，
跨域受限错误不补造细节。每个当前页面最多 100 项、message 2000 字符、URL 2048、stack 8000；资源按 URL 去重，
其他按类型、消息及位置去重。服务端已知状态可补全先到的浏览器未知状态，保持同一资源仅一项；不以未知结果
覆盖已知状态。宿主仅作文本呈现。

资源服务为请求分配递增序号，在生成每个 HTML 文档时记录当时的订阅起点。根 bridge 通过其 `documentId`
订阅；服务验证文档属于本实例，只回放和推送起点之后开始的请求错误。旧页请求即使延迟到下一页才失败，也不会
因完成时间较晚而进入下一页。子 HTML 的生成不改变根页面已有订阅的起点，不清空全站缓存。
站点只保留最近 100 项用于订阅回放，不使用站点累计去重/额度阻止下一页收集；页面本身负责去重和展示上限。

消息使用固定 protocol、previewId、generation、documentId、connectionId。宿主检查 `event.source` 为当前 iframe、
精确 origin、实例、generation、shape，并向当前 WindowProxy 发送新 challenge；连接完成前不接受业务消息。
新文档不得复用旧 challenge，旧文档消息不得污染新页面。同源子页面只能由真实直属 iframe/frame WindowProxy
建立独立 challenge 后逐级转发；跨域第三方页面内部异常不可观测，不假装已采集。

## 状态、交互与生命周期

准备请求超过 12 秒返回 `preview_timeout`，晚到站点自行释放。文档为准备/加载/已加载/尚未完成/无法确认/失败；脚本为尚未发现异常/有运行错误；资源为尚未发现失败/部分失败；诊断通道为等待/
连接/不可用。iframe load 仅触发当前窗口握手，不确认 HTTP 成功或文档完成。只有有效根文档状态消息或明确失败信号
更新确认状态；无桥接响应时，12 秒后显示“状态未确认”，展开后解释原因并提供重试，保留 iframe 内容，不覆盖已显示页面。
完整失败页仅用于明确的文档失败、无效预览站点或明确创建失败。

每个新建立的根 `documentId` 独立重置状态并启动 12 秒文档计时，当前文档报告完成/失败或实例释放才结束这一轮。
超时先连接但尚未完成的文档摘要显示“加载未完成”；之后收到真实完成仍可恢复。重复握手及 loading 重放不延长
或重启同一文档期限，子 frame 消息不能重置根计时器。新根文档清除前页诊断；加载后身份尚未确认时，不把前页
诊断显示成当前页错误。传输握手超时与文档超时分别管理。

正常加载完成不显示诊断摘要或额外状态行。有路径时，源码入口与临时加载/问题摘要并入路径行；无路径附件的
源码切换进入既有 Tab 菜单，仅加载或异常时在预览顶部出现临时反馈。详情默认收起、限高滚动并支持键盘操作，
不阻塞页面。重新加载中、文档失败、重试失败、状态未确认、加载未完成、加载中的摘要按此优先级呈现，已有问题
数量同时保留，详情继续分开呈现四类状态。重试期间禁用重复提交并保留旧页面与诊断；失败保留具体错误，成功
换代并重置展开状态。明确文档失败保留可访问的完整失败页。具体位置与文案见 [文件预览 UI](../ui/components/file-preview.md#html-运行反馈)。

源码切换通过原有 readText/readPage 读取未注入原稿，交互 iframe 保持挂载，保留输入、滚动与脚本状态；该模式
仅作为当前 Tab 的 Renderer 状态，不持久化。查找按当前模式选择源码或可见网页（含可访问同源子页）。页内定位保持；HTTP、hash 和作者路由不被
统一拦截，只有未被作者处理的可信 file: 点击进入已有 child_of_handle 行为。原生子 frame 导航只在有效预览子树
中开放正常 HTTP(S)，不能导航主应用或取得 Node、Shell、Preload、通用 IPC。

关闭 Tab、切换 Camp/binding、释放窗口与退出都取消请求、关闭流/监听端口并释放关联句柄。刷新成功撤销旧站点，
按新 generation 建站；晚到准备结果自行关闭。隐藏 Pane/切换可见 Tab 保持当前文档，仍受 30 分钟空闲 TTL。
旧站点被撤销后不得继续读取；刷新失败保留已显示旧内容及准确失败提示，不把失效旧站点宣称为仍可继续加载资源。

## 验证入口

HTTP/路径/权限/状态响应由共享包测试负责；Main 生命周期由 FilePreviewService 测试负责。
`pnpm test:html-preview` 通过正式 Provider/Pane、Main service、真实 Electron 及普通 Chrome iframe 分别验证 History
初始化、query 子画布、依赖与诊断。原始两个交互稿通过显式 sample 路径分别验收，摘要、可见内容和画布联动分别记录；
`pnpm test:file-preview-layout` 保留文件 Tabs、查找、阅读位置及布局回归。具体证据见
[v1.58 HTML 预览验证](../versions/v1.58/html-preview-http.md)。
