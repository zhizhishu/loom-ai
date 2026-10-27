// Research: unpatched official ACP + native plugin, one shared disposable Home.
// This deliberately does NOT grant CLI authority: no native execution -> Core Run
// binding has been established. Prompt labels drive the loopback model only.
// Usage: node <script> <unmodified-hermes-source> <prepared-python>
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn, execFileSync} from 'node:child_process'
import {createInterface} from 'node:readline'
import {mkdtemp, mkdir, readFile, writeFile, rename, cp, realpath} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, dirname, isAbsolute} from 'node:path'
import {fileURLToPath} from 'node:url'
import {createHash, randomUUID} from 'node:crypto'
import {parse as parseYaml, stringify as stringifyYaml} from 'yaml'

const [officialSource, executable] = process.argv.slice(2)
assert([officialSource, executable].every(p => p && isAbsolute(p)))
const root = await realpath(await mkdtemp(join(tmpdir(), 'rovai-hermes-middleware-')))
const nativeHome = join(root, '.hermes'), project = join(root, 'project')
await mkdir(nativeHome, {mode: 0o700}); await mkdir(project)
await mkdir(join(root, 'shell-home')); await mkdir(join(root, 'no-authority'), {mode: 0o700})
const nativeSource = join(root, 'hermes-agent')
execFileSync('git', ['clone', '--shared', '--no-hardlinks', officialSource, nativeSource], {stdio: 'pipe'})
const nativeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: nativeSource, encoding: 'utf8'}).trim()
// Same-version ignored release metadata only; tracked upstream code stays clean.
await cp(join(officialSource, 'install-stamp.json'), join(nativeSource, 'install-stamp.json'))
const bootstrap = `import sys; sys.path.insert(0, ${JSON.stringify(nativeSource)}); sys._hermes_pin_default_home = True; import hermes_bootstrap; `
const nativeArgs = ['-I', '-B', '-c', bootstrap + "import runpy; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)"]
await mkdir(join(nativeHome, 'plugins'))
await cp(join(dirname(fileURLToPath(import.meta.url)), 'middleware-probe-plugin'),
  join(nativeHome, 'plugins', 'rovai-middleware-probe'), {recursive: true})
const sh = value => "'" + value.replaceAll("'", "'\\''") + "'"
const now = () => Number(process.hrtime.bigint())
const exists = async path => {try {await readFile(path); return true} catch {return false}}
const alive = child => child && child.exitCode === null && child.signalCode === null
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const plans = new Map(), counts = new Map(), generatedCalls = new Map()
const wire = [], clients = [], steps = [], configHistory = []
let fault, gateway, gatewayLog = ''
async function state(mode = 'observe', marker_sessions = []) {
  await writeFile(join(root, 'probe-state.tmp'), JSON.stringify({mode, marker_sessions}), {mode: 0o600})
  await rename(join(root, 'probe-state.tmp'), join(root, 'probe-state.json'))
}
await state()
async function observations() {
  try {return (await readFile(join(root, 'observations.jsonl'), 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)}
  catch (error) {if (error.code === 'ENOENT') return []; throw error}
}
async function until(fn, timeout = 60000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (fault) throw fault
    const value = await fn(); if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw Error('Fixture deadline exceeded')
}
const textItem = text => ({id: randomUUID(), type: 'message', role: 'assistant', status: 'completed',
  content: [{type: 'output_text', text, annotations: []}]})
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') {
      res.writeHead(200, {'content-type': 'application/json'})
      res.end(JSON.stringify({object: 'list', data: [{id: 'middleware-probe', object: 'model'}]})); return
    }
    const parts = []; for await (const part of req) parts.push(part)
    const body = JSON.parse(Buffer.concat(parts).toString()); wire.push(body)
    if (!Array.isArray(body.input)) {res.end('{}'); return}
    const name = [...JSON.stringify(body.input).matchAll(/MIDDLEWARE_PROBE:([a-z0-9_-]+)/g)].at(-1)?.[1]
    const nth = counts.get(name) ?? 0; counts.set(name, nth + 1)
    const args = plans.get(name)?.[nth]
    const item = args ? {id: randomUUID(), type: 'function_call', call_id: randomUUID(),
      name: 'terminal', arguments: JSON.stringify(args), status: 'completed'} : textItem('Completed.')
    if (args) generatedCalls.set(name, [...(generatedCalls.get(name) ?? []), item.call_id])
    const id = 'response-' + randomUUID()
    const response = {id, object: 'response', status: 'completed', output: [item],
      usage: {input_tokens: 50, output_tokens: 10, total_tokens: 60}}
    if (!body.stream) {res.writeHead(200, {'content-type': 'application/json'}); res.end(JSON.stringify(response)); return}
    res.writeHead(200, {'content-type': 'text/event-stream'}); let sequence = 0
    const emit = event => res.write('data: ' + JSON.stringify({...event, sequence_number: sequence++}) + '\n\n')
    emit({type: 'response.created', response: {id, status: 'in_progress', output: []}})
    emit({type: 'response.output_item.added', output_index: 0, item})
    if (item.type === 'message') emit({type: 'response.output_text.delta', output_index: 0,
      content_index: 0, item_id: item.id, delta: item.content[0].text})
    emit({type: 'response.output_item.done', output_index: 0, item})
    emit({type: 'response.completed', response}); res.end()
  } catch (error) {fault = error; res.writeHead(500); res.end()}
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const config = {
  model: {provider: 'fixture', default: 'middleware-probe'},
  providers: {fixture: {base_url: `http://127.0.0.1:${server.address().port}/v1`,
    api_key_env: 'HERMES_NATIVE_PROBE_KEY', transport: 'codex_responses', models: ['middleware-probe']}},
  updates: {check: false}, platform_toolsets: {acp: ['terminal', 'no_mcp']},
  agent: {max_turns: 8}, session_title: {enabled: false}, compression: {enabled: false},
  terminal: {backend: 'local', persistent_shell: true},
  plugins: {enabled: [], disabled: [], entries: {'rovai-middleware-probe': {settings: {probe_root: root}}}},
}
await writeFile(join(nativeHome, 'config.yaml'), JSON.stringify(config), {mode: 0o600})
await writeFile(join(nativeHome, '.env'), 'PROBE_SENTINEL=unchanged\n', {mode: 0o600})
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !key.startsWith('ROVAI_') && !key.startsWith('HERMES_')))
Object.assign(env, {HOME: join(root, 'shell-home'), HERMES_HOME: nativeHome,
  HERMES_DISABLE_LAZY_INSTALLS: '1', HERMES_NATIVE_PROBE_KEY: 'loopback-only',
  PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin', SHELL: '/bin/bash'})
function runCli(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [...nativeArgs, '--profile', 'default', ...args], {cwd: project, env, stdio: ['ignore', 'pipe', 'pipe']})
    let output = ''; child.stdout.on('data', d => output += d); child.stderr.on('data', d => output += d)
    const timer = setTimeout(() => child.kill('SIGTERM'), 45000)
    child.on('error', reject); child.on('close', code => {
      clearTimeout(timer); code === 0 ? resolve(output) : reject(Error(`Native CLI exited ${code}: ${output}`))
    })
  })
}
async function configSnapshot(stage) {
  const raw = await readFile(join(nativeHome, 'config.yaml'))
  const value = parseYaml(raw.toString())
  configHistory.push({stage, sha256: hash(raw), plugins: value.plugins, topLevelKeys: Object.keys(value).sort()})
  return hash(raw)
}
async function selectPlugin(enabled) {
  // Explicit fixture setup through documented native plugins.enabled/disabled.
  // Avoid PM install operations against a shared dependency cache. The first
  // exploratory run separately exercised the stock `hermes plugins enable` CLI.
  const path = join(nativeHome, 'config.yaml'), value = parseYaml(await readFile(path, 'utf8'))
  value.plugins.enabled = enabled ? ['rovai-middleware-probe'] : []
  value.plugins.disabled = enabled ? [] : ['rovai-middleware-probe']
  await writeFile(path, stringifyYaml(value), {mode: 0o600})
  const code = bootstrap + "import json; from pathlib import Path; from gateway.control_socket import reload_gateway_plugins; print(json.dumps(reload_gateway_plugins(Path(" + JSON.stringify(nativeHome) + "))))"
  return JSON.parse(execFileSync(executable, ['-I', '-B', '-c', code], {cwd: project, env, encoding: 'utf8', timeout: 40000}))
}
async function acp(label) {
  const child = spawn(executable, [...nativeArgs, '--profile', 'default', 'acp'], {cwd: project, env, stdio: ['pipe', 'pipe', 'pipe']})
  const events = [], pending = new Map(); let id = 0, stderr = ''
  child.stderr.on('data', d => stderr += d)
  const closed = new Promise(resolve => child.once('close', (code, signal) => {
    for (const p of pending.values()) {clearTimeout(p.timer); p.reject(Error('ACP closed'))}
    pending.clear(); resolve({code, signal})
  }))
  createInterface({input: child.stdout}).on('line', line => {
    let message; try {message = JSON.parse(line)} catch {return}
    events.push({at: now(), direction: 'in', message})
    if (message.method && message.id !== undefined) {
      const result = message.method === 'session/request_permission' ?
        {result: {outcome: {outcome: 'selected', optionId: message.params.options.find(o => o.kind === 'allow_once')?.optionId}}} :
        {error: {code: -32601, message: 'Unsupported fixture request'}}
      child.stdin.write(JSON.stringify({jsonrpc: '2.0', id: message.id, ...result}) + '\n'); return
    }
    const p = pending.get(message.id); if (!p) return
    pending.delete(message.id); clearTimeout(p.timer)
    message.error ? p.reject(Error(JSON.stringify(message.error))) : p.resolve(message.result)
  })
  const client = {label, child, events, get stderr() {return stderr},
    request(method, params = {}) {return new Promise((resolve, reject) => {
      const requestId = ++id, timer = setTimeout(() => {
        pending.delete(requestId); reject(Error(`ACP timeout: ${method}`))
      }, 90000)
      pending.set(requestId, {resolve, reject, timer})
      const message = {jsonrpc: '2.0', id: requestId, method, params}
      events.push({at: now(), direction: 'out', message}); child.stdin.write(JSON.stringify(message) + '\n')
    })},
    async close() {if (!alive(child)) return; child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGTERM'), 3000)
      const result = await closed; clearTimeout(timer); return result
    },
  }
  clients.push(client)
  await client.request('initialize', {protocolVersion: 1, clientCapabilities: {},
    clientInfo: {name: 'rovai-middleware-research', version: '0.1'}})
  return client
}
async function prompt(client, sid, name, commands) {
  plans.set(name, commands.map(command => typeof command === 'string' ? {command} : command))
  const start = now(), result = await client.request('session/prompt', {
    sessionId: sid, prompt: [{type: 'text', text: 'MIDDLEWARE_PROBE:' + name}],
  })
  assert.equal(result.stopReason, 'end_turn')
  steps.push({name, client: client.label, session: sid, start, end: now(), result,
    fixtureToolIds: generatedCalls.get(name) ?? []})
  return steps.at(-1)
}
const recordEnvironment = name => 'python3 -c ' + sh(
  `import json,os,pathlib; pathlib.Path(${JSON.stringify(join(root, name + '.json'))}).write_text(json.dumps({**{k:os.environ.get(k) for k in ['ROVAI_MIDDLEWARE_PROBE','ROVAI_CLI_CONTEXT','ROVAI_AGENT_CLI','ROVAI_RUN_TMP','PROBE_ORIGINAL_EXPORT','PATH']},'cwd':os.getcwd()}))`)
const readEnvironment = async name => JSON.parse(await readFile(join(root, name + '.json'), 'utf8'))
const report = {scope: 'authority-free plugin feasibility; not Core Run qualification',
  officialVersion: null, nativeCommit, pluginVersion: '0.1.0', backend: 'local', shell: '/bin/bash',
  checks: {}, sessions: {}, steps, limitations: ['No trusted native execution -> Rovai Run binding; no live CLI credentials supplied.']}
console.log(JSON.stringify({fixture: root, nativeHome, project, channel: 'isolated automatic acceptance'}))
try {
  report.officialVersion = (await runCli(['--version'])).trim()
  await configSnapshot('before_gateway')
  gateway = spawn(executable, [...nativeArgs, '--profile', 'default', 'gateway', 'run', '--quiet'],
    {cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']})
  gateway.stderr.on('data', d => gatewayLog += d); gateway.stdout.on('data', d => gatewayLog += d)
  await until(async () => {
    if (!alive(gateway)) throw Error(gatewayLog)
    try {return JSON.parse(await readFile(join(nativeHome, 'gateway.lock'), 'utf8')).pid === gateway.pid} catch {return false}
  })
  report.gatewayPid = gateway.pid
  const a = await acp('a'), b = await acp('b'), viewer = await acp('idle-viewer')
  const session = async client => (await client.request('session/new', {cwd: project, mcpServers: []})).sessionId
  const sa = await session(a), sb = await session(b); report.sessions = {a: sa, b: sb}
  await viewer.request('session/load', {sessionId: sa, cwd: project, mcpServers: []})
  for (const [client, sid] of [[a, sa], [b, sb]]) await client.request('session/set_mode', {sessionId: sid, modeId: 'dont_ask'})
  await prompt(a, sa, 'disabled', [recordEnvironment('disabled')])
  assert.equal((await readEnvironment('disabled')).ROVAI_CLI_CONTEXT, null)
  assert.equal((await observations()).filter(r => r.phase === 'tool_request').length, 0)
  report.checks.filesAloneDoNotActivatePlugin = true
  const beforeEnable = await configSnapshot('before_enable')
  report.enableOutput = await selectPlugin(true)
  const afterEnable = await configSnapshot('after_enable')
  assert.notEqual(beforeEnable, afterEnable)
  await until(async () => (await observations()).some(r => r.phase === 'register' && r.pid === gateway.pid))
  report.checks.enableChangedConfigAndHotReloadedExistingGateway = alive(gateway)
  await state()
  const [a0, b0] = await Promise.all([
    prompt(a, sa, 'observe-a', ['printf first-a', 'printf second-a']),
    prompt(b, sb, 'observe-b', ['printf first-b', 'printf second-b']),
  ])
  const nativeRows = await observations()
  for (const step of [a0, b0]) {
    const rows = nativeRows.filter(r => r.phase === 'tool_request' && step.fixtureToolIds.includes(r.tool_call_id))
    assert.equal(rows.length, 2); assert.equal(new Set(rows.map(r => r.turn_id)).size, 1)
    assert.equal(new Set(rows.map(r => r.api_request_id)).size, 2)
    assert(rows.every(r => r.task_id === step.session))
  }
  report.checks.stableTurnDifferentApiAndToolIds = true
  const observedTurnIds = nativeRows.filter(row => row.phase === 'tool_request').map(row => row.turn_id)
  const acpBeforeInjection = JSON.stringify(clients.flatMap(client => client.events))
  assert(observedTurnIds.every(id => !acpBeforeInjection.includes(id)))
  report.checks.observedTurnIdsAbsentFromAcpBeforeInjection = true
  const aToolIds = a.events.filter(r => r.direction === 'in' && r.at >= a0.start && r.at <= a0.end)
    .map(r => r.message.params?.update).filter(u => u?.sessionUpdate === 'tool_call').map(u => u.toolCallId)
  const viewerIds = viewer.events.filter(r => r.direction === 'in' && r.at >= a0.start && r.at <= a0.end)
    .map(r => r.message.params?.update).filter(u => u?.sessionUpdate === 'tool_call').map(u => u.toolCallId)
  assert(aToolIds.length >= 2); assert(aToolIds.every(id => viewerIds.includes(id)))
  report.checks.idleViewerReceivesOtherClientsToolCalls = true
  await a.close()
  const a2 = await acp('a-cold-resume')
  await a2.request('session/load', {sessionId: sa, cwd: project, mcpServers: []})
  const a1 = await prompt(a2, sa, 'observe-a-resume', ['printf resumed'])
  const resumed = (await observations()).find(r => r.phase === 'tool_request' && a1.fixtureToolIds.includes(r.tool_call_id))
  const original = nativeRows.find(r => r.phase === 'tool_request' && r.session_id === sa)
  assert(resumed); assert.notEqual(original.turn_id, resumed.turn_id); assert.equal(original.task_id, resumed.task_id)
  report.checks.coldResumeKeepsSessionAndTaskButChangesTurn = true
  await state('marker_export', [sa, sb])
  await Promise.all([prompt(a2, sa, 'marker-a', [recordEnvironment('marker-a')]),
    prompt(b, sb, 'marker-b', [recordEnvironment('marker-b')])])
  const ma = await readEnvironment('marker-a'), mb = await readEnvironment('marker-b')
  assert(ma.ROVAI_MIDDLEWARE_PROBE.startsWith(sa + ':'))
  assert(mb.ROVAI_MIDDLEWARE_PROBE.startsWith(sb + ':'))
  assert.notEqual(ma.ROVAI_MIDDLEWARE_PROBE, mb.ROVAI_MIDDLEWARE_PROBE)
  assert(ma.ROVAI_MIDDLEWARE_PROBE.endsWith(" | quote:' dollar:$HOME newline:\nend"))
  report.checks.twoSessionsReceiveOwnNativeTurnMarkers = true
  // A native background terminal keeps its launch-time marker after a later turn.
  // This is NOT the old-execution-starts-a-new-tool case, and supplies no Core grant.
  await mkdir(join(project, 'background-workdir'))
  const waitForRelease = 'python3 -c ' + sh(
    `import pathlib,time; p=pathlib.Path(${JSON.stringify(join(root, 'release-background'))}); end=time.time()+30\nwhile not p.exists() and time.time()<end: time.sleep(.05)\nassert p.exists()`)
  const bgStep = await prompt(b, sb, 'marker-background', [{command: waitForRelease + '; ' + recordEnvironment('marker-background'),
    background: true, timeout: 30, workdir: join(project, 'background-workdir')}])
  const newStep = await prompt(b, sb, 'marker-background-next', [
    recordEnvironment('marker-background-next') + '; touch ' + sh(join(root, 'release-background'))])
  await until(() => exists(join(root, 'marker-background.json')), 10000)
  const bg = await readEnvironment('marker-background'), nextBg = await readEnvironment('marker-background-next')
  assert.notEqual(bg.ROVAI_CLI_CONTEXT, nextBg.ROVAI_CLI_CONTEXT)
  assert.equal(bg.cwd, join(project, 'background-workdir'))
  const bgRows = (await observations()).filter(r => r.phase === 'tool_request' && bgStep.fixtureToolIds.includes(r.tool_call_id))
  assert.equal(bgRows.length, 1); assert.equal(bgRows[0].background, true); assert.equal(bgRows[0].timeout, 30)
  const nextRow = (await observations()).find(r => r.phase === 'tool_request' && newStep.fixtureToolIds.includes(r.tool_call_id))
  assert.notEqual(bgRows[0].turn_id, nextRow.turn_id)
  assert(bg.ROVAI_MIDDLEWARE_PROBE.startsWith(bgRows[0].turn_id))
  report.checks.backgroundKeepsOldMarkerAcrossNextTurn = true
  report.checks.backgroundWorkdirTimeoutArgumentsPreserved = true
  await state()
  await prompt(a2, sa, 'export-residual', [recordEnvironment('export-residual')])
  const residual = await readEnvironment('export-residual')
  report.checks.exportRemainsWhenInjectionStops = residual.ROVAI_CLI_CONTEXT === ma.ROVAI_CLI_CONTEXT
  assert(report.checks.exportRemainsWhenInjectionStops)
  // A distinct ordinary user session must stay untouched, even while marker mode is on.
  const ordinary = await acp('ordinary-user'), so = await session(ordinary)
  await ordinary.request('session/set_mode', {sessionId: so, modeId: 'dont_ask'})
  await state('marker_export', [sa, sb])
  await prompt(ordinary, so, 'ordinary-user', [recordEnvironment('ordinary-user')])
  assert.equal((await readEnvironment('ordinary-user')).ROVAI_CLI_CONTEXT, null)
  report.checks.unselectedUserSessionUnchanged = true
  // Subshell is a possible containment experiment, not a semantics-preserving fix.
  const sub = await acp('subshell'), ss = await session(sub)
  await sub.request('session/set_mode', {sessionId: ss, modeId: 'dont_ask'})
  await state('marker_subshell', [ss])
  await prompt(sub, ss, 'subshell', [recordEnvironment('subshell') + '; export PROBE_ORIGINAL_EXPORT=expected'])
  assert((await readEnvironment('subshell')).ROVAI_CLI_CONTEXT)
  await state()
  await prompt(sub, ss, 'subshell-after', [recordEnvironment('subshell-after')])
  const afterSub = await readEnvironment('subshell-after')
  assert.equal(afterSub.ROVAI_CLI_CONTEXT, null); assert.equal(afterSub.PROBE_ORIGINAL_EXPORT, null)
  report.checks.subshellContainsMarkerButAlsoLosesOriginalExport = true
  // Existing native exception policy must be observed, not used as an auth gate.
  await state('raise', [ss])
  await prompt(sub, ss, 'raising-plugin', [`printf survived > ${sh(join(root, 'raise-survived'))}`])
  assert(await exists(join(root, 'raise-survived'))); report.checks.middlewareExceptionDoesNotBlockCommand = true
  await state()
  const stableBefore = await configSnapshot('before_ordinary_task')
  await prompt(sub, ss, 'no-config-write', ['printf unchanged'])
  assert.equal(stableBefore, await configSnapshot('after_ordinary_task'))
  report.checks.ordinaryTaskDoesNotChangeConfig = true
  report.disableOutput = await selectPlugin(false)
  await configSnapshot('after_disable')
  const beforeDisabled = (await observations()).filter(r => r.phase === 'tool_request' && r.pid === gateway.pid).length
  await prompt(a2, sa, 'disabled-residual', [recordEnvironment('disabled-residual')])
  assert.equal((await observations()).filter(r => r.phase === 'tool_request' && r.pid === gateway.pid).length, beforeDisabled)
  assert.equal((await readEnvironment('disabled-residual')).ROVAI_CLI_CONTEXT, ma.ROVAI_CLI_CONTEXT)
  report.checks.disableHotReloadStopsPluginButKeepsSnapshotResidue = true
  for (const client of clients) await client.close()
  assert(alive(gateway)); report.checks.sharedGatewaySurvivesAcpExit = true
  assert.equal(await readFile(join(nativeHome, '.env'), 'utf8'), 'PROBE_SENTINEL=unchanged\n')
  report.checks.dotenvUnchanged = true
  assert.equal(execFileSync('git', ['status', '--porcelain'], {cwd: nativeSource, encoding: 'utf8'}).trim(), '')
  report.checks.upstreamSourceUnpatched = true
  const rawEvents = clients.flatMap(client => client.events.map(row => ({client: client.label, ...row})))
  const containingPath = wire.filter(request => JSON.stringify(request).includes(join(root, 'no-authority')))
  const riskRequests = containingPath.filter(request => JSON.stringify(request.input).includes('The following command was flagged'))
  const permissionRequests = rawEvents.filter(row => row.direction === 'in' && row.message.method === 'session/request_permission')
  report.exposure = {
    markerPathInProviderRequests: containingPath.length > 0,
    nativeRiskAssessmentRequestsContainingPath: riskRequests.length,
    otherProviderRequestsContainingPath: containingPath.length - riskRequests.length,
    markerPathInAcpEvents: JSON.stringify(rawEvents.filter(r => r.direction === 'in')).includes(join(root, 'no-authority')),
    approvalRequestsContainingPath: permissionRequests.filter(r => JSON.stringify(r.message).includes(join(root, 'no-authority'))).length,
    authorityTokenEverSupplied: false,
  }
  await writeFile(join(root, 'acp.json'), JSON.stringify(rawEvents), {mode: 0o600})
  await writeFile(join(root, 'report.json'), JSON.stringify({...report, configHistory}, null, 2), {mode: 0o600})
  console.log(JSON.stringify({status: 'OBSERVATIONS_COMPLETE', checks: report.checks, exposure: report.exposure}, null, 2))
} catch (error) {
  await writeFile(join(root, 'failure.json'), JSON.stringify({error: String(error), report,
    clients: clients.map(client => ({label: client.label, stderr: client.stderr, events: client.events.slice(-12)}))}, null, 2), {mode: 0o600})
  throw error
} finally {
  for (const client of clients) await client.close().catch(() => {})
  if (alive(gateway)) {
    gateway.kill('SIGTERM')
    await Promise.race([new Promise(resolve => gateway.once('close', resolve)),
      new Promise(resolve => {const timer = setTimeout(() => {
        if (alive(gateway)) gateway.kill('SIGKILL'); resolve()
      }, 15000); timer.unref()})])
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await writeFile(join(root, 'wire.json'), JSON.stringify(wire), {mode: 0o600})
  await writeFile(join(root, 'gateway.log'), gatewayLog, {mode: 0o600})
  if (await exists(join(root, 'report.json'))) {
    report.checks.ownedGatewayStopped = !alive(gateway)
    await writeFile(join(root, 'report.json'), JSON.stringify({...report, configHistory}, null, 2), {mode: 0o600})
  }
  console.log('Evidence:', root)
}
