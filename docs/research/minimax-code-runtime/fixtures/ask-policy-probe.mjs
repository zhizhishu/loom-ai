// Source-patch qualification only. This does not install or patch the user's CLI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { createInterface } from 'node:readline'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parse, stringify } from 'yaml'

const cli = resolve(process.argv[2])
const root = await mkdtemp(join(tmpdir(), 'rovai-minimax-source-policy-'))
const native = join(root, 'native'), project = join(root, 'project')
await mkdir(native, { mode: 0o700 }); await mkdir(project, { mode: 0o700 })
const requests = [], cases = [], children = new Set()
let stage = 'setup'
const servers = ['a', 'b'].map(label => createServer(async (req, res) => {
  let raw = ''; for await (const part of req) raw += part
  const body = JSON.parse(raw)
  if (req.url.endsWith('/input_tokens')) {
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"input_tokens":100}'); return
  }
  requests.push({ stage, label, protocolPath: req.url, tools: (body.tools ?? []).map(t => t.function?.name ?? t.name),
    expectedKey: req.headers.authorization === `Bearer synthetic-${label}` })
  const response = { id: 'synthetic-reply', object: 'chat.completion', model: 'fixture',
    choices: [{ index: 0, message: { role: 'assistant', content: 'POLICY_OK' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }
  if (req.url.endsWith('/responses')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    let sequence = 0
    const event = (type, fields) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...fields })}\n\n`)
    const item = { id: 'msg_fixture', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'POLICY_OK', annotations: [] }] }
    const complete = { id: 'resp_fixture', object: 'response', model: 'fixture', status: 'completed', output: [item], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15, input_tokens_details: { cached_tokens: 0 } } }
    event('response.created', { response: { ...complete, status: 'in_progress', output: [] } })
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', content: [] } })
    event('response.content_part.added', { item_id: item.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } })
    event('response.output_text.delta', { item_id: item.id, output_index: 0, content_index: 0, delta: 'POLICY_OK' })
    event('response.output_item.done', { output_index: 0, item })
    event('response.completed', { response: complete }); res.end()
  } else if (body.stream) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ ...response, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'POLICY_OK' }, finish_reason: null }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ ...response, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`)
    res.end('data: [DONE]\n\n')
  } else { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(response)) }
}))
for (const server of servers) await new Promise(r => server.listen(0, '127.0.0.1', r))
const configPath = join(native, 'config.yaml')
const config = { defaultModel: 'custom_provider:fixture/fixture', defaultLightModel: 'custom_provider:fixture/fixture',
  sessionTitle: { enabled: false }, askUser: { enabled: true },
  custom_provider: { fixture: { name: 'fixture', kind: 'custom', enabled: true, api: 'openai-completions',
    options: { baseURL: `http://127.0.0.1:${servers[0].address().port}/v1`, apiKey: 'synthetic-a', authMode: 'api-key' },
    models: { fixture: { limit: { context: 65536, output: 2048 }, reasoning: false } } } } }
await writeFile(configPath, stringify(config), { mode: 0o600 })
function start(disabled) {
  const env = { ...process.env, MINIMAX_DATA_DIR: native, MAVIS_DATA_DIR: native }
  if (disabled) env.MCODE_DISABLE_ASK_USER = '1'; else delete env.MCODE_DISABLE_ASK_USER
  const child = spawn(process.execPath, [cli, 'acp'], { cwd: project, env, stdio: ['pipe', 'pipe', 'ignore'] })
  children.add(child)
  const pending = new Map(); let next = 1
  createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line)
    const entry = pending.get(message.id)
    if (entry) {
      clearTimeout(entry.timer); pending.delete(message.id)
      message.error ? entry.reject(new Error(JSON.stringify(message.error))) : entry.resolve(message.result)
    } else if (message.id != null && message.method === 'session/request_permission') {
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'cancelled' } } }) + '\n')
    }
  })
  const request = (method, params) => new Promise((resolveRequest, reject) => {
    const id = next++, timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout: ${method}`)) }, 30_000)
    pending.set(id, { resolve: resolveRequest, reject, timer })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const stop = async () => {
    child.stdin.end()
    const timer = setTimeout(() => child.kill('SIGTERM'), 10_000)
    await new Promise(r => child.once('exit', r)); clearTimeout(timer); children.delete(child)
  }
  return { request, stop, pid: child.pid }
}
async function initialize(host) {
  const result = await host.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'rovai-policy-probe', version: '1' } })
  assert.equal(result.agentInfo.name, 'minimax-code')
  return result.agentInfo.version
}
async function prompt(host, sessionId, name, hidden, provider) {
  stage = name
  const start = requests.length
  const result = await host.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply POLICY_OK without tools.' }] })
  assert.equal(result.stopReason, 'end_turn')
  const observations = requests.slice(start)
  assert.ok(observations.length)
  for (const observation of observations) {
    assert.equal(observation.tools.includes('ask_user'), !hidden)
    assert.equal(observation.tools.includes('request_feature_enable'), !hidden)
    assert.equal(observation.label, provider); assert.equal(observation.expectedKey, true)
    assert.ok(observation.tools.includes('bash'))
  }
  assert.equal(parse(await readFile(configPath, 'utf8')).askUser.enabled, true)
  cases.push({ name, status: 'passed', pid: host.pid, sessionId, calls: observations.length })
}
const report = { root, cli, status: 'running', cases, requests }
try {
  let host = start(false); report.version = await initialize(host)
  const original = await host.request('session/new', { cwd: project, mcpServers: [] })
  await prompt(host, original.sessionId, 'ordinary-native-default', false, 'a'); await host.stop()
  host = start(true); await initialize(host)
  await host.request('session/load', { sessionId: original.sessionId, cwd: project, mcpServers: [] })
  await prompt(host, original.sessionId, 'disabled-exact-resume', true, 'a')
  const updated = parse(await readFile(configPath, 'utf8'))
  updated.custom_provider.fixture.options = { ...updated.custom_provider.fixture.options,
    baseURL: `http://127.0.0.1:${servers[1].address().port}/v1`, apiKey: 'synthetic-b' }
  await writeFile(configPath, stringify(updated), { mode: 0o600 })
  await host.request('session/set_config_option', { sessionId: original.sessionId, configId: 'permissionMode', value: 'bypassPermissions' })
  await prompt(host, original.sessionId, 'warm-permission-provider-refresh', true, 'b'); await host.stop()
  host = start(true); await initialize(host)
  await host.request('session/load', { sessionId: original.sessionId, cwd: project, mcpServers: [] })
  await prompt(host, original.sessionId, 'disabled-cold-resume', true, 'b'); await host.stop()
  host = start(false); await initialize(host)
  await host.request('session/load', { sessionId: original.sessionId, cwd: project, mcpServers: [] })
  await prompt(host, original.sessionId, 'ordinary-native-after-host-policy', false, 'b'); await host.stop()
  report.status = 'passed'
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1 }
finally {
  for (const child of children) child.kill('SIGTERM')
  for (const server of servers) await new Promise(r => server.close(r))
  await writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
  console.log(JSON.stringify({ root, status: report.status, cases, error: report.error }))
}
