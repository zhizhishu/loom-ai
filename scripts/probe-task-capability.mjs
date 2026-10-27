// Isolated functional acceptance, not a Context Quality Gate or a new campaign.
// node scripts/probe-task-capability.mjs <new-absolute-root> <core> <codex> <frozen-config> [preflight]
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { access, cp, mkdir, readFile, rename, rmdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { frozenMemberRuntimeDifferences, startQualificationCore } from './lib/qualification-core.mjs'
import { composerDocumentForAddress } from './lib/create-configured-camp.mjs'

const [root, executable, nativeExecutable, configurationPath, mode = 'live'] = process.argv.slice(2)
assert.ok([root, executable, nativeExecutable, configurationPath].every(isAbsolute))
assert.ok(['preflight', 'live'].includes(mode))
await access(join(dirname(executable), 'rovai'))
await mkdir(root, { mode: 0o700 })
const data = join(root, 'core'), project = join(root, 'project'), native = join(root, 'native')
for (const path of [data, project, native]) await mkdir(path, { mode: 0o700 })
// Copy only native launch/auth configuration, never sessions or the daily Core DB.
const nativeSource = process.env.CODEX_HOME ?? join(homedir(), '.codex')
for (const name of ['auth.json', 'config.toml']) {
  try { await access(join(nativeSource, name)) } catch { continue }
  await cp(join(nativeSource, name), join(native, name))
}
const frozen = JSON.parse(await readFile(configurationPath, 'utf8')).team.find(member => member.agentId === 'agent_1')
assert.equal(frozen.adapterKind, 'codex-cli')
const report = { mode, startedAt: new Date().toISOString(), status: 'running',
  coreSha256: createHash('sha256').update(await readFile(executable)).digest('hex'),
  isolation: { data, skills: join(data, 'managed-skill-library'), mcp: join(data, 'mcp.json'), native, project },
  phases: [] }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let core, db, threadId
const exists = async name => { try { await access(join(project, name)); return true } catch { return false } }
const persist = () => writeFile(join(root, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 })
const runs = () => db.prepare('SELECT id,status,execution_epoch,last_error_code FROM agent_run WHERE camp_id=? ORDER BY created_at,id').all(threadId)
async function wait(check, label, timeout = 180_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await check()
    if (result) return result
    const failure = db && threadId && runs().find(run => ['succeeded', 'failed', 'cancelled'].includes(run.status))
    if (failure) throw new Error(`${label}: ${JSON.stringify(failure)}`)
    await sleep(100)
  }
  throw new Error(`Timed out: ${label}`)
}

// The real Agent starts this helper with its inherited CLI binding. Only the
// parent controls the preference via Host IPC; the Agent cannot change it.
await writeFile(join(project, 'task-switch-agent.mjs'), `
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { access, readFile, writeFile } from 'node:fs/promises';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const cli = args => { const result = spawnSync('rovai', args, {encoding:'utf8', timeout:15000}); if(result.error) throw result.error; return {code:result.status,stdout:result.stdout,stderr:result.stderr}; };
const contextPath = process.env.ROVAI_CLI_CONTEXT;
assert.ok(contextPath);
const shell = process.env.SHELL || '/bin/sh';
const loginCliPath = spawnSync(shell,['-lc','command -v rovai'],{encoding:'utf8',timeout:10000}).stdout.trim();
const loginCliVersion = spawnSync(shell,['-lc','rovai --version'],{encoding:'utf8',timeout:10000}).stdout.trim();
await writeFile('agent-ready.json', JSON.stringify({pid:process.pid,contextPath,boundCli:process.env.ROVAI_AGENT_CLI,boundCliVersion:spawnSync(process.env.ROVAI_AGENT_CLI,['--version'],{encoding:'utf8'}).stdout.trim(),plainCliVersion:cli(['--version']).stdout.trim(),loginCliPath,loginCliVersion}));
for(const [name, enabled] of [['off',false],['on',true],['off-again',false],['same-value-repair',true],['auto-retry',true]]) {
  if(name !== 'off') { const end=Date.now()+180000; for(;;) { try {await access(name+'.go');break;} catch {} if(Date.now()>end) throw new Error('Host did not release '+name); await delay(50); } }
  const context = JSON.parse(await readFile(contextPath,'utf8'));
  const help = cli(['--help']), taskHelp = cli(['task','--help']), list = cli(['task','list']);
  await writeFile(name+'.attempt.json',JSON.stringify({help,taskHelp,list}));
  assert.equal(help.code,0); assert.equal(help.stdout.includes('rovai task'),enabled);
  assert.equal(taskHelp.code, enabled?0:2); assert.equal(list.code, enabled?0:2);
  if(!enabled) assert.match(list.stdout,/task.feature_disabled/);
  const send = cli(['send','--public-only','--body','Task capability acceptance: '+name]);
  assert.equal(send.code,0,send.stdout+send.stderr);
  await writeFile(name+'.json',JSON.stringify({name,enabled,pid:process.pid,processId:context.processId,leaseId:context.lease.leaseId,help,taskHelp,list,send}));
}
const end=Date.now()+180000; for(;;) { try {await access('finish.go');break;} catch {} if(Date.now()>end) throw new Error('Host did not release finish'); await delay(50); }
await writeFile('agent-finished.json',JSON.stringify({pid:process.pid,completed:true}));
console.log('TASK_SWITCH_ACCEPTANCE_COMPLETE');
`, { mode: 0o600 })

try {
  console.error(`Automatic acceptance: ${JSON.stringify(report.isolation)}`)
  core = startQualificationCore({ coreExecutable: executable, dataDirectory: data, workingDirectory: project,
    runtimeCacheDirectory: join(root, 'cache'), mcpConfigPath: join(data, 'mcp.json'),
    environmentOverrides: { CODEX_HOME: native, ROVAI_CODEX_BIN: nativeExecutable } })
  await core.request('health.check')
  const startup = await core.request('runtime.startup.get', { runtimeKind: 'codex-cli' })
  await core.request('runtime.startup.save', { runtimeKind: 'codex-cli', expectedRevision: startup.revision,
    configuration: { programPath: nativeExecutable, environment: [] } })
  await core.request('runtime.discovery.rescan', { interactiveShell: false })
  report.readiness = await core.request('runtime.product.check', { runtimeKind: 'codex-cli' }, 120_000)
  const before = await core.request('members.get', { agentId: frozen.agentId })
  const configured = await core.request('members.runtime.set', { commandId: randomUUID(), command: {
    agentId: frozen.agentId, expectedVersion: before.version, adapterKind: frozen.adapterKind,
    model: frozen.model, permissions: frozen.permissions } })
  assert.equal(configured.status, 'applied', JSON.stringify(configured))
  const profile = await core.request('members.get', { agentId: frozen.agentId })
  report.frozen = { adapterKind: frozen.adapterKind, model: frozen.model, permissions: frozen.permissions }
  report.actual = { runtimeReadiness: profile.runtimeReadiness, runtimeConfiguration: profile.runtimeConfiguration }
  report.frozenDifferences = frozenMemberRuntimeDifferences(frozen, profile)
  await persist()
  console.error(`Frozen Runtime differences: ${JSON.stringify(report.frozenDifferences)}`)
  if (mode === 'live') {
    // Current profile reads are static/advisory. This functional probe relies on
    // the real Host launch below; it does not relax the frozen campaign's gate.
    assert.equal(report.readiness.ready, true)
    assert.ok(['ready', 'installed_unverified'].includes(profile.runtimeReadiness.status))
    assert.deepEqual(profile.runtimeReadiness.blockers, [])
    assert.equal(profile.runtimeConfiguration.adapterKind, frozen.adapterKind)
    assert.equal(profile.runtimeConfiguration.model.modelId, frozen.model.modelId)
    for (const [key, value] of Object.entries(frozen.model.options)) assert.equal(profile.runtimeConfiguration.model.options[key], value)
    for (const [key, value] of Object.entries(frozen.permissions.values)) assert.equal(profile.runtimeConfiguration.permissions.values[key], value)
    db = new DatabaseSync(join(data, 'rovai.sqlite'), { readOnly: true })
    const created = await core.request('threads.create', { commandId: randomUUID(), name: 'Running Task capability acceptance',
      workspace: { projectPath: project }, memberAgentIds: ['agent_1'], defaultLeadAgentId: 'agent_1', collaborationMode: 'peer' })
    assert.equal(created.status, 'applied')
    threadId = created.payload.threadId
    report.threadId = threadId
    assert.equal((await core.request('preferences.tasks.get')).enabled, false)
    const sent = await core.request('thread.messages.send', { commandId: randomUUID(), threadId,
      content: composerDocumentForAddress({ mode: 'explicit', agentIds: ['agent_1'] },
        '这是隔离功能验收。使用普通命令工具，不指定 login 参数，不修改 PATH，不使用 CLI 绝对路径。先执行 command -v rovai > plain-cli-path.txt 和 rovai --version > plain-cli-version.txt，再实际执行 node ./task-switch-agent.mjs 并等待它正常结束；脚本会等待 Host 切换开关。不要改脚本、不要创建任务、不要提前停止命令。若工具提前返回会话 ID，继续等待同一进程。脚本成功后直接执行 rovai send --public-only --body TASK_SWITCH_DONE，然后结束。失败时保留原始错误并停止，不绕过正常命令入口。'),
      sourceAttachments: [], quotes: [], replyToThreadMessageId: null,
      execution: { taskId: null, purpose: 'Running Task capability acceptance', completionRole: 'required' } })
    assert.equal(sent.commandResult.status, 'accepted', JSON.stringify(sent))
    async function phase(name) {
      await wait(() => exists(`${name}.json`), name)
      const evidence = JSON.parse(await readFile(join(project, `${name}.json`), 'utf8'))
      const activeRuns = runs()
      assert.equal(activeRuns.length, 1)
      assert.equal(activeRuns[0].status, 'running')
      const previous = report.phases[0]
      if (previous) for (const key of ['pid', 'processId', 'leaseId']) assert.equal(evidence[key], previous[key])
      report.phases.push({ ...evidence, activeRuns })
      await persist()
      console.error(`Passed phase: ${name}`)
    }
    const enable = async enabled => assert.equal((await core.request('preferences.tasks.set', { enabled })).enabled, enabled)
    const release = name => writeFile(join(project, `${name}.go`), 'go')
    await wait(() => exists('agent-ready.json'), 'normal CLI resolution')
    const { contextPath, ...cliResolution } = JSON.parse(await readFile(join(project, 'agent-ready.json'), 'utf8'))
    assert.ok(contextPath.startsWith(`${data}/runtime/builtin-tools/`))
    report.cliResolution = { ...cliResolution, commandPath: (await readFile(join(project, 'plain-cli-path.txt'), 'utf8')).trim(), commandVersion: (await readFile(join(project, 'plain-cli-version.txt'), 'utf8')).trim() }
    await persist()
    assert.equal(report.cliResolution.plainCliVersion, report.cliResolution.boundCliVersion, 'Plain CLI must match the Run-bound version')
    assert.equal(report.cliResolution.commandVersion, report.cliResolution.boundCliVersion, 'Normal Runtime command must resolve the bound version')
    await phase('off')
    await enable(true); await release('on'); await phase('on')
    await enable(false); await release('off-again'); await phase('off-again')
    const savedContext = `${contextPath}.saved`
    async function injectFailure() { await rename(contextPath, savedContext); await mkdir(contextPath) }
    async function restore() { await rmdir(contextPath); await rename(savedContext, contextPath) }
    const projection = async () => JSON.parse(await readFile(contextPath, 'utf8'))
    await injectFailure()
    await enable(true)
    assert.equal((await core.request('preferences.tasks.get')).enabled, true)
    // Exhaust the three bounded retry delays before exercising same-value repair.
    await sleep(3500)
    await restore()
    assert.equal((await projection()).tasksEnabled, false)
    await enable(true)
    assert.equal((await projection()).tasksEnabled, true)
    await release('same-value-repair'); await phase('same-value-repair')
    await enable(false)
    await injectFailure(); await enable(true); await restore()
    await wait(async () => (await projection()).tasksEnabled, 'automatic projection retry', 10_000)
    await release('auto-retry'); await phase('auto-retry')
    await release('finish')
    await wait(() => exists('agent-finished.json'), 'Agent helper completes')
    await wait(() => runs()[0]?.status === 'succeeded', 'same AgentRun completes')
    report.finalRuns = runs()
    report.inputDeliveries = db.prepare('SELECT status,input_kind,input_sequence FROM runtime_input_delivery WHERE agent_run_id=? ORDER BY input_sequence').all(runs()[0].id)
    report.messages = db.prepare('SELECT author_type,source_agent_run_id,body FROM camp_message WHERE camp_id=? ORDER BY sequence').all(threadId)
    assert.ok(report.messages.some(message => message.author_type === 'agent'
      && message.source_agent_run_id === runs()[0].id && message.body.trim() === 'TASK_SWITCH_DONE'))
  }
  report.status = mode === 'preflight' ? 'diagnosed' : 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1
  console.error(error)
} finally {
  db?.close()
  if (core) report.coreStop = await core.stop()
  report.finishedAt = new Date().toISOString()
  await persist()
}
