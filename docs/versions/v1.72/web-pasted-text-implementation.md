---
document_type: implementation-record
version: v1.72
status: completed
last_updated: 2026-10-22
---

# Web 长粘贴附件实施记录

User 要求补齐远程连接端，同时保持可用性优先、架构简单。范围是共享公屏已有长粘贴入口，
不改变普通上传、单聊、使命、消息删除或 Run 取消。当前合同由
[Composer Draft v19](../../contracts/camp-composer-draft-v19.md) 与 [Host Web v9](../../contracts/host-web-v9.md) 拥有。

## 验证归属

- `host-web.test.mjs` 原实际 Host HTTP owner 扩展生成文件直写、完整字节、前缀、同路径跨 Thread 保护、
  未发送移除、删除失败保留登记、回执重放及 Host 重启恢复；复用已有隔离进程、数据库与身份。
- `camp-adapter.test.ts` 与 `client-recovery.test.ts` 覆盖 capability 接通、来源/前缀透传、发送字段、
  清理错误不能谎报成功、25 MiB 前置检查，以及新 UploadTarget 的未知回执恢复。
- Core 既有 preflight owner 加入新 schema 的必要表/完成标记校验。新增
  `web_pasted_text_upgrade_is_atomic_and_reopens` 专属 schema 161→162 的事务失败边界；没有等价旧 owner
  能证明新 DDL 与完成标记一起回滚。fixture 使用 schema-only 数据库，不启动 Runtime，不读外部文件。
  最小命令：`cargo test -p rovai-core --features extended-tests --lib web_pasted_text_upgrade`。
- 共享 Composer 原 Electron fixture 继续拥有阈值、Atom 优先级与异步回填；浏览器到 Host 的实际交互单独验收。

## 验证结果

2026-10-22，在独立 `rovai/web-long-text-paste` worktree 验证：

- `pnpm typecheck`、`pnpm build:web` 通过。
- 定向 Vitest 两个文件共 18 项通过；`pnpm test:composer-input` 共 3 个集成 owner 通过。
- `pnpm test:rust:pr` 通过：Core lib 428 项、CLI 31 项、Server 4 项、Web 11 项；既有 1 项 ignored。
- `web_pasted_text_upgrade_is_atomic_and_reopens` 与现有 preflight 扩展检查分别通过。
- `node --test --test-name-pattern='Desktop and Web share one Core' scripts/lib/host-web.test.mjs` 通过，
  包含完整内容、删除失败、原编辑身份恢复、附件正文为空的真实发布与下载、跨 Thread 路径保护、
  明确拒绝发送后跨 Host 重启仍保留文件。原 Host clock owner 也通过。
- `pnpm docs:test` 与 `DOCS_BASE_REF=11b138a6c4c8e4a0320d0369629eae88ff806d23 pnpm docs:check:ci` 通过。

`node scripts/accept-web-pasted-text.mjs` 使用独立 Host/Core、Skill Library 和 headless Chrome profile。
在真实生产 Web 页面派发带纯文本 DataTransfer 的 ClipboardEvent，经真实 HTTP 生成文件；
10,000 个 emoji 保持正文，12,621 码点 / 18,224 字节生成文件，已有正文保留，刷新恢复、卡片预览和点击移除通过。
Active 文件移除后目录与会话保留；Pending 文件移除后为空，离开后目录被既有流程删除。
本次点击到文件消失观测约 159 ms / 140 ms，包含自动化等待，不作为性能承诺。

证据生成在 `ROVAI_WEB_PASTE_OUTPUT` 指定目录，包含六张截图和 `validation.json`。
使用同机浏览器经 HTTP 连接隔离 Host，未测试第二台物理设备、系统剪贴板硬件事件或真实模型运行；
文件内容由实际文件读取和发布消息附件下载验证。日常 App 未重启或安装本变更。

## 执行方式

先构建当前 worktree 的 Host/Core 与 Web；脚本不使用其他 worktree 的二进制。
`ROVAI_WEB_PASTE_OUTPUT=<绝对证据目录> node scripts/accept-web-pasted-text.mjs` 可保留证据，
测试数据、浏览器 profile 与该实例的输出目录在结束后清理。未指定输出目录时只保留隔离 fixture 供检查。


## 删除等待隔离与浏览器发送补验（2026-10-22）

复核基线 `6cd2a936a85f0bbceafc4a7b851921dbb7e3ebaa`：删除曾跨异步 unlink 持有 Core 数据库锁，
且在普通 FIFO 请求处理器中等待。改为复用现有独立请求调度；Core 内仅增加一个附件操作互斥，
发送与删除统一先取附件锁、再取数据库锁。空附件发送直接绕过附件锁。归属/路径读取和登记更新
仍由数据库锁保护，路径校验与文件删除在锁外完成；删除失败继续保留登记，不增加状态或后台任务。

扩展既有 `independent_reads_do_not_inherit_an_unrelated_non_database_wait` owner，复用同一隔离 Core、
数据库与受控 barrier，在真实 unlink 前暂停：另一 Thread 的打开、普通顺序请求 `members.list` 和
纯文字消息发布必须在释放 barrier 前完成；同时提交该待删文件的附件发送必须等待，并在删除后拒绝
缺失来源。原先的独立读取/必要顺序修复断言保留，不新增平行 Rust fixture 或独立测试函数。
该回归需要实际请求调度和共享数据库锁，纯函数测试不能覆盖。最小命令：
`cargo test -p rovai-core --features slow-tests --lib independent_reads_do_not_inherit_an_unrelated_non_database_wait`。

扩展原浏览器脚本：空正文仅粘贴附件，点击当前可见 Composer 的发送按钮，经真实 Web 身份校验发布；
用该浏览器的认证 HTTP 请求下载消息附件并逐字核对，刷新后确认旧草稿不恢复、源文件仍完整。
夹具默认成员没有配置 Runtime，验证真实消息发布与草稿收尾，不调用外部模型。按钮按可见面板定位，
避免误选仍挂载的隐藏 Composer；未修改产品发送入口。

单独 Server 的生成文本仍由现有 `ServerPaths` 推导：
`<data-dir>/instances/<instance-key>/attachments/<threadId>/<UUID>.txt`；默认数据根 `~/.rovai-server`。
本次不改变目录布局，浏览器正文和草稿清单仍在客户端本地。

本次验证通过：上述延迟删除定向 owner；`pnpm test:rust:pr`（Core 428、CLI 31、Server 4、Web 11，
既有 1 项 ignored）；实际 Host HTTP owner；更新后的真实浏览器脚本；`pnpm typecheck`、
`pnpm build:web`、`cargo fmt --all --check`、`pnpm docs:test` 与以本次基线运行的 `pnpm docs:check:ci`。
生产 Host 从当前 worktree 重新构建后运行 HTTP 与浏览器验收；Browser 的源文件 31,242 字节，
发布后的下载、刷新空草稿和文件保留均确认。`rovai-server paths` 另以默认与 `/data/rovai` 自定义根只读核对。
日常 App/Server 未安装、未重启；验收仍是同机浏览器经 HTTP 访问隔离 Host，不代表第二台设备测试。
