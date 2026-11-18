// Live one-Run acceptance: real production UI -> saved Pi Append -> frozen Run ->
// native activation/application -> model-authored file/Artifact/PENDING Candidate -> UI preview.
// Opt-in only. The existing isolated Host fixture seeds test assistants, but the
// page alone saves Persona/permission and creates/starts the work. No Owner verdict.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { prepareLivePiHost } from './loom-live-pi-host.mjs'
import { redactDeep, verifyArchivedArtifact } from '../accept-loom-live-lead.mjs'
import { UI, TEXT, findSecretLeak, pickNewMission, rosterJs, tagMemberJs, tagByTextJs, tagChoiceItemJs } from './loom-browser-live-mode.mjs'
import * as ab from './ab-browser.mjs'
import { confirmOwnedPage, pageScript } from './loom-owned-page.mjs'

const OUT = resolve(process.env.LOOM_PI_PURGE_UI_EVIDENCE ?? '')
const optIn = process.env.LOOM_ALLOW_LIVE_ACCEPTANCE === '1' && process.env.LOOM_ALLOW_PI_PURGE_UI_ACCEPTANCE === '1'
const pause = ms => new Promise(done => setTimeout(done, ms))
const hash = data => createHash('sha256').update(data).digest('hex')
const FILE = 'pi-persona-result.md'
const TASK = 'pi-persona-file'
const STUDIO = '.ln-surface-dialog.ln-studio'
const PERSONA_INPUT = STUDIO + ' textarea[aria-label="Pi Purge 人格提示词"]'
const PURGE_TRIGGER = STUDIO + ' button[aria-label="Pi Purge 模式"]'
const FILE_TRIGGER = STUDIO + ' button[aria-label="文件与任务权限"]'

test('production UI saves Pi Append and starts one real file delivery with the frozen persona', {
  timeout: 45 * 60_000, skip: optIn ? false : 'explicit live Pi Purge UI opt-in required'
}, async () => {
  assert.ok(process.env.LOOM_PI_PURGE_UI_EVIDENCE)
  await mkdir(OUT, { recursive: true })
  assert.equal(existsSync(join(OUT, 'report.json')), false, 'existing evidence is not a retry target')
  const marker = 'LOOM_PERSONA_' + randomBytes(16).toString('hex')
  const nonce = 'LOOM_TASK_' + randomBytes(12).toString('hex')
  const persona = '你是这次隔离验收的个人助手。你写的 ' + FILE + ' 必须额外包含一整行 ' + marker
    + '。此标记只来自当前助手设定。保持宿主的任务流程和授权检查，完成后等待用户接受成果，不替用户做接受决定。'
  const report = {
    scope: 'one-live-production-ui-Pi-Append-file-delivery', status: 'running',
    hostAuthoredPlan: false, hostRegisteredArtifact: false, hostSubmittedCandidate: false,
    ownerReviewRecorded: false, globalSettingsChanged: false, modelRequestsScripted: false,
    providerPromptInspected: false, backendModelIdentityVerified: false,
    marker, nonce, personaSha256: hash(persona), steps: {}, screenshots: {}, startedAt: new Date().toISOString()
  }
  const secrets = [process.env.LOOM_E4_PROVIDER_KEY].filter(Boolean)
  let prepared, tabId, runId, epoch, missionId, threadId, agentId, latestSnapshot
  let focusHeld = false
  const receipts = new Map(), guardReceipts = new Map(), bindings = new Map()
  const persist = async () => {
    const redacted = redactDeep(report, secrets)
    assert.equal(findSecretLeak(JSON.stringify(redacted), secrets).length, 0)
    await writeFile(join(OUT, 'report.json'), JSON.stringify(redacted, null, 2) + '\n')
  }
  const stage = async name => {
    report.stage = name
    await persist()
    console.log(JSON.stringify({ piPurgeUiStage: name, runId: runId ?? null }))
  }
  const facts = (method, params = {}) => prepared.facts(method, params)
  const evalValue = async code => {
    const result = await ab.abEval(tabId, pageScript(code), { env: process.env })
    assert.equal(result.ok, true, 'page read unconfirmed: ' + result.reason)
    return result.value
  }
  async function waitPage(expression, seconds = 45) {
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      if (await evalValue(expression) === true) return
      await pause(600)
    }
    throw new Error('page_state_timeout')
  }
  async function waitSignal(name) {
    await stage(name === 'focus.allow' ? 'waiting_initial_focus' : 'waiting_preview_focus')
    const deadline = Date.now() + 20 * 60_000
    while (!existsSync(join(OUT, name))) {
      if (Date.now() > deadline) throw new Error('focus_gate_timeout')
      await pause(750)
    }
    focusHeld = true
  }
  function click(selector) {
    const result = ab.abClick(tabId, selector, { env: process.env })
    assert.notEqual(result.verdict, 'FAILED', 'UI input failed: ' + result.reason)
  }
  async function clickText(selector, text, tag) {
    assert.equal(await evalValue(tagByTextJs(selector, text, tag)), true, 'visible UI text missing: ' + text)
    click('[data-loom-qa="' + tag + '"]')
  }
  async function choose(trigger, label, tag) {
    await waitPage('!!document.querySelector(' + JSON.stringify(trigger) + ')')
    await evalValue('(() => { document.querySelector(' + JSON.stringify(trigger) + ').scrollIntoView({block:"center"}); return true })()')
    const opened = ab.abTrustedClick(tabId, trigger, { env: process.env })
    assert.equal(opened.verdict, 'OK', 'choice trigger input not verified: ' + opened.reason)
    await waitPage('document.querySelectorAll(' + JSON.stringify(UI.choiceItem) + ').length > 0', 20)
    const actual = label
    const marked = await evalValue(tagChoiceItemJs(tag, actual))
    assert.equal(marked?.found, true, 'choice missing: ' + label)
    const picked = ab.abPick(tabId, '[data-loom-qa="' + tag + '"]', { env: process.env, open: trigger, value: actual })
    report.steps.choiceInputs ??= []
    report.steps.choiceInputs.push({ name: label, verdict: picked.verdict, reason: picked.reason })
    // An uncertain click is never replayed: only the exact controlled trigger proves selection.
    await waitPage('document.querySelector(' + JSON.stringify(trigger) + ')?.querySelector(":scope > span:not(.ln-avatar)")?.textContent.trim() === ' + JSON.stringify(actual), 20)
  }
  async function screenshot(name) {
    const path = join(OUT, name + '.png')
    const captured = await ab.abScreenshot(tabId, path, { env: process.env })
    report.screenshots[name] = { path, verified: captured.verified, bytes: captured.bytes ?? null }
    assert.equal(captured.verified, true, 'screenshot not verified')
  }
  function query(sql, ...args) {
    const db = new DatabaseSync(join(prepared.evidence.dataDir, 'rovai.sqlite'), { readOnly: true })
    try { return db.prepare(sql).all(...args) } finally { db.close() }
  }
  async function captureNativeEvidence() {
    if (!runId) return
    const dataDir = prepared.evidence.dataDir
    async function walk(directory, depth = 0) {
      if (depth > 10) return
      const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue
        const path = join(directory, entry.name)
        if (entry.isDirectory()) { await walk(path, depth + 1); continue }
        if (!entry.isFile() || !['pi-purge-receipt.jsonl', 'pi-purge-run.json', 'guard.jsonl'].includes(entry.name)) continue
        const info = await stat(path).catch(() => null)
        if (!info || info.size > 2 * 1024 * 1024) continue
        const body = await readFile(path, 'utf8').catch(() => '')
        const rows = entry.name.endsWith('.jsonl')
          ? body.split(/\r?\n/u).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)] } catch { return [] } })
          : (() => { try { return [JSON.parse(body)] } catch { return [] } })()
        const guardOwnedByRun = entry.name === 'guard.jsonl'
          && rows.some(row => row.t === 'guard_ready' && row.runId === runId && row.botId === agentId)
          && !rows.some(row => row.t === 'guard_ready' && (row.runId !== runId || row.botId !== agentId))
        for (const row of rows) {
          if (entry.name === 'guard.jsonl' ? !guardOwnedByRun
            : row.runId !== runId || row.botId !== agentId || row.executionEpoch !== epoch) continue
          if (entry.name === 'pi-purge-run.json') {
            const allowed = ['schema','runId','botId','executionEpoch','mode','upstreamSha256','personaSha256']
            const result = Object.fromEntries(allowed.filter(k => row[k] !== undefined).map(k => [k,row[k]]))
            // This generated file is the known synthetic Persona, never the native host binding.
            const personaBytes = await readFile(join(dirname(path), 'pi-purge-persona.md'))
            result.personaBytesMatchSavedUi = hash(personaBytes) === report.personaSha256
            bindings.set(path, { path, ...result })
          } else if (entry.name === 'pi-purge-receipt.jsonl') {
            const allowed = ['schema','runtimeEvidence','providerPromptSeen','runId','botId','executionEpoch','hook','mode','upstreamExtensionId','upstreamCommit','upstreamVersion','upstreamSha256','configSha256','personaSha256','at','activated','applied','reason','refused','promptDigest','hostTextDigest']
            const result = Object.fromEntries(allowed.filter(k => row[k] !== undefined).map(k => [k,row[k]]))
            receipts.set(hash(JSON.stringify(result)), { path, ...result })
          } else {
            const allowed = ['t','runId','botId','executionEpoch','at','toolName','decision','reasonCode','relPath','allowedTools','operation']
            const result = Object.fromEntries(allowed.filter(k => row[k] !== undefined).map(k => [k,row[k]]))
            guardReceipts.set(hash(JSON.stringify(result)), { path, ...result })
          }
        }
      }
    }
    await walk(dataDir)
    report.nativeBindings = [...bindings.values()]
    report.purgeReceipts = [...receipts.values()]
    report.guardReceipts = [...guardReceipts.values()]
  }

  try {
    await stage('prepare_isolated_host')
    const configPath = process.env.LOOM_UI_PUBLIC_CONFIG
    const config = JSON.parse((await readFile(configPath, 'utf8')).replace(/^\uFEFF/u, ''))
    const proof = JSON.parse(await readFile(join(dirname(configPath), 'source-proof.json'), 'utf8'))
    for (const [name, expected] of Object.entries(proof.webFiles)) {
      assert.equal(hash(await readFile(join(config.uiDirectory, name))), expected, 'pinned UI snapshot changed')
    }
    prepared = await prepareLivePiHost({ configPath, providerKey: process.env.LOOM_E4_PROVIDER_KEY })
    secrets.push(...prepared.secrets)
    assert.equal(prepared.evidence.hostSha256, proof.hostSha256)
    assert.equal(prepared.evidence.helperSha256, proof.helperSha256)
    report.fixture = prepared.evidence
    const nativeDefaults = JSON.parse(await readFile(join(prepared.evidence.isolatedProfile, 'settings.json'), 'utf8'))
    assert.equal(nativeDefaults.defaultProvider, 'loom-live')
    assert.equal(nativeDefaults.defaultModel, config.model.id)
    assert.equal(nativeDefaults.defaultThinkingLevel, 'max')
    report.steps.nativeModelDefaults = { provider: nativeDefaults.defaultProvider, model: nativeDefaults.defaultModel, thinking: nativeDefaults.defaultThinkingLevel }
    const target = prepared.roles.workerA
    agentId = target.agentId
    report.agent = target
    const membersBefore = await facts('members.list')
    const runtimeBefore = new Map()
    for (const member of membersBefore) {
      const profile = await facts('members.get', { agentId: member.agentId })
      runtimeBefore.set(member.agentId, hash(JSON.stringify(profile.runtimeConfiguration ?? null)))
    }
    assert.equal((await facts('members.get', { agentId })).runtimeConfiguration?.piPurge ?? null, null)
    const missionsBefore = await facts('missions.list')
    await waitSignal('focus.allow')
    const ready = ab.abReady({ env: process.env })
    assert.equal(ready.ok, true, 'browser door not confirmed: ' + ready.reason)
    await stage('opening_owned_page')
    const opened = ab.abOpen(prepared.origin, { env: process.env })
    assert.equal(opened.confirmed, true)
    tabId = opened.openedTabId
    report.tabId = tabId
    report.steps.browserOpen = { verdict: opened.verdict, reason: opened.reason, openedTabId: tabId }
    report.steps.pageIdentity = await confirmOwnedPage(tabId, prepared.origin, { env: process.env })
    await waitPage('!!document.querySelector(' + JSON.stringify(UI.loginToken) + ')', 60)
    assert.equal(ab.abFill(tabId, UI.loginToken, prepared.adminToken, { env: process.env }).verdict, 'OK')
    click(UI.loginSubmit)
    await waitPage('!document.querySelector(' + JSON.stringify(UI.loginOverlay) + ') && !!document.querySelector(' + JSON.stringify(UI.appRoot) + ')', 90)
    await stage('save_append_from_ui')
    click('.ln-rail button[aria-label="管理助手"]')
    await waitPage('!!document.querySelector(' + JSON.stringify(STUDIO) + ')')
    await clickText(STUDIO + ' .ln-studio-roster button', target.displayName, 'purge-assistant')
    await waitPage('document.querySelector(' + JSON.stringify(STUDIO + ' .ln-studio-identity h3') + ')?.textContent.trim() === ' + JSON.stringify(target.displayName))
    await clickText(STUDIO + ' .ln-studio-tabs button', '运行与权限', 'purge-runtime')
    await waitPage('!!document.querySelector(' + JSON.stringify(PURGE_TRIGGER) + ')')
    await choose(PURGE_TRIGGER, '追加助手设定', 'purge-append')
    assert.equal(ab.abFill(tabId, PERSONA_INPUT, persona, { env: process.env }).verdict, 'OK')
    await choose(FILE_TRIGGER, '读写文件并处理任务', 'purge-file-policy')
    await screenshot('append-draft')
    await clickText(STUDIO + ' .ln-form-actions button', '保存运行配置', 'purge-save')
    await waitPage('[...document.querySelectorAll(".ln-surface-title h2")].some(e=>e.textContent.trim()==="确认权限配置")')
    const confirmation = '.ln-surface-dialog.ln-room-dialog'
    await clickText(confirmation + ' .ln-form-actions button', '确认并保存', 'purge-confirm')
    await waitPage('[...document.querySelectorAll(' + JSON.stringify(STUDIO + ' [role="status"]') + ')].some(e=>e.textContent.includes("已保存，下次运行生效。"))', 60)
    const saved = await facts('members.get', { agentId })
    assert.deepEqual(saved.runtimeConfiguration.piPurge, { mode: 'append', persona })
    assert.equal(saved.runtimeConfiguration.permissions.values.loom_file_access, 'workspace_workflow')
    report.steps.uiSaved = { mode: saved.runtimeConfiguration.piPurge.mode, personaSha256: hash(saved.runtimeConfiguration.piPurge.persona),
      filePolicy: saved.runtimeConfiguration.permissions.values.loom_file_access, version: saved.version }
    for (const [id, previousHash] of runtimeBefore) {
      if (id === agentId) continue
      assert.equal(hash(JSON.stringify((await facts('members.get', { agentId: id })).runtimeConfiguration ?? null)), previousHash, 'another assistant changed')
    }
    report.steps.otherAssistantsUnchanged = true
    await screenshot('append-saved')
    click(STUDIO + ' > header button[aria-label="关闭窗口"]')
    await waitPage('!document.querySelector(' + JSON.stringify(STUDIO) + ')')

    const goal = [
      '这是单助手隔离验收，请你自己在当前这一轮完成，不创建其他运行，不安排其他助手。',
      '你同时是本工作的主助手和唯一执行者。你的成员ID是 ' + agentId + '。',
      '先用 rovai_loom 的 loom.status 读取当前工作，再用 loom.plan 创建恰好一个分配给你自己的任务：taskId=' + TASK + '；acceptanceCriteriaVersion=pi-persona-ui-v1；至少一个验收标准要求真实文件已登记且仍待用户接受。',
      '然后依次 loom.release、loom.claim 认领这个任务。拿到有效认领后，使用原生 write 创建 ' + FILE + '，使用 read 核对正文。',
      '正文要求：标题“# Pi 助手设定验收”；一整行 ' + nonce + '；一整行“等待用户接受”；并遵守你当前已生效的助手设定。正文控制在1000字节内。',
      '最后用 loom.evidence 登记该文件并绑定此taskId，再用 loom.submit 提交其artifactId作为evidenceIds。每一步使用实际返回值，不能编造ID。',
      '完成后停止，保留Candidate待用户接受；不要调用评审或接受，不要用bash、shell、MCP或触碰其他文件。'
    ].join('\n')
    assert.equal(goal.includes(marker), false)
    report.steps.personaMarkerAbsentFromGoal = true
    report.goalSha256 = hash(goal)
    await stage('start_one_work_from_ui')
    click(UI.newConversation)
    await waitPage('!!document.querySelector(' + JSON.stringify(UI.roomDialog) + ')')
    await clickText(UI.roomTabs, TEXT.workMode, 'purge-work-mode')
    for (const row of await evalValue(rosterJs())) {
      if (row.checked && row.name !== target.displayName) {
        const tag = 'purge-unselect-' + hash(row.name).slice(0,8)
        assert.equal(await evalValue(tagMemberJs(tag, row.name)), true)
        click('[data-loom-qa="' + tag + '"] input')
      }
    }
    const own = (await evalValue(rosterJs())).find(row => row.name === target.displayName)
    assert.ok(own)
    if (!own.checked) {
      assert.equal(await evalValue(tagMemberJs('purge-only-member', target.displayName)), true)
      click('[data-loom-qa="purge-only-member"] input')
    }
    assert.deepEqual((await evalValue(rosterJs())).filter(row=>row.checked).map(row=>row.name), [target.displayName])
    const leadText = await evalValue('document.querySelector(' + JSON.stringify(UI.leadTrigger) + ')?.querySelector(":scope > span:not(.ln-avatar)")?.textContent.trim()')
    if (leadText !== target.displayName) await choose(UI.leadTrigger, target.displayName, 'purge-lead')
    const title = 'Pi 个人设定真实验收 ' + nonce.slice(-8)
    assert.equal(ab.abFill(tabId, UI.workName, title, { env: process.env }).verdict, 'OK')
    assert.equal(ab.abFill(tabId, UI.workGoal, goal, { env: process.env }).verdict, 'OK')
    assert.equal(await evalValue('document.querySelector(' + JSON.stringify(UI.workGoal) + ')?.value === ' + JSON.stringify(goal)), true)
    if (await evalValue('document.querySelector(' + JSON.stringify(UI.startNow) + ')?.checked') !== true) click(UI.startNow)
    click(UI.roomSubmit)
    await waitPage('!document.querySelector(' + JSON.stringify(UI.roomDialog) + ')', 90)
    const missions = await facts('missions.list')
    const picked = pickNewMission(missionsBefore, missions)
    assert.ok(picked.missionId, picked.reason)
    missionId = picked.missionId
    const mission = missions.find(row => row.missionId === missionId)
    assert.equal(mission.title, title)
    threadId = mission.threadId
    Object.assign(report, { missionId, threadId })
    report.steps.startedFromUi = true
    focusHeld = false
    await stage('model_running_focus_released')
    await writeFile(join(OUT, 'focus-released.json'), JSON.stringify({ reason: 'UI work started; read-only Core polling until preview gate', tabId, missionId }) + '\n')

    const deadline = Date.now() + 12 * 60_000
    while (Date.now() < deadline) {
      latestSnapshot = await facts('threads.snapshot', { threadId })
      const runs = latestSnapshot.agentRuns ?? []
      assert.ok(runs.length <= 1, 'this check permits only one model Run')
      const run = runs[0]
      if (run) {
        assert.equal(run.agentId, agentId)
        runId = run.id
        const frozen = query("SELECT execution_epoch AS epoch, json_extract(effective_config_json,'$.runtime.piPurge.mode') AS mode, json_extract(effective_config_json,'$.runtime.piPurge.persona') AS persona, json_extract(effective_config_json,'$.runtime.permissions.values.loom_file_access') AS filePolicy, json_extract(effective_config_json,'$.runtime.model.modelId') AS modelId, json_extract(effective_config_json,'$.runtime.model.options.thinking_level') AS thinking FROM agent_run WHERE id=?", runId)[0]
        assert.ok(frozen)
        epoch = frozen.epoch
        assert.equal(frozen.mode, 'append')
        assert.equal(frozen.persona, persona)
        assert.equal(frozen.filePolicy, 'workspace_workflow')
        report.frozen = { runId, executionEpoch: epoch, mode: frozen.mode, personaSha256: hash(frozen.persona), filePolicy: frozen.filePolicy, modelId: frozen.modelId, thinking: frozen.thinking }
        report.run = { id: runId, status: run.status, lastErrorCode: run.lastErrorCode ?? null }
        await captureNativeEvidence()
        await persist()
        if (['succeeded','failed','cancelled'].includes(run.status)) break
      }
      assert.equal((latestSnapshot.approvals ?? []).filter(row=>row.status==='pending').length, 0, 'unexpected tool approval requires exact review')
      await pause(1000)
    }
    await captureNativeEvidence()
    await persist()
    assert.equal(report.run?.status, 'succeeded', 'Pi Run did not complete successfully')
    assert.equal(latestSnapshot.agentRuns.length, 1)
    const nativeModel = query('SELECT runtime_observed_model_id AS modelId FROM agent_run WHERE id=?', runId)[0]
    assert.equal(nativeModel?.modelId, 'pi://model?provider=loom-live&id=' + encodeURIComponent(config.model.id))
    report.steps.nativeObservedModelId = nativeModel.modelId
    const activated = [...receipts.values()].filter(row => row.hook === 'session_start' && row.activated === true)
    const applied = [...receipts.values()].filter(row => row.hook === 'before_agent_start' && row.applied === true)
    assert.ok(activated.length > 0 && applied.length > 0, 'native activation AND applied receipts are required')
    for (const row of [...activated, ...applied]) {
      assert.equal(row.runId, runId); assert.equal(row.botId, agentId); assert.equal(row.executionEpoch, epoch)
      assert.equal(row.personaSha256, report.personaSha256); assert.equal(row.mode, 'append')
      assert.equal(row.runtimeEvidence, 'native_extension_local'); assert.equal(row.providerPromptSeen, false)
    }
    assert.ok([...bindings.values()].some(row=>row.personaBytesMatchSavedUi))
    const guardReady = [...guardReceipts.values()].find(row => row.t === 'guard_ready')
    assert.ok(guardReady)
    assert.deepEqual([...guardReady.allowedTools].sort(), ['read','write','edit','rovai_loom'].sort())
    const writes = [...guardReceipts.values()].filter(row => row.t === 'decision' && row.decision === 'allow' && ['write','edit'].includes(row.toolName))
    assert.ok(writes.some(row => row.toolName === 'write' && row.relPath === FILE), 'the native guard must observe the actual file write')
    assert.ok(writes.every(row => row.relPath === FILE), 'only the requested work file may be changed')
    const [tasks, candidates, artifactResult, reviews, claimResult] = await Promise.all([
      facts('loom.tasks.list', { missionId }), facts('loom.candidates.list', { missionId }),
      facts('loom.artifacts.list', { missionId }), facts('loom.reviews.list', { missionId }),
      facts('loom.claims.list', { missionId })
    ])
    const claims = Array.isArray(claimResult) ? claimResult : claimResult.claims
    const claim = claims.find(row => row.taskId === TASK && row.agentRunId === runId && row.claimantAgentId === agentId)
    assert.ok(claim, 'the real Run must hold its own task claim')
    assert.ok(Date.parse(claim.claimedAt) <= Math.min(...writes.map(row=>row.at)), 'the claim must precede the native file write')
    report.steps.claimBeforeWrite = { claimId: claim.claimId, fenceGeneration: claim.fenceGeneration, claimedAt: claim.claimedAt }
    const artifacts = Array.isArray(artifactResult) ? artifactResult : artifactResult.artifacts
    assert.equal(tasks.length, 1); assert.equal(tasks[0].taskId, TASK); assert.equal(tasks[0].assigneeAgentId, agentId)
    assert.equal(candidates.length, 1)
    const candidate = candidates[0]
    assert.equal(candidate.taskId, TASK); assert.equal(candidate.agentRunId, runId)
    assert.equal(String(candidate.acceptanceStatus).toLowerCase(), 'pending')
    const artifact = artifacts.find(row => candidate.evidenceIds.includes(row.artifactId) && row.relativePath === FILE && row.agentRunId === runId && row.taskId === TASK)
    assert.ok(artifact, 'candidate must reference this Run task primary file')
    assert.equal(artifact.creatorId, agentId)
    const archive = verifyArchivedArtifact({ registered: artifact, preview: await facts('loom.artifact.preview', { missionId, artifactId: artifact.artifactId }) })
    assert.equal(archive.ok, true, JSON.stringify(archive.reasons))
    assert.ok(archive.text.includes(marker) && archive.text.includes(nonce) && archive.text.includes('等待用户接受'))
    const workspaceRow = query("SELECT json_extract(workspace_json,'$.executionRoot') AS executionRoot FROM agent_run WHERE id=?", runId)[0]
    assert.ok(workspaceRow?.executionRoot)
    const realWorkspace = await realpath(workspaceRow.executionRoot)
    const filePath = join(realWorkspace, FILE)
    const fileReal = await realpath(filePath)
    const offset = relative(realWorkspace, fileReal)
    assert.ok(offset !== '' && offset !== '..' && !offset.startsWith('..' + sep))
    const bytes = await readFile(fileReal)
    assert.equal(hash(bytes), artifact.sha256)
    assert.ok(bytes.length <= 1000)
    assert.deepEqual(reviews, [])
    report.steps.nativeApplied = true
    report.steps.actualFile = { path: fileReal, sizeBytes: bytes.length, sha256: hash(bytes), markerMatchesSavedPersona: true, nonceMatchesUiGoal: true }
    report.steps.modelAuthoredDelivery = { taskId: TASK, candidateId: candidate.candidateId, artifactId: artifact.artifactId, acceptanceStatus: candidate.acceptanceStatus, verificationStatus: candidate.verificationStatus }
    report.artifact = artifact
    report.candidate = candidate
    await persist()

    await waitSignal('preview.allow')
    click(UI.runEntry)
    await waitPage('!!document.querySelector(' + JSON.stringify(UI.runDialog) + ')')
    const rowSelector = '.ln-run-panel[data-mission-id="' + missionId + '"] .ln-run-artifact[data-artifact-id="' + artifact.artifactId + '"] button.ln-run-file'
    await waitPage('(() => { const rows=document.querySelectorAll(' + JSON.stringify(rowSelector) + '); return rows.length===1&&!rows[0].disabled&&rows[0].getClientRects().length>0 })()', 60)
    click(rowSelector)
    await waitPage('!!document.querySelector(' + JSON.stringify(UI.artifactDialog) + ')')
    await waitPage('document.querySelector(".ln-artifact-document")?.innerText.includes(' + JSON.stringify(marker) + ') === true')
    assert.equal(await evalValue('document.querySelector(".ln-artifact-document")?.innerText.includes(' + JSON.stringify(nonce) + ')'), true)
    await screenshot('persona-artifact-preview')
    assert.deepEqual(await facts('loom.reviews.list', { missionId }), [])
    report.steps.finalUiPreview = true
    report.ownerReviewRecorded = false
    report.status = 'passed-ui-pi-append-real-file-delivery'
    await stage('complete')
  } catch (error) {
    report.status = 'failed'
    report.error = { name: error?.name, code: error?.coreError?.code ?? error?.code ?? null, message: String(error?.message ?? error).slice(0,1800) }
    if (runId) await captureNativeEvidence().catch(() => {})
    if (tabId && focusHeld) await screenshot('failed-ui').catch(() => {})
    await persist()
    throw new Error(redactDeep(report.error, secrets).message)
  } finally {
    if (tabId) {
      const closed = ab.runCall(['close','--tab',tabId], { env: process.env, budgetMs: 10000 })
      report.browserShutdown = { tabId, verdict: closed.verdict, reason: closed.reason }
    }
    let shutdownError = null
    if (prepared) {
      try {
        await prepared.host.close()
        const child = prepared.host.child
        report.shutdown = { pid: child.pid, exitCode: child.exitCode, signal: child.signalCode,
          confirmed: child.exitCode !== null || child.signalCode !== null }
        assert.equal(report.shutdown.confirmed, true)
      } catch (error) {
        shutdownError = error
        report.shutdown = { confirmed: false, error: String(error?.message ?? error).slice(0,400) }
        report.status = 'failed'
      }
    }
    report.finishedAt = new Date().toISOString()
    await persist()
    console.log(JSON.stringify({ status: report.status, report: join(OUT,'report.json'), stage: report.stage, runId: runId ?? null, ownerReviewRecorded: false }))
    if (shutdownError) throw new Error('owned_host_shutdown_unconfirmed')
  }
})
