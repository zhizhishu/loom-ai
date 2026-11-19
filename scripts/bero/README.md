# DE-BERO loom-dev（P-1 开发容器）

用户 2026-11-18 决定：LOOM 在 DE-BERO 极速开发、测试、验收；Windows 包走 GitHub Actions；终态上云。

- 进机只走 `komari-ssh`（主机别名 `bero`），按 `berobox`：自己的编译用默认 runc，不加 gVisor；不挂宿主密钥；删容器/卷/prune 先问用户。
- 宿主目录：`/root/sandbox/projects/loom-dev/`
  - `src/`：本仓库克隆（分支 `rovai/loom-v2-personal-20261116`），挂到容器 `/src`
  - `cospan/`：keli-wen/cospan `45ab14d`，只读挂到 `/opt/cospan`
  - `cache/`：cargo registry/git、`target`（容器 `/cache/target`）、pnpm，全持久化，只做增量编译
  - `bundles/`：从用户电脑传来的 git bundle（未推送提交）
  - `logs/`：`setup.log`、`baseline.log`、`baseline.summary`、`step-*.log`
- 镜像 `loom-dev:base`：node:24-bookworm + Rust 1.97.1（clippy、rustfmt）+ pnpm 11.20.0，版本跟 `.github/workflows/loom-v2-container.yml`。**绝不装 Claude CLI。**
- 容器 `loom-dev`：`--init`（进程组测试需要）、`sleep infinity`、`--restart unless-stopped`。
- **Pi 工兵（2026-11-19 搬入，用户电脑不再跑工兵）**：Pi `1.5.0` 装在持久卷 `cache/npm-global`（`/opt/npm-global`）；`pi-home/` 挂到 `/root/.pi`，内含 `agent/models.json`（只留 `oct-chat`，`baseUrl` 为 Octopus 公网 `https://oct.agent-ai.vip/v1`，`apiKey: "$OCT_API_KEY"`）、`agent/settings.json`、`agent/extensions/pi-worker`、`pi-skill/`、`claude-hooks/`（7 个工兵守卫）。
- 密钥：只在宿主 `secrets/pi.env`（`OCT_API_KEY=…`，600）经 `--env-file` 进容器环境；不进镜像、仓库、回执。
- 上游参考只读副本：`bundles/refs/`（mikka `42f39219e` 的 `lib/factory`、`lib/computer`；accp `77f0577` 的 `internal/controlplane`），容器内 `/bundles/refs`。
- DSH、Codex 尚未装。

## 常用命令（在 bero 宿主上，经 komari-ssh 执行）

```bash
docker exec loom-dev bash -lc 'cd /src && cargo check -p rovai-core -j 4'
docker exec loom-dev bash -lc 'cd /src && cargo test -p rovai-core --lib -j 4 <filter>'
docker exec loom-dev bash -lc 'cd /src && node --test scripts/<x>.test.mjs'
```

同步未推送提交：用户电脑 `git bundle create x.bundle <bero 上已有提交>..HEAD`，经 komari `run-script` 以 base64 heredoc 写到 `bundles/`，再在 `src/` 里 `git fetch <bundle> HEAD:refs/heads/tmp && git merge --ff-only tmp`。推送 GitHub 须用户同意。

派 Pi 工兵（在宿主执行，后台跑、读 `/logs`）：

```bash
docker exec -d loom-dev sh -c 'cd /src && PYTHONUTF8=1 PI_SKILL_DATA_DIR=/root/.pi/pi-skill-data \
  python3 /root/.codex/skills/pi-skill/pi_skill_cli.py run --tools file --root /src --task - \
  < /bundles/tasks/<task>.txt > /logs/<task>.json 2>/logs/<task>.err'
```

只读用 `--tools file`；续会话 `--session-id <sid>`；验收 `approve --verdict accepted|rejected`。

脚本：`loom-dev-setup.sh`（幂等建镜像与容器）、`loom-dev-baseline.sh`（拉 bundle + 基线计时）。
