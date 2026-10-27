// Opt-in target-host qualification with a real mcode and the operator's native BYOK provider.
// Core, native sessions, Skills, MCP, workspaces and diagnostics are private fixtures.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync, spawnSync, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { mkdir, readFile, readdir, realpath, writeFile, cp, rm, chmod } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { startQualificationCore, processTable, descendantsOf } from './lib/qualification-core.mjs'
import { composerDocumentForAddress } from './lib/create-configured-camp.mjs'

const [fixtureArgument, coreExecutable, phase = 'basics'] = process.argv.slice(2)
assert.equal(process.platform, 'linux', 'Run this qualification on its Linux target host')
assert.ok(isAbsolute(fixtureArgument) && isAbsolute(coreExecutable))
assert.ok(['basics', 'capabilities', 'cli', 'compaction', 'compaction-manual', 'failures'].includes(phase))
const compactionPhase = phase.startsWith('compaction')
const fixture = await realpath(fixtureArgument)
assert.deepEqual(await readdir(fixture), [], 'Use a new, empty private fixture')
const data = join(fixture, 'core'), native = join(fixture, 'native'), project = join(fixture, 'project')
for (const path of [data, native, project]) await mkdir(path, { mode: 0o700 })
const sourceConfig = parseYaml(await readFile(join(process.env.MINIMAX_DATA_DIR ?? join(homedir(), '.minimax'), 'config.yaml'), 'utf8'))
const connection = Object.entries(sourceConfig.custom_provider ?? {}).find(([, value]) => value.models?.['gpt-6.1-sol'])
assert.ok(connection, 'Configure gpt-6.1-sol through the official mcode custom provider first')
const [providerId, provider] = connection
const upstreamKey = provider.options?.apiKey
assert.ok(typeof upstreamKey === 'string' && upstreamKey.length > 12)
const upstreamBase = provider.options.baseURL.replace(/\/$/, '')
assert.equal(provider.api, 'openai-responses')
const syntheticKeyA = 'qualification-a-' + randomUUID(), syntheticKeyB = 'qualification-b-' + randomUUID()
const markerA = 'LINUX_A_' + randomUUID(), markerB = 'LINUX_B_' + randomUUID()
const compactionSkillMarker = 'COMPACT_SKILL_' + randomUUID()
const userSkillMarker = 'USER_SKILL_' + randomUUID()
const nativeExecutable = process.env.ROVAI_MINIMAX_CODE_BIN ?? '/home/rovai-test/.local/bin/mcode'
const nativeVersion = execFileSync(nativeExecutable, ['--version'], { encoding: 'utf8' }).trim()
const events = [], requests = []
const ownedServers = [], forbiddenPromptSecrets = [upstreamKey]
const report = { schemaVersion: 1, evidenceKind: 'real-linux-mcode-real-provider-production-core', phase,
  fixture, coreExecutable, coreSha256: createHash('sha256').update(await readFile(coreExecutable)).digest('hex'),
  harnessSha256: digestNative(await readFile(new URL(import.meta.url))),
  nativeVersion, nativeExecutable, nativeSha256: digestNative(await readFile(nativeExecutable)),
  provider: 'native mcode custom_provider', model: 'gpt-6.1-sol',
  dataDirectory: data, skillLibraryRoot: join(data, 'managed-skill-library'), mcpConfigPath: join(data, 'mcp.json'),
  cases: [], turns: [], requests, status: 'running', fullQualification: false }
let core, db, stage = 'setup', fault = null
function digestNative(value) { return createHash('sha256').update(value).digest('hex') }
const digest = value => createHash('sha256').update(value).digest('hex')
const pause = ms => new Promise(resolvePause => setTimeout(resolvePause, ms))
const broker = createServer(async (request, response) => {
  let controller
  try {
    assert.equal(request.method, 'POST')
    const chunks = []; let bytes = 0
    for await (const chunk of request) { bytes += chunk.length; assert.ok(bytes < 16 * 1024 * 1024); chunks.push(chunk) }
    const raw = Buffer.concat(chunks), body = JSON.parse(raw)
    assert.ok(forbiddenPromptSecrets.every(secret => !raw.includes(Buffer.from(secret))), 'A provider/MCP credential entered a model request')
    const route = request.url.startsWith('/b/') ? 'b' : 'a'
    assert.equal(request.headers.authorization, 'Bearer ' + (route === 'b' ? syntheticKeyB : syntheticKeyA))
    const suffix = request.url.replace(/^\/[ab]\/v1/, '')
    assert.ok(['/responses', '/responses/input_tokens'].includes(suffix))
    // Native token-count probes are separate from generation and fault injection.
    if (suffix === '/responses/input_tokens') {
      const counted = await fetch(upstreamBase + suffix, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + upstreamKey }, body: raw })
      response.writeHead(counted.status, { 'Content-Type': counted.headers.get('content-type') ?? 'application/json' })
      response.end(Buffer.from(await counted.arrayBuffer())); return
    }
    const system = [body.instructions, ...(body.input ?? []).filter(value => ['system', 'developer'].includes(value.role)).map(value => JSON.stringify(value.content))].filter(Boolean).join('\n')
    const record = { index: requests.length, stage, route, model: body.model, bodyBytes: raw.length,
      highPriorityDigest: digest(system), payloadDigest: digest(raw), maxOutputTokens: body.max_output_tokens ?? body.max_tokens ?? null,
      charterCount: system.split('[SESSION_CHARTER]').length - 1,
      aPresent: raw.includes(Buffer.from(markerA)), bPresent: raw.includes(Buffer.from(markerB)),
      checkpoint: raw.includes(Buffer.from('loss-aware checkpoint')) || (compactionPhase
        && ((body.tools?.length ?? 0) === 0 || ['compact-failed', 'compact-cancelled', 'compact-checkpoint-overflow'].includes(stage))),
      sessionTitle: body.tools?.length === 1 && (body.tools[0].name ?? body.tools[0].function?.name) === 'submit_session_title',
      tools: (body.tools ?? []).map(tool => tool.name ?? tool.function?.name).filter(Boolean), usage: [] }
    requests.push(record)
    if (fault && !record.sessionTitle && (!fault.checkpointOnly || record.checkpoint)) {
      const activeFault = fault
      if (activeFault.remaining !== Infinity && --activeFault.remaining <= 0) fault = null
      record.injectedFault = activeFault.kind
      if (activeFault.kind === 'hold') {
        await new Promise(resolveClose => response.once('close', resolveClose)); record.clientDisconnected = true; return
      }
      const overflow = activeFault.kind === 'overflow'
      const status = overflow ? 400 : activeFault.kind === 'transient' ? 503 : 401
      record.status = status
      response.writeHead(status, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({ error: { type: overflow ? 'invalid_request_error' : 'qualification_fault',
        code: overflow ? 'context_length_exceeded' : 'qualification_fault',
        message: overflow ? "This model's maximum context length has been exceeded. Reduce the conversation." : 'Controlled qualification rejection' } }))
      return
    }
    controller = new AbortController()
    response.once('close', () => { if (!response.writableEnded) { record.clientDisconnected = true; controller.abort() } })
    const upstream = await fetch(upstreamBase + suffix, { method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + upstreamKey }, body: raw,
      signal: controller.signal })
    record.status = upstream.status
    response.writeHead(upstream.status, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' })
    let pending = ''
    for await (const part of upstream.body) {
      response.write(part)
      pending += Buffer.from(part).toString('utf8')
      if (pending.length > 2 * 1024 * 1024) pending = ''
      const entries = pending.split('\n\n'); pending = entries.pop()
      for (const entry of entries) {
        for (const line of entry.split('\n').filter(value => value.startsWith('data: '))) {
          try {
            const value = JSON.parse(line.slice(6)), usage = value.response?.usage ?? value.usage
            if (usage) record.usage.push(usage)
          } catch { /* Partial or non-JSON SSE carries no numeric evidence. */ }
        }
      }
    }
    response.end()
  } catch (error) {
    if (controller?.signal.aborted) return
    report.brokerFailure = String(error).replaceAll(upstreamKey, '[REDACTED]')
    if (!response.headersSent) response.writeHead(502, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ error: { message: 'Qualification relay failed' } }))
  }
})
await new Promise(resolveListen => broker.listen(0, '127.0.0.1', resolveListen))
async function saveNative(route = 'a') {
  const config = structuredClone(sourceConfig)
  config.custom_provider[providerId].options.baseURL = `http://127.0.0.1:${broker.address().port}/${route}/v1`
  config.custom_provider[providerId].options.apiKey = route === 'a' ? syntheticKeyA : syntheticKeyB
  if (compactionPhase) config.custom_provider[providerId].models['gpt-6.1-sol'].limit = { context: 65536, output: 4096 }
  await writeFile(join(native, 'config.yaml'), stringifyYaml(config), { mode: 0o600 })
}
async function persist() {
  await writeFile(join(fixture, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
}
async function passed(name, facts = {}) {
  report.cases.push({ name, status: 'passed', ...facts }); await persist()
  console.error(JSON.stringify({ phase, case: name, status: 'passed' }))
}
async function startCore() {
  core = startQualificationCore({ coreExecutable, dataDirectory: data, workingDirectory: project,
    runtimeCacheDirectory: join(fixture, 'cache'), mcpConfigPath: join(data, 'mcp.json'),
    environmentOverrides: { MINIMAX_DATA_DIR: native, MAVIS_DATA_DIR: native },
    onNotification: event => { events.push(event) } })
  await core.request('health.check')
}
const request = (method, params = {}, timeout) => core.request(method, params, timeout)
function binding(threadId, agentId = 'agent_2') {
  return db.prepare('SELECT id,native_session_id,native_binding_id,native_binding_generation FROM conversation WHERE camp_id=? AND agent_id=?').get(threadId, agentId)
}
function threadRuns(threadId) {
  return db.prepare('SELECT id,status,execution_epoch,last_error_code FROM agent_run WHERE camp_id=? ORDER BY created_at,id').all(threadId)
}
async function createThread(name, agentIds = ['agent_2']) {
  const result = await request('threads.create', { commandId: randomUUID(), name,
    workspace: { projectPath: project }, memberAgentIds: agentIds, defaultLeadAgentId: agentIds[0], collaborationMode: 'peer' })
  assert.equal(result.status, 'applied', JSON.stringify(result)); return result.payload.threadId
}
async function turn(threadId, text, options = {}) {
  const before = new Set(threadRuns(threadId).map(run => run.id)), firstEvent = events.length
  let nativeBefore = []
  const previousBinding = binding(threadId, options.agentId ?? 'agent_2')
  if (previousBinding?.native_session_id) nativeBefore = (await nativeHistory(previousBinding.native_session_id)).usage
  const content = composerDocumentForAddress({ mode: 'explicit', agentIds: [options.agentId ?? 'agent_2'] }, text)
  content.segments.splice(1, 0, ...(options.skills ?? []).flatMap(skill => [
    { kind: 'atom', atom: { type: 'skill', skillId: skill.id, nameAtSend: skill.name } }, { kind: 'text', text: ' ' }
  ]))
  const sent = await request('thread.messages.send', { commandId: randomUUID(), threadId,
    content,
    sourceAttachments: [], quotes: [], replyToThreadMessageId: null,
    execution: { taskId: null, purpose: 'Linux MiniMax Code runtime qualification', completionRole: 'required' } })
  assert.equal(sent.commandResult?.status, 'accepted', JSON.stringify(sent))
  const deadline = Date.now() + (options.timeout ?? 240_000)
  while (Date.now() < deadline) {
    const run = threadRuns(threadId).find(value => !before.has(value.id))
    if (run && options.onTick) await options.onTick(run)
    if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) {
      if (!options.allowFailure) assert.equal(run.status, 'succeeded', JSON.stringify(run))
      const snapshot = await request('camps.snapshot', { threadId })
      const currentBinding = binding(threadId, options.agentId ?? 'agent_2')
      let usage = []
      if (currentBinding?.native_session_id) {
        const old = new Set(nativeBefore.map(value => value.messageId))
        usage = (await nativeHistory(currentBinding.native_session_id)).usage.filter(value => !old.has(value.messageId))
      }
      report.turns.push({ stage, runId: run.id, status: run.status, binding: currentBinding, nativeUsage: usage })
      return { run, snapshot, binding: currentBinding,
        events: events.slice(firstEvent).filter(event => event.params?.agentRunId === run.id),
        publicMessages: snapshot.messages.filter(message => message.sourceAgentRunId === run.id) }
    }
    await pause(200)
  }
  throw new Error('AgentRun terminal timeout in ' + stage)
}
const nativeChildren = async () => (await processTable()).filter(process => process.ppid === core.pid).map(process => process.pid)
const publicText = result => result.publicMessages.map(message => message.body).join('\n')
const hostId = result => result.events.find(event => event.method === 'agent_run.started')?.params.hostInstanceId
async function command(method, value) {
  const result = await request(method, { commandId: randomUUID(), command: value })
  assert.notEqual(result.status, 'rejected', JSON.stringify(result)); return result
}
async function qualifyCli() {
  await request('preferences.tasks.set', { enabled: true })
  const mission = await command('missions.create', { title: 'Linux CLI qualification', description: 'Isolated qualification only.',
    projectPath: project, projectBindingKind: 'directory', memberAgentIds: ['agent_2'], defaultLeadAgentId: 'agent_2', tags: [] })
  const { threadId, missionId } = mission.payload
  const script = join(project, 'verify-cli.mjs'), resultFile = join(project, 'cli-results.json')
  const contextCopy = join(project, 'expired-lease.json')
  await writeFile(script, `
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {writeFileSync,readFileSync,copyFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const results=[];
const call=(args,input={})=>{
  const child=spawnSync(process.env.ROVAI_AGENT_CLI,args,{input:JSON.stringify(input),encoding:'utf8',timeout:30000});
  const value=JSON.parse(child.stdout); results.push({args,status:child.status,value});
  writeFileSync(${JSON.stringify(resultFile)},JSON.stringify(results,null,2));
  assert.equal(child.status,0,JSON.stringify({args,value,stderr:child.stderr}));assert.ok(!value.error,JSON.stringify(value));return value;
};
assert.ok(process.env.ROVAI_CLI_CONTEXT);copyFileSync(process.env.ROVAI_CLI_CONTEXT,${JSON.stringify(contextCopy)});
call(['member','list']);
const self=call(['member','get'],{agentId:'agent_2'});
call(['member','update'],{agentId:'agent_2',expectedVersion:self.version,requestId:randomUUID(),growthTopic:'Linux qualification fixture'});
const created=call(['member','create'],{creationKey:randomUUID(),displayName:'CLI Fixture Member',teamRole:'Verifier',professionalResponsibilities:'Only isolated acceptance.',personalityTraits:['Precise'],workingPrinciples:'Report the requested marker, then stop.',growthTopic:''});
const task=call(['task','create'],{title:'Linux CLI task',description:'Fixture task.',assigneeAgentId:'agent_2'});
call(['task','get'],{taskId:task.taskId});call(['task','list'],{limit:10});call(['task','update'],{taskId:task.taskId,status:'in_progress'});
call(['thread','list']);
const found=call(['thread','search'],{query:'CLI_QUALIFICATION_USER',limit:10});
assert.ok(found.results.length);call(['thread','read'],{messageId:found.results[0].messageId});call(['thread','runs']);
call(['history','search'],{query:'CLI_QUALIFICATION_USER',limit:10});
const memory=call(['memory','write'],{action:'add',scope:'companion',kind:'preference',body:'Linux CLI memory fixture.',retrievalKeys:['linux-cli-qualification']});
call(['memory','view'],{scope:'companion'});call(['memory','search'],{query:'linux-cli-qualification',limit:6});call(['memory','read'],{memoryIds:[memory.memoryId]});
call(['mission','list']);const current=call(['mission','get']);assert.equal(current.missionId,${JSON.stringify(missionId)});
call(['mission','update'],{description:'Updated by the authorized Linux CLI fixture.'});call(['mission','status'],{status:'in_progress'});
const automation=call(['automation','create'],{name:'Linux CLI manual fixture',prompt:'Publish LINUX_AUTOMATION_OK with one public-only send, then stop.',member:'agent_2',project:'quick-chat',repeat:'manual'});
call(['automation','list'],{status:'enabled'});call(['automation','get'],{automationId:automation.automationId});
const updated=call(['automation','update'],{automationId:automation.automationId,expectedVersion:automation.version,name:'Linux CLI updated fixture'});
call(['automation','run'],{automationId:automation.automationId});
const closed=call(['automation','close'],{automationId:automation.automationId,expectedVersion:updated.version});
call(['automation','delete'],{automationId:automation.automationId,expectedVersion:closed.version});
call(['send'],{body:'LINUX_CLI_29_OK',publicOnly:true});
console.log('LINUX_CLI_SCRIPT_OK');
`, { mode: 0o600 })
  stage = 'cli-public'
  const publicRun = await turn(threadId, `CLI_QUALIFICATION_USER: I explicitly authorize creating one test member and manual automation, running and deleting that automation, updating agent_2 growthTopic to Linux qualification fixture, creating/updating one task, writing fixture memory, and updating the current Mission. Execute exactly: node ${JSON.stringify(script)}. Do not modify the script. Its bundled CLI publishes the result; then finish with a short nonempty final.`, { timeout: 600_000 })
  const results = JSON.parse(await readFile(resultFile, 'utf8'))
  assert.ok(results.length >= 29 && results.every(value => value.status === 0))
  assert.ok(publicText(publicRun).includes('LINUX_CLI_29_OK'))
  const evidence = await request('agentRunEvidence.list', { threadId, agentRunId: publicRun.run.id, afterSequence: 0, limit: 1000 })
  report.cliEvidence = evidence
  const expired = spawnSync(dirname(coreExecutable) + '/rovai', ['thread', 'list'], {
    env: { ...process.env, ROVAI_CLI_CONTEXT: contextCopy }, encoding: 'utf8', timeout: 10_000,
    stdio: ['pipe', 'pipe', 'pipe']
  })
  assert.notEqual(expired.status, 0, 'The completed Run lease must reject')
  assert.ok(JSON.parse(expired.stdout).error)
  await passed('29 public-context CLI operations and expired Run lease rejection', { run: publicRun.run.id, invocations: results.length })
  const privateSeed = 'PRIVATE_HISTORY_SEED_' + randomUUID()
  const privateScript = join(project, 'verify-private-cli.mjs'), privateResult = join(project, 'private-cli-result.json')
  await writeFile(privateScript, `import {spawnSync} from 'node:child_process';import {writeFileSync} from 'node:fs';import assert from 'node:assert/strict';const r=spawnSync(process.env.ROVAI_AGENT_CLI,['single-chat','history'],{input:'{}',encoding:'utf8',timeout:10000});const value=JSON.parse(r.stdout);writeFileSync(${JSON.stringify(privateResult)},JSON.stringify({status:r.status,value}));assert.equal(r.status,0);assert.ok(!value.error);assert.ok(value.messages.some(message=>message.body?.includes(${JSON.stringify(privateSeed)})));console.log('PRIVATE_CLI_OK');`, { mode: 0o600 })
  const opened = await command('singleChat.open', { threadId, agentId: 'agent_2' })
  const conversationId = opened.payload.conversationId
  const sendPrivate = async body => {
    const before = await request('singleChat.get', { conversationId })
    const ids = new Set(before.agentRuns.map(run => run.id))
    const sent = await command('singleChat.send', { threadId, conversationId, body, draftRevision: before.draft.revision })
    assert.ok(['applied', 'accepted'].includes(sent.status))
    const deadline = Date.now() + 240_000
    let snapshot, run
    while (Date.now() < deadline) {
      snapshot = await request('singleChat.get', { conversationId })
      run = snapshot.agentRuns.find(value => !ids.has(value.id))
      if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
      await pause(200)
    }
    assert.equal(run?.status, 'succeeded', JSON.stringify(run))
    return { run, snapshot }
  }
  stage = 'cli-single-chat-seed'
  await sendPrivate(`Remember ${privateSeed} only in this private conversation. Finish with PRIVATE_SEED_OK. Do not publish to a public Thread.`)
  stage = 'cli-single-chat'
  const { run: privateRun, snapshot: privateSnapshot } = await sendPrivate(`Execute exactly node ${JSON.stringify(privateScript)}. Do not publish to the public Thread. Finish with PRIVATE_CLI_OK.`)
  assert.equal(JSON.parse(await readFile(privateResult, 'utf8')).status, 0)
  const privateEvidence = { evidence: privateSnapshot.executionEvidence.filter(entry => entry.agentRunId === privateRun.id) }
  const catalogSource = await readFile(resolve(import.meta.dirname, '../crates/rovai-core/src/builtin_tool_transport.rs'), 'utf8')
  const identities = catalogSource.match(/pub const BUILTIN_TOOL_CLI_IDENTITIES:[\s\S]*?= \[([\s\S]*?)\n\];/)[1]
  const expected = [...identities.matchAll(/operation: "([^"]+)"/g)].map(value => value[1]).sort()
  const completed = [...evidence.evidence, ...privateEvidence.evidence].filter(entry => entry.payload?.kind === 'builtin_tool_invocation' && entry.payload?.status === 'completed')
  const observed = [...new Set(completed.map(entry => entry.payload.canonicalTool))].sort()
  assert.deepEqual(observed, expected, 'Every operation in the current Core catalog needs committed real-Run evidence')
  report.cliOperationEvidence = { expected, observed, completedEvidenceRows: completed.length }
  await passed('all 30 current operations have committed Core evidence, including actual private Single Chat history', { run: privateRun.id, conversationId, operations: observed })
  const followup = await turn(threadId, 'Use one bundled public-only send to publish LINUX_CLI_NEW_LEASE_OK. Finish normally.')
  assert.ok(publicText(followup).includes('LINUX_CLI_NEW_LEASE_OK'))
  assert.deepEqual(followup.binding, publicRun.binding)
  await passed('successor public Run receives a working new lease and preserves its native binding', { run: followup.run.id })
  report.cliOperations = results.map(value => value.args.join(' ')).concat('single-chat history')
}
async function qualifyCapabilities() {
  const fixtureServer = resolve(import.meta.dirname, '../crates/rovai-core/tests/fixtures/mcp-smoke-server.mjs')
  const callMarker = join(project, 'mcp-calls.txt')
  const definition = source => ({ command: process.execPath, args: [fixtureServer],
    env: { ROVAI_MCP_SMOKE_SOURCE: source, ROVAI_MCP_SMOKE_CALL_MARKER: callMarker } })
  await writeFile(join(native, 'mcp.json'), JSON.stringify({ mcpServers: {
    linux_qualification: definition('NATIVE_CONFLICT'), native_unique: definition('NATIVE_UNIQUE')
  } }), { mode: 0o600 })
  const mutateMcp = async (method, value) => {
    const config = await request('mcp.config.get')
    const result = await request(method, { expectedConfigDigest: config.configDigest, ...value })
    assert.equal(result.status, 'ok', JSON.stringify(result)); return result
  }
  const createdMcp = await mutateMcp('mcp.servers.create', { definitionJson: JSON.stringify({ mcpServers: { linux_qualification: definition('ROVAI_ASSIGNED_V1') } }) })
  const serverId = createdMcp.config.servers.find(server => server.name === 'linux_qualification').serverId
  assert.ok(serverId)
  await mutateMcp('mcp.servers.setEnabled', { serverId, enabled: true })
  await mutateMcp('mcp.assignments.set', { serverId, agentId: 'agent_2', assigned: true })
  const httpSecret = 'synthetic-mcp-' + randomUUID(), httpCalls = []
  forbiddenPromptSecrets.push(httpSecret)
  const httpMcp = createServer(async (incoming, outgoing) => {
    try {
      assert.equal(incoming.headers.authorization, 'Bearer ' + httpSecret)
      if (incoming.method !== 'POST') { outgoing.writeHead(405).end(); return }
      const chunks = []; for await (const chunk of incoming) chunks.push(chunk)
      const message = JSON.parse(Buffer.concat(chunks))
      if (message.id == null) { outgoing.writeHead(202).end(); return }
      let result
      if (message.method === 'initialize') result = { protocolVersion: message.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'linux-http-fixture', version: '1' } }
      else if (message.method === 'tools/list') result = { tools: [{ name: 'echo', description: 'Echo a qualification marker.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] }
      else if (message.method === 'tools/call') {
        httpCalls.push({ stage, text: message.params.arguments.text })
        result = { content: [{ type: 'text', text: 'HTTP_ACTUAL:' + message.params.arguments.text }] }
      } else { outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Unsupported fixture method' } })); return }
      outgoing.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    } catch { outgoing.writeHead(400).end() }
  })
  await new Promise(resolveListen => httpMcp.listen(0, '127.0.0.1', resolveListen)); ownedServers.push(httpMcp)
  const createdHttp = await mutateMcp('mcp.servers.create', { definitionJson: JSON.stringify({ mcpServers: {
    linux_http: { url: `http://127.0.0.1:${httpMcp.address().port}/mcp`, headers: { Authorization: 'Bearer ' + httpSecret } }
  } }) })
  const httpServerId = createdHttp.config.servers.find(server => server.name === 'linux_http').serverId
  await mutateMcp('mcp.servers.setEnabled', { serverId: httpServerId, enabled: true })
  await mutateMcp('mcp.assignments.set', { serverId: httpServerId, agentId: 'agent_2', assigned: true })
  const nativeSkill = join(project, '.agents/skills/linux-native-qualification')
  await mkdir(nativeSkill, { recursive: true })
  const nativeMarker = 'NATIVE_SKILL_' + randomUUID(), updatedMarker = 'UPDATED_SKILL_' + randomUUID()
  const saveProjectSkill = marker => writeFile(join(nativeSkill, 'SKILL.md'), `---\nname: linux-native-qualification\ndescription: Native project qualification skill.\n---\nWhen invoked, report ${marker}.\n`)
  await saveProjectSkill(nativeMarker)
  const thread = await createThread('Linux capability lifecycle')
  const probe = async (name, text, options = {}) => { stage = name; return turn(thread, text + ' Publish actual results through exactly one bundled public-only send and finish with a nonempty final. Never fabricate tool results.', options) }
  const additional = runId => {
    const row = db.prepare('SELECT blob.sha256,blob.storage_relative_path FROM context_manifest AS context JOIN managed_blob AS blob ON blob.id=context.rendered_payload_blob_id WHERE context.agent_run_id=? ORDER BY context.created_at LIMIT 1').get(runId)
    assert.ok(row && /^[a-f0-9]{64}$/.test(row.sha256))
    const path = resolve(data, 'managed-blobs', row.storage_relative_path)
    assert.ok(path.startsWith(join(data, 'managed-blobs') + '/'))
    const bytes = readFileSync(path); assert.equal(digest(bytes), row.sha256)
    const text = bytes.toString('utf8'), start = text.indexOf('[ROVAI_ADDITIONAL_SKILLS]')
    assert.ok(start >= 0)
    const section = text.slice(start, text.indexOf('[/ROVAI_ADDITIONAL_SKILLS]', start))
    const index = JSON.parse(section.split('\n').find(line => line.startsWith('{"root":')))
    return index.skills.map(skill => skill.name)
  }
  const setToolbox = async (name, enabled) => {
    const row = (await request('toolbox.list')).find(skill => skill.name === name)
    assert.ok(row)
    const ids = row.memberIds.filter(id => id !== 'agent_2')
    if (enabled) ids.push('agent_2')
    await command('toolbox.setMembers', { skillName: name, memberIds: ids, expectedVersion: row.version })
  }
  const candidates = await request('skills.candidates', { threadId: thread, refresh: true })
  const selectedNative = candidates.skills.find(skill => skill.name === 'linux-native-qualification' && skill.entryPath === join(nativeSkill, 'SKILL.md'))
  assert.ok(selectedNative?.id.startsWith('native:'))
  const first = await probe('capabilities-first', 'Invoke linux-native-qualification through native skill discovery. Read cli-operations and memory-stewardship SKILL.md from the platform index root and member-studio SKILL.md from the Additional Skills root; report their YAML names without executing their workflows. Actually call the echo tool from linux_qualification, native_unique, and linux_http once each with text fresh_first. Do not substitute shell/file access for MCP.', { skills: [selectedNative] })
  const firstText = publicText(first)
  for (const marker of [nativeMarker, 'ROVAI_ASSIGNED_V1:fresh_first', 'NATIVE_UNIQUE:fresh_first', 'HTTP_ACTUAL:fresh_first']) assert.ok(firstText.includes(marker), firstText)
  for (const name of ['cli-operations', 'memory-stewardship', 'member-studio']) assert.ok(firstText.includes(name))
  assert.ok(!firstText.includes('NATIVE_CONFLICT:'))
  assert.ok(additional(first.run.id).includes('member-studio'))
  assert.ok(first.events.some(event => event.method === 'runtime.action' && JSON.stringify(event.params.payload?.input).includes('member-studio')))
  await passed('actual native Skill invocation, platform/toolbox file loading, and assigned/native stdio plus HTTP MCP', { run: first.run.id, binding: first.binding, nativeSkillId: selectedNative.id, additional: additional(first.run.id) })
  await saveProjectSkill(updatedMarker)
  await setToolbox('member-studio', false); await setToolbox('review-duo', true)
  await mutateMcp('mcp.servers.update', { serverId, definitionJson: JSON.stringify({ mcpServers: { linux_qualification: definition('ROVAI_ASSIGNED_V2') } }) })
  const updated = await probe('capabilities-update', 'Invoke linux-native-qualification afresh and read review-duo SKILL.md from the current Additional Skills root, reporting its YAML name without executing its workflow. Call linux_qualification echo with text fresh_updated. Return current actual results, not earlier memory.')
  assert.ok(publicText(updated).includes(updatedMarker)); assert.ok(!publicText(updated).includes(nativeMarker))
  assert.ok(publicText(updated).includes('ROVAI_ASSIGNED_V2:fresh_updated'))
  assert.deepEqual(additional(updated.run.id), ['review-duo'])
  assert.deepEqual(updated.binding, first.binding)
  await passed('next Run reads the updated native Skill, current per-member toolbox and updated MCP definition', { run: updated.run.id, binding: updated.binding })
  await setToolbox('review-duo', false)
  await mutateMcp('mcp.assignments.set', { serverId, agentId: 'agent_2', assigned: false })
  const absent = await probe('capabilities-disabled', 'Call linux_qualification echo with text fresh_unassigned and invoke linux-native-qualification. The current Additional Skills index replaces old indexes: report its current names, without reopening disabled toolbox guides.')
  assert.ok(publicText(absent).includes('NATIVE_CONFLICT:fresh_unassigned'))
  assert.deepEqual(additional(absent.run.id), [])
  await passed('disabled per-member toolbox stays absent and unassigned MCP restores its native same-name definition', { run: absent.run.id })
  const profile = await request('members.get', { agentId: 'agent_1' })
  await command('members.runtime.set', { agentId: 'agent_1', expectedVersion: profile.version, adapterKind: 'minimax-code-cli', ...report.installation.defaults })
  const adjacent = await createThread('Linux capability adjacent', ['agent_1'])
  stage = 'capabilities-adjacent'
  const neighbor = await turn(adjacent, 'Actually call linux_qualification echo with text adjacent. Return its result through one public-only send, then finish normally.', { agentId: 'agent_1' })
  assert.ok(publicText(neighbor).includes('NATIVE_CONFLICT:adjacent') && !publicText(neighbor).includes('ROVAI_ASSIGNED'))
  assert.ok(additional(neighbor.run.id).includes('member-studio'))
  await passed('adjacent member keeps its own toolbox and native MCP instead of another member assignment', { run: neighbor.run.id })
  await mutateMcp('mcp.assignments.set', { serverId, agentId: 'agent_2', assigned: true })
  const reassigned = await probe('capabilities-reassigned', 'Actually call linux_qualification echo with text reassigned and return its current result.')
  assert.ok(publicText(reassigned).includes('ROVAI_ASSIGNED_V2:reassigned'))
  await mutateMcp('mcp.servers.delete', { serverId })
  const deleted = await probe('capabilities-deleted', 'Actually call linux_qualification echo with text deleted and return its current result.')
  assert.ok(publicText(deleted).includes('NATIVE_CONFLICT:deleted'))
  await passed('MCP reassignment and deletion restore the current native capability without session drift', { run: deleted.run.id })
  const duplicate = join(project, '.minimax/skills/linux-native-qualification')
  await mkdir(duplicate, { recursive: true })
  const duplicateMarker = 'OTHER_SOURCE_' + randomUUID()
  await writeFile(join(duplicate, 'SKILL.md'), `---\nname: linux-native-qualification\ndescription: Same-name different-source qualification.\n---\nReport ${duplicateMarker}.\n`)
  const duplicateCandidates = (await request('skills.candidates', { threadId: thread, refresh: true })).skills.filter(skill => skill.name === selectedNative.name)
  assert.equal(duplicateCandidates.length, 2); assert.equal(new Set(duplicateCandidates.map(skill => skill.id)).size, 2)
  const exact = await probe('skill-same-name', 'Read only the exact Skill file linked in this message and publish its verification value. Do not resolve another same-name file by tool name.', { skills: [selectedNative] })
  assert.ok(publicText(exact).includes(updatedMarker) && !publicText(exact).includes(duplicateMarker))
  const resolution = runId => JSON.parse(db.prepare('SELECT current_input_skill_resolution_json FROM context_manifest WHERE agent_run_id=?').get(runId).current_input_skill_resolution_json)
  assert.ok(resolution(exact.run.id).entries.some(entry => entry.skillId === selectedNative.id && entry.outcome === 'available' && entry.sourcePath === join(nativeSkill, 'SKILL.md')))
  await rm(join(nativeSkill, 'SKILL.md'))
  const missing = await probe('skill-source-deleted', 'The exact selected native Skill file was removed. Do not use another same-name source, old cached content, shell or file discovery. Publish SKILL_SOURCE_MISSING and finish.', { skills: [selectedNative] })
  assert.ok(resolution(missing.run.id).entries.some(entry => entry.skillId === selectedNative.id && entry.outcome === 'unavailable' && entry.reason === 'source_missing'))
  assert.ok(!publicText(missing).includes(duplicateMarker))
  await passed('same-name native Skills keep distinct identities and a deleted selected source does not rebind', { run: missing.run.id, sources: duplicateCandidates.map(skill => skill.id) })
  await saveProjectSkill(updatedMarker)
  await core.stop(); core = null; await startCore()
  const cold = await probe('capabilities-cold', 'Read the original .agents/skills/linux-native-qualification/SKILL.md file and call linux_http echo with text after_cold. Return both actual results.')
  assert.ok(publicText(cold).includes(updatedMarker) && publicText(cold).includes('HTTP_ACTUAL:after_cold'))
  assert.deepEqual(cold.binding, first.binding); assert.deepEqual(additional(cold.run.id), [])
  assert.ok(!(await readFile(join(native, 'mcp.json'), 'utf8')).includes(httpSecret))
  assert.equal(httpCalls.filter(call => call.text === 'fresh_first').length, 1)
  assert.equal(httpCalls.filter(call => call.text === 'after_cold').length, 1)
  report.httpMcp = { actualCalls: httpCalls, secretInNativeGlobalConfig: false, secretInModelRequests: false }
  assert.deepEqual(first.snapshot.contextManifests.find(value => value.agentRunId === first.run.id).skillExposure.skills, [])
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM skill_projection_observation').get().n, 0)
  await passed('authenticated HTTP MCP, native source and disabled toolbox persist across exact cold resume without legacy project projections', { run: cold.run.id })
  report.mcpCalls = (await readFile(callMarker, 'utf8')).trim().split('\n').length
}
async function nativeHistory(sessionId) {
  const nativeDb = new DatabaseSync(join(native, 'v2/sqlite/runtime-state.sqlite'), { readOnly: true })
  const relative = nativeDb.prepare('SELECT history_relative_dir FROM local_runtime_sessions WHERE session_id=?').get(sessionId)?.history_relative_dir
  nativeDb.close(); assert.ok(relative && !relative.includes('..'))
  const directory = resolve(native, 'v2/sessions', relative)
  assert.ok(directory.startsWith(join(native, 'v2/sessions') + '/'))
  const rows = (await readFile(join(directory, 'messages.jsonl'), 'utf8')).split('\n').filter(Boolean).map(JSON.parse)
  const summaries = rows.filter(row => row.message?.role === 'compactionSummary').map(row => ({ messageId: row.message_id,
    tokensBefore: row.message.tokensBefore, generation: row.history_artifact?.generation }))
  const snapshots = join(directory, 'snapshots')
  let archived = []
  try {
    for (const name of (await readdir(snapshots)).filter(name => /^g\d{12}--ctx_[\da-f-]+\.jsonl$/.test(name))) {
      archived.push(...(await readFile(join(snapshots, name), 'utf8')).split('\n').filter(Boolean).map(JSON.parse))
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  const unique = new Map([...archived, ...rows].map(row => [row.message_id, row]))
  const usage = [...unique.values()].filter(row => row.message?.role === 'assistant' && row.message.usage && ['stop', 'toolUse', 'length'].includes(row.message.stopReason))
    .map(row => ({ messageId: row.message_id, turnId: row.turn_id, ...row.message.usage }))
  return { sessionId, directory, count: rows.length, generation: Math.max(0, ...rows.map(row => row.history_artifact?.generation ?? 0)), summaries, usage }
}
function nativeControl(bootstrap) {
  const child = spawn(nativeExecutable, ['acp', '--append-system-prompt-file', bootstrap], {
    cwd: project, env: { ...process.env, MINIMAX_DATA_DIR: native, MAVIS_DATA_DIR: native }, stdio: ['pipe', 'pipe', 'pipe'] })
  let id = 0; const pending = new Map()
  child.stderr.resume()
  createInterface({ input: child.stdout }).on('line', line => {
    let value; try { value = JSON.parse(line) } catch { return }
    if (value.method && value.id != null) {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: value.id, result: { outcome: { outcome: 'cancelled' } } }) + '\n'); return
    }
    const entry = pending.get(value.id)
    if (!entry) return
    pending.delete(value.id); clearTimeout(entry.timer)
    value.error ? entry.reject(new Error(JSON.stringify(value.error))) : entry.resolve(value.result)
  })
  const closed = new Promise(resolveClose => child.once('close', resolveClose))
  return {
    async request(method, params, timeout = 240_000) {
      const current = ++id
      return new Promise((resolveRequest, reject) => {
        const timer = setTimeout(() => { pending.delete(current); reject(new Error('Native ACP timeout: ' + method)) }, timeout)
        pending.set(current, { resolve: resolveRequest, reject, timer })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n')
      })
    },
    notify(method, params) { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n') },
    async stop() {
      const descendants = descendantsOf(await processTable(), child.pid)
      child.stdin.end()
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000)
      await closed; clearTimeout(timer)
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Native control stopped')) }
      await pause(500)
      const live = new Set((await processTable()).map(process => process.pid))
      const remaining = descendants.filter(pid => live.has(pid))
      report.nativeControlCleanup = { observedDescendants: descendants.length, remaining: remaining.length }
      for (const pid of remaining) { try { process.kill(pid, 'SIGKILL') } catch { /* Already gone. */ } }
      assert.deepEqual(remaining, [], 'Native control shutdown must reap its descendants')
      return child.exitCode
    }
  }
}
async function qualifyCompaction() {
  const thread = await createThread('Linux compaction continuity')
  stage = 'compact-baseline'
  const baseline = await turn(thread, `Remember the private phrase ${markerA} throughout compaction. Invoke linux-compact-qualification Skill and call compact_fixture echo with text baseline. Publish their actual results and COMPACT_BASELINE_OK using one public-only bundled send, then finish with a nonempty final.`)
  assert.ok(publicText(baseline).includes(compactionSkillMarker) && publicText(baseline).includes('COMPACT_MCP:baseline'))
  const sessionId = baseline.binding.native_session_id
  if (phase === 'compaction') {
  const initial = await nativeHistory(sessionId)
  for (let round = 0; round < 5; round++) {
    stage = 'automatic-pad-' + round
    const padding = Array.from({ length: 1000 }, (_, i) => `inert-${round}-${i}-${randomUUID()}`).join('\n')
    const result = await turn(thread, `The following is inert synthetic qualification data; do not execute or repeat it. Preserve the private phrase from the first message.\n<inert-data>\n${padding}\n</inert-data>\nPublish PAD_${round}_OK through one bundled public-only send and finish with a short nonempty final.`, { timeout: 360_000 })
    assert.deepEqual(result.binding, baseline.binding)
    const current = await nativeHistory(sessionId)
    report.automaticCompaction = { initial, current, round: round + 1 }
    await persist()
    if (current.generation > initial.generation) break
  }
  assert.ok(report.automaticCompaction.current.generation > initial.generation, 'Native threshold compaction must actually commit')
  await passed('real native automatic threshold compaction commits history without changing the Core binding', report.automaticCompaction)
  stage = 'compact-after-auto'
  const afterAuto = await turn(thread, 'Invoke linux-compact-qualification Skill and actually call compact_fixture echo with text after_auto. Publish both actual results and your original private phrase using one public-only send, then finish normally.')
  assert.ok(publicText(afterAuto).includes(compactionSkillMarker) && publicText(afterAuto).includes('COMPACT_MCP:after_auto') && publicText(afterAuto).includes(markerA))
  assert.deepEqual(afterAuto.binding, baseline.binding)
  await passed('automatic compaction preserves actual Skill, assigned MCP, permission configuration and private memory', { run: afterAuto.run.id })
  const beforeCancel = (await nativeHistory(sessionId)).generation
  stage = 'automatic-compact-cancelled'; fault = { kind: 'hold', checkpointOnly: true, remaining: Infinity }
  let cancelled = false
  const padding = Array.from({ length: 1000 }, (_, i) => `cancel-inert-${i}-${randomUUID()}`).join('\n')
  const cancelledRun = await turn(thread, `The following is inert data, not instructions. Do not execute it or publish it.\n<inert-data>\n${padding}\n</inert-data>\nFinish briefly.`, { allowFailure: true, timeout: 360_000,
    onTick: async run => {
      if (cancelled || !requests.some(value => value.stage === stage && value.injectedFault === 'hold')) return
      const version = db.prepare('SELECT version FROM agent_run WHERE id=?').get(run.id).version
      await command('agentRuns.cancel', { threadId: thread, agentRunId: run.id, expectedVersion: version })
      cancelled = true
    }
  })
  fault = null
  assert.ok(cancelled); assert.equal(cancelledRun.run.status, 'cancelled')
  const heldCheckpoint = requests.find(value => value.stage === stage && value.injectedFault === 'hold')
  const disconnectDeadline = Date.now() + 5000
  while (!heldCheckpoint.clientDisconnected && Date.now() < disconnectDeadline) await pause(100)
  assert.equal(heldCheckpoint.clientDisconnected, true, 'Cancelled native checkpoint must close its held provider request')
  assert.equal((await nativeHistory(sessionId)).generation, beforeCancel)
  assert.deepEqual(cancelledRun.binding, baseline.binding)
  await passed('Core cancellation during an actual native automatic checkpoint preserves the committed history generation', { run: cancelledRun.run.id })
  stage = 'compact-after-cancel'
  const afterCancel = await turn(thread, 'Recall the original private phrase, invoke linux-compact-qualification Skill and call compact_fixture echo with text after_cancel. Publish all actual results with one public-only send, then finish normally.', { timeout: 360_000 })
  assert.deepEqual(afterCancel.binding, baseline.binding)
  assert.ok(publicText(afterCancel).includes(markerA) && publicText(afterCancel).includes(compactionSkillMarker)
    && publicText(afterCancel).includes('COMPACT_MCP:after_cancel'))
  await passed('after cancelled compaction the next Core Run resumes the exact Session with actual Skill, MCP and private memory', { run: afterCancel.run.id })
  }
  // mcode changes its process title, so /proc argv no longer exposes its flags.
  // Copy the exact Core-written Bootstrap while its sole formal Host is alive.
  const bootstraps = (await readdir(fixture, { recursive: true }))
    .filter(path => path.endsWith('/system-prompt.txt')).map(path => join(fixture, path))
  assert.equal(bootstraps.length, 1)
  const savedBootstrap = join(fixture, 'native-control-bootstrap.md')
  await cp(bootstraps[0], savedBootstrap)
  await core.stop(); core = null
  const control = nativeControl(savedBootstrap)
  try {
    report.nativeInitialize = await control.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'Rovai isolated Linux qualification', version: '1' } })
    await control.request('session/resume', { sessionId, cwd: project, mcpServers: [] })
    const compact = () => control.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: '/compact Preserve the original private qualification phrase.' }] })
    const generation = (await nativeHistory(sessionId)).generation
    stage = 'compact-failed'; fault = { kind: 'auth', checkpointOnly: true, remaining: Infinity }
    let failure
    try { await compact() } catch (error) { failure = String(error) }
    fault = null
    assert.ok(failure && !failure.includes('Native ACP timeout'), 'Compaction must explicitly reject; timeout is not a native result')
    assert.ok(requests.some(value => value.stage === stage && value.injectedFault === 'auth'))
    assert.equal((await nativeHistory(sessionId)).generation, generation)
    await passed('failed native compaction does not advance history generation')
    stage = 'compact-checkpoint-overflow'
    fault = { kind: 'overflow', checkpointOnly: true, remaining: 1 }
    report.manualCompact = await compact(); fault = null
    const recovered = await nativeHistory(sessionId)
    assert.equal(recovered.generation, generation + 1, 'Compaction must recover and commit exactly once')
    const attempts = requests.filter(value => value.stage === stage)
    assert.ok(attempts.some(value => value.injectedFault === 'overflow') && attempts.some(value => value.status === 200))
    await passed('manual compaction retries after a controlled native checkpoint overflow and commits once', { beforeGeneration: generation, afterGeneration: recovered.generation, requestCount: attempts.length,
      requestBytes: attempts.filter(value => !value.sessionTitle).map(value => value.bodyBytes) })
  } finally { fault = null; await control.stop() }
  stage = 'compact-cold'; await startCore()
  const cold = await turn(thread, 'Without reading history or memory files, recall the original private phrase. Invoke linux-compact-qualification Skill and actually call compact_fixture echo with text after_cold. Publish those actual results, the phrase and COMPACTION_COLD_OK using one public-only send. Finish normally.')
  assert.deepEqual(cold.binding, baseline.binding); assert.ok(publicText(cold).includes(markerA))
  assert.ok(publicText(cold).includes(compactionSkillMarker) && publicText(cold).includes('COMPACT_MCP:after_cold'))
  assert.equal(db.prepare('SELECT runtime_permission_config_json FROM agent_run WHERE id=?').get(cold.run.id).runtime_permission_config_json,
    db.prepare('SELECT runtime_permission_config_json FROM agent_run WHERE id=?').get(baseline.run.id).runtime_permission_config_json)
  const main = requests.filter(value => value.stage !== 'setup' && !value.checkpoint && !value.sessionTitle)
  assert.ok(main.every(value => value.charterCount === 1))
  assert.equal(new Set(main.map(value => value.highPriorityDigest)).size, 1)
  await passed('compaction retains one identical high-priority Bootstrap and exact cold Session memory', { run: cold.run.id, binding: cold.binding, includesAutomatic: phase === 'compaction' })
}
async function qualifyFailures() {
  const thread = await createThread('Linux failure and recovery')
  stage = 'failure-baseline'
  const baseline = await turn(thread, `Remember ${markerA}. Publish FAILURE_BASELINE_OK using one public-only send and finish normally.`)
  const nativeModel = report.catalog.models.find(model => model.id.startsWith('m:custom_provider%3Asub2api:gpt-6.1-sol:'))
  assert.ok(nativeModel)
  const beforeModel = await request('members.get', { agentId: 'agent_2' })
  await command('members.runtime.set', { agentId: 'agent_2', expectedVersion: beforeModel.version,
    adapterKind: 'minimax-code-cli', model: { mode: 'explicit', modelId: nativeModel.id, options: {} },
    permissions: beforeModel.runtimeConfiguration.permissions })
  stage = 'explicit-native-model'
  const explicit = await turn(thread, 'Publish EXPLICIT_NATIVE_MODEL_OK through one public-only send and finish normally.')
  assert.deepEqual(explicit.binding, baseline.binding)
  assert.equal(explicit.events.find(event => event.method === 'agent_run.started')?.params.modelId, nativeModel.id)
  assert.ok(requests.filter(value => value.stage === stage).every(value => value.model === 'gpt-6.1-sol'))
  const beforeInvalid = await request('members.get', { agentId: 'agent_2' })
  const invalid = await request('members.runtime.set', { commandId: randomUUID(), command: { agentId: 'agent_2', expectedVersion: beforeInvalid.version,
    adapterKind: 'minimax-code-cli', model: { mode: 'explicit', modelId: nativeModel.id, options: { thinkingEffort: 'definitely-invalid' } },
    permissions: beforeInvalid.runtimeConfiguration.permissions } })
  assert.equal(invalid.status, 'applied', 'Saved configuration preserves exact intent; the live Host owns dynamic validation')
  stage = 'invalid-live-option'
  const invalidRun = await turn(thread, 'Publish INVALID_MODEL_OPTION_MUST_NOT_APPEAR.', { allowFailure: true })
  assert.equal(invalidRun.run.status, 'failed')
  assert.equal(invalidRun.run.last_error_code, 'runtime_model_option_unknown')
  assert.equal(requests.filter(value => value.stage === stage && !value.sessionTitle).length, 0)
  const restoreModel = await request('members.get', { agentId: 'agent_2' })
  await command('members.runtime.set', { agentId: 'agent_2', expectedVersion: restoreModel.version,
    adapterKind: 'minimax-code-cli', model: { mode: 'explicit', modelId: nativeModel.id, options: {} },
    permissions: restoreModel.runtimeConfiguration.permissions })
  await passed('native opaque model selection is acknowledged and the live Host rejects unsupported options before generation', { run: explicit.run.id, rejectedRun: invalidRun.run.id, modelId: nativeModel.id })
  stage = 'transient-retry'; fault = { kind: 'transient', remaining: 1 }
  const retried = await turn(thread, 'Append exactly one line ONCE to retry-effect.txt using a native tool. Publish RETRY_ONCE_OK via one public-only send and finish normally.', { timeout: 360_000 })
  assert.equal(await readFile(join(project, 'retry-effect.txt'), 'utf8'), 'ONCE\n')
  assert.ok(requests.some(value => value.stage === stage && value.injectedFault === 'transient'))
  assert.ok(requests.some(value => value.stage === stage && value.status === 200))
  assert.deepEqual(retried.binding, baseline.binding)
  await passed('a pre-output native transport retry causes exactly one file mutation and one public send', { run: retried.run.id })
  stage = 'deterministic-context-error'; fault = { kind: 'overflow', remaining: 1 }
  const rejected = await turn(thread, 'Publish OVERFLOW_MUST_NOT_APPEAR using one public-only send and finish normally.', { allowFailure: true })
  fault = null
  assert.equal(rejected.run.status, 'failed')
  assert.ok(!publicText(rejected).includes('OVERFLOW_MUST_NOT_APPEAR'))
  const overflowCalls = requests.filter(value => value.stage === stage && !value.sessionTitle)
  assert.equal(overflowCalls.length, 1, 'A deterministic main request overflow must not blindly replay accepted input')
  await passed('a deterministic main-request context rejection fails closed without input replay', { run: rejected.run.id,
    upstreamDifference: '0.6.12 does not automatically compact and replay a rejected main generation; checkpoint overflow is separately tested' })
  stage = 'after-context-error'
  const after = await turn(thread, 'Publish AFTER_CONTEXT_ERROR_OK with one public-only send and finish normally.')
  assert.ok(publicText(after).includes('AFTER_CONTEXT_ERROR_OK'))
  const profile = await request('members.get', { agentId: 'agent_2' })
  await command('members.runtime.set', { agentId: 'agent_2', expectedVersion: profile.version,
    adapterKind: 'minimax-code-cli', model: profile.runtimeConfiguration.model,
    permissions: { ...profile.runtimeConfiguration.permissions, values: { permission_mode: 'default', mode: 'default' } } })
  let approvalCount = 0
  stage = 'real-approval-deny'
  const denied = await turn(thread, `Use native bash once to run exactly: node -e 'require("node:fs").writeFileSync("native-denied.txt","FORBIDDEN")'. This is an isolated permission test: if execution is denied, do not retry or use another tool. Report denial through one public-only send and finish normally.`, {
    onTick: async () => {
      const snapshot = await request('camps.snapshot', { threadId: thread })
      for (const approval of snapshot.approvals.filter(value => value.status === 'pending')) {
        const target = JSON.stringify(approval).includes('native-denied.txt')
        const option = approval.options.find(value => value.kind === (target ? 'deny' : 'allow_once'))
        assert.ok(option)
        const resolved = await request('action.approvals.resolve', { commandId: randomUUID(), threadId: thread,
          approvalId: approval.id, expectedVersion: approval.version, optionId: option.optionId, reason: 'Isolated native deny qualification' })
        assert.notEqual(resolved.status, 'rejected'); if (target) approvalCount++
      }
    }
  })
  assert.ok(approvalCount > 0)
  assert.ok(!(await readdir(project)).includes('native-denied.txt'))
  await passed('the real model crosses native deny approval and leaves zero requested file effects', { run: denied.run.id, approvalCount })
  let cancelled = false
  stage = 'real-approval-cancel'
  const cancel = await turn(thread, `Run native bash exactly: node -e 'setTimeout(()=>require("node:fs").writeFileSync("approval-cancelled.txt","FORBIDDEN"),3000)'. Do not use an alternative tool or retry if cancelled.`, { allowFailure: true,
    onTick: async run => {
      if (cancelled) return
      const snapshot = await request('camps.snapshot', { threadId: thread })
      if (!snapshot.approvals.some(value => value.status === 'pending')) return
      const version = db.prepare('SELECT version FROM agent_run WHERE id=?').get(run.id).version
      const result = await command('agentRuns.cancel', { threadId: thread, agentRunId: run.id, expectedVersion: version })
      assert.notEqual(result.status, 'rejected'); cancelled = true
    }
  })
  assert.ok(cancelled); assert.equal(cancel.run.status, 'cancelled')
  await pause(5000)
  assert.ok(!(await readdir(project)).includes('approval-cancelled.txt'))
  await passed('cancelling a pending native approval reaches cancelled and prevents delayed mutation', { run: cancel.run.id })
  const current = await request('members.get', { agentId: 'agent_2' })
  await command('members.runtime.set', { agentId: 'agent_2', expectedVersion: current.version,
    adapterKind: 'minimax-code-cli', model: current.runtimeConfiguration.model, permissions: report.installation.defaults.permissions })
  const beforeQueue = new Set(threadRuns(thread).map(run => run.id))
  let queueReleased = false
  stage = 'queue-after-cancel'; fault = { kind: 'hold', remaining: 1 }
  const held = await turn(thread, 'Wait for the held provider response. Do not publish anything yet.', { allowFailure: true,
    onTick: async run => {
      if (queueReleased || !requests.some(value => value.stage === stage && value.injectedFault === 'hold')) return
      const sent = await request('thread.messages.send', { commandId: randomUUID(), threadId: thread,
        content: composerDocumentForAddress({ mode: 'explicit', agentIds: ['agent_2'] }, 'Publish QUEUE_FOLLOWUP_OK once with the bundled public-only send and finish normally.'),
        sourceAttachments: [], quotes: [], replyToThreadMessageId: null, deliveryMode: 'start',
        execution: { taskId: null, purpose: 'Queued follow-up qualification', completionRole: 'required' } })
      assert.equal(sent.commandResult.status, 'accepted')
      const version = db.prepare('SELECT version FROM agent_run WHERE id=?').get(run.id).version
      await command('agentRuns.cancel', { threadId: thread, agentRunId: run.id, expectedVersion: version })
      queueReleased = true
    }
  })
  assert.equal(held.run.status, 'cancelled'); fault = null
  const queueDeadline = Date.now() + 240_000
  let queued
  while (Date.now() < queueDeadline) {
    queued = threadRuns(thread).find(run => !beforeQueue.has(run.id) && run.id !== held.run.id)
    if (queued && ['succeeded', 'failed', 'cancelled'].includes(queued.status)) break
    await pause(200)
  }
  assert.equal(queued?.status, 'succeeded', JSON.stringify(queued))
  const queueSnapshot = await request('camps.snapshot', { threadId: thread })
  const queueMessages = queueSnapshot.messages.filter(message => message.sourceAgentRunId === queued.id && message.body.includes('QUEUE_FOLLOWUP_OK'))
  assert.equal(queueMessages.length, 1)
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM runtime_input_delivery WHERE agent_run_id=? AND status='accepted'").get(queued.id).n, 1)
  await passed('an ordinary input queued behind a cancelled Run starts once and receives one native accepted delivery', { cancelledRun: held.run.id, queuedRun: queued.id })
  stage = 'runtime-crash'; fault = { kind: 'hold', remaining: 1 }
  let killed = false
  const crashed = await turn(thread, 'Publish CRASH_MUST_NOT_APPEAR using one public-only send.', { allowFailure: true,
    onTick: async () => {
      if (killed || !requests.some(value => value.stage === stage && value.injectedFault === 'hold')) return
      const pids = await nativeChildren()
      assert.equal(pids.length, 1, 'The isolated failure phase has one native Host')
      process.kill(pids[0], 'SIGKILL'); killed = true
    }
  })
  fault = null; assert.ok(killed); assert.equal(crashed.run.status, 'failed')
  assert.ok(!publicText(crashed).includes('CRASH_MUST_NOT_APPEAR'))
  stage = 'after-runtime-crash'
  const recovered = await turn(thread, 'Publish AFTER_NATIVE_CRASH_OK through one public-only send and finish normally.')
  assert.ok(publicText(recovered).includes('AFTER_NATIVE_CRASH_OK'))
  assert.deepEqual(recovered.binding, baseline.binding)
  await passed('a native Host crash fails its accepted Run and the next Run recovers the exact original Session', { failedRun: crashed.run.id, recoveredRun: recovered.run.id, binding: recovered.binding })
  const wrapper = join(fixture, 'native-fault-wrapper.mjs'), modeFile = join(fixture, 'native-fault-mode')
  await writeFile(wrapper, `#!/usr/bin/env node
import {spawn} from 'node:child_process';import {readFileSync,writeFileSync} from 'node:fs';import {createInterface} from 'node:readline';
const mode=()=>{try{return readFileSync(${JSON.stringify(modeFile)},'utf8')}catch{return ''}};
const args=process.argv.slice(2),run=args.includes('--append-system-prompt-file');
const child=spawn(${JSON.stringify(nativeExecutable)},args,{stdio:['pipe','pipe','pipe'],env:process.env});
process.stdin.pipe(child.stdin);child.stderr.pipe(process.stderr);
if(args.includes('--version')&&mode()==='probe-hold'){
 child.stdout.resume();setInterval(()=>{},1000);
}else{
 createInterface({input:child.stdout}).on('line',line=>{if(run&&mode()==='malformed'){let value;try{value=JSON.parse(line)}catch{}if(value?.id!=null&&value.result){writeFileSync(${JSON.stringify(modeFile)},'');process.stdout.write('{malformed-native-frame\\n');return}}process.stdout.write(line+'\\n')});
 child.once('close',code=>process.exit(code??1));
}
process.on('SIGTERM',()=>{child.kill('SIGTERM');process.exit(0)});
`, { mode: 0o700 })
  await chmod(wrapper, 0o700)
  let startup = await request('runtime.startup.get', { runtimeKind: 'minimax-code-cli' })
  await request('runtime.startup.save', { runtimeKind: 'minimax-code-cli', expectedRevision: startup.revision, configuration: { programPath: wrapper, environment: [] } })
  await request('runtime.modelCatalog.open', { runtimeKind: 'minimax-code-cli', waitForRefresh: true }, 90_000)
  const protocolThread = await createThread('Linux malformed native protocol')
  stage = 'protocol-malformed'; await writeFile(modeFile, 'malformed')
  const malformed = await turn(protocolThread, 'Publish MALFORMED_MUST_NOT_APPEAR using one public-only send.', { allowFailure: true, timeout: 120_000 })
  assert.equal(malformed.run.status, 'failed'); assert.ok(!publicText(malformed).includes('MALFORMED_MUST_NOT_APPEAR'))
  assert.equal(requests.filter(value => value.stage === stage && !value.sessionTitle).length, 0)
  stage = 'after-protocol-error'; await writeFile(modeFile, '')
  const protocolRecovered = await turn(protocolThread, 'Publish AFTER_PROTOCOL_ERROR_OK with one public-only send and finish normally.')
  assert.ok(publicText(protocolRecovered).includes('AFTER_PROTOCOL_ERROR_OK'))
  await passed('a corrupted actual native ACP frame fails before model dispatch and a clean successor recovers', { failedRun: malformed.run.id, errorCode: malformed.run.last_error_code, recoveredRun: protocolRecovered.run.id })
  stage = 'probe-timeout'; await writeFile(modeFile, 'probe-hold')
  const beforeProbe = new Set(descendantsOf(await processTable(), core.pid))
  const probe = await request('runtime.product.check', { runtimeKind: 'minimax-code-cli' }, 120_000)
  report.probeTimeout = probe
  // Retained installations can include an older healthy executable. The check
  // result owns readiness of the newly selected startup program.
  assert.equal(probe.completed, true)
  assert.equal(probe.ready, false, 'A hung actual version probe must not advertise Ready')
  await pause(1000)
  assert.ok(descendantsOf(await processTable(), core.pid).every(pid => beforeProbe.has(pid)), 'The hung probe must leave no new child')
  await writeFile(modeFile, '')
  startup = await request('runtime.startup.get', { runtimeKind: 'minimax-code-cli' })
  await request('runtime.startup.save', { runtimeKind: 'minimax-code-cli', expectedRevision: startup.revision, configuration: { programPath: nativeExecutable, environment: [] } })
  await passed('a delayed actual CLI version result times out, clears Ready and reaps its probe process')
}
try {
  console.error(JSON.stringify({ channel: 'automatic_acceptance', phase, fixture, data, skills: report.skillLibraryRoot, mcp: report.mcpConfigPath, native }))
  await saveNative()
  await writeFile(join(project, 'existing.txt'), 'before\nkeep\n')
  if (phase === 'basics') {
    const path = join(native, 'skills/linux-user-qualification')
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'SKILL.md'), `---\nname: linux-user-qualification\ndescription: Isolated native user-source qualification.\n---\nReport ${userSkillMarker}.\n`)
  }
  if (compactionPhase) {
    const path = join(project, '.agents/skills/linux-compact-qualification')
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'SKILL.md'), `---\nname: linux-compact-qualification\ndescription: Compaction continuity qualification.\n---\nReport ${compactionSkillMarker}.\n`)
    const id = randomUUID()
    await writeFile(join(data, 'mcp.json'), JSON.stringify({ mcpServers: { compact_fixture: {
      command: process.execPath, args: [resolve(import.meta.dirname, '../crates/rovai-core/tests/fixtures/mcp-smoke-server.mjs')], env: { ROVAI_MCP_SMOKE_SOURCE: 'COMPACT_MCP' }
    } }, _rovai: { schemaVersion: 2, servers: { compact_fixture: { serverId: id, enabled: true, source: 'user', riskLevel: 'standard' } }, assignments: [{ serverId: id, agentId: 'agent_2' }] } }), { mode: 0o600 })
  }
  await startCore()
  db = new DatabaseSync(join(data, 'rovai.sqlite'), { readOnly: true })
  const startup = await request('runtime.startup.get', { runtimeKind: 'minimax-code-cli' })
  await request('runtime.startup.save', { runtimeKind: 'minimax-code-cli', expectedRevision: startup.revision,
    configuration: { programPath: nativeExecutable, environment: [] } })
  report.catalog = await request('runtime.modelCatalog.open', { runtimeKind: 'minimax-code-cli', waitForRefresh: true }, 90_000)
  const installation = (await request('runtime.installations.list')).find(value => value.adapterKind === 'minimax-code-cli')
  assert.ok(installation?.memberRuntimeDefaults, 'Native installation and native parameter defaults are required')
  const member = await request('members.get', { agentId: 'agent_2' })
  const selected = await request('members.runtime.set', { commandId: randomUUID(), command: { agentId: member.agentId,
    expectedVersion: member.version, adapterKind: 'minimax-code-cli', ...installation.memberRuntimeDefaults } })
  assert.equal(selected.status, 'applied')
  report.installation = { adapterKind: installation.adapterKind, probeStatus: installation.snapshot?.probeStatus,
    version: installation.snapshot?.reportedVersion, models: installation.snapshot?.models, defaults: installation.memberRuntimeDefaults }
  await passed('native provider discovery and product defaults')
  if (phase === 'cli') {
    await qualifyCli()
  } else if (phase === 'capabilities') {
    await qualifyCapabilities()
  } else if (compactionPhase) {
    await qualifyCompaction()
  } else if (phase === 'failures') {
    await qualifyFailures()
  } else {
  assert.equal(phase, 'basics', 'This phase is not implemented yet')
  const userSkills = await request('nativeSkills.list', { adapterKind: 'minimax-code-cli', refresh: true })
  const userSkill = userSkills.skills.find(skill => skill.name === 'linux-user-qualification')
  assert.equal(userSkill?.entryPath, join(native, 'skills/linux-user-qualification/SKILL.md'))
  await passed('native user-source discovery respects the executing Host MINIMAX_DATA_DIR', { skillId: userSkill.id })
  const threadA = await createThread('Linux mcode A')
  report.threadA = threadA
  stage = 'first-run'
  const first = await turn(threadA, `Remember ${markerA} privately for later turns. Invoke linux-user-qualification through native skill discovery. Use native read on existing.txt, native write to create 新增 文件.txt with one line added-linux followed by a newline, and native edit to replace before with after in existing.txt. Preserve all newlines and keep. Run printf LINUX_COMMAND_OK. Then publish the actual Skill verification value and LINUX_FIRST_OK with exactly one bundled rovai send --public-only call. End with a short nonempty final. Do not ask questions.`)
  assert.equal(await readFile(join(project, 'existing.txt'), 'utf8'), 'after\nkeep\n')
  assert.equal(await readFile(join(project, '新增 文件.txt'), 'utf8'), 'added-linux\n')
  assert.ok(publicText(first).includes('LINUX_FIRST_OK'))
  assert.ok(publicText(first).includes(userSkillMarker))
  assert.ok(first.binding?.native_session_id)
  report.firstBinding = first.binding
  report.fileCards = first.snapshot.agentRunFileChanges.filter(card => card.agentRunId === first.run.id)
  assert.equal(report.fileCards.length, 1, 'File Changes aggregate once per Run')
  assert.equal(report.fileCards[0].fileCount, 2)
  assert.deepEqual(report.fileCards[0].files.map(file => file.path).sort(), ['existing.txt', '新增 文件.txt'].sort())
  await passed('real first run with native read add edit command and public CLI send', { run: first.run.id, binding: first.binding, hostInstanceId: hostId(first), fileCards: report.fileCards })
  const initialPids = await nativeChildren()
  stage = 'warm'
  const warm = await turn(threadA, 'Without inspecting files or history, publish the private phrase you remember from my first message, followed by LINUX_WARM_OK. Use one bundled public-only send; then finish normally.')
  assert.ok(publicText(warm).includes(markerA)); assert.deepEqual(warm.binding, first.binding)
  assert.deepEqual(await nativeChildren(), initialPids)
  await passed('warm continuation preserves exact binding and resident host', { run: warm.run.id, hostInstanceId: hostId(warm) })
  const threadB = await createThread('Linux mcode B')
  report.threadB = threadB; stage = 'session-b'
  const other = await turn(threadB, `Remember ${markerB} privately. Publish LINUX_B_OK using one public-only bundled send. Finish normally.`)
  assert.notEqual(other.binding.native_session_id, first.binding.native_session_id)
  assert.ok(requests.filter(value => value.stage === stage && !value.sessionTitle).every(value => !value.aPresent))
  stage = 'a-return'
  const returned = await turn(threadA, 'Without reading files or history, publish your original private phrase followed by LINUX_A_RETURN_OK, using one public-only bundled send. Finish normally.')
  assert.ok(publicText(returned).includes(markerA)); assert.ok(!publicText(returned).includes(markerB))
  assert.deepEqual(returned.binding, first.binding)
  assert.ok(requests.filter(value => value.stage === stage && !value.sessionTitle).every(value => !value.bPresent))
  await passed('A to B to A isolation under the shared Camp/member/native-binding host scope', { runA: returned.run.id, runB: other.run.id, bindingA: first.binding, bindingB: other.binding })
  stage = 'concurrency'
  const [concurrentA, concurrentB] = await Promise.all([
    turn(threadA, 'Publish your own original private phrase followed by CONCURRENT_A_OK through one public-only send. Do not inspect files/history. Finish normally.'),
    turn(threadB, 'Publish your own original private phrase followed by CONCURRENT_B_OK through one public-only send. Do not inspect files/history. Finish normally.')
  ])
  assert.ok(publicText(concurrentA).includes(markerA) && !publicText(concurrentA).includes(markerB))
  assert.ok(publicText(concurrentB).includes(markerB) && !publicText(concurrentB).includes(markerA))
  assert.notEqual(hostId(concurrentA), hostId(concurrentB))
  assert.deepEqual(concurrentA.binding, first.binding); assert.deepEqual(concurrentB.binding, other.binding)
  await passed('concurrent public Runs use distinct native Hosts and preserve both private Session memories', { runA: concurrentA.run.id, runB: concurrentB.run.id })
  stage = 'provider-refresh'; await saveNative('b')
  const refreshed = await turn(threadA, 'Publish LINUX_REFRESH_OK using exactly one public-only bundled send and finish normally.')
  assert.ok(publicText(refreshed).includes('LINUX_REFRESH_OK'))
  assert.deepEqual(refreshed.binding, first.binding)
  assert.equal(hostId(refreshed), hostId(returned))
  assert.ok(requests.some(value => value.stage === stage && value.route === 'b' && !value.sessionTitle))
  await passed('official native provider address and key refresh on the next run without session drift', { run: refreshed.run.id, hostInstanceId: hostId(refreshed) })
  stage = 'cold-resume'; await core.stop(); await startCore()
  const cold = await turn(threadA, 'Without inspecting files or history, publish your original private phrase followed by LINUX_COLD_OK, using one public-only bundled send. Finish normally.')
  assert.ok(publicText(cold).includes(markerA)); assert.deepEqual(cold.binding, first.binding)
  assert.ok(publicText(cold).includes('LINUX_COLD_OK'))
  await passed('Core restart resumes the exact original native session and memory', { run: cold.run.id, binding: cold.binding })
  assert.ok(requests.filter(value => value.stage !== 'setup' && !value.sessionTitle).every(value => value.charterCount === 1))
  await passed('every observed root-agent model request keeps one Charter; native title-generation calls stay separate')
  }
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error).replaceAll(upstreamKey, '[REDACTED]')
  console.error(report.error)
} finally {
  if (core) {
    const table = await processTable(); const descendants = descendantsOf(table, core.pid)
    report.shutdown = await core.stop()
    const live = new Set((await processTable()).map(process => process.pid))
    report.descendantsRemaining = descendants.filter(pid => live.has(pid))
    if (report.descendantsRemaining.length) { report.status = 'failed'; report.error = 'Qualification child survived Core shutdown' }
    delete report.shutdown.stderrTail
  }
  if (db) {
    report.usage = db.prepare('SELECT agent_run_id,prompt_input_total_tokens,uncached_input_tokens,cache_read_tokens,cache_write_tokens,output_tokens,reasoning_output_tokens,cost_amount_decimal,cost_currency,usage_quality FROM runtime_usage_run_summary').all()
    report.usageReconciliation = report.turns.map(turn => {
      const actual = report.usage.find(row => row.agent_run_id === turn.runId)
      const fields = { uncached_input_tokens: 'input', cache_read_tokens: 'cacheRead', cache_write_tokens: 'cacheWrite', output_tokens: 'output' }
      const comparisons = Object.entries(fields).map(([field, source]) => {
        const values = turn.nativeUsage.map(row => row[source]).filter(Number.isSafeInteger)
        const expected = values.length ? values.reduce((sum, value) => sum + value, 0) : null
        return { field, expected, actual: actual?.[field] ?? null, matches: expected === (actual?.[field] ?? null) }
      })
      return { runId: turn.runId, stage: turn.stage, comparisons, unreportedCostRemainsUnknown: actual?.cost_amount_decimal == null && actual?.cost_currency == null }
    })
    if (report.status === 'passed' && (phase === 'basics' || compactionPhase)
      && report.usageReconciliation.some(row => !row.unreportedCostRemainsUnknown
        || (report.turns.find(turn => turn.runId === row.runId)?.status === 'succeeded' && row.comparisons.some(value => !value.matches)))) {
      report.status = 'failed'; report.error = 'Native root-agent numeric Usage does not reconcile with Core'
    }
  }
  let databaseContainsProviderKey = false
  for (const name of ['rovai.sqlite', 'rovai.sqlite-wal']) {
    try {
      const bytes = await readFile(join(data, name))
      databaseContainsProviderKey ||= [upstreamKey, syntheticKeyA, syntheticKeyB].some(key => bytes.includes(Buffer.from(key)))
    } catch (error) { if (error.code !== 'ENOENT') { report.status = 'failed'; report.error = String(error) } }
  }
  report.secretScan = { coreDatabaseContainsProviderKey: databaseContainsProviderKey, reportContainsUpstreamKey: JSON.stringify(report).includes(upstreamKey) }
  if (databaseContainsProviderKey) { report.status = 'failed'; report.error = 'Provider credential entered Core storage' }
  if (report.secretScan.reportContainsUpstreamKey) { report.status = 'failed'; report.error = 'Upstream credential entered private report'; throw new Error(report.error) }
  db?.close()
  for (const server of ownedServers) { server.closeAllConnections(); await new Promise(resolveClose => server.close(resolveClose)) }
  broker.closeAllConnections(); await new Promise(resolveClose => broker.close(resolveClose))
  await persist()
  console.log(JSON.stringify({ fixture, phase, status: report.status, cases: report.cases.map(value => ({ name: value.name, status: value.status })), error: report.error }))
}
if (report.status !== 'passed') process.exitCode = 1
