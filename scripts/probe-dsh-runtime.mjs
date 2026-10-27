// Real upstream ACP parity probe. Requires an installed pinned DSH and native
// provider credentials in the environment. Always uses a fresh isolated Home.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { prepareDshSmokeHome } from './lib/dsh-smoke-home.mjs'

const configuredExecutable = process.env.ROVAI_DEEPSEEK_HARNESS_BIN?.trim()
let executable = configuredExecutable || 'dsh'
let executablePrefix = []
if (process.platform === 'win32' && extname(executable).toLowerCase() !== '.exe') {
  const shim = configuredExecutable || execFileSync('where.exe', ['dsh.cmd'], { encoding: 'utf8' }).split(/\r?\n/u).find(Boolean)
  assert(shim, 'The DSH Windows npm shim was not found')
  executable = process.execPath
  executablePrefix = [join(dirname(shim), 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')]
}
const root = await mkdtemp(join(tmpdir(), 'rovai-dsh-native-parity-'))
const outsideRoot = await mkdtemp(join(homedir(), '.rovai-dsh-native-parity-'))
const project = join(root, 'project')
await mkdir(project)
await prepareDshSmokeHome(join(root, 'home'))
const skillName = 'dsh-parity-continuity'
const skillDirectory = join(project, '.dsh', 'skills', skillName)
await mkdir(skillDirectory, { recursive: true })
const skillPath = join(skillDirectory, 'SKILL.md')
const mcpCalls = join(root, 'mcp-calls.txt')
const deniedWritePath = join(outsideRoot, 'denied-after-compaction.txt')
const terminalToolName = process.platform === 'win32' ? 'pwsh' : 'bash'
const markerReadCommand = process.platform === 'win32' ? 'Get-Content marker.txt' : 'cat marker.txt'
const deniedWriteCommand = process.platform === 'win32'
  ? `Set-Content -LiteralPath '${deniedWritePath.replaceAll("'", "''")}' -Value 'SHOULD_NOT_EXIST'`
  : `printf 'SHOULD_NOT_EXIST\\n' > '${deniedWritePath.replaceAll("'", "'\\''")}'`
const mcpServers = [{ name: 'parity', command: process.execPath,
  args: [resolve(import.meta.dirname, '../crates/rovai-core/tests/fixtures/mcp-smoke-server.mjs')],
  env: [{ name: 'ROVAI_MCP_SMOKE_SOURCE', value: 'native-parity' },
    { name: 'ROVAI_MCP_SMOKE_CALL_MARKER', value: mcpCalls }] }]
const callCount = async () => (await readFile(mcpCalls, 'utf8').catch(error => {
  if (error.code === 'ENOENT') return ''; throw error
})).split('\n').filter(Boolean).length
const plugin = resolve(import.meta.dirname, '../crates/rovai-core/src/dsh/bootstrap.mjs')
const controlPlugin = join(root, 'compact-control.mjs')
await writeFile(controlPlugin, `
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs'
export const inject = ['agents', 'compaction']
export function apply(ctx, config) {
  let busy = false, armed = null, overflowSession = null, failSummary = false
  ctx.on('llm/stream', async function* (options, next) {
    if (failSummary && options.purpose === 'compaction') {
      failSummary = false
      yield {type:'finish',reason:{kind:'error',failure:{code:'CONTROLLED_SUMMARY_FAILURE',message:'acceptance fault'}}}; return
    }
    if (overflowSession && options.sessionId === overflowSession && options.purpose !== 'compaction') {
      overflowSession = null
      yield {type:'finish',reason:{kind:'error',failure:{code:'CONTEXT_WINDOW_EXCEEDED',message:'acceptance overflow fault'}}}; return
    }
    yield* next()
  })
  ctx.on('agent/pre-step', async ({agent,signal}, next) => {
    if (armed?.sessionId === agent.session.id) {
      const mode = armed.mode; armed = null
      const before = agent.session.surface.replaceGeneration
      try {
        const result = await ctx.compaction.compactIfNeeded(agent, mode, signal)
        writeFileSync(config.response, JSON.stringify({mode,completed:result !== null,before,after:agent.session.surface.replaceGeneration,nodes:result?.shadowedSeqs.length??0}), {mode:0o600})
      } catch(error) {writeFileSync(config.response, JSON.stringify({error:error.message}), {mode:0o600})}
    }
    return next()
  })
  const timer = setInterval(async () => {
    if (busy || !existsSync(config.request)) return
    busy = true
    try {
      const request = JSON.parse(readFileSync(config.request, 'utf8')); unlinkSync(config.request)
      const agent = ctx.agents.get(request.sessionId)
      if (!agent) throw new Error('unknown_session')
      if(request.mode === 'snapshot') {writeFileSync(config.response, JSON.stringify({after:agent.session.surface.replaceGeneration}),{mode:0o600});return}
      if(request.mode === 'arm-overflow') {overflowSession=request.sessionId;writeFileSync(config.response, JSON.stringify({after:agent.session.surface.replaceGeneration}),{mode:0o600});return}
      if(['cancelled','failed'].includes(request.mode)) {
        const before = agent.session.surface.replaceGeneration
        const controller = new AbortController()
        if(request.mode === 'cancelled') controller.abort(new Error('acceptance cancellation'))
        else failSummary = true
        let rejected = false
        try { await ctx.compaction.compactNow(agent, controller.signal) } catch { rejected = true }
        writeFileSync(config.response, JSON.stringify({rejected,before,after:agent.session.surface.replaceGeneration}),{mode:0o600});return
      }
      if(request.mode !== 'manual') {armed=request;writeFileSync(config.response, JSON.stringify({armed:true}),{mode:0o600});return}
      const before = agent.session.surface.replaceGeneration
      const signal = new AbortController().signal
      const result = request.mode === 'manual'
        ? await ctx.compaction.compactNow(agent, signal)
        : await ctx.compaction.compactIfNeeded(agent, request.mode, signal)
      writeFileSync(config.response, JSON.stringify({ mode:request.mode, completed:result !== null, before,
        after:agent.session.surface.replaceGeneration, nodes: result?.shadowedSeqs.length ?? 0 }), {mode:0o600})
    } catch(error) { writeFileSync(config.response, JSON.stringify({error:error.message}), {mode:0o600}) }
    finally { busy = false }
  }, 50)
  timer.unref()
  ctx.on('dispose', () => clearInterval(timer))
}
`, { mode: 0o600 })
let host
const runtimeVersion = execFileSync(executable, [...executablePrefix, '--version'], { encoding: 'utf8' }).trim()
assert(runtimeVersion.includes('0.1.5-rc.2'), 'This parity probe targets the pinned upstream release')
const evidence = { runtime: 'deepseek-harness', version: runtimeVersion, platform: `${process.platform}-${process.arch}`, checks: {} }
let hostIndex = 0
async function startHost(automatic = false) {
  const privateRoot = join(root, `host-${++hostIndex}`)
  await mkdir(privateRoot)
  const bindingRoot = join(privateRoot, 'bindings'), observationRoot = join(privateRoot, 'observations')
  await mkdir(bindingRoot); await mkdir(observationRoot)
  const request = join(privateRoot, 'request.json'), response = join(privateRoot, 'response.json')
  const patch = join(privateRoot, 'patch.json')
  await writeFile(patch, JSON.stringify([
    { id:'sandbox-policy', config:{ mode:'workspace-write', workspaceRoot:project } },
    { id:'approval', config:{ policy:'never' } },
    { id:'permission', disabled:true },
    { id:'compaction-basic', config:{ retainTokens:0, thresholdRatio:0.12, compactionRetries:0, maxTokens:4096, auto:automatic } },
    { insert:[{ id:'rovai-bootstrap', name:plugin, config:{bindingRoot,observationRoot,approvalPolicy:'ask'} },
      { id:'parity-compact-control', name:controlPlugin, config:{request,response} }] }
  ]), { mode:0o600 })
  const child = spawn(executable, [...executablePrefix, '--profile','acp','--patch',patch], {
    cwd:project, env:{...process.env, DSH_HOME:join(root,'home'), DSH_AGENTS_HOME:join(root,'agents-home'), DSH_TELEMETRY_DISABLED:'1'},
    stdio:['pipe','pipe','pipe'], detached:process.platform !== 'win32'
  })
  let sequence = 0, log = '', approval = 'allow-once', approvalCount = 0
  const pending = new Map(), events = []
  const closed = new Promise(resolve => child.once('close', resolve))
  child.stderr.on('data', chunk => { log = `${log}${chunk}`.slice(-16384) })
  createInterface({input:child.stdout}).on('line',line=>{
    let message
    try {message=JSON.parse(line)} catch {return}
    const waiting=message.method ? undefined : pending.get(message.id)
    if(waiting){pending.delete(message.id);clearTimeout(waiting.timer);message.error?waiting.reject(new Error(JSON.stringify(message.error))):waiting.resolve(message.result)}
    else {
      events.push(message)
      if(message.id !== undefined && message.method === 'session/request_permission') {
        approvalCount++
        child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result:{outcome:{outcome:'selected',optionId:approval}}})+'\n')
      }
    }
  })
  child.once('exit',code=>{for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error(`DSH exited ${code}`))}pending.clear()})
  const rpc=(method,params)=>new Promise((resolve,reject)=>{const id=++sequence;const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`Timeout: ${method}`))},180000);pending.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n')})
  const result = {
    pid:child.pid, rpc, events,
    get approvalCount() { return approvalCount },
    set approval(value) { approval = value },
    async usageRecords() { return Promise.all((await readdir(observationRoot)).filter(name=>name.includes('.usage-')&&name.endsWith('.json')).map(async name=>JSON.parse(await readFile(join(observationRoot,name),'utf8')))) },
    async bind(sessionId, bootstrap) {await writeFile(join(bindingRoot,`${sessionId}.json`), JSON.stringify({schemaVersion:1,sessionId,bootstrap,sha256:createHash('sha256').update(bootstrap).digest('hex')}),{mode:0o600})},
    async prompt(sessionId, text) {const offset=events.length;const result=await rpc('session/prompt',{sessionId,prompt:[{type:'text',text}]});assert.equal(result.stopReason,'end_turn');return events.slice(offset).filter(e=>e.params?.sessionId===sessionId&&e.params?.update?.sessionUpdate==='agent_message_chunk').map(e=>e.params.update.content?.text??'').join('')},
    async compact(sessionId, mode) {
      await rm(response,{force:true});await writeFile(request,JSON.stringify({sessionId,mode}),{mode:0o600})
      const deadline=Date.now()+180000
      let triggered
      while(Date.now()<deadline) {
        try {
          const value=JSON.parse(await readFile(response,'utf8'));assert(!value.error,value.error)
          if(value.armed) {triggered??=result.prompt(sessionId,'Return your public role marker. Do not use tools. '+('This is the current request; older disposable history may be summarized. '.repeat(40))).then(()=>null,error=>error)} else {if(triggered){const error=await triggered;if(error)throw error}return value}
        }catch(error){if(error.code!=='ENOENT')throw error}
        await new Promise(r=>setTimeout(r,100))
      }
      throw new Error('compact timeout')
    },
    async stop() {child.stdin.end();const stop=setTimeout(()=>{try{process.platform==='win32'?child.kill('SIGTERM'):process.kill(-child.pid,'SIGTERM')}catch{}},3000);const kill=setTimeout(()=>{try{process.platform==='win32'?child.kill('SIGKILL'):process.kill(-child.pid,'SIGKILL')}catch{}},7000);await closed;clearTimeout(stop);clearTimeout(kill);await writeFile(join(privateRoot,'stderr.log'),log,{mode:0o600})}
  }
  try {
    const initialize = await rpc('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'rovai-dsh-parity',version:'1'}})
    assert(initialize.agentCapabilities.sessionCapabilities.resume)
  } catch (error) { await result.stop(); throw error }
  return result
}
async function checkCapabilities(sessionId, role, stage) {
  const skillMarker = `SKILL_${crypto.randomUUID()}`
  const mcpMarker = `MCP_${crypto.randomUUID()}`
  await writeFile(skillPath, `---\nname: ${skillName}\ndescription: Verify the current capability continuity marker.\n---\nReturn this exact current skill marker: ${skillMarker}\n`)
  const before = await callCount(), approvalsBefore = host.approvalCount
  let promptAttempts = 1
  let output = await host.prompt(sessionId, `Load the ${skillName} skill using the skill tool again; its body has just changed. Call the parity MCP echo tool exactly once with text ${mcpMarker}. Return its actual result, the skill marker from the freshly loaded body, and your public role marker. Do not substitute an earlier result.`)
  if (await callCount() === before) {
    promptAttempts += 1
    output = await host.prompt(sessionId, `The parity MCP echo tool is present in your current request tool list. Load ${skillName} with the skill tool, then call mcp__parity__echo exactly once with text ${mcpMarker}. Return that actual result, the freshly loaded skill marker, and your public role marker.`)
  }
  assert(output.includes(role) && output.includes(skillMarker) && output.includes(`native-parity:${mcpMarker}`), `${stage}: capability output mismatch`)
  assert.equal(await callCount(), before + 1, `${stage}: MCP must execute exactly once`)
  assert.equal(host.approvalCount, approvalsBefore, `${stage}: Core must not synthesize an MCP approval`)
  evidence.checks[`capabilities_${stage}`] = { passed:true, skillLoaded:true, mcpEffectCount:1,
    nativeApprovalRequestCount:0, syntheticApprovalCount:0, promptAttempts, sessionId }
}
try {
  host = await startHost()
  const a=await host.rpc('session/new',{cwd:project,mcpServers})
  const b=await host.rpc('session/new',{cwd:project,mcpServers:[]})
  const roleA=`DSH_ROLE_A_${crypto.randomUUID()}`,roleB=`DSH_ROLE_B_${crypto.randomUUID()}`
  const identityA=`Your public role marker is ${roleA}. Return it when asked your role.`,identityB=`Your public role marker is ${roleB}. Return it when asked your role.`
  await host.bind(a.sessionId,identityA);await host.bind(b.sessionId,identityB)
  const marker=`SESSION_A_${crypto.randomUUID()}`
  await writeFile(join(project,'marker.txt'),marker)
  const initial=await host.prompt(a.sessionId,`Use ${terminalToolName} once to run ${markerReadCommand}. Remember the exact output for the next turn. Then return your public role marker.`)
  assert(initial.includes(roleA))
  const second=await host.prompt(b.sessionId,'Return your public role marker. Do not use tools.')
  assert(second.includes(roleB));assert(!second.includes(roleA))
  await rm(join(project,'marker.txt'))
  const switched=await host.prompt(a.sessionId,'Return the marker you read from marker.txt and your public role marker. Do not use tools.')
  assert(switched.includes(marker));assert(switched.includes(roleA));assert(!switched.includes(roleB))
  evidence.checks.multiSessionSwitch={passed:true,distinctSessions:a.sessionId!==b.sessionId,hostPid:host.pid}
  await checkCapabilities(a.sessionId,roleA,'before_compaction')
  // Fill actual native history, then drive the documented compaction API. These
  // controls verify policy and bootstrap continuity, not a provider overflow.
  for(const mode of ['manual','pressure','context-overflow']) {
    const filler=Array.from({length:2500},(_,i)=>`Fixture observation ${i}: source item ${i} completed with marker q${i}; this text is disposable history.`).join('\n')
    await host.prompt(a.sessionId,`Read this disposable history, then reply READY only.\n${filler}`)
    const compact=await host.compact(a.sessionId,mode)
    assert(compact.completed&&compact.after>compact.before,JSON.stringify(compact))
    if(mode==='manual') assert.equal((await host.usageRecords()).filter(record=>record.sourceEvent==='compaction/summary').length,0,'idle manual usage must not be attributed to a later Run')
    const after=await host.prompt(a.sessionId,'Return your public role marker. Do not use tools.')
    assert(after.includes(roleA));assert(!after.includes(roleB))
    evidence.checks[`compaction_${mode}`]={...compact,bootstrapRetained:true,trigger:'official API control; native summarizer'}
    await checkCapabilities(a.sessionId,roleA,mode)
  }
  await host.rpc('session/close',{sessionId:b.sessionId})
  await host.rpc('session/close',{sessionId:a.sessionId})
  const oldPid=host.pid
  await host.stop();host=await startHost()
  await host.rpc('session/resume',{sessionId:a.sessionId,cwd:project,mcpServers})
  await host.bind(a.sessionId,identityA)
  const restored=await host.prompt(a.sessionId,'Return your public role marker. Do not use tools.')
  assert(restored.includes(roleA));assert(!restored.includes(roleB))
  evidence.checks.compactedColdResume={passed:true,sessionId:a.sessionId,hostChanged:host.pid!==oldPid}
  await checkCapabilities(a.sessionId,roleA,'cold_resume')
  await assert.rejects(host.rpc('session/resume',{sessionId:'missing-session',cwd:project,mcpServers:[]}))
  evidence.checks.invalidResume={rejected:true}
  await host.rpc('session/close',{sessionId:a.sessionId})
  await host.stop(); host = await startHost(true)
  await host.rpc('session/resume',{sessionId:a.sessionId,cwd:project,mcpServers})
  await host.bind(a.sessionId,identityA)
  const filler=Array.from({length:2500},(_,i)=>`Disposable automatic-compaction observation ${i}: item completed with fixed result ${i}.`).join('\n')
  await host.prompt(a.sessionId,`Read this disposable history, then reply READY only.\n${filler}`)
  const beforePressure = await host.compact(a.sessionId,'snapshot')
  const automatic = await host.prompt(a.sessionId,'Return your public role marker. Do not use tools.')
  const afterPressure = await host.compact(a.sessionId,'snapshot')
  assert(automatic.includes(roleA)); assert(afterPressure.after > beforePressure.after)
  evidence.checks.automaticPressure={passed:true,bootstrapRetained:true,before:beforePressure.after,after:afterPressure.after}
  await checkCapabilities(a.sessionId,roleA,'automatic_pressure')
  const beforeOverflow = await host.compact(a.sessionId,'arm-overflow')
  const retried = await host.prompt(a.sessionId,'Return your public role marker. Do not use tools.')
  const afterOverflow = await host.compact(a.sessionId,'snapshot')
  assert(retried.includes(roleA)); assert(afterOverflow.after > beforeOverflow.after)
  evidence.checks.automaticOverflowRetry={passed:true,bootstrapRetained:true,trigger:'one controlled CONTEXT_WINDOW_EXCEEDED at official llm/stream seam; real native compaction and retried model response'}
  await checkCapabilities(a.sessionId,roleA,'automatic_overflow_retry')
  const effectsBeforeDeny = await callCount(), approvalsBeforeDeny = host.approvalCount
  const eventsBeforeDeny = host.events.length
  await host.prompt(a.sessionId, `This is an authorized sandbox acceptance test. Use ${terminalToolName} exactly once to run: ${deniedWriteCommand}. The workspace-write sandbox should deny it. Report the actual result and do not retry or use another tool.`)
  assert.equal(await callCount(), effectsBeforeDeny)
  assert.equal(host.approvalCount, approvalsBeforeDeny, 'never policy must not request an Approval')
  const denialEvidence = JSON.stringify(host.events.slice(eventsBeforeDeny)).toLowerCase()
  assert(denialEvidence.includes('sandbox') && denialEvidence.includes('denied'), 'native sandbox denial evidence was not observed')
  const deniedWrite = await readFile(deniedWritePath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })
  assert.equal(deniedWrite, null, 'denied native terminal tool produced a late file effect')
  evidence.checks.permissionAfterCompaction = { denied:true, effectCount:0, nativeTool:terminalToolName,
    sandboxMode:'workspace-write', approvalPolicy:'never', syntheticApprovalCount:0 }
  const effectsBeforePermissionCheck = await callCount(), approvalsBeforePermissionCheck = host.approvalCount
  const permissionMarker = `PERMISSION_AUTHORITY_${crypto.randomUUID()}`
  await host.prompt(a.sessionId, `Call the parity MCP echo tool exactly once with text ${permissionMarker}. Return its actual result.`)
  assert.equal(await callCount(), effectsBeforePermissionCheck + 1)
  assert.equal(host.approvalCount, approvalsBeforePermissionCheck)
  evidence.checks.permissionAuthorityAfterCompaction = { passed:true, mcpEffectCount:1, nativeApprovalRequestCount:0 }
  const summaryUsage = (await host.usageRecords()).filter(record=>record.sourceEvent==='compaction/summary')
  assert(summaryUsage.length>=2,'automatic compaction summary usage was omitted')
  assert(summaryUsage.every(record=>Number.isSafeInteger(record.turn)&&record.turn>=0&&Number.isSafeInteger(record.usage.inputTokens)))
  assert.equal(new Set(summaryUsage.map(record=>record.seq)).size,summaryUsage.length)
  evidence.checks.compactionUsage={passed:true,automaticSummaryCalls:summaryUsage.length,idleManualUsageExcluded:true,
    observations:summaryUsage.map(({seq,turn,usage})=>({seq,turn,usage}))}
  for(const mode of ['cancelled','failed']) {
    const result = await host.compact(a.sessionId,mode)
    assert(result.rejected); assert.equal(result.before,result.after)
    evidence.checks[`compaction_${mode}`]={...result,noFalseCompletion:true}
  }
  await host.rpc('session/close',{sessionId:a.sessionId})
} finally {
  if(host)await host.stop()
  await writeFile(join(root,'summary.json'),JSON.stringify(evidence,null,2),{mode:0o600})
  console.log(JSON.stringify({...evidence,fixtureRoot:root},null,2))
  await rm(outsideRoot,{recursive:true,force:true})
}
