# LOOM 远端 + 本地双端：交接书（2026-11-01）

> 状态：**用户要求暂停（2026-11-01）**。目标 `goal-58fe8e2d` 已置 paused。本文件是恢复入口。
> 用户原话方向：「远端机器放服务端，本地被控；本地有对应 CLI 也可以在本地跑，没有就落到远端；远端配齐 codex / claude 等 CLI；最主要的是规则 / MCP / skill 能同时用于远端和本地。」

## 1. 一句话现状

多主机架构已跑通到「远端服务端常驻 + 从本地 App 打开 + 助手规则两端同步 + 远端真跑编排到导入计划这一步」。**卡在两处**：r3 文案已确认但未实施；以及所有需要用户亲手/亲点的事（Tailscale 授权、装包、实机验收）。

## 2. 里程碑进度

| 里程碑 | 状态 | 证据 |
|---|---|---|
| M0 摸清架构 | ✅ | `plan-remote-2026-10-31.md` §1（Pi 工兵 `50fc3360` / `72654630`，主管抽查属实） |
| M1 bero 服务端（隧道 + 鉴权，不裸开端口） | ✅ | §5：systemd `loom-server`（`127.0.0.1:8767`，用户 `loom`）+ `loom-tunnel`（cloudflared 出站）；隧道 401/401/200；重启 3 次 0 次 `IdentityChanged` |
| M2 本地 App 连远端 | 🟡 代码完成，等实机 | `2d59be8` 设置页「远端主机」；`0144133` 隔离窗口；bero `test:settings-workspace` 1/0 |
| M2 附带：ACCP 真实 Gate | 🟡 | 远端冒烟到「导入计划」（§6）；本机 Gate 仍未做 |
| M3 按 CLI 可用性选主机 | ✅ 代码 | `9a33e94` `OpenOnRemoteHostButton`（消息未发送行 + 未安装行）；vitest 189/189 |
| M4 远端一键配齐 CLI | ✅ 脚本 | `scripts/provision-remote-runtimes.sh` + `server-preview.md` 六步；文档禁止 Core 代装 |
| M5 助手 profile 两端生效 | ✅ 本机→bero | `loom-profile.mjs`；漂移恢复实测（§5）；bero→本机未做（需本机开远程连接） |

## 3. 远端 bero 现状（暂停时仍在运行）

| 项 | 内容 |
|---|---|
| 程序 | `/opt/loom-server/<commit>`，`current` 软链；由 `node scripts/build-server.mjs` 在 bero 本机构建（glibc 2.39 > 发行基线 2.35，**不能当发行包**，自用无碍） |
| 服务 | `loom-server.service`：`User=loom`，`--data-dir /var/lib/loom-server --listen 127.0.0.1:8767 --public-origin <隧道>`；数据根 700 |
| 隧道 | `loom-tunnel.service`：cloudflared quick tunnel，`User=loom`，只出站。**地址每次重启都变**，变了必须同步 `--public-origin`，否则 API 一律 `origin_not_allowed`。当前地址记在 `/var/lib/loom-server/.tunnel-origin` |
| 登录 | 地址 + 64-hex Token 存在本地 `skill-cli/archive/secrets/loom-bero-server.txt`（gitignored，**不入 git、不入对话**） |
| CLI | `loom` 用户下 `/home/loom/.npm-global/bin`：Claude Code 2.1.316、codex-cli 0.166.0；服务端 `adapter_installation` 两条 `path_state=valid` |
| 模型 | 两家都走用户 Octopus（`http://192.99.232.234:5050`，SSOT `OCTOPUS_PROD_BASE_URL` 已现验）。Codex：`~/.codex/config.toml` provider `octopus`（wire `responses`）+ `auth.json`；Claude：`settings.json` `ANTHROPIC_BASE_URL` + `apiKeyHelper` 读 600 的 `octopus.key`，模型**只有** `claude-opus-5.5`。密钥另存本地 `archive/secrets/octopus-prod.txt` |
| ⚠️ 必配 | `~/.codex/config.toml` 的 `[sandbox_workspace_write] network_access = true`（否则 Codex 沙箱拒绝 Unix socket，`rovai` 全部 `cli_error`，见 §7） |
| Tailscale | 已装 1.104.4，`tailscale up --hostname=loom-bero` **仍在等用户点授权链接**（`/tmp/ts-up.log`）。授权后：`tailscale serve` 只给 tailnet 暴露 8767，改 `--public-origin` 为 tailnet 地址，停 `loom-tunnel` |

## 4. 本地（用户 Win11）

- 已装 App：**r2 包**（`dist/windows-x64-unsigned-4`, sha256 `9382e300…`）。**r3 环境下的最新包 `dist/windows-x64-unsigned-6/…`（sha256 `89d35cee…`）还没装**，里面才有「远端主机」设置页和「在远端主机打开」按钮。
- 本机 Tailscale 已在 tailnet（账号 `aa979167273@`）。
- 本机 Desktop 库只读导出：`archive/secrets/loom-profile-local.json`（4 队员 + member-studio 全员）。

## 5. 已验证的关键证据

- **M1**：隧道页面 200（标题 `Rovai AI`）；无 Token `session_required` 401；错 Token `invalid_administrator_token` 401；正确 Token 200；本机直连同样 200/401。`loom-server` 连续重启 3 次全 `active`，`IdentityChanged` 0 次，Token 摘要不变。
- **M5**：本机 profile 对 bero 预演 **0 处改动**（两边本来就一致）→ 人为把叮叮一条规则改成 `DRIFT-TEST` → 用本机 profile apply 恢复 → 再预演 **0 处改动**。
- **CI / 出包**：`41239625384`（CI）、`41239732256`（Windows，sha256 `26ce8601…`）；`41241972813`（CI）、`41242405053`（Windows，sha256 `89d35cee…`）全绿，打包自检 `Result: passed`。
- **本地测试**：`pnpm typecheck` 0；`docs:check` 0；`vitest` 189/189（含 `remote-host.test.ts` 5 条、`OpenOnRemoteHostButton` 3 条）；`node --test scripts/lib/loom-profile.test.mjs` 3/3；`provision-remote-runtimes` 3/3。
- **已知环境红**：`scripts/lib/settings-workspace.test.mjs` 在本机 Windows 报 `actual: null, expected: 0`，**改动前基线同样红**（已 stash 复跑确认），bero `xvfb-run` 下 1/0 通过。`scripts/lib/server-install.test.mjs` 本机红是因为缺 `target/debug/rovai-server.exe`（未做本地 Rust 构建），与改动无关。

## 6. 远端 ACCP 冒烟（`plan-remote-2026-10-31.md` §6）

两轮，Lead = 叮叮（Codex + Octopus），Mission `rvm_01a193df…` / `rvm_01a193ed…`：

1. **第 1 轮**：所有 `rovai …` 返回 `builtin_tool.cli_error`，Run 30 秒结束。根因 = Codex Linux 沙箱 seccomp 拒 Unix socket（沙箱内 `connect` 得 `EPERM`，`danger-full-access` 或 `network_access=true` 才通）。已配 `network_access = true` 并写进 `server-preview.md`。
2. **第 2 轮**：`rovai loom status` 成功、读到 LOOM 指引；`rovai loom plan` 反复 `builtin_tool.invalid_input`，计划未导入。根因 = 计划文件格式对模型不可见（`--help` 只说三项是数组；本机复现：`null` / 多字段 / 字段名错 / 大写 `condition` 全回同一句通用报错）。→ **r3 已确认，未实施**。

## 7. 交接时必须知道的坑

1. **服务端不能以 root 跑**（B1 根因）：root 打开既有 WAL 库时 SQLite `fchown` WAL，只改 **ctime**；`database_admission` 身份戳含 ctime（`database_admission.rs:1097-1107`），二次开库报 `IdentityChanged{stage:Revalidation}`。bero 那 3 个老测试失败也是这原因（以 root 跑测试）。非 root 即消失。
2. **Linux + Codex 必须 `network_access = true`**，否则 `rovai` 内置命令全废（§6 第 1 轮）。
3. **quick tunnel 地址会变**：`loom-tunnel` 重启 → 必须改 `loom-server` 的 `--public-origin` → 重启 server，否则 `origin_not_allowed`。
4. **程序目录权限**：`web-ui/` 若 700，改普通用户运行后报 `Matching WebUI is missing index.html`；需 `chmod -R a+rX`。
5. **改数据根属主会让准入失败**（`runtime_camp_files_root_invalid: root marker identity mismatch`）：换用户要重新初始化数据根，不能只 `chown`。
6. **`install-server.sh` / `.ps1` 已从上游改为本 fork**（`90ece89`）；`website/`、`SECURITY.md`、`.github/CODEOWNERS` 仍指上游，只登记未改。
7. **Pi 工兵**：`fcb063b0` 撞 `--max-runtime` 超时但白名单文件都改完（主管逐项复核后 `2d59be8`）；工兵自报 `ok:true` 不算验收，必须主管独立复跑。

## 8. 恢复后第一件事

1. **实施 r3**（已确认，见 `docs/versions/v1.72/model-context-change-loom-accp.md` 的「r3 修订」）：
   - `crates/rovai-core/src/loom_tool.rs`：`loom.plan` 描述末尾加「Pass the plan as JSON with --input-file; the exact file shape is in the cli-operations LOOM reference.」
   - `skills/cli-operations/references/loom.md`：`## Plan` 节末追加完整计划 JSON 样例 + 「可选项省略、不要写 null、`task_done` 小写」说明。
   - 测试：`--help` / reference 逐字一致；样例原样过 `loom.plan` 封闭 schema（新增测试）。
2. **再跑一次远端冒烟**，目标推进到「放行 → 认领 → 登记证据 → 提交交付」（脚本 `_artifacts/tmp/remote_accp_smoke.py`，Mission 描述已写好）。
3. **出 Windows 包 + 装到本机**（要用户点头关 App）。
4. **等用户**：Tailscale 授权链接；实机 Gate（设置 → 能力 → 远端主机 → 打开 → 用 Token 登录 → 建使命 → 叮叮规划 → 编排图 → 交付验收）。

## 9. 待用户决定 / 待用户动手

- Tailscale 授权：`https://login.tailscale.com/a/89d514d018d77`（会过期，过期就重发）。
- 装 `dist/windows-x64-unsigned-6`（或等 r3 后一起出包再装）。
- 远端 Claude / Codex 账号已用 Octopus 配好，**不需要用户再登录**。
- Octopus 密钥已直接出现在聊天记录里，用户可自行决定是否轮换。
- 是否要把 `website/`、`SECURITY.md`、`.github/CODEOWNERS` 的上游仓库名也改成 fork。

## 10. 台账

- loom `main` = `c907b97`（已推送）。本轮关键提交：`0144133`（远端窗口安全核心 + profile 工具）、`8b3984b`（profile 幂等）、`2d59be8`（远端主机设置页）、`9a33e94`（在远端主机打开 + 服务端指南）、`4e746e8`（Codex 沙箱 socket 记录）、`c907b97`（r3 确认记录）。
- 计划文档：`docs/loom/plan-remote-2026-10-31.md`（§5 M1 执行记录与 B1 根因，§6 远端冒烟两轮）。
- 项目记忆：`skill-cli/TASK.md`（顶部即本线现状）、`PROJECT_CONTEXT.md`（root 运行、bero 部署、Codex socket 三条长期事实）。
