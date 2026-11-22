import type { AgentProfile, MemberRuntimeConfiguration, StoredCommandResult, WorkspaceSelection } from '@contracts'
import type { BusinessEnvironment } from '../business-environment'
import { hookReviewSnapshot, highRiskToConfirm, itemKey, pendingHookReview, sameSelection, selectionsOf, type HookReviewSnapshot } from '../member-catalog-model'
import { createAssistant, readAssistant, type AssistantIdentity } from './assistant-service'
import { createCapabilityPort } from './capability-service'
import { createRoom, emptyRoomDraft, roomPort } from './room-service'

export type AssistantSetupDraft = {
  identity: AssistantIdentity
  avatarRef: string | null
  runtime: MemberRuntimeConfiguration | null
  capabilityKeys: string[]
  workspace: WorkspaceSelection | null
  openConversation: boolean
}
export type AssistantSetupAttempt = {
  signature: string
  createCommandId: string
  runtimeCommandId: string
  roomCommandId: string
  agentId?: string
  runtimeEnvelope?: { agentId: string; expectedVersion: number; adapterKind: MemberRuntimeConfiguration['adapterKind']; model: MemberRuntimeConfiguration['model']; permissions: MemberRuntimeConfiguration['permissions']; piPurge?: MemberRuntimeConfiguration['piPurge'] }
  runtimeSaved?: boolean
  capabilitiesSaved?: boolean
  threadId?: string
}
export type AssistantSetupResult =
  | { status: 'review'; agent: AgentProfile; review: HookReviewSnapshot; names: string[] }
  | { status: 'complete'; agent: AgentProfile; threadId: string | null; warning: string | null }

export function setupSignature(draft: AssistantSetupDraft): string {
  return JSON.stringify({ ...draft, capabilityKeys: [...new Set(draft.capabilityKeys)].sort() })
}
export function newSetupAttempt(draft: AssistantSetupDraft): AssistantSetupAttempt {
  return { signature: setupSignature(draft), createCommandId: crypto.randomUUID(), runtimeCommandId: crypto.randomUUID(), roomCommandId: crypto.randomUUID() }
}
export function setupProblems(draft: AssistantSetupDraft, existingNames: readonly string[] = []): string[] {
  const issues: string[] = []
  if (!draft.identity.name.trim()) issues.push('给助手起一个名字。')
  if (draft.identity.name.length > 40) issues.push('助手名称不能超过40个字符。')
  if (existingNames.some(value => value.trim().toLocaleLowerCase() === draft.identity.name.trim().toLocaleLowerCase())) issues.push('这个名字已被使用，请换一个名字。')
  if (draft.runtime && draft.runtime.permissions.adapterKind !== draft.runtime.adapterKind) issues.push('权限配置与所选运行端不一致。')
  // Core refuses an Append Run without a persona body, and the wizard saves the whole
  // Runtime document in one command, so the draft stops here instead of failing later.
  const purge = draft.runtime?.piPurge ?? null
  if (purge?.mode === 'append' && !purge.persona.trim()) issues.push('追加人格（Append）需要填写助手设定。')
  if (!draft.runtime && draft.capabilityKeys.some(key => key.startsWith('hook:'))) issues.push('选择运行端之后才能确认 Hook 的执行范围。')
  return issues
}

/** Resumable setup over existing versioned commands. No model is started here.
 * Creation/runtime/room command ids are kept after unknown outcomes; the user
 * never gets a second assistant just because an HTTP response was lost. */
export async function finishAssistantSetup(environment: BusinessEnvironment, draft: AssistantSetupDraft,
  attempt: AssistantSetupAttempt, approvedReview?: HookReviewSnapshot | null,
  onProgress?: (attempt: AssistantSetupAttempt) => void): Promise<AssistantSetupResult> {
  if (attempt.signature !== setupSignature(draft)) throw new Error('这次创建已经提交过；请先完成原配置，再编辑助手，避免重复创建。')
  const issues = setupProblems(draft)
  if (issues.length) throw new Error(issues.join(' '))
  const client = environment.client
  let agent = attempt.agentId ? await readAssistant(client, attempt.agentId) : await createAssistant({ client, identity:draft.identity, avatarRef:draft.avatarRef, commandId:attempt.createCommandId })
  attempt.agentId = agent.agentId
  onProgress?.(attempt)
  if (draft.runtime && !attempt.runtimeSaved) {
    attempt.runtimeEnvelope ??= { agentId:agent.agentId, expectedVersion:agent.version, adapterKind:draft.runtime.adapterKind, model:structuredClone(draft.runtime.model), permissions:structuredClone(draft.runtime.permissions), ...(draft.runtime.adapterKind === 'pi' && draft.runtime.piPurge ? { piPurge:structuredClone(draft.runtime.piPurge) } : {}) }
    onProgress?.(attempt)
    const result = await client.request<StoredCommandResult>('members.runtime.set', { commandId:attempt.runtimeCommandId, command:attempt.runtimeEnvelope })
    if (!result || result.status !== 'applied') throw new Error(result?.code ? `运行配置未保存：${result.code}` : '运行配置结果尚未确认，重试将核对同一次请求。')
    attempt.runtimeSaved = true
    onProgress?.(attempt)
    agent = await readAssistant(client, agent.agentId)
  }
  if (!attempt.capabilitiesSaved) {
    const port = createCapabilityPort(client)
    const catalog = await port.read(agent.agentId)
    const selected = new Set(draft.capabilityKeys)
    const known = new Set(catalog.items.map(itemKey))
    const missing = [...selected].filter(key => !known.has(key))
    if (missing.length) throw new Error(`有${missing.length}项能力已改变或不可用；助手已保留，请在能力页重新确认。`)
    const items = catalog.items.map(item => ({ ...item, selected:item.kind === 'skill' && item.source === '工具箱' ? item.selected : selected.has(itemKey(item)) }))
    if (!sameSelection(items,catalog.items)) {
      const pending = pendingHookReview(items)
      const risky = highRiskToConfirm(items,catalog.items)
      if ((pending.length || risky.length) && !approvedReview) {
        const review = hookReviewSnapshot({ agentId:agent.agentId, revision:catalog.revision, token:Date.now(), acknowledgeHighRisk:true, selections:selectionsOf(items), pending })
        if (!review) throw new Error('Hook 完整正文和工作范围尚不可读。助手已保留，但没有授予该能力。')
        return { status:'review', agent, review, names:risky.map(item => item.name) }
      }
      await port.save(catalog,items,approvedReview)
    }
    attempt.capabilitiesSaved = true
    onProgress?.(attempt)
  }
  let warning: string | null = null
  if (draft.openConversation && !attempt.threadId) {
    const created = await createRoom(roomPort(environment), { ...emptyRoomDraft(), name:null, memberAgentIds:[agent.agentId], leadAgentId:agent.agentId, workspace:draft.workspace }, [agent], attempt.roomCommandId)
    attempt.threadId = created.threadId
    warning = created.registrationWarning
    onProgress?.(attempt)
  }
  return { status:'complete', agent:await readAssistant(client,agent.agentId), threadId:attempt.threadId ?? null, warning }
}
