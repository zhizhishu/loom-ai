import { describe, expect, it, vi } from 'vitest'
import type {
  AdapterInstallation,
  AgentProfile,
  MemberRuntimeConfiguration,
  StoredCommandResult
} from '@contracts'
import type { ThreadClient } from '../camp-client'
import {
  ASSISTANT_RUNTIME_KINDS,
  ASSISTANT_RUNTIME_REGISTRY,
  AssistantCreateRejected,
  assistantIdentityDraft,
  assistantIdentityOf,
  assistantRuntimeAvailabilityLabel,
  assistantRuntimeChoice,
  assistantRuntimePort,
  assistantRuntimeSetupDefaults,
  createAssistant,
  piPurgeNeedsFileGrant,
  readAssistantRuntimeOptions,
  saveAssistantIdentity,
  saveAssistantRuntime,
  withPiPurgeFileGrant,
  type AssistantRuntimeOption
} from './assistant-service'

const model = {
  id: 'claude-sonnet-4-6',
  displayName: 'Claude Sonnet 4.6',
  isDefault: true,
  hidden: false,
  deprecated: false,
  options: [{
    key: 'effort',
    label: 'Thinking intensity',
    valueType: 'enum' as const,
    values: [{ value: 'high', label: 'High' }],
    defaultValue: 'high',
    scope: 'run' as const
  }]
}

const permission = {
  key: 'permission_mode',
  label: 'Permission mode',
  description: '',
  valueType: 'enum' as const,
  choices: [
    { value: 'default', label: 'Default' },
    { value: 'plan', label: 'Plan' }
  ],
  recommendedValue: 'default',
  scope: 'run' as const,
  risk: 'elevated' as const,
  supported: true,
  required: true,
  unsupportedReason: null
}

const defaults: MemberRuntimeConfiguration = {
  adapterKind: 'claude-code-cli',
  model: { mode: 'runtime_default' },
  permissions: { adapterKind: 'claude-code-cli', schemaVersion: 1, values: { permission_mode: 'default' } }
}

function installation(overrides: Partial<AdapterInstallation> = {}): AdapterInstallation {
  return {
    id: 'installation-claude',
    adapterKind: 'claude-code-cli',
    executablePath: '/opt/homebrew/bin/claude',
    commandName: 'claude',
    installationClass: 'managed_default',
    source: 'known_location',
    authScope: 'default',
    enabled: true,
    generation: 1,
    pathState: 'valid',
    version: 2,
    referencedProfileCount: 1,
    permissionOptions: [permission],
    snapshot: {
      reportedVersion: '2.0.1',
      executableFingerprint: 'sha256:test',
      authenticationStatus: 'authenticated',
      probeStatus: 'ready',
      permissionSchemaVersion: 4,
      permissionSchemaDigest: 'sha256:permissions',
      capabilities: [],
      protocols: [],
      models: [model],
      permissionOptions: [permission],
      observedAt: '2026-11-20T00:00:00.000Z',
      lastAttemptedAt: '2026-11-20T00:00:00.000Z',
      lastSuccessfulProbeAt: '2026-11-20T00:00:00.000Z',
      staleAt: null,
      lastError: null,
      nativeSessionCompatibilityKey: null
    },
    modelCatalog: { status: 'fresh', observedAt: null, revalidateAfter: null, expiresAt: null },
    memberRuntimeDefaults: defaults,
    lastProbeAttempt: null,
    relocationHistory: [],
    createdAt: '2026-11-20T00:00:00.000Z',
    updatedAt: '2026-11-20T00:00:00.000Z',
    ...overrides
  }
}

const profile: AgentProfile = {
  agentId: 'agent_1',
  displayName: '沐瓦',
  avatarRef: 'rovai://member-avatar/builtin/luoke/v1',
  accent: null,
  teamRole: '开发者',
  professionalResponsibilities: '交付实现',
  personalityTraits: ['严谨'],
  workingPrinciples: '先验证再交付',
  growthTopic: '沟通',
  defaultCapabilities: [],
  presence: 'present',
  runtimeConfiguration: null,
  runtimeReadiness: { status: 'runtime_not_configured', blockers: [] },
  memberOrder: 0,
  version: 3,
  createdAt: '2026-11-20T00:00:00.000Z',
  updatedAt: '2026-11-20T00:00:00.000Z',
  removedAt: null
}

const applied = (payload: Record<string, unknown>): StoredCommandResult => ({
  commandId: 'command',
  commandType: 'members.update',
  status: 'applied',
  code: 'ok',
  payload,
  resultEntity: null,
  recordedAt: '2026-11-20T00:00:00.000Z'
})

function client(request: unknown): ThreadClient {
  return { request } as unknown as ThreadClient
}

describe('assistant Runtime registry', () => {
  it('lists Pi first as the built-in primary brain and still claims nothing about installation', () => {
    expect([...ASSISTANT_RUNTIME_KINDS]).toEqual(['pi', 'claude-code-cli', 'codex-cli', 'deepseek-harness'])
    for (const kind of ASSISTANT_RUNTIME_KINDS) {
      const port = ASSISTANT_RUNTIME_REGISTRY[kind]
      expect(port.kind).toBe(kind)
      expect(port.transport).toBe('native-cli')
      expect(Object.keys(port).sort()).toEqual(['builtinPrimary', 'embedded', 'kind', 'label', 'transport'])
      // 主助手默认大脑 is a placement fact for Pi only; it is never an install claim.
      expect(port.builtinPrimary).toBe(kind === 'pi')
    }
    expect(ASSISTANT_RUNTIME_REGISTRY.pi.embedded).toEqual({ transport: 'embedded-pi', availability: 'from-host' })
    expect(ASSISTANT_RUNTIME_REGISTRY['codex-cli'].embedded).toBeNull()
  })

  it('returns null for any Runtime outside the registry', () => {
    expect(assistantRuntimePort('kimi-code-cli')).toBeNull()
    expect(assistantRuntimePort('pi')).toBe(ASSISTANT_RUNTIME_REGISTRY.pi)
  })
})

describe('assistant Runtime catalogue', () => {
  it('reads the Host installation list and keeps the real installation on the option', async () => {
    const request = vi.fn(async () => [installation()])
    const options = await readAssistantRuntimeOptions(client(request))
    expect(request).toHaveBeenCalledWith('runtime.installations.list')
    expect(options.map(option => option.kind)).toEqual([...ASSISTANT_RUNTIME_KINDS])
    // Pi is listed first because it is the built-in primary brain, not because it is installed.
    expect(options[0]!.kind).toBe('pi')
    expect(options[0]!.usable).toBe(false)
    const claude = options.find(option => option.kind === 'claude-code-cli')!
    expect(claude.installation?.id).toBe('installation-claude')
    expect(claude.usable).toBe(true)
    expect(claude.models).toEqual([model])
    expect(claude.permissionOptions).toEqual([permission])
    expect(claude.permissionSchemaVersion).toBe(4)
    expect(claude.defaults).toEqual(defaults)
  })

  it('marks every Runtime unusable when no installation exists', async () => {
    const options = await readAssistantRuntimeOptions(client(vi.fn(async () => [])))
    for (const option of options) {
      expect(option.usable).toBe(false)
      expect(option.installation).toBeNull()
      expect(option.models).toEqual([])
      expect(option.permissionOptions).toEqual([])
      expect(option.defaults).toBeNull()
      expect(option.permissionSchemaVersion).toBeNull()
    }
  })

  it('does not treat a custom-scope install, a disabled install or foreign defaults as usable', async () => {
    // The catalogue lists Pi first (built-in primary assistant), so the Runtime under
    // test is looked up by kind: an index would silently assert against Pi instead.
    const claudeOf = (rows: AssistantRuntimeOption[]) => rows.find(row => row.kind === 'claude-code-cli')!
    const custom = claudeOf(await readAssistantRuntimeOptions(client(vi.fn(async () => [
      installation({ id: 'custom', installationClass: 'custom' })
    ]))))
    expect(custom.installation).toBeNull()
    expect(custom.usable).toBe(false)

    const disabled = claudeOf(await readAssistantRuntimeOptions(client(vi.fn(async () => [
      installation({ id: 'disabled', enabled: false })
    ]))))
    expect(disabled.installation?.id).toBe('disabled')
    expect(disabled.usable).toBe(false)

    const foreign = claudeOf(await readAssistantRuntimeOptions(client(vi.fn(async () => [
      installation({
        id: 'foreign-defaults',
        memberRuntimeDefaults: {
          ...defaults,
          adapterKind: 'codex-cli',
          permissions: { ...defaults.permissions, adapterKind: 'codex-cli' }
        }
      })
    ]))))
    expect(foreign.installation?.id).toBe('foreign-defaults')
    expect(foreign.defaults).toBeNull()
    expect(foreign.usable).toBe(false)
  })

  it('fails instead of inventing a catalogue when the read returns nothing usable', async () => {
    await expect(readAssistantRuntimeOptions(client(vi.fn(async () => null)))).rejects.toThrow('智能体安装列表')
  })

  it('names Pi as the built-in primary brain in every installation state', async () => {
    const piDefaults: MemberRuntimeConfiguration = {
      adapterKind: 'pi', model: { mode: 'runtime_default' },
      permissions: { adapterKind: 'pi', schemaVersion: 1, values: {} }
    }
    const installedPi = await readAssistantRuntimeOptions(client(vi.fn(async () => [
      installation({ adapterKind: 'pi', memberRuntimeDefaults: piDefaults })
    ])))
    const live = installedPi.find(option => option.kind === 'pi')!
    expect(live.usable).toBe(true)
    expect(assistantRuntimeAvailabilityLabel(live)).toBe('内置 · 主助手默认大脑 · 1 个可选模型')

    const noModels = await readAssistantRuntimeOptions(client(vi.fn(async () => [
      installation({
        adapterKind: 'pi',
        memberRuntimeDefaults: piDefaults,
        snapshot: { ...installation().snapshot!, models: [] }
      })
    ])))
    expect(assistantRuntimeAvailabilityLabel(noModels.find(option => option.kind === 'pi')!))
      .toBe('内置 · 主助手默认大脑 · 0 个可选模型 · 默认模型需运行验证')

    // A machine without Pi gets an instruction, not a grey row that never explains itself.
    const absent = await readAssistantRuntimeOptions(client(vi.fn(async () => [])))
    expect(assistantRuntimeAvailabilityLabel(absent.find(option => option.kind === 'pi')!))
      .toBe('内置主助手需要连接本机 Pi 运行环境')
    expect(assistantRuntimeAvailabilityLabel(absent.find(option => option.kind === 'claude-code-cli')!))
      .toBe('主机尚未发现')

    // Every other Runtime keeps its existing wording: found but not ready, then ready.
    const notReady = await readAssistantRuntimeOptions(client(vi.fn(async () => [
      installation({ enabled: false })
    ])))
    expect(assistantRuntimeAvailabilityLabel(notReady.find(option => option.kind === 'claude-code-cli')!))
      .toBe('需要检查配置')
    const ready = await readAssistantRuntimeOptions(client(vi.fn(async () => [installation()])))
    expect(assistantRuntimeAvailabilityLabel(ready.find(option => option.kind === 'claude-code-cli')!))
      .toBe('1 个可选模型')
  })
})

describe('assistant Runtime choice and save', () => {
  it('keeps the assistant own values when they already belong to that Runtime', () => {
    const configured: AgentProfile = {
      ...profile,
      runtimeConfiguration: {
        adapterKind: 'claude-code-cli',
        model: { mode: 'explicit', modelId: 'claude-sonnet-4-6', options: { effort: 'high' } },
        permissions: { adapterKind: 'claude-code-cli', schemaVersion: 1, values: { permission_mode: 'plan' } }
      }
    }
    expect(assistantRuntimeChoice(configured, 'claude-code-cli', installation())).toEqual({
      adapterKind: 'claude-code-cli',
      model: { mode: 'explicit', modelId: 'claude-sonnet-4-6', options: { effort: 'high' } },
      permissions: { adapterKind: 'claude-code-cli', schemaVersion: 4, values: { permission_mode: 'plan' } }
    })
  })

  it('uses the real installation defaults for a Runtime the assistant has never had', () => {
    expect(assistantRuntimeChoice(profile, 'claude-code-cli', installation())).toEqual({
      adapterKind: 'claude-code-cli',
      model: { mode: 'runtime_default' },
      permissions: { adapterKind: 'claude-code-cli', schemaVersion: 4, values: { permission_mode: 'default' } }
    })
  })

  it('returns null with no installation instead of substituting another Runtime', () => {
    expect(assistantRuntimeChoice(profile, 'codex-cli', null)).toBeNull()
    expect(assistantRuntimeChoice(profile, 'codex-cli', installation())).toBeNull()
  })

  it('submits the exact command envelope and returns the receipt version', async () => {
    const request = vi.fn(async () => applied({ version: 8 }))
    const choice = assistantRuntimeChoice(profile, 'claude-code-cli', installation())!
    const saved = await saveAssistantRuntime({ client: client(request), agent: profile, choice })
    expect(saved).toEqual({ version: 8 })
    const [method, params] = request.mock.calls[0] as unknown as [string, Record<string, unknown>]
    expect(method).toBe('members.runtime.set')
    expect(typeof params.commandId).toBe('string')
    expect(params.command).toEqual({
      agentId: 'agent_1',
      expectedVersion: 3,
      adapterKind: 'claude-code-cli',
      model: { mode: 'runtime_default' },
      permissions: { adapterKind: 'claude-code-cli', schemaVersion: 4, values: { permission_mode: 'default' } }
    })
  })

  it('persists Pi Purge as an independent per-assistant preference and refuses invalid input', async () => {
    const defaultsPi: MemberRuntimeConfiguration = {
      adapterKind: 'pi', model: { mode: 'runtime_default' },
      permissions: { adapterKind: 'pi', schemaVersion: 1, values: { loom_file_access: 'workspace_read_write' } }
    }
    const installedPi = installation({
      adapterKind: 'pi', memberRuntimeDefaults: defaultsPi,
      snapshot: { ...installation().snapshot!, permissionSchemaVersion: 1 }
    })
    const choice = assistantRuntimeChoice(profile, 'pi', installedPi)!
    expect(choice.piPurge).toEqual({ mode: 'off', persona: '' })
    const request = vi.fn(async () => applied({ version: 4 }))
    await saveAssistantRuntime({
      client: client(request), agent: profile,
      choice: { ...choice, piPurge: { mode: 'append', persona: 'Be concise and cite evidence.' } }
    })
    const command = (request.mock.calls[0] as unknown as [string, { command: Record<string, unknown> }])[1].command
    expect(command.piPurge).toEqual({ mode: 'append', persona: 'Be concise and cite evidence.' })
    expect(command.permissions).toEqual(defaultsPi.permissions)
    const reloaded = assistantRuntimeChoice({
      ...profile, runtimeConfiguration: { ...choice, piPurge: { mode: 'append', persona: 'Saved.' } }
    }, 'pi', installedPi)
    expect(reloaded?.piPurge).toEqual({ mode: 'append', persona: 'Saved.' })
    for (const invalid of [
      { mode: 'append' as const, persona: '' },
      { mode: 'append' as const, persona: 'x'.repeat(17 * 1024) },
    ]) {
      await expect(saveAssistantRuntime({
        client: client(request), agent: profile, choice: { ...choice, piPurge: invalid }
      })).rejects.toThrow('Pi Purge')
    }
    expect(request).toHaveBeenCalledTimes(1)

    // Core, not the renderer, decides whether the selected file policy can host Purge.
    // Surface its precise refusal without changing the user's draft or granting tools.
    const nativeDraft = {
      ...choice,
      permissions: { ...defaultsPi.permissions, values: {} },
      piPurge: { mode: 'append' as const, persona: 'Keep this draft.' }
    }
    const missingGrant = vi.fn(async () => ({
      ...applied({}), status: 'rejected', code: 'pi_purge_requires_file_grant'
    }))
    await expect(saveAssistantRuntime({
      client: client(missingGrant), agent: profile, choice: nativeDraft
    })).rejects.toThrow('设置助手的工作目录文件权限')
    expect(nativeDraft.permissions.values).toEqual({})
    expect(nativeDraft.piPurge.persona).toBe('Keep this draft.')
    expect(missingGrant).toHaveBeenCalledTimes(1)
  })

  it('surfaces a Core rejection and refuses an unconfirmed version', async () => {
    const rejected = vi.fn(async () => ({
      ...applied({}),
      status: 'rejected',
      code: 'runtime_permission_schema_mismatch'
    }))
    await expect(saveAssistantRuntime({
      client: client(rejected), agent: profile,
      choice: assistantRuntimeChoice(profile, 'claude-code-cli', installation())!
    })).rejects.toThrow('权限选项已变化')

    const stale = vi.fn(async () => applied({ version: 3 }))
    await expect(saveAssistantRuntime({
      client: client(stale), agent: profile,
      choice: assistantRuntimeChoice(profile, 'claude-code-cli', installation())!
    })).rejects.toThrow('无法确认最新版本')
  })
})

describe('Pi Purge file policy', () => {
  const piChoice = (
    values: Record<string, unknown>,
    mode: 'off' | 'append' = 'append'
  ): MemberRuntimeConfiguration => ({
    adapterKind: 'pi',
    model: { mode: 'runtime_default' },
    permissions: { adapterKind: 'pi', schemaVersion: 1, values },
    piPurge: { mode, persona: 'Be concise and cite evidence.' }
  })

  const piOption = (values: Record<string, unknown> | null): AssistantRuntimeOption => ({
    kind: 'pi',
    label: 'Pi',
    installation: null,
    usable: true,
    models: [],
    permissionOptions: [],
    permissionSchemaVersion: 1,
    defaults: values === null ? null : {
      adapterKind: 'pi',
      model: { mode: 'runtime_default' },
      permissions: { adapterKind: 'pi', schemaVersion: 1, values }
    }
  })

  it('warns exactly where Core answers pi_purge_requires_file_grant', () => {
    // Rows mirror the Core unit test agent_profile.rs:6447-6456.
    const rows: Array<[string, Record<string, unknown>, boolean]> = [
      ['read only', { loom_file_access: 'workspace_read_only' }, false],
      ['read write', { loom_file_access: 'workspace_read_write' }, false],
      ['read write object', { loom_file_access: { mode: 'workspace_read_write' } }, false],
      ['workflow', { loom_file_access: 'workspace_workflow' }, false],
      ['absent means native', {}, true],
      ['native', { loom_file_access: 'native' }, true],
      ['native object', { loom_file_access: { mode: 'native' } }, true],
      ['unknown mode', { loom_file_access: 'workspace' }, true],
      ['extra key is an error', { loom_file_access: { mode: 'workspace_read_write', tools: ['read'] } }, true]
    ]
    for (const [label, values, warns] of rows) {
      expect(`${label}:${piPurgeNeedsFileGrant(piChoice(values))}`).toBe(`${label}:${warns}`)
    }
  })

  it('never warns for Off, a missing Purge preference or another Runtime', () => {
    expect(piPurgeNeedsFileGrant(piChoice({}, 'off'))).toBe(false)
    expect(piPurgeNeedsFileGrant({ ...piChoice({}), piPurge: null })).toBe(false)
    const noPurge = piChoice({})
    delete noPurge.piPurge
    expect(piPurgeNeedsFileGrant(noPurge)).toBe(false)
    expect(piPurgeNeedsFileGrant(null)).toBe(false)
    expect(piPurgeNeedsFileGrant({
      ...piChoice({}),
      adapterKind: 'claude-code-cli',
      permissions: { adapterKind: 'claude-code-cli', schemaVersion: 1, values: {} }
    })).toBe(false)
  })

  it('raises only the file policy in one click and keeps the rest of the draft', () => {
    const draft = piChoice({ permission_mode: 'plan', loom_file_access: 'native' })
    const repaired = withPiPurgeFileGrant(draft)
    expect(repaired.permissions.values).toEqual({
      permission_mode: 'plan',
      loom_file_access: 'workspace_read_write'
    })
    expect(repaired.piPurge).toEqual(draft.piPurge)
    expect(repaired.model).toEqual(draft.model)
    expect(piPurgeNeedsFileGrant(repaired)).toBe(false)
    // The original draft is not mutated: Core's refusal still sees what the user chose.
    expect(draft.permissions.values.loom_file_access).toBe('native')
  })

  it('starts a new Pi assistant at workspace_read_write instead of an unchosen native policy', () => {
    const empty = assistantRuntimeSetupDefaults(piOption({}))!
    expect(empty.permissions.values).toEqual({ loom_file_access: 'workspace_read_write' })
    expect(empty.adapterKind).toBe('pi')
    expect(empty.model).toEqual({ mode: 'runtime_default' })

    const native = assistantRuntimeSetupDefaults(piOption({ loom_file_access: 'native' }))!
    expect(native.permissions.values).toEqual({ loom_file_access: 'workspace_read_write' })

    // A default the Host already guards is kept as reported, and other values survive.
    const readOnly = assistantRuntimeSetupDefaults(piOption({ loom_file_access: 'workspace_read_only', other: 1 }))!
    expect(readOnly.permissions.values).toEqual({ loom_file_access: 'workspace_read_only', other: 1 })

    // Nothing else is rewritten, and no default is invented.
    const claude = assistantRuntimeSetupDefaults({
      ...piOption({}),
      kind: 'claude-code-cli',
      defaults: {
        adapterKind: 'claude-code-cli',
        model: { mode: 'runtime_default' },
        permissions: { adapterKind: 'claude-code-cli', schemaVersion: 1, values: {} }
      }
    })!
    expect(claude.permissions.values).toEqual({})
    expect(assistantRuntimeSetupDefaults(piOption(null))).toBeNull()
  })
})

describe('assistant identity', () => {
  it('reads the four editable facts plus optional working principles', () => {
    expect(assistantIdentityOf(profile)).toEqual({
      name: '沐瓦',
      role: '开发者',
      purpose: '交付实现',
      style: ['严谨'],
      instructions: '先验证再交付'
    })
    expect(assistantIdentityOf({ ...profile, workingPrinciples: '' })).toEqual({
      name: '沐瓦',
      role: '开发者',
      purpose: '交付实现',
      style: ['严谨']
    })
  })

  it('keeps growth topic, working principles and the avatar when they are not patched', () => {
    const draft = assistantIdentityDraft(profile, { name: '沐瓦二', style: ['直接'] })
    expect(draft).toEqual({
      displayName: '沐瓦二',
      teamRole: '开发者',
      professionalResponsibilities: '交付实现',
      personalityTraits: ['直接'],
      workingPrinciples: '先验证再交付',
      growthTopic: '沟通'
    })
  })

  it('writes only members.update (no avatar or runtime command) and returns the read-back profile', async () => {
    const readBack: AgentProfile = { ...profile, displayName: '沐瓦二', version: 4 }
    const request = vi.fn(async (method: string) => (
      method === 'members.get' ? readBack : applied({ version: 4 })
    ))
    const saved = await saveAssistantIdentity({
      client: client(request), agent: profile, patch: { name: '沐瓦二' }
    })
    expect(saved).toBe(readBack)
    expect(request.mock.calls.map(([method]) => method)).toEqual(['members.update', 'members.get'])
    const params = (request.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
    expect(typeof params.commandId).toBe('string')
    expect(params.command).toEqual({
      displayName: '沐瓦二',
      teamRole: '开发者',
      professionalResponsibilities: '交付实现',
      personalityTraits: ['严谨'],
      workingPrinciples: '先验证再交付',
      growthTopic: '沟通',
      agentId: 'agent_1',
      expectedVersion: 3
    })
    expect(Object.hasOwn(params.command as object, 'avatarRef')).toBe(false)
  })

  it('lets instructions change working principles explicitly', async () => {
    const request = vi.fn(async (method: string) => (
      method === 'members.get' ? { ...profile, version: 4 } : applied({ version: 4 })
    ))
    await saveAssistantIdentity({ client: client(request), agent: profile, patch: { instructions: '先写测试' } })
    const params = (request.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
    expect((params.command as Record<string, unknown>).workingPrinciples).toBe('先写测试')
  })

  it('sends nothing when the patch is already persisted, and validates before transport', async () => {
    const idle = vi.fn(async () => applied({ version: 4 }))
    await expect(saveAssistantIdentity({
      client: client(idle), agent: profile, patch: { name: '沐瓦' }
    })).resolves.toBe(profile)
    expect(idle).not.toHaveBeenCalled()

    const tooLong = vi.fn(async () => applied({ version: 4 }))
    await expect(saveAssistantIdentity({
      client: client(tooLong), agent: profile, patch: { name: 'x'.repeat(81) }
    })).rejects.toThrow('名称必须为')
    expect(tooLong).not.toHaveBeenCalled()
  })

  it('reports a Core conflict instead of a lost receipt', async () => {
    const request = vi.fn(async () => ({ ...applied({}), status: 'rejected', code: 'agent_profile.version_conflict' }))
    await expect(saveAssistantIdentity({
      client: client(request), agent: profile, patch: { name: '沐瓦二' }
    })).rejects.toThrow('请重新载入后重试')
  })
})

describe('assistant creation', () => {
  it('creates only the profile envelope: no Runtime configuration and no model value', async () => {
    const readBack: AgentProfile = { ...profile, agentId: 'agent_new', displayName: '新人', version: 1 }
    const request = vi.fn(async (method: string) => (
      method === 'members.get'
        ? readBack
        : { ...applied({ agentId: 'agent_new', version: 1 }), resultEntity: { entityType: 'agent', entityId: 'agent_new' } }
    ))
    const created = await createAssistant({
      client: client(request),
      identity: { name: '新人', role: '评审', purpose: '把关质量', style: ['克制'] }
    })
    expect(created).toBe(readBack)
    expect(request.mock.calls.map(([method]) => method)).toEqual(['members.create', 'members.get'])
    const params = (request.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
    expect(typeof params.commandId).toBe('string')
    expect(params.command).toEqual({
      displayName: '新人',
      teamRole: '评审',
      professionalResponsibilities: '把关质量',
      personalityTraits: ['克制'],
      workingPrinciples: '',
      growthTopic: '',
      avatarRef: null
    })
    expect(JSON.stringify(params.command)).not.toMatch(/runtimeConfiguration|adapterKind|model|permissions/)
  })

  it('accepts an explicit avatar reference and reports a rejected create', async () => {
    const request = vi.fn(async (method: string) => (
      method === 'members.get' ? profile : applied({ agentId: 'agent_1', version: 1 })
    ))
    await createAssistant({
      client: client(request),
      identity: { name: '新人', role: '评审', purpose: '把关质量', style: [] },
      avatarRef: 'rovai://member-avatar/custom/1'
    })
    const create = (request.mock.calls[0] as unknown as [string, Record<string, unknown>])[1]
    expect((create.command as Record<string, unknown>).avatarRef).toBe('rovai://member-avatar/custom/1')

    const rejected = vi.fn(async () => ({ ...applied({}), status: 'rejected', code: 'agent_profile.display_name_conflict' }))
    await expect(createAssistant({
      client: client(rejected),
      identity: { name: '沐瓦', role: '评审', purpose: '把关质量', style: [] }
    })).rejects.toThrow('该名称已被其他助手使用')
  })

  it('types an explicit rejected create so the caller may unlock the form', async () => {
    const rejected = vi.fn(async () => ({ ...applied({}), status: 'rejected', code: 'agent_profile.display_name_conflict' }))
    const failure = await createAssistant({
      client: client(rejected),
      identity: { name: '沐瓦', role: '评审', purpose: '把关质量', style: [] },
      commandId: 'create-attempt-typed'
    }).then(() => null, (cause: unknown) => cause)
    if (!(failure instanceof AssistantCreateRejected)) throw new Error('expected AssistantCreateRejected')
    expect(failure.name).toBe('AssistantCreateRejected')
    expect(failure.code).toBe('agent_profile.display_name_conflict')
    expect(failure.result.code).toBe('agent_profile.display_name_conflict')
    expect(failure.message).toContain('该名称已被其他助手使用')
    // A rejection is final: Core did not create anything, so exactly one call.
    expect(rejected).toHaveBeenCalledTimes(1)
    expect((rejected.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].commandId).toBe('create-attempt-typed')
  })

  it('keeps a lost create receipt unknown so the same commandId is replayed', async () => {
    const lost = vi.fn(async () => null)
    const failure = await createAssistant({
      client: client(lost),
      identity: { name: '新人', role: '评审', purpose: '把关质量', style: [] },
      commandId: 'create-attempt-lost'
    }).then(() => null, (cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(AssistantCreateRejected)
    expect((failure as Error).message).toContain('创建结果暂时不可用')

    // The caller keeps the attempt: retrying reuses its id instead of minting a
    // new one, so Core replays the stored command rather than duplicating it.
    const retry = vi.fn(async (method: string) => (
      method === 'members.get'
        ? { ...profile, agentId: 'agent_1' }
        : { ...applied({ agentId: 'agent_1' }), resultEntity: { entityType: 'agent', entityId: 'agent_1' } }
    ))
    await createAssistant({
      client: client(retry),
      identity: { name: '新人', role: '评审', purpose: '把关质量', style: [] },
      commandId: 'create-attempt-lost'
    })
    expect((retry.mock.calls[0] as unknown as [string, Record<string, unknown>])[1].commandId).toBe('create-attempt-lost')
  })

  it('keeps create read-back failures unknown instead of a rejection', async () => {
    const unreadable = vi.fn(async (method: string) => (
      method === 'members.get'
        ? null
        : { ...applied({ agentId: 'agent_1' }), resultEntity: { entityType: 'agent', entityId: 'agent_1' } }
    ))
    const readBackFailure = await createAssistant({
      client: client(unreadable),
      identity: { name: '新人', role: '评审', purpose: '把关质量', style: [] }
    }).then(() => null, (cause: unknown) => cause)
    expect(readBackFailure).toBeInstanceOf(Error)
    expect(readBackFailure).not.toBeInstanceOf(AssistantCreateRejected)
    expect((readBackFailure as Error).message).toContain('助手信息暂时无法读回')

    const noIdentity = vi.fn(async () => applied({}))
    const identityFailure = await createAssistant({
      client: client(noIdentity),
      identity: { name: '新人', role: '评审', purpose: '把关质量', style: [] }
    }).then(() => null, (cause: unknown) => cause)
    expect(identityFailure).toBeInstanceOf(Error)
    expect(identityFailure).not.toBeInstanceOf(AssistantCreateRejected)
    expect((identityFailure as Error).message).toContain('助手已创建，但暂时无法读回')
  })

  it('leaves members.update rejections untyped: only create is distinguishable', async () => {
    const request = vi.fn(async () => ({ ...applied({}), status: 'rejected', code: 'agent_profile.display_name_conflict' }))
    const failure = await saveAssistantIdentity({
      client: client(request), agent: profile, patch: { name: '沐瓦二' }
    }).then(() => null, (cause: unknown) => cause)
    expect(failure).toBeInstanceOf(Error)
    expect(failure).not.toBeInstanceOf(AssistantCreateRejected)
    expect((failure as Error).message).toContain('该名称已被其他助手使用')
  })
})
