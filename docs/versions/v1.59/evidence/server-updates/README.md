# 登录页与 Server 更新验证（2026-09-14—15）

实现基于分支 `rovai/unified-rust-host` 的 `205cb0d3`，保留同期 Linux 验证提交。

| 验证 | 结果与范围 |
| --- | --- |
| `pnpm typecheck`、`pnpm build:web` | 通过；Vite 保留既有大 chunk 提示 |
| Vitest `server-updates` / `client` / Desktop `app-updates` | 3 文件、38 项通过；可控时间覆盖断网、重启未确认、重连换版本和旧响应竞争 |
| `cargo test -p rovai-host --lib server_updates` | macOS 4 项通过；固定发布坐标、校验错误、重复/失效操作、停机未确认不安装、目录切换失败恢复、Unix revision/current、共享程序占用、真实子进程交接与参数保留 |
| `cargo test -p rovai-web` | 7 项通过；包含已有认证持久化与资源一致性测试 |
| `cargo clippy -p rovai-host -p rovai-web --all-targets -- -D warnings` | 通过 |
| `host-web-channels` + `host-web` 串行执行 | 3 项通过；Desktop 的四种更新操作均不开放，共享 Core/Web/渠道生命周期保持 |
| `server-entry` | 本机 3 项通过、Windows console 项按平台跳过；数据根、Token、终端与退出保留 |
| `host-web-mobile` 的 workbench 与 standalone Server 用例 | 2 项通过；真实 macOS Host/Server 与 Chrome，375/844/1440 登录页、明暗主题、退出后的初始表单；Desktop 只读说明、Server 更新控件、鉴权与封闭操作准入 |
| 文档门禁、`git diff --check` | 通过 |

首次多套 Host 测试与 Rust 编译并发时，channels 和 shared-Core 用例超过既有 15 秒步骤期限；未修改期限，串行复跑两者通过。

程序更新流水线使用本地 HTTP 与受控归档；交接测试执行测试程序作为下一版本，不启动真实 Core 或模型。
浏览器用例使用隔离数据、Skill Library、MCP 和 Chrome profile，没有操作日常 App 或用户 Server。
截图与构建、安装日志保存在本机 `Downloads/Rovai-Server-Update-20260914`。

这些证据不等于正式 GitHub Release 升级：当前 `scripts/server-channel.txt` 仍为 `unpublished`。
首轮原生 CI 的 Linux x64、macOS arm64 与 macOS x64 任务通过，包括各自的 updater 与交接测试；Windows 失败与复验见下文。
后续发布后还须用两份正式包验证检查、下载、重启、会话恢复及业务数据保留。

## 本机交付

macOS 最终交付基于 `ccada935`；后续 `2e9a40a4`、`2f15a17f`、`01efc75d` 仅改 Windows 编译分支、Windows 测试和 CI，不改变 macOS 交付行为。

- Server：`~/Downloads/Rovai-Server-0.2.6-ccada935`。包内 146 个文件通过清单校验，实际打包程序的浏览器验收通过。
  归档 SHA-256：`ea033dc55f5ca76560f26b7dbea458580f4155445a40e799ff91c04e9b1cb7fe`。
- Desktop：`pnpm package:mac:daily` 通过签名与架构门禁；隔离的打包 App 验收通过明暗主题、键盘聚焦、窄屏、200% 等效布局、减少动效及现有自动检查文案。
- `pnpm install:mac:daily` 已安装到 `/Applications/Rovai AI.app`，旧安装备份为 `/Applications/Rovai AI.backup-before-server-updates-ccada935.app`。
  没有重启日常 App 或当前会话进程；新版本在用户退出后从规范路径重新打开时生效。

构建时的 dirty 标记来自文档修改，交付程序代码已提交。未覆盖用户先前使用的 Server 程序目录，也未启动用户数据根上的 Server。

## Windows 原生失败与定向复验

首轮 [f4cdc687 四目标 CI](https://github.com/murray17/rovai-ai/actions/runs/34858735464) 的 Windows 任务失败，不能算通过。
失败点为已有文件扫描测试的只读句柄不能设置文件时间，以及新增交接测试在执行切换后仍读到 `old`。
后续的产物上传步骤使用失败后也执行的条件，进入上传步骤不能推断前面的测试通过。

`ccada935` 修正测试写时间所用的句柄权限；Windows 更新器在目录换名前释放自己的程序文件句柄，
保留先前的其他实例共享锁检查、安装锁及文件系统最终准入。目录切换失败的回执现在注明具体阶段。
原生进程交接用例继续验证未授权 EOF 不安装、其他实例占用不安装、成功后执行新程序并保留参数。
这两个失败都复用已有测试，不增加重复用例。

增加 `Full check` 的 `server-updates` scope，用同一组原生目标定向运行 `rovai-web` 与 Server updater 测试，
省去完整产物重建；两条 Cargo 命令分为独立步骤，避免 PowerShell 后一个命令掩盖前一个失败。
[ccada935 Windows 定向复验](https://github.com/murray17/rovai-ai/actions/runs/34861797383) 在文件读取阶段失败，updater 步骤未运行。
修正句柄权限后暴露已有路径遍历错误：按组件读取绝对路径时，用禁止卷根作为附件的入口打开了遍历起点，导致普通文件读取也被拒绝。

`2e9a40a4` 为内部遍历增加严格限定本地磁盘根的起点入口，保留附件来源的卷根禁入。
扩展现有 Windows junction 测试，确认普通文件可读、父级 junction 不可穿越、卷根仍不可作为附件或文件读取。
定向 CI 的 Web、updater 与 Windows 边界测试各自报告状态，即使 Web 测试失败，也继续取得 updater 的独立结果。
[2e9a40a4 Windows 定向复验](https://github.com/murray17/rovai-ai/actions/runs/34863491813)：Web 7 项、updater 3 项通过，新增的边界断言失败。
实际读取没有穿越 junction，但缺少打开节点后的显式检查，直到读取其子项才收到系统错误 1921。
`2f15a17f` 在 Windows 每个父节点和最终文件节点打开后立即使用已有类型检查拒绝 reparse/device 节点；
继续使用原用例验证普通文件可读、父级与最终节点 junction 被拒绝、卷根禁入及外部文件保留。

[2f15a17f Windows 定向复验](https://github.com/murray17/rovai-ai/actions/runs/34864547648) 整体通过：Web 7 项、updater 3 项、Windows 文件边界 1 项。
[2f15a17f Windows 原生包验证](https://github.com/murray17/rovai-ai/actions/runs/34864552411) 的构建、认证、updater、原生进程与存储步骤通过。
包级 Node 验收 6 项通过、3 项按平台跳过、1 项失败：Windows 绝对路径 `C:\…` 在 Web 的 URL joining 中被视为协议，返回 `source_not_authorized`。
本轮原生安装器校验、重复安装、数据保留、PATH 配置与 Windows console 关闭验收均通过。

`01efc75d` 仅在 Windows 将本地绝对盘符引用转为 file URI，再进入既有解析过程；保留一次解码、网络协议拒绝和 Core 授权。
扩展已有资源解析测试覆盖正反斜杠、位置后缀、等价 file URI、双重编码不重复解码，以及远程 UNC/盘符相对路径拒绝。
[01efc75d Windows 定向复验](https://github.com/murray17/rovai-ai/actions/runs/34866620483) 整体通过：Web、updater 与 Windows 文件边界三个步骤均通过。
[01efc75d 原生包复验](https://github.com/murray17/rovai-ai/actions/runs/34866625718) 整体通过。
包级 Host/Web、Server 入口与安装验收为 7 项通过、3 项按平台跳过、0 项失败；此前失败的绝对路径文件打开已通过真实 HTTP 流程。
核对完整原生日志，Rust 测试与 Node 测试均无失败记录，未将后续命令成功作为先前命令通过的替代证据。
原生文件边界观察保持 Single-Owner 口径：父子进程的授权工作区均可写，同 UID 私有夹具仍可读；这不是强隔离或真实 Runtime 发布资格证明。
检查过的 Windows 归档和预览包已作为本轮 CI artifact 上传，没有创建 GitHub Release。
先前针对 `2e9a40a4` 的包验证在生成过期产物前主动取消，不记作验收结果。
