// Live fixture for one paired, Node-only device with its own private desktop.
//
// The acceptance this supports is: a real page authorizes computer control for a paired
// node, a real Pi model drives that desktop through the reviewed MCP toolchain, the node's
// desktop really changes, and revoking the grant in the page refuses the next call.
//
// Isolation, stated exactly:
// * `buildNodeOnlyRoot` assembles a private root that contains ONLY the node binary, the
//   desktop helper, one interpreter with its standard library, and the shared libraries
//   those three need. Nothing else from the host, and no Core data directory, is reachable
//   from inside it. `startNode` runs the node under `chroot` with an `env -i` environment,
//   so the model credential of the Host process cannot leak into the device.
// * Docker is unavailable inside the development container (`loom-dev`), so this fixture
//   uses a chroot instead of a container. The claim it supports is "an independent
//   Node-only root with its own display", never "a second Docker container".
// * The display is a private Xvfb started by the fixture with TCP listening on loopback,
//   because a chroot cannot see the host's `/tmp/.X11-unix`. It is opt-in per fixture and
//   never the user's desktop.
//
// Nothing here starts a Core, a model or a browser: the caller owns those. Every child is
// returned so the caller can stop exactly what it started.

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'

export const NODE_ROOT_BINARIES = Object.freeze({
  node: '/usr/local/bin/node',
  python: '/usr/bin/python3',
  client: '/usr/local/bin/loom-node',
  helper: '/usr/local/bin/host_desktop.py',
  // `ctypes.util.find_library` runs `/sbin/ldconfig -p` INSIDE the root to resolve libX11,
  // so the loader tool is part of what the helper needs, not extra userland.
  ldconfig: '/sbin/ldconfig'
})

export const NODE_ONLY_LISTEN = '127.0.0.1'

/** The helper speaks JSON on stdin, one request per process (`resources/computer/host_desktop.py`). */
export const HELPER_INFO_REQUEST = Object.freeze({ op: 'info' })
export const HELPER_CAPTURE_REQUEST = Object.freeze({ op: 'capture', consent: true, maxWidth: 1280, maxHeight: 900 })

const DEV_NODES = Object.freeze([
  ['null', '1', '3'],
  ['zero', '1', '5'],
  ['random', '1', '8'],
  ['urandom', '1', '9'],
  ['tty', '5', '0']
])

export const pause = ms => new Promise(done => setTimeout(done, ms))

/** The kernel tool that enters the private root. Absolute, because the clean env has no PATH. */
export const CHROOT_BINARY = Object.freeze([
  '/usr/sbin/chroot', '/sbin/chroot', '/usr/bin/chroot'
].find(candidate => existsSync(candidate)) ?? 'chroot')

/** `rovai-server node-pair` prints the one-time code on stdout and the URL on stderr. */
export function parsePairOutput ({ stdout = '', stderr = '' } = {}) {
  const code = String(stdout).trim().split(/\r?\n/u).map(line => line.trim()).find(line => /^[0-9a-f]{8,64}$/u.test(line)) ?? null
  const connect = /^connect:\s*(\S+)$/mu.exec(String(stderr))?.[1] ?? null
  return { code, connect }
}

/** The exact desktop marker a fixture click writes, and nothing broader than that. */
export function clickReceipt (text) {
  return typeof text === 'string' && text.trim() === 'CONFIRM'
}

/** The typed line, trimmed, must be exactly the code this run asked for. */
export function typedReceipt (text, expected) {
  return typeof text === 'string' && typeof expected === 'string' && expected.length > 0 && text.trim() === expected
}

export function digestOf (bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

/** A stable, ordered description of what the private root must contain. */
export function nodeOnlyRootPlan (root, sources = {}) {
  const chosen = { ...NODE_ROOT_BINARIES, ...sources }
  const shared = '/usr/lib/x86_64-linux-gnu'
  return {
    root,
    directories: [
      'bin', 'dev', 'etc', 'home', 'lib', 'lib64', 'proc', 'root', 'tmp',
      'usr/bin', 'usr/local/bin', 'usr/lib', 'work', shared
    ],
    devices: DEV_NODES.map(([name, major, minor]) => ({ name, major, minor })),
    binaries: [
      { from: chosen.node, to: 'usr/local/bin/node' },
      { from: chosen.python, to: 'usr/bin/python3' },
      { from: chosen.client, to: 'usr/local/bin/loom-node' },
      { from: chosen.helper, to: 'usr/local/bin/host_desktop.py' },
      { from: chosen.ldconfig, to: 'sbin/ldconfig' }
    ],
    /** Libraries the helper loads through ctypes, invisible to `ldd` on the binaries. */
    runtimeLibraries: [
      '/usr/lib/x86_64-linux-gnu/libX11.so.6',
      '/usr/lib/x86_64-linux-gnu/libXext.so.6',
      '/usr/lib/x86_64-linux-gnu/libXtst.so.6'
    ],
    /** Python's `ctypes.util.find_library` needs this cache; `ldconfig -r` rebuilds it. */
    libraryRoots: ['/usr/lib', '/lib', '/lib64', shared],
    pythonPackages: ['/usr/lib/python3.11', '/usr/lib/python3/dist-packages/PIL'],
    ldCache: 'etc/ld.so.cache'
  }
}

function loadableExtensions (directories) {
  const found = []
  for (const directory of directories) {
    if (!existsSync(directory)) continue
    for (const name of readdirSync(directory)) {
      if (name.endsWith('.so')) found.push(join(directory, name))
      else if (name.includes('.so.')) found.push(join(directory, name))
    }
  }
  return found
}

function isElf (path) {
  try {
    const header = readFileSync(path).subarray(0, 4)
    return header.length === 4 && header[0] === 0x7f && header.toString('ascii', 1, 4) === 'ELF'
  } catch { return false }
}

function lddLibraries (paths) {
  const libraries = new Set()
  for (const path of paths) {
    if (!existsSync(path) || !isElf(path)) continue
    let output = ''
    try {
      output = execFileSync('ldd', [path], { encoding: 'utf8' })
    } catch {
      continue
    }
    for (const line of output.split('\n')) {
      const target = /=>\s+(\/\S+)/u.exec(line)?.[1] ?? /^\s*(\/\S+)\s+\(0x/u.exec(line)?.[1]
      if (target) libraries.add(target)
    }
  }
  return [...libraries].sort()
}

function copyTree (from, to, { allowMissing = false } = {}) {
  if (!existsSync(from)) {
    if (allowMissing) return false
    throw new Error(`the Node-only root needs ${from}`)
  }
  mkdirSync(dirname(to), { recursive: true })
  execFileSync('cp', ['-a', from, to], { stdio: 'ignore' })
  return true
}

function copyLibrary (library, root) {
  const destination = join(root, library)
  mkdirSync(dirname(destination), { recursive: true })
  execFileSync('cp', ['-L', library, destination], { stdio: 'ignore' })
}

/**
 * Build (or reuse) the private root that holds only what a device needs.
 *
 * The result is verified instead of assumed: the node and the helper are executed inside
 * the root, the helper must answer `info` with the display's own bounds, and no path
 * outside the root exists for either process.
 */
export async function buildNodeOnlyRoot ({ root, display, reuse = true, budgetMs = 600_000, sources = {} }) {
  const plan = nodeOnlyRootPlan(root, sources)
  const marker = join(root, '.loom-node-only.json')
  if (reuse && existsSync(marker)) {
    try {
      const recorded = JSON.parse(readFileSync(marker, 'utf8'))
      if (recorded.planDigest === digestOf(JSON.stringify(plan)) && existsSync(join(root, 'usr/local/bin/loom-node'))) return plan
    } catch { /* rebuild below */ }
  }
  const startedAt = Date.now()
  execFileSync('rm', ['-rf', root])
  for (const directory of plan.directories) mkdirSync(join(root, directory), { recursive: true })
  for (const binary of plan.binaries) {
    const destination = join(root, binary.to)
    mkdirSync(dirname(destination), { recursive: true })
    // `-L`: `/usr/bin/python3` is a symlink to the versioned interpreter in Debian.
    execFileSync('cp', ['-L', binary.from, destination], { stdio: 'ignore' })
    chmodSync(destination, 0o755)
  }
  // Devices are needed by `subprocess.DEVNULL` in the helper's own toolchain and by Node.
  for (const device of plan.devices) {
    const target = join(root, 'dev', device.name)
    if (existsSync(target)) continue
    execFileSync('mknod', ['-m', '666', target, 'c', device.major, device.minor], { stdio: 'ignore' })
  }
  for (const packages of plan.pythonPackages) copyTree(packages, join(root, packages))
  const libraries = lddLibraries(plan.binaries.map(binary => binary.from))
  // The helper loads libX11 for capture and libXtst for synthetic input through ctypes at
  // run time, so `ldd` on the binaries does not see them. Without libXtst a capture still
  // works and every click fails closed as an unknown input, which is exactly the trap this
  // list exists to avoid.
  const x11 = plan.runtimeLibraries
  // Modules loaded through `import` are invisible to `ldd` on the interpreter:
  // `_ctypes` (imported by the helper's ctypes backends) needs libffi, and Pillow needs its
  // image libraries. Every extension that ships with this interpreter is inspected.
  const pillow = lddLibraries(loadableExtensions(['/usr/lib/python3.11/lib-dynload', '/usr/lib/python3/dist-packages/PIL']))
  for (const library of [...new Set([...libraries, ...x11, ...pillow])]) {
    copyLibrary(library, root)
    const soname = join(root, dirname(library), `${basename(library).split('.so')[0]}.so`)
    try { execFileSync('ln', ['-sf', basename(library), soname], { stdio: 'ignore' }) } catch { /* a missing alias only affects find_library, checked below */ }
  }
  // `ctypes.util.find_library` reads the loader cache; rebuild it inside this root only.
  execFileSync('ldconfig', ['-r', root], { stdio: 'ignore' })
  writeFileSync(marker, `${JSON.stringify({ planDigest: digestOf(JSON.stringify(plan)), builtAt: new Date().toISOString() }, null, 2)}\n`)
  const elapsedMs = Date.now() - startedAt
  const verification = await verifyNodeOnlyRoot({ root, display, budgetMs })
  return { ...plan, elapsedMs, verification }
}

/**
 * Run one command inside the private root.
 *
 * The environment is replaced at the `chroot` boundary instead of inside it: the root holds
 * no `env` (and no shell), so a device process can never inherit a Host variable — including
 * the model credential. `input` is the only thing written to the process.
 */
export function runInRoot ({ root, argv, env = {}, input = '', budgetMs = 60_000 }) {
  const completed = spawnSync(CHROOT_BINARY, [root, ...argv], {
    input, encoding: 'utf8', timeout: budgetMs, maxBuffer: 32 * 1024 * 1024, env
  })
  if (completed.status !== 0) {
    throw new Error(`the Node-only root refused ${argv[0]}: ${String(completed.stderr ?? '').slice(-300)}`)
  }
  return completed.stdout
}

/** The helper inside the root, exactly as the node invokes it. */
export function helperInRoot ({ root, display, request, budgetMs = 30_000 }) {
  return runInRoot({ root, argv: ['/usr/bin/python3', '/usr/local/bin/host_desktop.py'], env: { DISPLAY: display }, input: `${JSON.stringify(request)}\n`, budgetMs })
}

async function verifyNodeOnlyRoot ({ root, display, budgetMs }) {
  const deadline = Date.now() + budgetMs
  const node = runInRoot({ root, argv: ['/usr/local/bin/node', '--version'] }).trim()
  const header = helperInRoot({ root, display, request: HELPER_INFO_REQUEST })
  const parsed = JSON.parse(header.split('\n')[0])
  if (parsed.ok !== true) throw new Error(`the helper refused inside the Node-only root: ${header.slice(0, 200)}`)
  return {
    node,
    helperPlatform: parsed.platform,
    helperDeviceId: parsed.deviceId,
    bounds: { width: parsed.screenWidth, height: parsed.screenHeight },
    deadlineMs: Math.max(0, deadline - Date.now())
  }
}

/** One private display for the device, TCP-only so a chroot can reach it. */
export function startXvfb ({ displayNumber, width = 1280, height = 900, logPath }) {
  const display = `${NODE_ONLY_LISTEN}:${displayNumber}`
  const child = spawn('Xvfb', [`:${displayNumber}`, '-screen', '0', `${width}x${height}x24`, '-listen', 'tcp', '-nolisten', 'unix'], { stdio: ['ignore', 'ignore', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000) })
  return {
    display, child, stderr: () => stderr, displayNumber,
    async stop () { try { child.kill('SIGTERM') } catch { /* already gone */ } }
  }
}

export async function waitForDisplay ({ display, budgetMs = 20_000 }) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try {
      execFileSync('xdpyinfo', ['-display', display], { stdio: 'ignore', timeout: 5_000 })
      return true
    } catch { await pause(150) }
  }
  throw new Error(`the private display ${display} never answered`)
}

/** The two dedicated windows the model must find, click and type into. */
export function startDesktopFixture ({ display, directory }) {
  mkdirSync(directory, { recursive: true })
  const clicked = join(directory, 'clicked.txt')
  const typed = join(directory, 'typed.txt')
  // `-print` writes the clicked label to stdout: redirecting it to the fixture's own file is
  // what makes the click a real, readable change instead of something the test assumes.
  const prompt = spawn('sh', ['-c', `exec xmessage -geometry 560x160+360+60 -buttons 'CONFIRM:0,RETRY:1' -print 'LOOM NODE PROMPT CLICK CONFIRM' > ${clicked}`], {
    env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'ignore', 'ignore']
  })
  const terminal = spawn('xterm', ['-geometry', '90x24+60+380', '-T', 'LOOM NODE TERMINAL', '-e', 'sh', '-c', `read line; printf '%s\\n' "$line" > ${typed}; sleep 900`], {
    env: { ...process.env, DISPLAY: display }, stdio: ['ignore', 'ignore', 'pipe']
  })
  return {
    clicked, typed, prompt, terminal,
    output: () => readIfPresentText(clicked),
    async stop () { for (const child of [prompt, terminal]) { try { child.kill('SIGTERM') } catch { /* already gone */ } } }
  }
}

/** Sign in to the isolated Host as its administrator; the token never leaves memory. */
export async function login ({ origin, administratorToken }) {
  const response = await fetch(`${origin}/api/v1/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 5, administratorToken }),
    signal: AbortSignal.timeout(30_000)
  })
  if (!response.ok) throw new Error(`the isolated Host refused the administrator login: ${response.status}`)
  const body = await response.json()
  if (!/^[0-9a-f]{64}$/u.test(String(body.token ?? ''))) throw new Error('the login answered no session token')
  return body.token
}

/** One Core operation through the running Host's own HTTP surface. */
export async function request ({ origin, session, operation, params = {} }) {
  const response = await fetch(`${origin}/api/v1/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
    body: JSON.stringify({ operation, params }),
    signal: AbortSignal.timeout(60_000)
  })
  const body = await response.json().catch(() => null)
  if (body?.error) throw Object.assign(new Error(`${operation}: ${body.error.code ?? 'failed'}`), { code: body.error.code })
  return body?.result ?? null
}

/** The paired-node list is a fixed GET route, not a Core operation. */
export async function listNodes ({ origin, session }) {
  const response = await fetch(`${origin}/api/v1/nodes`, {
    headers: { Authorization: `Bearer ${session}` },
    signal: AbortSignal.timeout(30_000)
  })
  const body = await response.json().catch(() => null)
  if (!response.ok) throw new Error(`nodes list refused: ${response.status}`)
  return Array.isArray(body?.nodes) ? body.nodes : (Array.isArray(body) ? body : [])
}

/** A fixed-route workbench call (computer surfaces are not Core operations). */
export async function workbench ({ origin, session, path, body = {} }) {
  const response = await fetch(`${origin}/api/v1${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}`, Origin: origin },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(45_000)
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(`${path}: ${response.status} ${payload?.error?.code ?? ''}`), { status: response.status, code: payload?.error?.code ?? null })
  return payload
}

/** The paired node that advertises a desktop; never inferred from a device id. */
export function computerNode (nodes) {
  const rows = Array.isArray(nodes) ? nodes : []
  const candidates = rows.filter(node => node?.revocable === true && node?.computer?.advertised === true && node?.status === 'online')
  if (candidates.length !== 1) return { node: null, reason: `computer_nodes:${candidates.length}` }
  return { node: candidates[0], reason: null }
}

/**
 * The stored MCP server this grant created, read back through the same `reveal` the panel
 * uses. `tokenFile` and `digest` are the environment Core itself hands the bridge, so a
 * call made with them is the model's own tool path, not a second implementation.
 */
export function grantServer ({ config, definitionJson }) {
  const servers = Array.isArray(config?.servers) ? config.servers : []
  const names = Object.keys(JSON.parse(definitionJson ?? '{"mcpServers":{}}').mcpServers ?? {})
  const name = names[0]
  if (typeof name !== 'string') throw new Error('the grant stored no MCP server definition')
  const entry = servers.find(server => server.name === name)
  if (!entry) throw new Error('the stored grant server is not in the configuration')
  const env = JSON.parse(definitionJson).mcpServers[name].env ?? {}
  return { serverId: entry.serverId, name, env }
}

export function fixtureRoots (base) {
  return {
    base,
    server: join(base, 'server'),
    workspace: join(base, 'workspace'),
    nodeRoot: join(base, 'node-only-root'),
    nodeData: join(base, 'node-data'),
    desktop: join(base, 'desktop'),
    piAgent: join(base, 'pi-agent'),
    home: join(base, 'home'),
    webUi: join(base, 'web-ui')
  }
}

/** Evidence paths stay inside the caller's run directory. */
export function evidencePaths (root) {
  mkdirSync(root, { recursive: true })
  return {
    root,
    report: join(root, 'report.json'),
    nodeDesktopBefore: join(root, 'node-desktop-before.png'),
    nodeDesktopAfter: join(root, 'node-desktop-after.png'),
    pageConsent: join(root, 'page-consent.png'),
    pageGranted: join(root, 'page-granted.png'),
    pageRevoked: join(root, 'page-revoked.png'),
    pageRun: join(root, 'page-run.png'),
    hostLog: join(root, 'host.log'),
    nodeLog: join(root, 'node.log'),
    bridgeLog: join(root, 'bridge.log')
  }
}

function readIfPresentText (path) {
  try { return readFileSync(path, 'utf8') } catch { return '' }
}

export function readIfPresent (path) {
  try { return readFileSync(path, 'utf8') } catch { return null }
}

export function listDirectory (path) {
  try { return readdirSync(path) } catch { return [] }
}

export function resolveRepositoryPath (environment, fallback) {
  const value = environment?.ROVAI_REPOSITORY
  return typeof value === 'string' && value.trim() !== '' ? resolve(value.trim()) : fallback
}
