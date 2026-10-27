// Real native CLI + production Core + a local scripted provider.
// This owns the dispatch/terminal seam; it is not real-model qualification.
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { startQualificationCore } from './lib/qualification-core.mjs'
import { composerDocumentForAddress } from './lib/create-configured-camp.mjs'

const [adapter, native, fixture] = process.argv.slice(2)
const duplicateQuestionnaires = process.argv.includes('--duplicate-questionnaires')
assert.ok(['claude-code-cli', 'copilot-cli', 'kimi-code-cli', 'qwen-code', 'zcode-app', 'opencode-cli'].includes(adapter))
const zcode = adapter === 'zcode-app', opencode = adapter === 'opencode-cli'
assert.ok(isAbsolute(native) && isAbsolute(fixture), 'Pass absolute native executable and fresh fixture paths')
const repo = resolve(import.meta.dirname, '..')
const data = join(fixture, 'data'), project = join(fixture, 'project'), nativeData = join(fixture, 'native')
await mkdir(fixture) // Deliberately refuse to reuse an existing acceptance directory.
for (const path of [data, project, nativeData]) await mkdir(path)
const report = { adapter, evidenceKind: 'real-cli-scripted-provider', duplicateQuestionnaires, fixture, cases: [], requests: [] }
const coreExecutable = join(repo, 'target', 'debug', 'rovai-core')
report.coreSha256 = createHash('sha256').update(await readFile(coreExecutable)).digest('hex')
console.error(JSON.stringify({ channel: 'automatic acceptance', data, skills: join(data, 'managed-skill-library'), mcp: join(data, 'mcp.json'), nativeData }))
let stage = 'setup', step = 0, core, db, threadId
const quote = value => `'${value.replaceAll("'", "'\\''")}'`
const nativeQuestion = adapter === 'kimi-code-cli' ? 'AskUserQuestion' : 'ask_user_question'
const disabled = ['claude-code-cli', 'copilot-cli', 'qwen-code', 'zcode-app', 'opencode-cli'].includes(adapter)
assert.ok(!duplicateQuestionnaires || !disabled, 'Duplicate injection requires an exposed questionnaire tool')
const questionInput = { questions: [{ question: 'Which color?', header: 'Color', options: [
  { label: 'Blue', description: 'Blue fixture' }, { label: 'Green', description: 'Green fixture' }
], multiSelect: false }] }
if (adapter === 'kimi-code-cli') {
  delete questionInput.questions[0].multiSelect
  questionInput.questions[0].multi_select = false
}
const server = createServer(async (req, res) => {
  try {
    if (req.method === 'GET') {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'rovai-control', object: 'model' }] }))
      return
    }
    let raw = ''; for await (const part of req) raw += part
    const body = JSON.parse(raw)
    if (req.url.includes('count_tokens')) { res.end('{"input_tokens":100}'); return }
    const anthropic = req.url.includes('/messages')
    const tools = body.tools?.map(tool => anthropic ? tool : tool.function) ?? []
    const names = tools.map(tool => tool.name)
    report.requests.push({ stage, path: req.url, tools: names,
      toolResults: body.messages?.filter(message => message.role === 'tool').map(message => message.content) ?? [] })
    let call
    // Native title/summary requests may have no tools and do not advance the
    // scripted business turn.
    if (stage !== 'setup' && tools.length > 0) {
      if (disabled) {
        assert.ok(!names.some(name => ['AskUserQuestion', 'ask_user', 'ask_user_question', 'question'].includes(name)), 'Disabled questionnaire was exposed to the model')
      }
      const currentStep = step++
      if ((!disabled && stage === 'ASK' && currentStep === 0)
          || (!disabled && stage === 'SEND_ASK' && currentStep === 1)) {
        assert.ok(names.includes(nativeQuestion), `Missing native tool ${nativeQuestion}`)
        call = { name: nativeQuestion, input: questionInput }
      } else if (currentStep === 0 && stage !== 'ASK') {
        const shell = tools.find(tool => /^(bash|shell|run_shell_command)$/i.test(tool.name))
        assert.ok(shell, `Missing ordinary shell: ${names.join(',')}`)
        const properties = (shell.input_schema ?? shell.parameters).properties
        const commandKey = Object.keys(properties).find(key => key.toLowerCase() === 'command')
        assert.ok(commandKey, 'Missing native command argument')
        call = { name: shell.name, input: { [commandKey]: `${quote(process.execPath)} ${quote(join(project, 'publish.mjs'))} ${quote(stage)}`,
          ...(properties.description ? { description: 'Publish the isolated acceptance result' } : {}) } }
      }
    }
    const text = 'Controlled native questionnaire acceptance completed.'
    if (anthropic) {
      const content = call ? [{ type: 'tool_use', id: `toolu_${stage}_${step}`, name: call.name, input: call.input }]
        : [{ type: 'text', text }]
      const message = { id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: body.model,
        content, stop_reason: call ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 20 } }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        const event = (type, value) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`)
        event('message_start', { message: { ...message, content: [], stop_reason: null } })
        event('content_block_start', { index: 0, content_block: call ? { ...content[0], input: {} } : { type: 'text', text: '' } })
        event('content_block_delta', { index: 0, delta: call ? { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } : { type: 'text_delta', text } })
        event('content_block_stop', { index: 0 })
        event('message_delta', { delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 20 } })
        event('message_stop', {})
        res.end()
      } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(message)) }
    } else {
      const toolCalls = call ? [{ index: 0, id: `call_${stage}_${step}`, type: 'function',
        function: { name: call.name, arguments: JSON.stringify(call.input) } }] : undefined
      const response = { id: `chatcmpl_${randomUUID()}`, model: body.model, created: 1,
        choices: [{ index: 0, message: { role: 'assistant', content: call ? null : text, ...(call ? { tool_calls: toolCalls } : {}) }, finish_reason: call ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }
      if (body.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        res.write(`data: ${JSON.stringify({ ...response, object: 'chat.completion.chunk', choices: [{ index: 0,
          delta: response.choices[0].message, finish_reason: null }] })}\n\n`)
        res.write(`data: ${JSON.stringify({ ...response, object: 'chat.completion.chunk', choices: [{ index: 0,
          delta: {}, finish_reason: response.choices[0].finish_reason }] })}\n\ndata: [DONE]\n\n`)
        res.end()
      } else { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ ...response, object: 'chat.completion' })) }
    }
  } catch (error) {
    report.providerError = error.stack
    res.writeHead(500, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { message: error.message } }))
  }
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const baseUrl = `http://127.0.0.1:${server.address().port}`
const environment = zcode || opencode
  ? { HOME: nativeData, XDG_CONFIG_HOME: join(nativeData, 'config'), XDG_DATA_HOME: join(nativeData, 'data'),
    XDG_STATE_HOME: join(nativeData, 'state'), XDG_CACHE_HOME: join(nativeData, 'cache'),
    ...(zcode ? { ZCODE_DATA_BASE_DIR: nativeData, ZCODE_STORAGE_DIR: join(nativeData, '.zcode') }
      : { OPENCODE_DISABLE_AUTOUPDATE: 'true', MSGPACKR_NATIVE_ACCELERATION_DISABLED: 'true',
        OPENCODE_MODELS_PATH: join(nativeData, 'models.json') }) }
  : adapter === 'claude-code-cli'
  ? { CLAUDE_CONFIG_DIR: nativeData, ANTHROPIC_API_KEY: 'fixture-only', ANTHROPIC_BASE_URL: baseUrl,
    ANTHROPIC_MODEL: 'claude-sonnet-4-6', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_AUTOUPDATER: '1' }
  : adapter === 'copilot-cli'
    ? { COPILOT_HOME: nativeData, COPILOT_CACHE_HOME: join(nativeData, 'cache'), COPILOT_PROVIDER_BASE_URL: `${baseUrl}/v1`,
      COPILOT_PROVIDER_TYPE: 'openai', COPILOT_PROVIDER_WIRE_API: 'completions', COPILOT_PROVIDER_API_KEY: 'fixture-only',
      COPILOT_MODEL: 'rovai-control', COPILOT_PROVIDER_MODEL_ID: 'gpt-4.1', COPILOT_OFFLINE: 'true' }
    : adapter === 'qwen-code'
      ? { QWEN_HOME: nativeData, OPENAI_API_KEY: 'fixture-only', OPENAI_BASE_URL: `${baseUrl}/v1`, OPENAI_MODEL: 'rovai-control' }
      : { KIMI_CODE_HOME: nativeData }
if (adapter === 'kimi-code-cli') await writeFile(join(nativeData, 'config.toml'), `default_model = "control"
[providers.control]
type = "openai"
base_url = "${baseUrl}/v1"
api_key = "fixture-only"
[models.control]
provider = "control"
model = "rovai-control"
max_context_size = 128000
max_output_size = 4096
capabilities = ["tool_use"]
`)
if (adapter === 'qwen-code') await writeFile(join(nativeData, 'settings.json'), JSON.stringify({
  security: { auth: { selectedType: 'openai' } }, model: { name: 'rovai-control' }, telemetry: { enabled: false }
}))
if (adapter === 'copilot-cli') await writeFile(join(nativeData, 'settings.json'), '{"autoUpdate":false}')
if (zcode) {
  const provider = { providerId: 'custom:fixture', providerName: 'Fixture', enabled: true, config: {
    group: 'standard-personal', access: { type: 'api-key', apiKey: 'fixture-only' },
    api: { type: 'openai-chat-completions', baseUrl: `${baseUrl}/v1` }, personalModelIds: ['rovai-control'] } }
  await mkdir(join(nativeData, '.zcode/v2'), { recursive: true })
  await writeFile(join(nativeData, '.zcode/v2/provider_config.json'), JSON.stringify({ schemaVersion: 1, config: {
    providerConfigRules: { providerRules: [provider] },
    modelConfigRules: { providerModelRules: [], manualProviderModelRules: [] },
    defaultModelSelection: { providerId: provider.providerId, modelId: 'rovai-control', options: { reasoningLevel: 'disabled' } }
  } }))
}
if (opencode) {
  await writeFile(join(nativeData, 'models.json'), '{}')
  environment.OPENCODE_CONFIG_CONTENT = JSON.stringify({ update: 'disable', model: 'fixture/rovai-control',
    providers: { fixture: { name: 'Fixture', package: 'aisdk:@ai-sdk/openai-compatible',
      settings: { apiKey: 'fixture-only', baseURL: `${baseUrl}/v1` },
      models: { 'rovai-control': { name: 'Fixture', capabilities: { tools: true, input: ['text'], output: ['text'] },
        cost: { input: 0, output: 0 }, limit: { context: 100000, output: 10000 } } } } } })
}
await writeFile(join(data, 'mcp.json'), '{"mcpServers":{}}')
await writeFile(join(project, 'README.md'), '# Isolated questionnaire acceptance\n')
await writeFile(join(project, 'publish.mjs'), `import {writeFileSync} from 'node:fs';import {spawnSync} from 'node:child_process';
const stage=process.argv[2];writeFileSync(stage+'.txt','effect preserved');
const child=spawnSync('rovai',['send','--public-only','--body','Fixture '+stage],{stdio:'inherit'});
if(child.error)throw child.error;process.exitCode=child.status??1;
`)
for (const args of [['init', '-b', 'main'], ['config', 'user.name', 'Rovai Smoke'],
  ['config', 'user.email', 'smoke@rovai.local'], ['add', '.'], ['commit', '-m', 'fixture']]) {
  execFileSync('git', args, { cwd: project, stdio: 'ignore' })
}
// Native wire capture; optional duplicate fault injection is reported separately.
const shim = join(fixture, 'native-cli')
await writeFile(shim, `#!${process.execPath}
import{spawn}from'node:child_process';import{appendFileSync}from'node:fs';import{createInterface}from'node:readline';
const log=${JSON.stringify(join(fixture, 'wire.jsonl'))};
const duplicateQuestionnaires=${duplicateQuestionnaires};
appendFileSync(log,JSON.stringify({argv:process.argv.slice(2)})+'\\n');
const child=spawn(${JSON.stringify(native)},process.argv.slice(2),{stdio:['pipe','pipe','inherit']});
for(const [source,destination,direction] of [[process.stdin,child.stdin,'in'],[child.stdout,process.stdout,'out']]){
createInterface({input:source}).on('line',line=>{let duplicate=false;try{const value=JSON.parse(line);duplicate=duplicateQuestionnaires&&direction==='out'&&value.method==='session/request_permission';if((value.id!==undefined&&value.method)||value.type==='control_request'||(value.id!==undefined&&value.result?.outcome)){appendFileSync(log,JSON.stringify({direction,value,duplicateInjected:duplicate})+'\\n')}}catch{};destination.write(line+'\\n');if(duplicate)destination.write(line+'\\n')}).on('close',()=>{if(direction==='in')child.stdin.end()})}
child.on('exit',(code)=>process.exit(code??1));process.on('SIGTERM',()=>child.kill('SIGTERM'));
`, { mode: 0o700 })
if (zcode) {
  // Observe the official kernel without replacing its admitted App identity.
  // The native parser retains ownership of stdin flow; no responses are injected.
  const hook = join(fixture, 'trace.cjs')
  await writeFile(hook, `if(process.argv.some(a=>a.endsWith('/zcode.cjs'))&&process.argv.includes('app-server')){
const fs=require('node:fs'),file=${JSON.stringify(join(fixture, 'wire.jsonl'))};
const record=(direction,value)=>fs.appendFileSync(file,JSON.stringify({pid:process.pid,direction,value})+'\\n',{mode:0o600});
const observe=(direction)=>{let pending='';return chunk=>{pending+=chunk.toString();let n;while((n=pending.indexOf('\\n'))>=0){const line=pending.slice(0,n);pending=pending.slice(n+1);try{const v=JSON.parse(line);if(v.method)record(direction,v);}catch{}}}};
const incoming=observe('in'),outgoing=observe('out'),emit=process.stdin.emit,write=process.stdout.write;
process.stdin.emit=function(name,...args){if(name==='data')incoming(args[0]);return Reflect.apply(emit,this,[name,...args])};
process.stdout.write=function(chunk,...args){outgoing(chunk);return Reflect.apply(write,this,[chunk,...args])};
}`)
  environment.NODE_OPTIONS = `--require=${hook}`
}
const runs = () => db.prepare('SELECT id,status,last_error_code FROM agent_run WHERE camp_id=? ORDER BY created_at,id').all(threadId)
const startCore = () => startQualificationCore({
  coreExecutable, dataDirectory: data, workingDirectory: project,
  runtimeCacheDirectory: join(fixture, 'cache'), mcpConfigPath: join(data, 'mcp.json'),
  // Native HOME belongs to the Runtime startup scope. Changing the Core's
  // HOME would invalidate its already prepared attachment root.
  environmentOverrides: zcode || opencode
    ? Object.fromEntries(Object.entries(environment).filter(([name]) => name !== 'HOME')) : environment
})
async function turn(name, expected) {
  stage = name; step = 0
  const before = runs().length
  const sentBefore = db.prepare("SELECT COUNT(*) AS n FROM camp_message WHERE camp_id=? AND author_type='agent'").get(threadId).n
  const result = await core.request('thread.messages.send', { commandId: randomUUID(), threadId,
    content: composerDocumentForAddress({ mode: 'explicit', agentIds: ['agent_2'] }, `Controlled fixture ${name}`),
    sourceAttachments: [], quotes: [], replyToThreadMessageId: null, deliveryMode: 'start',
    execution: { taskId: null, purpose: 'Native questionnaire acceptance', completionRole: 'required' } })
  assert.equal(result.commandResult.status, 'accepted', JSON.stringify(result))
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    const current = runs()
    if (current.length > before && ['succeeded', 'failed', 'cancelled'].includes(current.at(-1).status)) break
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const run = runs().at(-1)
  assert.equal(run?.status, expected, JSON.stringify({ run, providerError: report.providerError, requests: report.requests.slice(-3) }))
  if (expected === 'failed') assert.equal(run.last_error_code, 'runtime_questionnaire_unsupported')
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM approval').get().n, 0, 'Questionnaires must not create Approvals')
  if (name !== 'ASK') {
    assert.equal(await readFile(join(project, `${name}.txt`), 'utf8'), 'effect preserved')
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM camp_message WHERE camp_id=? AND author_type='agent'").get(threadId).n - sentBefore, 1)
  }
  const binding = db.prepare('SELECT native_session_id FROM conversation WHERE camp_id=? AND agent_id=?').get(threadId, 'agent_2')
  report.cases.push({ name, status: 'passed', run, sessionId: binding.native_session_id })
}
try {
  report.version = execFileSync(zcode ? process.execPath : native,
    zcode ? [resolve(native, '../../Resources/glm/zcode.cjs'), '--version'] : ['--version'],
    { env: { ...process.env, ...environment }, encoding: 'utf8', timeout: 15_000 }).trim()
  if (opencode) assert.match(report.version, /^(?:opencode )?v?2\./, 'This smoke owns the V2 permission dialect')
  core = startCore()
  await core.request('health.check')
  const startup = await core.request('runtime.startup.get', { runtimeKind: adapter })
  await core.request('runtime.startup.save', { runtimeKind: adapter, expectedRevision: startup.revision,
    configuration: { programPath: zcode ? native : shim, environment: [] } })
  report.discovery = await core.request('runtime.product.check', { runtimeKind: adapter }, 90_000)
  const installation = (await core.request('runtime.installations.list')).find(item => item.adapterKind === adapter)
  assert.equal(installation?.pathState, 'valid', JSON.stringify(installation) ?? 'No installation')
  // Formal execution owns lazy protocol validation; an optional catalog probe
  // is neither admission nor evidence that a questionnaire was disabled.
  const member = await core.request('members.get', { agentId: 'agent_2' })
  const defaults = installation.memberRuntimeDefaults
  assert.ok(defaults)
  const values = adapter === 'claude-code-cli' ? { permission_mode: 'bypassPermissions' }
    : adapter === 'copilot-cli' ? { allow_all: 'on' }
      : adapter === 'kimi-code-cli' || zcode ? { permission_mode: 'yolo' }
        : opencode ? { permission: 'allow' } : { approval_mode: 'yolo' }
  const configured = await core.request('members.runtime.set', { commandId: randomUUID(), command: {
    agentId: 'agent_2', expectedVersion: member.version, adapterKind: adapter, ...defaults,
    permissions: { ...defaults.permissions, values },
    ...(zcode || opencode ? { environment: { expectedRevision: 0, json: JSON.stringify(environment) } } : {})
  } })
  assert.equal(configured.status, 'applied', JSON.stringify(configured))
  const created = await core.request('threads.create', { commandId: randomUUID(), name: `${adapter} questionnaire`,
    workspace: { projectPath: project }, memberAgentIds: ['agent_2'], defaultLeadAgentId: 'agent_2', collaborationMode: 'peer' })
  assert.equal(created.status, 'applied'); threadId = created.payload.threadId
  db = new DatabaseSync(join(data, 'rovai.sqlite'), { readOnly: true })
  await turn('NORMAL', 'succeeded')
  if (!disabled) { await turn('ASK', 'failed'); await turn('SEND_ASK', 'failed') }
  await turn('FOLLOWUP', 'succeeded')
  report.beforeRestart = await core.stop()
  core = startCore()
  await core.request('health.check')
  await turn('AFTER_RESTART', 'succeeded')
  assert.equal(new Set(report.cases.map(item => item.sessionId)).size, 1, 'Genuine later input must continue the same native Session')
  const wire = (await readFile(join(fixture, 'wire.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  if (zcode) {
    const sessions = wire.filter(entry => entry.direction === 'in' && ['session/create', 'session/resume'].includes(entry.value?.method))
    assert.ok(sessions.some(entry => entry.value.method === 'session/create'))
    assert.ok(sessions.some(entry => entry.value.method === 'session/resume'))
    for (const entry of sessions) assert.deepEqual(entry.value.params.toolDenylist, ['AskUserQuestion'])
    report.sessionRequests = sessions
  }
  report.businessToolLists = report.requests.filter(request => request.stage !== 'setup' && request.tools.length > 0).map(request => request.tools)
  assert.ok(report.businessToolLists.length >= report.cases.length, 'Each Run must reach the actual model tool boundary')
  const questions = wire.filter(entry => entry.direction === 'out' && ['session/request_permission', 'interaction/requestUserInput'].includes(entry.value?.method))
  if (disabled) {
    assert.equal(questions.length, 0, 'Disabled questionnaire must not reach the permission transport')
  } else {
    assert.equal(questions.length, 2, 'Both ask and send-then-ask must reach the real permission transport')
    for (const question of questions) {
      const responses = wire.filter(entry => entry.direction === 'in' && entry.value.id === question.value.id && entry.value.result?.outcome)
      assert.equal(responses.length, 1, 'One native cancellation per questionnaire')
      assert.deepEqual(responses[0].value.result, { outcome: { outcome: 'cancelled' } })
    }
  }
  report.questionnaireReceipts = questions.length
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error.stack
  process.exitCode = 1
} finally {
  if (db) db.close()
  if (core) report.coreDiagnostics = await core.stop()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await writeFile(join(fixture, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ status: report.status, adapter, version: report.version, fixture, error: report.error }))
}
