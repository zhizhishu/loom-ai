---
document_type: implementation-plan
version: v1.72
authority: version-implementation-and-acceptance
status: implemented
last_updated: 2026-10-23
---

# 队员拼音检索实施与验收

User 确认仅增强队员名字和团队角色，采用普通空格容错。当前交互权威见
[结构化 Mention](../../ui/components/structured-mentions.md#member-typeahead)。

- 基线：`origin/main @ 4fe005decd5eaf54b81265943f71e80a7014f75e`。
- 分支：`rovai/member-pinyin-search`。
- Worktree：`/Users/murray.xue/VSCodeProjects/opensource/rovai-ai-member-pinyin`。
- 治理先行：无需单独主线治理提交；局部可逆匹配不新增 Version Decision。
- 完成后提交并推送分支，不自动创建 PR；未合入前保留 worktree。

## 实现

`member-search.ts` 提供纯函数 `memberSearchMatches(value, query)`，
由 `structuredMentionOptions()` 分别筛选名字与角色。先调用原有 `fuzzyContains()`，
再对副本执行 NFKC/小写，在候选含汉字且查询含拼音字母时调用锁定的 `pinyin-pro@3.29.5`：

```ts
{ precision: 'start', continuous: true, v: true, space: 'ignore' }
```

不增加缓存、索引或搜索服务。编辑器 query/offset、Atom 的 `agentId` 与 `labelFallback`、
可提及资格、排序、数量上限、邀请流程及自动/手动分类机制保持现有所有权。
对话/使命标题及 Skill 不接入拼音。依赖锁文件、完整 MIT 许可证与第三方声明同步提交。

## 验证层次

| 层次 | 检查与结果 |
| --- | --- |
| 纯函数与候选 | 3 个定向 Vitest 文件，91 项通过。覆盖全拼/前缀/首字母、任意汉字起点、中拼混输、简繁体、全角/大写、ü/v、普通空格、UI 设计师、常见多音姓氏、反例、跨字段隔离、同名/同音身份、资格、排序、上限、邀请层和使命模式 |
| 原文检索隔离 | 队员原文子序列保留；对话/使命标题与 Skill 拼音反例及正常原文命中通过 |
| 全量前端 | `pnpm test` 通过：Vitest 256 文件、2,992 项通过、2 项跳过；末段 Node 360 项中 358 通过、2 个 Windows 专项按平台跳过；文档、Skills、sandbox capability 等前置门禁通过 |
| 类型与文档 | `pnpm typecheck`、`pnpm docs:test`、`pnpm docs:check`、`DOCS_BASE_REF=4fe005decd5eaf54b81265943f71e80a7014f75e pnpm docs:check:ci` 通过 |
| 真实编辑器 | `pnpm test:composer-input` 的 3 个 suite 全部通过。隔离 Electron 挂载生产 ThreadWorkspace（Active/Pending）与 MissionDescriptionComposer；新增 13 组输入行为检查通过：原生 Enter/Tab、重复提及、原文范围/空格/光标、Chromium composition、自动/手动分类、队外仅标记待邀请、引用和 Skill 原文隔离 |
| 桌面应用 | macOS arm64 ad-hoc 打包应用 + 真实 Core 的 `--member-search-only` 专项通过：aili/Enter、als/Tab、全角/Enter、中拼/Tab、角色 uisj/Enter；全部绑定 agent_1 与原显示名，尾随空格/光标正常，Core 中消息与 Run 均为 0 |
| Rust 回归 | pnpm test:rust:pr（cargo test --workspace）通过：475 项，0 失败、1 忽略 |

真实编辑器传输由本地夹具控制，不启动 Core/Runtime；不能替代带真实 Core 的桌面验收，
也不声称进行了实体键盘输入法候选窗的人工验收。打包专项入口为：

```sh
node scripts/accept-structured-mentions-ui.mjs --member-search-only
```

该入口复用原隔离 App/Core 启停与清理流程，专用名册含“爱丽丝 / UI 设计师”。
正式全量 Mention/Skill 成品验收与此专项结果分开记录，不互相冒充。
本次构建按 `package:mac` 的阶段执行 `core:build:macos:arm64`、`build:desktop`，
再执行 `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm exec electron-builder --mac dir --arm64 -c.mac.identity=-`。
打包 App 的 pinyin-pro LICENSE 与仓库留存文件逐字节一致（1,070 字节）。

打包验收的 userData 为 `/tmp/rovai-pinyin-app.GdymQN/user-data`，Skill Library 为其
`managed-skill-library` 子目录，Runtime 临时目录为 `/tmp/rv-py.M6qT4S`；
仅使用隔离 /usr/bin/true Runtime 配置，专项不触发发送。App/Core 退出后已清理上述本次目录，
截图与 JSON 结果留在当前 Thread 的 `member-pinyin-search` 附件目录。未安装或重启日常 App。

既有输入回归发现并修复两个夹具漂移：Skill 的滚动断言原先读取 listbox 而非实际外层滚动容器
（在未修改主线上复现），邀请入口的旧完整 aria-label 选择器改为现有稳定 option kind。
保留原断言目标，不减少测试或改变生产交互。

## 构建体积

同一工作树、依赖环境与未启用 Renderer JavaScript minify 的生产配置，
先在不可变基线执行 `pnpm build:desktop`，再在实现后执行相同命令。
统计 `out/renderer/**/*.js`，每个文件独立 gzip level 9 后求和；均为 119 个 JS 文件。

| 口径（字节） | 基线 | 接入后 | 增量 |
| --- | ---: | ---: | ---: |
| Renderer JavaScript | 8,748,332 | 9,036,088 | 287,756 |
| 同批 JS gzip level 9 | 2,049,196 | 2,141,457 | 92,261 |

按 1 KB = 1,000 字节计，约增加 **287.8 KB / gzip 92.3 KB**。
这是本次完整队员匹配接入的 Renderer 增量，不是 npm 下载包或桌面安装包增量；
本次未做基线/变更两套安装包的体积对照。

## 跨版本文档影响

当前 UI 合同更新匹配、分类和范围隔离。Core 协议、持久化、Runtime、模型上下文、
领域身份与发送事务均不变，Architecture/Contracts 无需增加新版本。
本记录拥有本次验证事实；不把本地截图或临时夹具目录当作长期规范。
