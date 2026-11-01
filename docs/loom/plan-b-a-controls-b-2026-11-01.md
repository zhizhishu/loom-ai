# LOOM 方案 B：A 调度，B 出站执行（2026-11-01）

> 用户要的结果：机器 A 是有公网地址的 LOOM 服务器。机器 B（例如家里的电脑）可以没有公网地址。A 要能让 B 干活。一次使命可以拆给多个 CLI（Claude Code、Codex，以及其他已接入的运行时）和多个助手；有的助手在 A 上跑，有的在 B 上跑，都由 A 排。每个助手从云端目录里勾选技能、MCP、规则和 hook。产品仍然是「当前项目的一个文件夹」，带文件管理。界面要和本机桌面一样全，并加上一块看得清现场进度的编排视图。
>
> 这就是方案 B：A 上只有一个 Core。B 上跑一个节点代理，主动连到 A，接受执行。
>
> 本文只定方案。不改 Rust、不改界面、不改数据库。行号对着写本文时的 `main`（`5b44585`）。函数名比行号稳，行号会随别人的提交漂移。
>
> 事实底稿：[`plan-remote-2026-10-31.md`](plan-remote-2026-10-31.md) §1、[`handoff-remote-2026-11-01.md`](handoff-remote-2026-11-01.md)、[`architecture-round4-2026-10-29.md`](architecture-round4-2026-10-29.md)、仓库根的 [`LOOM.md`](../../LOOM.md)。克隆哪些参考仓库见 [`references-plan-b.md`](references-plan-b.md)。

## 0. 结论

A 继续跑现在的 `rovai-server`（一个 Host、一个 Core、一份 SQLite）。浏览器和桌面都连 A，这一点方案 A 已经走通。

新加的是执行位置。B 不对外开放端口。B 用 WebSocket 连到 A，带上自己的节点凭据，定时心跳，并上报本机装了哪些 CLI。A 把一次 Run 整段交给某一台在线节点。节点在 B 上启动进程，把标准输出、标准错误和退出码送回 A。项目文件留在持有该工作区的那台节点上，A 上的文件管理只是把读、列、写转过去。

A 自己也算一台节点，只是这台节点不走网络，直接调用现有的 `ManagedProcess::spawn`。这样「有的助手在 A、有的在 B」是同一种排程，不是两套产品。

方案 A 留下的东西见第 5 节。方案 A 解决的是「人怎么打开远端那台机器上的整套 LOOM」。它解决不了「B 没有公网地址，却要被 A 派活」。

## 1. 别人怎么做的

2026-11-01 核对过公开仓库的许可文件、默认分支或发行标签，以及官方文档。钉死的提交在 [`references-plan-b.md`](references-plan-b.md)。下面每条都写：谁拨谁、凭什么相信对方、断了怎么接、工作 / 进程 / 文件走哪条通道、LOOM 该借什么、要不要克隆到本机旁边读。

「克隆」指放到仓库外面的 `~/loom-refs/`，当阅读材料。不要 submodule，不要把别人的源码抄进这个 MIT 仓库。AGPL 和 BUSL 的仓库只读文档，不克隆进参考目录。

### 1.1 方向对的：节点主动连控制面，控制面再把活送回去

这是方案 B 的同一类问题。家里的机器没有公网地址，只能自己往外拨。

#### GitHub Actions 自托管 runner

- 仓库：<https://github.com/actions/runner>，MIT。标签 `v2.338.2`。
- 谁拨谁：runner 进程出站访问 GitHub（HTTPS 443）。GitHub 不连回 runner。GitHub Enterprise Server 文档写明：长轮询大约 50 秒，超时就再拨一次；只要求 runner 到服务器的出站 HTTP(S)。
- 鉴权：注册令牌换成一份存在 runner 机器上的凭据。令牌和 `.runner` 一类身份文件不能拷到第二台机器。超过 14 天不连会被删掉；临时 runner 更短。
- 通道：任务说明、日志、产物、缓存都是 runner 自己往外上传。机器上要预先装好任务要用的工具。
- LOOM 该借：注册令牌和长期节点身份分开；掉线只影响新任务，不要从控制面去「连」节点；日志由节点往外推。
- 本地参考：要克隆，但仓库是大型 C#。只读 `src/Runner.Listener` 和 `src/Runner.Worker`。

#### Gitea Actions runner（原先的 act_runner）

- 仓库：<https://gitea.com/gitea/runner>，MIT。标签 `v5.2.4`。GitHub 上的 `gitea/act_runner` 在核对当天返回 404，现行官方仓库在 gitea.com。
- 谁拨谁：runner 向 Gitea 实例出站注册，再用 gRPC 长轮询要任务。实例在 NAT 后面时不需要入站端口。机器关机时任务在服务器上排队，runner 回来再领。
- 鉴权：实例、组织或仓库级注册令牌。注册成功后写下 `.runner`，里面是 runner 自己的 API 凭据。丢了就重新注册，不要手改，不要两台机器共用。
- 通道：任务在 runner 本机执行（底层沿用 act 去跑 workflow）。日志回到 Gitea。
- LOOM 该借：一次性配对码和落盘的节点身份；身份文件权限收紧；一台节点一个身份。
- 本地参考：要克隆。体积比 GitHub runner 小，优先读 `internal/`。

#### Buildkite agent

- 仓库：<https://github.com/buildkite/agent>，MIT。标签 `v4.9.0`。
- 谁拨谁：agent 拿着 agent token 出站连 Buildkite。心跳和领任务都是 agent 发起。
- 鉴权：agent token。任务环境变量和密钥由控制面随任务下发，不要求 agent 机器事先拥有控制面的管理员口令。
- 通道：进程在 agent 机器上跑。日志按序号分块上传（`agent/log_streamer.go`），断线后用序号接着传，而不是把整段日志重头再塞一遍。心跳在 `agent/agent_worker_heartbeat.go`，探活在 `agent/agent_worker_ping.go`。
- LOOM 该借：输出帧带递增序号和确认号。这是 B2 重连的直接样板。
- 本地参考：要克隆，而且是协议方面第一本该读的。重点就是上面三个文件，加上 `agent/job_runner.go`。

#### Woodpecker agent

- 仓库：<https://github.com/woodpecker-ci/woodpecker>，Apache-2.0。标签 `v3.20.1`。
- 谁拨谁：agent 启动时带上服务器地址，自己连过去。服务器不拨 agent。
- 鉴权：agent 令牌。
- 通道：gRPC。流水线步骤在 agent 侧执行，状态和日志送回服务器。
- LOOM 该借：一个小进程就够当节点，不必把 Core 搬到 B。若以后把 WebSocket 上的 JSON 换成 gRPC，拨号方向保持不变。
- 本地参考：要克隆。读 `agent/` 和 `rpc/`。

#### Coder 工作区代理 + DERP

- 仓库：<https://github.com/coder/coder>，AGPL-3.0。标签 `v2.37.9`。
- 谁拨谁：工作区里的 agent 出站连 `coderd`。控制面再沿着这条已经建立的连接回去：开终端、传文件、跑命令。工作区不需要入站端口。打洞失败时走 DERP 中继；Coder 可以自带 DERP，也可以指向 Tailscale 的 DERP 地图。
- 鉴权：工作区代理有自己的身份，用户登录控制面用的是另一套会话。
- 通道：同一条 tailnet。网页终端是 WebSocket，SSH 是 SSH，代理的 HTTP API 负责读文件和起进程。官方架构说明写的是：代理循环在控制面里发工具调用，工作区守护进程在隧道那头执行。
- LOOM 该借：三个形状。一，节点只出站，控制面顺着这条连接把文件和进程请求送回去。二，浏览器、文件、进程共用这一条已认证的连接，不要为了文件再在 B 上开一个端口。三，A 上的界面和 B 上的文件可以不在同一台机器。
- 本地参考：不克隆。AGPL 代码不能进 MIT 产品，也不放进参考目录。需要看图时读官方文档 [Architecture](https://coder.com/docs/ai-coder/agents/architecture/) 即可。

#### Teleport 节点代理

- 仓库：<https://github.com/gravitational/teleport>，AGPL-3.0。标签 `v18.10.0`。
- 谁拨谁：节点反向拨到代理（proxy），在 NAT 后也不需要公网入站。加入集群用短期 join token，换成节点证书。
- 通道：SSH、Kubernetes、数据库会话复用在这条反向隧道上。会话可以录下来。
- LOOM 该借：短期配对、长期证书或令牌；会话有始有终，输出可回放。LOOM 已有的 Run 记录就是回放的存放处，不必另做一套录像产品。
- 本地参考：不克隆。AGPL，仓库也过大。

#### Temporal worker

- 仓库：<https://github.com/temporalio/temporal>，MIT。标签 `v1.32.1`。
- 谁拨谁：worker 出站，用 gRPC 长轮询任务队列。服务器不连接 worker。
- 鉴权：命名空间和 worker 身份。
- 通道：传的是活动的输入、输出和心跳，不是一个长期存活的进程的标准输入输出。工作流状态在服务器上。worker 死了，活动按策略重试。
- LOOM 该借：队列、心跳超时、重试要有次数和间隔。一次 Run 的状态记在 A 的库里，不要只放在 A 的内存里。
- 不该借：把 LOOM 嵌进 Temporal。那是另一整套服务器。进程输出的流式字节也不是 Temporal 活动的返回值能直接代替的。
- 本地参考：不克隆服务器。读 [Workers](https://docs.temporal.io/workers) 就够。

#### Nomad client

- 仓库：<https://github.com/hashicorp/nomad>，Business Source License 1.1（1.7.0 及以后；许可方 IBM）。GitHub API 对这份许可回报 `NOASSERTION`，以仓库里的 `LICENSE` 正文为准。标签 `v2.1.1`。
- 谁拨谁：client 向 server 注册并心跳。分配（allocation）在 client 上跑。日志经 client 的接口读出。
- LOOM 该借：节点有状态（就绪、忙碌、失联）；一次分配落在一台机器上；失联的节点不再接新活。
- 本地参考：不克隆。许可不允许当普通依赖，仓库也过大。

#### OpenHands 远程运行时

- 应用：<https://github.com/OpenHands/OpenHands>，MIT。标签 `v1.34.0`。（`All-Hands-AI/OpenHands` 指向同一处。）
- SDK：<https://github.com/OpenHands/software-agent-sdk>，MIT。标签 `v1.59.0`。
- 谁拨谁：和方案 B 相反。Agent Server 在执行机器上监听 HTTP 和 WebSocket，客户端拨进去。官方文档把远程工作区写成 `DockerWorkspace` / `APIRemoteWorkspace`，客户端连服务器。B 没有公网地址时，这条路走不通，除非再加一层隧道。Devin 没有可克隆的实现，公开的同类就是这一套。
- 鉴权：Agent Server 可选 API key。
- 通道：WebSocket 推事件。文件上传、下载和 `execute_command` 走同一套工作区 API。换本地目录还是换远程工作区，对话代码保持同一个入口。
- LOOM 该借：事件流的形状（工具开始、工具结束、一块输出、一次退出），以及「文件和命令是工作区的两个方法」。拨号方向改成节点连 A。
- 本地参考：两份都要克隆。SDK 读 `openhands-agent-server/` 和 `openhands-workspace/`。应用读界面，不要从 `docker/` 读起。

#### VS Code Remote Tunnels，以及听端口的 code-server

- 隧道产品说明：<https://code.visualstudio.com/docs/remote/tunnels>。`code tunnel` 跑在那台没有公网入口的机器上，出站连到微软 Dev Tunnels 中继。人和另一台 VS Code 再连到同一个中继。文件和终端是隧道上的 RPC，进程在远端机器。
- 源码：VS Code 仓库是 MIT，但中继服务不是可以自己架的同一套程序。公开的 `anthropics/claude-code` 那种「只有说明、没有实现」这里也类似：协议的可用部分绑在微软的服务上。
- `coder/code-server`（MIT，`v4.144.0`）和 `gitpod-io/openvscode-server`（MIT）是浏览器里的 VS Code，它们自己听端口。人要连进去，就得给这台机器一个地址。这是方案 A 的形状（把服务端暴露出去），不是方案 B。
- LOOM 该借：界面在 A，文件和进程在 B，中间一条已认证的通道。中继可以由 A 自己充当，因为 A 已经有公网地址，不必再依赖 Dev Tunnels。
- 本地参考：不克隆 VS Code，也不克隆 code-server。体积大，而且听端口的那个方向会把方案带偏。

### 1.2 只打通 TCP 的反向隧道

这些项目解决「B 上的某个端口，从 A 看起来像本地端口」。它们不理解 Run、文件树或 CLI。方案 B 不要把执行协议做成「先用隧道把 B 的 shell 暴露出来，A 再去 SSH」。那样 B 上任何一个被转发的端口都变成攻击面，节点能做的事也无法收成「只接收派来的 Run」。

| 项目 | 许可与标签 | 连接 | LOOM 的用法 |
|---|---|---|---|
| [frp](https://github.com/fatedier/frp) | Apache-2.0，`v0.71.1` | `frpc` 出站连 `frps`，令牌认证。控制连接建好后，每个被转发的端口再开工作连接 | 不采用。不克隆 |
| [rathole](https://github.com/rathole-org/rathole) | Apache-2.0。最后标签 `v0.5.0`（2023），`main` 停在 2026-08 | 同上，Rust，Noise 握手。标签已经旧，若只是好奇应看 `main` | 不采用。不克隆 |
| [chisel](https://github.com/jpillora/chisel) | MIT，`v1.12.0` | 客户端出站，用 HTTP 承载，反向转发 TCP | 不采用。不克隆 |
| [bore](https://github.com/ekzhang/bore) | MIT，`v0.6.0` | 更小的同类 | 不采用 |
| [cloudflared](https://github.com/cloudflare/cloudflared) | Apache-2.0，`2026.10.7` | 出站隧道。方案 A 已经用它把浏览器接到 A 上只听回环的 `rovai-server` | 继续只做「人怎么打开 A」。不要拿它把 B 的端口映到公网 |

### 1.3 有公网身份、但不是「A 派活到 B」的网络

#### Tailscale DERP 与 headscale

- Tailscale：<https://github.com/tailscale/tailscale>，BSD-3-Clause，`v1.104.4`。
- headscale：<https://github.com/juanfont/headscale>，BSD-3-Clause，`v0.29.7`。自托管的协调服务器。
- 谁拨谁：两端都出站连协调服务器。直连失败时，流量经 DERP 中继。B 因此得到一个 tailnet 地址，即使它没有公网 IP。
- LOOM 该借：可选的底层网络。节点 WebSocket 可以拨 A 的公网地址，也可以拨 A 的 tailnet 地址。DERP 不是执行协议。方案 A 留下的 Tailscale 继续负责人怎么访问 A，见第 5 节。
- 本地参考：不克隆。两份仓库都过大。

### 1.4 多 CLI、多助手的界面

这些项目不管 NAT。它们管「同时看好几路助手在干什么」。

#### 本仓库已经有的编排和执行过程

LOOM 的编排在 `apps/desktop/src/renderer/src/LoomWorkspace.tsx`。`LoomWorkspace` 用三个视图读同一份使命：活动、编排、交付。编排按依赖深度分泳道（约 173–182 行），列上标「阶段」，卡片上能放认领、fence 和阻塞原因。数据来自 `loom.plan.get`、`loom.tasks.list`、`loom.claims.list` 等已有 RPC（约 637–654 行）。

执行过程在 `ThreadWorkspace.tsx` 的「执行过程」面板和队员执行卡片里，不是编排页上的第二套时间线。

文件侧今天是预览，不是一棵完整的项目树。合同在 [`docs/ui/components/file-preview.md`](../ui/components/file-preview.md) 和 [`docs/ui/components/conversation-workspace.md`](../ui/components/conversation-workspace.md)。会话里的文件链接、变更和预览分栏已经能打开文件；缺的是「当前项目文件夹」这一棵树。方案 B 补这棵树，点开仍进现有的 `FilePreviewPane`。

技能勾选今天只有内置工具箱五项，见 [`docs/ui/components/skills-settings.md`](../ui/components/skills-settings.md) 的「工具箱：逐队员配置」。MCP 按队员勾选在 `McpSettings.tsx`。规则是队员身份上的六段文字，不是目录。hook 没有产品入口。

这套界面是方案 B 要长上去的底，不要另起一个视觉世界。

#### Claude Code 与 Codex 的无头模式、以及它们自己的远程控制

- Claude Code 公开仓库 <https://github.com/anthropics/claude-code> 标签 `v2.1.316` 的 `LICENSE.md` 是 Anthropic 商业条款，不是开源实现。不要克隆来当代码参考。
- 无头一次任务：`claude -p`（`--print`）。成功退出码 0。文档：<https://code.claude.com/docs/en/headless>。
- 厂商远程控制：`claude remote-control` 把本机会话接到 claude.ai。进程仍在本机，但控制面是 Anthropic，不是机器 A。断网、没有 PTY 时的行为和 LOOM 的节点无关。文档：<https://code.claude.com/docs/en/remote-control>。
- Codex 实现是开源的：<https://github.com/openai/codex>，Apache-2.0，标签 `rust-v0.166.0`。Rovai 今天启动的就是 `codex app-server --listen stdio://`（见下面 2.5 节的引用）。一次任务用 `codex exec`。`codex remote-control` 和 `app-server --code-mode-host wss://...` 是连到 OpenAI 侧的出站，不是 LOOM 能当控制面用的协议。文档：<https://developers.openai.com/codex/cli/reference>。
- LOOM 该借：B1 在节点上跑 `claude -p` 或 `codex exec` 这种一次就结束的命令，把标准输出送回 A。不要把节点做成「去登录 claude.ai / ChatGPT 远程控制」。长期会话（Codex 的 app-server）放在 B1 之后，因为它是一条一直开着的 stdio 协议，断线更难收场。
- 本地参考：只克隆 `openai/codex`。读 `codex-rs/cli`、`codex-rs/app-server`、`codex-rs/app-server-protocol`。

#### Claude Squad

- <https://github.com/smtg-ai/claude-squad>，AGPL-3.0，`v1.0.20`。
- 终端界面。每个助手一个 tmux 会话加一个 git worktree。能启动 Claude Code、Codex、Aider、OpenCode 等。助手之间不对话，也没有依赖图。人在会话之间切换，看 diff，再决定提交。
- LOOM 该借：一个助手一块隔离目录；多 CLI 是启动参数不同，不是不同的产品。编排和验收仍用 LOOM 自己的任务图，不退回「一排互不相干的终端」。
- 本地参考：不克隆。AGPL。

#### Vibe Kanban

- <https://github.com/BloopAI/vibe-kanban>，Apache-2.0。核对当天 `main` 是 `7c3807084daad0d9d315064f60fa869de254f027`（2026-10-28）。发行标签 `v0.1.44` 停在 2026-04，已经不能代表界面。
- 看板上看多路编码助手。每个任务一块工作区，常见做法仍是 git worktree。
- LOOM 该借：使命板上同时看见「谁在哪台机器、哪一个 CLI、进行到哪」。不要把 LOOM 的泳道换成另一套看板组件。借的是信息：并行的卡片上有状态，点进去是这次执行的输出。
- 本地参考：要克隆。读 `packages/` 和 `crates/` 里看板和任务状态怎么摆，不把它的样式搬进 Rovai。

#### Conductor 这个名字下的三件东西

- <https://www.conductor.build/> 是闭源的 macOS 应用：并行跑 Claude Code、Codex、Cursor，各自一个工作区，人看进度再合并。只当产品参照，没有仓库。
- <https://github.com/microsoft/conductor>，MIT，`v0.1.44`。命令行加文档化的仪表盘，用 YAML 描述多助手流程，并行组、子流程、条件分支。助手是 GitHub Copilot SDK 和 Anthropic Agents SDK，不是 LOOM 的 Runtime。
- `ryanmac/code-conductor`（MIT）用 GitHub Issue 当队列，助手来领。LOOM 已经有 `loom.claim.acquire`，不必再引入 Issue。
- Netflix 的 Conductor 是另一类工作流引擎，和这件事无关。
- LOOM 该借：微软这份的「一组并行步骤，每步状态单独可见」。闭源 Conductor 的「一眼看出每个助手在改什么」用现有执行卡片和变更列表来做。
- 本地参考：克隆 `microsoft/conductor`，读 `src/` 和 `docs/`。不克隆另外两个。

#### Crystal

- <https://github.com/stravu/crystal>，MIT，`v0.3.5`。2026-02 起仓库声明由 Nimbalyst 接替，不再更新。
- 桌面里开多个 Claude Code / Codex 会话，每个会话一个 git worktree。
- LOOM 该借：会话和目录一一对应，这个概念 Rovai 的使命工作区已经有了。停更的界面不作为视觉参照。
- 本地参考：不克隆。

### 1.5 调查之后定下来的取舍

| 决定 | 原因 |
|---|---|
| 节点出站 WebSocket 到 A | 与 GitHub runner、Gitea runner、Buildkite、Woodpecker、Coder 的拨号方向一致。B 无需公网地址 |
| 一条连接上承载心跳、派发、进程字节、文件和内置命令回连 | 与 Coder「不要为文件再开一个端口」一致 |
| 输出帧带序号 | 直接来自 Buildkite 的 log streamer |
| 一次 Run 整个落在一台节点 | 与 Nomad 的一次分配、也与「工作区目录是本机路径」一致 |
| 不用 frp / rathole / chisel 当执行通道 | 它们转发的是端口，不是 Run |
| 不用 `claude remote-control` 或 `codex remote-control` | 控制面会长到厂商云上，A 排不了这块活 |
| B1 用一次就退出的 CLI，不用 Codex app-server | app-server 是长期 stdio 会话，断线恢复是后面的里程碑 |
| 界面长在现有 `LoomWorkspace`、执行过程和文件预览上 | 桌面和 `rovai-server` 的网页本来就是同一套渲染层（`architecture-round4` §1） |

## 2. 方案 B 的结构

### 2.1 两台机器上各有什么

```text
机器 A（有公网地址，或至少 B 拨得到）
  rovai-server
    Core + SQLite          使命、计划、认领、队员、目录、节点表
    网页                   和桌面同一套界面
    节点接入               新的 WebSocket，不是管理员 API
    本机节点               进程内，直接 ManagedProcess::spawn

机器 B（可以没有公网地址）
  loom-node                只出站
    节点凭据               本机文件，权限 0600
    工作区目录             真正的项目文件
    Claude / Codex / …     本机子进程
    给助手用的 rovai 垫片  把内置命令经同一条 WebSocket 送回 A
```

B 上没有 Core，没有产品数据库。A 重启后，节点重连，A 从库里知道「这个 Run 派给了谁」。

桌面应用继续可以当纯界面连 A（方案 A 的「打开远端主机」）。桌面所在的电脑如果就是 B，它同时跑 `loom-node`。界面和执行是两件可以分开放的事。

### 2.2 节点代理

新进程，建议命令名 `loom-node`。它不做编排。

连接：

- B1 用一条 WebSocket。帧是 JSON，字节内容用 base64 或单独的二进制帧，避免把大文件塞进一行日志。
- A 侧路径建议 `GET /api/v1/nodes/connect`，挂在 `rovai-server` 上。不要把节点消息塞进现有的 `/api/v1/request`。那条路是给人用的操作白名单（`architecture-round4` §1）。
- 以后若要换成 gRPC，只换帧的编码。谁拨谁不变。Woodpecker 和 Temporal 说明 gRPC 长轮询也成立；B1 用 WebSocket 是因为服务器已经是 HTTP。

配对：

1. 人在 A 的设置里点「添加节点」。A 给出 10 分钟有效的配对码，以及 B 要拨的 `wss://` 地址。
2. B 上执行配对。A 生成 `node_id` 和节点令牌。库里只存令牌摘要。
3. B 把 `node_id` 和令牌写进自己的数据目录。
4. 之后每次连接都带这份令牌。配对码用过即废。

摘要的做法对齐现有管理员令牌：`crates/rovai-web/src/auth.rs` 的 `new_token`（206–209 行）生成 32 字节、64 位十六进制；同文件的 `digest` 把种类和令牌一起哈希。节点令牌要用不同的种类前缀，并且不能通过管理员登录接口。

心跳：

- 节点每 10 秒送一次。连续 3 次没有，A 把节点标成离线。
- 离线节点不接新 Run。
- 心跳里可以带「正在跑的 run id 列表」，方便 A 重启后对账。

能力：

- 节点上报操作系统、架构，以及每个已发现 CLI 的种类、可执行文件路径、版本、路径是否还在。
- 种类用现有的 `adapter_kind` 字符串（`codex-cli`、`claude-code-cli` 等）。
- 路径是 B 上的路径。A 把它当不透明字符串存下来，绝不在 A 上打开。

重连：

- 指数退避，带上限。身份不变，连接代次可以变。
- 重连后第一帧带上：节点 id、每个未结束 Run 的进程是否还在、已确认的输出序号。

### 2.3 单例执行主机改成多节点

今天一份库只有一台执行主机。建表时写死一行：

```44:48:crates/rovai-core/src/mission_schema.sql
CREATE TABLE mission_execution_host (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    id TEXT NOT NULL UNIQUE
);
INSERT INTO mission_execution_host VALUES(1,lower(hex(randomblob(16))));
```

工作区行上已经有 `execution_host_id`（`mission_schema.sql` 54 行，以及 `mission_workspace.rs` 里 `MissionWorkspace.execution_host_id`）。缺的不是「工作区不知道自己属于哪台机器」，而是「全库只承认这一台机器」。

生产代码读这行单例的地方：

| 位置 | 在做什么 |
|---|---|
| `Core::prepare_mission_execution_workspace`，`application/mission.rs` 216–242 行 | 准备使命工作区前读出唯一的 host id，写进工作区 |
| `Core::perform_mission_workspace_cleanup_locked`，同文件 589–612 行 | 清理前比对。对不上就 `mission.execution_host_unavailable` |
| `Core::handle_mission`，同文件 907 行起，979–988 行 | 调度清理时做同样的比对，拒绝码相同 |
| `mission_workspace::cleanup_projection`，`mission_workspace.rs` 1789–1796 行 | 只有工作区的 host 等于当前这台，清理才标成可用 |

`db_mission_context.rs` 164–166 行把 `singleton INTEGER PRIMARY KEY CHECK(singleton=1)` 当成这份表的形状来认库。测试里还有多处 `SELECT id FROM mission_execution_host WHERE singleton=1`（`mission.rs`、`delivery_queue.rs`、`collaboration.rs`、`camp_deletion.rs`、`application.rs`、`db.rs`、`db_mission_details.rs`）。改表时这些测试要跟着改，它们不是第二套产品逻辑。

改法：

- 已发出的 `mission_schema.sql` 不要重写。新加迁移。
- 新表 `execution_node`：`node_id`、显示名、角色（`local` 或 `remote`）、令牌摘要、最后心跳、在线状态、能力 JSON、创建时间。
- 迁移时把原来那一行 host id 收成第一台节点，角色为 `local`。已有工作区的 `execution_host_id` 继续指向它，旧库不用改路径。
- `mission_execution_host` 可以留成只读视图，或在迁移里删除并由代码改为读 `execution_node`。删除前先把上面四个生产读点改掉。
- 清理规则变成：工作区的 `execution_host_id` 必须等于将要动手的那台节点，而且该节点在线。A 不能删除只存在于 B 磁盘上的 worktree。清理命令发给那台节点执行。

### 2.4 运行时探测改成按节点

安装记录没有机器这一列。`Database::migrate_managed_product_runtime_v31`（`db.rs` 10776 行起）建的 `adapter_installation` 以种类、路径、`auth_scope` 为唯一性（10826–10835 行），探测尝试挂在 `installation_id` 上。全库一份。

探测在 A 的进程里跑：

- `Core::run_runtime_discovery` 调 `discover_runtime_installations`（`application.rs` 3474–3478 行）。
- `discover_runtime_path`（`runtime_discovery.rs` 982 行）在本机 `PATH` 和已知位置里找可执行文件。
- `spawn_managed_probe`（`runtime_probe_process.rs` 362–378 行）用 `ManagedProcess::spawn` 在本机跑探测。
- `AgentProfileService::list_installations`（`agent_profile.rs` 1426 行）把这些行列给界面。

改法：

- 本机节点继续走这套探测，写入时带上 `node_id = local`。不要改写 v31 那段历史迁移；加新列和新的唯一索引，索引里包含 `node_id`。
- 远端节点不由 A 探测。节点把同一形状的结果报上来，A  upsert 到带 `node_id` 的行。节点离线时保留最后一次上报，状态标成「上次见到」，不要改成 `path_missing`。`path_missing` 只表示节点自己说路径没了。
- 排程只读「这台节点、这种 `adapter_kind`、启用、路径有效」。

### 2.5 一次 Run 怎么落到节点

今天所有 Runtime 都是 Core 的子进程。入口在 `ManagedProcess::spawn`：

```591:604:crates/rovai-core/src/managed_process.rs
impl ManagedProcess {
    pub fn spawn(spec: ManagedProcessLaunchSpec) -> Result<Self> {
        Self::spawn_owned(spec).map_err(|failure| failure.error)
    }

    pub(crate) fn spawn_owned(
        spec: ManagedProcessLaunchSpec,
    ) -> std::result::Result<Self, ManagedProcessSpawnFailure> {
        #[cfg(unix)]
        {
            let owns_descendants = spec.purpose != ManagedProcessPurpose::RuntimeConnection;
            let mut command = command_from_spec(&spec);
            command.as_std_mut().process_group(0);
            let child = command.spawn().with_context(|| {
```

`command_from_spec`（994–1008 行）在本机 `Command::new`，清空环境后只放规格里的变量，标准输入按策略接管道，标准输出和标准错误都是管道。

Claude 的一次打印模式在 `ClaudeCodeCliRuntimeAdapter::run`（`claude.rs` 373 行）进入 `run_process`（555 行），组好命令后在本机 spawn：

```807:815:crates/rovai-core/src/claude.rs
let launch_result: Result<ManagedProcess> = (|| {
    let spec = ManagedProcessLaunchSpec::capture(
        &command,
        ManagedProcessPurpose::RuntimeOneShot,
        ManagedStdinPolicy::Piped,
        ManagedWindowsArgvDialect::MicrosoftCrt,
        format!("agent-run:{}:claude-code-cli", request.agent_run_id),
    )?;
    ManagedProcess::spawn(spec)
```

Codex 的长期主机在 `CodexHost::spawn_uninitialized`（`codex.rs` 370 行）里调 `spawn_in_environment`（392 行）。命令行是 `app-server --listen stdio://`，然后本机 spawn，并立刻拿走三条管道：

```437:447:crates/rovai-core/src/codex.rs
let mut child = ManagedProcess::spawn(spec)
    .with_context(|| format!("failed to start {} app-server", codex_path.display()))?;
let stdin = child
    .take_stdin()
    .context("Codex app-server stdin was unavailable")?;
let stdout = child
    .take_stdout()
    .context("Codex app-server stdout was unavailable")?;
let stderr = child
    .take_stderr()
    .context("Codex app-server stderr was unavailable")?;
```

标准输出的读取在 `spawn_stdout_reader`（500 行）。这条读取逻辑可以留在 A，只要喂给它的是一条「看起来像管道」的字节流。

其他本机 spawn，同一抽象以后都要接上，B1 不必全部改完：`acp.rs` 里 ACP 终端、`pi/host.rs` 里 Pi RPC、`antigravity.rs`、`zcode/transport.rs`。

排程规则，按这个顺序：

1. 这次 Run 属于哪个队员。队员已经有 `adapter_kind`。
2. 使命工作区若已有 `execution_host_id`，就用那台节点。文件在那台机器上，不能临时换机器。
3. 还没有工作区：在线、上报了这种 CLI、并且人允许它接这个项目的节点里选一台。B1 只有一台远端，不用策略。
4. 选中后把工作区的 `execution_host_id` 写成这台节点的 id。
5. A 仍在本机把命令行组出来（环境、MCP 文件参数、权限模式，沿用 `run_process` / `spawn_in_environment` 里已有的组法）。然后：
   - 目标是本机节点：照旧 `ManagedProcess::spawn`。
   - 目标是远端：把 `ManagedProcessLaunchSpec` 里的程序、参数、工作目录、环境送出去。路径必须是节点上的路径。A 不检查这些路径在不在自己的磁盘上。
6. 节点按同样的约束启动：新进程组、管道标准输入输出、可杀掉整棵进程树。B1 可以先做一个小的启动器，只要退出码和两路输出是对的。和 `ManagedProcess` 对齐的进程树所有权放到紧接着的里程碑，不要在 B1 里移植整份 `managed_process.rs`。

幂等：派发键是 `agent_run_id` 加尝试代次。节点上已经有同键进程时，再收到一次启动请求，返回「已经在跑」和当前输出序号，不要再起一个进程。

LOOM 的认领继续在 A 上。`loom::claim_acquire`（`loom.rs` 1195 行）在一个事务里检查任务、依赖和上一份租约。租约还在时拒绝：

```1320:1336:crates/rovai-core/src/loom.rs
            return Err(LoomCommandError::rejection(
                LOOM_CLAIM_HELD,
                format!(
                    "task {task_id} is held by claim {held_claim_id} until {held_lease_expires_at}"
                ),
            ));
        }
        transaction.execute(
            "UPDATE loom_claim SET released_at=?1 WHERE claim_id=?2 AND released_at IS NULL",
            params![&claimed_at, &held_claim_id],
        )?;
    }
    let claim_id = format!("claim_{}", uuid::Uuid::new_v4().simple());
    transaction.execute(
        "INSERT INTO loom_claim(claim_id,plan_id,task_id,agent_run_id,claimant_agent_id,
                              command_id,lease_expires_at,fence_generation,claimed_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9)",
```

节点不写 `loom_claim`。助手若在 B 上执行 `rovai loom claim`，那是经垫片回到 A 的一次普通 RPC（见 2.6）。`fence_generation` 仍然只增不减。

B1 不走认领。B1 只证明「A 让 B 起一个 CLI，输出回来了」。认领和节点绑在一起是后面的里程碑，避免第一刀就改 LOOM 状态机。

### 2.6 进程字节、文件、工作区，以及内置命令

进程：

- 节点把 stdout、stderr 打成帧：`run_id`、流、序号、字节。A 确认到哪一号。
- stdin 从 A 送到节点，同样带序号。一次就退出的 CLI（`claude -p`、`codex exec`）可以没有后续 stdin。
- 退出帧带退出码。A 把它写成这次 Run 的结束，和今天本机子进程结束是同一条产品路径。
- `spawn_stdout_reader` 那种解析留在 A。节点不解释 Codex 或 Claude 的 JSON。

文件：

- 一个工作区只有一个主人节点，就是 `execution_host_id`。
- 文件 API 只有：列出、读、写、看属性、在工作区根之内监视。全部经节点连接转发。
- 路径必须落在该工作区根里面。节点和工作区绑定都要检查。拒绝 `..` 和根以外的绝对路径。这是 B6 的验收，不是口号。
- A 上的 `FilePreviewPane` 继续负责显示。数据来源从「本机磁盘」变成「若工作区属于远端节点，就转发」。
- 两台节点不共享一个 POSIX 目录。助手要交换文件时，用 git：各节点上的 worktree，推到 A 上的一个 bare 仓库或项目已经有的远端。这和今天 `prepare_mission_execution_workspace` 使用 git worktree 的方向一致，只是 worktree 建在主人节点上，不建在 A 上。
- B1 不传文件。任务的工作目录是节点上已有的空目录或临时目录。

内置 `rovai` 命令：

今天助手在本机通过 Unix socket 调 Core。方案 A 的记录已经说明：Codex 在 Linux 沙箱里默认连不上这只 socket，要开 `network_access`。进程若在 B 上，socket 根本在 A 上，开沙箱也没用。

因此节点数据目录里放一个 `rovai` 垫片，出现在该次 Run 的 `PATH` 最前。垫片不连 socket。它把子命令经节点 WebSocket 交给 A 的同一套 RPC，再把标准输出带回来。权限是这一个 Run 的身份，不是 A 的管理员。

没有这个垫片，B 上的助手就做不了 `rovai loom plan` / `claim` / `candidate`。它不在 B1 里。B1 的假 CLI 或一次「把这句话原样打印」的任务不需要回调。垫片是 B4。

### 2.7 技能、MCP、规则、hook 怎么到节点

目录在 A。勾选结果也在 A。节点只在一次 Run 开始前收到一份运行包，写到该 Run 的私有目录，权限 0700。Run 结束就删。节点不保存第二份队员数据库。

规则，今天就是队员身份的六列，在引导词里交给模型。`load_latest_member_identity` 读取它们：

```3568:3573:crates/rovai-core/src/context.rs
            r#"
            SELECT display_name, team_role, professional_responsibilities,
                   personality_traits_json, working_principles, growth_topic
            FROM agent_profile
            WHERE id = ?1 AND profile_status <> 'removed'
            "#,
```

`render_session_bootstrap`（3602 行起）把它们放进 `[MEMBER_IDENTITY]`。`CONTEXT.md` 里的 Member Working Principles 写明：工作准则进的是之后合格的引导投递，不能改写已经送出的引导，也不能改正在跑的 Runtime。方案 B 遵守同一条。勾选变化从下一次 Run 的运行包生效。

技能：`managed_skills.rs` 25–31 行的 `TOOLBOX_SKILLS` 是内置五项。`prepare_additional_skills`（`context.rs` 7277 行起）按队员取出名字，写成 `[ROVAI_ADDITIONAL_SKILLS]`。运行包里带这段文本，以及这些技能的文件。节点不自己去 A 的数据目录读技能。

MCP：定义是全局的，队员勾选是 `McpConfigStore::set_members`（`mcp.rs` 580 行，参数 `SetMcpMembersParams` 278 行）和单条的 `SetMcpAssignmentParams`（314 行）。一次 Run 的投影由 `materialize_projection`（`mcp_projection.rs` 477 行）写到 `target_path`（464–474 行）那种按 `agent_run_id` 分开的私有目录。Claude 再用 `--mcp-config` 指到这份文件（`claude.rs` 785–793 行）。方案 B 把这份已经投影好的文件放进运行包，节点写到自己的私有目录，命令行里的路径改成节点上的路径。只放这个队员勾过的服务器。

hook：产品里没有可配置的 hook 表。代码里的 hook 是 SQLite 授权钩子、压缩信号和测试夹具，不是用户目录。新目录是后加的。投递方式与 MCP 相同：并进节点上那份 CLI 设置文件。在目录做成之前，运行包里的 hook 段为空。

云端目录的勾选，落地时写回已有的存储，而不是平行再存一套：

| 勾选 | 写入 |
|---|---|
| 工具箱技能 | 现有的队员工具箱关系 |
| MCP | 现有的 `set_members` / `SetMcpAssignmentParams` |
| 规则片段 | B7 先只运送现有六列。额外片段若要新的引导段落，走模型上下文变更治理，不在运送的同一刀里发明段落 |
| hook | 新表。空表表示没有 hook |

运行包是「A 上这次 Run 本来就要写进私有目录的那些文件」的拷贝。组包的代码留在 A，和今天 `run_process` 写临时文件是同一处。节点只落盘和启动。

### 2.8 安全

- 节点令牌不是管理员令牌。管理员令牌仍然是登录网页的那条（`server.rs` 20–26 行的监听地址、`auth.rs` 的 64 位十六进制）。拿管理员令牌去连节点套接字，必须拒绝。
- 非回环监听继续要求显式 `--allow-insecure-lan`。节点通道在公网上必须是 `wss`。明文 WebSocket 只允许回环，供同一台 VM 上的 B1 使用。
- 节点能做的事：心跳、上报能力、接受派给自己的 Run、为这些 Run 传输字节、为绑在自己身上的工作区做文件操作、替这些 Run 转发内置命令。节点不能做评审、不能读别的节点的运行包、不能列别的工作区。
- 内置命令垫片使用 Run 的身份。它到不了管理员操作。
- MCP 和密钥只出现在该 Run 的运行包里，目录 0700，Run 结束删除。日志里不回显令牌和定义原文。
- 能力上报是节点自述。A 不把上报的路径当本机文件去执行。
- 文件根校验在 A 和节点各做一次。
- 配对码短时有效。节点令牌可作废。作废后下一次心跳失败，在途进程由节点自己杀掉并上报，避免一个被偷走的令牌继续收新任务。
- 服务端继续不要用 root 跑。方案 A 已经记下 root 会让 SQLite 的 WAL ctime 变化，从而 `IdentityChanged`。这条与节点无关，仍然有效。

### 2.9 断线之后怎样

| 情况 | 行为 |
|---|---|
| 心跳丢失，没有在途 Run | 节点标离线。新 Run 不派给它 |
| 在途 Run，连接断了，进程还在 | 不另起进程，不换机器。等重连，从已确认序号之后继续送输出 |
| 在途 Run，连接断了，进程没了 | Run 记为中断。LOOM 租约到期后才能再认领（现有 `LOOM_CLAIM_HELD`）。不自动改派到另一台节点，因为文件不在那边 |
| A 重启 | 派发记录在库里，不在内存里。B2 就必须落库。节点重连后用 run id 对账 |
| 节点重连但 run id 对不上 | 以节点上的进程实况为准：还在就接上，不在就中断。不要为了「库里还写着在跑」再启动一次 |
| 同一 `agent_run_id` 的第二次启动请求 | 节点返回已有进程。A 不把它当成新的尝试 |

工作区主人节点离线时，文件树显示「这台机器不在线」，不显示空目录。空目录和「读不到」是两件事，编排页对认领已经是这个语义（`LoomWorkspace.tsx` 里 claims 为 `null` 表示没读到）。

## 3. 界面信息架构

视觉继续用现在的 Rovai / LOOM。新增的是信息，不是另一套皮肤。桌面和 `rovai-server` 的网页共用渲染层，所以这些入口两边一起出现。

### 3.1 项目文件夹和文件管理

位置：现有会话工作区，和文件预览分栏在一起。

- 左侧一棵树，根是当前使命的项目目录。数据来自工作区主人节点。
- 点文件：打开现有 `FilePreviewPane`（`apps/desktop/src/renderer/src/FilePreviewPane.tsx`）。预览合同继续有效。
- 变更列表继续用现在的执行变更，不另做第三种 diff。
- 节点离线：树上说明不在线，已打开的标签保留上次内容并标成旧的。

对照着看的屏幕：

- 本仓库文件预览分栏和 [`docs/ui/components/file-preview.md`](../ui/components/file-preview.md)。
- OpenHands 应用里会话旁边的文件树（参考克隆 `OpenHands/OpenHands`）。
- VS Code 资源管理器的信息结构：树、点开、脏文件。不引入 VS Code 的外观。
- Coder 文档里「界面在控制面、文件在工作区代理」那张路径图，用来核对数据从哪来，不用来改布局。

### 3.2 助手配置：四个勾选目录

一个队员一页，四个分组。分组都在 A 上。

| 分组 | 今天有什么 | 页上怎么勾 |
|---|---|---|
| 技能 | 工具箱五项，设置页已经是复选框 | 沿用工具箱那一页的行为：勾上即存，失败回滚。目录以后变长，控件不变 |
| MCP | `McpSettings.tsx` 里按队员指派 | 把「这个队员是否使用该服务器」收成目录上的复选框。高风险确认沿用 `acknowledge_high_risk` |
| 规则 | 身份编辑器里的专业职责、工作准则等六段文字（[`docs/ui/components/member-identity.md`](../ui/components/member-identity.md)） | 六段文字留在身份里。另加目录：每条是可复用的规则片段，勾上的才会进入下一次运行包。B7 之前界面可以先只显示六段文字已经会随运行包出发 |
| hook | 没有 | 新分组。没有条目时明确写「还没有可勾选的 hook」，不要显示永远空着的开关 |

对照着看的屏幕：

- 工具箱设置：[`docs/ui/components/skills-settings.md`](../ui/components/skills-settings.md)「工具箱：逐队员配置」。
- MCP 设置页 `McpSettings.tsx` 的队员勾选。
- 队员身份编辑器里的六段文字。

### 3.3 节点列表

放在设置里，挨着方案 A 已经做的「远端主机」。

两个入口含义不同，都留着：

- 远端主机：打开另一台机器上的整套 LOOM 网页（方案 A，那台机器自己有 Core）。
- 节点：这一份 Core 手下的执行机器。没有自己的库。

每一行：名字、在线或离线、最后心跳、操作系统、上报的 CLI、正在跑的 Run 数量。离线行保留上次能力，并写明时间。添加节点显示配对码和要在 B 上执行的那一行命令。作废令牌在同一行。

对照着看的屏幕：

- GitHub 仓库或组织设置里的 Actions → Runners：在线、离线、标签。
- Buildkite 的 Agents 列表：心跳和当前任务。
- Coder 工作区页面上代理是否连上。只借状态怎么摆。

### 3.4 现场进度

编排仍是 `LoomWorkspace` 的泳道。卡片上增加三样已经能从控制面读到的事实：节点名、CLI 种类、这次 Run 是在排队、在跑、已结束还是中断。点卡片打开现有「执行过程」，输出是节点送回的那条流。

不要做第二张图。认领、fence、阻塞原因已经在卡片上，节点是同一张卡片的另一行。

对照着看的屏幕：

- 本仓库编排泳道：`LoomWorkspace.tsx` 里 `loom-flow-lane`，眉题「LOOM · 编排」。
- 同页执行过程：`ThreadWorkspace.tsx` 的「执行过程」。
- GitHub Actions 任务日志：跟着序号往下长，断了能接上。
- OpenHands 的事件流：工具和输出按时间排。
- Vibe Kanban 的并行任务卡：一屏看见多路，点进去才是细节。
- `microsoft/conductor` 文档里的并行组：每一步单独有状态。
- conductor.build 只有公开营销页，没有源码。看「一眼能分清每个助手」即可。

## 4. 里程碑

每一步都能在一台 Linux VM 上单独验。A 和 B 是两个进程、两个数据目录。需要更硬的隔离时，换成两个系统用户或两个容器，验收观察点不变。

假 CLI 是为了不依赖模型账号。真 CLI 是同一条派发路径上的手工冒烟，没有密钥时不挡步骤通过。

下面命令里的子命令名是验收界面。实现时名字可以改，观察点不能改。

### B1 节点拨入，A 在 B 上跑一次 CLI，输出回来

这是最薄的一条。没有文件同步，没有技能，没有编排，没有第二台节点，没有落库的重连。A 的派发可以先放在内存里。

准备：

```bash
mkdir -p /tmp/loom-b1/a /tmp/loom-b1/b /tmp/loom-b1/bin /tmp/loom-b1/work
cat > /tmp/loom-b1/bin/codex << 'EOF'
#!/bin/sh
printf 'LOOM_B1_OK\n'
exit 0
EOF
chmod +x /tmp/loom-b1/bin/codex
```

A 只听回环。B 不听任何端口。

```bash
rovai-server --data-dir /tmp/loom-b1/a --listen 127.0.0.1:8767
# 另一个终端，向这份数据目录要一个短时配对码
rovai-server node-pair --data-dir /tmp/loom-b1/a

PATH=/tmp/loom-b1/bin:$PATH \
  loom-node --data-dir /tmp/loom-b1/b \
  --server ws://127.0.0.1:8767/api/v1/nodes/connect \
  --pair-code "$CODE"
```

派发（工作目录在 B 上）：

```bash
rovai-server node-exec --data-dir /tmp/loom-b1/a \
  --runtime codex-cli \
  --cwd /tmp/loom-b1/work \
  -- exec --skip-git-repo-check 'ignored by the fake cli'
```

通过标准：

- 标准输出里有 `LOOM_B1_OK`，退出码 0。
- `ss -ltnp` 里找不到 `loom-node` 的监听套接字。只有 A 在听 `127.0.0.1:8767`。
- 用管理员令牌去连节点 WebSocket，连接被拒绝。
- B 的数据目录里没有 SQLite 产品库。
- 把假 `codex` 换成真的 `codex exec` 或 `claude -p`，同一条派发命令能跑完并带回输出。这一条是手工冒烟：没有登录态就记下来，不把 B1 判失败。

两个用户时：`loom-a` 拥有 `/tmp/loom-b1/a`（0700），`loom-b` 拥有 `/tmp/loom-b1/b`，`loom-b` 读不了 A 的数据目录。这一条比两个进程更硬，自动化验收没有另建系统用户。

#### 实施状态（2026-11-01）

B1 已落地。A 仍是 `rovai-server`（一个 Core、一份 SQLite，默认只听回环）。节点通道是旁边的 `GET /api/v1/nodes/connect`，不进入 `/api/v1/request`。B 是新进程 `loom-node`，只出站。

和上面正文的差别，是为了让这一刀保持最薄：

- 配对码和节点令牌的摘要、以及这一次派发，记在 A 的进程内存里，不写新表。明文节点令牌只在配对成功时经套接字交回一次，A 不保存。重启后的对账是 B2。
- `node-pair` 和 `node-exec` 是另一次进程。它们读数据目录里的管理员令牌，向正在跑的服务登录后要配对码、下发一次 Run。服务把实际监听地址写在 `loom-node-listener.json`，退出时删掉。
- 节点启动器继承自己的环境，再盖上 A 发来的环境变量。B1 发的是空列表，这样同一条命令上的真 `codex exec` / `claude -p` 还能看见本机的 HOME 和登录态。完整的 `ManagedProcess` 清环境和进程树所有权留到下一刀。
- B1 只发现 `codex`（`codex-cli`）和 `claude`（`claude-code-cli`）。其余种类是 B3。
- 进程字节用 JSON 文本帧，字节是 base64。序号从 1 起，stdout 和 stderr 共用，A 确认到该序号。

自动化验收（两个进程、两个数据目录、假 `codex` 打出 `LOOM_B1_OK` 并以 0 退出；同时断言 A 看到这一行和退出码 0、`loom-node` 没有监听套接字、管理员令牌连不上节点套接字、节点令牌不能当管理员登录、B 的数据目录没有 SQLite）：

```bash
cargo test -p loom-node --test b1_outbound
cargo test -p rovai-web --lib nodes::
cargo test -p loom-node --lib
cargo test -p rovai-core --lib loom
```

2026-11-01 在非 root 的 Linux 上复跑：`b1_outbound` 通过；`nodes::` 1 通过；`loom-node --lib` 1 通过；`cargo test -p rovai-core --lib loom` 85 通过。同一棵树上 `cargo fmt --all -- --check`、`cargo check -p rovai-core --all-targets`、`cargo check -p loom-protocol --all-targets`、`cargo check -p loom-node --all-targets`、`cargo check -p rovai-web --all-targets`、`cargo check -p rovai-host --all-targets`、`pnpm typecheck`、`pnpm docs:check` 也通过。没有出现只在 root 下失败的 `database_admission` 用例，因为这些命令不是以 root 跑的。

手工冒烟用真 CLI。没有登录态就记下来，不把 B1 判失败。先按本节开头的准备把 A、B 和假 `codex` 跑通，再把 B 的 `PATH` 换成真的 `codex` / `claude` 所在目录，重新配对后执行：

```bash
rovai-server node-exec --data-dir /tmp/loom-b1/a \
  --runtime codex-cli \
  --cwd /tmp/loom-b1/work \
  -- exec --skip-git-repo-check 'say hello in one line'

rovai-server node-exec --data-dir /tmp/loom-b1/a \
  --runtime claude-code-cli \
  --cwd /tmp/loom-b1/work \
  -- -p 'say hello in one line'
```

`node-exec` 的标准输出就是 CLI 的标准输出，进程退出码就是 CLI 的退出码。

### B2 心跳、掉线、重连、不双开

- 停掉节点进程，A 在大约 30 秒内把它标成离线。
- 派发一个会睡几秒的脚本，杀掉节点再拉起。进程若还在，输出从上次确认的序号之后继续，不重复已经确认的前缀，也不出现第二个进程。
- 进程若已经死了，A 把这次 Run 标成中断，再派一次使用新的尝试代次，而不是悄悄再起一个同 id 的进程。
- 派发记录写在 A 的库里。重启 `rovai-server` 后仍能对上这个 run id。

```bash
# 节点 pid 不应持有 LISTEN
pid=$(pgrep -f 'loom-node --data-dir /tmp/loom-b1/b')
if ss -ltnp | grep -q "pid=${pid},"; then echo 'node is listening'; exit 1; fi
```

### B3 能力上报，没有的 CLI 不派

- 节点上报 `codex-cli` 或明确不上报。
- A 上对该节点派 `claude-code-cli` 时，在启动前拒绝，B 上不出现进程。
- 界面或 CLI 能读到「上次上报」的种类列表。节点离线后列表还在，并带时间。

### B4 内置 rovai 从 B 回到 A

- 节点为这次 Run 准备的 `PATH` 里，`rovai` 是垫片。
- 在 B 的这次 Run 里执行 `rovai loom status`（或一个只读的现有 RPC），读写的是 A 的库。
- 垫片呈上管理员令牌时被拒绝。
- 真 Codex 若仍因沙箱连不上网络，沿用方案 A 的配置：节点用户的 `~/.codex/config.toml` 里 `[sandbox_workspace_write] network_access = true`。垫片走的是连向 A 的出站，不是 Unix socket。

### B5 本机节点 + 一台远端，一次使命两段活

- A 的本机执行登记为 `local` 节点，走 `ManagedProcess::spawn`，不经过 WebSocket。
- 两个任务：一个指定本机且本机有对应 CLI，一个指定 B。
- 两边的输出都回到 A，run id 不同。
- 把本机任务的 `execution_host_id` 改成 B 的 id 时，进程出现在 B 上，不出现在 A 上。

### B6 工作区主人与文件读

- 创建工作区时 `execution_host_id` 写成主人节点。worktree 建在那台机器上。
- 从 A 列出并读一个工作区里的文件，内容与 B 磁盘上的一致。
- `../` 和绝对路径跳出根目录时，A 和节点都拒绝。
- 主人离线时，列出操作返回「不在线」，不是空列表。
- 网页里的项目树能点开，预览走现有 `FilePreviewPane`。

### B7 运行包：身份、工具箱、MCP

- 改队员的工作准则，派一次 Run。B 上该 Run 私有目录里的引导文本含这段话。
- 给队员勾上一个工具箱技能。运行包里的 `[ROVAI_ADDITIONAL_SKILLS]` 含这项，技能文件在节点上可读。
- 给队员勾上一个 MCP。节点上的 `--mcp-config` 指向的文件含这个服务器，不含未勾选的服务器。
- 私有目录是 0700。Run 结束后目录没了。
- hook 段为空，并且测试锁住「空」。
- 这一步不新增引导段落。

### B8 hook 与规则片段目录

- A 上可以新增一条 hook 目录项，并勾给队员。
- 运行包里 CLI 设置文件含这条 hook。取消勾选后再跑，文件里没有。
- 规则片段同样：勾选后出现在下一次运行包，不改写已经在跑的进程。
- 若片段必须变成新的引导段落，先完成模型上下文变更治理里要求的说明和确认，再改 `render_session_bootstrap`。

### B9 节点列表和编排上的现场

- 设置里能看见节点、心跳和 CLI。
- 编排卡片上有节点名、CLI、运行状态。
- 点开是现有执行过程，输出随帧增长。
- 用现有的界面测试入口覆盖：节点离线、没有计划、认领读失败（`claims === null`）这三态不被新行弄丢。

```bash
pnpm test:loom-workspace
```

这一步只在夹具和网页能表达节点字段之后跑。Rust 侧的节点行为仍用 B1–B8 的进程级命令验。

### B10 和认领租约对齐的失败表

用一张脚本把 2.9 的表跑完：断线但进程还在、断线且进程已死、A 重启、重复启动、离线节点不接新活、工作区不自动迁到另一台节点。

```bash
# 期望：租约未过期时第二次认领被拒绝，错误码 LOOM_CLAIM_HELD
# 期望：执行节点离线时不会出现第二台机器上的新进程
```

B10 通过之后，方案 B 的执行路径才算能接到现有 LOOM 认领上。在那之前，不要把远端节点写成默认执行位置。

## 5. 风险，以及方案 A 留下什么

### 5.1 风险

- 单例主机和 `adapter_installation` 埋得深。生产读点不多，测试读点多。必须用新迁移，不能改已经应用过的 `mission_schema.sql` 和 v31 迁移正文。
- 内置 `rovai` 今天依赖本机 socket。不做 B4 的话，B 上的真助手无法参加 LOOM 认领和交付。B1 的通过不能被说成「使命已经能在 B 上跑完」。
- Codex app-server 是长期协议。B1 用 `codex exec` / `claude -p`。把 app-server 的三条管道搬到 WebSocket 上时，序号和「不要双开」必须已经在 B2 落地。
- 文件 API 写错就是任意文件读写。根目录校验要有否定测试。
- 运行包里有 MCP 密钥。日志、崩溃转储和节点数据目录的权限要按 2.8 检查。
- 两台机器同时改一个目录会对不上。主人节点只有一个；跨机器用 git，不用共享盘幻想。
- A 的 SQLite 仍是单写。节点变多不增加数据库，但增加 A 上的连接和字节。B1 不承诺规模。
- 参考仓库里 Coder、Teleport、Claude Squad 是 AGPL，Nomad 是 BUSL。阅读可以，抄进本仓库不行。
- 公开的 Claude Code 仓库不是实现。不要基于那份树做补丁。
- 方案 A 的 Codex 沙箱坑还在，而且垫片改为出站之后，沙箱必须允许这条约到 A 的连接。

### 5.2 方案 A 继续有效的部分

- A 上的 `rovai-server`：非 root、数据目录 0700、默认只听 `127.0.0.1:8767`、公网入口用隧道、`--public-origin` 与隧道地址一致。见 `handoff-remote-2026-11-01.md`。
- 管理员令牌登录，以及网页操作白名单。节点通道是旁边的新入口，不把白名单放大。
- 桌面「远端主机」和「在远端主机打开」。那是打开另一份 Core。方案 B 的节点列表不替换它。
- `scripts/provision-remote-runtimes.sh` 改为在节点机器上、以节点用户运行。Core 仍然不代装 CLI。
- 两台库之间的 profile 同步脚本只用于把方案 A 已经分叉的两份配置收成 A 上的一份。方案 B 之后目录只住在 A，运行包是单向的。
- cloudflared 或 Tailscale 继续只解决浏览器如何到达 A。节点是否走 tailnet，是 B 拨 A 时的地址选择，不是第二套执行协议。
- LOOM 的计划、任务、依赖、认领、候选、评审、核验、产物，仍只在 A 的库里。`LoomWorkspace` 的三个视图仍是现场进度的位置。
- 不把服务端以 root 运行。不裸开公网 HTTP。

方案 A 的 M2 实机验收、Tailscale 授权和 Windows 安装包，仍按 `handoff-remote-2026-11-01.md` 办。它们不阻塞 B1 在一台 Linux VM 上用两个进程先走通。
