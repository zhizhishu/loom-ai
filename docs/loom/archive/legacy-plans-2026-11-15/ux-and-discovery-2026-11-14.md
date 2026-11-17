# LOOM 四端能力发现与工作区体验迭代 — 2026-11-14

## 结果和完成比例
本轮仅在已验证的本机隔离 LOOM 实例发布。整体产品完成约 65–70%，这是工程估算，并非正式需求项自动加权；既有四端能力适配、安装器、远端图形桌面与跨目录授权仍非全部交付。

## 经证实的双重故障
旧 Host 的扫描上限是 64 KiB，而本机 Claude 主配置 .claude.json 为 77,441 字节，导致 Claude/DSH/Pi 三个同源投影均显示 native_config_unreadable。新 Host 仅对固定的 Claude 主配置使用有界 256 KiB 读取，并将相同限制用于别名扫描和 MCP 导入 digest 重读；其他文件仍为 64 KiB，不执行原生 Hook/MCP，浏览器不获取账号密钥或正文。
前端原本默认按当前 Pi 运行端筛选，隐藏了 Claude 原生来源；已改为默认显示全部来源，增设“Claude 原生主来源”筛选及四种类别数量和源诊断，不混淆发现、已导入、已选择及实际执行。

真实 Host 只读回执：旧版三处 .claude.json 均 unreadable；新版三处均 read，各有一项 MCP，errors=[]。新版投影计数 Skills 97、MCP 4、Hooks 60、Rules 4，包含跨运行端同源别名，不能视为 165 个互不重复资产。证据：_artifacts/loom-next-ux-20261114/native-before.json、native-after.json。

## UI 和工作区
主管亲自写 UI、执行最终 review：LOOM 编织机器人标志已用于标签 favicon 和应用顶栏；左右分栏都添加可调整分隔条、CSS变量和本地宽度保存；助手会话行新增快捷编辑；工作创建/新建对话支持已登记的项目根与 Host 显式挑选目录；长列表离屏渲染以及常驻侧栏取消大面积 backdrop-filter。原有功能与 Core 任务/成果合同不变。

“工作区”是默认执行项目根，跨其他目录仍需独立工具或 Host 授权。多根工作区统一授权不是这一轮已交付功能，禁止无权限读取其他目录。
目前仅进行了去大面积滤镜及离屏优化，没有 FPS / 端到端延迟基准，不应称所有卡顿已根除。

## 实际验证
- Rust native_discovery 24/24 通过，含合成超 64 KiB Claude JSON 扫描、相同 digest 的导入复读及超 256 KiB 拒绝测试。
- LOOM UI 214/214 通过，TypeScript typecheck 通过，生产 Web build 与 Host 构建通过。
- 真 Chrome 已看到两个分栏调整控件、23 个助手快捷编辑入口和 favicon；从 Hanzi 行正常点击可进入“你的助手 / Hanzi”编辑面板。
- 页面合成键盘事件让左栏从 264 变成 288px 并持久化到 localStorage。browser-cli 键盘发送返回 OK 但未改变值；一次真实指针拖拽自动化超时，之后只读检查仍是 288px。**真实鼠标拖动验收未完成，不能宣称通过。** 数学约束及持久化代码经过单元测试。
- 本轮未重新执行真实模型消息或五阶段返工链，沿用上轮单独证据；扫描成功不等于本轮所有能力生效。

## 运行和恢复
工作目录 C:/Users/echo/Downloads/claude/skill-cli/loom，独立地址 http://127.0.0.1:64851/，双击 Start-LOOM.cmd 可启动/打开。
换版前旧 Host、旧 Web 首页、runtime、MCP 与 SQLite 一致性备份在 _artifacts/loom-next-ux-20261114/before-upgrade/；变更版本及哈希见 staged-upgrade.json。其他常用客户端/生产配置和用户数据未修改，旧 WIP 未整体 reset、clean、commit、push。

## 后续最值得做的事项
1. 在真实鼠标和触屏环境确认分栏拖拽；验证最窄窗口与持久化。
2. 原生 MCP 额外字段目前在扫描时可能被标 importable，但最终 Core 白名单拒绝，需前移兼容性状态提示，不可跳过安全验证。
3. 做用户级多根工作区授权页面，要求跨目录逐项显式许可，Core 保留单一授权事实。
4. 对实际卡顿进行交互耗时和事件刷新采样，再决定是否引入虚拟列表与请求合并。
5. 跨四个 Runtime 分别做配置装载和执行留证；DE-BERO、本机正式全仓发布文档门禁另做。

本轮证据优先于旧状态表；上一轮工作台与 Pi 协作链证据仍见 docs/loom/ship-2026-11-14.md。
