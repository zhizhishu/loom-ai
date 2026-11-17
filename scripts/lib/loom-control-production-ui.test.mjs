// Live acceptance: the REAL page creates and starts the work, the Lead authors exactly two tasks,
// and the user (through this harness) approves the automatic relay scope in the real control panel.
//
// Opt-in only (`LOOM_ALLOW_LIVE_ACCEPTANCE=1`). Two modes:
// - `external`: `LOOM_BROWSER_HOST_CONFIG` describes an already prepared isolated Host; this file
//   treats it as READ-ONLY and never closes it. The administrator token comes from
//   `LOOM_ADMIN_TOKEN_ENV` / `LOOM_ADMIN_TOKEN_FILE`, never from JSON and never printed.
// - `self`: this file prepares its own protected data-root with the product's own
//   `--prepare-windows-data-root`, seeds four members + their Pi runtime, and takes the token from
//   `host.web.start`.
//
// The Host is never allowed to author a plan, release a task, register an artifact/claim/candidate
// or record a review: mission creation, start, plan and review all come from the page or a model.
// No Owner acceptance is recorded here; a test-only click would be reported as such.

import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { prepareLivePiHost } from './loom-live-pi-host.mjs'
import { buildMissionDescription, redactDeep, summarizeLeadChain, verifyArchivedArtifact } from '../accept-loom-live-lead.mjs'
import * as ab from './ab-browser.mjs'
import {
  HOST_CONFIG_ENV,
  PROVIDER_KEY_ENV,
  ROLE_ORDER,
  TEXT,
  UI,
  chainGate,
  findSecretLeak,
  hostMode,
  liveGate,
  parseHostConfig,
  pickNewMission,
  relayStateJs,
  resolveAdminToken,
  rosterJs,
  screenshotGate,
  tagByTextJs,
  tagChoiceItemJs,
  tagMemberJs,
  tagNthJs,
  workerIds,
  workerTasks
} from './loom-browser-live-mode.mjs'

const REPOSITORY = resolve(import.meta.dirname, '../..')
const OUT = resolve(process.env.LOOM_UI_EVIDENCE_ROOT ?? join(REPOSITORY, '_artifacts', 'loom-control-ui-live', `run-${Date.now()}`))
const READY_BUDGET_MS = 180_000
const LEAD_PLAN_BUDGET_MS = 15 * 60_000
const CHAIN_BUDGET_MS = 25 * 60_000
const gate = liveGate(process.env)
const sleep = ms => new Promise(done => setTimeout(done, ms))

test('real page creates and starts the work, then approves the relay scope for the Lead', {
  timeout: 3_600_000,
  skip: gate.allowed ? false : `opt-in required: ${gate.reason}`
}, async (t) => {
  const report = {
    scope: 'live-control-scope-approval-from-real-ui',
    mode: hostMode(process.env),
    hostAuthoredMission: false,
    hostAuthoredPlan: false,
    ownerReviewRecorded: false,
    ownerReviewIsTestAction: false,
    steps: {},
    screenshots: {},
    status: 'running'
  }
  const secrets = []
  let host = null
  let ownsHost = false
  let tabId = null
  let roles = null
  let facts = null
  try {
    const prepared = await prepare()
    secrets.push(...prepared.secrets)
    facts = prepared.facts
    roles = prepared.roles
    await mkdir(OUT, { recursive: true })

    const before = await facts('missions.list')
    report.steps.missionsBefore = Array.isArray(before) ? before.length : null

    // ---- real Chrome, explicit tab only ----
    const ready = ab.abReady({ env: process.env })
    report.steps.browserDoor = { verdict: ready.verdict, reason: ready.reason }
    assert.equal(ready.ok, true, `the browser door is not confirmed usable (${ready.verdict}/${ready.reason})`)
    const opened = ab.abOpen(prepared.origin, { env: process.env })
    assert.equal(opened.confirmed, true, `open did not return its own tab id (${opened.verdict}/${opened.reason})`)
    tabId = opened.openedTabId
    console.log(JSON.stringify({ liveUiStage: 'opened_owned_tab', tabId }))

    // ---- login with the isolated Host's own credential (memory only, never printed) ----
    await waitFor(`return !!document.querySelector(${JSON.stringify(UI.loginToken)})`, 60)
    assert.equal(ab.abFill(tabId, UI.loginToken, prepared.adminToken, { env: process.env }).verdict, 'OK', 'login field fill was not confirmed')
    ab.abClick(tabId, UI.loginSubmit, { env: process.env })
    await waitFor(`return document.querySelector(${JSON.stringify(UI.loginOverlay)}) === null && !!document.querySelector(${JSON.stringify(UI.appRoot)})`, 120)
    report.steps.login = 'app-root-visible'
    console.log(JSON.stringify({ liveUiStage: 'signed_in' }))

    // ---- create + start from the page: four named roles, dynamic goal ----
    await waitFor(`document.querySelector(${JSON.stringify(UI.newConversation)}) !== null`, 30)
    assert.notEqual(ab.abClick(tabId, UI.newConversation, { env: process.env }).verdict, 'FAILED', 'the new-conversation control was not clickable')
    await waitFor(`return !!document.querySelector(${JSON.stringify(UI.roomDialog)})`, 30)
    assert.equal(await clickText(UI.roomTabs, [TEXT.workMode], 'work-mode'), true, 'the work mode tab was not clickable')
    const roster = await evalValue(rosterJs())
    assert.ok(Array.isArray(roster), 'the collaboration roster is unreadable')
    const wantedNames = new Set(ROLE_ORDER.map(role => roles[role].displayName))
    for (const [index, row] of roster.entries()) {
      if (row.checked && !wantedNames.has(row.name)) {
        const tag = `remove-default-${index}`
        assert.equal(await evalValue(tagMemberJs(tag, row.name)), true)
        assert.notEqual(ab.abClick(tabId, `[data-loom-qa="${tag}"] input`, { env: process.env }).verdict, 'FAILED')
      }
    }
    for (const role of ROLE_ORDER) {
      assert.ok(Array.isArray(roster) && roster.some(row => row.name === roles[role].displayName),
        `the roster does not show ${role} (${roles[role].displayName}); refusing to pick another member`)
      const current = (await evalValue(rosterJs())).find(row => row.name === roles[role].displayName)
      if (!current?.checked) {
        assert.equal(await evalValue(tagMemberJs(`member-${role}`, roles[role].displayName)), true, `roster row for ${role} not found`)
        assert.notEqual(ab.abClick(tabId, `[data-loom-qa="member-${role}"] input`, { env: process.env }).verdict, 'FAILED')
      }
    }
    assert.deepEqual((await evalValue(rosterJs())).filter(row => row.checked).map(row => row.name).sort(), [...wantedNames].sort())
    report.steps.membersSelected = ROLE_ORDER.length
    // The lead is chosen by ITS OWN name through the production ChoiceMenu (a RadioItem, not a menuitem).
    const leadSelected = `document.querySelector(${JSON.stringify(UI.leadTrigger)})?.querySelector(':scope > span:not(.ln-avatar)')?.textContent.trim() === ${JSON.stringify(roles.lead.displayName)}`
    if (await evalValue(leadSelected) !== true) {
      assert.equal(ab.abTrustedClick(tabId, UI.leadTrigger, { env: process.env }).verdict, 'OK')
      await waitFor(`document.querySelectorAll(${JSON.stringify(UI.choiceItem)}).length > 0`, 20)
      const leadPick = await evalValue(tagChoiceItemJs('lead-choice', roles.lead.displayName))
      assert.equal(leadPick?.found, true, `the lead menu did not offer ${roles.lead.displayName}: ${JSON.stringify(leadPick?.labels)}`)
      const picked = ab.abPick(tabId, '[data-loom-qa="lead-choice"]', { env: process.env, open: UI.leadTrigger, value: roles.lead.displayName })
      // A closed Radix menu can make the Skill's page-wide text verifier
      // inconclusive (the same name exists in the roster). Do not replay the
      // click: independently read this exact controlled trigger instead.
      report.steps.leadPickInput = { verdict: picked.verdict, reason: picked.reason }
    }
    await waitFor(leadSelected, 20)
    report.steps.leadSelected = roles.lead.displayName

    const goal = buildMissionDescription({ workers: workerIds(roles) })
    const workName = `LOOM 真实接力 ${randomUUID().slice(0, 8)}`
    assert.ok(ab.abFill(tabId, UI.workName, workName, { env: process.env }).verdict === 'OK', 'work name fill was not confirmed')
    assert.ok(ab.abFill(tabId, UI.workGoal, goal, { env: process.env }).verdict === 'OK', 'work goal fill was not confirmed')
    if (await evalValue(`document.querySelector(${JSON.stringify(UI.startNow)})?.checked === true`) !== true) {
      ab.abClick(tabId, UI.startNow, { env: process.env })
    }
    ab.abClick(tabId, UI.roomSubmit, { env: process.env })
    await waitFor(`return !document.querySelector(${JSON.stringify(UI.roomDialog)})`, 90)
    report.steps.missionCreatedFromUi = true
    console.log(JSON.stringify({ liveUiStage: 'mission_created_from_page' }))

    // ---- the one new mission, by diff (never by recency) ----
    const afterMissions = await facts('missions.list')
    const picked = pickNewMission(before, afterMissions)
    assert.equal(picked.missionId !== null, true, `mission diff refused: ${picked.reason}`)
    const missionId = picked.missionId
    const mission = afterMissions.find(row => row.missionId === missionId)
    assert.equal(mission?.title, workName, 'the new Mission must be the one created by this UI action')
    assert.ok(typeof mission.threadId === 'string' && mission.threadId.length > 0)
    report.missionId = missionId
    report.threadId = mission.threadId
    assert.equal(await facts('loom.reviews.list', { missionId }).then(rows => Array.isArray(rows) && rows.length === 0), true, 'a review existed before any human verdict')

    // ---- wait for the Lead to actually author two worker tasks ----
    const authored = await waitForTasks(missionId)
    assert.equal(authored.ok, true, `the Lead did not author two worker tasks: ${authored.reason}`)
    report.steps.leadPlan = { taskIds: authored.tasks.map(task => task.taskId), workers: workerIds(roles) }
    console.log(JSON.stringify({ liveUiStage: 'model_plan_observed', taskCount: authored.tasks.length }))

    const beforeApproval = await facts('threads.snapshot', { threadId: mission.threadId })
    assert.ok(Array.isArray(beforeApproval?.agentRuns), 'the actual pre-approval Run list is required')
    assert.equal(beforeApproval.agentRuns.filter(run => workerIds(roles).includes(run.agentId)).length, 0,
      'the Lead must not dispatch workers before the explicit UI scope approval')
    report.steps.noWorkersBeforeApproval = true

    // ---- approve the scope in the real panel ----
    assert.notEqual(ab.abClick(tabId, UI.runEntry, { env: process.env }).verdict, 'FAILED', 'the run surface entry was not clickable')
    await waitFor(`return !!document.querySelector(${JSON.stringify(UI.relay)})`, 120)
    if (!(await evalValue(`return !!document.querySelector('.ln-control-budgets')`))) {
      assert.equal(await clickText('.ln-control .ln-action', TEXT.scopeOpen, 'relay-open'), true, 'the scope editor did not open')
      await waitFor(`return !!document.querySelector('.ln-control-budgets')`, 60)
    }
    await waitFor(`(() => {
      const shown = [...document.querySelectorAll(${JSON.stringify(UI.relayTaskTitle)})].map(e => e.textContent.trim());
      return ${JSON.stringify(authored.tasks.map(task => task.title))}.every(title => shown.includes(title));
    })()`, 60)
    const panel = await evalValue(relayStateJs())
    assert.equal(panel?.editing, true, 'the scope editor is not open')
    for (const task of authored.tasks) {
      const index = panel.tasks.findIndex(row => row.title === task.title)
      assert.ok(index >= 0, `panel task ${task.taskId} ("${task.title}") is not on screen`)
      assert.equal(await evalValue(tagNthJs(UI.relayTaskCheckbox, index, `task-${task.taskId}`)), true, 'task checkbox not found')
      ab.abClick(tabId, `[data-loom-qa="task-${task.taskId}"]`, { env: process.env })
      const reviewerIndex = await tagReviewerForTask(index, `reviewer-${task.taskId}`)
      assert.equal(reviewerIndex.opened, true, `reviewer menu for ${task.taskId} did not open`)
      const assigneeName = task.assigneeAgentId === roles.workerA.agentId ? roles.workerA.displayName : roles.workerB.displayName
      // The real menu must not offer the assignee itself, and must offer the designated reviewer.
      assert.equal(reviewerIndex.labels.includes(assigneeName), false,
        `the assignee ${assigneeName} was offered as its own reviewer for ${task.taskId}`)
      assert.equal(reviewerIndex.picked, true,
        `the designated reviewer ${roles.reviewer.displayName} was not offered for ${task.taskId}: ${JSON.stringify(reviewerIndex.labels)}`)
      assert.equal(reviewerIndex.pickedLabel, roles.reviewer.displayName)
    }
    assert.equal(await evalValue(tagNthJs(UI.relayBudget, 0, 'budget-dispatches')), true, 'dispatch budget field not found')
    assert.equal(ab.abFill(tabId, '[data-loom-qa="budget-dispatches"]', '12', { env: process.env }).verdict, 'OK')
    assert.equal(await evalValue(tagNthJs(UI.relayBudget, 1, 'budget-reworks')), true, 'rework budget field not found')
    assert.equal(ab.abFill(tabId, '[data-loom-qa="budget-reworks"]', '1', { env: process.env }).verdict, 'OK')
    const authorityClock = await facts('loom.control.get', { missionId })
    assert.ok(Number.isFinite(Date.parse(authorityClock?.evaluatedAt)), 'Core authorization clock is required')
    const expiryLocal = await evalValue(`(() => {
      const d = new Date(${JSON.stringify(authorityClock.evaluatedAt)});
      d.setTime(d.getTime() + 60 * 60 * 1000);
      const two = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + two(d.getMonth()+1) + '-' + two(d.getDate()) + 'T' + two(d.getHours()) + ':' + two(d.getMinutes());
    })()`)
    assert.match(expiryLocal, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u)
    assert.equal(ab.abFill(tabId, '.ln-control-budgets input[type="datetime-local"]', expiryLocal, { env: process.env }).verdict, 'OK')
    await waitFor(`document.querySelector(${JSON.stringify(UI.relayApprove)})?.disabled === false`, 30)
    ab.abClick(tabId, UI.relayApprove, { env: process.env })
    await waitFor(`return document.querySelector(${JSON.stringify(UI.relayState)})?.getAttribute('data-control-state') === 'approved'`, 120)
    report.steps.relayApprovedFromUi = true
    console.log(JSON.stringify({ liveUiStage: 'scope_approved_from_page' }))

    // ---- Core readback of the standing policy ----
    const control = await facts('loom.control.get', { missionId })
    assert.ok(control?.policy !== null && control?.policy !== undefined, 'Core reports no standing policy after the click')
    assert.ok(control.policy.revision >= 1, `policy revision did not advance: ${control.policy.revision}`)
    assert.deepEqual([...control.policy.taskIds].sort(), authored.tasks.map(task => task.taskId).sort())
    assert.equal(control.policy.reviewers.length, authored.tasks.length)
    for (const row of control.policy.reviewers) {
      assert.equal(row.reviewerAgentId, roles.reviewer.agentId, `reviewer ${row.reviewerAgentId} is not the designated independent reviewer`)
      const task = authored.tasks.find(entry => entry.taskId === row.taskId)
      assert.notEqual(row.reviewerAgentId, task.assigneeAgentId, 'reviewer equals assignee')
    }
    report.steps.coreReadback = {
      policyRevision: control.policy.revision,
      authorizationRevision: control.policy.authorizationRevision,
      taskIds: control.policy.taskIds.length,
      reviewers: control.policy.reviewers.length
    }

    // ---- wait for the real chain: EXECUTE / REVIEW / REWORK / settled ----
    const chain = await waitForChain(missionId, mission.threadId, control.policy.reviewers)
    assert.equal(chain.ok, true, `the relay chain did not settle: ${JSON.stringify(chain.reasons)}`)
    report.steps.chain = chain.evidence
    console.log(JSON.stringify({ liveUiStage: 'model_chain_verified', evidence: chain.evidence }))

    // ---- UI preview of the archived result ----
    const currentArtifactRows = `.ln-run-panel[data-mission-id="${missionId}"] .ln-run-artifact[data-artifact-id="${chain.artifactId}"] button.ln-run-file`
    assert.equal(await clickNth(currentArtifactRows, 0, 'artifact-open'), true, 'the exact reviewed artifact row was not clickable')
    await waitFor(`return !!document.querySelector(${JSON.stringify(UI.artifactDialog)})`, 60)
    const previewChars = await evalValue(`return (document.querySelector(${JSON.stringify(UI.artifactDialog)})?.innerText ?? '').trim().length`)
    assert.ok(typeof previewChars === 'number' && previewChars > 0, 'the opened artifact preview has no text')
    assert.equal(await evalValue("document.querySelector('.ln-artifact-document')?.innerText.includes('REVIEW-REVISION-2') === true"), true,
      'the rendered preview must contain the actual reviewed revision')
    report.steps.artifactPreview = 'dialog-visible'

    const shot = await ab.abScreenshot(tabId, join(OUT, `approved-${Date.now()}.png`), { env: process.env })
    report.screenshots.approved = shot.verified ? { verified: true, bytes: shot.bytes } : { verified: false, reason: shot.reason }
    const shotGate = screenshotGate(report.screenshots.approved)
    assert.equal(shotGate.ok, true, `screenshot gate failed: ${shotGate.reason}`)

    const reviews = await facts('loom.reviews.list', { missionId })
    assert.deepEqual(reviews, [], 'this run must not record an Owner review')
    report.status = 'passed-ui-created-started-and-approved-scope'
  } catch (error) {
    report.status = 'failed'
    report.error = { name: error?.name ?? null, message: String(error?.message ?? error).slice(0, 1500) }
    if (tabId && report.steps.login === 'app-root-visible') {
      const shot = await ab.abScreenshot(tabId, join(OUT, 'failed-ui.png'), { env: process.env })
      report.screenshots.failed = { verified: shot.verified, bytes: shot.bytes ?? null }
      const observation = await ab.abEval(tabId, `return {buttons:[...document.querySelectorAll('button')].filter(e=>e.getBoundingClientRect().width>0).map(e=>({label:e.getAttribute('aria-label'),text:e.innerText.slice(0,100),disabled:e.disabled})).slice(0,60),notices:[...document.querySelectorAll('.ln-notice,[role="alert"]')].map(e=>e.innerText.slice(0,800))}`, { env: process.env })
      if (observation.ok) report.failureUiObservation = observation.value
    }
    throw error
  } finally {
    if (tabId !== null && tabId !== '') ab.runCall(['close', '--tab', String(tabId)], { budgetMs: 10_000, env: process.env })
    // External Hosts are read-only for this test: it does not own them, so it never closes them.
    if (ownsHost && host !== null) await host.close().catch(() => {})
    const redacted = redactDeep(report, secrets)
    const leaks = findSecretLeak(JSON.stringify(redacted), secrets)
    if (leaks.length > 0) throw new Error(`report would leak a credential: ${leaks.length} hit(s)`)
    await mkdir(OUT, { recursive: true })
    await writeFile(join(OUT, 'report.json'), `${JSON.stringify(redacted, null, 2)}\n`)
    console.log(JSON.stringify({ out: OUT, status: redacted.status, mode: redacted.mode, steps: redacted.steps }))
  }

  // ---------------------------------------------------------------- helpers

  async function evalValue (expression) {
    const code = /^\s*return\b/u.test(expression) ? expression : `return (${expression})`
    const result = await ab.abEval(tabId, code, { env: process.env })
    return result.ok ? result.value ?? null : null
  }

  async function waitFor (expression, seconds) {
    const deadline = Date.now() + seconds * 1000
    while (Date.now() < deadline) {
      if (await evalValue(expression) === true) return true
      await sleep(1000)
    }
    throw new Error(`page did not reach the expected state within ${seconds}s`)
  }

  async function clickText (selector, texts, tag) {
    for (const text of texts) {
      if (await evalValue(tagByTextJs(selector, text, tag)) === true) {
        const clicked = ab.abClick(tabId, `[data-loom-qa="${tag}"]`, { env: process.env })
        if (clicked.verdict !== 'FAILED') return true
      }
    }
    return false
  }

  async function clickNth (selector, index, tag) {
    if (await evalValue(tagNthJs(selector, index, tag)) !== true) return false
    return ab.abClick(tabId, `[data-loom-qa="${tag}"]`, { env: process.env }).verdict !== 'FAILED'
  }

  async function tagReviewerForTask (taskIndex, tag) {
    const opened = await evalValue(tagNthJs(UI.relayReviewer, taskIndex, `${tag}-trigger`))
    if (opened !== true) return { opened: false, picked: false, labels: [], pickedLabel: null }
    await waitFor(`document.querySelector('[data-loom-qa="${tag}-trigger"]')?.disabled === false`, 20)
    assert.equal(ab.abTrustedClick(tabId, `[data-loom-qa="${tag}-trigger"]`, { env: process.env }).verdict, 'OK')
    await waitFor(`document.querySelectorAll(${JSON.stringify(UI.choiceItem)}).length > 0`, 20)
    const menu = await evalValue(tagChoiceItemJs(tag, roles.reviewer.displayName))
    if (menu?.found !== true) return { opened: true, picked: false, labels: menu?.labels ?? [], pickedLabel: null }
    const beforePick = await evalValue(`document.querySelector('[data-loom-qa="${tag}-trigger"]')?.innerText.trim()`)
    const picked = ab.abPick(tabId, `[data-loom-qa="${tag}"]`, {
      env: process.env, open: `[data-loom-qa="${tag}-trigger"]`, value: roles.reviewer.displayName
    })
    // Only this task's controlled trigger is a valid postcondition. Never
    // repeat an unconfirmed input, and never infer selection from page text.
    await waitFor(`document.querySelector('[data-loom-qa="${tag}-trigger"]')?.innerText.trim() === ${JSON.stringify(roles.reviewer.displayName)}`, 20)
    report.steps.reviewerPicks ??= []
    report.steps.reviewerPicks.push({ taskIndex, inputVerdict: picked.verdict, inputReason: picked.reason,
      exactTriggerVerified: true, changedFromPrevious: beforePick !== roles.reviewer.displayName })
    return { opened: true, picked: true, labels: menu.labels ?? [], pickedLabel: roles.reviewer.displayName }
  }

  async function waitForTasks (missionId) {
    const deadline = Date.now() + LEAD_PLAN_BUDGET_MS
    let last = 'no_read'
    while (Date.now() < deadline) {
      const plan = await facts('loom.plan.get', { missionId })
      const tasks = await facts('loom.tasks.list', { missionId })
      if (plan !== null && Array.isArray(tasks)) {
        const pickedTasks = workerTasks(tasks, roles)
        if (pickedTasks.complete) return { ok: true, tasks: pickedTasks.tasks, reason: null }
        last = pickedTasks.reason ?? 'incomplete'
      }
      await sleep(4000)
    }
    return { ok: false, tasks: [], reason: last }
  }

  async function waitForChain (missionId, threadId, reviewers) {
    const deadline = Date.now() + CHAIN_BUDGET_MS
    let evidence = null
    while (Date.now() < deadline) {
      const control = await facts('loom.control.get', { missionId })
      const candidates = await facts('loom.candidates.list', { missionId })
      const artifacts = await facts('loom.artifacts.list', { missionId })
      const rows = Array.isArray(artifacts) ? artifacts : Array.isArray(artifacts?.artifacts) ? artifacts.artifacts : []
      const archiveChecks = []
      for (const artifact of rows) {
        const preview = await facts('loom.artifact.preview', { missionId, artifactId: artifact.artifactId })
        archiveChecks.push(verifyArchivedArtifact({ registered: artifact, preview }))
      }
      const verdict = chainGate({ dispatches: control?.dispatches ?? [], candidates: candidates ?? [], archiveChecks })
      evidence = {
        dispatches: (control?.dispatches ?? []).map(row => ({ kind: row.kind, status: row.status })),
        candidates: (candidates ?? []).length,
        artifacts: rows.length,
        archiveOk: archiveChecks.filter(check => check.ok).length,
        stageReviews: (control?.stageReviews ?? []).map(row => row.verdict),
        reviewers: reviewers.length
      }
      if (verdict.ok) {
        const snapshot = await facts('threads.snapshot', { threadId })
        const claimResult = await facts('loom.claims.list', { missionId })
        const ownerReviews = await facts('loom.reviews.list', { missionId })
        assert.ok(Array.isArray(snapshot?.agentRuns), 'actual model Run receipts are required')
        assert.ok(Array.isArray(ownerReviews), 'Owner review facts must be readable')
        // Reuse the shared summary for the model-authored facts it can judge from persisted rows.
        const summary = summarizeLeadChain({
          plan: await facts('loom.plan.get', { missionId }),
          tasks: await facts('loom.tasks.list', { missionId }),
          candidates: candidates ?? [],
          artifacts: rows,
          control,
          runs: snapshot.agentRuns,
          claims: Array.isArray(claimResult) ? claimResult : claimResult?.claims ?? [],
          ownerReviews,
          workerAgentIds: workerIds(roles),
          fileTexts: Object.fromEntries(candidates.map(candidate => [candidate.candidateId, candidate.evidenceIds.map(id => archiveChecks.find(check => check.ok && check.artifactId === id)?.text ?? '').join('\n')])),
          archiveChecks: Object.fromEntries(archiveChecks.map(check => [check.artifactId, check]))
        })
        evidence.summaryReasons = summary.reasons ?? []
        evidence.planAuthoredByModel = summary.planAuthoredByModel === true
        if (summary.reasons.length === 0) {
          const artifactIndex = archiveChecks.findIndex(check => check.ok && check.text.includes('REVIEW-REVISION-2'))
          assert.ok(artifactIndex >= 0, 'an archived reviewed revision is required')
          return { ok: true, reasons: [], evidence, artifactIndex, artifactId: archiveChecks[artifactIndex].artifactId }
        }
      }
      await sleep(5000)
    }
    return { ok: false, reasons: ['chain_timeout'], evidence }
  }

  async function prepare () {
    if (report.mode === 'external') {
      // Read-only: never closed by this run, never re-prepared, never re-seeded.
      const config = parseHostConfig(process.env[HOST_CONFIG_ENV])
      const token = resolveAdminToken(process.env)
      let adminToken = token.kind === 'env' ? token.value : null
      if (token.kind === 'file') adminToken = (await readFile(token.path, 'utf8')).trim()
      assert.ok(typeof adminToken === 'string' && adminToken.trim() !== '',
        'external mode needs the isolated Host administrator token via LOOM_ADMIN_TOKEN_ENV or LOOM_ADMIN_TOKEN_FILE')
      const session = await loginApi(config.origin, adminToken)
      report.steps.hostMode = 'external-read-only'
      report.steps.externalHostClosed = false
      return {
        origin: config.origin,
        adminToken,
        roles: config.roles,
        secrets: [adminToken, session],
        facts: (operation, params = {}) => requestApi(config.origin, session, operation, params)
      }
    }
    const prepared = await prepareLivePiHost({
      configPath: process.env.LOOM_UI_PUBLIC_CONFIG,
      providerKey: process.env[PROVIDER_KEY_ENV],
      readyBudgetMs: READY_BUDGET_MS
    })
    host = prepared.host
    ownsHost = true
    report.steps.hostMode = 'self-prepared-isolated'
    report.steps.dataRootPreparedByProduct = true
    report.fixture = prepared.evidence
    return prepared
  }

})

async function loginApi (origin, administratorToken) {
  const response = await fetch(`${origin}/api/v1/login`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ protocolVersion: 5, administratorToken })
  })
  assert.equal(response.status, 200, 'the isolated Host refused the administrator login')
  const body = await response.json()
  assert.match(body.token, /^[0-9a-f]{64}$/u, 'login must answer a session token')
  return body.token
}

async function requestApi (origin, token, operation, params) {
  const response = await fetch(`${origin}/api/v1/request`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ operation, params })
  })
  const body = await response.json().catch(() => null)
  if (response.status !== 200 || body?.error) return null
  return body.result ?? null
}
