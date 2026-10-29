# LOOM 落地交接书：Win11 安装 → bero 收尾 → 云端远程 → 助手注入（2026-10-29）

> 配套验收书：`acceptance-win11-remote-2026-10-29.md`。主助手按本书派工，按验收书判。

## 0. 现状（2026-10-29 只读取证）
- 仓库 `zhizhishu/loom-ai`，`main` = `897af63`，工作区干净，== origin/main；CI run 40857366600 绿
- LOOM 第一～四轮闭环；schema 174；8 张 loom 表；web 准入 10 个 LOOM 操作
- Windows 打包机制来自上游 v1.15（`docs/development/packaging-windows.md`，status `implemented-pending-release-qualification`）；本 fork 的 `windows-package.yml` **从未运行**
- 上游未验：Windows 11 client OS、Authenticode 签名；对外口径只能是 `Windows x64 Preview — unsigned`
- 本机 Windows 编不了 Rust；cargo 构建与测试在 bero 上跑；Windows 安装包只能在 GitHub `windows-2022` 上编
- skill 按队员注入已是现成功能（`member_toolbox_skill`）；按队员管理 hook / MCP 未确认；仓库内没有远程隧道

## 1. 总原则
- 产品形态：Win11 桌面客户端是本体，云端只做控制面
- 证据 = 命令 + commit + 原始输出尾部 + 时间（CST）；工兵自报不算
- 红线：不碰上游 murray17/rovai-ai；不对公网裸开端口；验收不指向日常 userData；skill-cli 不许 `git add -A`

## 2. 阶段 1：GitHub 出安装包（今天）
1. 确认 `main` == `origin/main`、工作区干净、最新 CI 绿
2. `gh workflow run windows-package.yml --ref main -R zhizhishu/loom-ai`
3. 运行结束后 `gh run download <run-id>`，取 `Rovai-AI-<version>-x64.exe`
4. 失败：贴失败步与日志尾 30 行，回报主助手，不改 workflow 凑绿

## 3. 阶段 2：装到 Win11（第 1 天）
1. SmartScreen 选「仍要运行」（未签名）
2. 当前用户安装，不提权
3. 完成引导，接入已装好的 Runtime（如 Claude Code）
4. 跑一次真实对话 + 一条 LOOM 链：导入计划 → 认领 → 交付 → 验收
5. 关闭重开，盯 `IdentityChanged`；最后卸载，确认数据保留

## 4. 阶段 3：bero 收尾（第 2–3 天）
1. 查清 `IdentityChanged{stage:Revalidation}` 三个基线失败的根因并写进文档；是缺陷就修
2. 每次 push 前：`cargo fmt --all -- --check`、`cargo check -p rovai-core --all-targets`、`pnpm typecheck` 全部 exit 0
3. 回归：全量 + `--lib loom` + `pnpm test:loom-core` + 夹具

## 5. 阶段 4：云端控制面 + 远程调本机（本地稳定后）
- 架构：云端轻量网关；Win11 主动外连（Tailscale 或 Cloudflare Tunnel），本机不开公网端口
1. 先用 Tailscale 把本机 `rovai-host --web-listen` 只暴露给 tailnet
2. 调研 GitHub 上的自托管 agent 网关、MCP over HTTP/SSE 桥接方案，出选型对比
3. 加身份验证 + 操作白名单，去掉 `--allow-insecure-lan`

## 6. 阶段 5：每个助手注入 skill / hook / MCP / 规则
- skill：用现成队员工具箱配置，不写代码
- hook / MCP / 规则：先调研有无按队员入口；做的话，每个助手一份声明式 profile，启动时加载

## 7. 待用户确认
- 云服务器用哪家
- 隧道选 Tailscale 还是 Cloudflare
- 是否有代码签名证书（没有则一直发未签名 Preview）

## 8. 阶段 1 执行记录

### 8.1 首次触发的真实结果：Windows 目标根本编译不过（2026-10-29 12:11–12:16 CST）

- run `40871224854`（commit `897af63`）→ **失败**，卡在 `Build and verify unsigned NSIS package`，4m59s
- 报错（原始输出）：
  ```
  error[E0308]: mismatched types
     --> crates\rovai-core\src\managed_process.rs:642:17
  642 |   bail!("connection-only Runtime ownership is not admitted on Windows");
      |   expected `ManagedProcessSpawnFailure`, found `Error`
  error: could not compile `rovai-core` (lib) due to 1 previous error; 1 warning emitted
  ```

**根因**：`spawn_owned` 返回 `Result<Self, ManagedProcessSpawnFailure>`，而 `bail!` 展开成
`return Err(anyhow::Error)`，类型不符。该行位于 `#[cfg(windows)]` 块内，**Linux 的 CI 永远看不见**，
所以 `main` 一直是绿的、Windows 一直是死的。

**归属**：`git log upstream/main..HEAD -- crates/rovai-core/src/managed_process.rs` 为空，
该文件自 `7ef7588`（导入 `4ea9cac` 基线）起没被本 fork 改过一个字节——**这是上游继承来的缺陷**，
不是 LOOM 引入的。也就是说：文档里写的 `Windows x64 Preview` 在快照 `4ea9cac` 上从未真正编译通过。

**修法**（`8a70ce4`，4 行）：照同一函数末尾既有写法，改成
`return Err(anyhow::anyhow!(...).into())`，走已存在的 `From<anyhow::Error> for ManagedProcessSpawnFailure`。

**为什么这是好消息**：W1 不是「跑一遍确认能出包」，而是真的抓到了一个 blocker。这条修好之前，
任何「Windows 能用」的说法都是空的。

### 8.2 本机无法自证
本机没有 Rust 工具链（`cargo` / `rustc` 均 not found），符合 MASTER-HANDOFF「本机 Windows 编不了 Rust」。
因此 Windows 编译的唯一证人就是 GitHub 的 `windows-2022` 运行器本身——这也是 W2 的判据来源。
fmt 证人改由 CI 提供：`8a70ce4` 的 CI run 40872203417 全绿，含
`Run Rust format and compile checks`（`cargo fmt --all --check` + `cargo check --workspace`）。

### 8.3 修完后出包成功（2026-10-29 12:18–12:34 CST）

- run `40872214155`（commit `8a70ce4`）→ **全绿**，用时 15m50s
- artifact `rovai-windows-x64-unsigned-8a70ce45c2a9642cad101b42c601172f24a60c0b`，148,230,281 字节
- 本地落盘 `dist/windows-x64-unsigned/`（`dist/` 已 gitignore）：

| 文件 | 大小 |
|---|---|
| `Rovai-AI-0.5.1-x64.exe` | 148,057,033 |
| `Rovai-AI-0.5.1-x64.exe.blockmap` | 155,659 |
| `latest.yml` | 4,828 |
| `windows-release-manifest.json` | 4,598 |
| `windows-verification-report.txt` | 1,053 |

**verifier 原文（`Result: passed`）关键行**：
```
NSIS configuration: assisted per-user install, selectable destination, 20s controlled shutdown and bounded force close passed
App: x64, manifest/resources passed
rovai-host / rovai-core / rovai: x64, manifest/resources passed
CLI: rovai 0.5.1 contract-v44 ipc-v3
Packaged Core: isolated Windows data-root preparation and health.check passed
NSIS installer: sha256=ba03c2a0ba2d0ffec1aa45493ee46debdfa43d8c3fcd3a0464bd5120b8940655
Result: passed
```

- manifest 记载：`commit 8a70ce45…`、`dirty: false`、`rustc 1.97.1 host x86_64-pc-windows-msvc`、
  runner `win32 10.0.20348`、`signedReleaseRequired: false`
- 本地 `sha256sum` 与报告一致（`ba03c2a0…90655`），字节数一致 → 下载完整

**这一轮真正证明的事**：Windows 目标**确实能编译并打出 NSIS 安装包**，而且打包后 Core 在隔离的
Windows data-root 里跑通了 `health.check`。这是本仓第一份 Windows 证据。

**顺带发现（待处理，不阻塞安装）**：`latest.yml` / verifier 记录的升级通道是
`github/murray17/rovai-ai`——即**应用内升级检查指向的是上游仓库**，不是 `zhizhishu/loom-ai`。
本 fork 自己发版前必须改通道，否则「检查更新」会去拿上游的包。

## 9. 记录
每项一行写进 `skill-cli/TASK.md`，格式同第四轮验收书 §3。
