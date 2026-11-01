/* Sample-only clickable prototype for the LOOM plan B UI review.
   Nothing here is production data, a credential, or a real node. */

const SAMPLE = {
  mission: "节点通道",
  number: "M-014",
  project: "样例 · 织布对照",
  root: "loom-plan-b",
  now: "10:18",
  pairCode: "4F7K-Q2M9",
  server: "wss://loom.example/api/v1/nodes/connect",
  command:
    "loom-node --data-dir ~/.loom-node \\\n  --server wss://loom.example/api/v1/nodes/connect \\\n  --pair-code 4F7K-Q2M9",
};

const NODES = [
  {
    id: "loom-a",
    name: "loom-a",
    role: "本机",
    kind: "local",
    os: "Linux",
    arch: "x64",
    heartbeat: "2 秒前",
    online: true,
    runs: ["拆节点协议"],
    clis: [
      { kind: "claude-code-cli", version: "2.1.316", path: "/home/loom/.npm-global/bin/claude", state: "路径有效" },
      { kind: "codex-cli", version: "0.166.0", path: "/home/loom/.npm-global/bin/codex", state: "路径有效" },
    ],
  },
  {
    id: "desk-b",
    name: "desk-b",
    role: "家里的电脑",
    kind: "remote",
    os: "macOS",
    arch: "arm64",
    heartbeat: "4 秒前",
    online: true,
    runs: ["在 B 上跑通心跳"],
    clis: [
      { kind: "codex-cli", version: "0.166.0", path: "/Users/loom/.npm-global/bin/codex", state: "路径有效" },
      { kind: "claude-code-cli", version: "2.1.316", path: "/Users/loom/.npm-global/bin/claude", state: "路径有效" },
    ],
  },
  {
    id: "win-studio",
    name: "win-studio",
    role: "工作室",
    kind: "remote",
    os: "Windows",
    arch: "x64",
    heartbeat: "昨天 18:40",
    online: false,
    runs: [],
    clis: [
      { kind: "codex-cli", version: "0.166.0", path: "C:\\Users\\loom\\.npm-global\\bin\\codex.cmd", state: "上次见到" },
    ],
  },
];

const AGENTS = [
  { id: "zhi", name: "织", role: "主助手", identity: "var(--identity-1)", runtime: "claude-code-cli", node: "loom-a" },
  { id: "suo", name: "梭", role: "实现", identity: "var(--identity-2)", runtime: "codex-cli", node: "desk-b" },
  { id: "yan", name: "验", role: "评审", identity: "var(--identity-5)", runtime: "claude-code-cli", node: "loom-a" },
];

const CATALOG = [
  { id: "campfire", group: "skill", name: "campfire", note: "多人讨论，对照方案", source: "工具箱", checked: true },
  { id: "grill-duo", group: "skill", name: "grill-duo", note: "两人质询一份计划", source: "工具箱", checked: false },
  { id: "grill-docs", group: "skill", name: "grill-duo-with-docs", note: "质询并维护已确认的文档", source: "工具箱", checked: false },
  { id: "member-studio", group: "skill", name: "member-studio", note: "创建队员", source: "工具箱", checked: true },
  { id: "review-duo", group: "skill", name: "review-duo", note: "两名队员独立看一份改动", source: "工具箱", checked: false },
  { id: "mcp-git", group: "mcp", name: "git", note: "样例服务器 · 只读 git", source: "全局定义", checked: true },
  { id: "mcp-fs", group: "mcp", name: "filesystem", note: "样例服务器 · 占用 read_file", source: "全局定义", checked: true, conflict: "read_file" },
  { id: "mcp-browser", group: "mcp", name: "browser", note: "样例服务器 · 高风险，勾选前要确认", source: "全局定义", checked: false, risk: true },
  { id: "rule-ro", group: "rule", name: "只读工作区", note: "样例片段 · 也要占用 read_file", source: "规则目录", checked: true, conflict: "read_file" },
  { id: "rule-commit", group: "rule", name: "提交前说明", note: "样例片段 · 下次运行包才生效", source: "规则目录", checked: false },
  { id: "hook-fmt", group: "hook", name: "format-on-stop", note: "样例 hook · 写进该次 CLI 设置", source: "hook 目录", checked: true },
  { id: "hook-net", group: "hook", name: "deny-network", note: "样例 hook · 未勾选", source: "hook 目录", checked: false },
];

const FILES = {
  "README.md": {
    git: "M",
    body: "# 样例项目\n\n这是静态原型里的文件，不是仓库里的真文档。\n工作区主人是 desk-b。A 上看到的内容是从那台节点读来的。\n",
  },
  "src/node/connect.ts": {
    git: "M",
    body: "// 样例文件。不是生产代码。\nexport const connectPath = \"/api/v1/nodes/connect\"\n\nexport function dial(server: string): void {\n  // 节点出站。A 不回拨。\n  void server\n}\n",
  },
  "src/node/heartbeat.ts": {
    git: "A",
    body: "// 样例文件。不是生产代码。\nexport function noteHeartbeat(input: { nodeId: string; seq: number }): void {\n  // 每 10 秒一次。连续 3 次没有，控制面标离线。\n  void input\n}\n",
  },
  "docs/loom/plan-b.md": {
    git: "",
    body: "# 样例说明\n\n同一份目录不会同时住在两台机器上。\n要交换文件，用 git，不用共享盘。\n",
  },
};

const TASKS = [
  {
    id: "spec",
    depth: 0,
    title: "拆节点协议",
    agent: "zhi",
    runtime: "claude-code-cli",
    node: "loom-a",
    status: "done",
    workspace: "/var/lib/loom-server/work/protocol",
    why: "这段活只改 A 上的规格，文件主人从一开始就是本机。本机上报了 claude-code-cli，而且人允许它接这个项目。",
    claim: "已释放 · 织 · fence 2",
    start: 4,
    end: 38,
  },
  {
    id: "impl",
    depth: 1,
    title: "在 B 上跑通心跳",
    agent: "suo",
    runtime: "codex-cli",
    node: "desk-b",
    status: "running",
    workspace: "/Users/loom/work/loom-plan-b",
    why: "工作区已经钉在 desk-b。文件在那台机器上，不能改派到 loom-a：两台节点不共享一个目录。desk-b 在线，并且上报了 codex-cli。",
    claim: "认领中 · 梭 · 租约 10:24 · fence 3",
    start: 38,
    end: 92,
  },
  {
    id: "review",
    depth: 2,
    title: "对照输出序号",
    agent: "yan",
    runtime: "claude-code-cli",
    node: "loom-a",
    status: "blocked",
    workspace: "A 上的 Run 回放，不打开 B 的目录",
    why: "验收读的是已经回到 A 的输出，不需要 B 的工作区。它等「在 B 上跑通心跳」的产物被人工验收后才放行。",
    claim: "还没有认领",
    start: 0,
    end: 0,
  },
];

const LOG = [
  ["141", "stdout", "样例回放 · 已载入运行包 · 工具箱 1 · MCP 1 · hook 0"],
  ["142", "stdout", "探查 src/node/connect.ts"],
  ["146", "stdout", "写入 src/node/heartbeat.ts"],
  ["148", "stdout", "心跳已上报 · 等待确认序号"],
];

const params = new URLSearchParams(location.search);
const ui = {
  screen: params.get("screen") || "nodes",
  state: params.get("state") || "ready",
  theme: params.get("theme") === "night" ? "night" : "day",
  shot: params.get("shot") === "1",
  agent: params.get("agent") || "zhi",
  task: params.get("task") || "impl",
  file: params.get("file") || "src/node/heartbeat.ts",
  query: "",
  edit: false,
  accepted: false,
  toast: "",
  openNodes: { "desk-b": true },
  openDirs: { src: true, "src/node": true },
  checks: null,
  riskFor: null,
  extraLog: [],
};

if (ui.screen === "catalog" && ui.state === "offline" && !params.get("agent")) ui.agent = "suo";
if ((ui.screen === "dispatch" || ui.screen === "live") && ui.state === "offline" && !params.get("task")) ui.task = "impl";

const root = document.getElementById("root");
const bar = document.getElementById("proto-bar");

function esc(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function writeUrl() {
  const next = new URLSearchParams();
  next.set("screen", ui.screen);
  next.set("state", ui.state);
  next.set("theme", ui.theme);
  if (ui.shot) next.set("shot", "1");
  if (ui.agent !== "zhi") next.set("agent", ui.agent);
  if (ui.task !== "impl") next.set("task", ui.task);
  if (ui.file !== "src/node/heartbeat.ts") next.set("file", ui.file);
  history.replaceState(null, "", `${location.pathname}?${next.toString()}`);
}

function bodyState() {
  if (ui.state === "pair" || ui.state === "revoke") return "ready";
  return ui.state;
}

function deskOffline() {
  return ui.state === "offline";
}

function nodeById(id) {
  const node = NODES.find((item) => item.id === id);
  const online = node.online && !(deskOffline() && id === "desk-b");
  return { ...node, online, clis: node.clis.map((cli) => ({ ...cli, state: online ? cli.state : "上次见到" })) };
}

function agentById(id) {
  return AGENTS.find((item) => item.id === id);
}

function tasks() {
  return TASKS.map((task) => {
    const copy = { ...task };
    if (ui.accepted && task.id === "review") {
      copy.status = "ready";
      copy.claim = "可以认领 · 上游产物已验收";
    }
    if (ui.accepted && task.id === "impl") copy.claim = "认领中 · 梭 · 产物已验收 · fence 3";
    return copy;
  });
}

function checks() {
  if (!ui.checks) ui.checks = Object.fromEntries(CATALOG.map((item) => [item.id, item.checked]));
  return ui.checks;
}

function catalogVisible() {
  const state = bodyState();
  if (state === "empty") {
    return CATALOG.filter((item) => item.group === "skill").map((item) => ({ ...item, checked: false }));
  }
  const q = ui.query.trim().toLowerCase();
  return CATALOG.filter((item) => {
    if (!q) return true;
    return `${item.name} ${item.note} ${item.source}`.toLowerCase().includes(q);
  }).map((item) => ({ ...item, checked: Boolean(checks()[item.id]) }));
}

function conflictIds(items) {
  const on = items.filter((item) => item.checked && item.conflict);
  const groups = new Map();
  for (const item of on) {
    const bucket = groups.get(item.conflict) ?? [];
    bucket.push(item.id);
    groups.set(item.conflict, bucket);
  }
  const ids = new Set();
  for (const bucket of groups.values()) if (bucket.length > 1) bucket.forEach((id) => ids.add(id));
  return ids;
}

function toast(text) {
  ui.toast = text;
  render();
  clearTimeout(toast._t);
  toast._t = setTimeout(() => {
    ui.toast = "";
    render();
  }, 2200);
}

function icon(name) {
  const common = 'width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
  const paths = {
    pen: '<path d="M8 3.5h4.5V8"/><path d="M3 13l1-3.5L11 2.5l2.5 2.5L6.5 12.5 3 13z"/>',
    users: '<path d="M6 7.2a2.2 2.2 0 1 0 0-4.4 2.2 2.2 0 0 0 0 4.4z"/><path d="M2.5 13.2c.4-2 1.8-3 3.5-3s3.1 1 3.5 3"/><path d="M10.2 4.2a1.8 1.8 0 0 1 0 3.2"/><path d="M11 10.2c1.3.2 2.3 1 2.6 3"/>',
    flag: '<path d="M3.5 13.5V2.8"/><path d="M3.5 3.2h8l-1.6 2.4 1.6 2.4h-8"/>',
    board: '<path d="M2.5 3.5h11v9h-11z"/><path d="M6 3.5v9M10 3.5v9"/>',
    gear: '<circle cx="8" cy="8" r="2"/><path d="M8 2.4v1.6M8 12v1.6M2.4 8h1.6M12 8h1.6M4 4l1.1 1.1M10.9 10.9 12 12M12 4l-1.1 1.1M5.1 10.9 4 12"/>',
    server: '<rect x="2.5" y="2.5" width="11" height="4" rx="1"/><rect x="2.5" y="9.5" width="11" height="4" rx="1"/><path d="M5 4.5h.01M5 11.5h.01"/>',
    spark: '<path d="M8 1.8 8.8 6 13 6.8 8.8 7.6 8 11.8 7.2 7.6 3 6.8 7.2 6z"/>',
    cpu: '<rect x="3" y="3" width="10" height="10" rx="1.5"/><path d="M6 1.8v1.4M10 1.8v1.4M6 12.8v1.4M10 12.8v1.4M1.8 6h1.4M1.8 10h1.4M12.8 6h1.4M12.8 10h1.4"/>',
    blocks: '<path d="M2.5 8.5 8 3.5l5.5 5-5.5 5z"/>',
    case: '<path d="M3 5.5h10v7H3z"/><path d="M6 5.5V4h4v1.5"/>',
    monitor: '<rect x="2.5" y="3" width="11" height="7.5" rx="1"/><path d="M6 13h4M8 10.5V13"/>',
    radio: '<path d="M8 8.2v5"/><path d="M5.2 6.2a4 4 0 0 1 5.6 0"/><path d="M3.4 4.4a6.4 6.4 0 0 1 9.2 0"/><circle cx="8" cy="8.2" r="1"/>',
    chart: '<path d="M2.5 13h11"/><path d="M4 13V8M8 13V4.5M12 13V7"/>',
    plus: '<path d="M3 8h10M8 3v10"/>',
    info: '<circle cx="8" cy="8" r="5.2"/><path d="M8 7.2V11M8 5.2h.01"/>',
    back: '<path d="M10 3.5 5.5 8 10 12.5"/>',
    sidebar: '<rect x="2.2" y="2.8" width="11.6" height="10.4" rx="1.2"/><path d="M6.2 2.8v10.4"/>',
  };
  return `<svg ${common}>${paths[name] || ""}</svg>`;
}

function brand() {
  return `<span class="rail-logo" role="img" aria-label="Rovai AI">
    <svg class="rail-logo-mark" width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 2 L13.16 7.3 L17.76 8.84 L13.16 10.38 L12 15.68 L10.84 10.38 L6.24 8.84 L10.84 7.3 Z" fill="currentColor"/>
      <path d="M3 20.96 Q12 15.96 21 20.96" fill="none" stroke="currentColor" stroke-width="2.08" stroke-linecap="round"/>
      <circle class="brand-rendezvous-point" cx="12" cy="18.46" r="1.05"/>
    </svg>
    <strong>Rovai AI</strong>
  </span>`;
}

function railButton(screen, label, glyph, current) {
  return `<button class="rail-btn" type="button" data-act="go" data-screen="${screen}" ${current ? 'aria-current="page"' : ""}>${icon(glyph)}<span>${esc(label)}</span></button>`;
}

function appRail() {
  const mission = ["project", "dispatch", "live", "activity", "delivery"].includes(ui.screen);
  const owner = nodeById("desk-b");
  return `<aside class="rail" aria-label="全局导航">
    <div class="unified-brand">${brand()}</div>
    <nav class="rail-nav" aria-label="主要页面">
      <button class="rail-btn" type="button" data-act="noop">${icon("pen")}<span>新对话</span></button>
      ${railButton("catalog", "队员", "users", ui.screen === "catalog")}
      <button class="rail-btn" type="button" data-act="noop">${icon("flag")}<span>团队</span></button>
      <button class="rail-btn" type="button" data-act="noop">${icon("board")}<span>使命板</span></button>
    </nav>
    <div class="rail-section">
      <p class="rail-kicker">项目</p>
      <p class="project-name">${esc(SAMPLE.project)}</p>
      <p class="project-path">${owner.online ? "desk-b:/Users/loom/work/loom-plan-b" : "desk-b · 不在线"}</p>
      <button class="thread-btn" type="button" data-act="go" data-screen="project" ${mission ? 'aria-current="page"' : ""}>${esc(SAMPLE.mission)}</button>
    </div>
    <div class="rail-spacer"></div>
    <div class="rail-foot">
      <button class="rail-btn" type="button" data-act="go" data-screen="nodes">${icon("gear")}<span>设置</span></button>
    </div>
  </aside>`;
}

function setButton(screen, label, glyph) {
  const on = ui.screen === screen;
  return `<button class="set-btn" type="button" data-act="go" data-screen="${screen}" ${on ? 'aria-current="page"' : ""}>${icon(glyph)}<strong>${esc(label)}</strong></button>`;
}

function setLink(label, glyph) {
  return `<button class="set-btn" type="button" data-act="go" data-screen="placeholder">${icon(glyph)}<strong>${esc(label)}</strong></button>`;
}

function settingsRail() {
  return `<aside class="rail" aria-label="设置分类">
    <div class="unified-brand">${brand()}</div>
    <div class="set-head">
      <button class="set-back" type="button" data-act="go" data-screen="project">${icon("back")}返回 App</button>
      <strong>设置</strong>
      <span>应用级偏好与本机能力</span>
    </div>
    <nav aria-label="设置页面">
      <section class="set-group"><h2>应用</h2>
        ${setLink("通用", "gear")}
        ${setLink("记忆", "spark")}
        ${setLink("外观", "monitor")}
        ${setLink("快捷键", "cpu")}
        ${setLink("提醒", "radio")}
      </section>
      <section class="set-group"><h2>能力</h2>
        ${setLink("智能体", "cpu")}
        ${setLink("MCP", "blocks")}
        ${setLink("Skills", "spark")}
        ${setLink("工具箱", "case")}
        ${setLink("远程连接", "monitor")}
        ${setButton("hosts", "远端主机", "server")}
        ${setButton("nodes", "节点", "server")}
        ${setLink("渠道", "radio")}
      </section>
      <section class="set-group"><h2>支持</h2>
        ${setLink("运行监控", "chart")}
        ${setLink("诊断与修复", "plus")}
        ${setLink("关于与更新", "info")}
      </section>
    </nav>
  </aside>`;
}

function topbar(title) {
  return `<header class="topbar">
    <button class="icon-btn" type="button" aria-label="侧栏" data-act="noop">${icon("sidebar")}</button>
    <button class="icon-btn" type="button" aria-label="后退" data-act="noop">${icon("back")}</button>
    <button class="icon-btn" type="button" aria-label="前进" data-act="noop"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><path d="M6 3.5 10.5 8 6 12.5"/></svg></button>
    <h1>${esc(title)}</h1>
    <div class="top-spacer"></div>
    <span class="sample-chip">样例数据</span>
  </header>`;
}

function empty(title, paragraphs, action) {
  return `<div class="empty" role="status">
    <div class="empty-mark" aria-hidden="true"><i></i><i></i><i></i></div>
    <h3>${esc(title)}</h3>
    ${paragraphs.map((line) => `<p>${esc(line)}</p>`).join("")}
    ${action || ""}
  </div>`;
}

function pill(kind, text) {
  return `<span class="pill ${kind}">${esc(text)}</span>`;
}

function viewNodes() {
  const state = bodyState();
  let body = "";
  if (state === "loading") {
    body = empty("正在读取节点…", ["从这份 Core 读取节点表、心跳和上次上报的 CLI。"]);
  } else if (state === "error") {
    body = empty("节点列表读取失败", ["这次没有读到节点。列表不会显示成空，也不会把本机画成离线。", "请重新读取。失败时若已有上次成功的列表，生产里会保留那份列表。"], `<button class="quiet" type="button" data-act="retry">重新读取</button>`);
  } else if (state === "empty") {
    const local = nodeById("loom-a");
    body = `${nodeRows([local])}
      ${empty("还没有拨入的节点", ["本机节点跟这份 Core 一起在，不需要配对。家里的电脑用配对码自己拨进来。"])}`;
  } else {
    const nodes = NODES.map((item) => nodeById(item.id));
    const banner = deskOffline()
      ? `<p class="note warn"><strong>desk-b 已离线。</strong> 在途的 Run 留在那台机器上，不改派。新 Run 不会派给它。上次上报的 CLI 还留着。</p>`
      : `<p class="note"><strong>节点</strong>是这一份 Core 手下的执行机器，没有自己的库。 <button class="linkish" type="button" data-act="go" data-screen="hosts">远端主机</button> 仍是打开另一台机器上的整套 LOOM。两个入口都留着。</p>`;
    body = `${banner}${nodeRows(nodes)}`;
  }
  return `${topbar("设置")}<div class="page">
    <div class="page-head">
      <div>
        <h2>节点</h2>
        <p class="lede">机器 A 是这份 Core。机器 B 出站拨进来。本机也是一台节点，只是不走网络。</p>
      </div>
      <button class="primary" type="button" data-act="pair" ${state === "loading" ? "disabled" : ""}>添加节点</button>
    </div>
    ${body}
  </div>`;
}

function nodeRows(nodes) {
  return `<div class="node-list">${nodes.map((node) => {
    const open = Boolean(ui.openNodes[node.id]);
    const status = node.online ? pill("ok", "在线") : pill("", node.kind === "local" ? "离线" : "离线 · 上次见到");
    const beat = node.online ? `心跳 ${node.heartbeat}` : `上次心跳 ${node.heartbeat}`;
    const runLine = !node.online && node.runs.length
      ? `在途 ${node.runs.length} · ${node.runs.join("、")} · 不改派`
      : node.runs.length && node.online
        ? `在跑 ${node.runs.length} · ${node.runs.join("、")}`
        : "在跑 0";
    return `<article class="node" data-node="${esc(node.id)}">
      <div>
        <div class="node-title"><i class="dot ${node.online ? "on" : "off"}"></i><strong>${esc(node.name)}</strong><em>${esc(node.role)}</em>${status}</div>
        <p class="meta">${esc(node.os)} · ${esc(node.arch)} · ${esc(beat)} · ${node.kind === "local" ? "进程内" : "出站 WebSocket"}</p>
        <div class="cli-line">${node.clis.map((cli) => `<span class="cli ${node.online ? "" : "stale"}">${esc(cli.kind)} <i>${esc(cli.version)}</i></span>`).join("")}</div>
        <p class="meta">${esc(runLine)}</p>
      </div>
      <div class="row-actions">
        <button class="quiet compact" type="button" data-act="toggle-node" data-id="${esc(node.id)}">${open ? "收起" : "CLI 路径"}</button>
        ${node.kind === "local"
          ? `<button class="quiet compact" type="button" disabled title="本机节点跟这份 Core 走">不可作废</button>`
          : `<button class="danger compact" type="button" data-act="revoke" data-id="${esc(node.id)}">作废</button>`}
      </div>
      ${open ? `<div class="detail"><table>
        <thead><tr><th>CLI</th><th>版本</th><th>节点上的路径</th><th>状态</th></tr></thead>
        <tbody>${node.clis.map((cli) => `<tr><td class="mono">${esc(cli.kind)}</td><td class="mono">${esc(cli.version)}</td><td class="path">${esc(cli.path)}</td><td>${esc(node.online ? cli.state : "上次见到")}</td></tr>`).join("")}</tbody>
      </table></div>` : ""}
    </article>`;
  }).join("")}</div>`;
}

function viewHosts() {
  return `${topbar("设置")}<div class="page">
    <div class="page-head"><div>
      <h2>远端主机</h2>
      <p class="lede">现有页面，这次不改。这里保存的是另一台机器上的整套 Rovai Server，用来在新窗口打开。Token 不写在这张列表里。</p>
    </div></div>
    <p class="note">和「节点」不是一回事。远端主机自己有 Core。节点没有库，只执行 A 派来的 Run。</p>
    <div class="node-list">
      <article class="node"><div>
        <div class="node-title"><strong>bero</strong></div>
        <p class="meta mono">https://loom.example</p>
      </div><div class="row-actions"><button class="quiet compact" type="button" data-act="noop">打开</button><button class="quiet compact" type="button" data-act="noop">移除</button></div></article>
    </div>
    <form class="host-form" data-act="host-form">
      <div class="field"><label for="host-address">地址</label><input id="host-address" value="https://loom.example" readonly></div>
      <div class="field"><label for="host-label">名称（可选）</label><input id="host-label" value="样例" readonly></div>
      <button class="primary" type="button" data-act="noop">添加</button>
    </form>
    <p class="lede">样例地址。生产页不会在这里收集 Token。</p>
  </div>`;
}

function viewPlaceholder() {
  return `${topbar("设置")}<div class="page">${empty("这是现有设置项", ["原型没有重画这一页。方案 B 新增的是旁边的「节点」。"])}</div>`;
}

function missionChrome(mode) {
  const tabs = [
    ["activity", "活动"],
    ["dispatch", "编排"],
    ["delivery", "交付"],
  ];
  const current = ui.screen === "live" || ui.screen === "dispatch" ? "dispatch" : ui.screen;
  return `${topbar(SAMPLE.mission)}
    <div class="loom-tabs" role="tablist" aria-label="LOOM">
      ${tabs.map(([id, label]) => `<button type="button" data-act="go" data-screen="${id === "dispatch" ? (mode === "live" ? "live" : "dispatch") : id}" aria-pressed="${current === id || (id === "dispatch" && (ui.screen === "live" || ui.screen === "dispatch")) ? "true" : "false"}">${esc(label)}</button>`).join("")}
    </div>`;
}

function viewProject() {
  const state = bodyState();
  const owner = nodeById("desk-b");
  let tree = "";
  let preview = "";
  if (state === "loading") {
    tree = empty("正在从主人节点读取…", ["列出 loom-plan-b。路径必须落在这棵工作区根里面。"]);
    preview = `<div class="preview"><header class="preview-head"><strong>文件</strong></header><div class="preview-body">${empty("预览等这棵树", ["树还没回来。不会先显示一个空目录。"])}</div></div>`;
  } else if (state === "error") {
    tree = empty("列出文件失败", ["主人节点在线，但这棵树没有读到。这不是空目录。", "已打开的标签会留着上次内容。这次样例里还没有打开过。"], `<button class="quiet" type="button" data-act="retry">重新读取</button>`);
    preview = `<div class="preview"><header class="preview-head"><strong>文件</strong></header><div class="preview-body">${empty("没有可显示的文件", ["从项目树点开之后，才进现有的文件预览。"])}</div></div>`;
  } else if (state === "offline") {
    tree = empty("这台机器不在线", ["文件主人是 desk-b。它现在没有心跳，所以这里不列出目录，也不显示成空文件夹。", "已打开的标签留着上次读到的内容，并标成旧的。"]);
    preview = filePreview(true);
  } else if (state === "empty") {
    tree = `<div class="tree-body"><button class="tree-item" type="button" aria-current="true">${esc(SAMPLE.root)}</button></div>
      ${empty("这个工作区还没有文件", ["根目录在 desk-b 上，而且是空的。空目录和读不到是两件事。"])}
      <div class="gitbar"><strong>Git</strong> · 干净 · 主人 desk-b · 在线</div>`;
    preview = `<div class="preview"><header class="preview-head"><strong>文件</strong></header><div class="preview-body">${empty("从左侧项目树选择文件", ["还没有文件可以预览。"])}</div></div>`;
  } else {
    tree = `${treeBody()}<div class="gitbar"><strong>main</strong> · 已修改 2 · 新文件 1<br>主人 desk-b · ${owner.online ? "在线" : "不在线"} · 变更正文仍走现有执行变更，这里只标状态。</div>`;
    preview = filePreview(false);
  }
  return `${topbar(SAMPLE.mission)}<div class="workspace">
    <header class="modebar">
      <span class="seg" role="group" aria-label="使命工作区">
        <button type="button" aria-pressed="true">项目</button>
        <button type="button" data-act="go" data-screen="dispatch">编排</button>
      </span>
      <span class="sample-chip">${esc(SAMPLE.number)}</span>
      <div class="stats">${pill(owner.online ? "ok" : "warn", owner.online ? "文件主人 desk-b" : "文件主人离线")}</div>
    </header>
    <div class="split">
      <aside class="tree" aria-label="项目树">
        <header class="tree-head"><strong>${esc(SAMPLE.root)}</strong><span class="sample-chip">样例</span></header>
        ${tree}
      </aside>
      ${preview}
    </div>
  </div>`;
}

function treeBody() {
  const rows = [
    { id: "README.md", depth: 0, label: "README.md", git: "M" },
    { id: "src", depth: 0, label: "src", dir: true },
    { id: "src/node", depth: 1, label: "node", dir: true },
    { id: "src/node/connect.ts", depth: 2, label: "connect.ts", git: "M" },
    { id: "src/node/heartbeat.ts", depth: 2, label: "heartbeat.ts", git: "A" },
    { id: "docs", depth: 0, label: "docs", dir: true },
    { id: "docs/loom", depth: 1, label: "loom", dir: true },
    { id: "docs/loom/plan-b.md", depth: 2, label: "plan-b.md", git: "" },
  ];
  const html = rows.filter((row) => {
    if (row.id !== "src" && row.id.startsWith("src") && !ui.openDirs.src) return false;
    if (row.depth >= 2 && row.id.startsWith("src/node/") && !ui.openDirs["src/node"]) return false;
    if ((row.id === "docs/loom" || row.id.startsWith("docs/loom/")) && !ui.openDirs.docs) return false;
    if (row.id.startsWith("docs/loom/") && !ui.openDirs["docs/loom"]) return false;
    return true;
  }).map((row) => {
    const current = ui.file === row.id;
    const badge = row.git === "M" ? '<span class="badge m">M</span>' : row.git === "A" ? '<span class="badge a">A</span>' : "";
    const act = row.dir ? "toggle-dir" : "file";
    const mark = row.dir ? (ui.openDirs[row.id] || row.id === "root" ? "▾" : "▸") : " ";
    return `<button class="tree-item" type="button" style="padding-left:${10 + row.depth * 14}px" data-act="${act}" data-id="${esc(row.id)}" ${current ? 'aria-current="true"' : ""}><span aria-hidden="true">${mark}</span><span>${esc(row.label)}</span>${badge}</button>`;
  }).join("");
  return `<div class="tree-body" role="tree">${html}</div>`;
}

function filePreview(stale) {
  const file = FILES[ui.file] || FILES["src/node/heartbeat.ts"];
  const name = ui.file.split("/").pop();
  const lines = file.body.replace(/\n$/, "").split("\n");
  const code = ui.edit
    ? `<textarea class="code-edit" id="code-edit" data-act="edit-text">${esc(file.body)}</textarea>`
    : `<div class="code" aria-label="文件预览">${lines.map((line, index) => `<div class="ln"><span class="n">${index + 1}</span><span class="s">${esc(line) || " "}</span></div>`).join("")}</div>`;
  return `<section class="preview" aria-label="文件预览">
    <header class="preview-head">
      <div class="tabs"><button class="file-tab" type="button" aria-current="true">${esc(name)}${ui.edit ? " · 未保存" : ""}</button></div>
      <div class="top-spacer"></div>
      <button class="quiet compact" type="button" data-act="toggle-edit" ${stale ? "disabled" : ""}>${ui.edit ? "预览" : "编辑"}</button>
    </header>
    ${stale ? `<p class="stale">上次内容 · 10:02 · 主人节点离线。这不是当前磁盘上的文件。</p>` : ""}
    ${ui.edit ? `<p class="editor-banner">只读为主。样例里的改动停在这页，不会送到节点。</p>` : ""}
    <div class="preview-body">${code}</div>
  </section>`;
}

function viewCatalog() {
  const state = bodyState();
  const agent = agentById(ui.agent);
  const node = nodeById(agent.node);
  let body = "";
  if (state === "loading") body = empty("正在读取目录…", ["技能、MCP、规则片段和 hook 都在 A 上。勾选结果也在 A 上。"]);
  else if (state === "error") {
    body = empty("目录读取失败", ["勾选状态未知。这一页不把未知画成未选中，避免一次刷新看起来像全部取消。"], `<button class="quiet" type="button" data-act="retry">重新读取</button>`);
  } else {
    const items = catalogVisible();
    const conflicts = state === "empty" ? new Set() : conflictIds(items);
    const banner = [];
    if (!node.online) banner.push(`<p class="note warn"><strong>${esc(node.name)} 离线。</strong> 勾选仍写在 A 上，从下一次 Run 的运行包生效。现在不能在这台机器上启动。</p>`);
    if (conflicts.size) banner.push(`<p class="note warn"><strong>冲突 · read_file。</strong> filesystem 和规则片段「只读工作区」都要占用这个名字。取消其中一个勾选后，运行包才不会把两份一起送出去。</p>`);
    body = `${banner.join("")}
      <div class="bind">
        <div><label for="runtime">CLI / 运行时</label>
          <select id="runtime" class="select" data-act="runtime" ${state === "empty" ? "" : ""}>
            ${["claude-code-cli", "codex-cli"].map((kind) => `<option ${agent.runtime === kind ? "selected" : ""}>${esc(kind)}</option>`).join("")}
          </select>
        </div>
        <div><label for="target-node">目标节点</label>
          <select id="target-node" class="select" data-act="target-node">
            ${NODES.map((item) => {
              const live = nodeById(item.id);
              const has = live.clis.some((cli) => cli.kind === agent.runtime);
              const label = `${live.name} · ${live.online ? "在线" : "离线"}${has ? "" : " · 没有这个 CLI"}`;
              return `<option value="${esc(item.id)}" ${item.id === agent.node ? "selected" : ""} ${!live.online || !has ? "disabled" : ""}>${esc(label)}</option>`;
            }).join("")}
          </select>
        </div>
      </div>
      <p class="meta">运行包在 Run 开始前写到节点上的私有目录，权限 0700，结束就删。节点不保存第二份队员数据库。</p>
      <div class="search"><input id="catalog-search" type="search" placeholder="搜索名称、来源" value="${esc(ui.query)}" data-act="search"></div>
      <div class="groups">
      ${group("skill", "技能", "工具箱五项。勾上即存，失败会滚回这个勾选。", items, conflicts, "五项都在。这个队员还没有勾选。")}
      ${group("mcp", "MCP", "服务器定义是全局的。这里只决定这个队员用不用。", items, conflicts, "还没有 MCP 服务器。定义仍在设置里的 MCP 页。")}
      ${group("rule", "规则", "身份里的六段文字不在这里勾选。下面是可复用的规则片段，勾上的才会进入下一次运行包。", items, conflicts, "还没有可勾选的规则片段。身份里的六段文字仍会随下一次运行包出发。", true)}
      ${group("hook", "hook", "没有条目时就这样写，不放一排永远空着的开关。", items, conflicts, "还没有可勾选的 hook。")}
      </div>
    `;
  }
  return `${topbar("队员")}<div class="member-split">
    <aside class="roster" aria-label="队员">
      <header class="roster-head"><strong>队员</strong></header>
      ${AGENTS.map((item) => `<button class="member" type="button" data-act="agent" data-id="${item.id}" ${item.id === ui.agent ? 'aria-current="page"' : ""}>
        <span class="avatar" style="background:${item.identity}">${esc(item.name)}</span>
        <span><strong>${esc(item.name)}</strong><small>${esc(item.role)}</small></span>
      </button>`).join("")}
    </aside>
    <div class="detail-pane">
      <div class="page-head"><div>
        <p class="eyebrow">队员 · 目录</p>
        <h2>${esc(agent.name)}</h2>
        <p class="lede">${esc(agent.role)}。四个分组都在 A 上。样例队员，不是真实的人。</p>
      </div><span class="sample-chip">样例数据</span></div>
      ${body}
    </div>
  </div>`;
}

function group(key, title, hint, items, conflicts, emptyCopy, identity) {
  const rows = items.filter((item) => item.group === key);
  const identityBlock = identity && ui.identityOpen ? `<div class="identity">
    <span>显示名</span><strong>织</strong>
    <span>团队角色</span><strong>主助手</strong>
    <span>专业职责</span><strong>样例 · 把使命拆开</strong>
    <span>性格特质</span><strong>样例 · 短句</strong>
    <span>工作准则</span><strong>样例 · 先写放置理由</strong>
    <span>成长课题</span><strong>样例 · 不发明第二套编排</strong>
  </div>` : "";
  const head = `<section class="group" aria-label="${esc(title)}"><h3>${esc(title)}</h3><p class="hint">${esc(hint)}</p>
    ${identity ? `<button class="linkish" type="button" data-act="identity">${ui.identityOpen ? "收起身份六段" : "身份六段在队员身份里编辑"}</button>${identityBlock}` : ""}`;
  if (!rows.length) return `${head}<p class="hint">${esc(ui.query ? "没有匹配的条目。" : emptyCopy)}</p></section>`;
  return `${head}${rows.map((item) => `<label class="check ${conflicts.has(item.id) ? "conflict" : ""}">
    <input type="checkbox" data-act="check" data-id="${esc(item.id)}" ${item.checked ? "checked" : ""}>
    <span><strong>${esc(item.name)}</strong>${item.risk ? ` ${pill("warn", "高风险")}` : ""}${conflicts.has(item.id) ? ` ${pill("warn", "冲突")}` : ""}<p>${esc(item.note)}</p></span>
    <span class="src">${esc(item.source)}</span>
  </label>`).join("")}</section>`;
}

function statusWord(status) {
  return { done: "已结束", running: "在跑", blocked: "阻塞", ready: "就绪" }[status] || status;
}

function taskCards(list) {
  return `<div class="flow">${[0, 1, 2].map((depth) => {
    const inStage = list.filter((task) => task.depth === depth);
    return `<div class="stage"><span class="stage-label">阶段 ${depth + 1}</span>${inStage.map((task) => {
      const agent = agentById(task.agent);
      const node = nodeById(task.node);
      const selected = ui.task === task.id;
      return `<button class="card ${esc(task.status)}" type="button" data-act="task" data-id="${task.id}" aria-pressed="${selected ? "true" : "false"}">
        <div class="card-top"><i class="dot ${task.status === "running" ? "run" : task.status === "blocked" ? "block" : task.status === "done" ? "done" : "on"}"></i><strong>${esc(task.title)}</strong></div>
        <div class="status">${esc(statusWord(task.status))}</div>
        <p>${esc(agent.name)} · ${esc(task.runtime)}</p>
        <p>${esc(node.name)} · ${node.online ? "在线" : "离线"}</p>
        <div class="claim"><b>${esc(task.claim)}</b></div>
      </button>`;
    }).join("")}</div>`;
  }).join("")}</div>
  <div class="legend"><span><i></i>任务完成即可放行</span><span><i class="dash"></i>需人工验收后放行</span><span><i class="block"></i>当前阻塞</span></div>`;
}

function viewDispatch() {
  const state = bodyState();
  let body = "";
  if (state === "loading") body = empty("正在读取编排…", ["从控制面读取计划、任务与依赖关系。"]);
  else if (state === "error") body = empty("读取编排失败", ["请检查控制面连接后重试。节点行不会拿一份空白计划来填。"], `<button class="quiet" type="button" data-act="retry">重新读取</button>`);
  else if (state === "empty") {
    body = `<p class="intro">把目标、责任与交付放在同一张工作图上。执行状态和人工验收各自保留。</p>
      ${empty("尚未配置编排", ["这个使命还没有任务依赖或执行计划。", "由主助手建立计划后，这里会显示任务关系、负责队员和放置理由。"])}
      <div class="foundation"><div><span>当前使命</span><strong>${esc(SAMPLE.mission)}</strong></div><div><span>队员</span><strong>3</strong></div><div><span>执行中</span><strong>0</strong></div></div>`;
  } else {
    const list = tasks();
    const task = list.find((item) => item.id === ui.task) || list[1];
    const ownerOff = deskOffline() && task.node === "desk-b";
    body = `<header class="flow-title"><div><p class="eyebrow">LOOM · 编排 · 派遣</p><h2>一次使命，分到两台机器</h2></div><span class="sample-chip">${esc(SAMPLE.number)}</span></header>
      <p class="intro">每段活有自己的文件主人。已经钉死的工作区不能改到另一台节点。下面写的是选择，以及为什么不能选别的。</p>
      ${ownerOff ? `<p class="note warn"><strong>desk-b 离线。</strong> 「在 B 上跑通心跳」的文件不在其他机器上，不能改派。进程若还在，就等它重连。</p>` : ""}
      ${taskCards(list)}
      <section class="inspector" aria-label="放置理由">
        <div>
          <h3>${esc(task.title)}</h3>
          <dl class="why">
            <dt>为什么在这台机器</dt><dd>${esc(ownerOff ? "文件主人是 desk-b，但它现在离线。工作区不自动迁走。新的尝试也要等这台节点回来，或者人另开一份工作区。" : task.why)}</dd>
            <dt>工作区</dt><dd class="mono">${esc(task.workspace)}</dd>
            <dt>CLI</dt><dd class="mono">${esc(task.runtime)} · ${esc(agentById(task.agent).name)}</dd>
          </dl>
        </div>
        <div>
          <h3>可以放到</h3>
          <div class="choices">${NODES.map((item) => {
            const live = nodeById(item.id);
            const selected = item.id === task.node;
            let reason = "在线，且上报了这个 CLI";
            let disabled = false;
            if (!live.online) { reason = "离线，不接新 Run"; disabled = true; }
            else if (task.id === "impl" && item.id !== "desk-b") { reason = "这份工作区的主人不是它"; disabled = true; }
            else if (task.id !== "impl" && item.id === "desk-b" && task.node !== "desk-b") { reason = "这段活的文件不在 B 上"; disabled = true; }
            else if (!live.clis.some((cli) => cli.kind === task.runtime)) { reason = "没有上报这个 CLI"; disabled = true; }
            if (selected) reason = ownerOff ? "主人，当前离线" : "当前放置";
            return `<label class="choice ${selected ? "on" : ""}"><input type="radio" name="place" ${selected ? "checked" : ""} ${disabled && !selected ? "disabled" : ""} data-act="place" data-id="${esc(item.id)}"><span>${esc(live.name)} · ${esc(live.role)}<small>${esc(reason)}</small></span></label>`;
          }).join("")}</div>
        </div>
      </section>`;
  }
  return `${missionChrome("dispatch")}<div class="workspace">
    <header class="modebar">
      <span class="seg"><button type="button" aria-pressed="true">派遣</button><button type="button" data-act="go" data-screen="live">现场</button></span>
      <button class="quiet compact" type="button" data-act="go" data-screen="project">项目</button>
      <div class="stats">${dispatchStats()}</div>
    </header>
    <div class="flow-scroll">${body}</div>
  </div>`;
}

function viewLive() {
  const state = bodyState();
  if (state === "loading") {
    return `${missionChrome("live")}<div class="workspace"><header class="modebar">${liveMode()}</header><div class="flow-scroll">${empty("正在读取现场…", ["计划、认领和节点上的输出序号一起读。某一路失败不会把别的路清掉。"])}</div></div>`;
  }
  if (state === "error") {
    return `${missionChrome("live")}<div class="workspace"><header class="modebar">${liveMode()}</header><div class="flow-scroll">${empty("执行过程读取失败", ["这次连计划也没有读到。若只是某一路输出失败，卡片还在，终端里写失败原因。"], `<button class="quiet" type="button" data-act="retry">重新读取</button>`)}</div></div>`;
  }
  if (state === "empty") {
    return `${missionChrome("live")}<div class="workspace"><header class="modebar">${liveMode()}</header><div class="flow-scroll">
      <header class="flow-title"><div><p class="eyebrow">LOOM · 编排 · 现场</p><h2>还没有执行</h2></div></header>
      ${empty("派遣之后，输出会从节点推到这里", ["依赖图可以先在。没有 Run 的时候，终端不伪造一行输出。"])}
    </div></div>`;
  }
  const list = tasks();
  const task = list.find((item) => item.id === ui.task) || list[1];
  const claimsUnknown = ui.state === "claims";
  const waiting = deskOffline() && task.id === "impl";
  const log = waiting
    ? LOG.concat([["—", "wait", "连接已断 · 已确认到序号 148 · 进程还在 · 不另起进程"]])
    : LOG.concat(ui.extraLog);
  return `${missionChrome("live")}<div class="workspace">
    <header class="modebar">${liveMode()}</header>
    <div class="live">
      <div class="flow-pane">
        <div class="flow-scroll">
          <header class="flow-title"><div><p class="eyebrow">LOOM · 编排 · 现场</p><h2>心跳正在 B 上跑</h2></div><span class="sample-chip">样例回放</span></header>
          ${claimsUnknown ? `<p class="note warn"><strong>认领状态未知。</strong> 这不是「没有认领」。其他任务和输出照常显示。</p>` : ""}
          ${waiting ? `<p class="note warn"><strong>desk-b 的连接断了。</strong> 在途 Run 不换机器。重连后从序号 148 之后继续送。</p>` : ""}
          ${taskCards(list.map((item) => claimsUnknown ? { ...item, claim: "认领状态未知" } : item))}
        </div>
        <section class="lanes" aria-label="节点泳道">
          <h3>节点</h3>
          <div class="axis"><span>10:02</span><span>10:10</span><span>10:18</span></div>
          ${lane("loom-a", 4, 38, "拆节点协议", "done")}
          ${lane("desk-b", 38, waiting ? 70 : 92, waiting ? "等待重连" : "跑通心跳", waiting ? "wait" : "run")}
          ${lane("win-studio", 0, 0, "", "off")}
        </section>
      </div>
      <section class="run-pane" aria-label="执行过程">
        <header class="run-head">
          <div class="who"><strong>${esc(task.title)}</strong><small>${esc(agentById(task.agent).name)} · ${esc(task.runtime)} · ${esc(nodeById(task.node).name)} · ${waiting && task.id === "impl" ? "等待重连" : statusWord(task.status)}</small></div>
          <div class="top-spacer"></div>
          <button class="quiet compact" type="button" data-act="append" ${task.id === "impl" && !waiting ? "" : "disabled"}>追加一帧</button>
        </header>
        <pre class="term">${task.id === "impl" ? log.map((row) => `<div class="row"><span class="seq">${esc(row[0])}</span><span class="stream">${esc(row[1])}</span><span class="${row[1] === "wait" ? "frozen" : ""}">${esc(row[2])}</span></div>`).join("") : `<div class="row"><span class="seq">—</span><span class="stream">note</span><span>${esc(task.id === "spec" ? "这段输出已经结束，回放留在 A 上。" : "还没有输出。上游产物验收之后才会启动。")}</span></div>`}</pre>
        <div class="artifacts">
          <h3>产物</h3>
          <button class="art" type="button" data-act="open-art" data-file="docs/loom/plan-b.md"><code>docs/loom/plan-b.md</code><span class="add">已验收</span><span>打开</span></button>
          <button class="art" type="button" data-act="open-art" data-file="src/node/heartbeat.ts"><code>src/node/heartbeat.ts</code><span class="add">+12</span><span>${ui.accepted ? "已验收" : "刚刚出现"}</span></button>
        </div>
        <footer class="review">
          ${reviewControls(task, waiting)}
        </footer>
      </section>
    </div>
  </div>`;
}

function dispatchStats() {
  const state = bodyState();
  if (state === "loading" || state === "error") return "";
  if (state === "empty") return "<span>总任务 0</span>";
  return `<span>依赖就绪 1</span><span>阻塞 ${ui.accepted ? 0 : 1}</span><span>总任务 3</span>`;
}

function liveMode() {
  const state = bodyState();
  const stats = state === "ready" || state === "offline" || state === "claims"
    ? `<span>序号 148</span><span>在跑 ${state === "offline" ? 0 : 1}</span>`
    : "";
  return `<span class="seg"><button type="button" data-act="go" data-screen="dispatch">派遣</button><button type="button" aria-pressed="true">现场</button></span>
    <button class="quiet compact" type="button" data-act="go" data-screen="project">项目</button>
    <div class="stats">${stats}</div>`;
}

function lane(id, start, end, label, kind) {
  const node = nodeById(id);
  const off = !node.online;
  const bar = end > start ? `<button class="bar ${kind}" type="button" data-act="task" data-id="${id === "loom-a" ? "spec" : "impl"}" style="left:${start}%;width:${end - start}%">${esc(label)}</button>` : `<span class="lane-note">${off ? "离线 · 不接新活" : "还没开始"}</span>`;
  return `<div class="lane ${off ? "off" : ""}"><div class="lane-name"><i class="dot ${off ? "off" : "on"}"></i><span>${esc(node.name)}</span></div><div class="track">${bar}</div></div>`;
}

function reviewControls(task, waiting) {
  if (task.id === "spec") return `<p>这段已经验收过。下游要等 B 上的产物。</p><button class="quiet compact" type="button" disabled>已验收</button>`;
  if (task.id === "review") return `<p>${ui.accepted ? "上游已验收，这段可以认领。" : "还没有产物。按钮不可用。"}</p><button class="primary compact" type="button" disabled>验收通过</button>`;
  if (ui.accepted) return `<p>样例 · 已记下验收，没有写入控制面。阶段 3 变为就绪。</p><button class="quiet compact" type="button" disabled>已验收</button>`;
  return `<p>${waiting ? "连接断了。已经送回的产物仍可验收。" : "需人工验收后放行。验收写的是现有评审，不是新的一套批准。"}</p>
    <button class="primary compact" type="button" data-act="accept">验收通过</button>
    <button class="quiet compact" type="button" data-act="reject">退回修改</button>`;
}

function viewNote(title, copy) {
  return `${missionChrome("dispatch")}<div class="flow-scroll">${empty(title, copy)}<p class="intro"><button class="linkish" type="button" data-act="go" data-screen="dispatch">回到编排</button></p></div>`;
}

function dialogs() {
  if (ui.state === "pair" && ui.screen === "nodes") {
    return `<div class="overlay" role="presentation"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="pair-title">
      <h3 id="pair-title">添加节点</h3>
      <p class="sub">配对码 10 分钟内有效，用过即废。样例码，不是真的节点凭据。</p>
      <p class="pair-code">${esc(SAMPLE.pairCode)}</p>
      <p class="meta">B 要拨的地址</p>
      <p class="cmd">${esc(SAMPLE.server)}</p>
      <p class="meta" style="margin-top:12px">在 B 上执行</p>
      <pre class="cmd" id="pair-command">${esc(SAMPLE.command)}</pre>
      <div class="dialog-foot">
        <button class="quiet" type="button" data-act="close">关闭</button>
        <button class="primary" type="button" data-act="copy">复制命令</button>
      </div>
    </div></div>`;
  }
  if (ui.state === "revoke" && ui.screen === "nodes") {
    return `<div class="overlay"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="revoke-title">
      <h3 id="revoke-title">作废 desk-b？</h3>
      <p class="sub">令牌立即作废。下一次心跳失败。在途进程由节点自己杀掉并上报。磁盘上的项目文件还在，只是这份 Core 不再把新 Run 派给它。</p>
      <div class="dialog-foot">
        <button class="quiet" type="button" data-act="close">取消</button>
        <button class="danger" type="button" data-act="confirm-revoke">作废</button>
      </div>
    </div></div>`;
  }
  if (ui.riskFor) {
    return `<div class="overlay"><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="risk-title">
      <h3 id="risk-title">确认高风险 MCP</h3>
      <p class="sub">browser 可以离开工作区。沿用现有的 acknowledge_high_risk。取消则这个勾选不保存。</p>
      <div class="dialog-foot">
        <button class="quiet" type="button" data-act="cancel-risk">取消</button>
        <button class="primary" type="button" data-act="confirm-risk">确认并勾选</button>
      </div>
    </div></div>`;
  }
  return "";
}

function screenBody() {
  if (ui.screen === "nodes") return viewNodes();
  if (ui.screen === "hosts") return viewHosts();
  if (ui.screen === "placeholder") return viewPlaceholder();
  if (ui.screen === "project") return viewProject();
  if (ui.screen === "catalog") return viewCatalog();
  if (ui.screen === "dispatch") return viewDispatch();
  if (ui.screen === "live") return viewLive();
  if (ui.screen === "activity") return viewNote("活动仍是现有使命历史", ["这一分段不改。原型不另画一张活动时间线。"]);
  if (ui.screen === "delivery") return viewNote("交付仍是现有验收列表", ["产物和评审的权威列表还在交付分段。现场上的验收写回同一处。"]);
  return viewNodes();
}

function renderBar() {
  const screens = [
    ["nodes", "节点"],
    ["hosts", "远端主机"],
    ["project", "项目"],
    ["catalog", "目录"],
    ["dispatch", "派遣"],
    ["live", "现场"],
  ];
  const states = [
    ["ready", "就绪"],
    ["empty", "空"],
    ["loading", "读取中"],
    ["error", "失败"],
    ["offline", "离线"],
    ["pair", "配对"],
    ["revoke", "作废"],
    ["claims", "认领未知"],
  ];
  bar.innerHTML = `<strong>样例原型</strong>
    <label>屏幕 <select data-act="bar-screen">${screens.map(([id, label]) => `<option value="${id}" ${ui.screen === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <label>状态 <select data-act="bar-state">${states.map(([id, label]) => `<option value="${id}" ${ui.state === id ? "selected" : ""}>${label}</option>`).join("")}</select></label>
    <label>主题 <select data-act="bar-theme"><option value="day" ${ui.theme === "day" ? "selected" : ""}>日间</option><option value="night" ${ui.theme === "night" ? "selected" : ""}>夜间</option></select></label>
    <span class="grow"></span>
    <span>不写入生产 · 用查询参数可以固定一帧</span>`;
}

function render() {
  document.documentElement.dataset.theme = ui.theme;
  document.body.classList.toggle("is-shot", ui.shot);
  const active = document.activeElement;
  const activeId = active && active.id;
  const start = active && "selectionStart" in active ? active.selectionStart : null;
  const settings = ui.screen === "nodes" || ui.screen === "hosts" || ui.screen === "placeholder";
  root.innerHTML = `<div class="app">${settings ? settingsRail() : appRail()}<div class="main">${screenBody()}</div></div>${dialogs()}${ui.toast ? `<div class="toast" role="status">${esc(ui.toast)}</div>` : ""}`;
  renderBar();
  if (activeId) {
    const next = document.getElementById(activeId);
    if (next) {
      next.focus();
      if (start != null && next.setSelectionRange) {
        const end = Math.min(start, next.value.length);
        next.setSelectionRange(end, end);
      }
    }
  }
}

function go(screen, state) {
  ui.screen = screen;
  if (state) ui.state = state;
  if (ui.state === "pair" || ui.state === "revoke") ui.screen = "nodes";
  if (ui.state === "claims") ui.screen = "live";
  ui.riskFor = null;
  writeUrl();
  render();
}

function onClick(event) {
  const el = event.target.closest("[data-act]");
  if (!el || el.matches("input, select, textarea")) return;
  const act = el.dataset.act;
  if (act === "go") go(el.dataset.screen || ui.screen);
  else if (act === "noop") toast("样例 · 这个入口保持现有页面");
  else if (act === "pair") go("nodes", "pair");
  else if (act === "revoke") go("nodes", "revoke");
  else if (act === "close") go(ui.screen, "ready");
  else if (act === "retry") {
    ui.state = "ready";
    writeUrl();
    toast("样例 · 重新读取得到了就绪数据");
  } else if (act === "copy") {
    const text = SAMPLE.command.replaceAll(" \\\n  ", " ");
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText(text).catch(() => {});
    toast("样例 · 已复制配对命令");
  } else if (act === "confirm-revoke") {
    ui.state = "offline";
    writeUrl();
    toast("样例 · desk-b 已作废，没有真的令牌被吊销");
  } else if (act === "toggle-node") ui.openNodes[el.dataset.id] = !ui.openNodes[el.dataset.id];
  else if (act === "toggle-dir") ui.openDirs[el.dataset.id] = !ui.openDirs[el.dataset.id];
  else if (act === "file") {
    ui.file = el.dataset.id;
    ui.edit = false;
    writeUrl();
  } else if (act === "toggle-edit") ui.edit = !ui.edit;
  else if (act === "agent") {
    ui.agent = el.dataset.id;
    writeUrl();
  } else if (act === "task") {
    ui.task = el.dataset.id;
    writeUrl();
  } else if (act === "identity") ui.identityOpen = !ui.identityOpen;
  else if (act === "accept") {
    ui.accepted = true;
    toast("样例 · 已记下验收，没有写入控制面");
    return;
  } else if (act === "reject") toast("样例 · 已记下退回，没有写入控制面");
  else if (act === "append") {
    ui.extraLog.push([String(149 + ui.extraLog.length), "stdout", "样例 · 又一帧输出"]);
    toast("样例 · 追加了一帧，序号只在这页上增加");
    return;
  } else if (act === "open-art") {
    ui.screen = "project";
    ui.file = el.dataset.file;
    ui.state = "ready";
    writeUrl();
  } else if (act === "confirm-risk") {
    checks()[ui.riskFor] = true;
    ui.riskFor = null;
    toast("样例 · 已确认高风险 MCP");
  } else if (act === "cancel-risk") ui.riskFor = null;
  else if (act === "place") toast("样例 · 已钉死的主人不能从这里改派");
  render();
}

function onChange(event) {
  const el = event.target.closest("[data-act]");
  if (!el) return;
  const act = el.dataset.act;
  if (act === "bar-screen") go(el.value);
  else if (act === "bar-state") go(ui.state === "pair" || ui.state === "revoke" ? "nodes" : ui.state === "claims" ? "live" : ui.screen, el.value);
  else if (act === "bar-theme") {
    ui.theme = el.value;
    writeUrl();
    render();
  } else if (act === "search") ui.query = el.value;
  else if (act === "check") {
    const item = CATALOG.find((entry) => entry.id === el.dataset.id);
    if (el.checked && item?.risk && !checks()[item.id]) {
      el.checked = false;
      ui.riskFor = item.id;
      render();
      return;
    }
    const next = { ...checks(), [el.dataset.id]: el.checked };
    const items = CATALOG.map((entry) => ({ ...entry, checked: next[entry.id] }));
    if (el.checked && conflictIds(items).has(el.dataset.id) && !checks()[el.dataset.id]) {
      const before = conflictIds(CATALOG.map((entry) => ({ ...entry, checked: checks()[entry.id] })));
      if (!before.has(el.dataset.id)) {
        el.checked = false;
        toast("样例 · 这个勾选造成冲突，已回滚");
        return;
      }
    }
    checks()[el.dataset.id] = el.checked;
  } else if (act === "edit-text") return;
  else if (act === "runtime" || act === "target-node") toast("样例 · 运行时和节点的改动停在这页");
  render();
}

document.addEventListener("click", onClick);
document.addEventListener("change", onChange);
document.addEventListener("input", (event) => {
  if (event.target.id === "catalog-search") {
    ui.query = event.target.value;
    render();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && (ui.state === "pair" || ui.state === "revoke" || ui.riskFor)) {
    ui.riskFor = null;
    if (ui.state === "pair" || ui.state === "revoke") ui.state = "ready";
    writeUrl();
    render();
  }
});

render();
