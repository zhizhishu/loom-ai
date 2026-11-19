// Live one-Run acceptance: real production UI -> saved Pi Append -> frozen Run ->
// native activation/application -> model-authored file/Artifact/PENDING Candidate -> UI preview.
// Opt-in only. The existing isolated Host fixture seeds test assistants, but the
// page alone saves Persona/permission and creates/starts the work. No Owner verdict.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { prepareLivePiHost } from './loom-live-pi-host.mjs'
import { redactDeep, verifyArchivedArtifact } from '../accept-loom-live-lead.mjs'
import { UI, TEXT, findSecretLeak, pickNewMission, rosterJs, tagMemberJs, tagByTextJs } from './loom-browser-live-mode.mjs'
import * as ab from './ab-browser.mjs'
import { confirmOwnedPage, pageScript, radioChoiceSelector } from './loom-owned-page.mjs'

const OUT = resolve(process.env.LOOM_PI_PURGE_UI_EVIDENCE ?? '')
const optIn = process.env.LOOM_ALLOW_LIVE_ACCEPTANCE === '1' && process.env.LOOM_ALLOW_PI_PURGE_UI_ACCEPTANCE === '1'
const pause = ms => new Promise(done => setTimeout(done, ms))
const hash = data => createHash('sha256').update(data).digest('hex')

// The rendered value of the Lead choice trigger; the controlled read for both the
// re-pick decision and its read-back.
const LEAD_TEXT_JS = 'document.querySelector(' + JSON.stringify(UI.leadTrigger) + ')?.querySelector(":scope > span:not(.ln-avatar)")?.textContent.trim()'

// The Lead is re-picked only when the rendered controlled value is not the target
// member. One pick, then the rendered value is read back. Kept as one extractable
// function so the offline page-script test drives this branch instead of the live run.
async function applyLeadChoice(evalValue, choose, persist, report, target, assert) {
  const currentLead = await evalValue(LEAD_TEXT_JS)
  const patch = { currentLead: currentLead ?? null, targetMember: target.displayName, repicked: currentLead !== target.displayName }
  report.steps.leadChoice = patch
  if (currentLead === target.displayName) {
    await persist()
    return patch
  }
  await choose(UI.leadTrigger, target.displayName, 'purge-lead')
  const appliedLead = await evalValue(LEAD_TEXT_JS)
  assert.equal(appliedLead, target.displayName, 'the chosen Lead must render as the controlled value')
  patch.appliedLead = appliedLead
  await persist()
  return patch
}
const FILE = 'pi-persona-result.md'
// The model-facing byte ask and the independent hard cap are reported separately: the
// goal text is not a gate, the hard cap is.
const MAX_BYTES_ASKED = 200
const HARD_MAX_BYTES = 1000
const LITERAL_ACCEPT_LINE = '等待用户接受'
// The rendered body area only. The aside shows the task description, which may quote the
// goal text, so a marker read from the whole dialog proves nothing about the file body.
const ARTIFACT_BODY_TEXT_JS = '(() => { const doc = document.querySelector(".ln-artifact-dialog .ln-artifact-document"); if (!doc) return null; const body = doc.querySelector(".ln-markdown, .ln-artifact-text"); return body ? body.innerText : null })()'
const ARTIFACT_PREVIEW_SETTLED_JS = '(() => { const doc = document.querySelector(".ln-artifact-dialog .ln-artifact-document"); if (!doc) return false; if (doc.querySelector(".ln-artifact-state[data-state=reading]")) return false; return !!(doc.querySelector(".ln-markdown, .ln-artifact-text") || doc.querySelector(".ln-artifact-state[data-state=error], .ln-artifact-state[data-state=unavailable]")) })()'
const ARTIFACT_DIALOG_READ_JS = '(() => { const dialog = document.querySelector(".ln-artifact-dialog"); if (!dialog) return null; const doc = dialog.querySelector(".ln-artifact-document"); const failed = doc ? doc.querySelector(".ln-artifact-state[data-state=error], .ln-artifact-state[data-state=unavailable]") : null; const body = doc ? doc.querySelector(".ln-markdown, .ln-artifact-text") : null; return { titleText: dialog.querySelector(".ln-artifact-title")?.textContent.trim() ?? null, settled: { state: failed ? failed.dataset.state : (body ? "ready" : "unknown"), reason: failed ? failed.dataset.reason ?? null : null }, bodyText: body ? body.innerText : null } })()'
const STUDIO = '.ln-surface-dialog.ln-studio'
const PERSONA_INPUT = STUDIO + ' textarea[aria-label="Pi Purge 人格提示词"]'
const PURGE_TRIGGER = STUDIO + ' button[aria-label="Pi Purge 模式"]'
const FILE_TRIGGER = STUDIO + ' button[aria-label="文件与任务权限"]'
const WAIT_NAMES = new Set([
  'login_form', 'app_ready', 'studio_open', 'assistant_selected', 'runtime_controls_ready',
  'purge_trigger_ready', 'purge_selection_applied', 'file_trigger_ready', 'file_selection_applied',
  'lead_trigger_ready', 'lead_selection_applied',
  'permission_confirmation', 'runtime_saved', 'studio_closed', 'work_dialog_open', 'work_dialog_closed',
  'run_panel_open', 'artifact_row_ready', 'artifact_preview_open', 'artifact_preview_settled'
])

// Verbatim device paths (`\\?\C:\...`) name the same directory as the plain form.
function normalizeRoot(value) {
  if (typeof value !== 'string' || value === '') return null
  return value.replace(/^\\\\\?\\/u, '').replace(/[\\/]+$/u, '').toLowerCase()
}

// Five provenance conclusions, all of them hard. Every one fails closed.
// 1. the target was observed absent at this exact path before the UI submitted;
// 2. the Run really worked in that same directory;
// 3. the first write to the target inside this Run/bot/epoch guard log created a new file
//    under a claim that was already held;
// Extracted (parameter-only) so `loom-pi-purge-page-scripts.test.mjs` can drive the
// negatives offline, without a Host, a browser, or a model request.
function adjudicateSourceProvenance(raw, assert) {
  const relativePath = raw.relativePath
  const baseline = raw.baseline ?? {}
  assert.equal(baseline.exists, false, 'the target file must not exist before the UI submits')
  assert.equal(baseline.errorCode, 'ENOENT', 'the baseline must observe ENOENT, not an existing file or a permission error')
  assert.equal(baseline.insideDataDir, true, 'the target path must stay inside the isolated data directory')
  assert.equal(baseline.relativePath, relativePath)
  const baselineRoot = normalizeRoot(baseline.executionRoot)
  const runRoot = normalizeRoot(raw.workspace?.executionRoot)
  assert.ok(baselineRoot, 'the baseline must record its execution root')
  assert.ok(runRoot, 'the Run must record its workspace execution root')
  assert.equal(runRoot, baselineRoot, 'the Run workspace must be the directory the baseline observed')
  const guard = raw.guard ?? {}
  assert.equal(guard.epoch, raw.epoch, 'the guard log must belong to this execution epoch')
  assert.equal(guard.runId, raw.runId, 'the guard log must belong to this Run')
  assert.equal(guard.botId, raw.botId, 'the guard log must belong to this member')
  const rows = guard.rows ?? []
  const writeDecisions = rows.filter(row => row.t === 'decision' && ['write', 'edit'].includes(row.toolName))
  assert.ok(writeDecisions.every(row => row.relPath === relativePath), 'only the requested work file may be written')
  const writes = writeDecisions.filter(row => row.relPath === relativePath)
  assert.ok(writes.length > 0, 'the guard must observe the actual write of the target file')
  const first = [...writes].sort((left, right) => left.at - right.at)[0]
  assert.equal(first.toolName, 'write', 'the first write to the target must be a native write')
  assert.equal(first.decision, 'allow', 'the first write to the target must be allowed')
  assert.equal(first.reasonCode, 'in_workspace_new_file', 'the first write must create the file, not overwrite one')
  const claimedAt = Date.parse(raw.claim?.claimedAt ?? '')
  assert.ok(Number.isFinite(claimedAt), 'the claim must carry a parseable claimedAt')
  assert.ok(claimedAt <= first.at, 'the claim must precede the first write of the target file')
  return {
    before: { executionRoot: baseline.executionRoot, relativePath, observedAt: baseline.observedAt, exists: false, errorCode: baseline.errorCode },
    workspace: { executionRootRaw: raw.workspace.executionRoot, matchesBaselineRoot: true, isolation: raw.workspace.isolation ?? null },
    claim: { claimId: raw.claim.claimId, claimedAt: raw.claim.claimedAt, claimedAtMs: claimedAt, epoch: raw.epoch },
    firstWrite: { toolName: first.toolName, decision: first.decision, reasonCode: first.reasonCode, relPath: first.relPath, at: first.at, atIso: new Date(first.at).toISOString(), guardPath: guard.path ?? null, claimedAtBeforeWrite: true }
  }
}

// The archived text is split into whole lines. Only the random persona marker is a
// content gate; the work nonce and the literal accept line are reported compliance.
// `exactCopyMet` is therefore true only when the model copied the requested lines.
function adjudicateContentCompliance(raw, assert) {
  const text = raw.text
  assert.equal(typeof text, 'string', 'the archived text must be readable')
  const lines = text.split(/\r?\n/u).map(line => line.trim())
  const personaMarkerLine = lines.includes(raw.marker)
  const workNonceLine = lines.includes(raw.nonce)
  const literalAcceptLine = lines.includes(raw.literalAccept)
  const sizeBytes = raw.sizeBytes
  assert.ok(Number.isInteger(sizeBytes) && sizeBytes >= 0, 'the archive size must be a real byte count')
  assert.equal(sizeBytes, Buffer.byteLength(text, 'utf8'), 'the archive text must be the exact file bytes')
  assert.ok(sizeBytes <= raw.hardMaxBytes, 'the delivered file must stay under the hard byte cap')
  assert.equal(personaMarkerLine, true, 'the archive must carry this round whole-line persona marker')
  return {
    personaMarkerLine, workNonceLine, literalAcceptLine, sizeBytes,
    requestedMaxBytes: raw.requestedMaxBytes, hardMaxBytes: raw.hardMaxBytes,
    withinRequestedMaxBytes: sizeBytes <= raw.requestedMaxBytes,
    exactCopyMet: workNonceLine && literalAcceptLine && sizeBytes <= raw.requestedMaxBytes
  }
}

// Opening a result must never accept it: PENDING and zero Owner Reviews, read before and
// after the preview opens.
function adjudicateCandidateState(raw, assert) {
  const result = { before: null, after: null, autoAccepted: false }
  for (const phase of ['before', 'after']) {
    const state = raw[phase] ?? {}
    const status = typeof state.acceptanceStatus === 'string' ? state.acceptanceStatus.toLowerCase() : null
    assert.equal(status, 'pending', 'the candidate must still be PENDING ' + phase + ' the preview')
    assert.equal(status === 'accepted' || status === 'rejected', false, 'the candidate must never be auto-accepted ' + phase + ' the preview')
    assert.equal(state.reviewCount, 0, 'no Owner Review may exist ' + phase + ' the preview')
    result[phase] = { acceptanceStatus: state.acceptanceStatus, reviewCount: state.reviewCount }
  }
  return result
}

// The dialog must show the registered file name and the body area — not the aside — must
// render this round marker, after the preview reached a terminal state.
function adjudicatePreviewEvidence(raw, assert) {
  assert.equal(raw.settled?.state, 'ready', 'the preview must settle on a body, not on loading, error or unavailable')
  assert.equal(raw.titleText, raw.relativePath, 'the dialog must show the registered artifact file name')
  assert.equal(typeof raw.bodyText, 'string', 'the rendered body must be readable')
  assert.equal(raw.bodyText.includes(raw.marker), true, 'the rendered body area must show this round persona marker')
  return { settledState: raw.settled.state, titleShown: raw.titleText, markerInBody: true, bodyLength: raw.bodyText.length }
}

// Every record in the chain must point at the same Run, Task, Artifact and Candidate.
function adjudicateChainBinding(raw, assert) {
  const { task, claim, candidate, artifact, runId, agentId, relativePath } = raw
  assert.ok(claim, 'the real Run must hold its own task claim')
  assert.equal(claim.agentRunId, runId, 'the claim must name this Run')
  assert.equal(claim.claimantAgentId, agentId, 'the claim must name this member')
  assert.equal(claim.taskId, task.taskId, 'the claim must name the single Task')
  assert.equal(candidate.taskId, task.taskId, 'the candidate must reference the single Task')
  assert.equal(candidate.agentRunId, runId, 'the candidate must reference this Run')
  assert.ok(Array.isArray(candidate.evidenceIds) && candidate.evidenceIds.includes(artifact.artifactId), 'the candidate must reference the registered artifact')
  assert.equal(artifact.agentRunId, runId, 'the artifact must be registered by this Run')
  assert.equal(artifact.taskId, task.taskId, 'the artifact must be bound to the Task')
  assert.equal(artifact.creatorId, agentId, 'the artifact must be created by the claimed member')
  assert.equal(artifact.relativePath, relativePath, 'the artifact must register the requested file')
  return { taskId: task.taskId, claimId: claim.claimId, candidateId: candidate.candidateId, artifactId: artifact.artifactId }
}

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
    marker, nonce, personaSha256: hash(persona), provenance: {}, contentCompliance: null,
    steps: {}, screenshots: {}, startedAt: new Date().toISOString()
  }
  const secrets = [process.env.LOOM_E4_PROVIDER_KEY].filter(Boolean)
  let prepared, tabId, runId, epoch, missionId, threadId, agentId, latestSnapshot
  let focusHeld = false
  const receipts = new Map(), guardReceipts = new Map(), guardFiles = new Map(), bindings = new Map()
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
  async function waitPage(name, expression, seconds = 45) {
    assert.equal(WAIT_NAMES.has(name), true, 'page wait must have a fixed diagnostic name')
    report.waitingFor = name
    await persist()
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      if (await evalValue(expression) === true) {
        report.lastSatisfiedWait = name
        report.waitingFor = null
        await persist()
        return
      }
      await pause(600)
    }
    report.waitTimeout = { name, seconds }
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
    // Every real choice target the fixture drives, declared here so the page
    // script test can extract and drive this one function unchanged.
    const waits = {
      'purge-append': ['purge_trigger_ready', 'purge_selection_applied'],
      'purge-file-policy': ['file_trigger_ready', 'file_selection_applied'],
      'purge-lead': ['lead_trigger_ready', 'lead_selection_applied']
    }[tag]
    assert.ok(waits, 'unknown choice target: ' + tag)
    const [readyWait, selectedWait] = waits
    await waitPage(readyWait, '(() => { const e=document.querySelector(' + JSON.stringify(trigger) + '); return !!e&&!e.disabled&&e.getAttribute("aria-disabled")!=="true"&&e.getClientRects().length>0 })()')
    await evalValue('(() => { document.querySelector(' + JSON.stringify(trigger) + ').scrollIntoView({block:"center"}); return true })()')
    const actual = label
    report.steps.choiceInputs ??= []
    const input = { name: label, phase: 'pick_started', opener: 'owned_by_idempotent_pick' }
    report.steps.choiceInputs.push(input)
    await persist()
    const picked = ab.abPick(tabId, radioChoiceSelector(actual), { env: process.env, open: trigger, value: actual })
    Object.assign(input, { phase: 'pick_returned', verdict: picked.verdict, reason: picked.reason })
    await persist()
    let final = picked
    if (picked.verdict === 'FAILED' && picked.reason === 'pick_not_found') {
      // A missing option means the toggle never expanded: nothing was picked, so one
      // bounded repeat of the same opener cannot duplicate a selection. Any other
      // failure (UNKNOWN included) stays final and is never replayed.
      input.phase = 'pick_retry_after_missing_option'
      await persist()
      final = ab.abPick(tabId, radioChoiceSelector(actual), { env: process.env, open: trigger, value: actual })
      Object.assign(input, { phase: 'pick_returned_retry', verdict: final.verdict, reason: final.reason, attempts: 2 })
      await persist()
    }
    // An uncertain click is never replayed: only the exact controlled trigger proves selection.
    await waitPage(selectedWait, 'document.querySelector(' + JSON.stringify(trigger) + ')?.querySelector(":scope > span:not(.ln-avatar)")?.textContent.trim() === ' + JSON.stringify(actual), 20)
    input.phase = 'selection_verified'
    await persist()
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
  // The only acceptable baseline: the exact target path is absent (ENOENT) before the UI
  // submits. An existing file, a permission error or an escaping path all fail closed.
  async function observeBaselineTarget() {
    const dataDir = resolve(prepared.evidence.dataDir)
    const root = resolve(dataDir, 'quick-chat')
    const target = resolve(root, FILE)
    const offset = relative(dataDir, target)
    const insideDataDir = offset !== '' && offset !== '..' && !offset.startsWith('..' + sep) && !isAbsolute(offset)
    let exists = null, errorCode = null
    try {
      await lstat(target)
      exists = true
    } catch (error) {
      exists = false
      errorCode = error?.code ?? 'unknown'
    }
    const record = { executionRoot: root, relativePath: FILE, targetPath: target,
      observedAt: new Date().toISOString(), exists, errorCode, insideDataDir }
    report.provenance.before = record
    await persist()
    return record
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
        if (entry.name === 'guard.jsonl' && guardOwnedByRun) {
          // The execution epoch is carried by the log directory name `<runId>-<epoch>`, so a
          // log left over from an older epoch can never stand in for this Run's log.
          const directory = basename(dirname(path))
          const prefix = runId + '-'
          const parsed = directory.startsWith(prefix) ? Number(directory.slice(prefix.length)) : Number.NaN
          guardFiles.set(path, { path, epoch: Number.isInteger(parsed) ? parsed : null, runId, botId: agentId,
            rows: rows.map(row => ({ ...row })) })
        }
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
    prepared = await prepareLivePiHost({ configPath, providerKey: process.env.LOOM_E4_PROVIDER_KEY,
      timingsPath: join(OUT, 'host-preparation.json') })
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
    await waitPage('login_form', '!!document.querySelector(' + JSON.stringify(UI.loginToken) + ')', 60)
    assert.equal(ab.abFill(tabId, UI.loginToken, prepared.adminToken, { env: process.env }).verdict, 'OK')
    click(UI.loginSubmit)
    await waitPage('app_ready', '!document.querySelector(' + JSON.stringify(UI.loginOverlay) + ') && !!document.querySelector(' + JSON.stringify(UI.appRoot) + ')', 90)
    await stage('save_append_from_ui')
    click('.ln-rail button[aria-label="管理助手"]')
    await waitPage('studio_open', '!!document.querySelector(' + JSON.stringify(STUDIO) + ')')
    await clickText(STUDIO + ' .ln-studio-roster button', target.displayName, 'purge-assistant')
    await waitPage('assistant_selected', 'document.querySelector(' + JSON.stringify(STUDIO + ' .ln-studio-identity h3') + ')?.textContent.trim() === ' + JSON.stringify(target.displayName))
    await clickText(STUDIO + ' .ln-studio-tabs button', '运行与权限', 'purge-runtime')
    await waitPage('runtime_controls_ready', '(() => { const e=document.querySelector(' + JSON.stringify(PURGE_TRIGGER) + '); return !!e&&!e.disabled&&e.getAttribute("aria-disabled")!=="true" })()')
    await choose(PURGE_TRIGGER, '追加助手设定', 'purge-append')
    assert.equal(ab.abFill(tabId, PERSONA_INPUT, persona, { env: process.env }).verdict, 'OK')
    await choose(FILE_TRIGGER, '读写文件并处理任务', 'purge-file-policy')
    await screenshot('append-draft')
    await clickText(STUDIO + ' .ln-form-actions button', '保存运行配置', 'purge-save')
    await waitPage('permission_confirmation', '[...document.querySelectorAll(".ln-surface-title h2")].some(e=>e.textContent.trim()==="确认权限配置")')
    const confirmation = '.ln-surface-dialog.ln-room-dialog'
    await clickText(confirmation + ' .ln-form-actions button', '确认并保存', 'purge-confirm')
    await waitPage('runtime_saved', '[...document.querySelectorAll(' + JSON.stringify(STUDIO + ' [role="status"]') + ')].some(e=>e.textContent.includes("已保存，下次运行生效。"))', 60)
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
    await waitPage('studio_closed', '!document.querySelector(' + JSON.stringify(STUDIO) + ')')

    // The tool writes this text verbatim into the Mission description. Four earlier
    // rounds showed a long briefing gets summarised: the model paraphrased the accept
    // line, dropped the work nonce, and added its own title and table. So the copy
    // template is now the last thing in the text, outside any code fence, with no
    // competing "write a heading/status" wording anywhere in the instruction.
    // The persona marker is deliberately NOT named here: it must arrive through the
    // frozen persona, and `goal.includes(marker) === false` is the proof of that.
    const goal = [
      '隔离验收：只做一件事，把最后几行原样写进 ' + FILE + ' 并登记提交。',
      '你是主助手也是唯一执行者，成员ID是 ' + agentId + '。',
      '1) rovai_loom：loom.status → loom.plan（恰好 1 个任务，assigneeAgentId 填 ' + agentId + '）→ loom.release → loom.claim 认领它。',
      '2) 原生 write 写 ' + FILE + '。',
      '3) 原生 read 自查：文件必须含下面列出的每一整行；缺任何一行就整份重写。',
      '4) loom.evidence 以相对路径 ' + FILE + ' 登记并绑定该任务；loom.submit 提交该 artifactId。',
      '完成后停止，候选待用户接受；不要评审、不要接受、不要用 bash/shell/MCP、不要写其他文件。',
      '写入文件的全部内容就是下面这几行，逐字复制，顺序不限：不要改字、不要翻译、不要同义替换、不要补任何额外的行。',
      nonce,
      '等待用户接受',
      '你当前已生效的助手设定要求写入的那一整行标记（设定要求的那一行必须原样写入）',
      '上面这几行之外不要写任何内容；整份文件不超过 ' + MAX_BYTES_ASKED + ' 字节。'
    ].join('\n')
    assert.equal(goal.includes(marker), false)
    report.steps.personaMarkerAbsentFromGoal = true
    // The nonce stays in the submitted goal: it proves what the UI actually asked for.
    report.steps.submittedGoalCarriesWorkNonce = goal.split(/\r?\n/u).includes(nonce)
    report.goalSha256 = hash(goal)
    await stage('start_one_work_from_ui')
    click(UI.newConversation)
    await waitPage('work_dialog_open', '!!document.querySelector(' + JSON.stringify(UI.roomDialog) + ')')
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
    await applyLeadChoice(evalValue, choose, persist, report, target, assert)
    const title = 'Pi 个人设定真实验收 ' + nonce.slice(-8)
    assert.equal(ab.abFill(tabId, UI.workName, title, { env: process.env }).verdict, 'OK')
    assert.equal(ab.abFill(tabId, UI.workGoal, goal, { env: process.env }).verdict, 'OK')
    assert.equal(await evalValue('document.querySelector(' + JSON.stringify(UI.workGoal) + ')?.value === ' + JSON.stringify(goal)), true)
    if (await evalValue('document.querySelector(' + JSON.stringify(UI.startNow) + ')?.checked') !== true) click(UI.startNow)
    // 1. Source baseline, taken immediately before the one submit that starts the work.
    const baseline = await observeBaselineTarget()
    assert.equal(baseline.insideDataDir, true, 'the target path must stay inside the isolated data directory')
    assert.equal(baseline.exists, false, 'the target file must not exist before the UI submits')
    assert.equal(baseline.errorCode, 'ENOENT', 'the baseline must observe ENOENT, not an existing file or a permission error')
    click(UI.roomSubmit)
    await waitPage('work_dialog_closed', '!document.querySelector(' + JSON.stringify(UI.roomDialog) + ')', 90)
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
    const writeDecisions = [...guardReceipts.values()].filter(row => row.t === 'decision' && ['write','edit'].includes(row.toolName))
    assert.ok(writeDecisions.some(row => row.toolName === 'write' && row.relPath === FILE), 'the native guard must observe the actual file write')
    assert.ok(writeDecisions.every(row => row.relPath === FILE), 'only the requested work file may be changed')
    const [tasks, candidates, artifactResult, reviews, claimResult] = await Promise.all([
      facts('loom.tasks.list', { missionId }), facts('loom.candidates.list', { missionId }),
      facts('loom.artifacts.list', { missionId }), facts('loom.reviews.list', { missionId }),
      facts('loom.claims.list', { missionId })
    ])
    const claims = Array.isArray(claimResult) ? claimResult : claimResult.claims
    // The task id is whatever loom.plan assigned; the chain is proven by every
    // record pointing at that same task, not by a fixture-chosen literal.
    // `assigneeAgentId` is optional in the loom.plan schema, so a plan may leave the
    // Task unassigned and let the Claim carry execution: the binding proof is the
    // Claim that names this Run and this member, not the optional plan field.
    assert.equal(tasks.length, 1, 'this round permits exactly one Task')
    const task = tasks[0]
    assert.ok(typeof task.taskId === 'string' && task.taskId.length > 0, 'the Task must have a real id')
    assert.ok(task.assigneeAgentId === null || task.assigneeAgentId === agentId,
      'the single Task must never be assigned to another member')
    const claim = claims.find(row => row.taskId === task.taskId && row.agentRunId === runId && row.claimantAgentId === agentId)
    assert.ok(claim, 'the real Run must hold its own task claim')
    const artifacts = Array.isArray(artifactResult) ? artifactResult : artifactResult.artifacts
    assert.equal(tasks.length, 1); assert.equal(tasks[0].taskId, task.taskId)
    assert.ok(tasks[0].assigneeAgentId === null || tasks[0].assigneeAgentId === agentId)
    // The real Task row, not an ID summary: the round has to show who held it and
    // what state it settled in beside the Claim that this Run actually took.
    report.task = {
      taskId: task.taskId, assigneeAgentId: task.assigneeAgentId,
      status: task.status ?? null, title: task.title ?? null,
      acceptanceCriteriaVersion: task.acceptanceCriteriaVersion ?? null,
      revision: task.revision ?? null,
      claimId: claim.claimId, claimantAgentId: claim.claimantAgentId,
      claimAgentRunId: claim.agentRunId, claimStatus: claim.status ?? null
    }
    assert.equal(candidates.length, 1)
    const candidate = candidates[0]
    assert.equal(candidate.taskId, task.taskId); assert.equal(candidate.agentRunId, runId)
    assert.equal(String(candidate.acceptanceStatus).toLowerCase(), 'pending')
    const artifact = artifacts.find(row => candidate.evidenceIds.includes(row.artifactId) && row.relativePath === FILE && row.agentRunId === runId && row.taskId === task.taskId)
    assert.ok(artifact, 'candidate must reference this Run task primary file')
    report.steps.chainBinding = adjudicateChainBinding({ task, claim, candidate, artifact, runId, agentId, relativePath: FILE }, assert)
    const archive = verifyArchivedArtifact({ registered: artifact, preview: await facts('loom.artifact.preview', { missionId, artifactId: artifact.artifactId }) })
    assert.equal(archive.ok, true, JSON.stringify(archive.reasons))
    // 5. Content: only the whole-line persona marker is a gate. The work nonce, the literal
    //    accept line and the byte ask are measured compliance and reported exactly as observed.
    report.contentCompliance = adjudicateContentCompliance({
      text: archive.text, marker, nonce, literalAccept: LITERAL_ACCEPT_LINE,
      sizeBytes: archive.archiveSizeBytes, requestedMaxBytes: MAX_BYTES_ASKED, hardMaxBytes: HARD_MAX_BYTES
    }, assert)
    const workspaceRow = query("SELECT json_extract(workspace_json,'$.executionRoot') AS executionRoot, json_extract(workspace_json,'$.isolation') AS isolation FROM agent_run WHERE id=?", runId)[0]
    assert.ok(workspaceRow?.executionRoot)
    const realWorkspace = await realpath(workspaceRow.executionRoot)
    const filePath = join(realWorkspace, FILE)
    const fileReal = await realpath(filePath)
    const offset = relative(realWorkspace, fileReal)
    assert.ok(offset !== '' && offset !== '..' && !offset.startsWith('..' + sep))
    const bytes = await readFile(fileReal)
    assert.equal(hash(bytes), artifact.sha256)
    assert.ok(bytes.length <= HARD_MAX_BYTES, 'the delivered file must stay under the hard byte cap')
    assert.equal(report.contentCompliance.sizeBytes, bytes.length, 'the archive size and the workspace size must agree')
    assert.deepEqual(reviews, [])
    // 2-3. This epoch's guard log, the first write of the target, and the three-way digest.
    const guardFile = [...guardFiles.values()].find(file => file.epoch === epoch)
    assert.ok(guardFile, 'the guard log of this execution epoch must exist')
    const provenance = adjudicateSourceProvenance({
      relativePath: FILE, epoch, runId, botId: agentId, baseline,
      workspace: { executionRoot: workspaceRow.executionRoot, isolation: workspaceRow.isolation ?? null },
      claim: { claimId: claim.claimId, claimedAt: claim.claimedAt },
      guard: guardFile
    }, assert)
    const shas = { workspace: hash(bytes), artifact: artifact.sha256, archive: archive.archiveSha256 }
    assert.equal(shas.workspace, shas.artifact, 'the workspace bytes and the registration digest must match')
    assert.equal(shas.artifact, shas.archive, 'the registered digest and the archive digest must match')
    const personaShas = { savedUi: report.steps.uiSaved.personaSha256, frozenRun: report.frozen.personaSha256, receipt: applied[0].personaSha256 }
    assert.equal(new Set(Object.values(personaShas)).size, 1, 'the saved, frozen and receipt persona digests must be identical')
    assert.equal(personaShas.frozenRun, report.personaSha256)
    report.provenance = { ...provenance, shas: { ...shas, allEqual: true }, persona: { ...personaShas, allEqual: true } }
    report.steps.claimBeforeWrite = { claimId: provenance.claim.claimId, claimedAt: provenance.claim.claimedAt,
      firstWriteAt: provenance.firstWrite.atIso, claimedBeforeWrite: provenance.firstWrite.claimedAtBeforeWrite }
    report.steps.nativeApplied = true
    report.steps.actualFile = { path: fileReal, sizeBytes: bytes.length, sha256: hash(bytes),
      personaMarkerLine: report.contentCompliance.personaMarkerLine,
      workNonceLine: report.contentCompliance.workNonceLine,
      literalAcceptLine: report.contentCompliance.literalAcceptLine }
    report.steps.modelAuthoredDelivery = { taskId: task.taskId, candidateId: candidate.candidateId, artifactId: artifact.artifactId, acceptanceStatus: candidate.acceptanceStatus, verificationStatus: candidate.verificationStatus }
    report.artifact = artifact
    report.candidate = candidate
    await persist()

    // 4. Capture first, adjudicate second. The page, the Mission and the Artifact binding are
    //    already proven above, so the preview and its screenshot are taken before any content
    //    verdict: a content failure still leaves the real UI on record.
    const readCandidateGate = async () => {
      const candidateRows = await facts('loom.candidates.list', { missionId })
      const current = candidateRows.find(row => row.candidateId === candidate.candidateId)
      const reviewRows = await facts('loom.reviews.list', { missionId })
      return { acceptanceStatus: current?.acceptanceStatus ?? null, reviewCount: reviewRows.length }
    }
    const beforeOpen = await readCandidateGate()
    report.steps.preview = { before: beforeOpen, artifactRowId: artifact.artifactId }
    assert.equal(String(beforeOpen.acceptanceStatus ?? '').toLowerCase(), 'pending', 'the candidate must be PENDING before the preview opens')
    assert.equal(beforeOpen.reviewCount, 0, 'no Owner Review may exist before the preview opens')
    let shown = null
    try {
      await waitSignal('preview.allow')
      click(UI.runEntry)
      await waitPage('run_panel_open', '!!document.querySelector(' + JSON.stringify(UI.runDialog) + ')')
      const rowSelector = '.ln-run-panel[data-mission-id="' + missionId + '"] .ln-run-artifact[data-artifact-id="' + artifact.artifactId + '"] button.ln-run-file'
      await waitPage('artifact_row_ready', '(() => { const rows=document.querySelectorAll(' + JSON.stringify(rowSelector) + '); return rows.length===1&&!rows[0].disabled&&rows[0].getClientRects().length>0 })()', 60)
      click(rowSelector)
      await waitPage('artifact_preview_open', '!!document.querySelector(' + JSON.stringify(UI.artifactDialog) + ')')
      await waitPage('artifact_preview_settled', ARTIFACT_PREVIEW_SETTLED_JS, 90)
      shown = await evalValue(ARTIFACT_DIALOG_READ_JS)
      const bodyText = await evalValue(ARTIFACT_BODY_TEXT_JS)
      if (shown && typeof shown === 'object') shown.bodyText = bodyText
      await screenshot('persona-artifact-preview')
      report.screenshots['persona-artifact-preview'].capturedBeforeContentAdjudication = true
      await stage('preview_captured')
    } catch (error) {
      report.previewCaptureUnavailable = { stage: report.waitingFor ?? 'preview_capture',
        reason: String(error?.message ?? error).slice(0, 300), focusHeld,
        screenshot: report.screenshots['persona-artifact-preview'] ?? null }
      if (focusHeld) await screenshot('failed-preview').catch(() => {})
      await persist()
      throw error
    }
    // The same Candidate is re-read before the body is judged: opening a result must never accept it.
    const afterOpen = await readCandidateGate()
    report.steps.preview.after = afterOpen
    report.provenance.candidate = adjudicateCandidateState({ before: beforeOpen, after: afterOpen }, assert)
    report.steps.preview.evidence = adjudicatePreviewEvidence({
      settled: shown?.settled ?? null, titleText: shown?.titleText ?? null,
      bodyText: shown?.bodyText ?? null, marker, relativePath: FILE
    }, assert)
    report.steps.preview.bodyTextSha256 = shown?.bodyText ? hash(shown.bodyText) : null
    report.provenance.checks = {
      baselineAbsentBeforeSubmit: report.provenance.before?.errorCode === 'ENOENT',
      runWorkspaceEqualsBaselineRoot: report.provenance.workspace?.matchesBaselineRoot === true,
      firstWriteNewFileAfterClaim: report.provenance.firstWrite?.claimedAtBeforeWrite === true,
      threeWayShaEqual: report.provenance.shas?.allEqual === true,
      candidatePendingNoOwnerReview: report.provenance.candidate?.autoAccepted === false,
      personaMarkerLineInArchive: report.contentCompliance.personaMarkerLine
    }
    report.exactCopyMet = report.contentCompliance.exactCopyMet
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
