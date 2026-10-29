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

## 8. 记录
每项一行写进 `skill-cli/TASK.md`，格式同第四轮验收书 §3。
