# 方案 B 的本地参考仓库

给 [`plan-b-a-controls-b-2026-11-01.md`](plan-b-a-controls-b-2026-11-01.md) 用。核对日期 2026-11-01。

这些目录只放在仓库外面，建议 `~/loom-refs/`。不要放进本仓库，不要做成 submodule，不要把其中的源码抄进 LOOM。LOOM 继承 Rovai 的 MIT；AGPL 和 Business Source License 的仓库连参考目录都不要克隆，需要时读官方文档。

钉死的是提交 SHA。标签方便人认，以 SHA 为准。

```bash
mkdir -p ~/loom-refs
cd ~/loom-refs
```

每个仓库：

```bash
git clone <url> <目录名>
git -C <目录名> checkout <sha>
```

## 要克隆的

### 执行节点怎么连、日志怎么续

| 目录名 | Git | 标签 | SHA | 读哪里 | 为什么 |
|---|---|---|---|---|---|
| `buildkite-agent` | <https://github.com/buildkite/agent.git> | `v4.9.0` | `735f98f3de5a29a9b3b60a36bbcef4f4e1d9ba17` | `agent/agent_worker_heartbeat.go`、`agent/agent_worker_ping.go`、`agent/log_streamer.go`、`agent/job_runner.go` | MIT。节点出站、心跳、日志按序号分块。方案 B 的 WebSocket 帧直接照这个序号模型 |
| `gitea-runner` | <https://gitea.com/gitea/runner.git> | `v5.2.4` | `ffd80101a317d6c3ef922dfb4856b629b3d60064` | `internal/` | MIT。现行的 Gitea Actions runner（旧名 act_runner；GitHub 上 `gitea/act_runner` 已 404）。注册令牌换成落盘身份，再出站领任务 |
| `woodpecker` | <https://github.com/woodpecker-ci/woodpecker.git> | `v3.20.1` | `3f1bb0bd0db28e410ad797034d75780116122c91` | `agent/`、`rpc/` | Apache-2.0。小的出站 agent。以后若把帧从 WebSocket 换成 gRPC，看这里，拨号方向不变 |
| `actions-runner` | <https://github.com/actions/runner.git> | `v2.338.2` | `d1eb12d4b115c301201de27d667284e1a80f2ab5` | 只看 `src/Runner.Listener`、`src/Runner.Worker` | MIT，但是大型 C#。补看「长轮询、注册凭据、日志往外推」。日常先读上面三份 |

### 我们要启动的 CLI，以及远程工作区的 API 形状

| 目录名 | Git | 标签 | SHA | 读哪里 | 为什么 |
|---|---|---|---|---|---|
| `codex` | <https://github.com/openai/codex.git> | `rust-v0.166.0` | `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` | `codex-rs/cli`、`codex-rs/app-server`、`codex-rs/app-server-protocol` | Apache-2.0。Rovai 已经在本机拉起 `app-server --listen stdio://`。B1 用一次退出的 `codex exec`。`code-mode-host` 是连到 OpenAI 的出站，不是 LOOM 的协议 |
| `openhands-sdk` | <https://github.com/OpenHands/software-agent-sdk.git> | `v1.59.0` | `ccae18cb897bef7960f210aa3f380b577a84be7c` | `openhands-agent-server/`、`openhands-workspace/` | MIT。事件、文件、执行命令是同一套工作区 API。他们的服务器是听端口，LOOM 要改成节点拨入 |

### 界面上怎么同时看见多路助手

| 目录名 | Git | 钉死点 | SHA | 读哪里 | 为什么 |
|---|---|---|---|---|---|
| `openhands` | <https://github.com/OpenHands/OpenHands.git> | 标签 `v1.34.0` | `6c120073f5a1e1c838ba6fdd9a075c79ff997b98` | 仓库根的界面（`electron/`、`public/`）里会话、终端、文件树 | MIT。文件树和事件流的信息怎么摆。不要从 `docker/` 读起，也不要把它的外观搬过来 |
| `vibe-kanban` | <https://github.com/BloopAI/vibe-kanban.git> | `main`（标签 `v0.1.44` 停在 2026-04，不能用） | `7c3807084daad0d9d315064f60fa869de254f027` | `packages/`、`crates/` | Apache-2.0。并行任务卡：一屏看见多路，点进去才是输出。LOOM 的泳道卡片借这个信息密度 |
| `conductor` | <https://github.com/microsoft/conductor.git> | `v0.1.44` | `65e632328dedbb2a15ef546ca76fce64e5bdcc68` | `src/`、`docs/` | MIT。YAML 里的并行组，每一步单独有状态。不是 conductor.build，那份没有源码 |

## 核对过，不要克隆

| 项目 | 许可 | 核对到的标签 | SHA | 原因 |
|---|---|---|---|---|
| [coder/coder](https://github.com/coder/coder) | AGPL-3.0 | `v2.37.9` | `f12050792076720fb7e2e48b44e39eeb6085d713` | 拨号方向和「一条隧道上同时跑终端与文件」值得读文档，代码不能进参考目录。文档：<https://coder.com/docs/ai-coder/agents/architecture/> |
| [gravitational/teleport](https://github.com/gravitational/teleport) | AGPL-3.0 | `v18.10.0` | `ddaa46b8f4ee579d43480cd2d3b6a14b18e3ef7d` | 反向隧道和短期 join token。仓库过大，许可不合适 |
| [smtg-ai/claude-squad](https://github.com/smtg-ai/claude-squad) | AGPL-3.0 | `v1.0.20` | `ce1ffb4392b01f38e2c4599c7c84d2a93973b138` | tmux + worktree 的多 CLI 终端。看 README 即可 |
| [hashicorp/nomad](https://github.com/hashicorp/nomad) | BUSL-1.1（1.7.0 起，许可方 IBM） | `v2.1.1` | `d0f21042997689c7690421ede8849be694e2ce46` | GitHub API 显示 `NOASSERTION`，以仓库 `LICENSE` 正文为准。只借「一台客户端接一份分配」这个概念 |
| [tailscale/tailscale](https://github.com/tailscale/tailscale) | BSD-3-Clause | `v1.104.4` | `27047635f237d1f3e0b08c0f487674757f30d2f7` | 可选的底层网络，不是执行协议。仓库过大 |
| [juanfont/headscale](https://github.com/juanfont/headscale) | BSD-3-Clause | `v0.29.7` | `c9cf210b8bc84d13177e18b91f555788a44b47b6` | 自托管协调服务器。方案 A 的 Tailscale 已经够用时不必读源码 |
| [fatedier/frp](https://github.com/fatedier/frp) | Apache-2.0 | `v0.71.1` | `d8cf1800dc1abd7fda1828cab105d7a6b5a50eb1` | 通用反向代理。方案 B 不走这条 |
| [rathole-org/rathole](https://github.com/rathole-org/rathole) | Apache-2.0 | 最后标签 `v0.5.0`（2023）；`main` 为下行 SHA | `a292f7ed5402f840415fc6a53827da2f34337856` | 同上。标签已旧 |
| [jpillora/chisel](https://github.com/jpillora/chisel) | MIT | `v1.12.0` | `fe4f4fe7e6a849b4aa6d1b8ee47037e16033f42a` | 同上 |
| [ekzhang/bore](https://github.com/ekzhang/bore) | MIT | `v0.6.0` | `8e059cdaf993d25d92080a2b28a71949a4545d03` | 同上，更小 |
| [cloudflare/cloudflared](https://github.com/cloudflare/cloudflared) | Apache-2.0 | `2026.10.7` | `872b241f94871665c1c157adefcf90c11f0ead96` | 方案 A 已经用它把浏览器接到 A。继续只做这件事 |
| [coder/code-server](https://github.com/coder/code-server) | MIT | `v4.144.0` | `ee31cdbe02c07b3ba718007f221d14c890696c61` | 自己听端口，是方案 A 的形状 |
| [gitpod-io/openvscode-server](https://github.com/gitpod-io/openvscode-server) | MIT | `openvscode-server-v1.109.5` | `4ffe2270acdf711bbefecc3e8c79f4b3631640e5` | 同上 |
| [temporalio/temporal](https://github.com/temporalio/temporal) | MIT | `v1.32.1` | `af08a5e5f2dd40f545f2afac7780daaa6987001e` | 借 worker 出站轮询即可。文档：<https://docs.temporal.io/workers>。不要把服务器嵌进 LOOM |
| [stravu/crystal](https://github.com/stravu/crystal) | MIT | `v0.3.5` | `1e18e0bc981225f75b5226f82a300fa741970c6f` | 2026-02 起停更，后继产品没有可对照的源码 |
| [anthropics/claude-code](https://github.com/anthropics/claude-code) | 非开源（商业条款） | `v2.1.316` | `80c6959d28c4c30ecd14fc1cdf172f19d9adad81` | 标签树上没有可借用的实现。无头模式看 <https://code.claude.com/docs/en/headless> |
| conductor.build | 闭源 | 无 | 无 | 只有产品页 <https://www.conductor.build/> |
| [ryanmac/code-conductor](https://github.com/ryanmac/code-conductor) | MIT | 未钉 | 未钉 | 用 GitHub Issue 当队列。LOOM 已有认领，不必读 |

VS Code Remote Tunnels 没有单独的自托管仓库。产品说明在 <https://code.visualstudio.com/docs/remote/tunnels>：远端机器出站连到微软的中继。方案 B 用 A 自己当这端，不克隆 VS Code。
