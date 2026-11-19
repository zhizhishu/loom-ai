// Parse every page expression used by the live Pi fixture without opening a
// browser, starting a Host, loading credentials, or sending a model request.
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { pageScript, radioChoiceSelector } from './loom-owned-page.mjs'
import { robustInvocation } from './ab-browser.mjs'
import { UI, rosterJs, tagMemberJs, tagByTextJs, tagChoiceItemJs } from './loom-browser-live-mode.mjs'
const require = createRequire(new URL('../../apps/desktop/package.json', import.meta.url))
const ts = require('typescript')

test('every generated Pi UI page expression compiles with the actual browser wrapper', async t => {
  const source = await readFile(new URL('./loom-pi-purge-production-ui.test.mjs', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('pi-ui.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(ast.parseDiagnostics.length, 0)
  const context = { UI, rosterJs, tagMemberJs, tagByTextJs, tagChoiceItemJs,
    selector: '.ln-studio-tabs button', text: '运行与权限', tag: 'fixture-tag',
    trigger: 'button[aria-label="Pi Purge 模式"]', actual: '读写文件并处理任务',
    readyWait: 'purge_trigger_ready', selectedWait: 'purge_selection_applied',
    target: { displayName: '助手 "A"\n验收' }, row: { name: '助手 "A"\n验收' },
    goal: '目标含 "双引号"、\'单引号\'与\n换行',
    rowSelector: '.ln-run-panel[data-mission-id="mission-1"] .ln-run-artifact[data-artifact-id="artifact-2"] button.ln-run-file',
    marker: 'LOOM_PERSONA_fixture', nonce: 'LOOM_TASK_fixture'
  }
  // Keep top-level selectors from the fixture itself, so their edits are covered.
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !['STUDIO','PERSONA_INPUT','PURGE_TRIGGER','FILE_TRIGGER','LEAD_TEXT_JS','WAIT_NAMES',
        'ARTIFACT_BODY_TEXT_JS','ARTIFACT_PREVIEW_SETTLED_JS','ARTIFACT_DIALOG_READ_JS'].includes(declaration.name.text)) continue
      context[declaration.name.text] = new Function(...Object.keys(context), 'return (' + declaration.initializer.getText(ast) + ')')(...Object.values(context))
    }
  }
  const lines = [], forwarded = []
  let chooseDeclaration
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'choose') chooseDeclaration = node
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ['evalValue','waitPage'].includes(node.expression.text)) {
      const isWait = node.expression.text === 'waitPage'
      if (isWait) {
        const name = new Function(...Object.keys(context), 'return (' + node.arguments[0].getText(ast) + ')')(...Object.values(context))
        assert.equal(context.WAIT_NAMES.has(name), true, 'every page wait must persist a fixed diagnostic name')
      }
      const argument = node.arguments[isWait ? 1 : 0]
      assert.ok(argument)
      const position = ast.getLineAndCharacterOfPosition(node.getStart(ast)).line + 1
      if (ts.isIdentifier(argument) && argument.text === 'expression') forwarded.push(position)
      else {
        const code = new Function(...Object.keys(context), 'return (' + argument.getText(ast) + ')')(...Object.values(context))
        assert.equal(typeof code, 'string', 'non-string page script at line ' + position)
        assert.doesNotThrow(() => new Function(pageScript(code)), 'invalid page script at line ' + position)
        lines.push(position)
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.equal(forwarded.length, 1, 'only waitPage may forward its already checked expression')
  assert.ok(lines.length > 0, 'the fixture must contain page expressions')
  t.diagnostic(lines.length + ' page expressions compiled; one waitPage forwarding call covered by those expressions')
  assert.ok(chooseDeclaration)
  for (const [tag, label, readyWait, selectedWait] of [
    ['purge-append','追加助手设定','purge_trigger_ready','purge_selection_applied'],
    ['purge-file-policy','读写文件并处理任务','file_trigger_ready','file_selection_applied'],
    ['purge-lead','当前主助手替换','lead_trigger_ready','lead_selection_applied']
  ]) for (const failAt of [readyWait, selectedWait, null]) {
    const calls = [], state = { steps: {} }, trigger = 'button[aria-label="fixture"]'
    const dependencies = { assert, report: state, tabId: 'fixture-tab', radioChoiceSelector, process: { env: {} },
      persist: async () => {}, evalValue: async () => true,
      waitPage: async name => { if (name === failAt) throw new Error('fixture_wait_failure') },
      ab: { abPick: (tab, selector, options) => {
        calls.push(robustInvocation(tab, selector, 'pick', options))
        assert.equal(options.open, trigger)
        assert.equal(options.value, label)
        return { verdict: 'UNKNOWN', reason: 'TRUSTED_ACTION_UNCONFIRMED' }
      } }
    }
    const choose = new Function(...Object.keys(dependencies), 'return (' + chooseDeclaration.getText(ast) + ')')(...Object.values(dependencies))
    if (failAt) await assert.rejects(choose(trigger, label, tag), /fixture_wait_failure/)
    else await choose(trigger, label, tag)
    assert.equal(calls.length, failAt === readyWait ? 0 : 1, 'unconfirmed picks are never replayed')
    if (calls.length) {
      assert.equal(calls[0].args.filter(value => value === '--open').length, 1)
      assert.equal(state.steps.choiceInputs[0].phase, failAt ? 'pick_returned' : 'selection_verified')
      assert.equal(state.steps.choiceInputs[0].reason, 'TRUSTED_ACTION_UNCONFIRMED')
    }
  }
  t.diagnostic('both real choose functions wait for readiness, invoke one idempotent picker, and require the controlled value; unconfirmed picks are not replayed')

  // A definite `pick_not_found` means the toggle never expanded, so the same opener may
  // run once more; an UNKNOWN verdict above is still never replayed.
  const retryCalls = []
  const retryState = { steps: {} }
  const retryDeps = { assert, report: retryState, tabId: 'fixture-tab', radioChoiceSelector, process: { env: {} },
    persist: async () => {}, evalValue: async () => true, waitPage: async () => {},
    ab: { abPick: (tab, selector, options) => {
      retryCalls.push(options.value)
      return retryCalls.length === 1
        ? { verdict: 'FAILED', reason: 'pick_not_found' }
        : { verdict: 'OK', reason: 'NONE' }
    } } }
  const retryingChoose = new Function(...Object.keys(retryDeps), 'return (' + chooseDeclaration.getText(ast) + ')')(...Object.values(retryDeps))
  await retryingChoose('button[aria-label="fixture"]', '追加助手设定', 'purge-append')
  assert.equal(retryCalls.length, 2, 'a missing option is retried exactly once')
  assert.equal(retryState.steps.choiceInputs[0].attempts, 2)
  assert.equal(retryState.steps.choiceInputs[0].phase, 'selection_verified', 'the retry still has to prove the controlled value')
  t.diagnostic('a missing option gets one bounded repeat; the controlled value is still the only proof of selection')
})

// The live fixture used to pass the Lead tag into a choose() that only accepted the
// Persona and file-policy tags, so a round whose current Lead was another member
// failed before any work started. This drives the real branch offline.
test('the Lead is re-picked once only when the current Lead is not the target member', async t => {
  const source = await readFile(new URL('./loom-pi-purge-production-ui.test.mjs', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('pi-ui-lead.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(ast.parseDiagnostics.length, 0)
  const context = { UI, target: { displayName: '目标助手' }, LEAD_TEXT_JS: null }
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'LEAD_TEXT_JS') continue
      context.LEAD_TEXT_JS = new Function(...Object.keys(context), 'return (' + declaration.initializer.getText(ast) + ')')(...Object.values(context))
    }
  }
  assert.equal(typeof context.LEAD_TEXT_JS, 'string', 'the Lead controlled read must stay extractable')
  let declaration
  const visit = node => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'applyLeadChoice') declaration = node
    ts.forEachChild(node, visit)
  }
  visit(ast)
  assert.ok(declaration, 'the Lead branch must stay one extractable function')
  const drive = (reads) => {
    const picks = [], readsSeen = [], queue = [...reads]
    const state = { report: { steps: {} }, persisted: 0 }
    const evalValue = async code => { readsSeen.push(code); return queue.shift() }
    const choose = async (trigger, label, tag) => { picks.push({ trigger, label, tag }) }
    const persist = async () => { state.persisted += 1 }
    const run = new Function(...Object.keys(context), 'return (' + declaration.getText(ast) + ')')(...Object.values(context))
    return { run, picks, readsSeen, state, call: () => run(evalValue, choose, persist, state.report, context.target, assert) }
  }
  // 1. Current Lead is another member: exactly one pick, then a controlled-value read.
  const foreign = drive(['别的助手', context.target.displayName])
  const patch = await foreign.call()
  assert.equal(foreign.picks.length, 1, 'the Lead trigger must be opened exactly once')
  assert.equal(foreign.picks[0].trigger, UI.leadTrigger)
  assert.equal(foreign.picks[0].tag, 'purge-lead')
  assert.equal(foreign.picks[0].label, context.target.displayName)
  assert.deepEqual(foreign.readsSeen, [context.LEAD_TEXT_JS, context.LEAD_TEXT_JS], 'the pick must be followed by the same controlled read')
  assert.equal(patch.repicked, true)
  assert.equal(patch.appliedLead, context.target.displayName)
  // 2. Current Lead is already the target member: no pick at all.
  const same = drive([context.target.displayName])
  const kept = await same.call()
  assert.equal(same.picks.length, 0, 'an already correct Lead must not be re-picked')
  assert.equal(kept.repicked, false)
  // 3. A pick that never renders the target value fails instead of passing silently.
  const stale = drive(['别的助手', '别的助手'])
  await assert.rejects(stale.call(), /controlled value/u)
  t.diagnostic('lead branch: one pick when the current Lead differs, none when it already matches, and a stale render fails')
})

// The live fixture now proves provenance from the write receipt instead of the model's
// literal wording. These are the negative cases that guard the replacement: an accepted
// Candidate, an old file, a borrowed receipt, a lost persona marker and a fake preview
// each have to fail, using read-only fixtures only.
test('the provenance and content adjudicators fail closed on every wrong-round shape', async t => {
  const source = await readFile(new URL('./loom-pi-purge-production-ui.test.mjs', import.meta.url), 'utf8')
  const ast = ts.createSourceFile('pi-ui-gates.mjs', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  assert.equal(ast.parseDiagnostics.length, 0)
  const declarations = new Map()
  const collect = node => {
    if (ts.isFunctionDeclaration(node) && node.name) declarations.set(node.name.text, node.getText(ast))
    ts.forEachChild(node, collect)
  }
  collect(ast)
  const materialize = (name, deps = {}) => {
    assert.ok(declarations.has(name), 'the gate must stay one extractable function: ' + name)
    return new Function(...Object.keys(deps), 'return (' + declarations.get(name) + ')')(...Object.values(deps))
  }
  const normalizeRoot = materialize('normalizeRoot')
  const adjudicateSourceProvenance = materialize('adjudicateSourceProvenance', { normalizeRoot })
  const adjudicateContentCompliance = materialize('adjudicateContentCompliance')
  const adjudicateCandidateState = materialize('adjudicateCandidateState')
  const adjudicatePreviewEvidence = materialize('adjudicatePreviewEvidence')
  const adjudicateChainBinding = materialize('adjudicateChainBinding')

  const FILE = 'pi-persona-result.md'
  const MARKER = 'LOOM_PERSONA_2f0c'
  const NONCE = 'LOOM_TASK_9ac1'
  const ACCEPT = '等待用户接受'
  // One read-only shape that must pass, mirroring the r8 receipt layout: the guard log of
  // the Run's own epoch, a new-file write at 14:12:27.764Z and a claim at 14:12:25.786Z.
  const shape = () => ({
    relativePath: FILE, epoch: 1, runId: 'run-a', botId: 'agent_6',
    baseline: { executionRoot: 'C:\\tmp\\Core\\quick-chat', relativePath: FILE,
      observedAt: '2026-11-18T14:12:00.000Z', exists: false, errorCode: 'ENOENT', insideDataDir: true },
    workspace: { executionRoot: '\\\\?\\C:\\tmp\\Core\\quick-chat', isolation: 'shared' },
    claim: { claimId: 'claim-1', claimedAt: '2026-11-18T14:12:25.786Z' },
    guard: { path: 'C:\\tmp\\guard.jsonl', epoch: 1, runId: 'run-a', botId: 'agent_6', rows: [
      { t: 'guard_ready', runId: 'run-a', botId: 'agent_6' },
      { t: 'decision', at: 1795011147764, toolName: 'write', decision: 'allow', reasonCode: 'in_workspace_new_file', relPath: FILE },
      { t: 'decision', at: 1795011154615, toolName: 'read', decision: 'allow', reasonCode: 'in_workspace', relPath: FILE }
    ] }
  })
  const accepted = adjudicateSourceProvenance(shape(), assert)
  assert.equal(accepted.firstWrite.reasonCode, 'in_workspace_new_file')
  assert.equal(accepted.firstWrite.claimedAtBeforeWrite, true)
  assert.equal(accepted.workspace.matchesBaselineRoot, true)
  t.diagnostic('guard log at `\\?\\C:\\tmp\\Core\\quick-chat` is the same root as the baseline')

  // Old file must be red.
  const existing = shape(); existing.baseline.exists = true; existing.baseline.errorCode = null
  assert.throws(() => adjudicateSourceProvenance(existing, assert), /must not exist/u)
  const denied = shape(); denied.baseline.errorCode = 'EACCES'
  assert.throws(() => adjudicateSourceProvenance(denied, assert), /ENOENT/u)
  const escaped = shape(); escaped.baseline.insideDataDir = false
  assert.throws(() => adjudicateSourceProvenance(escaped, assert), /inside the isolated data directory/u)
  const otherRoot = shape(); otherRoot.workspace.executionRoot = 'C:\\tmp\\Core\\other'
  assert.throws(() => adjudicateSourceProvenance(otherRoot, assert), /the directory the baseline observed/u)
  const overwrite = shape(); overwrite.guard.rows[1].reasonCode = 'in_workspace'
  assert.throws(() => adjudicateSourceProvenance(overwrite, assert), /create the file, not overwrite/u)
  const secondFile = shape(); secondFile.guard.rows.push({ t: 'decision', at: 1795011150000, toolName: 'write', decision: 'allow', reasonCode: 'in_workspace_new_file', relPath: 'other.md' })
  assert.throws(() => adjudicateSourceProvenance(secondFile, assert), /only the requested work file/u)
  t.diagnostic('an existing target, a denied baseline, an escaping path, a foreign root, an overwrite and a second file all fail')

  // Borrowed receipt must be red.
  const lateClaim = shape(); lateClaim.claim.claimedAt = '2026-11-18T14:12:30.000Z'
  assert.throws(() => adjudicateSourceProvenance(lateClaim, assert), /claim must precede/u)
  const oldEpoch = shape(); oldEpoch.guard.epoch = 0
  assert.throws(() => adjudicateSourceProvenance(oldEpoch, assert), /this execution epoch/u)
  const otherRun = shape(); otherRun.guard.runId = 'run-b'
  assert.throws(() => adjudicateSourceProvenance(otherRun, assert), /belong to this Run/u)
  const otherBot = shape(); otherBot.guard.botId = 'agent_7'
  assert.throws(() => adjudicateSourceProvenance(otherBot, assert), /belong to this member/u)
  t.diagnostic('a late claim, an older epoch and another Run or member can never stand in for this Run')

  // Content: the marker is the only gate; a missing work nonce is reported, not fatal.
  const text = ['# 标题', '', MARKER, '', NONCE, ACCEPT].join('\n')
  const compliance = adjudicateContentCompliance({ text, marker: MARKER, nonce: NONCE,
    literalAccept: ACCEPT, sizeBytes: Buffer.byteLength(text, 'utf8'),
    requestedMaxBytes: 200, hardMaxBytes: 1000 }, assert)
  assert.equal(compliance.personaMarkerLine, true)
  assert.equal(compliance.exactCopyMet, true)
  assert.equal(compliance.withinRequestedMaxBytes, true)
  const paraphrased = ['# 标题', '', MARKER, '', '等待用户验收'].join('\n')
  const reported = adjudicateContentCompliance({ text: paraphrased, marker: MARKER, nonce: NONCE,
    literalAccept: ACCEPT, sizeBytes: Buffer.byteLength(paraphrased, 'utf8'),
    requestedMaxBytes: 200, hardMaxBytes: 1000 }, assert)
  assert.equal(reported.workNonceLine, false)
  assert.equal(reported.literalAcceptLine, false)
  assert.equal(reported.exactCopyMet, false)
  const overAsk = adjudicateContentCompliance({ text: paraphrased, marker: MARKER, nonce: NONCE,
    literalAccept: ACCEPT, sizeBytes: Buffer.byteLength(paraphrased, 'utf8'),
    requestedMaxBytes: 40, hardMaxBytes: 1000 }, assert)
  assert.equal(overAsk.withinRequestedMaxBytes, false)
  assert.equal(overAsk.exactCopyMet, false)
  t.diagnostic('a paraphrased accept line and a dropped nonce are reported as exactCopyMet=false, not hidden')

  // Lost frozen source must be red.
  const noMarker = ['# 标题', '', NONCE, ACCEPT].join('\n')
  assert.throws(() => adjudicateContentCompliance({ text: noMarker, marker: MARKER, nonce: NONCE,
    literalAccept: ACCEPT, sizeBytes: Buffer.byteLength(noMarker, 'utf8'),
    requestedMaxBytes: 200, hardMaxBytes: 1000 }, assert), /whole-line persona marker/u)
  const inlineMarker = ['# 标题 ' + MARKER + ' 出现过了', NONCE].join('\n')
  assert.throws(() => adjudicateContentCompliance({ text: inlineMarker, marker: MARKER, nonce: NONCE,
    literalAccept: ACCEPT, sizeBytes: Buffer.byteLength(inlineMarker, 'utf8'),
    requestedMaxBytes: 200, hardMaxBytes: 1000 }, assert), /whole-line persona marker/u)
  const huge = 'x'.repeat(1115)
  assert.throws(() => adjudicateContentCompliance({ text: huge, marker: MARKER, nonce: NONCE,
    literalAccept: ACCEPT, sizeBytes: 1115, requestedMaxBytes: 200, hardMaxBytes: 1000 }, assert), /hard byte cap/u)
  assert.throws(() => adjudicateContentCompliance({ text: paraphrased, marker: MARKER, nonce: NONCE,
    literalAccept: ACCEPT, sizeBytes: 12, requestedMaxBytes: 200, hardMaxBytes: 1000 }, assert), /exact file bytes/u)
  t.diagnostic('a missing marker, a marker leaked into prose, an over-cap file and a lying byte count all fail')

  // Auto-accept must be red, even with a perfect file.
  const pending = { acceptanceStatus: 'PENDING', reviewCount: 0 }
  const kept = adjudicateCandidateState({ before: pending, after: pending }, assert)
  assert.equal(kept.autoAccepted, false)
  assert.throws(() => adjudicateCandidateState({ before: { acceptanceStatus: 'ACCEPTED', reviewCount: 0 }, after: pending }, assert), /PENDING before/u)
  assert.throws(() => adjudicateCandidateState({ before: pending, after: { acceptanceStatus: 'accepted', reviewCount: 0 } }, assert), /PENDING after/u)
  assert.throws(() => adjudicateCandidateState({ before: pending, after: { acceptanceStatus: 'PENDING', reviewCount: 1 } }, assert), /no Owner Review/u)
  t.diagnostic('an already accepted candidate, an accept on open and any Owner Review fail even when the body is perfect')

  // Fake or wrong preview must be red.
  const ready = { settled: { state: 'ready' }, titleText: 'pi-persona-result.md', bodyText: 'x ' + MARKER, marker: MARKER, relativePath: FILE }
  assert.equal(adjudicatePreviewEvidence(ready, assert).markerInBody, true)
  assert.throws(() => adjudicatePreviewEvidence({ ...ready, settled: { state: 'reading' } }, assert), /must settle on a body/u)
  assert.throws(() => adjudicatePreviewEvidence({ ...ready, settled: { state: 'error' } }, assert), /must settle on a body/u)
  assert.throws(() => adjudicatePreviewEvidence({ ...ready, titleText: 'other.md' }, assert), /registered artifact file name/u)
  // The marker only in the aside (never in the body area) must not count.
  assert.throws(() => adjudicatePreviewEvidence({ ...ready, bodyText: 'nothing here' }, assert), /rendered body area/u)
  t.diagnostic('a loading dialog, an error dialog, another file name and a marker seen only in the aside all fail')

  // Wrong-round chain must be red.
  const chain = {
    task: { taskId: 'task-1' }, claim: { claimId: 'claim-1', taskId: 'task-1', agentRunId: 'run-a', claimantAgentId: 'agent_6' },
    candidate: { candidateId: 'candidate-1', taskId: 'task-1', agentRunId: 'run-a', evidenceIds: ['artifact-1'] },
    artifact: { artifactId: 'artifact-1', taskId: 'task-1', agentRunId: 'run-a', creatorId: 'agent_6', relativePath: FILE },
    runId: 'run-a', agentId: 'agent_6', relativePath: FILE
  }
  assert.deepEqual(adjudicateChainBinding(chain, assert), { taskId: 'task-1', claimId: 'claim-1', candidateId: 'candidate-1', artifactId: 'artifact-1' })
  assert.throws(() => adjudicateChainBinding({ ...chain, candidate: { ...chain.candidate, agentRunId: 'run-b' } }, assert), /candidate must reference this Run/u)
  assert.throws(() => adjudicateChainBinding({ ...chain, candidate: { ...chain.candidate, evidenceIds: ['artifact-2'] } }, assert), /reference the registered artifact/u)
  assert.throws(() => adjudicateChainBinding({ ...chain, claim: { ...chain.claim, agentRunId: 'run-b' } }, assert), /claim must name this Run/u)
  assert.throws(() => adjudicateChainBinding({ ...chain, artifact: { ...chain.artifact, taskId: 'task-2' } }, assert), /bound to the Task/u)
  t.diagnostic('a candidate, claim or artifact borrowed from another Run or Task is refused')
})
