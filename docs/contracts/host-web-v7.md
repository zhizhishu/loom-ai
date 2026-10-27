---
document_type: protocol-contract
contract: host-web-v7
authority: shared-host-web-transport
status: accepted
version: 7
source_version: v1.72
last_updated: 2026-10-18
---

# Host Web v7

继承 [v6](host-web-v6.md)，替代其中上传额度、下载与预览共用读取预算、全部下载经认证 Fetch/Blob 的规则。
登录 `protocolVersion` 仍为 5；没有新的附件资产、持久票据、数据库迁移或模型输入协议。
Core 拥有来源与业务权限，Host 拥有传输，浏览器下载管理器拥有保存进度与取消。

## 能力与独立预算

登录、恢复/分叉 Session 和 `GET /api/v1/capabilities` 返回 `fileTransfers`：

```json
{"uploadMaxBytes":31457280,"nativeDownload":true,"downloadMaxBytes":null,"downloadAdmissionSeconds":120}
```

- 浏览器单文件上传最多 30 MiB，即 `30 × 1024 × 1024` 字节。传输附加信息不计入文件额度；
  整个 multipart 请求另外限制为文件额度加 16 KiB，intent 字段最多 8 KiB。
  总请求额度失败使用 `upload_envelope_too_large`，不冒充按文件字节累计的 `upload_too_large`。
- 现有 Web 预览保持独立的 20 MiB 读取预算和类型/解析限制。上传不保证 Agent 能处理内容。
- 下载不使用上述两个额度。Host 启动环境 `ROVAI_WEB_DOWNLOAD_MAX_BYTES` 可设独立非负整数字节额度；
  未设置时不限文件大小，`0` 只允许空文件。无效配置使 Web 启动失败。
- 旧 Host 没有能力字段时，新客户端继续用旧 20 MiB 上传边界和原有有界预览下载；
  不能把大文件降级为 Blob，也不能宣称支持独立下载。新 Host 对旧客户端保留原有有界字节端点。

## 上传与原结果恢复

`POST /api/v1/uploads` 继续使用认证 multipart `intent`、`file`，逐块写临时文件并计算 SHA-256。
按实际文件字节累计上限，不信任声明大小；64 KiB 写盘缓冲形成背压。连续接收/写盘等待上限为 60 秒。
只有完整接收、大小/摘要验证和 Core 来源绑定成功，才返回成功。

新客户端携带 `X-Rovai-Upload-Command-Id`，必须匹配 intent.commandId。Host 保存最多 256 个临时尝试状态，
按编辑身份和原 commandId 区分；在途尝试不能被另一请求覆盖。该记录只证明传输是否已结束且从未提交绑定，
成功来源仍只能由 Core 原事务回执证明。旧客户端不携带头时保留原恢复语义。

`POST /api/v1/uploads/reconcile` 先查 Core：有原回执则返回原结果；没有回执且 Host 能确认原尝试已结束、
未提交绑定时返回 `{state:"unbound"}`；其他情况为 `{state:"unknown"}`。Host 重启或记录淘汰后不能凭记录缺失推断未绑定。

浏览器显示准备文件、传输百分比、确认附件三个阶段。传输百分比基于 multipart 请求进度，不作为文件额度或绑定成功证明。
固定同来源上传端点使用 XHR 获得上传进度和 abort；必须显式 Bearer，Host 不以 Cookie 认证，端点/代理不重定向。
异常响应地址拒绝接收，并以原 ID 核对。其他业务 Fetch 继续拒绝重定向。

取消前未提交绑定的临时文件清理；可能已绑定则保留并核对。取消不撤销已提交的 Core 事务。
晚到回执不能自动把已取消的上传加入客户端正文附件；私聊以 Core 当前快照为准，界面提示核对附件。
未知结果保留原 ID，不自动重发；显式重试先核对再复用相同 ID/内容。原请求仍持有待处理文件时拒绝重复选择。
取消或刷新已丢失文件正文时，重新选择相同目标和摘要的文件会先核对；仍未知则复用原 intent 重传完整文件，
不会换 ID 新建绑定。这不是分片续传。
确认未绑定后可以重新选择。取消或刷新后的成功回执只保存原 intent，不保存文件字节；
重新选择同一目标和摘要的文件时先取原回执，不创建第二个来源。收起提示不丢失待恢复的原 ID。
错误/取消不清正文或其他附件。

## 下载申请

`POST /api/v1/downloads` 经普通 Bearer 认证，只接受以下二选一封闭请求：

```text
{kind:"source", source: OpenFilePreviewRequest}
{kind:"preview", handleId}
```

source 支持现有 attachment owner locator、message_reference、camp_workspace、run_evidence 的 open_current、
run_activity_file，以及同一已证明编辑身份下可重新授权父句柄内的 child_of_handle；不接受单独路径、任意新来源或外部跳转。
Core 按原来源重验归属、私有作用域与删除状态。Host 只准入存在、可读、允许的普通文件；空文件有效。
source 与 preview 均下载 GET 准入时打开的当前文件，不要求预览成功、刷新或绑定所见版本。
旧客户端可继续携带可选字符串 expectedGeneration；下载忽略该兼容字段，不提供严格模式。
预览读取自身的摘要/版本检查，以及 legacy managed 来源既有的完整性验证不变。
预览句柄及 child_of_handle 按已证明的编辑身份归属；同页重新登录后重新检查原来源，
新票据只绑定当前 Session，旧 Session 和旧票据不复活。另一个编辑身份不能借用旧句柄。
准备阶段只授权来源、安全打开文件并检查元数据，不扫描下载正文。阻塞打开任务持有准备额度至实际结束，
HTTP 取消不能提前释放仍在执行的文件操作额度。

成功返回 `{url,name,byteSize,expiresInSeconds:120}`。url 只能是当前 Host 的
`/api/v1/downloads/<64位小写十六进制票据>` 相对地址。浏览器校验固定路由及连接代次后点击原生下载链接；
迟到、退出或换连接的结果不得触发下载。页面不 Fetch 文件正文或组装 Blob。

## 下载专用授权

`GET /api/v1/downloads/{token}` 与 HEAD 使用独立下载凭证，不要求普通 Bearer；这是定义过的认证路由，
仍执行相同 Host/Origin、无查询参数、无外部重定向规则。票据只有随机 256-bit secret，Host 仅存摘要、
单调时钟准入期限、原 Session 弱引用、经授权解析的精确路径与文件名；没有可改写的路径参数或普通业务调用能力。
Host 重启全部票据失效，普通 Session 的持久规则不变。

凭证是持有者可用的下载能力。Session 绑定提供权限派生与新请求的准入撤销，不承诺复制 URL 后的浏览器身份不可转移。
票据不进入消息、恢复存储、遥测或普通访问日志，不作为分享链接。代理必须排除/脱敏该路由，诊断使用非凭证操作标识。

申请时完成 Core 来源授权；GET/HEAD 只校验票据期限、Session、安全打开及独立下载额度，不再次查询 Core。
安全打开逐段拒绝符号链接或 reparse point 替换，并要求普通文件；不能把票据改成其他路径的读取权限。
长度取自本次打开的文件，即使申请后同一路径的文件被编辑或替换，也按当前文件准入。

退出、Session 到期/撤销、轮换凭据阻止后续准入；关闭 Web 停止接受新连接，Host 重启使票据失效。
来源失效或 Camp 删除阻止新申请，已签发的票据在 120 秒内、Session 仍有效且文件仍可打开时继续可用。
已准入流不监听 Session、Core 或业务事件，不周期重验、不暂停检查，不因到期或业务撤销主动中断。
实际连接断开、读写失败或空闲超时仍结束传输并释放资源；不承诺关闭 Web 时实时撤销每个已准入响应。

不采用一次访问即消耗票据。HEAD 验证元数据但不读取文件正文、不消耗 GET 机会；Range 当前忽略并返回完整 200，
`Accept-Ranges: none`，不承诺续传。额度为准备并发 4、活动下载全 Host 8/每 Session 2/每票据 1、
缓存票据全 Host 256/每 Session 16。已发完正文的票据在空闲时保留重试能力；缓存紧张时优先回收较早完成且
当前没有活动 GET 的票据，正常连续下载不兼作两分钟次数限流。未使用/活动票据仍保留有界容量；全部不可回收时
返回单独的 download_ticket_capacity，区分活动并发繁忙。HEAD 不标记完成。票据不阻止空闲 Session 回收，活动下载持有 Session。

## 数据与终止

响应使用 `Content-Type: application/octet-stream`、`Content-Disposition: attachment; filename*=UTF-8''…`，
文件名来自服务端元数据并消除路径分隔/控制字符。`Content-Length` 是 GET 准入打开时的文件长度，空文件为 0；
`Cache-Control: no-store, no-transform`、`X-Accel-Buffering: no`，代理不得压缩或改写文件正文。

64 KiB 读取块和单槽通道限制应用内存；慢网络约束读盘，60 秒无进展终止。
文件 I/O 在 Core 普通命令队列之外，传输 lease 随 HTTP body 完成、失败或断开释放。
中止只取消读取，不删除/冻结/复制源文件，不延长源文件寿命。

文件句柄不是快照。传输直接发送声明长度的字节，不计算下载正文摘要、不保留尾块或重新打开路径校验。
并发原地写入可能读到混合内容，不保证旧预览版本或检测全部变化；生成中的文件应在写入完成后下载。
发送长度以准入值为界，之后追加的字节不进入本次响应；截断造成短读或读盘失败时中断，不能把不足长度的响应当作成功。

响应前错误没有 attachment 头，返回 JSON；已开始响应的错误使 body 失败，不正常 EOF、不附加 JSON/HTML。
Host 发完字节不证明浏览器写入用户磁盘。
中断输出最小结构化日志：web.download.interrupted、非凭证 operationId、阶段、安全错误码和 bytesEmitted。
bytesEmitted 只代表已交给 HTTP 正文的字节数；日志不含票据、完整 URL、来源对象或敏感文件路径。

| 错误 | HTTP | 意义 |
| --- | --- | --- |
| session_required | 401 | 原 Session 已失效 |
| source_not_authorized | 403 | 来源、归属或作用域无效 |
| file_not_found | 404 | 已授权文件不存在 |
| download_expired | 410 | 票据未知或准入过期 |
| download_too_large | 413 | 独立部署下载额度 |
| download_capacity | 429 | 准备或活动传输并发额度 |
| download_ticket_capacity | 429 | 票据缓存已满，且没有可回收的完成票据 |
| core_unavailable / download_timeout | 503 / 504 | 申请来源授权不可用或文件操作超时 |
| file_unreadable / not_regular_file / read_failed / download_unavailable | 400 | 不可读、非普通文件或其他读取失败 |

## 界面与边界

附件卡片和消息文件引用先打开查看区，再在该处下载；查看区与预览失败页复用同一动作，手机可直接点击。
申请中只在图标显示“准备下载…”状态并阻止重复点击；启动后仅以无障碍反馈告知“已交给浏览器下载。”，不显示下载完成或已保存。
不支持预览/超过预览预算时：“此文件暂不支持在线预览，可下载到本机查看。”；权限或缺失错误如实保留。
预览内容和消息在申请失败后保留。后续下载进度/失败由浏览器处理。

首期完整文件传输，不增加分片上传、断点续传、目录打包、公开分享、历史快照、批量下载或独立下载中心。
