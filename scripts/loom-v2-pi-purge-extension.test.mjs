// LOOM V2 — tests for the real native Pi Extension adapter (loom-v2-pi-purge-extension.ts).
// Run: node --test scripts/loom-v2-pi-purge-extension.test.mjs  (Node 24.14.1, Root-executed)
// The ExtensionAPI used here is a TEST-ONLY mock host (labeled mock below); it is
// never production evidence. Production receipts carry runtimeEvidence
// 'native_extension_local' and providerPromptSeen:false only.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, stat, writeFile, readFile } from "node:fs/promises"
import { readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

import {
  PIN,
  CONFIG_SCHEMA,
  FILE_GRANT_ENV,
  FILE_GRANT_SCHEMA,
  HOST_BINDING_ENV,
  RUNTIME_EVIDENCE,
  loadManagedBinding,
  registerManagedPiPurge,
  validateRunConfig,
  default as extensionEntry,
} from "./loom-v2-pi-purge-extension.ts"

const here = path.dirname(fileURLToPath(import.meta.url))
const UPSTREAM = path.resolve(here, "..", "_artifacts", "reference-repos", "pi-purge-current", "extensions", "pi-purge.ts")
const PERSONA = "# LOOM TEST PERSONA\n\ncwd={{cwd}}\n"
const HOST_PROMPT = "You are a coding assistant running inside pi, a coding agent harness.\n\n# AGENTS\nKeep repo rules.\n"
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex")

/** TEST-ONLY mock host: labeled mock, not production, no model, no network, no writes. */
function createMockApi() {
  const hooks = new Map()
  const commands = []
  const api = {
    mockExtensionApiLabel: "test_only_mock_host",
    on(event, handler) {
      if (!hooks.has(event)) hooks.set(event, [])
      hooks.get(event).push(handler)
      return api
    },
    registerCommand(name) {
      commands.push(name)
      return api
    },
  }
  const trigger = async (event, payload) => {
    const handlers = hooks.get(event) ?? []
    return Promise.all(handlers.map((handler) => handler(payload, {})))
  }
  return { api, hooks, commands, trigger }
}

const RUN = { runId: "run_test_1", botId: "bot_test_1", executionEpoch: 7 }

async function makeRunDir() {
  return mkdtemp(path.join(tmpdir(), "loom-pi-purge-ext-"))
}

async function writeConfig(dir, overrides = {}) {
  const personaPath = path.join(dir, "persona.md")
  await writeFile(personaPath, PERSONA, "utf8")
  const personaSha256 = sha256(readFileSync(personaPath))
  const config = {
    schema: CONFIG_SCHEMA,
    ...RUN,
    mode: "append",
    upstreamPath: UPSTREAM,
    upstreamSha256: PIN.sha256,
    personaPath,
    personaSha256,
    receiptPath: path.join(dir, "receipt.jsonl"),
    ...overrides,
  }
  const configPath = path.join(dir, "run.json")
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  return { configPath, config, personaPath, personaSha256 }
}

/** Real ROVAI shapes: Core HostBinding has agentRunId + executionEpoch and NO botId;
 *  botId lives only at the fileGrant top level. */
async function writeRovai(dir, { host = {}, grant = {} } = {}) {
  const hostPath = path.join(dir, "host-binding.json")
  const grantPath = path.join(dir, "file-grant.json")
  await writeFile(hostPath, `${JSON.stringify({ schema: "loom.runtime.host-binding.v1", agentRunId: RUN.runId, executionEpoch: RUN.executionEpoch, ...host })}\n`, "utf8")
  await writeFile(grantPath, `${JSON.stringify({ schema: FILE_GRANT_SCHEMA, runId: RUN.runId, executionEpoch: RUN.executionEpoch, botId: RUN.botId, ...grant })}\n`, "utf8")
  return { [HOST_BINDING_ENV]: hostPath, [FILE_GRANT_ENV]: grantPath }
}

async function receipts(configPath, previouslyValidatedBinding) {
  const loaded = previouslyValidatedBinding
    ? { ok: true, binding: previouslyValidatedBinding }
    : loadManagedBinding({ configPath, expectedRun: RUN, env: {} })
  assert.equal(loaded.ok, true, JSON.stringify(loaded.errors))
  const text = await readFile(loaded.binding.receiptPath, "utf8").catch(() => "")
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line))
}

test("01 pinned source: real upstream sha256 equals the frozen pin", () => {
  assert.equal(sha256(readFileSync(UPSTREAM)), PIN.sha256)
  assert.equal(PIN.version, "0.3.0")
  assert.equal(PIN.commit, "d0196ccfd773b0ed342bd2f25372aff65f1a4a53")
})

test("02 no binding file: default entry registers nothing and changes no prompt", async () => {
  const result = await extensionEntry(createMockApi().api, { env: {} })
  assert.equal(result.ok, true)
  assert.equal(result.status, "disabled_no_binding")
  assert.deepEqual(result.hooks, [])
})

test("03 load: valid append binding loads frozen config and reports pinned digests", async () => {
  const dir = await makeRunDir()
  try {
    const { configPath } = await writeConfig(dir)
    const loaded = loadManagedBinding({ configPath, expectedRun: RUN, env: {} })
    assert.equal(loaded.ok, true, JSON.stringify(loaded.errors))
    assert.equal(Object.isFrozen(loaded.binding), true)
    assert.equal(loaded.binding.upstreamSha256, PIN.sha256)
    assert.equal(loaded.binding.mode, "append")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("04 unsupported modes: replace/fallback/strict refused here", async () => {
  for (const mode of ["replace", "fallback", "strict"]) {
    const dir = await makeRunDir()
    try {
      const { configPath } = await writeConfig(dir, { mode })
      const loaded = loadManagedBinding({ configPath, expectedRun: RUN, env: {} })
      assert.equal(loaded.ok, false)
      assert.ok(loaded.errors.includes(`mode_not_supported_here:${mode}`), JSON.stringify(loaded.errors))
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }
})

test("05 owner context: mismatch refused, absent context refused", async () => {
  const dir = await makeRunDir()
  try {
    const { configPath } = await writeConfig(dir)
    const wrong = loadManagedBinding({ configPath, expectedRun: { ...RUN, executionEpoch: 8 }, env: {} })
    assert.equal(wrong.ok, false)
    assert.ok(wrong.errors.includes("executionEpoch_mismatch_expectedRun"))
    const missing = loadManagedBinding({ configPath, env: {} })
    assert.equal(missing.ok, false)
    assert.ok(missing.errors.includes("owner_context_missing_expectedRun_or_rovai_files"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("06 hash: unpinned upstreamSha256 and drifted persona are refused", async () => {
  const dir = await makeRunDir()
  try {
    const first = await writeConfig(dir, { upstreamSha256: "a".repeat(64) })
    const badPin = loadManagedBinding({ configPath: first.configPath, expectedRun: RUN, env: {} })
    assert.equal(badPin.ok, false)
    assert.ok(badPin.errors.includes("upstreamSha256_must_match_pinned_reference"))
    const second = await writeConfig(dir)
    await writeFile(second.personaPath, "different persona\n", "utf8")
    const badPersona = loadManagedBinding({ configPath: second.configPath, expectedRun: RUN, env: {} })
    assert.equal(badPersona.ok, false)
    assert.ok(badPersona.errors.includes("personaSha256_mismatch"))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("07 off: session_start leaves the original disabled, prompt untouched", async () => {
  const dir = await makeRunDir()
  try {
    const { configPath } = await writeConfig(dir, { mode: "off" })
    const binding = loadManagedBinding({ configPath, expectedRun: RUN, env: {} })
    const host = createMockApi()
    const registered = await registerManagedPiPurge(host.api, binding.binding)
    assert.equal(registered.ok, true, JSON.stringify(registered.errors))
    assert.deepEqual([...host.hooks.keys()].sort(), ["before_agent_start", "session_start"])
    await host.trigger("session_start", {})
    const [prompt] = await host.trigger("before_agent_start", { systemPrompt: HOST_PROMPT })
    assert.equal(prompt, undefined)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("08 append: activation after reset, host text preserved whole", async () => {
  const dir = await makeRunDir()
  try {
    const { configPath } = await writeConfig(dir)
    const binding = loadManagedBinding({ configPath, expectedRun: RUN, env: {} })
    const host = createMockApi()
    await registerManagedPiPurge(host.api, binding.binding)
    const beforeReset = await host.trigger("before_agent_start", { systemPrompt: HOST_PROMPT, systemPromptOptions: { cwd: "C:/fake" } })
    assert.equal(beforeReset[0], undefined, "nothing applied before session_start")
    await host.trigger("session_start", {})
    const [prompt] = await host.trigger("before_agent_start", { systemPrompt: HOST_PROMPT, systemPromptOptions: { cwd: "C:/fake" } })
    assert.ok(prompt.systemPrompt.startsWith("# LOOM TEST PERSONA"))
    assert.ok(prompt.systemPrompt.includes("cwd=C:/fake"))
    assert.ok(prompt.systemPrompt.endsWith(HOST_PROMPT), "host prompt preserved whole")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("09 tamper: persona changed after load is refused at the hook", async () => {
  const dir = await makeRunDir()
  try {
    const { configPath, personaPath } = await writeConfig(dir)
    const binding = loadManagedBinding({ configPath, expectedRun: RUN, env: {} })
    const host = createMockApi()
    await registerManagedPiPurge(host.api, binding.binding)
    await host.trigger("session_start", {})
    await writeFile(personaPath, "# TAMPERED PERSONA\n", "utf8")
    const [prompt] = await host.trigger("before_agent_start", { systemPrompt: HOST_PROMPT, systemPromptOptions: { cwd: "C:/fake" } })
    assert.equal(prompt, undefined)
    // Read the original frozen receipt location; re-admitting tampered input must fail.
    const lines = await receipts(configPath, binding.binding)
    assert.ok(lines.some((line) => line.refused === "persona_tampered"), JSON.stringify(lines))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("10 paths: receipt outside run dir, and receipt colliding config, are refused", async () => {
  const dir = await makeRunDir()
  const outside = await mkdtemp(path.join(tmpdir(), "loom-pi-purge-outside-"))
  try {
    const escaped = await writeConfig(dir, { receiptPath: path.join(outside, "receipt.jsonl") })
    const outsideResult = loadManagedBinding({ configPath: escaped.configPath, expectedRun: RUN, env: {} })
    assert.equal(outsideResult.ok, false)
    assert.ok(outsideResult.errors.includes("receipt_outside_run_dir"), JSON.stringify(outsideResult.errors))
    const collide = await writeConfig(dir, { receiptPath: path.join(dir, "run.json") })
    const collideResult = loadManagedBinding({ configPath: collide.configPath, expectedRun: RUN, env: {} })
    assert.equal(collideResult.ok, false)
    assert.ok(collideResult.errors.includes("receipt_collides_config"), JSON.stringify(collideResult.errors))
  } finally {
    await rm(dir, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  }
})

test("11 inherited PI_PURGE_SOURCE is refused, never scrubbed", async () => {
  const dir = await makeRunDir()
  try {
    const { configPath } = await writeConfig(dir)
    const env = { PI_PURGE_SOURCE: "C:/should/not/be/used.md" }
    const loaded = validateRunConfig(JSON.parse(readFileSync(configPath, "utf8")), {
      configPath,
      expectedRun: RUN,
      env,
    })
    assert.equal(loaded.ok, false)
    assert.ok(loaded.errors.includes("inherited_PI_PURGE_SOURCE_refused"))
    assert.equal(env.PI_PURGE_SOURCE, "C:/should/not/be/used.md", "env must not be deleted or mutated")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("12 evidence: receipts are native_extension_local, provider-unobserved, secret-free", async () => {
  const dir = await makeRunDir()
  try {
    const { configPath } = await writeConfig(dir)
    const binding = loadManagedBinding({ configPath, expectedRun: RUN, env: {} })
    const host = createMockApi()
    await registerManagedPiPurge(host.api, binding.binding)
    await host.trigger("session_start", {})
    await host.trigger("before_agent_start", { systemPrompt: HOST_PROMPT, systemPromptOptions: { cwd: "C:/fake" } })
    const lines = await receipts(configPath)
    assert.ok(lines.length >= 2, JSON.stringify(lines))
    for (const line of lines) {
      assert.equal(line.runtimeEvidence, RUNTIME_EVIDENCE)
      assert.equal(line.providerPromptSeen, false)
      assert.equal(line.mockExtensionApi, undefined, "production receipts must not claim a mock")
      assert.equal(line.prompt, undefined)
      assert.equal(line.systemPrompt, undefined)
      assert.equal(line.persona, undefined)
    }
    const raw = await readFile(binding.binding.receiptPath, "utf8")
    assert.ok(!raw.includes("LOOM TEST PERSONA"), "persona text must never be written")
    assert.ok(!raw.includes("Keep repo rules"), "prompt text must never be written")
    assert.ok(lines.some((line) => line.hook === "session_start" && line.activated === true))
    assert.ok(lines.some((line) => line.hook === "before_agent_start" && line.applied === true))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("13 owner from ROVAI files: host has no botId, botId derives from fileGrant only", async () => {
  const dir = await makeRunDir()
  try {
    const { configPath } = await writeConfig(dir)
    // Core HostBinding shape: agentRunId + executionEpoch, no botId. A stray host botId
    // must be irrelevant because botId is derived from the fileGrant top level only.
    const env = await writeRovai(dir, { host: { botId: "bot_wrong_host_level" } })
    const loaded = loadManagedBinding({ configPath, env })
    assert.equal(loaded.ok, true, JSON.stringify(loaded.errors))
    assert.equal(loaded.binding.runId, RUN.runId)
    assert.equal(loaded.binding.botId, RUN.botId, "botId comes from fileGrant, not the host binding")
    assert.equal(loaded.binding.executionEpoch, RUN.executionEpoch)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("14 negative cross-run grant: grant.runId or grant schema disagreeing is refused", async () => {
  const dir = await makeRunDir()
  try {
    const { configPath } = await writeConfig(dir)
    const crossRun = await writeRovai(dir, { grant: { runId: "run_other_9" } })
    const crossed = loadManagedBinding({ configPath, env: crossRun })
    assert.equal(crossed.ok, false)
    assert.ok(crossed.errors.includes("runId_mismatch_file_grant"), JSON.stringify(crossed.errors))
    const wrongSchema = await writeRovai(dir, { grant: { schema: "loom.runtime.file-guard.v0" } })
    const schemaResult = loadManagedBinding({ configPath, env: wrongSchema })
    assert.equal(schemaResult.ok, false)
    assert.ok(schemaResult.errors.includes(`file_grant_schema_must_be_${FILE_GRANT_SCHEMA}`), JSON.stringify(schemaResult.errors))
    const noBot = await writeRovai(dir, { grant: { botId: undefined } })
    const noBotResult = loadManagedBinding({ configPath, env: noBot })
    assert.equal(noBotResult.ok, false)
    assert.ok(noBotResult.errors.includes("botId_missing_in_file_grant"), JSON.stringify(noBotResult.errors))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("15 default entry throws when an explicitly requested binding fails", async () => {
  const dir = await makeRunDir()
  try {
    const { configPath } = await writeConfig(dir, { mode: "strict" })
    await assert.rejects(
      () => extensionEntry(createMockApi().api, { configPath, env: {} }),
      /loom_pi_purge_binding_invalid:mode_not_supported_here:strict/,
    )
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test("16 receipt target swapped for a non-regular file is refused before append", async () => {
  const dir = await makeRunDir()
  try {
    const { configPath } = await writeConfig(dir)
    const binding = loadManagedBinding({ configPath, expectedRun: RUN, env: {} })
    const host = createMockApi()
    await registerManagedPiPurge(host.api, binding.binding)
    await host.trigger("session_start", {})
    await rm(binding.binding.receiptPath)
    await mkdir(binding.binding.receiptPath)
    const [prompt] = await host.trigger("before_agent_start", { systemPrompt: HOST_PROMPT, systemPromptOptions: { cwd: "C:/fake" } })
    assert.ok(prompt && typeof prompt.systemPrompt === "string", "prompt path still works without a receipt")
    assert.equal((await stat(binding.binding.receiptPath)).isDirectory(), true, "receipt target must be left untouched")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
