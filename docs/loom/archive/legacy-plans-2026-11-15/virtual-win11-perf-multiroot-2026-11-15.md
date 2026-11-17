# LOOM 无实体屏幕、拖拽、性能与多根工作区 — 2026-11-15

## 用户场景与此次验收
Windows 11 主机没有固定物理显示器，远程操作可能由 UU 虚拟显示或 RDP 提供，显示器、DPI、屏幕尺寸会变化。真实 Windows 状态为 SM_REMOTESESSION=1，读到一个 2560×1440 显示区域。本次不安装/修改任何显示驱动，不碰 UU/RDP 客户端和真实 Claude、Codex、DSH、Pi 配置。

当前仅部署在隔离 LOOM 本地预览 http://127.0.0.1:64851/，不是正式多平台发布。通过 Playwright Python 启动独立 Chromium headless，CDP mouse.move/down/move/up 是实际浏览器指针输入，不是 JS 伪造事件。验证：
- 左栏 264→364px、右栏 470→540px，持久化且页面刷新后宽度相同。
- 超级分辨率模拟设备像素比 DPR 2 时仍能真实拖拽、保存、刷新恢复。
- 浏览器 CSS viewport 1440、1024、900、801 宽度变动时，保持主聊天区可读（至少 320px），恢复尺寸后用户保存的宽度回归；窗体过窄时附栏遵守响应式压缩，而不是假定三个面板的最小宽度可全部同时容纳。
- 快捷键 ArrowRight 调宽由真实浏览器键盘执行并写入持久化设置。
实测 receipts：_artifacts/loom-hardening-20261115/browser-before.json、browser-after-batch.json、browser-superdisplay-dpr2.json、browser-virtual-manager.json。此前 agent-browser CLI 拖拽超时属于自动化通道结果，不是分栏真实失败。

## 性能更改与可量化结论
旧前端的首次工作视图刷新产生 **175 次**独立工作详情 RPC（六种数据接口每一 Mission 重复读取）。先加入事件驱动的 WorkBundleCache、相同请求去重和任务签名缓存；再在 Core 增加只读 loom.bundles.getMany，单请求最多 8 个 Mission，限制总返回 3 MB，拒绝重复/非法 ID 与额外字段。旧 Host 不支持时仍可回退六类原接口，错误不会伪装成空成功。

新 Host 在真实认证会话中，首次页面活动的旧六类 RPC **0 次**，批量接口 **2 次**；真实读取 **8 个 Mission** 及原有六类数据形状，异常请求（空、重复、路径逃逸、九项超限、附加 path）均被拒。运行中的任务 0，扫描错误 0。

前端再将助手工作室、连接设置、能力库和会话弹窗惰性加载，保持第一次打开后实例不卸载，以免关闭丢失未知执行结果。Vite 主入口脚本从约 **1.40 MB → 1.25 MB**（gzip 从约 462 KB → 418 KB），减少首屏需要解析的 JS；对长历史 Markdown 做 memo/useMemo，侧栏拖拽帧内更新采用 requestAnimationFrame 合并。

严格的性能边界：旧浏览器 longtask 样本峰值约 502ms；后续样本伴随 Rust 本机大型编译，有显著 CPU 竞争，峰值和 FPS 不具有可比性。这次能够证明请求数与首屏加载体积下降，但**不能宣称所有卡顿或长任务已消失**。后续可在无编译负载状态下补同一会话和1000+消息场景的连续 p50/p95。

## 多根项目工作区及权限事实
新增「工作目录」入口（左侧导航及设置）、当前对话头部的执行根标签，浏览器内可从 Host 显式选择目录并加入现有项目列表，设置默认项目根、取消收藏、从其他已登记根直接启动新 Work。RoomDialog 使用默认目录前要求该路径仍在 Host 已登记项目列表，并再次执行 workspaces.validate；仅 localStorage 字符串**没有**授予根目录访问权限。浏览器独立实际验收：已登记项目显示、设置默认成功、在该根打开新建工作弹窗成功，未发送模型任务和未写用户项目文件。

这实现**多项目/多根选择和按根启动**，不是对所有四个原生 Runtime 的同一 AgentRun 跨根授权。Claude/Codex/DSH/Pi 是否能越出当前根，仍应交由真实原生工具权限与用户确认。MCP roots/list 是客户端提供的根目录提示，不能当成操作系统授权或写入许可；不能因为目录出现在列表中就无条件给予模型读写。要完成真正同 Run 多根，需要 Core 保存不可变的每 Run 附加根权限/生效期、可撤销的显式许可，各 Runtime 单独适配并在实际执行端留证。这一项尚未安全交付，不在本次验收通过范围内。

## 来源/原项目借鉴（FusionSearch 实际执行）
- Playwright CDP/Mouse 输入：https://playwright.dev/docs/api/class-mouse
- React 组件 memo：https://react.dev/reference/react/memo
- Chrome 性能测量/longtask：https://developer.chrome.com/docs/devtools/performance
- VS Code 多根工作区：https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces
- VS Code Workspace Trust：https://code.visualstudio.com/docs/editing/workspaces/workspace-trust
- MCP 官方 filesystem server 实现：https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem
- MCP Roots 规范：https://modelcontextprotocol.io/specification/2025-11-25/client/roots
本轮参考模型与交互/安全边界，不直接复制第三方项目或引入不受审计、全盘读写的 MCP 服务。检索与输出见 _artifacts/loom-hardening-20261115/ 下 fusionsearch 各 result.json。

## 开发安全事件与恢复审计（必须保留）
改动过程中，我的一个 Python 文件写入参数错误曾将 crates/rovai-core/src/application.rs 截断为 0 字节。发现后立即停止使用该损坏文件，从 2026-11-14 09:48 UTC 保留的完整最终源码归档 _artifacts/loom-workspace-release-20261114/resume-02/final-source.tar.gz **原子恢复** application.rs（1,574,101 字节），再通过 AgentDock staged patch 加入只读批量接口。恢复证据与 SHA：_artifacts/loom-hardening-20261115/application-recovery.json；新版 cargo check/Host 构建、Web 类型检查、全套 LOOM UI 测试和真实 Host 只读端点重验均通过。原有预览 Host、首页、runtime、SQLite 一致性备份与 MCP 配置在 _artifacts/loom-hardening-20261115/before-batch-upgrade/，可回滚。

不能从已知归档证明在其保存时间之后、意外截断之前 application.rs 不存在其他未归档未提交改动。这个**源码差异风险**仍需和 Git 工作树及此前交接对账，不能把「可编译、隔离实例可运行」误写成「所有 WIP 完全无损」。不做全仓 reset/clean/强制提交、推送或声称 CI 全绿。

## 此刻结论与未解决的边界
本地隔离预览的鼠标真拖拽/屏幕多尺寸与DPR、缓存批量读取、首屏代码拆分、项目根目录注册和切换已落实并经过针对性验收；原生同一 Run 跨多个根的可撤销授权、安静环境连续 FPS 量化、上面提到的源码恢复时间差核对及正式全仓发布门禁不应销项。
主要项目进度见 TASK.md，技术回执在 _artifacts/loom-hardening-20261115/postdeploy-report.json。
