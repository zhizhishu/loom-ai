import { describe, expect, it, vi } from 'vitest'
import type {
  AdapterInstallation,
  ProductRuntimeAvailability,
  RuntimeDiscoveryObservation,
  RuntimeStatus
} from '@contracts'
import {
  createRuntimeSetupPort,
  ensureProductRuntime,
  openRuntimeModelCatalog,
  probeProductRuntime,
  PRODUCT_RUNTIME_KINDS,
  readRuntimeSetup,
  rescanRuntimeDiscovery,
  RuntimeSetupError,
  type RuntimeSetupRpc
} from './runtime-setup-service'

/** 全部为合成值：没有真实路径、真实账号或真实版本号。 */
const NOW = '2026-11-13T00:00:00.000Z'

function rpc(request: ReturnType<typeof vi.fn>): RuntimeSetupRpc {
  return { request } as unknown as RuntimeSetupRpc
}

function discovery(over: Partial<RuntimeDiscoveryObservation> = {}): RuntimeDiscoveryObservation {
  return {
    runtimeKind: 'codex-cli',
    discoveryStatus: 'found',
    executablePath: '/synthetic/bin/codex',
    source: 'inherited_path',
    reportedVersion: 'synthetic-1.0.0',
    executableFingerprint: 'sha256:synthetic',
    searchPathSource: 'inherited_path',
    entrypointKind: 'native_executable',
    candidateExtension: 'native',
    resolvedNativeTarget: true,
    versionProbeSucceeded: null,
    searchGeneration: 3,
    observedAt: NOW,
    diagnosticCode: null,
    ...over
  }
}

function availability(over: Partial<ProductRuntimeAvailability> = {}): ProductRuntimeAvailability {
  return {
    runtimeKind: 'codex-cli',
    status: 'found_uninspected',
    checking: false,
    discovery: discovery(),
    installationId: 'installation-synthetic',
    reportedVersion: 'synthetic-1.0.0',
    diagnosticCode: null,
    failure: null,
    ...over
  }
}

function installation(over: Partial<AdapterInstallation> = {}): AdapterInstallation {
  return {
    id: 'installation-synthetic',
    adapterKind: 'codex-cli',
    executablePath: '/synthetic/bin/codex',
    commandName: 'codex',
    installationClass: 'managed_default',
    source: 'inherited_path',
    authScope: 'synthetic-scope',
    enabled: true,
    generation: 1,
    pathState: 'valid',
    version: 1,
    referencedProfileCount: 0,
    snapshot: null,
    modelCatalog: { status: 'unavailable', observedAt: null, revalidateAfter: null, expiresAt: null },
    memberRuntimeDefaults: {
      adapterKind: 'codex-cli',
      model: { mode: 'runtime_default' },
      permissions: { adapterKind: 'codex-cli', schemaVersion: 1, values: {} }
    },
    lastProbeAttempt: null,
    relocationHistory: [],
    createdAt: NOW,
    updatedAt: NOW,
    ...over
  }
}

function status(over: Partial<RuntimeStatus> = {}): RuntimeStatus {
  return {
    hostPlatform: 'windows-x64',
    runtimeCatalog: [{ runtimeKind: 'codex-cli', displayName: 'Codex', commandName: 'codex' }],
    runtimePlatformAdmission: PRODUCT_RUNTIME_KINDS.map((runtimeKind) => ({
      runtimeKind,
      platform: 'windows-x64',
      status: 'qualified',
      reasonCode: null,
      evidenceRevision: null
    })),
    runtimeAvailability: [availability()],
    searchEnvironment: {
      generation: 3,
      createdAt: NOW,
      pathEntryCount: 4,
      shell: {
        status: 'captured',
        interactive: true,
        shellName: 'synthetic-shell',
        entryCount: 4,
        elapsedMillis: 12
      }
    },
    ...over
  }
}

/** 默认读取器：只在被测方法调用时回值，避免因调用顺序不同而错配。 */
function reader(overrides: {
  status?: unknown
  installations?: unknown
} = {}): ReturnType<typeof vi.fn> {
  return vi.fn(async (method: string) => {
    if (method === 'runtime.status.get') return Object.prototype.hasOwnProperty.call(overrides, 'status') ? overrides.status : status()
    if (method === 'runtime.installations.list') return Object.prototype.hasOwnProperty.call(overrides, 'installations') ? overrides.installations : [installation()]
    throw new Error(`unexpected method ${method}`)
  })
}

function cardOf(cards: Awaited<ReturnType<typeof readRuntimeSetup>>, runtimeKind: string): unknown {
  if (cards.status !== 'ready') throw new Error('expected ready')
  return cards.cards.find((card) => card.runtimeKind === runtimeKind)
}

describe('readRuntimeSetup', () => {
  it('reads only status and installations, never a probe or a scan', async () => {
    const request = reader()
    const read = await readRuntimeSetup(rpc(request))
    expect(read.status).toBe('ready')
    expect(request.mock.calls.map((call) => call[0]).sort()).toEqual([
      'runtime.installations.list',
      'runtime.status.get'
    ])
    for (const forbidden of ['runtime.product.check', 'runtime.product.ensure', 'runtime.discovery.rescan', 'runtime.modelCatalog.open']) {
      expect(request.mock.calls.map((call) => call[0])).not.toContain(forbidden)
    }
  })

  it('returns one card per product runtime in the fixed order', async () => {
    const read = await readRuntimeSetup(rpc(reader()))
    if (read.status !== 'ready') throw new Error('expected ready')
    expect(read.cards.map((card) => card.runtimeKind)).toEqual([...PRODUCT_RUNTIME_KINDS])
    expect(read.platform).toBe('windows-x64')
    expect(read.cards[0].displayName).toBe('Claude Code')
  })

  it('does not go green from a found path, an enabled install and defaults', async () => {
    const read = await readRuntimeSetup(rpc(reader()))
    const card = cardOf(read, 'codex-cli') as {
      setupState: string
      configured: boolean
      installation: { configured: boolean }
      authentication: { verified: boolean }
      versionSupport: string
      discovery: { executablePath: string | null }
      runEvidence: { available: boolean }
    }
    expect(card.discovery.executablePath).toBe('/synthetic/bin/codex')
    expect(card.installation.configured).toBe(true)
    expect(card.setupState).toBe('found_unverified')
    expect(card.setupState).not.toBe('verified')
    expect(card.authentication.verified).toBe(false)
    expect(card.versionSupport).toBe('unverified')
    // 本服务不读运行证据，也不编造。
    expect(card.runEvidence).toEqual({ available: false, reason: 'not_read_by_this_service' })
  })

  it('reports a check in flight as pending rather than a result', async () => {
    const read = await readRuntimeSetup(rpc(reader({
      status: status({ runtimeAvailability: [availability({ status: 'checking', checking: true })] })
    })))
    const card = cardOf(read, 'codex-cli') as { setupState: string, check: { progress: { kind: string } } }
    expect(card.setupState).toBe('check_pending')
    expect(card.check.progress).toEqual({ kind: 'pending', checking: true })
  })

  it('is verified only from a ready availability with a real probe attempt', async () => {
    const read = await readRuntimeSetup(rpc(reader({
      status: status({ runtimeAvailability: [availability({ status: 'ready', checking: false })] }),
      installations: [installation({
        modelCatalog: { status: 'fresh', observedAt: NOW, revalidateAfter: NOW, expiresAt: NOW },
        lastProbeAttempt: {
          id: 'attempt-synthetic',
          installationId: 'installation-synthetic',
          status: 'ready',
          failureClass: 'none',
          diagnosticCode: null,
          candidatePath: '/synthetic/bin/codex',
          executableFingerprint: 'sha256:synthetic',
          attemptedAt: NOW,
          retryAfter: null,
          failure: null
        }
      })]
    })))
    const card = cardOf(read, 'codex-cli') as {
      setupState: string
      versionSupport: string
      authentication: { verified: boolean }
      check: { progress: { kind: string }, lastSuccessfulProbeAt: string | null }
      modelCatalog: { cacheStatus: string }
    }
    expect(card.setupState).toBe('verified')
    expect(card.versionSupport).toBe('supported')
    expect(card.authentication.verified).toBe(true)
    expect(card.check.progress).toEqual({
      kind: 'attempted',
      status: 'ready',
      failureClass: 'none',
      diagnosticCode: null,
      attemptedAt: NOW
    })
    expect(card.check.lastSuccessfulProbeAt).toBe(NOW)
    expect(card.modelCatalog.cacheStatus).toBe('fresh')
  })

  it('surfaces authentication as its own fact, not as "not installed"', async () => {
    const read = await readRuntimeSetup(rpc(reader({
      status: status({
        runtimeAvailability: [availability({
          status: 'authentication_required',
          failure: {
            runtimeKind: 'codex-cli',
            origin: 'runtime',
            phase: 'authentication',
            code: 'synthetic_auth',
            summary: 'synthetic summary',
            detail: null,
            retryable: true
          }
        })]
      })
    })))
    const card = cardOf(read, 'codex-cli') as {
      setupState: string
      authentication: { required: boolean, verified: boolean }
      check: { failure: unknown }
    }
    expect(card.setupState).toBe('authentication_required')
    expect(card.authentication).toEqual({ required: true, verified: false, status: null })
    expect(card.check.failure).not.toBeNull()
  })

  it('reports an unknown Core status as a schema error, never as green or missing', async () => {
    const read = await readRuntimeSetup(rpc(reader({
      status: status({
        runtimeAvailability: [{ ...availability(), status: 'quantum_ready' } as unknown as ProductRuntimeAvailability]
      })
    })))
    expect(read).toEqual({
      status: 'error',
      code: 'local.runtime_status_schema_unsupported',
      message: expect.any(String)
    })
    expect(read).not.toHaveProperty('cards')
  })

  it('reports an unreadable status or installation list as an error, never as four missing cards', async () => {
    expect(await readRuntimeSetup(rpc(reader({ status: null })))).toMatchObject({
      status: 'error',
      code: 'local.runtime_status_unreadable'
    })
    expect(await readRuntimeSetup(rpc(reader({ installations: null })))).toMatchObject({
      status: 'error',
      code: 'local.runtime_installations_unreadable'
    })
  })

  it('keeps an unavailable-by-admission card out of green on any platform', async () => {
    const read = await readRuntimeSetup(rpc(reader({
      status: status({
        runtimeAvailability: [availability({ status: 'ready', checking: false })],
        runtimePlatformAdmission: PRODUCT_RUNTIME_KINDS.map((runtimeKind) => ({
          runtimeKind,
          platform: 'windows-x64',
          status: runtimeKind === 'codex-cli' ? 'not_qualified' : 'qualified',
          reasonCode: 'runtime_platform.qualification_evidence_missing',
          evidenceRevision: null
        }))
      })
    })))
    const card = cardOf(read, 'codex-cli') as { setupState: string, platformAdmission: { status: string } }
    expect(card.platformAdmission.status).toBe('not_qualified')
    expect(card.setupState).toBe('platform_unsupported')
  })
})

describe('explicit runtime actions', () => {
  it('rescans with the existing payload and reports rejection, not success', async () => {
    const accepted = vi.fn().mockResolvedValue(undefined)
    expect(await rescanRuntimeDiscovery(rpc(accepted))).toEqual({ status: 'ok', value: { requested: true } })
    expect(accepted).toHaveBeenCalledWith('runtime.discovery.rescan', { interactiveShell: true })

    const refused = vi.fn().mockRejectedValue(new Error('scan unavailable'))
    expect(await rescanRuntimeDiscovery(rpc(refused))).toEqual({
      status: 'rejected',
      code: '',
      message: 'scan unavailable'
    })
  })

  it('sends exactly { runtimeKind } to ensure and keeps scheduled=false as scheduled=false', async () => {
    const request = vi.fn().mockResolvedValue({ scheduled: false, runtimeKind: 'codex-cli' })
    const outcome = await ensureProductRuntime(rpc(request), 'codex-cli')
    expect(request).toHaveBeenCalledWith('runtime.product.ensure', { runtimeKind: 'codex-cli' })
    expect(outcome).toEqual({ status: 'ok', value: { scheduled: false, runtimeKind: 'codex-cli' } })
  })

  it('probes with exactly { runtimeKind } and rejects an unreadable result', async () => {
    const request = vi.fn().mockResolvedValue({
      scheduled: true,
      completed: true,
      ready: true,
      outcome: 'ready',
      status: 'ready',
      runtimeKind: 'pi'
    })
    const outcome = await probeProductRuntime(rpc(request), 'pi')
    expect(request).toHaveBeenCalledWith('runtime.product.check', { runtimeKind: 'pi' })
    expect(outcome.status).toBe('ok')

    const odd = vi.fn().mockResolvedValue({ ready: 'yes' })
    expect(await probeProductRuntime(rpc(odd), 'pi')).toMatchObject({
      status: 'rejected',
      code: 'local.runtime_status_schema_unsupported'
    })
  })

  it('refuses a runtime kind outside the four product kinds', async () => {
    const request = vi.fn()
    expect(await probeProductRuntime(rpc(request), 'opencode-cli' as never)).toMatchObject({
      status: 'rejected',
      code: 'local.runtime_kind_unsupported'
    })
    expect(request).not.toHaveBeenCalled()
  })

  it('opens the model catalog with the existing optional fields only', async () => {
    const request = vi.fn().mockResolvedValue({
      runtimeKind: 'codex-cli',
      cache: { status: 'fresh', observedAt: NOW, revalidateAfter: null, expiresAt: null },
      models: [],
      refreshStatus: 'not_required',
      diagnosticCode: null
    })
    await openRuntimeModelCatalog(rpc(request), 'codex-cli')
    expect(request).toHaveBeenCalledWith('runtime.modelCatalog.open', { runtimeKind: 'codex-cli' })

    request.mockClear()
    await openRuntimeModelCatalog(rpc(request), 'codex-cli', {
      waitForRefresh: true,
      target: { modelId: 'synthetic-model' }
    })
    // 非 DSH 不带 target：Core 明确拒绝。
    expect(request).toHaveBeenCalledWith('runtime.modelCatalog.open', {
      runtimeKind: 'codex-cli',
      waitForRefresh: true
    })

    request.mockClear()
    await openRuntimeModelCatalog(rpc(request), 'deepseek-harness', {
      target: { modelId: 'synthetic-model', dshSource: 'native' }
    })
    expect(request).toHaveBeenCalledWith('runtime.modelCatalog.open', {
      runtimeKind: 'deepseek-harness',
      modelId: 'synthetic-model',
      dshSource: 'native'
    })
  })

  it('rejects a catalog that belongs to another runtime', async () => {
    const request = vi.fn().mockResolvedValue({
      runtimeKind: 'pi',
      cache: { status: 'fresh', observedAt: NOW, revalidateAfter: null, expiresAt: null },
      models: [],
      refreshStatus: 'not_required',
      diagnosticCode: null
    })
    expect(await openRuntimeModelCatalog(rpc(request), 'codex-cli')).toMatchObject({
      status: 'rejected',
      code: 'local.runtime_model_catalog_mismatch'
    })
  })

  it('maps a thrown Core failure to a typed setup error', async () => {
    const request = vi.fn().mockRejectedValue(Object.assign(new Error('runtime busy'), { code: 'runtime_busy' }))
    const outcome = await probeProductRuntime(rpc(request), 'codex-cli')
    expect(outcome).toEqual({ status: 'rejected', code: 'runtime_busy', message: 'runtime busy' })
  })
})

describe('createRuntimeSetupPort', () => {
  it('binds reads and explicit actions to the same authenticated channel', async () => {
    const request = reader()
    const port = createRuntimeSetupPort(rpc(request))
    await port.read()
    await port.rescan()
    expect(request.mock.calls.map((call) => call[0])).toEqual([
      'runtime.status.get',
      'runtime.installations.list',
      'runtime.discovery.rescan'
    ])
  })

  it('exposes RuntimeSetupError for callers that need the code', () => {
    expect(new RuntimeSetupError('local.runtime_kind_unsupported', 'x').code).toBe('local.runtime_kind_unsupported')
  })
})
