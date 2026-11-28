// Synthetic ACP peer for scripts/smoke-loom-control.mjs.
//
// This is a *controlled protocol process*, not a model: it answers the ACP handshake the way
// `scripts/fixtures/missing-completion-acp-runtime.mjs` does, then performs the LOOM work a
// reviewer/producer would perform by calling the real `rovai` CLI that Core injected through
// `ROVAI_AGENT_CLI`. No credential, no network, no database write and no fabrication of
// auth/context/rows happens here: every state change below is a real Built-in Tool invocation.
//
// Usage (from the smoke's `/bin/sh` wrapper):
//   node fixtures/loom-control-acp.mjs --fixture-journal <absolute path to journal.jsonl>
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline'
import { dirname, join } from 'node:path'

const arguments_ = process.argv.slice(2)
// The Copilot probe asks for the version before anything else and must see a real banner.
if (arguments_.includes('--version')) {
  process.stdout.write('GitHub Copilot CLI 1.0.88.\n')
  process.exit(0)
}

const journalIndex = arguments_.indexOf('--fixture-journal')
const journalPath = journalIndex === -1 ? null : arguments_[journalIndex + 1]
const sessionId = `loom-control-${process.pid}`
const handled = []

// Opt-in first verdict. Unset (the default, and the only thing `scripts/smoke-loom-control.mjs` ever
// sets) keeps the historical chain: v1 -> `request_changes` -> rework -> v2 -> `pass`. A harness that
// has to prove the Owner's own "退回重做" release sets `LOOM_CONTROL_FIXTURE_FIRST_VERDICT=blocked`, and
// only the *first* candidate's verdict changes: without a User decision a block is terminal, so the
// release under test is the one thing that can bring the chain back.
const firstVerdict = (process.env.LOOM_CONTROL_FIXTURE_FIRST_VERDICT ?? '').trim().toLowerCase()
if (firstVerdict !== '' && !['request_changes', 'blocked'].includes(firstVerdict)) {
  // A typo must fail the ACP handshake loudly instead of quietly running the default chain.
  throw new Error(`LOOM_CONTROL_FIXTURE_FIRST_VERDICT must be request_changes or blocked, not ${firstVerdict}`)
}

function journal(entry) {
  if (journalPath === null) return
  const record = { at: new Date().toISOString(), pid: process.pid, sessionId, ...entry }
  appendFileSync(journalPath, `${JSON.stringify(record)}\n`)
}

function send(message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`)
}

function summarize(argvList, parsed) {
  const pick = (value, keys) => {
    const summary = {}
    for (const key of keys) {
      if (value?.[key] !== undefined) summary[key] = value[key]
    }
    return summary
  }
  if (argvList[0] === 'loom' && argvList[1] === 'claim') return pick(parsed, ['claimId', 'taskId', 'fenceGeneration', 'replayed'])
  if (argvList[0] === 'loom' && argvList[1] === 'evidence') return pick(parsed.artifact ?? {}, ['artifactId', 'relativePath', 'sha256', 'sizeBytes'])
  if (argvList[0] === 'loom' && argvList[1] === 'submit') return pick(parsed, ['candidateId', 'taskId', 'previousCandidateId', 'acceptanceStatus', 'replayed'])
  if (argvList[0] === 'loom' && argvList[1] === 'inspect') {
    return {
      ...pick(parsed, ['policyRevision', 'reviewerAgentId', 'manifestHash']),
      candidateId: parsed.candidate?.candidateId ?? null,
      previousCandidateId: parsed.candidate?.previousCandidateId ?? null,
      artifactIds: (parsed.artifacts ?? []).map(artifact => artifact.artifactId)
    }
  }
  if (argvList[0] === 'loom' && argvList[1] === 'stage-review') {
    return { ...pick(parsed.review ?? {}, ['stageReviewId', 'candidateId', 'verdict']), taskStatus: parsed.taskStatus, replayed: parsed.replayed }
  }
  if (argvList[0] === 'loom' && argvList[1] === 'release') return pick(parsed, ['taskId', 'status'])
  if (argvList[0] === 'send') return pick(parsed, ['messageId', 'deliveryIds'])
  return {}
}

// Runs the real `rovai` CLI. Arguments are an argv array (never a shell string); JSON payloads
// go over stdin, which the CLI prefers over every implicit source once no direct flag is given.
function runCli(argvList, { payload = null, label = argvList.join(' ') } = {}) {
  const cli = process.env.ROVAI_AGENT_CLI
  if (!cli) {
    journal({ step: 'cli', label, argv: argvList, status: 'failed', error: 'ROVAI_AGENT_CLI is not injected' })
    throw new Error(`ROVAI_AGENT_CLI is not injected; ${label} cannot run`)
  }
  const result = spawnSync(cli, argvList, {
    cwd: process.cwd(),
    env: process.env,
    input: payload === null ? '' : JSON.stringify(payload),
    encoding: 'utf8',
    timeout: 120_000
  })
  const ok = result.status === 0
  const parsed = ok ? parseJson(result.stdout) : null
  if (ok) {
    journal({ step: 'cli', label, argv: argvList, status: 'ok', summary: summarize(argvList, parsed) })
  } else {
    journal({
      step: 'cli',
      label,
      argv: argvList,
      status: 'failed',
      exitCode: result.status,
      signal: result.signal ?? null,
      stdout: (result.stdout ?? '').slice(-2000),
      stderr: (result.stderr ?? '').slice(-2000)
    })
  }
  if (!ok) {
    throw Object.assign(new Error(`${label} failed with exit code ${result.status}`), { cliFailure: true })
  }
  return { ok, parsed, status: result.status, stdout: result.stdout ?? '', stderr: result.stderr ?? '' }
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function must(result, what) {
  if (!result.ok) throw new Error(`${what} was rejected: ${result.stderr.slice(-500)}`)
  return result.parsed
}

function promptText(params) {
  const blocks = params?.prompt ?? params?.content ?? params?.messages
  if (typeof blocks === 'string') return blocks
  if (!Array.isArray(blocks)) return JSON.stringify(params ?? {})
  return blocks
    .map(block => (typeof block === 'string' ? block : block?.text ?? block?.content?.text ?? ''))
    .filter(Boolean)
    .join('\n')
}

// Only current RUN_INPUT messages carry work; historical context is never re-executed.
function handoffFacts(text) {
  const sections = [...text.matchAll(/\[RUN_INPUT\]\s*\n([\s\S]*?)\n\[\/RUN_INPUT\]/g)]
  const current = parseJson(sections.at(-1)?.[1] ?? '')
  if (!current || !Array.isArray(current.messages)) throw new Error('prompt has no structured RUN_INPUT messages')
  const facts = current.messages
    .filter(message => message.senderType === 'system' && message.body?.startsWith('[LOOM_HANDOFF_V1]\n'))
    .map(message => parseJson(message.body.split('\n')[1]))
  if (facts.length === 0 || facts.some(fact => !fact?.dispatchId || !fact.taskId || !['execute', 'review', 'rework', 'handoff'].includes(fact.kind))) {
    throw new Error('current RUN_INPUT has no valid LOOM handoff')
  }
  return facts
}

function writeWorkspaceFile(relativePath, contents) {
  const absolute = join(process.cwd(), relativePath)
  mkdirSync(dirname(absolute), { recursive: true })
  writeFileSync(absolute, contents, 'utf8')
  return relativePath
}

function tellUser(text) {
  // A short public result so the Run never looks silently finished. `--public-only` with
  // `--to-user` addresses the User only: no Agent Delivery is created.
  must(runCli(['send', '--public-only', '--to-user', '--body', text], { label: 'send' }), 'send')
}

function executeBranch(facts) {
  const taskId = facts.taskId
  must(runCli(['loom', 'claim', '--task-id', taskId]), 'loom claim')
  const relativePath = writeWorkspaceFile('out/v1.md', '# LOOM control smoke v1\n\nFirst delivery of the approved task.\n')
  const evidence = must(runCli(['loom', 'evidence', '--relative-path', relativePath, '--task-id', taskId]), 'loom evidence')
  const artifactId = evidence.artifact?.artifactId
  if (!artifactId) throw new Error('loom evidence returned no artifactId')
  const submitted = must(
    runCli(['loom', 'submit'], { payload: { taskId, evidenceIds: [artifactId] } }),
    'loom submit'
  )
  tellUser(`execute: v1 submitted as ${submitted.candidateId}`)
  return `Copilot fixture (synthetic): v1 delivered for ${taskId} and submitted for stage review.`
}

function reviewBranch(facts) {
  const taskId = facts.taskId
  const inspected = must(runCli(['loom', 'inspect'], { payload: { taskId } }), 'loom inspect')
  const candidate = inspected.candidate
  if (!candidate) throw new Error('loom inspect returned no candidate to review')
  if (inspected.policyRevision === null || inspected.manifestHash === null) {
    throw new Error('loom inspect returned no review authorization for this task')
  }
  const evidenceIds = (inspected.artifacts ?? []).map(artifact => artifact.artifactId)
  const criteria = inspected.task?.acceptanceCriteria?.criteria ?? []
  if (criteria.length === 0) throw new Error('loom inspect returned no acceptance criteria')
  // v1 (no previous candidate) is sent back by the opt-in first verdict; the chained v2 passes.
  const rework = candidate.previousCandidateId === null
  const verdict = rework ? firstVerdict === 'blocked' ? 'blocked' : 'request_changes' : 'pass'
  const blocked = verdict === 'blocked'
  const criteriaResults = criteria.map(criterion => ({
    criterionId: criterion.criterionId,
    satisfied: !rework,
    ...(evidenceIds.length > 0 ? { evidenceIds } : {}),
    note: rework ? 'the first delivery does not answer this criterion yet' : 'the chained delivery answers this criterion'
  }))
  const receipt = must(
    runCli(['loom', 'stage-review'], {
      payload: {
        taskId,
        candidateId: candidate.candidateId,
        policyRevision: inspected.policyRevision,
        manifestHash: inspected.manifestHash,
        verdict,
        reason: !rework
          ? 'The chained candidate answers every acceptance criterion.'
          : blocked
            ? 'The first candidate cannot be judged until its owner decides what the delivery should be.'
            : 'The first candidate needs one rework pass before it can pass.',
        criteriaResults
      }
    }),
    'loom stage-review'
  )
  tellUser(`review: ${verdict} on ${candidate.candidateId} -> ${receipt.taskStatus}`)
  return `Copilot fixture (synthetic): stage review ${verdict} recorded for ${candidate.candidateId}.`
}

function reworkBranch(facts) {
  const taskId = facts.taskId
  const previousCandidateId = facts.candidateId
  if (!previousCandidateId) throw new Error('a rework handoff must name the candidate it answers')
  must(runCli(['loom', 'claim', '--task-id', taskId]), 'loom claim')
  const relativePath = writeWorkspaceFile('out/v2.md', '# LOOM control smoke v2\n\nSecond delivery answering the request for changes.\n')
  const evidence = must(runCli(['loom', 'evidence', '--relative-path', relativePath, '--task-id', taskId]), 'loom evidence')
  const artifactId = evidence.artifact?.artifactId
  if (!artifactId) throw new Error('loom evidence returned no artifactId')
  const submitted = must(
    runCli(['loom', 'submit'], {
      payload: { taskId, evidenceIds: [artifactId], previousCandidateId }
    }),
    'loom submit'
  )
  tellUser(`rework: v2 submitted as ${submitted.candidateId}`)
  return `Copilot fixture (synthetic): v2 delivered for ${taskId}, chained to ${previousCandidateId}.`
}

function handoffBranch(facts) {
  tellUser(`handoff: internal review passed for ${facts.taskId}`)
  return 'Copilot fixture (synthetic): internal review passed; waiting for the User decision.'
}

async function handlePrompt(message) {
  const text = promptText(message.params)
  const currentFacts = handoffFacts(text)
  for (const facts of currentFacts) {
  const key = `${facts.kind}:${facts.dispatchId}`
  if (handled.includes(key)) throw new Error(`duplicate handoff ${key}`)
  handled.push(key)
  journal({ step: 'handoff', kind: facts.kind, dispatchId: facts.dispatchId, status: 'started' })
  let text_ = null
  try {
    if (facts.kind === 'execute') text_ = executeBranch(facts)
    else if (facts.kind === 'review') text_ = reviewBranch(facts)
    else if (facts.kind === 'rework') text_ = reworkBranch(facts)
    else if (facts.kind === 'handoff') text_ = handoffBranch(facts)
    else throw new Error(`unsupported handoff kind ${facts.kind}`)
    journal({ step: 'handoff', kind: facts.kind, dispatchId: facts.dispatchId, status: 'completed' })
  } catch (error) {
    // A failed Built-in Tool call must surface as a failure, never as a quiet end_turn.
    journal({ step: 'branch', kind: facts.kind, status: 'failed', error: error?.message ?? String(error) })
    text_ = `LOOM_FIXTURE_FAILURE ${facts.kind}: ${error?.message ?? String(error)}`
  }
  await finish(text_)
  }
}

async function finish(text) {
  send({
    method: 'session/update',
    params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } }
  })
}

let queue = Promise.resolve()
for await (const line of createInterface({ input: process.stdin })) {
  let message
  try {
    message = JSON.parse(line)
  } catch {
    continue
  }
  if (message.method === 'initialize') {
    send({ id: message.id, result: { protocolVersion: 1, agentCapabilities: {} } })
  } else if (['session/new', 'session/load', 'session/resume'].includes(message.method)) {
    send({
      id: message.id,
      result: {
        sessionId,
        models: { currentModelId: 'loom-control-fixture', availableModels: [{ modelId: 'loom-control-fixture', name: 'LOOM control fixture' }] },
        configOptions: []
      }
    })
  } else if (message.method === 'session/prompt') {
    queue = queue.then(() => handlePrompt(message)).then(
      () => send({ id: message.id, result: { stopReason: 'end_turn' } }),
      error => {
        journal({ step: 'prompt', status: 'failed', error: error?.message ?? String(error) })
        send({
          method: 'session/update',
          params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `LOOM_FIXTURE_FAILURE ${error?.message ?? error}` } } }
        })
        send({ id: message.id, result: { stopReason: 'end_turn' } })
      }
    )
  } else if (message.method === 'session/cancel') {
    // Cancellation needs no completion reply; the smoke never relies on it.
  } else if (message.id !== undefined && message.id !== null) {
    send({ id: message.id, result: {} })
  }
}
await queue
