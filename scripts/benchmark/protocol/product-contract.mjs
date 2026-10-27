import { readFile, stat } from 'node:fs/promises'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { digestJson, sha256 } from './canonical.mjs'

const DEFAULT_REPOSITORY_ROOT = resolve(import.meta.dirname, '../../..')

const SOURCES = Object.freeze({
  package: 'package.json',
  cargo: 'Cargo.toml',
  dataContract: 'crates/rovai-core/src/db.rs',
  readModel: 'crates/rovai-core/src/read_model.rs',
  contextContract: 'crates/rovai-core/src/context_contract.rs',
  contextDelivery: 'crates/rovai-core/src/context_delivery.rs',
  builtinTransport: 'crates/rovai-core/src/builtin_tool_transport.rs',
  taskContract: 'crates/rovai-core/src/collaboration.rs',
  acceptedAck: 'crates/rovai-core/src/context.rs'
})

export async function collectProductContractFingerprint({
  repositoryRoot = DEFAULT_REPOSITORY_ROOT,
  coreExecutable = null,
  coreHealth = null
} = {}) {
  const source = await readSources(repositoryRoot)
  const packageMetadata = JSON.parse(source.package.contents)
  const cargoVersion = capture(source.cargo.contents, /\[workspace\.package\][\s\S]*?\nversion\s*=\s*"([^"]+)"/u, 'workspace Cargo version')
  const gitCommit = await runGit(repositoryRoot, ['rev-parse', 'HEAD'])
  const gitStatus = await runGit(repositoryRoot, ['status', '--porcelain=v1'])
  const coreDigest = coreExecutable ? await digestExecutable(coreExecutable) : null
  const deliveryProfileSymbol = capture(source.contextDelivery.contents,
    /pub fn current_public_camp_batch_context_delivery_profile\(\)[^{]*\{\s*(PUBLIC_CAMP_BATCH_CONTEXT_DELIVERY_PROFILE_V\d+)\.validate\(\)/u,
    'Current Public Camp Context Delivery Profile symbol')

  const fields = {
    releaseBuildIdentity: available({
      packageVersion: packageMetadata.version,
      cargoWorkspaceVersion: cargoVersion,
      sourceStateDigest: sha256(gitStatus)
    }, sourceAuthority([source.package, source.cargo])),
    gitCommit: available(gitCommit, { kind: 'git_object_id' }),
    coreExecutableDigest: coreDigest
      ? available(coreDigest, { kind: 'executable_sha256' })
      : unavailable('product.core_executable_not_supplied'),
    dataContractVersion: available(
      capture(source.dataContract.contents, /CURRENT_DATA_CONTRACT_VERSION:\s*&str\s*=\s*"([^"]+)"/u, 'Data Contract version'),
      constantAuthority(source.dataContract, 'CURRENT_DATA_CONTRACT_VERSION')
    ),
    dataContractSchemaVersion: available(
      Number.parseInt(capture(source.dataContract.contents, /CURRENT_PROJECTION_SCHEMA_VERSION:\s*i64\s*=\s*(\d+)/u, 'Data Contract schema version'), 10),
      constantAuthority(source.dataContract, 'CURRENT_PROJECTION_SCHEMA_VERSION')
    ),
    campSnapshotSchemaVersion: available(
      Number.parseInt(capture(source.readModel.contents, /READ_MODEL_SCHEMA_VERSION:\s*i64\s*=\s*(\d+)/u, 'CampSnapshot schema version'), 10),
      constantAuthority(source.readModel, 'READ_MODEL_SCHEMA_VERSION')
    ),
    contextManifestVersion: available(
      Number.parseInt(capture(source.contextContract.contents, /PUBLIC_CAMP_BATCH_CONTEXT_MANIFEST_VERSION:\s*i64\s*=\s*(\d+)/u, 'Public Camp ContextManifest version'), 10),
      constantAuthority(source.contextContract, 'PUBLIC_CAMP_BATCH_CONTEXT_MANIFEST_VERSION')
    ),
    contextFormatterVersion: available(
      Number.parseInt(capture(source.contextContract.contents, /PUBLIC_CAMP_BATCH_CONTEXT_FORMATTER_VERSION:\s*i64\s*=\s*(\d+)/u, 'Public Camp Context Formatter version'), 10),
      constantAuthority(source.contextContract, 'PUBLIC_CAMP_BATCH_CONTEXT_FORMATTER_VERSION')
    ),
    contextDeliveryProfileVersion: available(
      Number.parseInt(capture(source.contextDelivery.contents, new RegExp(`${deliveryProfileSymbol}:[\\s\\S]*?profile_version:\\s*(\\d+)`, 'u'), 'Context Delivery Profile version'), 10),
      constantAuthority(source.contextDelivery, deliveryProfileSymbol)
    ),
    durableTaskContract: available({
      version: Number.parseInt(capture(source.taskContract.contents, /DURABLE_TASK_CONTRACT_VERSION:\s*u32\s*=\s*(\d+)/u, 'Durable Task contract version'), 10),
      sourceDigest: digestSources([source.taskContract, source.dataContract])
    }, constantAuthority(source.taskContract, 'DURABLE_TASK_CONTRACT_VERSION')),
    builtInTransportVersion: available(
      Number.parseInt(capture(source.builtinTransport.contents, /BUILTIN_TOOL_CONTRACT_VERSION:\s*u32\s*=\s*(\d+)/u, 'Built-in Transport version'), 10),
      constantAuthority(source.builtinTransport, 'BUILTIN_TOOL_CONTRACT_VERSION')
    ),
    acceptedInputAckContract: available({
      semanticClass: 'accepted_input_only',
      sourceDigest: source.acceptedAck.digest
    }, {
      kind: 'verified_source_contract',
      locator: source.acceptedAck.locator,
      evidenceSymbol: 'acknowledge_input_delivery'
    })
  }
  const fingerprintDigest = digestJson(fields)
  return { fingerprintDigest, ...fields }
}

export function sanitizeCoreHealth(payload) {
  const core = payload?.payload?.core ?? payload?.core ?? null
  if (!core || typeof core !== 'object') return null
  return {
    version: typeof core.version === 'string' ? core.version : null,
    readModelSchema: Number.isInteger(core.readModelSchema) ? core.readModelSchema : null,
    builtinToolContractVersion: Number.isInteger(core.builtinToolContractVersion)
      ? core.builtinToolContractVersion
      : null,
  }
}

async function readSources(root) {
  return Object.fromEntries(await Promise.all(Object.entries(SOURCES).map(async ([key, locator]) => {
    const contents = await readFile(resolve(root, locator), 'utf8')
    return [key, { locator, contents, digest: sha256(contents) }]
  })))
}

async function digestExecutable(path) {
  const metadata = await stat(path)
  if (!metadata.isFile()) throw new Error('Core executable is not a regular file')
  return sha256(await readFile(path))
}

function capture(contents, pattern, label) {
  const match = pattern.exec(contents)
  if (!match) throw new Error(`authoritative ${label} was not found in code`)
  return match[1]
}

function available(value, authority) {
  return { status: 'available', value, authority }
}

function unavailable(code, attempted = undefined) {
  return attempted
    ? { status: 'unavailable', reason: { code }, attempted }
    : { status: 'unavailable', reason: { code } }
}

function constantAuthority(source, symbol) {
  return { kind: 'code_constant', locator: source.locator, sourceDigest: source.digest, symbol }
}

function sourceAuthority(sources) {
  return {
    kind: 'build_metadata',
    locators: sources.map((entry) => entry.locator),
    sourceDigest: digestSources(sources)
  }
}

function digestSources(sources) {
  return digestJson(sources.map(({ locator, digest }) => ({ locator, digest })))
}

function runGit(cwd, args) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.once('error', rejectRun)
    child.once('close', (code) => {
      if (code !== 0) rejectRun(new Error(`git ${args[0]} failed: ${stderr.trim()}`))
      else resolveRun(stdout.trim())
    })
  })
}
