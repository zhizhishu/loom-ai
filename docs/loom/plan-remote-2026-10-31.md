# LOOM 远端 + 本地双端计划（2026-10-31）

> 用户方向（原话）：远端机器放服务端，本地被控；本地有对应 CLI 也可以被控，没有就落到远端；远端配齐 codex / claude 等 CLI（一般点一下就配齐）；最主要的是规则 / MCP / skill 能同时用于远端和本地。

## 1. 现状（M0 侦察，Pi 工兵只读，主管抽查属实）

| 事实 | 证据 |
|---|---|
| Runtime 永远是 Core 的子进程，跑在 Host 所在机器上；无任何远端执行通道 | `crates/rovai-core/src/managed_process.rs:592-604`、`claude.rs:815`、`codex.rs:437` |
| 桌面 App 只会 spawn 本机 Core（stdio），没有「连远端 Server」入口 | `apps/desktop/src/main/core-client.ts:457` |
| `rovai-server` 已是可用的无头服务端：默认 `127.0.0.1:8767`、64-hex Token 登录、非回环必须 `--allow-insecure-lan` | `crates/rovai-host/src/server.rs:11-30`、`crates/rovai-web/src/auth.rs:206-217`、`crates/rovai-web/src/lib.rs:113-116` |
| Linux 服务端打包 / 安装脚本齐全，但不建系统服务 | `scripts/build-server.mjs`、`scripts/install-server.sh`、`docs/development/server-preview.md` |
| 一个数据库只有一个执行主机（singleton），Runtime 探测结果无机器维度 | `mission_schema.sql:44-48`、`db.rs:10785-10812` |
| 队员规则：`agent_profile` 6 列进 Bootstrap；MCP 已可按队员指派（server 定义全局）；skill 只有内置 5 项工具箱，按提示词索引投递；无可配 hooks | `context.rs:3560-3617`、`mcp_projection.rs:460-477`、`managed_skills.rs:25-31`、`context.rs:7307` |
| 安装脚本仍指向上游仓库 | `scripts/install-server.sh:43,64` |

## 2. 架构取舍

| 方案 | 做法 | 结论 |
|---|---|---|
| **A 多主机（推荐，先做）** | 每台机器各跑一个 Host（本地 = Desktop 自带，远端 = `rovai-server`），各有自己的 Core / 数据库 / Runtime。本地 App 增加「远端主机」：在 App 内打开远端 Web 控制台。「在哪跑」= 选哪台主机。规则 / MCP / skill 用一份声明式 profile 同步到两端。 | 不动 Core 执行模型，安全边界清楚（每台主机自己的 Token），可分步交付 |
| B 单 Core + 远端执行器 | 一个 Core 调度，远端只跑 Runtime 进程 | 要新增进程 / 文件 / 工作区跨机通道，改 singleton 执行主机与探测表，工作量和风险大一个数量级；A 稳定后再评估 |

## 3. 里程碑

| # | 内容 | 完成判据 |
|---|---|---|
| M0 | 摸清现状 | 本文 §1 ✅ |
| M1 | bero 跑 `rovai-server`（只监听回环）+ 常驻；经加密隧道访问；不裸开公网端口 | 本机浏览器经隧道登录成功；bero `ss` 只见 127.0.0.1 监听；重启后数据与 Token 仍在 |
| M2 | 本地 App 内连远端主机发起对话；LOOM 真实任务 Gate 在远端或本地任一主机跑通 | 用户实机：使命 → 规划 → 编排图 → 交付验收 |
| M3 | 「在哪跑」：按两端 CLI 可用性提示 / 选择主机 | 本地缺 CLI 时一键转到远端主机 |
| M4 | 远端一键配齐 CLI | ✅ 见 §7。Desktop「远端主机」复制命令；Linux Host「智能体」在 Claude Code / Codex 未检测到时复制同一命令并重新探测，显示「可用」后收起。Core 不代装 |
| M5 | 每助手规则 / MCP / skill profile 两端生效 | 同一 profile 导入两台主机后，`members.runProjection.preview` 取出的 Bootstrap 与 MCP 投射经 `projection --compare` 规范化后一致。见 §8 |

## 4. 待用户决定（不阻塞 M1 前半段）

- 隧道：Tailscale（只自己设备可达）或 Cloudflare Tunnel + Access（有域名、可加邮箱验证）。两者都要一次账号授权。
- 远端登录 Claude / Codex 账号：凭据只存在远端机器上，需用户本人在远端完成登录。

## 5. M1 执行记录（2026-11-01 CST，bero）

- **部署**：`node scripts/build-server.mjs --output-dir …` 在 bero（Debian 13）构建通过，ABI 门禁因 bero glibc 2.39 > 发行基线 2.35 拒绝出发行包——本机自用不受影响，正式发行包仍走 CI 的 ubuntu-22.04。程序装到 `/opt/loom-server/<commit>`，`current` 软链；systemd `loom-server.service` 以**系统用户 `loom`** 运行，`--listen 127.0.0.1:8767`，数据 `/var/lib/loom-server`（700）。
- **隧道**：`loom-tunnel.service`（cloudflared quick tunnel，只出站，`User=loom`）。`ss -ltn` 只见 `127.0.0.1:8767`，无公网监听。quick tunnel 地址在 `loom-tunnel` 重启后会变，需同步改 `loom-server` 的 `--public-origin`（否则 API 一律 `origin_not_allowed`）。正式形态换命名隧道 + Access 或 Tailscale。
- **验收**：经隧道页面 200（标题 `Rovai AI`）；无 Token `session_required` 401；错 Token `invalid_administrator_token` 401；正确 Token 登录 200；本机 Win11 直连同一地址 200 / 401。`loom-server` 连续重启 3 次全部 `active` + 200，`IdentityChanged` 0 次，Token 摘要重启前后一致。
- **CLI 配齐**：`scripts/provision-remote-runtimes.sh --prefix /home/loom/.npm-global`（以 `loom` 运行）装好 Claude Code 2.1.316、codex-cli 0.166.0；服务端 `adapter_installation` 两条 `path_state=valid`。账号登录未做。

### 根因：`IdentityChanged{stage:Revalidation}`（原 B1，3 个 `database_admission` 基线失败）

以 root 运行时，SQLite 每次打开既有 WAL 都会对其 `fchown` 到主库属主（Unix VFS `robustFchown` 只在 euid 0 时执行），**WAL 的 ctime 改变而 mtime / 大小 / inode 不变**；`database_admission` 的身份戳是 `mtime:mtime_nsec:ctime:ctime_nsec`（`database_admission.rs:1097-1107`），于是 ticket 观察与开库后复核不一致，二次打开必被拒。bero 上插桩实测：`expected_wal …:1793474208:788000000` → `actual_wal …:1793474208:800000000`，仅 ctime 纳秒位变化。GitHub runner 与桌面都不是 root，所以从未复现。

**结论**：不是数据损坏，也不是 bero 文件系统问题；是「以 root 跑 Core」触发的误判。处置：服务端一律非 root 运行（已落 systemd）；bero 上的回归测试也应以非 root 用户跑，基线 3 失败即消失。是否放宽准入（仅 ctime 变化的零长 WAL）属冻结安全逻辑，暂不改。

## 6. 远端 ACCP 冒烟（2026-11-01，bero，Lead = Codex + Octopus）

| 轮 | 现象 | 根因 | 处置 |
|---|---|---|---|
| 1 | 叮叮第一条 `rovai mission get` 即 `builtin_tool.cli_error`，Run 秒结束 | Codex Linux 沙箱（`workspace-write`）seccomp 拒绝 Unix socket：沙箱内 `connect(/tmp/rovai-builtin-*/core.sock)` = `EPERM`，`danger-full-access` 或 `network_access=true` 才通 | bero `loom` 的 `~/.codex/config.toml` 加 `[sandbox_workspace_write] network_access = true`；写入 `server-preview.md` |
| 2 | `rovai loom status` 成功、读到 LOOM 指引；`rovai loom plan` 反复 `builtin_tool.invalid_input`，计划未导入 | `--help` 只说三项是数组，reference 无文件样例；CLI 对字段错误只回通用 `invalid_input`（本机复现：`null` / 多字段 / 字段名错 / 大写 condition 全同一句） | 模型上下文变更 r3（加完整计划 JSON 样例 + plan 描述指向 reference），待用户二次确认 |

结论：多主机路线的远端执行链在「CLI ↔ Core」这一层已打通；剩余阻塞是计划文件格式对模型不可见，属文案问题，不是架构问题。

## 7. M4 执行记录

Core 不代用户安装 Runtime。App 只展示这一行并提供复制，不执行它：

`scripts/provision-remote-runtimes.sh --prefix "$HOME/.npm-global"`

操作者在含有该脚本的目录中，以 Server 的运行用户执行。脚本幂等安装 Claude Code 与 Codex，不写凭据、不开端口。

- Desktop「设置 → 能力 → 远端主机」始终给出该命令。这台电脑探测不到远端 Core，所以这里没有「重新检测」。打开该主机后，到它自己的「智能体」页重新检测。Web 与独立 Server 没有「远端主机」页，因此这条命令也不出现。
- 当前 Host 为 Linux x64，且 Claude Code 或 Codex 为「未检测到」（含路径缺失）时，「设置 → 能力 → 智能体」给出同一命令、两项当前探测结果和「重新检测」。重新检测调用既有 `runtime.discovery.rescan`。两项都不再缺失后，命令收起；若这次检测由该说明发起且两项都为「可用」，留下探测结果。登录未完成不展示该命令，脚本不负责登录。
- macOS 与 Windows 的智能体页不展示这条 Server 命令。本机安装仍走原有官方安装指南。systemd 启动的 Server 需把 `$HOME/.npm-global/bin` 加进单元 PATH 并重启后，探测才会看到新安装的 CLI。

## 8. M5 投射预览

不启动 Run、不调用模型，也能读出这个队员下一次 Run 会拿到的引导正文和 MCP 文件。操作名 `members.runProjection.preview`。只读。走现有管理员登录（`/api/v1/login` 的 64-hex Token 换 Session，再 `POST /api/v1/request`）。不写 Bootstrap 证据，不写 `runtime/mcp` 快照，不创建 Run。

参数：

```json
{ "member": "<agent id 或显示名>", "runtime": "codex-cli" }
```

`runtime` 可省略。省略时用该队员已选的 Runtime，且只能是 `codex-cli` 或 `claude-code`（内部 id `claude-code-cli` 也接受）。未配置或不是这两项时返回 `runtime_required`。显示名多条命中返回 `member_ambiguous`，没有命中返回 `member_not_found`。精确 agent id 优先于显示名。

返回：

```json
{
  "agentId": "agent_1",
  "displayName": "叮叮",
  "runtime": "codex-cli",
  "bootstrap": "[SESSION_CHARTER]\n…",
  "mcp": { "mcp_servers": { } }
}
```

`runtime` 为 `claude-code` 时 `mcp` 是 `{ "mcpServers": { } }`，与 Claude Code 运行包写入的 `--mcp-config` 相同。`codex-cli` 的 `mcp` 是 Codex 会话配置里的 `{ "mcp_servers": { } }`。两边都只含该队员已启用且已指派、适配器支持的服务器。MCP `env`、`headers`、`http_headers` 的每个值都换成 `********`，命令、参数和 URL 保留。

引导正文走 Run 使用的 `render_session_bootstrap`，材料来自同一次 `BootstrapContents::read`。因为请求只给队员、不给会话，这份正文等于一条新的公共 Thread Run：没有团队指引、没有使命、没有渠道文件投递。Claude Code 仍会多出那条「不要把有限命令放后台」的章程句。平台 Skill 索引和这台主机的记忆入口都在正文里。相对 MCP `cwd` 按主机数据目录解析，因为还没有 Run 工作区；真实 Run 会改按该次执行根解析。未探测的 Runtime 版本按「满足 MCP 最低版本」处理，与投影器在版本缺失时的判断相同。Codex 的同名冲突要先拉起 CLI 才能发现，预览不拉起进程，因此不剔除那些名字。

脚本：

```bash
node scripts/loom-profile.mjs projection --host <源> --token-file <文件> --member <id 或显示名> [--runtime codex-cli|claude-code] [--out 文件.json]
node scripts/loom-profile.mjs projection --compare <左.json> <右.json>
```

`--compare` 先规范化再比较，退出码 0 表示一致。规范化丢掉这些字段：

| 字段 | 变成 |
|---|---|
| 顶层 `agentId` | 不参与比较 |
| 整个 JSON 字符串若是绝对路径（POSIX `/…`、盘符、UNC） | `<path>` |
| Bootstrap 里平台 Skill 的 `"root"` | `<path>` |
| UUID | `<id>` |
| `agent_<记号>` | `<id>` |
| `sha256:<十六进制>` | `<digest>` |
| ISO-8601 时间戳 | `<time>` |

显示名、runtime、章程、队员六列、MCP 命令与 URL 保留。记忆入口里的检索词属于主机记忆，不是 profile；两边记忆不同时，比较会在这一段分开。
