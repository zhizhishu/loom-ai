import React, { act, useEffect, useState, type ReactNode } from 'react'
import type { Root } from 'react-dom/client'
import type { AgentProfile, Team, ThreadReadInvalidation } from '@contracts'
import { NewConversationDialog } from '../../../apps/desktop/src/renderer/src/NewConversationDialog'
import { ThreadClientProvider } from '../../../apps/desktop/src/renderer/src/camp-client'
import { TeamWorkspace } from '../../../apps/desktop/src/renderer/src/TeamWorkspace'
import { useTeams } from '../../../apps/desktop/src/renderer/src/useTeams'
import { DEFAULT_GENERAL_PREFERENCES } from '../../../apps/desktop/src/shared/general-preferences-model'
import { creationPreferences, withHostConversationPreferences } from '../../../apps/desktop/src/shared/host-general-preferences'

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const check = (actual: unknown, expected: unknown, label: string) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}
const find = (selector: string) => {
  const node = document.querySelector<HTMLElement>(selector)
  if (!node) throw new Error(`Missing ${selector}`)
  return node
}
const click = (selector: string) => act(async () => { find(selector).click() })
const type = (selector: string, value: string) => act(async () => {
  const input = find(selector)
  Object.getOwnPropertyDescriptor(input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

// Real React effects and production BusinessApp handoff. Promise resolution,
// not elapsed time, determines when save and teams.list reach the UI.
export async function runTeamCreationRegression(root: Root, app: ReactNode, client: any, agents: AgentProfile[], environment: any, events: Set<(event: any) => void>) {
  ;(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true
  const team: Team = { id: 'team-fixture', name: 'Team v1', memberAgentIds: agents.map(a => a.agentId), defaultLeadAgentId: agents[0].agentId, guidance: '', version: 1 }
  const saved = { ...team, name: 'Team v2', version: 2 }
  const save = deferred<any>(), list = deferred<Team[]>()
  let holdList = false, refreshes = 0
  const creations: any[] = []
  const teamWrites: any[] = []
  const request = client.request
  client.request = async (method: string, params: any) => {
    if (method === 'teams.list') { if (holdList) { refreshes++; return list.promise }; return [team] }
    if (method === 'teams.save') { teamWrites.push(params); return save.promise }
    if (method === 'threads.create') {
      creations.push(params)
      // Retain the dialog so the same draft can be submitted after list refresh.
      return { status: 'rejected', code: 'fixture.retry', payload: { message: 'Fixture retry' } }
    }
    return request(method, params)
  }
  await act(async () => { root.render(app) })
  await type('.team-editor-form input', saved.name)
  await click('.team-start-button')
  await click('[role="dialog"] .primary-button')
  holdList = true
  await act(async () => { save.resolve({ status: 'applied', code: 'team.saved', payload: { team: saved } }) })
  check(refreshes > 0, true, 'teams.list is still pending when dialog opens')
  await click('.new-camp-dialog .compact-primary')
  check(creations.at(-1)?.team, { teamId: team.id, expectedVersion: 2 }, 'saved receipt used before list refresh')
  check(find('.team-picker-trigger').textContent?.includes(saved.name), true, 'saved name displayed')
  await act(async () => { list.resolve([saved]) })
  await click('.new-camp-dialog .compact-primary')
  check(creations.length, 2, 'both create attempts were submitted')
  check(creations.at(-1)?.team, { teamId: team.id, expectedVersion: 2 }, 'retry uses saved version')

  const preflight = { admissible: true, blockers: [], initialLeadAgentId: agents[0].agentId,
    presentMembers: agents.map(a => ({ agentId: a.agentId, displayName: a.displayName, memberOrder: a.memberOrder, runtimeConfigured: true, runtimeReadiness: 'ready' as const })) }
  const submitted: any[] = []
  const common = { open: true, initialTeamId: team.id, initialWorkspace: null, agents, projects: [], preflight, busy: false, projectAccessReady: true,
    initialSelection: { memberAgentIds: [agents[0].agentId], defaultLeadAgentId: agents[0].agentId },
    onOpenChange() {}, onChooseWorkspaceDirectory: async () => null, onWorkspaceSelected: async () => {}, onCreate: async (draft: unknown) => { submitted.push(draft) } }
  function LateLibrary({ response }: { response: Promise<Team[]> }) {
    const [teams, setTeams] = useState<Team[]>([])
    useEffect(() => { void response.then(setTeams) }, [response])
    return <ThreadClientProvider client={client}><NewConversationDialog {...common} teams={teams}/></ThreadClientProvider>
  }
  const late = deferred<Team[]>()
  await act(async () => { root.render(<LateLibrary key="late" response={late.promise}/>) })
  check((find('.compact-primary') as HTMLButtonElement).disabled, true, 'unloaded team blocks creation')
  await click('.compact-text-button[aria-controls="new-camp-optional-panel"]')
  await type('#new-camp-name', 'Keep my name')
  await act(async () => { late.resolve([saved]) })
  await click('.compact-primary')
  check(submitted.at(-1)?.team, { teamId: team.id, expectedVersion: 2 }, 'late team completes initial selection')
  check(submitted.at(-1)?.name, 'Keep my name', 'late library preserves edited name')
  await act(async () => { root.render(<LateLibrary key="late" response={Promise.resolve([{ ...saved, version: 3 }])}/>) })
  await click('.compact-primary')
  check(submitted.length, 2, 'external refresh still allows a submission with the frozen version')
  check(submitted.at(-1)?.team, { teamId: team.id, expectedVersion: 2 }, 'external edits do not silently replace the selected snapshot')

  const switched = deferred<Team[]>()
  await act(async () => { root.render(<LateLibrary key="custom" response={switched.promise}/>) })
  await act(async () => { find('.team-picker-trigger').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
  await click('[role="menuitemradio"]') // Custom is first.
  await act(async () => { switched.resolve([saved]) })
  await click('.compact-primary')
  check(submitted.length, 3, 'Custom selection can submit after the late list')
  check(submitted.at(-1)?.team, undefined, 'late team does not replace an explicit Custom selection')
  check(submitted.at(-1)?.memberAgentIds, [agents[0].agentId], 'Custom roster is retained')

  // Discard may change the selected row, but must not retarget a pending action.
  const fallback = { ...team, id: 'team-B', name: 'Team B' }
  for (const action of ['conversation', 'duplicate']) for (const remaining of [[fallback], []]) {
    const opened: Team[] = []
    const writesBefore = teamWrites.length
    const renderWorkspace = (teams: Team[]) => <ThreadClientProvider client={client}><TeamWorkspace
      key={`${action}-${remaining.length}`} teams={teams} agents={agents} loading={false} loadError={null}
      defaultTeamId={null} customDefaults={null} refresh={async () => teams}
      onNewConversation={team => { opened.push(team) }} onLeaveGuardChange={() => {}}/></ThreadClientProvider>
    await act(async () => { root.render(renderWorkspace([team, fallback])) })
    await type('.team-editor-form input', 'Unsaved A')
    await act(async () => { root.render(renderWorkspace(remaining)) })
    if (action === 'conversation') await click('.team-start-button')
    else {
      await act(async () => { find('.team-overflow').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      await click('.team-crud-menu [role="menuitem"]')
    }
    await click('[role="dialog"] .quiet-button:nth-child(2)')
    check(opened.length, 0, 'deleted source does not start a conversation with a fallback team')
    check(teamWrites.length, writesBefore, 'deleted source does not duplicate a fallback team')
    check(find('[role="alert"]').textContent?.includes('重新选择'), true, 'cancelled action explains that the team must be selected again')
    if (remaining.length) check(find('.team-detail-header h1').textContent, fallback.name, 'list selection may still fall back to Team B')
  }
  await act(async () => { root.render(null) })
  client.request = request
  const availability = await runCreationAvailabilityRegression(root, app, client, agents, environment, events)
  await runTeamRefreshRegression(root, client, team)
  await runSavedTeamRegression(root, client, agents, team)
  await runGuidanceLimitRegression(root, client, agents, team)
  await act(async () => { root.unmount() })
  return { ok: true, cases: ['save receipt before teams.list', 'retry after list refresh', 'late initial team preserves draft', 'external edits preserve selected version', 'late list preserves Custom', 'deleted source cancels conversation and duplication with a fallback or empty library', ...availability, 'scoped Web invalidation, reconnect and request generation', 'saved version survives discard and list selection', 'guidance accepts 10000 Unicode scalars and rejects 10001 without truncation'] }
}

async function runGuidanceLimitRegression(root: Root, client: any, agents: AgentProfile[], team: Team) {
  const writes: any[] = []
  const scopedClient = { ...client, request: async (method: string, params: any) => {
    if (method !== 'teams.save') return client.request(method, params)
    writes.push(params.command)
    return { status: 'applied', payload: { team: { ...team, ...params.command, version: 2 } } }
  } }
  await act(async () => { root.render(<ThreadClientProvider client={scopedClient}><TeamWorkspace
    teams={[team]} agents={agents} loading={false} loadError={null} defaultTeamId={null} customDefaults={null}
    refresh={async () => [team]} onNewConversation={() => {}} onLeaveGuardChange={() => {}}/></ThreadClientProvider>) })
  await click('.team-guidance-toggle')
  for (const character of ['花', '🌸']) {
    const tooLong = character.repeat(10001)
    await type('.team-guidance-editor textarea', tooLong)
    check(find('.team-guidance-count').textContent, '10001 / 10000', 'Unicode count includes the over-limit character')
    await click('.team-editor-form button[type="submit"]')
    check(writes.length, 0, 'over-limit guidance never reaches Core')
    check((find('.team-guidance-editor textarea') as HTMLTextAreaElement).value, tooLong, 'over-limit draft is not truncated')
    check(find('[role="alert"]').textContent?.includes('10000'), true, 'error shows the new limit')
  }
  const guidance = '花🌸'.repeat(5000)
  await type('.team-guidance-editor textarea', guidance)
  check(find('.team-guidance-count').textContent, '10000 / 10000', 'emoji counts as one Unicode scalar')
  await click('.team-editor-form button[type="submit"]')
  check(writes.length, 1, '10000-character guidance can be saved')
  check(writes[0].guidance, guidance, 'complete guidance reaches the save request')
  check(find('.team-guidance-preview').textContent, guidance, 'save receipt retains complete guidance')
  await act(async () => { root.render(null) })
}

async function runTeamRefreshRegression(root: Root, client: any, team: Team) {
  const requests: ReturnType<typeof deferred<Team[]>>[] = []
  let invalidate!: (change?: ThreadReadInvalidation) => void
  let event!: (value: any) => void
  let library!: ReturnType<typeof useTeams>
  const scopedClient = { ...client,
    request: () => { const request = deferred<Team[]>(); requests.push(request); return request.promise },
    onInvalidated: (listener: typeof invalidate) => { invalidate = listener; return () => {} },
    onEvent: (listener: typeof event) => { event = listener; return () => {} }
  }
  function Library() { library = useTeams(scopedClient, true); return null }
  await act(async () => { root.render(<Library/>) })
  for (let sequence = 1; sequence <= 6; sequence++) {
    await act(async () => { invalidate({ messages: [{ threadId: 'other', indexChanged: false, throughGlobalSequence: sequence }] }) })
  }
  await act(async () => { invalidate({ tasksChanged: true }); invalidate({ notificationsChanged: true }); event({ method: 'run.output' }) })
  check(requests.length, 1, 'unrelated events do not supersede the pending Team read')
  await act(async () => { requests[0].resolve([team]) })
  check(library.loading, false, 'initial Team read settles during unrelated activity')
  await act(async () => { invalidate({ teamsChanged: true }) })
  check(requests.length, 2, 'Team changes refresh the library')
  check(library.loading, true, 'a scoped refresh retains its loading state')
  await act(async () => { invalidate({ resync: true }) })
  check(requests.length, 3, 'reconnect refreshes the library')
  await act(async () => { requests[1].resolve([team]) })
  check(library.loading, true, 'obsolete response cannot settle a newer refresh')
  const newer = { ...team, version: 2 }
  await act(async () => { requests[2].resolve([newer]) })
  check(library.teams, [newer], 'latest refresh wins')
  check(library.loading, false, 'latest refresh settles loading')
  await act(async () => { event({ method: 'teams.changed' }) })
  check(requests.length, 4, 'Desktop Team events still refresh')
  await act(async () => { requests[3].resolve([newer]); root.render(null) })
}

async function runSavedTeamRegression(root: Root, client: any, agents: AgentProfile[], team: Team) {
  const saved = { ...team, name: 'Saved v2', guidance: 'Saved guidance', version: 2 }
  for (const action of ['discard', 'list', 'conversation', 'duplicate']) {
    const receipt = deferred<any>(), list = deferred<Team[]>()
    const opened: Team[] = [], writes: any[] = []
    const localClient = { ...client, request: async (method: string, params: any) => {
      if (method !== 'teams.save') return client.request(method, params)
      writes.push(params.command)
      return writes.length === 1 ? receipt.promise : { status: 'applied', payload: { team: { ...saved, id: 'copy' } } }
    } }
    const render = (teams: Team[]) => <ThreadClientProvider client={localClient}><TeamWorkspace
      key={action} teams={teams} agents={agents} loading={false} loadError={null}
      defaultTeamId={null} customDefaults={null} refresh={() => list.promise}
      onNewConversation={value => opened.push(value)} onLeaveGuardChange={() => {}}/></ThreadClientProvider>
    await act(async () => { root.render(render([team])) })
    await type('.team-editor-form input', saved.name)
    await click('.team-editor-form button[type="submit"]')
    await act(async () => { receipt.resolve({ status: 'applied', payload: { team: saved } }) })
    await type('.team-editor-form input', 'Second unsaved draft')
    if (action === 'discard') await click('.member-editor-cancel')
    else {
      if (action === 'list') await click('.team-list-row')
      else if (action === 'conversation') await click('.team-start-button')
      else {
        await act(async () => { find('.team-overflow').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        await click('.team-crud-menu [role="menuitem"]')
      }
      await click('[role="dialog"] .quiet-button:nth-child(2)')
    }
    check((find('.team-editor-form input') as HTMLInputElement).value, saved.name, action + ' retains the confirmed version')
    if (action === 'conversation') check(opened, [saved], 'creation uses the saved snapshot')
    if (action === 'duplicate') check(writes[1].guidance, saved.guidance, 'duplication uses the saved guidance')
    else {
      check(document.querySelector('.team-roster-attention'), null, 'stale list is not an external modification')
      const newer = { ...saved, name: 'External v3', version: 3 }
      await act(async () => { root.render(render([newer])); list.resolve([newer]) })
      await click('.team-roster-attention button')
      check((find('.team-editor-form input') as HTMLInputElement).value, newer.name, 'explicit reload still accepts a newer version')
    }
    await act(async () => { root.render(null) })
  }
}

async function runCreationAvailabilityRegression(root: Root, app: ReactNode, client: any, agents: AgentProfile[], environment: any, events: Set<(event: any) => void>) {
  const request = client.request, general = environment.preferences.generalPreferences
  const initial = environment.navigationHistory.initial
  const cases: string[] = [], failures: string[] = []
  const custom = { memberAgentIds: [agents[0].agentId], defaultLeadAgentId: agents[0].agentId }
  const team: Team = { id: 'team-available', name: 'Available Team', ...custom, guidance: '', version: 2 }
  const run = async (label: string, body: () => Promise<void>) => {
    try { await body(); cases.push(label) }
    catch (error) { failures.push(`${label}: ${String(error)}`) }
    finally { await act(async () => { root.render(null) }); client.request = request }
  }
  const mount = async (oneClick: boolean, teamId: string | null, list: () => Promise<Team[]>, invalidations: ReturnType<typeof deferred<any>>[] = []) => {
    const preferences = { ...DEFAULT_GENERAL_PREFERENCES, newConversationDefaults: custom, newConversationTeamId: teamId, oneClickNewConversationEnabled: oneClick }
    const creations: any[] = []
    const local = new Proxy({}, { get: () => async () => preferences })
    environment.preferences.generalPreferences = withHostConversationPreferences(local as any, (method, params) => client.request(method, params))
    environment.navigationHistory.initial = { entries: [{ kind: 'quick_chat' }], index: 0 }
    client.request = async (method: string, params: any) => {
      if (method === 'teams.list') return list()
      if (method === 'preferences.newConversation.get') return creationPreferences(preferences)
      if (method === 'preferences.newConversation.invalidate') {
        const response = deferred<any>(); invalidations.push(response); return response.promise
      }
      if (method === 'threads.create') creations.push(params)
      return request(method, params)
    }
    await act(async () => { root.render(app) })
    return { creations, preferences }
  }
  try {
    for (const oneClick of [false, true]) for (const outcome of ['rejected', 'pending']) {
      await run(`Custom ${oneClick ? 'one-click' : 'dialog'} with ${outcome} teams.list`, async () => {
        const pending = deferred<Team[]>()
        const { creations } = await mount(oneClick, null, () => outcome === 'pending' ? pending.promise : Promise.reject(new Error('Team list unavailable')))
        await click('.rail-button[aria-label="新对话"]')
        if (!oneClick) {
          check(!!document.querySelector('.new-camp-dialog'), true, 'Custom dialog opens without waiting for teams.list')
          check(find(`.new-camp-dialog [role="${outcome === 'pending' ? 'status' : 'alert'}"]`).textContent?.includes(outcome === 'pending' ? '正在载入团队' : 'Team list unavailable'), true, 'optional list has its own loading or error feedback')
          await click('.new-camp-dialog .compact-primary')
        }
        check(creations.length, 1, 'Custom creation proceeds without teams.list')
        check(creations[0].team, undefined, 'Custom has no Team dependency')
        check(creations[0].memberAgentIds, custom.memberAgentIds, 'saved Custom roster is used')
      })
    }
    for (const oneClick of [false, true]) {
      await run(`selected Team ${oneClick ? 'one-click' : 'dialog'} failure requires explicit Custom`, async () => {
        const { creations } = await mount(oneClick, team.id, async () => { throw new Error('Team list unavailable') })
        await click('.rail-button[aria-label="新对话"]')
        check(creations.length, 0, 'Team failure never auto-creates Custom')
        check(!!document.querySelector('.new-camp-dialog'), true, 'failed Team can be changed explicitly')
        check((find('.new-camp-dialog .compact-primary') as HTMLButtonElement).disabled, true, 'missing selected Team cannot submit')
        check(find('.new-camp-dialog [role="alert"]').textContent?.includes('Team list unavailable'), true, 'list failure is shown in the dialog')
        await act(async () => { find('.team-picker-trigger').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
        await click('[role="menuitemradio"]')
        await click('.new-camp-dialog .compact-primary')
        check(creations.length, 1, 'explicit Custom can create after Team failure')
        check(creations[0].team, undefined, 'only explicit Custom omits the Team')
      })
    }
    await run('Team one-click waits for the fresh snapshot', async () => {
      const pending = deferred<Team[]>()
      let refresh = false
      const { creations } = await mount(true, team.id, async () => refresh ? pending.promise : [{ ...team, version: 1 }])
      refresh = true
      await click('.rail-button[aria-label="新对话"]')
      check(creations.length, 0, 'one-click Team waits for authoritative list')
      await act(async () => { pending.resolve([team]) })
      check(creations[0]?.team, { teamId: team.id, expectedVersion: 2 }, 'fresh Team version used')
    })
    await run('Team retry replaces a failed library without selecting its stale cache', async () => {
      let list = async () => [{ ...team, version: 1 }]
      const { creations } = await mount(false, team.id, () => list())
      list = async () => { throw new Error('Team list unavailable') }
      await click('.rail-button[aria-label="新对话"]')
      check((find('.new-camp-dialog .compact-primary') as HTMLButtonElement).disabled, true, 'failed refresh does not select cached Team v1')
      const retry = deferred<Team[]>()
      list = () => retry.promise
      await click('.new-camp-dialog [role="alert"] button')
      check(find('.new-camp-dialog [role="status"]').textContent?.includes('正在载入团队'), true, 'retry marks the library loading again')
      check((find('.new-camp-dialog .compact-primary') as HTMLButtonElement).disabled, true, 'pending retry still needs its selected Team')
      await act(async () => { retry.resolve([team]) })
      await click('.new-camp-dialog .compact-primary')
      check(creations[0]?.team, { teamId: team.id, expectedVersion: 2 }, 'retry selects the returned version')
    })
    await run('background refresh keeps the editor and leave confirmation usable', async () => {
      const pending = deferred<Team[]>()
      let refresh = false
      await mount(false, null, async () => refresh ? pending.promise : [team])
      await click('.rail-button[aria-label="团队"]')
      await type('.team-editor-form input', 'Unsaved team')
      const input = find('.team-editor-form input')
      refresh = true
      await act(async () => { events.forEach(fn => fn({ method: 'teams.changed', params: {} })) })
      await click('.rail-button[aria-label="队员"]')
      check(!!document.querySelector('[role="dialog"]'), true, 'leave confirmation opens during pending background refresh')
      check(find('.team-editor-form input') === input, true, 'background refresh keeps the same editor mounted')
      check((input as HTMLInputElement).value, 'Unsaved team', 'background refresh preserves the draft')
      check(find('.team-save-bar [role="status"]').textContent?.includes('正在载入团队'), true, 'refresh status is non-blocking')
      await click('[role="dialog"] .quiet-button')
      await type('.team-editor-form input', 'Still editable')
      await click('.rail-button[aria-label="队员"]')
      const dialog = find('[role="dialog"]')
      await act(async () => { pending.resolve([{ ...team, version: 3 }]) })
      check(find('[role="dialog"]') === dialog, true, 'completed refresh keeps the pending leave confirmation mounted')
      check((find('.team-editor-form input') as HTMLInputElement).value, 'Still editable', 'late list does not replace the draft')
      await click('[role="dialog"] .quiet-button:nth-child(2)')
      check(find('.rail-button[aria-label="队员"]').getAttribute('aria-current'), 'page', 'discard resolves the pending navigation')
    })
    await run('background refresh preserves an open delete confirmation', async () => {
      const pending = deferred<Team[]>()
      let refresh = false
      await mount(false, null, async () => refresh ? pending.promise : [team])
      await click('.rail-button[aria-label="团队"]')
      await act(async () => { find('.team-overflow').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })) })
      await click('.team-crud-menu [role="menuitem"]:last-child')
      const dialog = find('[role="dialog"]')
      refresh = true
      await act(async () => { events.forEach(fn => fn({ method: 'teams.changed', params: {} })) })
      check(document.querySelector('[role="dialog"]') === dialog, true, 'delete confirmation stays mounted during refresh')
      await click('[role="dialog"] .quiet-button')
      check(!!document.querySelector('[role="dialog"]'), false, 'delete can be cancelled before refresh completes')
      await act(async () => { pending.resolve([team]) })
    })
    await run('initial loading and a new unsaved team have distinct refresh states', async () => {
      const initialList = deferred<Team[]>(), refresh = deferred<Team[]>()
      let list = initialList.promise
      await mount(false, null, () => list)
      await click('.rail-button[aria-label="团队"]')
      check(!!document.querySelector('.team-first-workspace[role="status"]'), true, 'first load can use the full-page status')
      await act(async () => { initialList.resolve([]) })
      await click('.mcp-first-connection-actions button')
      await type('.team-editor-form input', 'First unsaved team')
      list = refresh.promise
      await act(async () => { events.forEach(fn => fn({ method: 'teams.changed', params: {} })) })
      check((find('.team-editor-form input') as HTMLInputElement).value, 'First unsaved team', 'empty library refresh preserves a new draft')
      await act(async () => { refresh.resolve([]) })
    })
    await run('unchanged invalidation receipt settles with a stale roster', async () => {
      const invalidations: ReturnType<typeof deferred<any>>[] = []
      const pending = deferred<Team[]>()
      let refresh = false
      const stale = { ...team, memberAgentIds: [...custom.memberAgentIds, 'missing-member'] }
      const { preferences } = await mount(true, team.id, async () => refresh ? pending.promise : [stale], invalidations)
      check(invalidations.length, 1, 'stale roster sends its first invalidation')
      await act(async () => { invalidations[0].resolve(creationPreferences(preferences)) })
      check(invalidations.length, 1, 'same-content Host receipt does not trigger another invalidation')
      refresh = true
      await act(async () => { events.forEach(fn => fn({ method: 'teams.changed', params: {} })) })
      check(invalidations.length, 1, 'pending refresh does not revalidate the stale roster')
      await act(async () => { pending.resolve([team]) })
      check(invalidations.length, 1, 'repaired roster remains valid')
      refresh = false
      await act(async () => { events.forEach(fn => fn({ method: 'teams.changed', params: {} })) })
      check(invalidations.length, 2, 'a new unavailable observation can invalidate again')
      preferences.newConversationDefaultsRequireConfirmation = true
      await act(async () => { invalidations[1].resolve(creationPreferences(preferences)) })
      await act(async () => { events.forEach(fn => fn({ method: 'teams.changed', params: {} })) })
      check(invalidations.length, 2, 'a changed confirmation receipt is applied')
    })
    for (const repaired of [false, true]) {
      await run(`in-flight invalidation rechecks only the latest ${repaired ? 'repaired' : 'unavailable'} observation`, async () => {
        const invalidations: ReturnType<typeof deferred<any>>[] = []
        const pending = deferred<Team[]>()
        const stale = { ...team, memberAgentIds: [...custom.memberAgentIds, 'missing-member'] }
        let list = Promise.resolve([stale])
        const { preferences } = await mount(true, team.id, () => list, invalidations)
        check(invalidations.length, 1, 'first invalidation is in flight')
        list = pending.promise
        await act(async () => { events.forEach(fn => fn({ method: 'teams.changed', params: {} })) })
        await act(async () => { pending.resolve([{ ...stale, version: 3 }]) })
        check(invalidations.length, 1, 'new unavailable observation arrives before the first receipt')
        if (repaired) {
          list = Promise.resolve([{ ...team, version: 4 }])
          await act(async () => { events.forEach(fn => fn({ method: 'teams.changed', params: {} })) })
        }
        await act(async () => { invalidations[0].resolve(creationPreferences(preferences)) })
        check(invalidations.length, repaired ? 1 : 2, 'only the latest still-invalid observation is processed after the no-op receipt')
        if (!repaired) {
          await act(async () => { invalidations[1].resolve(creationPreferences(preferences)) })
          check(invalidations.length, 2, 'second no-op receipt does not retry the same observation')
        }
      })
    }
  } finally {
    environment.preferences.generalPreferences = general
    environment.navigationHistory.initial = initial
  }
  if (failures.length) throw new Error(failures.join('\n'))
  return cases
}
