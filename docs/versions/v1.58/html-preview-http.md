---
document_type: implementation-report
version: v1.58
lifecycle: current
authority: implementation-evidence
status: completed
last_updated: 2026-09-13
---

# HTML HTTP 预览实现与验证

本增量按用户确定的正式链路改造执行，工作分支 `rovai/html-preview-http`，起点 main
`decdedda72de8feadfa3380f3e9d02c07374cf4c`。范围为 HTML、必要的共享接口、桌面文件能力适配与诊断 UI，
不改其他文件类型或作者文件。提交前同步至 main `cc91ec0d1`，两处版本文档追加冲突保留双方记录。当前规范见 [File Preview v12](../../contracts/file-preview-v12.md)。

## 实现

- `packages/html-preview` 提供独立 loopback HTTP 实例、cookie capability、范围检查、静态响应、原稿位置映射和
  浏览器通道；不导入 Electron。不同实例拥有不同 origin，权限检查独立于端口和 URL 随机性。
- Main 复用 FilePreviewService 的来源、handle、Camp binding、generation、version 与窗口生命周期；旧 HTML
  srcdoc wrapper 退出，Markdown 原协议保留。正常浏览器依赖与子 iframe 无资源重写或 History 修补。
- Desktop 私有数据目录即使位于较宽文件范围内，也不作为网页依赖提供；直接路径和 symlink 均验证 403，
  明确打开的入口与范围内普通 JSON 仍可读取。未将托管附件资源根整体列为私有目录。
- 正式 Provider/Pane 使用 descriptor；错误详情不覆盖已显示内容。源码模式沿用原有只读读取、分页与查找。
  新通道验证 source/origin/实例/generation/挑战/文档身份，同源真实子 frame 逐级转发诊断。

## 先失败、再验证

最小 History 与 query canvas 样本首先通过旧正式 Provider/Pane + Main service 运行，分别出现 History SecurityError
和内部 `file:...index.html?canvas=1` 加载失败。它们是两个独立业务断言，未用一个 load 事件替代二者。
迁移后检查实际正文、内部 Canvas ready、主题回执，并独立检查诊断连接。

原始交互稿逐字复制到隔离临时资源目录后验收，不修改磁盘原稿或 History API：

| 样本 | SHA-256 | 已观察结果 |
| --- | --- | --- |
| 原始 Runtime 启动稿 | `099d6f1c741df8839ea960d4f986fd86cf5e0adc0c29f303f197581a5aa36b69` | `#view` 实际渲染运行时列表、2 个子块、`#runtimes`，History 保持 native |
| 渠道连接稿 | `0014254c7dfabd8bfac80909cace65357e9ec376e2e756d2f1bffe04cd34f8ec` | query 子页实际渲染渠道与 Bot 内容；外层真实主题按钮使内层 day → night；可见画布约 974 × 622，截图复核完整页面 |

下载目录中的 Runtime 文件已变化（摘要 `a0922560d633bd3cd6d0a497707d9f39de229d3b7dd2ed2f3eff3fb5f0b7cafc`）；
它的通过不作为原始故障稿的唯一证据。最终原始附件使用上表摘要单独复验。

资源集验证 CSS/@import/url、根相对图片、经典脚本、import map、ESM、import()、JSON fetch；独立 HTTP 依赖的脚本、
样式、JSON、字体及外部 iframe 成功加载，无 CORS 头的请求仍被浏览器拒绝。8 个内部 frame 均完成各自 JSON 请求，
诊断采用每根页面单一流，避免占满 HTTP/1 连接槽。故障集验证缺失
CSS/图片的 HTTP 404、同步异常、Promise rejection、同源子页面异常与已渲染正文同时存在；原稿位置显示为
`errors.html:3` 与 `child-error.html:1`，未显示注入后伪位置。重复资源错误归并为同一项，服务端实际 404 补全浏览器
先到的未知状态，最终仍为 5 项问题。外部脚本一直 pending 时，文档与诊断状态独立，12 秒后显示“尚未完成加载”并保留正文。
源码逐字匹配磁盘文本，切回页面保留临时交互状态；刷新换代及旧站点撤销、Tab 关闭撤销均有正式组件断言。

普通 Chrome 使用独立 profile、HTTP 宿主页和同一个共享服务及 HostChannel；从生产查找桥获得 History 正文、
内部画布正文和 module/dynamic/JSON/classic 结果，三页诊断均为空。无 Electron、Preload 或 Core 依赖。

## 验证命令与证据边界

自动入口：

```bash
pnpm test:html-preview
pnpm test:file-preview-layout
pnpm test:file-reference-navigation
pnpm test:desktop-bridge
pnpm typecheck
pnpm test
pnpm build:desktop
pnpm docs:test
pnpm docs:check
DOCS_BASE_REF=cc91ec0d10d3ccfe10d77ccebfeadebea7e64fd1 pnpm docs:check:ci
```

`ROVAI_HTML_HISTORY_SAMPLE`、`ROVAI_HTML_CANVAS_SAMPLE` 为可选的原始文件验收路径。测试先复制到临时资源目录并
打印摘要；默认回归不依赖本机原稿。`ROVAI_KEEP_HTML_PREVIEW_FIXTURE=1` 保留隔离 userData、截图和资源，
`ROVAI_TEST_CHROME` 可指定普通 Chrome 可执行路径。Chrome 缺失时明确标记该项未执行。

Electron 和 Chrome 均使用临时绝对 userData/profile，未连接日常 Core、SQLite、Runtime 或 Skill Library；
本次是代码与隔离生产组件验证，不宣称日常已安装 App 被升级，也不据固定等待或模拟业务通过宣称真实性能 SLA。
HTTP 共享单元测试另验证 cookie/Host/来源/跨实例拒绝、query、MIME、304、range、缺失资源、SPA 静态边界、
编码与 symlink、关闭端口和上下文撤销。Main 与 HostChannel 测试独立覆盖代际、旧消息及窗口生命周期。


## 本地检查结果

首次完整 `pnpm test` 通过（Vitest 184 文件/1919 项，Node 子集 317 通过、2 项平台专属跳过），桌面 contextBridge、
文件链接导航、文件预览布局、TypeScript、桌面构建和文档单测通过。
同步 main 后，默认并发的一次 Vitest 中 3 项评测模块断言等待超时；保留原断言，降低并发重跑，185 个文件/1927 项
全部通过（`pnpm exec vitest run --maxWorkers=2`）。新增私有目录和诊断补全验证包含在此结果中；Clippy 与固定 base
文档治理再次通过。
最终正式 HTML 回归包括两份原稿、HTTP/CORS/字体/外部 frame、8 个内部 frame、pending 脚本超时、源码原文、
History 导航、刷新代际、真实导航 404 与关闭撤销；普通 Chrome、文件预览布局、TypeScript 和桌面构建在最终代码上
再次通过。Rust PR 套件各段通过：同步 main 后的库测试 559 项、CLI 35 项、慢测试 310 项；Clippy 无警告。
远端 CI 的最终提交状态见 [PR #363](https://github.com/murray17/rovai-ai/pull/363)。

## 连续导航状态与诊断修正（2026-09-13）

基线为 main `d53f8ca9`，修复用户指出的三个导航生命周期问题。先在正式 Provider/Pane、Main service 和隔离
Electron 中建立失败用例；只控制宿主截止计时，iframe HTTP、作者脚本与导航保持浏览器原生行为：

| 场景 | 修复前实际结果 | 修复后专项结果 |
| --- | --- | --- |
| 正常 A → 卡住 B | 推进 60 秒后仍 loading、剩余计时器 0 | B 按自己的期限进入 unresponsive，正文可见；同页重复握手和真实子 iframe 加载不能延后期限 |
| 已加载页面 → 无鉴权的纯文本 403 | load 后标为 loaded，诊断 unavailable | 显示无法确认与重试，错误响应原文可见，无遮罩或上一页诊断 |
| 旧页 CSS/图片 404 → 新页面 | 两条旧 404 在新页重放 | 只出现新页主动触发的当前错误；该新请求用作诊断流顺序屏障 |

最小命令为 `node --test --test-name-pattern='document navigation' scripts/lib/html-preview-site.test.mjs`；此用例同时
进入默认 `pnpm test:html-preview`。它与首次打开即卡住的既有回归分别执行，不用状态逻辑模拟替代正式界面证据。
共享 HTTP 测试另验证旧页延迟请求、105 条历史失败后的新页额度、子 HTML 不清除根错误及未知文档订阅拒绝。
负例首先观察到 `old-page-missing.css` 混入新订阅，修复后仅留下当前请求。宿主加载状态的确定性测试覆盖重复握手、
旧根状态、无响应、完成/失败与销毁清理。此修正不更改权限界面、资源改写策略或作者文件。

最终 TypeScript、桌面构建、完整 `VITEST_MAX_WORKERS=2 pnpm test`（189 个文件/1960 项 Vitest；Node 子集 317
通过、2 项平台专属跳过）、HTML 套件、普通 Chrome、文档治理与 Clippy 通过。Rust PR 套件为库 560、CLI 35、慢测试
310 项通过。磁盘空间有限，本次 Rust 验证关闭 incremental 与 debug symbols，未复用其他 worktree 的 target。

文件布局原生输入回归在分支与未修改 main `d53f8ca9` 上都失败于同一项：拖动关闭时分隔线是
`rgb(119, 119, 119)`，原断言要求与 danger 提示 `rgb(162, 76, 70)` 一致；本次未修改分隔线代码或放宽断言，
不把这一项报告为通过。完整测试的 sandbox admission 源码检查还发现 main 的 `navigation-shell.test.mjs` 中
`if` 后缺少空格；本次仅补齐该空格以匹配既有检查，调用、隔离准入与测试语义保持不变。

## HTML 反馈收敛（2026-09-13）

按用户的新交互稿调整正式 Renderer：正常页面去除“页面已加载／查看详情”整行提示，有路径时将源码与临时状态
并入路径行，异常详情默认收起并限高滚动。无路径附件从既有 Tab 菜单切换源码，正常时不增加任何路径占位。
问题数与加载/未确认状态可同时存在；失败重试保留页面及诊断，成功换代后收起详情。当前规范同步至
[文件预览 UI](../../ui/components/file-preview.md#html-运行反馈) 与 [File Preview v12](../../contracts/file-preview-v12.md#状态交互与生命周期)。

源码切换的原有“只保留 iframe 节点”不足以保留滚动位置：正式 Electron 反例中输入和脚本变量保持，但
`display: none` 后滚动从 120 回到 0。现在隐藏网页时继续保留其视口尺寸，附件菜单往返后输入、脚本变量与
120px 滚动均保持；只读源码依然逐字对应原稿。原有 HTML 验收 owner 扩展真实 Provider/Pane/Tabs 与 Main
service 断言，覆盖健康页零诊断行、无路径附件源码/问题入口、键盘展开、420px 双主题、夜间 200% 缩放、实际
源文件移走后的重试失败、成功恢复及导航隔离。重试等待仅在文件 API 前设置确定性放行门，失败由真实 Main
读取产生；HTTP、作者脚本、iframe 与交互仍由浏览器执行。普通 Chrome 回归同时通过。

验证通过：`pnpm typecheck`、`pnpm build:desktop`、`VITEST_MAX_WORKERS=2 pnpm test`（189 个 Vitest 文件 /
1958 项；Node 子集 317 通过、2 项平台专属跳过）、`pnpm test:html-preview`（Electron 两个场景与普通 Chrome）。
通用文件布局回归初次在源码主题切换的可见行断言失败；独立重跑通过该项，随后与未修改 main `62eff9d6`
同样停在拖动关闭分隔线的既有颜色断言（实际 `rgb(119, 119, 119)`，预期 `rgb(162, 76, 70)`）。未修改分隔线
实现或放宽断言，该套件不报告为通过。所有 Electron/Chrome 验收使用独立临时 userData/profile，未连接日常 Core 或 Runtime。
