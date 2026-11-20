// Live acceptance: the REAL page creates and starts the work, the Lead authors exactly two tasks,
// and the user (through this harness) approves the automatic relay scope in the real control panel.
//
// The second case is the computer chain: the same page authorizes computer control for a PAIRED
// Node's desktop, the real Pi model drives that desktop through the reviewed MCP toolchain, the
// Node's screen really changes, and revoking the grant in the page refuses the next tool call.
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
import { randomBytes, randomUUID } from 'node:crypto'
import { existsSync, writeFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { prepareLivePiHost } from './loom-live-pi-host.mjs'
import {
  buildNodeOnlyRoot,
  CHROOT_BINARY,
  clickReceipt,
  computerNode,
  digestOf,
  evidencePaths,
  fixtureRoots,
  grantServer,
  helperInRoot,
  HELPER_INFO_REQUEST,
  listDirectory,
  listNodes,
  login as hostLogin,
  parsePairOutput,
  pause,
  readIfPresent,
  request as hostRequest,
  startDesktopFixture,
  startXvfb,
  typedReceipt,
  waitForDisplay,
  workbench
} from './loom-computer-node-live.mjs'
import { launchAcceptanceBrowser } from './host-web-browser.mjs'
import { createConfiguredCampAndSend } from './create-configured-camp.mjs'
import { buildMissionDescription, redactDeep, summarizeLeadChain, verifyArchivedArtifact } from '../accept-loom-live-lead.mjs'
import { taskDeliveryOutcomes } from './loom-chain-outcome.mjs'
import { verifyRunningHostSchema } from './loom-host-schema.mjs'
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
  relayTaskCheckboxSelector,
  terminalFirstPassWithoutRework,
  leadPlanTerminalOutcome,
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
  // The scope-approval fixture prepares its Host with the product's Windows-only
  // `--prepare-windows-data-root` path and the Windows browser door, so it is stated as
  // Windows-only instead of failing on another platform. The computer case below prepares
  // its own Linux Host and runs here.
  skip: gate.allowed
    ? (process.platform === 'win32' ? false : `windows-only fixture: this Host is ${process.platform}`)
    : `opt-in required: ${gate.reason}`
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
    report.steps.hostSchema = prepared.evidence?.hostSchema ?? prepared.hostSchema
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
    const authored = await waitForTasks(missionId, mission.threadId)
    report.steps.leadPlan = { ok: authored.ok, reason: authored.reason, evidence: authored.evidence,
      taskIds: authored.tasks.map(task => task.taskId), workers: workerIds(roles) }
    assert.equal(authored.ok, true, `the Lead did not author two worker tasks: ${authored.reason}`)
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
    let panel = await evalValue(relayStateJs())
    // The explicit Mission-bundle refresh may finish just after the user first
    // opens this *local-only* editor. If React remounted the panel, reopen
    // the editor once, before any task click or Core write. This is not a
    // retry of an unknown approval and is separately evidenced as a UX race.
    if (panel?.editing !== true) {
      report.steps.editorReopenedAfterBundleRefresh = true
      assert.equal(panel?.state, 'unapproved', 'unexpected relay state while re-opening editor')
      assert.equal(await clickText('.ln-control .ln-action', TEXT.scopeOpen, 'relay-reopen'), true,
        'the local-only scope editor did not reopen after the Mission bundle refreshed')
      await waitFor(`return !!document.querySelector('.ln-control-budgets')`, 30)
      panel = await evalValue(relayStateJs())
    }
    assert.equal(panel?.editing, true, 'the scope editor is not open after the bounded local refresh')
    assert.equal(authored.tasks.every(task => panel.tasks.some(row => row.title === task.title)), true,
      'the scope editor lost the authoritative Lead tasks after reopening')
    for (const task of authored.tasks) {
      const index = panel.tasks.findIndex(row => row.title === task.title)
      assert.ok(index >= 0, `panel task ${task.taskId} ("${task.title}") is not on screen`)
      const selector = relayTaskCheckboxSelector(task.title)
      try {
        await waitFor(`return document.querySelectorAll(${JSON.stringify(selector)}).length === 1 && document.querySelector(${JSON.stringify(selector)})?.disabled === false`, 30)
      } catch (error) {
        report.steps.scopeCheckboxDiagnostic = await evalValue(`return ({
          taskTitles: [...document.querySelectorAll('.ln-control-task-title')].map(el => el.textContent.trim()),
          allCheckboxLabels: [...document.querySelectorAll('.ln-control-task input[type="checkbox"]')].map(el => el.getAttribute('aria-label')),
          scopeEditing: !!document.querySelector('.ln-control-budgets'),
          exactMatches: document.querySelectorAll(${JSON.stringify(selector)}).length
        })`)
        throw error
      }
      assert.equal(await evalValue(`return document.querySelector(${JSON.stringify(selector)}).checked`), false,
        `task ${task.taskId} was already selected; refusing a second click`)
      const click = ab.abClick(tabId, selector, { env: process.env })
      report.steps.scopeClickAttempt = { taskId: task.taskId, verdict: click.verdict, reason: click.reason }
      // Never repeat an uncertain click. Query this exact checkbox instead.
      try {
        await waitFor(`return document.querySelector(${JSON.stringify(selector)})?.checked === true`, 20)
      } catch (error) {
        report.steps.scopeAfterClick = await evalValue(`return ({
          scopeEditing: !!document.querySelector('.ln-control-budgets'),
          scopeState: document.querySelector('.ln-control')?.getAttribute('data-control-state') ?? null,
          matchingCheckboxes: document.querySelectorAll(${JSON.stringify(selector)}).length,
          checked: document.querySelector(${JSON.stringify(selector)})?.checked ?? null
        })`)
        throw error
      }
      report.steps.scopeTaskClicks ??= []
      report.steps.scopeTaskClicks.push({ taskId: task.taskId, outcome: click.verdict, checkedReadback: true })
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
    const chain = await waitForChain(missionId, mission.threadId, control.policy)
    report.steps.chain = { ...chain.evidence, ok: chain.ok, reasons: chain.reasons }
    assert.equal(chain.ok, true, `the relay chain did not settle: ${JSON.stringify(chain.reasons)}`)
    console.log(JSON.stringify({ liveUiStage: 'model_chain_verified', evidence: chain.evidence }))

    // ---- UI preview of the archived result ----
    const currentArtifactRows = `.ln-run-panel[data-mission-id="${missionId}"] .ln-run-artifact[data-artifact-id="${chain.artifactId}"] button.ln-run-file`
    await waitFor(`return (() => { const rows = document.querySelectorAll(${JSON.stringify(currentArtifactRows)}); const row = rows[0]; return rows.length === 1 && !row.disabled && row.getClientRects().length > 0 })()`, 60)
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
    if (error?.hostSchema) report.steps.hostSchema = error.hostSchema
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

  async function waitForTasks (missionId, threadId) {
    const deadline = Date.now() + LEAD_PLAN_BUDGET_MS
    let last = 'no_read', evidence = null, latestTasks = []
    while (Date.now() < deadline) {
      // Read plan/tasks after this Run snapshot. A terminal Run must not be paired
      // with a plan read from just before its final tool call committed.
      const snapshot = await facts('threads.snapshot', { threadId })
      const [plan, tasks] = await Promise.all([
        facts('loom.plan.get', { missionId }), facts('loom.tasks.list', { missionId })
      ])
      if (plan !== null && Array.isArray(tasks)) {
        const pickedTasks = workerTasks(tasks, roles)
        latestTasks = pickedTasks.tasks
        if (pickedTasks.complete) return { ok: true, tasks: pickedTasks.tasks, reason: null, evidence: null }
        last = pickedTasks.reason ?? 'incomplete'
      }
      const terminal = leadPlanTerminalOutcome({ snapshot, missionId, threadId, leadAgentId: roles.lead.agentId })
      evidence = terminal.evidence
      if (terminal.terminal) return { ok: false, tasks: latestTasks, reason: terminal.reason, evidence }
      await sleep(4000)
    }
    return { ok: false, tasks: latestTasks, reason: last, evidence }
  }

  async function waitForChain (missionId, threadId, policy) {
    const deadline = Date.now() + CHAIN_BUDGET_MS
    let evidence = null
    while (Date.now() < deadline) {
      const control = await facts('loom.control.get', { missionId })
      const tasks = await facts('loom.tasks.list', { missionId })
      const candidates = await facts('loom.candidates.list', { missionId })
      const artifacts = await facts('loom.artifacts.list', { missionId })
      assert.ok(Array.isArray(tasks) && Array.isArray(candidates), 'task and candidate facts must be readable')
      const rows = Array.isArray(artifacts) ? artifacts : Array.isArray(artifacts?.artifacts) ? artifacts.artifacts : []
      const outcome = taskDeliveryOutcomes({
        taskIds: policy.taskIds, tasks, candidates,
        stageReviews: control?.stageReviews ?? [], dispatches: control?.dispatches ?? [],
        authorizationRevision: policy.authorizationRevision
      })
      evidence = {
        dispatches: (control?.dispatches ?? []).map(row => ({
          taskId: row.taskId, candidateId: row.candidateId, kind: row.kind, status: row.status
        })),
        candidates: candidates.length, artifacts: rows.length, archiveOk: 0,
        stageReviews: (control?.stageReviews ?? []).map(row => ({
          taskId: row.taskId, candidateId: row.candidateId, verdict: row.verdict
        })),
        reviewers: policy.reviewers.length, taskOutcomes: outcome.outcomes,
        allTasksPassed: outcome.allPassed
      }
      // A task that needs a new approval cannot finish by waiting longer. Preserve its
      // actual reason; do not turn one successful task into success for the whole scope.
      if (outcome.terminalFailure) return { ok: false, reasons: outcome.reasons, evidence }
      if (terminalFirstPassWithoutRework({
        dispatches: control?.dispatches ?? [], candidates,
        stageReviews: control?.stageReviews ?? [], taskIds: policy.taskIds,
        authorizationRevision: policy.authorizationRevision
      })) {
        return { ok: false, reasons: ['model_passed_first_drafts_without_required_rework'], evidence }
      }
      const archiveChecks = []
      for (const artifact of rows) {
        const preview = await facts('loom.artifact.preview', { missionId, artifactId: artifact.artifactId })
        archiveChecks.push(verifyArchivedArtifact({ registered: artifact, preview }))
      }
      evidence.archiveOk = archiveChecks.filter(check => check.ok).length
      const verdict = chainGate({ dispatches: control?.dispatches ?? [], candidates, archiveChecks })
      if (outcome.allPassed && verdict.ok) {
        const snapshot = await facts('threads.snapshot', { threadId })
        const claimResult = await facts('loom.claims.list', { missionId })
        const ownerReviews = await facts('loom.reviews.list', { missionId })
        assert.ok(Array.isArray(snapshot?.agentRuns), 'actual model Run receipts are required')
        assert.ok(Array.isArray(ownerReviews), 'Owner review facts must be readable')
        const summary = summarizeLeadChain({
          plan: await facts('loom.plan.get', { missionId }), tasks, candidates, artifacts: rows, control,
          runs: snapshot.agentRuns, claims: Array.isArray(claimResult) ? claimResult : claimResult?.claims ?? [],
          ownerReviews, workerAgentIds: workerIds(roles), expectedTaskIds: policy.taskIds,
          policyApprovedAt: policy.approvedAt,
          fileTexts: Object.fromEntries(candidates.map(candidate => [candidate.candidateId,
            candidate.evidenceIds.map(id => archiveChecks.find(check => check.ok && check.artifactId === id)?.text ?? '').join('\n')])),
          archiveChecks: Object.fromEntries(archiveChecks.map(check => [check.artifactId, check]))
        })
        evidence.summaryReasons = summary.reasons
        evidence.planAuthoredByModel = summary.planAuthoredByModel
        if (summary.reasons.length === 0) {
          const artifact = archiveChecks.find(check => summary.reviewedArtifactIds.includes(check.artifactId)
            && check.ok && check.text.includes('REVIEW-REVISION-2'))
          assert.ok(artifact, 'the latest passed candidate must cite the previewed archive')
          evidence.previewArtifactId = artifact.artifactId
          return { ok: true, reasons: [], evidence, artifactId: artifact.artifactId }
        }
        // All current candidates and handoffs are final; missing proof will not appear
        // through an extra model run. Return the precise acceptance failure now.
        if (!summary.reasons.includes('a_dispatch_is_still_pending')
          && snapshot.agentRuns.every(run => ['succeeded', 'failed', 'cancelled'].includes(run.status))) {
          return { ok: false, reasons: summary.reasons, evidence }
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
      const facts = (operation, params = {}) => requestApi(config.origin, session, operation, params)
      assert.ok(config.dataDir, 'external acceptance must name its isolated dataDir for the running Host schema check')
      const hostSchema = await verifyRunningHostSchema({ request: facts, databasePath: join(config.dataDir, 'rovai.sqlite') })
      report.steps.hostMode = 'external-read-only'
      report.steps.externalHostClosed = false
      return {
        origin: config.origin,
        adminToken,
        roles: config.roles,
        hostSchema,
        secrets: [adminToken, session],
        facts
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

// ---------------------------------------------------------------------------------------
// Computer-D: page -> Pi model -> paired Node desktop (live).
// ---------------------------------------------------------------------------------------

const COMPUTER_CHAIN_BUDGET_MS = 20 * 60_000
const PROVIDER_MODEL_ID = 'deepseek-v4.1-flash'
const PROVIDER_API = 'openai-completions'
const PROVIDER_BASE_URL = process.env.LOOM_COMPUTER_PROVIDER_BASE_URL ?? 'https://oct.agent-ai.vip/v1'

function debugDirectory () {
  return process.env.CARGO_TARGET_DIR ? join(process.env.CARGO_TARGET_DIR, 'debug') : join(REPOSITORY, 'target', 'debug')
}

function requiredPath (label, path) {
  assert.equal(existsSync(path), true, `${label} is missing at ${path}; build it before the live computer acceptance`)
  return path
}

async function waitForHttp (origin, budgetMs = 180_000) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/`, { signal: AbortSignal.timeout(3_000) })
      if (response.status === 200) return true
    } catch { /* not listening yet */ }
    await pause(500)
  }
  throw new Error(`the isolated Host never answered on ${origin}`)
}

async function waitForText (browser, expression, budgetMs, label) {
  const deadline = Date.now() + budgetMs
  while (Date.now() < deadline) {
    if (await browser.evaluate(expression)) return true
    await pause(500)
  }
  throw new Error(`the page did not reach ${label} within ${budgetMs}ms`)
}

test('real page authorizes a paired Node desktop, the Pi model drives it, and revoking refuses the next call', {
  timeout: 3_600_000,
  skip: gate.allowed ? false : `opt-in required: ${gate.reason}`
}, async (t) => {
  const report = {
    scope: 'live-computer-page-model-remote-node',
    mode: 'self-prepared-linux-node-only-root',
    crossDeviceContainer: 'independent Node-only chroot root with a private display',
    dockerAvailable: false,
    pageAuthorized: false,
    pageRevoked: false,
    modelAutonomousToolCalls: false,
    nodeDesktopChanged: false,
    bridgeRefusedAfterRevoke: false,
    hostAuthoredToolCall: false,
    steps: {},
    screenshots: {},
    status: 'running'
  }
  const secrets = []
  const evidence = evidencePaths(OUT)
  const children = []
  let browser = null
  let desktop = null
  let xvfb = null
  let host = null
  let node = null
  let bridge = null
  let hostLog = ''
  let nodeLog = ''
  try {
    const providerKey = process.env.LOOM_E4_PROVIDER_KEY ?? process.env.OCT_API_KEY ?? ''
    assert.ok(providerKey.length > 0, 'an authorized model credential is required in LOOM_E4_PROVIDER_KEY or OCT_API_KEY')
    secrets.push(providerKey)
    const python = requiredPath('the desktop interpreter', process.env.LOOM_COMPUTER_PYTHON ?? '/usr/bin/python3')
    const chrome = requiredPath('an acceptance browser', process.env.LOOM_ACCEPTANCE_CHROME ?? '/usr/bin/chromium')
    const serverBinary = requiredPath('rovai-server', process.env.ROVAI_SERVER_BIN ?? join(debugDirectory(), 'rovai-server'))
    const nodeBinary = requiredPath('loom-node', process.env.LOOM_NODE_BIN ?? join(debugDirectory(), 'loom-node'))
    const helper = requiredPath('the desktop helper', join(REPOSITORY, 'resources/computer/host_desktop.py'))
    const webUi = requiredPath('the production WebUI bundle', process.env.ROVAI_WEB_UI ?? join(REPOSITORY, 'out/web'))
    const bridgeScript = requiredPath('the agent MCP bridge', join(REPOSITORY, 'resources/computer/mcp_bridge.py'))
    assert.equal(existsSync(join(webUi, 'index.html')), true, 'the production WebUI bundle has no index.html')
    const base = await mkdtemp(join(tmpdir(), 'loom-computer-live-'))
    const roots = fixtureRoots(base)
    for (const directory of [roots.server, roots.workspace, roots.nodeData, roots.desktop, roots.piAgent, roots.home]) {
      await mkdir(directory, { recursive: true })
    }

    // ---- the private display and the Node-only root -------------------------------------
    let displayNumber = 90
    for (;;) {
      xvfb = startXvfb({ displayNumber, logPath: join(OUT, 'xvfb.log') })
      try {
        await waitForDisplay({ display: xvfb.display, budgetMs: 8_000 })
        break
      } catch (error) {
        await xvfb.stop(); xvfb = null; displayNumber += 1
        if (displayNumber > 99) throw error
      }
    }
    children.push(xvfb)
    report.steps.display = xvfb.display
    const nodeRootPlan = await buildNodeOnlyRoot({ root: roots.nodeRoot, display: xvfb.display, sources: { client: nodeBinary, helper } })
    report.steps.nodeOnlyRoot = {
      node: nodeRootPlan.verification.node,
      helperPlatform: nodeRootPlan.verification.helperPlatform,
      bounds: nodeRootPlan.verification.bounds,
      builtMs: nodeRootPlan.elapsedMs
    }
    // The helper really runs inside the root, with only the devices it declares.
    const helperHeader = JSON.parse(helperInRoot({ root: roots.nodeRoot, display: xvfb.display, request: HELPER_INFO_REQUEST }).split('\n')[0])
    assert.equal(helperHeader.ok, true, 'the desktop helper does not answer inside the Node-only root')
    report.steps.nodeHelperDeviceId = helperHeader.deviceId

    // ---- the isolated Host ------------------------------------------------------------
    const port = Number(process.env.LOOM_COMPUTER_HOST_PORT ?? 64_700 + Math.floor(Math.random() * 200))
    const origin = `http://127.0.0.1:${port}`
    writeFileSync(join(roots.piAgent, 'models.json'), `${JSON.stringify({
      providers: {
        'loom-live': {
          baseUrl: PROVIDER_BASE_URL,
          api: PROVIDER_API,
          apiKey: '$LOOM_E4_PROVIDER_KEY',
          models: [{ id: PROVIDER_MODEL_ID, name: 'DeepSeek-V4.1-Flash', reasoning: true, input: ['text', 'image'], contextWindow: 1_000_000, maxTokens: 384_000 }]
        }
      }
    }, null, 2)}\n`)
    writeFileSync(join(roots.piAgent, 'settings.json'), `${JSON.stringify({ defaultProvider: 'loom-live', defaultModel: PROVIDER_MODEL_ID, defaultThinkingLevel: 'max' }, null, 2)}\n`)
    host = spawn(serverBinary, ['--data-dir', roots.server, '--listen', `127.0.0.1:${port}`, '--web-ui', webUi], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: roots.home,
        PI_CODING_AGENT_DIR: roots.piAgent,
        PI_TELEMETRY: '0',
        LOOM_E4_PROVIDER_KEY: providerKey,
        // The agent toolchain stays on its explicit opt-in, and both programs are Host-owned.
        LOOM_COMPUTER_AGENT_PI_MCP: '1',
        LOOM_COMPUTER_AGENT_PYTHON: python,
        LOOM_COMPUTER_AGENT_BRIDGE: bridgeScript
      }
    })
    children.push({ stop: () => { try { host.kill('SIGKILL') } catch { /* gone */ } } })
    host.stdout.on('data', chunk => { hostLog = (hostLog + String(chunk)).slice(-40_000) })
    host.stderr.on('data', chunk => { hostLog = (hostLog + String(chunk)).slice(-40_000) })
    await waitForHttp(origin)
    const administratorToken = execFileSync(serverBinary, ['--data-dir', roots.server, 'token'], { encoding: 'utf8' }).trim()
    assert.match(administratorToken, /^[0-9a-f]{64}$/u, 'the isolated Host issued no administrator token')
    const session = await hostLogin({ origin, administratorToken })
    secrets.push(administratorToken, session)
    report.steps.host = { origin, webUi, agentToolchain: 'pi', helperOnNodeOnly: true }

    // ---- the paired Node that owns the desktop ----------------------------------------
    const pairing = parsePairOutput(spawnSync(serverBinary, ['--data-dir', roots.server, 'node-pair'], { encoding: 'utf8' }))
    assert.match(String(pairing.code ?? ''), /^[0-9a-f]{8,64}$/u, 'the Host issued no pairing code')
    assert.ok(String(pairing.connect ?? '').startsWith('ws://127.0.0.1:'), `the pairing URL is not the isolated loopback Host: ${pairing.connect}`)
    secrets.push(pairing.code)
    const nodeCommand = ['--data-dir', '/work/node-data', '--server', pairing.connect, '--pair-code-stdin', '--device-only', '--computer-helper', '/usr/local/bin/host_desktop.py', '--computer-python', '/usr/bin/python3']
    await mkdir(join(roots.nodeRoot, 'work', 'home'), { recursive: true })
    await mkdir(join(roots.nodeRoot, 'work', 'node-data'), { recursive: true })
    // The environment is replaced at the `chroot` boundary, so the device inherits nothing
    // from this process: the model credential can never reach the machine that captures.
    node = spawn(CHROOT_BINARY, [roots.nodeRoot, '/usr/local/bin/loom-node', ...nodeCommand], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { DISPLAY: xvfb.display, HOME: '/work/home', TMPDIR: '/tmp', PATH: '/usr/local/bin:/usr/bin:/bin' }
    })
    children.push({ stop: () => { try { node.kill('SIGKILL') } catch { /* gone */ } } })
    node.stdout.on('data', chunk => { nodeLog = (nodeLog + String(chunk)).slice(-20_000) })
    node.stderr.on('data', chunk => { nodeLog = (nodeLog + String(chunk)).slice(-20_000) })
    node.stdin.write(`${pairing.code}\n`)
    let paired = null
    for (let attempt = 0; attempt < 90 && paired === null; attempt += 1) {
      await pause(2_000)
      const picked = computerNode(await listNodes({ origin, session }))
      if (picked.node) paired = picked.node
    }
    assert.ok(paired, `the Node-only root never advertised a desktop: ${nodeLog.slice(-600)}`)
    const nodeDevice = await workbench({ origin, session, path: `/computer/nodes/${paired.nodeId}` })
    assert.equal(nodeDevice.ready, true, `the node desktop is not ready: ${JSON.stringify(nodeDevice.reason ?? nodeDevice)}`)
    assert.equal(nodeDevice.device?.platform, 'linux-x11', 'the device must be the node\'s own X11 desktop')
    const deviceId = nodeDevice.device.deviceId
    report.steps.node = { nodeId: paired.nodeId, displayName: paired.displayName, deviceId: deviceId.slice(0, 20), platform: nodeDevice.device.platform }

    // The two windows the model must find by itself.
    desktop = startDesktopFixture({ display: xvfb.display, directory: roots.desktop })
    children.push(desktop)
    await pause(2_500)

    // Baseline picture of that desktop through the product's own node frame route.
    const baselineView = await workbench({ origin, session, path: `/computer/nodes/${paired.nodeId}/view`, body: { deviceId, consent: true } })
    await pause(400)
    const baselineFrame = await fetch(`${origin}/api/v1/computer/nodes/${paired.nodeId}/frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
      body: JSON.stringify({ viewId: baselineView.viewId, consent: true })
    })
    assert.equal(baselineFrame.ok, true, `the baseline node capture failed: ${baselineFrame.status}`)
    const baselinePng = Buffer.from(await baselineFrame.arrayBuffer())
    await writeFile(evidence.nodeDesktopBefore, baselinePng)
    await workbench({ origin, session, path: `/computer/nodes/${paired.nodeId}/view/stop`, body: { viewId: baselineView.viewId } })
    report.screenshots.nodeDesktopBefore = { bytes: baselinePng.length, sha256: digestOf(baselinePng) }

    // ---- the real page: choose the node, authorize control ---------------------------
    const members = await hostRequest({ origin, session, operation: 'members.list' })
    const roster = Array.isArray(members) ? members : (members?.members ?? [])
    const member = roster.find(entry => !entry.removedAt)
    assert.ok(member, 'the isolated Host has no member for the model to run as')
    const installations = await hostRequest({ origin, session, operation: 'runtime.installations.list' })
    const piInstallation = (Array.isArray(installations) ? installations : []).find(entry => entry.adapterKind === 'pi')
    assert.ok(piInstallation?.memberRuntimeDefaults, 'the Host exposes no Pi installation for this acceptance')
    if ((member.runtimeConfiguration?.adapterKind ?? null) !== 'pi') {
      const before = await hostRequest({ origin, session, operation: 'members.get', params: { agentId: member.agentId } })
      const applied = await hostRequest({ origin, session, operation: 'members.runtime.set', params: { commandId: randomUUID(), command: {
        agentId: member.agentId, expectedVersion: before.version, adapterKind: 'pi',
        model: { ...piInstallation.memberRuntimeDefaults.model, options: { thinking_level: 'max' } },
        permissions: piInstallation.memberRuntimeDefaults.permissions
      } } })
      assert.equal(applied?.status, 'applied', `the Pi runtime was not applied: ${JSON.stringify(applied)}`)
    }
    const profile = await mkdtemp(join(tmpdir(), 'loom-computer-page-'))
    browser = await launchAcceptanceBrowser({
      executable: chrome,
      args: ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-dev-shm-usage', '--no-sandbox', '--remote-debugging-port=0', `--user-data-dir=${profile}`, `${origin}/`]
    })
    await waitForText(browser, '!!document.querySelector("input[type=password]")', 90_000, 'the login form')
    await browser.evaluate(`(() => { const input = document.querySelector('input[type=password]'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ${JSON.stringify(administratorToken)}); input.dispatchEvent(new Event('input', { bubbles: true })); return true })()`)
    await browser.evaluate('[...document.querySelectorAll("button")].find(button => /sign in/iu.test(button.innerText)).click()')
    await waitForText(browser, '!!document.querySelector("#workspace-tab-computer")', 120_000, 'the workspace dock')
    report.steps.pageSignedIn = true
    await browser.click('document.querySelector("#workspace-tab-computer")')
    await pause(1_500)
    await browser.click('document.querySelector(\'button[aria-label="选择要查看的电脑"]\')')
    await pause(900)
    await browser.click(`[...document.querySelectorAll(".ln-choice-item")].find(item => item.textContent.includes(${JSON.stringify(paired.displayName)}))`)
    await pause(3_000)
    const targetText = await browser.evaluate('(document.querySelector(".ln-computer-target")||{}).innerText || ""')
    assert.equal(targetText.includes(paired.displayName), true, `the page did not select the paired node: ${targetText}`)
    const grantButton = '[...document.querySelectorAll(".ln-computer-agent-access button")].find(button => button.textContent.trim() === "授权电脑操作")'
    await waitForText(browser, `!!${grantButton}`, 60_000, 'the computer authorization control')
    await browser.click(`(${grantButton})`)
    await pause(1_500)
    const dialogText = await browser.evaluate('(document.querySelector(".ln-surface-dialog")||{}).innerText || ""')
    assert.equal(dialogText.includes('允许助手操作这台电脑'), true, `the consent dialog did not open: ${dialogText}`)
    assert.equal(dialogText.includes(member.displayName), true, 'the consent dialog must name the reviewed member')
    await browser.capture(evidence.pageConsent)
    await browser.click('[...document.querySelectorAll(".ln-surface-dialog button")].find(button => button.textContent.trim() === "允许本次")')
    await waitForText(browser, 'document.querySelector(".ln-computer-agent-access")?.innerText.includes("剩余约") === true', 90_000, 'the standing grant row')
    await browser.capture(evidence.pageGranted)
    report.steps.pageGrant = { member: member.displayName, node: paired.displayName, standing: true }
    report.pageAuthorized = true

    // ---- the real model runs the goal on that node -----------------------------------
    const code = `LOOM-NODE-${randomBytes(3).toString('hex').toUpperCase()}`
    const goal = [
      '你在一个可以控制远端电脑的环境里。桌面有一个写着 LOOM NODE PROMPT 的对话框（按钮 CONFIRM / RETRY），和一个标题为 LOOM NODE TERMINAL 的终端窗口。',
      `请你自己用 screenshot 工具先看屏幕，然后点 CONFIRM 按钮，再点击 LOOM NODE TERMINAL 终端窗口内部，输入这段 ASCII 文本 ${code} 并按 Enter。`,
      '不要询问我坐标，自己看截图判断。完成后用一句话报告你实际做了什么、屏幕上看到了什么。'
    ].join('\n')
    const camp = await createConfiguredCampAndSend((operation, params = {}) => hostRequest({ origin, session, operation, params }), {
      commandId: randomUUID(),
      name: `LOOM 远端电脑 ${Date.now()}`,
      workspace: { projectPath: roots.workspace },
      memberAgentIds: [member.agentId],
      defaultLeadAgentId: member.agentId,
      purpose: 'chat',
      body: goal
    })
    const threadId = camp?.payload?.threadId
    assert.ok(typeof threadId === 'string' && threadId.length > 0, `the goal was not accepted: ${JSON.stringify(camp).slice(0, 400)}`)
    report.steps.goal = { threadId, requestedCode: code }
    const deadline = Date.now() + COMPUTER_CHAIN_BUDGET_MS
    let snapshot = null
    let run = null
    let clicked = null
    let typed = null
    while (Date.now() < deadline) {
      await pause(4_000)
      snapshot = await hostRequest({ origin, session, operation: 'threads.open', params: { threadId, traceId: randomUUID() } })
      run = (snapshot?.agentRuns ?? []).find(entry => entry.agentId === member.agentId)
      clicked = readIfPresent(desktop.clicked)
      typed = readIfPresent(desktop.typed)
      if (clickReceipt(clicked) && typedReceipt(typed, code)) break
      if (run && ['failed', 'cancelled'].includes(run.status)) {
        throw new Error(`the model Run ${run.status}: ${JSON.stringify(run.failure ?? run.terminalReasonCode)}`)
      }
    }
    assert.equal(clickReceipt(clicked), true, `the model never clicked CONFIRM on the node desktop (receipt: ${JSON.stringify(clicked)})`)
    assert.equal(typedReceipt(typed, code), true, `the node terminal did not receive the requested code (receipt: ${JSON.stringify(typed)})`)
    report.nodeDesktopChanged = true
    report.modelAutonomousToolCalls = true
    report.steps.nodeReceipts = { clicked: String(clicked).trim(), typedMatched: true }
    // Let the real Run settle: the grant serializes its tools, so a second call while it
    // still runs would be refused as busy rather than proving anything.
    for (let attempt = 0; attempt < 120; attempt += 1) {
      if (run && ['succeeded', 'failed', 'cancelled'].includes(run.status)) break
      await pause(2_000)
      snapshot = await hostRequest({ origin, session, operation: 'threads.open', params: { threadId, traceId: randomUUID() } })
      run = (snapshot?.agentRuns ?? []).find(entry => entry.agentId === member.agentId)
    }
    assert.equal(run?.status, 'succeeded', `the model Run did not succeed: ${JSON.stringify(run?.failure ?? run?.terminalReasonCode)}`)
    const modelReport = (snapshot?.messages ?? []).filter(message => message.authorType === 'agent').slice(-1)[0]
    report.steps.modelRun = { id: run.id, status: run.status, report: String(modelReport?.body ?? '').slice(0, 400) }
    await browser.capture(evidence.pageRun)

    // The desktop after the Run, through the same product route, must differ from the baseline.
    const afterView = await workbench({ origin, session, path: `/computer/nodes/${paired.nodeId}/view`, body: { deviceId, consent: true } })
    await pause(400)
    const afterFrame = await fetch(`${origin}/api/v1/computer/nodes/${paired.nodeId}/frame`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session}` },
      body: JSON.stringify({ viewId: afterView.viewId, consent: true })
    })
    assert.equal(afterFrame.ok, true, `the post-run node capture failed: ${afterFrame.status}`)
    const afterPng = Buffer.from(await afterFrame.arrayBuffer())
    await writeFile(evidence.nodeDesktopAfter, afterPng)
    await workbench({ origin, session, path: `/computer/nodes/${paired.nodeId}/view/stop`, body: { viewId: afterView.viewId } })
    assert.notEqual(digestOf(afterPng), digestOf(baselinePng), 'the node desktop did not change after the model run')
    report.screenshots.nodeDesktopAfter = { bytes: afterPng.length, sha256: digestOf(afterPng) }

    // ---- the model's own tool path, read back from the reviewed definition ----------
    const config = await hostRequest({ origin, session, operation: 'mcp.config.get' })
    const server = (config?.servers ?? []).find(entry => String(entry.name ?? '').startsWith('loom-computer-agent-'))
    assert.ok(server, 'the grant stored no MCP server for the member')
    const revealed = await hostRequest({ origin, session, operation: 'mcp.servers.reveal', params: { serverId: server.serverId, expectedConfigDigest: config.configDigest } })
    const stored = grantServer({ config, definitionJson: revealed.definitionJson })
    assert.equal(stored.env.LOOM_COMPUTER_AGENT_RUNTIME, 'pi', 'the stored grant must be the Pi toolchain')
    assert.equal(stored.env.LOOM_COMPUTER_AGENT_SUBJECT, member.agentId, 'the stored grant must name the reviewed member')
    assert.equal(stored.env.LOOM_COMPUTER_AGENT_SCOPE, 'control', 'the stored grant must carry the reviewed scope')
    report.steps.storedGrant = { server: stored.name, runtime: stored.env.LOOM_COMPUTER_AGENT_RUNTIME, scope: stored.env.LOOM_COMPUTER_AGENT_SCOPE }
    bridge = spawn(python, [bridgeScript], {
      stdio: ['pipe', 'pipe', 'pipe'],
      // Exactly the environment the reviewed definition carries: no PATH, no extra secret.
      env: {
        LOOM_COMPUTER_AGENT_ENDPOINT: stored.env.LOOM_COMPUTER_AGENT_ENDPOINT,
        LOOM_COMPUTER_AGENT_ORIGIN: stored.env.LOOM_COMPUTER_AGENT_ORIGIN,
        LOOM_COMPUTER_AGENT_TOKEN_FILE: stored.env.LOOM_COMPUTER_AGENT_TOKEN_FILE,
        LOOM_COMPUTER_AGENT_DIGEST: stored.env.LOOM_COMPUTER_AGENT_DIGEST,
        LOOM_COMPUTER_AGENT_RUNTIME: stored.env.LOOM_COMPUTER_AGENT_RUNTIME,
        LOOM_COMPUTER_AGENT_SUBJECT: stored.env.LOOM_COMPUTER_AGENT_SUBJECT,
        LOOM_COMPUTER_AGENT_SCOPE: stored.env.LOOM_COMPUTER_AGENT_SCOPE,
        PATH: '/usr/bin:/bin'
      }
    })
    children.push({ stop: () => { try { bridge.kill('SIGKILL') } catch { /* gone */ } } })
    const replies = new Map()
    let buffer = ''
    let bridgeError = ''
    bridge.stdout.on('data', chunk => {
      buffer += String(chunk)
      let index
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1)
        if (!line.trim()) continue
        try { const parsed = JSON.parse(line); replies.set(parsed.id, parsed) } catch { /* diagnostics never reach stdout */ }
      }
    })
    bridge.stderr.on('data', chunk => { bridgeError = (bridgeError + String(chunk)).slice(-4_000) })
    const send = message => bridge.stdin.write(`${JSON.stringify(message)}\n`)
    const awaitReply = async id => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (replies.has(id)) return replies.get(id)
        await pause(100)
      }
      throw new Error(`the bridge never answered request ${id}: ${bridgeError.slice(-400)}`)
    }
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'loom-acceptance', version: '1' } } })
    await awaitReply(1)
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
    const tools = await awaitReply(2)
    const toolNames = (tools.result?.tools ?? []).map(tool => tool.name).sort()
    assert.deepEqual(toolNames, ['key', 'mouse_click', 'screenshot', 'text', 'wheel'], 'the grant must expose exactly the closed five tools')
    send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'screenshot', arguments: {} } })
    let live = await awaitReply(3)
    for (let attempt = 0; attempt < 10 && live.result?.isError === true; attempt += 1) {
      await pause(1_500)
      send({ jsonrpc: '2.0', id: 30 + attempt, method: 'tools/call', params: { name: 'screenshot', arguments: {} } })
      live = await awaitReply(30 + attempt)
    }
    const image = (live.result?.content ?? []).find(part => part.type === 'image')
    assert.ok(image, `the standing grant did not capture a real image: ${JSON.stringify(live).slice(0, 300)}`)
    const bridgePng = Buffer.from(image.data, 'base64')
    assert.ok(bridgePng.length > 1_000 && bridgePng.subarray(1, 4).toString('ascii') === 'PNG', 'the bridge answered no real PNG')
    await writeFile(join(OUT, 'model-tool-screenshot.png'), bridgePng)
    report.steps.bridgeBeforeRevoke = { pngBytes: bridgePng.length, sha256: digestOf(bridgePng) }

    // ---- the page revokes, and the same bridge is refused ---------------------------
    const revokeButton = '[...document.querySelectorAll(".ln-computer-agent-access button")].find(button => button.textContent.trim() === "撤销")'
    if (!(await browser.evaluate(`!!${revokeButton}`))) {
      // A settled Run may leave the dock without a bound assistant; rebinding the
      // conversation is one click and does not touch the grant.
      await browser.click('[...document.querySelectorAll(".ln-conversation-main")].find(button => button.textContent.includes("LOOM 远端电脑"))')
      await pause(2_500)
      await browser.click('document.querySelector("#workspace-tab-computer")')
      await pause(1_500)
      if (!(await browser.evaluate(`!!${revokeButton}`))) {
        await browser.click('document.querySelector(\'button[aria-label="选择要查看的电脑"]\')')
        await pause(900)
        await browser.click(`[...document.querySelectorAll(".ln-choice-item")].find(item => item.textContent.includes(${JSON.stringify(paired.displayName)}))`)
        await pause(2_500)
      }
    }
    await waitForText(browser, `!!${revokeButton}`, 120_000, 'the revoke control')
    await browser.click(`(${revokeButton})`)
    await waitForText(browser, 'document.querySelector(".ln-computer-agent-access")?.innerText.includes("已撤销电脑权限") === true', 120_000, 'the revoke confirmation')
    await browser.capture(evidence.pageRevoked)
    report.pageRevoked = true
    send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'screenshot', arguments: {} } })
    const refused = await awaitReply(4)
    assert.equal(refused.result?.isError === true || Boolean(refused.error), true,
      `a revoked grant still answered a tool call: ${JSON.stringify(refused).slice(0, 300)}`)
    const refusalText = JSON.stringify(refused.result?.content ?? refused.error ?? '')
    assert.equal(/grant_unavailable|grant_revoked|computer_agent_grant_revoked|401|403/u.test(refusalText), true,
      `the refusal must name the revoked grant: ${refusalText.slice(0, 200)}`)
    report.bridgeRefusedAfterRevoke = true
    report.steps.bridgeAfterRevoke = { refused: true, detail: refusalText.slice(0, 200) }
    report.status = 'passed-page-model-node-and-revoke'
  } catch (error) {
    report.status = 'failed'
    report.error = { name: error?.name ?? null, message: String(error?.message ?? error).slice(0, 1_500) }
    if (browser) {
      try {
        report.failurePage = await browser.evaluate('document.body.innerText.slice(-1_500)')
        await browser.capture(join(OUT, 'failed-page.png'))
      } catch { /* the browser may already be gone */ }
    }
    throw error
  } finally {
    try { bridge?.stdin.end() } catch { /* already closed */ }
    for (const child of children.reverse()) {
      try { await child.stop?.() } catch { /* already gone */ }
    }
    try { await browser?.close() } catch { /* already closed */ }
    if (typeof nodeLog === 'string' && nodeLog !== '') report.steps.nodeLogTail = nodeLog.slice(-600)
    if (typeof hostLog === 'string' && hostLog !== '') report.steps.hostLogTail = hostLog.slice(-600)
    const redacted = redactDeep(report, secrets)
    const leaks = findSecretLeak(JSON.stringify(redacted), secrets)
    await mkdir(OUT, { recursive: true })
    await writeFile(join(OUT, 'computer-report.json'), `${JSON.stringify(redacted, null, 2)}\n`)
    if (leaks.length > 0) throw new Error(`the computer report would leak a credential: ${leaks.length} hit(s)`)
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
