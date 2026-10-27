// Opt-in real-provider extension of smoke-hermes-native-session.mjs. No production hooks.
import assert from 'node:assert/strict'
import {createServer} from 'node:http'
import {spawn, execFileSync} from 'node:child_process'
import {mkdtemp, mkdir, writeFile, readFile, cp, realpath, symlink} from 'node:fs/promises'
import {join, resolve} from 'node:path'
import {tmpdir, homedir} from 'node:os'
import {createHash, randomUUID} from 'node:crypto'
import {DatabaseSync} from 'node:sqlite'
import {parse} from 'yaml'
import {startQualificationCore} from './qualification-core.mjs'
import {composerDocumentForAddress} from './create-configured-camp.mjs'

export async function runRealModelProbe(officialSource, python, secondModel) {
  assert(secondModel, 'Supply a second real model ID supported by the configured provider')
  const repository = resolve(import.meta.dirname, '../..')
  const originalHome = join(homedir(), '.hermes')
  const originalConfig = await readFile(join(originalHome, 'config.yaml'), 'utf8')
  const nativeConfig = parse(originalConfig)
  const providerName = nativeConfig.model.provider, firstModel = nativeConfig.model.default
  const provider = nativeConfig.providers[providerName]
  assert.equal(provider.transport, 'codex_responses', 'This probe currently covers Responses providers')
  assert.notEqual(firstModel, secondModel)
  const dotenv = Object.fromEntries((await readFile(join(originalHome, '.env'), 'utf8')).split('\n')
    .filter(l => l.includes('=') && !l.trim().startsWith('#'))
    .map(l => {const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^(['"])(.*)\1$/, '$2')]}))
  const credential = process.env[provider.api_key_env] || dotenv[provider.api_key_env] || provider.api_key
  assert(credential && provider.base_url, 'The existing provider needs a credential and endpoint')
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rovai-hermes-real-model-')))
  const userHome = join(root, 'user'), nativeHome = join(userHome, '.hermes')
  const project = join(root, 'project'), data = join(root, 'data'), source = join(root, 'hermes-agent')
  for (const path of [nativeHome, project, data, join(userHome, '.local/bin')]) await mkdir(path, {recursive: true, mode: 0o700})
  await symlink(join(repository, 'target/debug/rovai'), join(userHome, '.local/bin/rovai'))
  execFileSync('git', ['clone', '--shared', '--no-hardlinks', officialSource, source], {stdio: 'pipe'})
  await cp(join(officialSource, 'install-stamp.json'), join(source, 'install-stamp.json'))
  const nativeCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: source, encoding: 'utf8'}).trim()
  const rovaiCommit = execFileSync('git', ['rev-parse', 'HEAD'], {cwd: repository, encoding: 'utf8'}).trim()
  const sh = s => "'" + s.replaceAll("'", "'\\''") + "'"
  const hash = s => createHash('sha256').update(s).digest('hex')
  const requests = [], runs = [], checks = {}, sessions = {}, threads = {}, current = {}
  let core, gateway, database, gatewayLog = '', failure
  // Forward real responses byte-for-byte. Credentials stay in this test process,
  // never in fixture configuration, request records, logs or committed evidence.
  const relay = createServer(async (req, res) => {
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const bytes = Buffer.concat(chunks), body = bytes.length ? JSON.parse(bytes) : null
      const input = body?.input, latestUser = Array.isArray(input) ? input.findLast(v => v.role === 'user') : null
      const latest = JSON.stringify(latestUser ?? '')
      const label = [...latest.matchAll(/REAL_PROBE:([AB][0-9])/g)].at(-1)?.[1] ?? null
      const record = {label, model: body?.model, path: req.url, status: null, completed: false,
        initialRules: latest.includes('[Rovai 协作规则]'), updateRules: latest.includes('[Rovai 协作规则更新]'),
        selectedFileInInput: latest.includes('project-shared/SKILL.md'),
        skillReadInHistory: JSON.stringify(input ?? []).includes('SKILL_MARKER_REAL_84'), toolNames: []}
      if (body) requests.push(record)
      assert(requests.length <= 45, 'Real-provider request budget exceeded')
      const upstream = await fetch(provider.base_url.replace(/\/$/, '') + req.url.replace(/^\/v1/, ''), {
        method: req.method, headers: {'content-type': 'application/json', authorization: 'Bearer ' + credential},
        ...(bytes.length ? {body: bytes} : {}), signal: AbortSignal.timeout(180000)})
      record.status = upstream.status
      res.writeHead(upstream.status, {'content-type': upstream.headers.get('content-type') || 'application/json'})
      let stream = ''
      for await (const chunk of upstream.body) {
        res.write(chunk); stream += Buffer.from(chunk).toString('utf8')
        let end
        while ((end = stream.indexOf('\n')) >= 0) {
          const line = stream.slice(0, end); stream = stream.slice(end + 1)
          if (!line.startsWith('data: ')) continue
          try {
            const event = JSON.parse(line.slice(6))
            if (event.type === 'response.completed') {
              record.completed = true; record.responseModel = event.response?.model
              record.usage = Object.fromEntries(['input_tokens', 'output_tokens', 'total_tokens']
                .filter(k => typeof event.response?.usage?.[k] === 'number').map(k => [k, event.response.usage[k]]))
            }
            if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') record.toolNames.push(event.item.name)
          } catch {}
        }
      }
      res.end()
    } catch (error) {failure ??= String(error); res.destroy(error)}
  })
  await new Promise(done => relay.listen(0, '127.0.0.1', done))
  const config = {model: {provider: providerName, default: firstModel}, providers: {[providerName]: {
    base_url: `http://127.0.0.1:${relay.address().port}/v1`, api_key_env: 'HERMES_REAL_PROBE_KEY',
    transport: 'codex_responses', models: [firstModel], discover_models: false}},
    updates: {check: false}, platform_toolsets: {acp: ['terminal', 'file', 'skills']},
    session_title: {enabled: false}, agent: {max_turns: 10, reasoning_effort: 'low'},
    skills: {project_discovery: false, disabled: ['project-shared'], external_dirs: ['not-a-menu-root']}}
  await writeFile(join(nativeHome, 'config.yaml'), JSON.stringify(config), {mode: 0o600})
  await writeFile(join(nativeHome, '.env'), 'HERMES_REAL_PROBE_KEY=relay-only-no-authority\n', {mode: 0o600})
  const skillRoots = [join(nativeHome, 'skills'), join(userHome, '.agents/skills'), join(project, '.hermes/skills'), join(project, '.agents/skills')]
  const skillNames = ['user-hermes', 'user-shared', 'project-hermes', 'project-shared']
  for (let i = 0; i < skillRoots.length; i++) {
    const folder = join(skillRoots[i], skillNames[i]); await mkdir(folder, {recursive: true})
    await writeFile(join(folder, 'SKILL.md'), `---\nname: ${skillNames[i]}\ndescription: Isolated real-model acceptance skill\n---\nFor this isolated test only, the verification token is SKILL_MARKER_REAL_84. When explicitly selected, read this file and append that exact token to the task's evidence file and public Send. Do not read credentials or change any configuration.\n`)
  }
  await mkdir(join(nativeHome, 'not-a-menu-root/external-only'), {recursive: true})
  await writeFile(join(nativeHome, 'not-a-menu-root/external-only/SKILL.md'), '---\nname: external-only\ndescription: Not a fixed menu root\n---\n')
  const baseline = hash(await readFile(join(nativeHome, 'config.yaml')))
  const bootstrap = `import sys; sys.path.insert(0, ${JSON.stringify(source)}); sys._hermes_pin_default_home = True; import hermes_bootstrap; import runpy; runpy.run_module('hermes_cli.main', run_name='__main__', alter_sys=True)`
  const launcher = join(root, 'hermes'), tap = join(root, 'acp-observer.mjs'), acpLog = join(root, 'acp.jsonl')
  // Test-only transparent stdio observer: records closed metadata, never changes a message.
  await writeFile(tap, `import {spawn} from 'node:child_process';import {appendFileSync} from 'node:fs';
const child=spawn(process.argv[2],process.argv.slice(3),{stdio:['pipe','pipe','inherit']});
const buffers={out:'',in:''};const methods=new Map();
function observe(direction,bytes){buffers[direction]+=bytes;let end;while((end=buffers[direction].indexOf('\\n'))>=0){const line=buffers[direction].slice(0,end);buffers[direction]=buffers[direction].slice(end+1);try{const m=JSON.parse(line);if(direction==='in'&&m.method)methods.set(m.id,m.method);const p=m.params||{};const r=m.result||{};const method=m.method||methods.get(m.id);if(!['session/new','session/resume','session/load','session/set_model','session/set_mode','session/prompt'].includes(method))continue;appendFileSync(${JSON.stringify(acpLog)},JSON.stringify({pid:process.pid,direction,id:m.id,method,sessionId:p.sessionId||r.sessionId,modelId:p.modelId,modeId:p.modeId,currentModelId:r.models?.currentModelId,currentModeId:r.modes?.currentModeId,catalog:r.models?.availableModels?.map(v=>v.modelId),errorCode:m.error?.code})+'\\n');}catch{}}}
process.stdin.on('data',b=>observe('in',b));child.stdout.on('data',b=>observe('out',b));process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stdin.on('error',()=>{});child.on('exit',(code)=>process.exit(code??1));for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>child.kill(signal));
`)
  await writeFile(launcher, `#!/bin/sh\ncase "$*" in *' acp') exec ${sh(process.execPath)} ${sh(tap)} ${sh(python)} -I -B -c ${sh(bootstrap)} "$@";; *) exec ${sh(python)} -I -B -c ${sh(bootstrap)} "$@";; esac\n`, {mode: 0o700})
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('ROVAI_') && !k.startsWith('HERMES_')))
  Object.assign(env, {HOME: userHome, HERMES_HOME: nativeHome, HERMES_DISABLE_LAZY_INSTALLS: '1', PATH: '/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin'})
  const options = {coreExecutable: join(repository, 'target/debug/rovai-core'), dataDirectory: data, workingDirectory: repository,
    runtimeCacheDirectory: join(root, 'runtime-cache'), mcpConfigPath: join(root, 'mcp.json'),
    environmentOverrides: {...Object.fromEntries(Object.keys(process.env).filter(k => k.startsWith('ROVAI_') || k.startsWith('HERMES_')).map(k => [k, undefined])), ...env, ROVAI_HERMES_BIN: launcher}}
  await writeFile(join(root, 'mcp.json'), '{"mcpServers":{}}')
  const alive = child => child && child.exitCode === null && child.signalCode === null
  const exists = async path => {try {await readFile(path); return true} catch {return false}}
  async function until(fn, timeout = 360000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {if (failure) throw Error(failure); const result = await fn(); if (result) return result; await new Promise(r => setTimeout(r, 200))}
    throw Error('Isolated real-model deadline exceeded')
  }
  const row = (sql, ...args) => database.prepare(sql).get(...args)
  const acp = async () => (await readFile(acpLog, 'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse)
  async function configure(agentId, model, mode) {
    const member = await core.request('members.get', {agentId})
    const result = await core.request('members.runtime.set', {commandId: randomUUID(), command: {agentId, expectedVersion: member.version,
      adapterKind: 'hermes-cli', model, permissions: {adapterKind: 'hermes-cli', schemaVersion: 1, values: {permission_mode: mode}}}})
    assert.equal(result.status, 'applied', JSON.stringify(result))
  }
  async function run(label, model, expectedSetters, selectedSkill = null) {
    const name = label[0], agentId = name === 'A' ? 'agent_2' : 'agent_3', threadId = threads[name]
    const previous = row('SELECT COALESCE(MAX(rowid),0) AS n FROM agent_run WHERE camp_id=?', threadId).n
    const before = (await acp()).length
    const marker = 'REAL_OK_' + label + (selectedSkill ? ':SKILL_MARKER_REAL_84' : '')
    const body = `REAL_PROBE:${label}\nThis is an authorized isolated integration test. ${selectedSkill ? 'Read the explicitly selected Skill file and obtain its verification token.' : ''} Use native tools to write ${label}.txt in the current project with ${selectedSkill ? 'the verification token from that Skill' : JSON.stringify(marker)}. Then directly execute rovai send --public-only --body ${selectedSkill ? "'REAL_OK_" + label + ":<verification token>' (replace the placeholder with the exact token read)" : sh(marker)}. Do not send to other agents. Do not modify settings or inspect credentials. After successful Send, finish. Keep the task short.`
    const content = composerDocumentForAddress({mode: 'explicit', agentIds: [agentId]}, body)
    if (selectedSkill) content.segments.push({kind: 'atom', atom: {type: 'skill', skillId: selectedSkill.id, nameAtSend: selectedSkill.name}})
    const accepted = await core.request('thread.messages.send', {commandId: randomUUID(), threadId, content, sourceAttachments: [], quotes: [], replyToThreadMessageId: null, deliveryMode: 'start', execution: {taskId: null, purpose: 'Real model Hermes acceptance', completionRole: 'required'}})
    assert.notEqual(accepted.commandResult?.status ?? accepted.status, 'rejected', JSON.stringify(accepted))
    console.log('submitted', label)
    const r = await until(async () => {
      const r = row('SELECT id,status,execution_epoch,public_runtime_failure_json AS failure FROM agent_run WHERE camp_id=? AND rowid>? ORDER BY rowid DESC LIMIT 1', threadId, previous)
      if (r?.status === 'waiting') {
        const snapshot = await core.request('threads.snapshot', {threadId})
        for (const approval of snapshot.approvals.filter(a => a.status === 'pending')) {
          const option = approval.options.find(o => o.kind === 'allow_once'); assert(option)
          await core.request('action.approvals.resolve', {commandId: randomUUID(), threadId, approvalId: approval.id, expectedVersion: approval.version, optionId: option.optionId, reason: 'Explicitly authorized isolated real-model task'})
        }
      }
      return r && ['succeeded', 'failed', 'cancelled'].includes(r.status) && r
    })
    const runRecord = {label, runId: r.id, status: r.status, expectedModel: model}
    runs.push(runRecord)
    assert.equal(r.status, 'succeeded', JSON.stringify(r))
    const message = row("SELECT id,author_id,source_agent_run_id FROM camp_message WHERE camp_id=? AND body=? AND author_type='agent'", threadId, marker)
    assert(message, label + ' missing exact public Send'); assert.equal(message.author_id, agentId); assert.equal(message.source_agent_run_id, r.id)
    assert.equal(row("SELECT COUNT(*) AS n FROM camp_message WHERE camp_id=? AND body=? AND author_type='agent'", threadId, marker).n, 1)
    const sid = row('SELECT native_session_id FROM conversation WHERE camp_id=? AND agent_id=?', threadId, agentId).native_session_id
    if (sessions[name]) assert.equal(sid, sessions[name], 'Continue the original Session'); sessions[name] = sid
    const traffic = (await acp()).slice(before), prompt = traffic.find(v => v.direction === 'in' && v.method === 'session/prompt' && v.sessionId === sid)
    assert(prompt)
    const own = traffic.filter(v => v.pid === prompt.pid)
    const setters = own.filter(v => v.direction === 'in' && ['session/set_model', 'session/set_mode'].includes(v.method))
    assert.deepEqual(setters.map(v => v.method), expectedSetters)
    const attached = own.find(v => v.direction === 'out' && ['session/new', 'session/resume', 'session/load'].includes(v.method))
    assert(attached?.currentModelId)
    current[name] = setters.find(v => v.method === 'session/set_model')?.modelId ?? attached.currentModelId
    const evidence = requests.filter(v => v.label === label && v.model)
    assert(evidence.length); assert(evidence.every(v => v.model === model)); assert(evidence.some(v => v.completed))
    assert.equal(evidence[0].initialRules, label.endsWith('0'))
    if (selectedSkill) {assert(evidence[0].selectedFileInInput); assert(evidence.some(v => v.skillReadInHistory))}
    assert((await readFile(join(project, label + '.txt'), 'utf8')).includes(selectedSkill ? 'SKILL_MARKER_REAL_84' : marker))
    const delivery = row("SELECT hermes_rules_delivery_kind AS kind FROM runtime_input_delivery WHERE agent_run_id=? AND status='accepted' ORDER BY rowid LIMIT 1", r.id)
    assert.equal(delivery.kind, label.endsWith('0') ? 'initial' : 'none')
    Object.assign(runRecord, {nativeSessionId: sid, messageId: message.id, attachedModelId: attached.currentModelId, nativeModelId: current[name], setters: setters.map(v => ({method: v.method, modelId: v.modelId, modeId: v.modeId})), rules: delivery.kind, modelRequests: evidence.length, catalogContainsTarget: attached.catalog?.includes(current[name])})
    console.log('passed', label, model)
  }
  console.log(JSON.stringify({channel: 'isolated automatic real-model acceptance', root, userHome, nativeHome, data, skillLibrary: join(data, 'managed-skill-library'), nativeCommit, models: [firstModel, secondModel]}))
  try {
    gateway = spawn(launcher, ['--profile', 'default', 'gateway', 'run', '--quiet'], {cwd: project, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']})
    gateway.stdout.on('data', d => gatewayLog += d); gateway.stderr.on('data', d => gatewayLog += d)
    await until(async () => {if (!alive(gateway)) throw Error('Fixture Gateway exited; see private log'); return exists(join(nativeHome, 'gateway.lock'))})
    core = startQualificationCore(options); await core.request('health.check')
    await until(async () => !(await core.request('runtime.status.get')).runtimeAvailability.some(r => r.runtimeKind === 'hermes-cli' && r.discovery.discoveryStatus === 'detecting'))
    await core.request('runtime.startup.save', {runtimeKind: 'hermes-cli', configuration: {programPath: launcher, environment: []}, expectedRevision: 0})
    assert((await core.request('runtime.product.check', {runtimeKind: 'hermes-cli'})).ready)
    for (const name of ['A', 'B']) {
      const agentId = name === 'A' ? 'agent_2' : 'agent_3'
      await configure(agentId, {mode: 'runtime_default'}, 'dont_ask')
      const created = await core.request('threads.create', {commandId: randomUUID(), name: 'Real Hermes ' + name, workspace: {projectPath: project}, memberAgentIds: [agentId], defaultLeadAgentId: agentId, collaborationMode: 'peer'})
      assert.equal(created.status, 'applied'); threads[name] = created.payload.threadId
    }
    database = new DatabaseSync(join(data, 'rovai.sqlite'), {readOnly: true})
    const global = await core.request('nativeSkills.list', {adapterKind: 'hermes-cli', refresh: true})
    assert.deepEqual(global.skills.map(v => v.name).filter(v => skillNames.includes(v)).sort(), skillNames.slice(0, 2).sort())
    assert(!global.skills.some(v => v.name === 'external-only'))
    const candidates = await core.request('skills.candidates', {threadId: threads.A, refresh: true})
    const native = candidates.skills.filter(v => v.source === 'native')
    assert.deepEqual(native.map(v => v.name).filter(v => skillNames.includes(v)).sort(), [...skillNames].sort())
    assert(!native.some(v => v.name === 'external-only'))
    const selected = native.find(v => v.name === 'project-shared')
    const preview = await core.request('nativeSkills.read', {skillId: selected.id})
    assert(JSON.stringify(preview).includes('SKILL_MARKER_REAL_84')); checks.fourRootsAndPreview = true
    await Promise.all([run('A0', firstModel, ['session/set_mode'], selected), run('B0', firstModel, ['session/set_mode'])])
    assert.notEqual(sessions.A, sessions.B); checks.concurrentRealMembers = true
    const namedChoice = current.A
    await core.stop(); core = null; assert(alive(gateway))
    core = startQualificationCore(options); await core.request('health.check')
    // Keep the complete named choice: native resume may omit the custom provider.
    await configure('agent_2', {mode: 'explicit', modelId: namedChoice, options: {}}, 'dont_ask')
    await run('A1', firstModel, [])
    assert.equal(runs.find(v => v.label === 'A1').attachedModelId, `custom:${firstModel}`)
    assert.notEqual(namedChoice, `custom:${firstModel}`)
    const nextId = namedChoice.slice(0, -firstModel.length) + secondModel
    await configure('agent_2', {mode: 'explicit', modelId: nextId, options: {}}, 'default')
    await run('A2', secondModel, ['session/set_model', 'session/set_mode'])
    await run('A3', secondModel, [])
    assert.equal(runs.find(v => v.label === 'A2').setters.find(v => v.method === 'session/set_model').modelId, nextId)
    assert.equal(runs.find(v => v.label === 'A2').catalogContainsTarget, false, 'Explicit model should be outside the attachment picker')
    checks.originalSessionColdResume = true; checks.customProviderSettingsSkipped = true; checks.explicitUnlistedModelUsed = true
    checks.explicitUntrustedSkillFileUsed = true
    await core.stop(); core = null; assert(alive(gateway)); checks.sharedGatewaySurvivesCore = true
    assert.equal(hash(await readFile(join(nativeHome, 'config.yaml'))), baseline)
    assert.equal(hash(await readFile(join(originalHome, 'config.yaml'))), hash(originalConfig))
    assert.equal(execFileSync('git', ['diff', '--exit-code'], {cwd: source, encoding: 'utf8'}), '')
    checks.configurationUnchanged = true
  } catch (error) {failure ??= String(error); throw error}
  finally {
    if (core) await core.stop().catch(() => {})
    database?.close()
    if (alive(gateway)) {gateway.kill('SIGTERM'); await new Promise(r => setTimeout(r, 3000)); if (alive(gateway)) gateway.kill('SIGKILL')}
    relay.closeAllConnections(); await new Promise(r => relay.close(r))
    await writeFile(join(root, 'report.json'), JSON.stringify({rovaiCommit, nativeCommit, checks, runs, requests, failure}, null, 2), {mode: 0o600})
    await writeFile(join(root, 'gateway.log'), gatewayLog, {mode: 0o600})
    console.log('Evidence:', root)
  }
}
