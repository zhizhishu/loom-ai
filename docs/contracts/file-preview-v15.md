---
document_type: contract
contract: file-preview
version: 15
status: accepted
authority: desktop-file-preview-wire
last_updated: 2026-09-16
---

# File Preview v15

继承 [v14](file-preview-v14.md) 的窗口保留、LRU、HTML 沙箱及候选刷新合同。
附件读取改动由 [Camp Attachment v10](camp-attachment-v10.md) 规定。

已解析本机附件均可展示实际位置，不按 `.rovai`、Application Support 或 Managed 目录隐藏。
消息标签保持文件名；hover/菜单可查询位置，复制使用完整绝对路径；Native 可定位文件管理器。
内部 `camp.attachments.location` 复用 exact owner 授权与已存位置，不读取全文；不存在可解析记录时返回 null。
Web 返回服务器路径，ResolvedFilePreview 可含 absolutePath；它只用于展示与复制，不传入本机文件管理器。
旧文件的读取校验和权限不随展示改变。

新附件及其 HTML 相邻资源使用实际来源边界。Desktop 显式附件目录支持相对资源，仍阻止越界和指向其他私有位置的链接。
Web HTML 的静态预览壳按 [Host Web v2](host-web-v2.md#workspaces-uploads-and-resources)采用可信同来源策略，
原生 Storage 归访问设备浏览器，可访问同来源主页面及登录材料。资源仍通过已授权文件句柄提供 `/preview-assets/<随机能力>/<相对路径>`。
资源能力只允许该来源 root 内已支持类型的当前资源，不在资源 URL 中传递编辑 Session；每次核对 Session、记录与目录边界。
句柄释放、Camp 删除、源失效或 Session 撤销使读取失效；不复制目录或新增永久站点。
只有资源 GET/HEAD 允许 opaque Origin 与资源 query（例如缓存参数），无 credentialed CORS；业务 API 的同源/认证/无 query 规则不变。
资源响应及直接导航沿用原有 CSP sandbox；本轮只调整 `/preview.html` 静态壳策略。HTML bridge/查找与原始源码视图保持。

图像显式大图/刷新及返回外部编辑器后读取当前源，失败保留已有图像并提示；文件预览沿用原外部变更通知与候选刷新。
切 Camp 不清空缓存、不扫描全 Camp。路径显示不触发全文摘要，实际内容读取可保留缓存一致性的当前内容标识。

Run Evidence 的 `open_current` 以 exact Camp、AgentRun 和 execution epoch 为身份边界。Core 优先使用该 Run
`workspace_json.executionRoot` 中的有效绝对路径；只有历史 Run 缺少有效值时，才回退到 active directory Camp 的绝对
`project_path`。Evidence 文件路径仍必须是无父目录跳转的相对路径，并继续经过详情/摘要一致性、Main realpath、普通文件及
既有预览安全校验。该规则允许 Mission worktree 新增文件，并禁止同名文件被错误解析到 Camp 原项目目录。
