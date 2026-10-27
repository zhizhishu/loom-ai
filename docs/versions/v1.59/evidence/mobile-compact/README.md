# Mobile 最终紧凑稿与本机安装

实现来源：`85c7519c5736c5cc06afd5518dd5c3e4e30d6eb6`。本轮只修改共享前端的手机展示、面板导航及相关验收；保留任务分支上已提交的 Linux 修复，未纳入其他执行者的未提交文件。

- [真实手机入口流程](validation.json)：使用待安装 App 内的 Release Host 与 Web 资源，覆盖更多菜单、任务真实创建、三个二级面板返回执行、返回列表、标签页草稿恢复、附件、单聊、管理页及六种计划。
- [执行组件](execution-validation.json)：生产共享组件、固定模拟 Run，360/375/390/430px 和 844px 横屏、日夜主题、最多两个头像与 +N、十队员换行、独立 Run 开合、展开 command 32px、阅读字号设置和减少动效。
- [独立 Server](server-validation.json)：实际 Server，保持既有更新说明入口与渠道能力边界。
- [打包 App](packaged-app-validation.json)：独立 userData、Skill Library 与 MCP config，真实 Host 就绪、创建会话、Desktop 原有详情入口和任务浮层开合。
- [安装交接](install-validation.json)：源、暂存、规范路径均通过 ad-hoc 签名、arm64 架构和 Bundle ID 检查；App/Host/Core/CLI、app.asar 及 139 个 Web 文件摘要一致。旧 App 保存在该记录的 backup 路径。

`pnpm typecheck`、相关 Vitest 28 项、Mobile 三组自动验收、`pnpm package:mac:daily` 通过。包内真实 Web 流程另行复验通过。通用文档门禁按仓库流程运行。

安装采用非终止交接。App、Host、GPU/网络 Helper 和原主 Renderer 的 PID 与启动时间保持不变；快照间另一个较晚创建的辅助 Renderer 30709 已退出，原因未确定，记录保留此差异，不宣称六个 PID 全部存活。安装脚本没有发送终止信号。当前主进程仍为旧版，退出后从 `/Applications/Rovai AI.app` 显式打开，再刷新 Web/Mobile 页面启用配套版本。

这些结果不替代实体手机软键盘、图库/拍照、后台恢复、网络切换或其他操作系统验收；执行命令 fixture 不冒充本轮真实模型执行。整体跨平台 Task 继续进行。
