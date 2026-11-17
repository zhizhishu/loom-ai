// Real local-model Run -> remote device-only Node. No synthetic Run or forged Grant.
// Model credentials stay in the Windows Host; only a single-use Node pairing code
// crosses the authorized Komari channel. This is a service-triggered fixture, not UI sign-off.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { randomBytes, randomUUID, createHash } from 'node:crypto'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { prepareLivePiHost } from './lib/loom-live-pi-host.mjs'
import { verifyArchivedArtifact, redactDeep } from './accept-loom-live-lead.mjs'
import { terminalReceipt } from './lib/komari-terminal-receipt.mjs'
const exec = promisify(execFile)
const repo = resolve(import.meta.dirname, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
const digest = value => createHash('sha256').update(value).digest('hex')
const token = process.env.LOOM_E4_PROVIDER_KEY
assert.equal(process.env.LOOM_ALLOW_LIVE_ACCEPTANCE, '1', 'explicit live acceptance opt-in required')
assert.ok(token, 'authorized model environment credential is required')
const suffix = randomBytes(5).toString('hex')
const out = resolve(process.env.LOOM_DEVICE_EVIDENCE_ROOT ?? join(repo, '_artifacts', 'device-live', suffix))
await mkdir(out, { recursive: false })
const python = process.env.LOOM_AB_PYTHON ?? 'python'
const komari = 'C:/Users/echo/.claude/skills/komari-ssh/scripts/komari_ssh_cli.py'
const cloudflared = 'C:/Users/echo/.local/bin/cloudflared.exe'
const remoteBase = `/root/sandbox/projects/loom-delivery-20261116/device-model-${suffix}`
const containerName = `loom-device-model-${suffix}`
const report = { scope: 'real model Run using remote DevicePort, with Node reconnection',
  trigger: 'service', uiExercised: false, runtimeOnRemoteNode: false, forgedRunOrGrant: false,
  modelCredentialSentToRemote: false, ownerReviewRecorded: false, status: 'running', steps: [], suffix }
const secrets = [token]
let prepared, tunnel, remoteCreated = false
function step(stage, facts = {}) { report.steps.push({ stage, ...facts }); console.log(JSON.stringify({ deviceAcceptance: stage, ...facts })) }
async function request(origin, path, body, session) {
  const response = await fetch(origin + path, { method: body === undefined ? 'GET' : 'POST',
    redirect: 'error', signal: AbortSignal.timeout(60000),
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(session ? { Authorization: `Bearer ${session}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const result = await response.json().catch(() => null)
  if (!response.ok) throw Object.assign(new Error(`owned endpoint ${path} refused ${response.status}`), { status: response.status, code: result?.error?.code })
  return result
}
async function komariReadOrWrite(command) {
  // The call is submitted ONCE. Pending/unknown results are read by job id, never resubmitted.
  const invoke = async args => {
    let result
    try { result = await exec(python, [komari, ...args], { cwd: repo, env: { ...process.env, PYTHONIOENCODING: 'utf-8' }, timeout: 240000, maxBuffer: 4 * 1024 * 1024 }) }
    catch (error) {
      if (typeof error.stdout !== 'string' || !error.stdout.trim()) throw new Error('Komari outcome unconfirmed; command not replayed')
      result = error
    }
    try { return JSON.parse(result.stdout) } catch { throw new Error('Komari result unreadable; command not replayed') }
  }
  let receipt = await invoke(['run', '--host', 'bero', '--command', command, '--i-confirm-exec'])
  let terminal = terminalReceipt(receipt)
  const taskId = terminal.taskId
  const deadline = Date.now() + 240000
  while (terminal.state === 'waiting' && taskId && Date.now() < deadline) {
    await sleep(1500)
    receipt = await invoke(['result', '--job', taskId, '--regrant'])
    terminal = terminalReceipt(receipt, taskId)
  }
  const row = receipt.results?.[0]
  report.remoteActions ??= []
  report.remoteActions.push({ taskId, state: terminal.state, exitCode: terminal.exitCode ?? null,
    outputBytes: Buffer.byteLength(String(row?.output ?? '')), reason: terminal.reason ?? null })
  if (terminal.state !== 'succeeded') {
    throw new Error(`owned remote action not confirmed: ${terminal.state} / ${terminal.exitCode ?? 'unknown'}; job=${taskId ?? 'unconfirmed'}`)
  }
  const lines = String(row.output ?? '').trim().split(/\r?\n/u)
  const line = lines.findLast(text => text.startsWith('LOOM_PROOF '))
  return line ? JSON.parse(line.slice('LOOM_PROOF '.length)) : { completed: true }
}
async function waitFor(fn, budget, message) {
  const deadline = Date.now() + budget
  while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(1000) }
  throw new Error(message)
}
try {
  prepared = await prepareLivePiHost({ configPath: process.env.LOOM_UI_PUBLIC_CONFIG, providerKey: token })
  const { host, roles } = prepared
  report.fixture = prepared.evidence
  secrets.push(prepared.adminToken)
  step('isolated_windows_host_ready')
  const tunnelHome = join(prepared.evidence.fixture, 'tunnel-home')
  await mkdir(tunnelHome)
  const tunnelConfig = join(tunnelHome, 'config.yaml'); await writeFile(tunnelConfig, '{}\n')
  const cloudEnv = Object.fromEntries(['SystemRoot','windir','SystemDrive','ComSpec','PATHEXT','PATH','ProgramData'].filter(k => process.env[k]).map(k => [k, process.env[k]]))
  Object.assign(cloudEnv, { HOME: tunnelHome, USERPROFILE: tunnelHome, NO_PROXY: '127.0.0.1,localhost' })
  tunnel = spawn(cloudflared, ['tunnel', '--config', tunnelConfig, '--no-autoupdate', '--protocol', 'http2', '--url', prepared.origin],
    { env: cloudEnv, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
  let tunnelText = '', tunnelError = null
  tunnel.once('error', error => { tunnelError = error.code ?? 'spawn_failed' })
  for (const stream of [tunnel.stdout, tunnel.stderr]) stream.on('data', chunk => { tunnelText = (tunnelText + chunk.toString()).slice(-16000) })
  const publicOrigin = await waitFor(() => {
    if (tunnelError || tunnel.exitCode !== null) throw new Error('owned TLS tunnel failed to start')
    return tunnelText.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/u)?.[0]
  }, 90000, 'owned TLS origin was not confirmed')
  const listen = new URL(prepared.origin).host
  await host.request('host.web.stop')
  const web = await host.request('host.web.start', { listen, publicOrigin, uiDirectory: prepared.evidence.uiDirectory })
  assert.equal(web.origin, prepared.origin)
  const admin = web.administratorToken; secrets.push(admin)
  const session = (await request(prepared.origin, '/api/v1/login', { protocolVersion: 5, administratorToken: admin })).token
  secrets.push(session)
  const pair = await request(prepared.origin, '/api/v1/nodes/pair', {}, session)
  assert.ok(pair.pairingCode); secrets.push(pair.pairingCode)
  const nonce = randomBytes(24).toString('hex')
  const remoteText = `LOOM_DEVICE_PROOF=${nonce}\nRead through an authorized remote Workspace RPC.\n`
  const cfg = { root: remoteBase, container: containerName, server: publicOrigin.replace('https:', 'wss:') + '/api/v1/nodes/connect',
    pairingCode: pair.pairingCode, content: remoteText }
  const encoded = Buffer.from(JSON.stringify(cfg)).toString('base64')
  const remoteSetup = `# Owned LOOM acceptance only. No provider/model credential is included.\n# The short-lived code is consumed by native Node stdin and never printed.\n# Existing containers, unrelated volumes and user workspaces are not modified.\npython3 - <<'PY'\nimport json,base64,subprocess,hashlib,os,time,shutil\nfrom pathlib import Path\nc=json.loads(base64.b64decode('${encoded}'))\nr=Path(c['root']);r.mkdir(mode=0o700,exist_ok=False)\nfor n in ['node','bootstrap','source','bin']:\n p=r/n;p.mkdir(mode=0o700);os.chown(p,0 if n=='source' else 10001,0 if n=='source' else 10001)\nb=Path('/root/sandbox/projects/loom-personal-delivery-20261116/target/debug/loom-node')\nh=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()\nbefore=h(b);shutil.copy2(b,r/'bin/loom-node');assert h(r/'bin/loom-node')==before==h(b);os.chmod(r/'bin/loom-node',0o555)\nsource=r/'source';(source/'device-proof.txt').write_bytes(c['content'].encode());(source/'.gitattributes').write_text('* -text\\n')\nsubprocess.run(['git','init','--initial-branch=main',str(source)],check=True,stdout=subprocess.DEVNULL)\nsubprocess.run(['git','-C',str(source),'add','--','.gitattributes','device-proof.txt'],check=True)\nsubprocess.run(['git','-C',str(source),'-c','user.name=LOOM Test','-c','user.email=test@invalid','-c','commit.gpgsign=false','commit','-m','Add isolated RPC proof'],check=True,stdout=subprocess.DEVNULL)\nfor p in [source,*source.rglob('*')]:os.chown(p,10001,10001)\nsecret=r/'bootstrap/pair-code';fd=os.open(secret,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)\nwith os.fdopen(fd,'w') as f:f.write(c['pairingCode']+'\\n')\nos.chown(secret,10001,10001)\nentry='command -v curl >/dev/null || { echo missing_container_curl >&2; exit 72; }; origin="https://\${LOOM_SERVER#wss://}"; origin="\${origin%/api/v1/nodes/connect}/"; deadline=$(( $(date +%s) + 100 )); until curl --noproxy "*" --connect-timeout 5 --max-time 10 -fsS -o /dev/null "$origin" 2>/dev/null; do if test "$(date +%s)" -ge "$deadline"; then echo public_tunnel_readiness_timeout >&2; exit 73; fi; sleep 2; done; if test -f /data/node.json; then exec /opt/loom-node --data-dir /data --server "$LOOM_SERVER" --device-only; else exec /opt/loom-node --data-dir /data --server "$LOOM_SERVER" --device-only --pair-code-stdin < /bootstrap/pair-code; fi'\nsubprocess.run(['docker','run','-d','--name',c['container'],'--label','loom.task=delivery-20261117','--runtime=runc','--user','10001:10001','--cpus=1','--memory=1g','--pids-limit=128','--cap-drop','ALL','--security-opt=no-new-privileges','--read-only','--tmpfs','/tmp:rw,nosuid,nodev,size=128m','-v',str(r/'node')+':/data','-v',str(source)+':/fixture-source','-v',str(r/'bootstrap')+':/bootstrap:ro','-v',str(r/'bin/loom-node')+':/opt/loom-node:ro','-e','LOOM_SERVER='+c['server'],'rust:1.99.1-bookworm','sh','-c',entry],check=True,stdout=subprocess.DEVNULL)\ndeadline=time.monotonic()+180\nwhile time.monotonic()<deadline:\n p=r/'node/node.json'\n if p.is_file():\n  n=json.loads(p.read_text());secret.unlink();print('LOOM_PROOF '+json.dumps({'nodeId':n['nodeId'],'binarySha256':before,'sourceSha256':h(source/'device-proof.txt'),'sourceBytes':len(c['content'].encode()),'deviceOnly':True}));break\n time.sleep(1)\nelse:raise RuntimeError('native Node pairing not confirmed; no secret printed')\nPY`
  remoteCreated = true
  const node = await komariReadOrWrite(remoteSetup)
  assert.ok(node.nodeId && node.sourceSha256 === digest(remoteText))
  report.node = node; report.remoteRoot = remoteBase
  const listNodes = async () => (await request(prepared.origin, '/api/v1/nodes', undefined, session)).nodes
  await waitFor(async () => (await listNodes()).find(n => n.nodeId === node.nodeId && n.status === 'online'), 120000, 'paired device did not become online')
  step('remote_device_paired', { nodeId: node.nodeId, modelCredentialSent: false })
  const creation = await host.request('missions.create', { commandId: randomUUID(), command: {
    title: `DevicePort acceptance ${suffix}`, description: 'Real scoped workspace requests; no Owner acceptance.',
    projectPath: '', projectBindingKind: 'quick_chat', memberAgentIds: [roles.lead.agentId], defaultLeadAgentId: roles.lead.agentId, tags: [] } })
  assert.equal(creation.status, 'applied')
  const { missionId, threadId } = creation.payload
  report.missionId = missionId; report.threadId = threadId
  const workspace = await request(prepared.origin, '/api/v1/nodes/workspaces', {
    missionId, campId: threadId, nodeId: node.nodeId, source: '/fixture-source'
  }, session)
  assert.equal(workspace.nodeId, node.nodeId, 'the prepared workspace must actually belong to this remote node')
  const targets = await host.request('members.executionTarget.get', { memberId: roles.lead.agentId })
  const eligible = targets.availableWorkspaces.filter(row => row.missionId === missionId && row.nodeId === node.nodeId)
  assert.equal(eligible.length, 1, 'exactly one authorized remote workspace is required')
  const workspaceId = eligible[0].workspaceId
  assert.match(workspaceId, /^ws_[A-Za-z0-9]+$/u)
  report.workspace = { ...workspace, workspaceId }
  // Bind a real user goal through the normal command; no direct DB mutation or privileged tool shim.
  const goal = `这是本次用户明确授权的隔离跨机验收。你是本工作的唯一负责人/执行者。请先用 rovai loom 自己建立一个分配给自己的单任务计划，验收要求是从远端工作区读取真实文件、在当前本地工作目录保存逐字节相同的副本、登记成果并提交待用户审核的 Candidate，不要代用户接受。远端 workspaceId=${workspaceId}。使用 rovai workspace list --workspace-id ${workspaceId}，再用 rovai workspace read --workspace-id ${workspaceId} --path device-proof.txt（需要时 poll 回执里的 wrpc_ requestId，不能自造；只有 completed 的归档字节可信）。远端文件内容未在本提示中提供。将读取内容原样保存成本地 device-proof-collected.txt；不要重新生成 nonce，不改换行。登记它前按正式流程 release/claim 自己的任务并保留 fence。现在还要验证设备恢复：第一次真实读取成功后，写本地 device-recovery-ready.txt 仅一行 READY，然后通过 bash sleep 90 等待主管停止并重启这个远端设备；这期间别结束 Run。等待后用 rovai workspace run --workspace-id ${workspaceId} --tool-id git.status，再独立 read 同一文件，确认内容和第一次一致。不得用其它服务器或本地同名文件替代远端调用；工具拒绝/未知不能说成功。最后用 rovai loom evidence 登记本地 device-proof-collected.txt 并 submit 真 Candidate，保留 PENDING，不调用用户 review。汇报两次 read 和 git.status 的真实 requestId/状态。`
  const mission = await host.request('missions.get', { missionId })
  const update = await host.request('missions.update', { commandId: randomUUID(), command: {
    missionId, expectedDetailsVersion: mission.detailsVersion, title: mission.title, description: goal, tags: []
  } })
  assert.equal(update.status, 'applied')
  const started = await host.request('missions.start', { commandId: randomUUID(), command: { missionId } })
  // A fresh start admits a Delivery asynchronously. The real Core contract is
  // accepted/mission.started, not a claim that execution has already applied.
  assert.equal(started.status, 'accepted')
  assert.equal(started.code, 'mission.started')
  assert.equal(started.payload?.missionId, missionId)
  assert.ok(Array.isArray(started.payload?.deliveryIds) && started.payload.deliveryIds.length > 0)
  step('real_model_run_started', { missionId })
  const localWorkspace = join(prepared.evidence.dataDir, 'quick-chat')
  await waitFor(async () => {
    try { return (await readFile(join(localWorkspace, 'device-recovery-ready.txt'), 'utf8')).trim() === 'READY' } catch { return false }
  }, 600000, 'model did not produce the recovery readiness marker')
  const before = await host.request('threads.snapshot', { threadId })
  assert.ok(before.agentRuns.some(r => r.status === 'running'), 'a real model Run must still be active at interruption')
  await komariReadOrWrite(`docker stop -t 20 ${containerName} >/dev/null; printf 'LOOM_PROOF {"stopped":true}\\n'`)
  await waitFor(async () => (await listNodes()).find(n => n.nodeId === node.nodeId && n.status === 'offline'), 60000, 'remote disconnection was not observed')
  step('node_offline_during_actual_run')
  await komariReadOrWrite(`docker start ${containerName} >/dev/null; printf 'LOOM_PROOF {"restarted":true}\\n'`)
  await waitFor(async () => (await listNodes()).find(n => n.nodeId === node.nodeId && n.status === 'online'), 120000, 'same Node identity did not reconnect')
  step('same_node_identity_reconnected')
  const final = await waitFor(async () => {
    const s = await host.request('threads.snapshot', { threadId })
    if (s.agentRuns.some(r => ['failed','cancelled'].includes(r.status))) throw new Error('a real model Run failed')
    const c = await host.request('loom.candidates.list', { missionId })
    return c.length > 0 && s.agentRuns.every(r => r.status === 'succeeded') ? { snapshot: s, candidates: c } : null
  }, 600000, 'model did not submit a completed candidate after reconnection')
  const artifacts = await host.request('loom.artifacts.list', { missionId })
  const rows = Array.isArray(artifacts) ? artifacts : artifacts.artifacts
  const artifact = rows.find(a => a.relativePath === 'device-proof-collected.txt')
  assert.ok(artifact && artifact.sha256 === node.sourceSha256)
  const checked = verifyArchivedArtifact({ registered: artifact,
    preview: await host.request('loom.artifact.preview', { missionId, artifactId: artifact.artifactId }) })
  assert.ok(checked.ok && digest(checked.text) === node.sourceSha256)
  assert.deepEqual(await host.request('loom.reviews.list', { missionId }), [])
  assert.ok(final.candidates.every(c => c.acceptanceStatus === 'pending'))
  report.artifact = { id: artifact.artifactId, sha256: artifact.sha256, bytes: artifact.sizeBytes,
    provenance: 'local Run collected exact remote Workspace RPC bytes; not remote-runtime artifact registration' }
  report.runs = final.snapshot.agentRuns.map(r => ({ id: r.id, agentId: r.agentId, status: r.status }))
  report.candidates = final.candidates.map(c => ({ id: c.candidateId, acceptanceStatus: c.acceptanceStatus }))
  report.status = 'passed'
  step('exact_remote_bytes_archived_as_pending_artifact')
} catch (error) {
  report.status = 'failed'; report.error = { name: error.name, code: error.code ?? null, message: String(error.message).slice(0,1600) }
  process.exitCode = 1
} finally {
  if (remoteCreated) {
    try { await komariReadOrWrite(`docker stop -t 20 ${containerName} >/dev/null; printf 'LOOM_PROOF {"ownedNodeStopped":true}\\n'`); report.remoteNodeStopped = true }
    catch { report.remoteNodeStopped = false }
  }
  if (tunnel && tunnel.exitCode === null) tunnel.kill()
  if (prepared) { try { await prepared.host.close(); report.hostStopped = true } catch { report.hostStopped = false } }
  await writeFile(join(out, 'report.json'), JSON.stringify(redactDeep(report,secrets),null,2)+'\n')
  console.log(JSON.stringify({ deviceAcceptance: report.status, evidence: out, error: redactDeep(report.error,secrets) }))
}
