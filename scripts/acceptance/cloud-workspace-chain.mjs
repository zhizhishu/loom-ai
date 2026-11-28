// Isolation acceptance for the remote workspace write/read delivery chain.
//
// Launches a real host, configures a Pi member to workspace_workflow, starts the
// Web UI, pairs a device-only loom-node, prepares a remote mission workspace,
// then sends one prompt that writes a real .docx through the managed
// loom.workspace.write/read tools and posts the read-back file as a thread
// attachment. The chain passes only when the remote bytes are exact, the run
// succeeds and the attachment is present in the thread snapshot.
//
// Environment (each path is validated; missing paths fail naming the variable):
//   LOOM_ROVAI_HOST_BIN   default <repo>/target/debug/rovai-host
//   LOOM_NODE_BIN         default <repo>/target/debug/loom-node
//   LOOM_PI_RUNTIME_ROOT  default <repo>/resources/runtime/pi
//   LOOM_PI_CONFIG_DIR    default ~/.pi/agent (models.json source; never printed)
//   LOOM_WEB_UI_DIR       default <repo>/out/web
// Optional:
//   LOOM_OCT_BASE_URL              override the copied oct-chat baseUrl (debugging only)
//   LOOM_WORKSPACE_CHAIN_EVIDENCE  evidence JSON path (default <fixture>/workspace-chain-evidence.json)
//
// Example:
//   LOOM_PI_CONFIG_DIR="$HOME/.pi/agent" node scripts/acceptance/cloud-workspace-chain.mjs
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { cp, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { launchHost } from '../lib/host-test-client.mjs'
import {
  coreDataDirectoryArguments,
  runtimeCampFilesRootForDataDirectory
} from '../lib/runtime-camp-files-root.mjs'

const PROOF_DOCX_SHA256 = '2e29923a4834e160ce1e2f216a540f0857dfeca4f67dff7aa58e0cc2e67e4158'
// The exact bytes of the acceptance document, embedded so this script needs no
// fixture binary on disk. The hash below is asserted before the prompt is built.
const PROOF_DOCX_BASE64 = [
  'UEsDBBQAAAAIAMqse115bjPX6AAAAK0BAAATAAAAW0NvbnRlbnRfVHlwZXNdLnhtbH1QyU7DMBD9FWuuKHHggBCK0wPLETiU',
  'DxjZk8SqN3nc0v49Tlt6QIXjzFv1+tXeO7GjzDYGBbdtB4KCjsaGScHn+rV5AMEFg0EXAyk4EMNq6NeHRCyqNrCCuZT0KCXr',
  'mTxyGxOFiowxeyz1zJNMqDc4kbzrunupYygUSlMWDxj6Zxpx64p42df3qUcmxyCeTsQlSwGm5KzGUnG5C+ZXSnNOaKvyyOHZ',
  'Jr6pBJBXExbk74Cz7r0Ok60h8YG5vKGvLPkVs5Em6q2vyvZ/mys94zhaTRf94pZy1MRcF/euvSAebfjpL49zD99QSwMEFAAA',
  'AAgAyqx7XZv9N+qtAAAAKQEAAAsAAABfcmVscy8ucmVsc43POw7CMAwG4KtE3mlaBoRQ0y4IqSsqB7ASN61oHkrCo7cnAwNF',
  'DIy2f3+W6/ZpZnanECdnBVRFCYysdGqyWsClP232wGJCq3B2lgQsFKFt6jPNmPJKHCcfWTZsFDCm5A+cRzmSwVg4TzZPBhcM',
  'plwGzT3KK2ri27Lc8fBpwNpknRIQOlUB6xdP/9huGCZJRydvhmz6ceIrkWUMmpKAhwuKq3e7yCzwpuarF5sXUEsDBBQAAAAI',
  'AMqse120ub8jqwAAANwAAAARAAAAd29yZC9kb2N1bWVudC54bWxFjsEOgjAQRH+F9C5FD8YQihfxoqQJwXgklVYgobtNW0X+',
  'XooHL2+ymczLZsePHqO3sm5AYGQbJyRS0KIcoGPkVp83BxI5L0CKEUExMitHjnk2pRLbl1bgo0UALp0Y6b03KaWu7ZUWLkaj',
  'YOmeaLXwy2k7OqGVxmKrnFv8eqS7JNlTLQYgQflAOYc0ATbA51fOy6YqSl4XzZ1Xp4ZfMhqKQLvSrPyN6f+x/AtQSwECFAMU',
  'AAAACADKrHtdeW4z1+gAAACtAQAAEwAAAAAAAAAAAAAAgAEAAAAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLAQIUAxQAAAAIAMqs',
  'e12b/TfqrQAAACkBAAALAAAAAAAAAAAAAACAARkBAABfcmVscy8ucmVsc1BLAQIUAxQAAAAIAMqse120ub8jqwAAANwAAAAR',
  'AAAAAAAAAAAAAACAAe8BAAB3b3JkL2RvY3VtZW50LnhtbFBLBQYAAAAAAwADALkAAADJAgAAAAA='
].join('')

const repository = resolve(import.meta.dirname, '..', '..')
const sleep = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds))

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

function configuredPath(variable, fallback) {
  const value = process.env[variable]?.trim()
  return resolve(value ? value : fallback)
}

function requireDirectory(variable, path, purpose) {
  if (!existsSync(path)) {
    throw new Error(`${variable} is not an existing directory: ${path}; set ${variable} to ${purpose}`)
  }
  return path
}

function requireFile(variable, path, purpose) {
  if (!existsSync(path)) {
    throw new Error(`${variable} is not an existing file: ${path}; set ${variable} to ${purpose}`)
  }
  return path
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  await new Promise((done) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
    child.once('close', () => { clearTimeout(timer); done() })
    child.kill('SIGTERM')
  })
}

const proofDocx = Buffer.from(PROOF_DOCX_BASE64, 'base64')
assert.equal(sha256Hex(proofDocx), PROOF_DOCX_SHA256,
  'embedded proof.docx bytes do not match the pinned sha256')

const hostBinary = configuredPath('LOOM_ROVAI_HOST_BIN', join(repository, 'target/debug/rovai-host'))
requireFile('LOOM_ROVAI_HOST_BIN', hostBinary, 'the built rovai-host binary')
const nodeBinary = configuredPath('LOOM_NODE_BIN', join(repository, 'target/debug/loom-node'))
requireFile('LOOM_NODE_BIN', nodeBinary, 'the built loom-node binary')
const piRuntimeRoot = configuredPath('LOOM_PI_RUNTIME_ROOT', join(repository, 'resources/runtime/pi'))
requireDirectory('LOOM_PI_RUNTIME_ROOT', piRuntimeRoot, 'the embedded Pi bundle root')
const piConfigDirectory = configuredPath('LOOM_PI_CONFIG_DIR', join(homedir(), '.pi/agent'))
requireDirectory('LOOM_PI_CONFIG_DIR', piConfigDirectory, 'the Pi profile directory holding models.json')
const webUiDirectory = configuredPath('LOOM_WEB_UI_DIR', join(repository, 'out/web'))
requireDirectory('LOOM_WEB_UI_DIR', webUiDirectory, 'the built Web UI directory (for example <repo>/out/web)')

const fixture = await mkdtemp(join(tmpdir(), 'loom-ws-chain-'))
const dataDirectory = join(fixture, 'core')
const homeDirectory = join(fixture, 'home')
const piDirectory = join(fixture, 'pi-agent')
for (const directory of [dataDirectory, homeDirectory, piDirectory]) await mkdir(directory, { recursive: true })

// Copy the operator's Pi profile into the fixture, then leave it byte-identical
// unless LOOM_OCT_BASE_URL explicitly redirects oct-chat for debugging.
const modelsSource = join(piConfigDirectory, 'models.json')
if (!existsSync(modelsSource)) {
  throw new Error(`LOOM_PI_CONFIG_DIR has no models.json: ${modelsSource}; set LOOM_PI_CONFIG_DIR to the Pi profile directory holding models.json`)
}
await cp(modelsSource, join(piDirectory, 'models.json'))
const settingsSource = join(piConfigDirectory, 'settings.json')
if (existsSync(settingsSource)) await cp(settingsSource, join(piDirectory, 'settings.json'))
const octBaseUrl = process.env.LOOM_OCT_BASE_URL?.trim()
if (octBaseUrl) {
  const modelsPath = join(piDirectory, 'models.json')
  let models
  try {
    models = JSON.parse(readFileSync(modelsPath, 'utf8'))
  } catch {
    // The parse error text can quote the file, so never surface it: it may hold provider keys.
    throw new Error('models.json in LOOM_PI_CONFIG_DIR is not valid JSON; refusing to copy it into the fixture')
  }
  const provider = models.providers?.['oct-chat']
  assert.ok(provider, 'models.json has no oct-chat provider to override with LOOM_OCT_BASE_URL')
  provider.baseUrl = octBaseUrl
  await writeFile(modelsPath, JSON.stringify(models))
}

const runtimeFilesRoot = runtimeCampFilesRootForDataDirectory(dataDirectory, { homeDirectory })
const environment = {
  ...process.env,
  HOME: homeDirectory,
  PI_CODING_AGENT_DIR: piDirectory,
  ROVAI_EMBEDDED_PI_ROOT: piRuntimeRoot,
  PATH: [join(piRuntimeRoot, 'node'), dirname(process.execPath), process.env.PATH].filter(Boolean).join(':')
}
const host = launchHost(hostBinary, [
  ...coreDataDirectoryArguments(dataDirectory, { homeDirectory }),
  '--skill-library-root', join(dataDirectory, 'skills'),
  '--mcp-config-path', join(dataDirectory, 'mcp.json')
], { env: environment, cwd: repository, requestTimeoutMs: 120000 })

let node
try {
  await host.ready
  await host.request('runtime.discovery.rescan', { interactiveShell: false })
  await host.request('runtime.product.check', { runtimeKind: 'pi' })
  const members = await host.request('members.list')
  const agent = members.find((member) => member.presence === 'present') ?? members[0]
  assert.ok(agent, `no member to configure: ${JSON.stringify(members).slice(0, 1000)}`)
  const installations = await host.request('runtime.installations.list')
  const installation = installations.find((item) => item.adapterKind === 'pi' && item.memberRuntimeDefaults)
    ?? installations.find((item) => item.adapterKind === 'pi')
  assert.ok(installation, JSON.stringify(installations).slice(0, 1000))
  const defaults = installation.memberRuntimeDefaults
  const permissions = JSON.parse(JSON.stringify(defaults.permissions))
  permissions.values = { ...(permissions.values ?? {}), loom_file_access: 'workspace_workflow' }
  const current = await host.request('members.get', { agentId: agent.agentId })
  const configured = await host.request('members.runtime.set', {
    commandId: randomUUID(),
    command: {
      agentId: agent.agentId,
      expectedVersion: current.version,
      adapterKind: 'pi',
      model: defaults.model,
      permissions
    }
  })
  assert.equal(configured.status, 'applied', JSON.stringify(configured))

  const web = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory: webUiDirectory })
  const origin = web.origin
  const request = async (path, body, token) => {
    const response = await fetch(origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        Origin: origin,
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    const payload = await response.json().catch(() => null)
    if (!response.ok) throw new Error(`${path} ${response.status} ${JSON.stringify(payload)}`)
    return payload
  }
  const session = (await request('/api/v1/login', {
    protocolVersion: 5,
    administratorToken: web.administratorToken
  })).token
  const pair = await request('/api/v1/nodes/pair', {}, session)

  const localSource = join(fixture, 'local-source')
  const remoteSource = join(fixture, 'remote-source')
  for (const source of [localSource, remoteSource]) {
    await mkdir(source)
    execFileSync('git', ['init', '--initial-branch=main', source])
    execFileSync('git', ['-C', source, 'config', 'user.name', 'LOOM Test'])
    execFileSync('git', ['-C', source, 'config', 'user.email', 'test@invalid'])
    await writeFile(join(source, 'seed.txt'), 'remote workspace seed\n')
    execFileSync('git', ['-C', source, 'add', '.'])
    execFileSync('git', ['-C', source, 'commit', '-m', 'seed'])
  }

  const nodeDataDirectory = join(fixture, 'node')
  await mkdir(nodeDataDirectory)
  node = spawn(nodeBinary, [
    '--data-dir', nodeDataDirectory,
    '--server', `${origin.replace('http:', 'ws:')}/api/v1/nodes/connect`,
    '--device-only',
    '--pair-code-stdin'
  ], { stdio: ['pipe', 'pipe', 'pipe'] })
  let nodeStderr = ''
  node.stderr.on('data', (chunk) => { nodeStderr = (nodeStderr + chunk).slice(-4000) })
  node.stdout.on('data', () => {})
  node.stdin.write(`${pair.pairingCode}\n`)
  node.stdin.end()
  let remoteNode
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const rows = (await request('/api/v1/nodes', undefined, session)).nodes
    remoteNode = rows.find((row) => row.status === 'online' && row.role === 'remote')
    if (remoteNode) break
    if (node.exitCode !== null) throw new Error(`loom-node exited ${node.exitCode}: ${nodeStderr}`)
    await sleep(1000)
  }
  assert.ok(remoteNode, `loom-node did not pair online: ${nodeStderr}`)

  const mission = (await host.request('missions.create', {
    commandId: randomUUID(),
    command: {
      title: 'workspace write chain',
      description: 'placeholder',
      projectPath: localSource,
      projectBindingKind: 'directory',
      memberAgentIds: [agent.agentId],
      defaultLeadAgentId: agent.agentId,
      tags: []
    }
  })).payload
  const prepared = await request('/api/v1/request', {
    operation: 'missions.workspace.prepareRemote',
    params: { missionId: mission.missionId, nodeId: remoteNode.nodeId, sourceRoot: remoteSource }
  }, session)
  assert.equal(prepared.error, null, JSON.stringify(prepared))
  const workspace = prepared.result

  const database = new DatabaseSync(join(dataDirectory, 'rovai.sqlite'), { readOnly: true })
  const readyRows = database.prepare(
    'SELECT id FROM mission_workspace WHERE mission_id=? AND execution_host_id=? AND state=?'
  ).all(mission.missionId, remoteNode.nodeId, 'ready')
  database.close()
  assert.equal(readyRows.length, 1,
    `expected exactly one ready remote mission_workspace row, got ${readyRows.length}`)
  const workspaceId = readyRows[0].id

  const prompt = [
    '隔离验收，真实完成，不要询问。你只使用 rovai_loom 这个受管业务工具完成以下操作，不能用 bash/shell，也不要写本地文件。',
    `1) loom.workspace.write，input 只能包含 path 和 data，不要传 workspaceId：{"path":"remote-proof.docx","data":"${PROOF_DOCX_BASE64}"}`,
    '2) loom.workspace.read，input 只能包含 path/offset/maxBytes，不要传 workspaceId：{"path":"remote-proof.docx","offset":0,"maxBytes":1048576}。成功结果会给你一个 ROVAI_RUN_TMP 下已生成的本地文件绝对路径。',
    '3) thread.message.send，body 简洁报告写入/读回完成，files 必须只包含第 2 步工具返回的那个绝对路径。把 docx 作为群普通附件发出。',
    '完成后停止；不要提交 artifact，不要自造路径，不要把 base64 写进消息正文。'
  ].join('\n')

  const started = await host.request('missions.start', {
    commandId: randomUUID(),
    command: { missionId: mission.missionId }
  })
  assert.equal(started.status, 'accepted', JSON.stringify(started))
  let snapshot
  for (let attempt = 0; attempt < 120; attempt += 1) {
    snapshot = await host.request('threads.snapshot', { threadId: mission.threadId })
    const first = (snapshot.agentRuns ?? [])[0]
    if (first && ['succeeded', 'failed', 'cancelled'].includes(first.status)) break
    await sleep(1000)
  }
  const firstRuns = new Set((snapshot?.agentRuns ?? []).map((run) => run.id))

  const sent = await host.request('thread.messages.send', {
    commandId: randomUUID(),
    threadId: mission.threadId,
    content: { version: 2, segments: [{ kind: 'text', text: prompt }] },
    execution: { purpose: 'Validate remote workspace write/read delivery', completionRole: 'required' }
  })
  assert.equal(sent.commandResult?.status, 'accepted', JSON.stringify(sent))

  let run
  for (let attempt = 0; attempt < 600; attempt += 1) {
    snapshot = await host.request('threads.snapshot', { threadId: mission.threadId })
    run = (snapshot.agentRuns ?? [])
      .find((candidate) => !firstRuns.has(candidate.id)
        && ['succeeded', 'failed', 'cancelled'].includes(candidate.status))
    if (run) break
    await sleep(1000)
  }
  assert.equal(run?.status, 'succeeded', JSON.stringify(run))

  const remoteFile = join(workspace.worktree ?? workspace.path ?? remoteSource, 'remote-proof.docx')
  const remoteBytes = readFileSync(remoteFile)
  assert.equal(sha256Hex(remoteBytes), PROOF_DOCX_SHA256,
    `remote bytes mismatch at ${remoteFile}; workspace=${JSON.stringify(workspace)}`)
  assert.equal(remoteBytes.toString('base64'), PROOF_DOCX_BASE64,
    `remote bytes mismatch at ${remoteFile}; workspace=${JSON.stringify(workspace)}`)

  const snapshotText = JSON.stringify(snapshot)
  assert.match(snapshotText, /remote-proof|loom-read-|docx/)
  const attachments = []
  const collect = (value) => {
    if (Array.isArray(value)) value.forEach(collect)
    else if (value && typeof value === 'object') {
      if (value.attachments) attachments.push(...value.attachments)
      Object.values(value).forEach(collect)
    }
  }
  collect(snapshot)
  assert.ok(attachments.length > 0, `no attachment in the thread snapshot: ${snapshotText.slice(-2000)}`)
  const attachment = attachments.find((candidate) => /docx/i.test(JSON.stringify(candidate)))
    ?? attachments[attachments.length - 1]

  const evidencePath = resolve(
    process.env.LOOM_WORKSPACE_CHAIN_EVIDENCE?.trim()
      || join(fixture, 'workspace-chain-evidence.json')
  )
  await mkdir(dirname(evidencePath), { recursive: true })
  const evidence = {
    fixture,
    evidencePath,
    configuration: {
      repository,
      hostBinary,
      nodeBinary,
      piRuntimeRoot,
      piConfigDirectory,
      webUiDirectory,
      runtimeFilesRoot,
      octBaseUrlOverride: Boolean(octBaseUrl)
    },
    mission,
    workspace,
    workspaceId,
    nodeId: remoteNode.nodeId,
    runId: run.id,
    status: run.status,
    attachment,
    remoteFile,
    remoteSha256: PROOF_DOCX_SHA256,
    snapshotTail: snapshotText.slice(-3000)
  }
  await writeFile(evidencePath, JSON.stringify(evidence, null, 2))
  console.log(JSON.stringify({
    ok: true,
    evidencePath,
    runId: run.id,
    attachment,
    remoteFile,
    workspaceId,
    missionId: mission.missionId,
    nodeId: remoteNode.nodeId,
    fixture
  }, null, 2))
} finally {
  await stopChild(node)
  await host.close().catch(() => {})
}
