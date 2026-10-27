import { useEffect, useRef, useState } from 'react'
import type { ReferenceCandidate, ReferencePage } from '@contracts'
import type { ThreadClient } from './camp-client'
import type { ComposerTriggerMatch } from './composer-trigger'
import type { StructuredMentionOption } from './StructuredMentionComposer'

export type ReferenceFilter = 'members' | 'thread' | 'mission'
export type ReferencePickerOption = StructuredMentionOption | { kind: 'reference'; item: ReferenceCandidate }
export interface ReferenceScope { threadId: string; client: Pick<ThreadClient, 'request' | 'onEvent' | 'onInvalidated'> }
interface Search {
  key: string; filter: ReferenceFilter; status: 'loading' | 'ready' | 'more' | 'error'
  items: ReferenceCandidate[]; nextCursor: string | null
}
const empty: Search = { key: '', filter: 'members', status: 'ready', items: [], nextCursor: null }

/** One query generation owns category selection and pages. Late responses never change a new @ invocation. */
export function useReferencePicker(scope: ReferenceScope | undefined, match: ComposerTriggerMatch | null,
  inviteLayer: boolean, members: readonly StructuredMentionOption[]) {
  const query = match?.kind === 'member' ? match.query : null
  const anchor = match?.kind === 'member' ? `${match.nodeKey}:${match.fromOffset}` : ''
  const [manual, setManual] = useState<{ anchor: string; filter: ReferenceFilter } | null>(null)
  const [search, setSearch] = useState<Search>(empty)
  const [retry, setRetry] = useState(0)
  const generation = useRef(0)
  const morePending = useRef(false)
  const manualFilter = manual?.anchor === anchor ? manual.filter : null
  const hasMembers = members.length > 0
  const key = JSON.stringify([scope?.threadId, anchor, query, manualFilter, inviteLayer, hasMembers, retry])
  const currentKey = useRef(key)
  currentKey.current = key
  useEffect(() => {
    const ticket = ++generation.current
    morePending.current = false
    if (!scope || query === null || inviteLayer) {
      setSearch(empty)
      if (query === null) setManual(null)
      return
    }
    const valid = () => generation.current === ticket && currentKey.current === key
    if (manualFilter === 'members' || !manualFilter && (!query.trim() || hasMembers)) {
      setSearch({ ...empty, key })
      return
    }
    setSearch(previous => ({ ...empty, filter: manualFilter ?? previous.filter, key, status: 'loading' }))
    const timer = setTimeout(() => {
      const page = (kind: 'thread' | 'mission') => scope.client.request<ReferencePage>('threadReferences.list', { threadId: scope.threadId, kind, query })
      const request = manualFilter ? page(manualFilter).then(result => ({ result, filter: manualFilter }))
        : Promise.all([page('thread'), page('mission')]).then(([threads, missions]) => threads.items.length
          ? { result: threads, filter: 'thread' as const }
          : missions.items.length ? { result: missions, filter: 'mission' as const }
            : { result: threads, filter: search.filter })
      void request.then(({ result, filter }) => {
        if (valid()) setSearch({ key, filter, status: 'ready', ...result })
      }).catch(() => { if (valid()) setSearch(previous => ({ ...previous, key, status: 'error' })) })
    }, query.trim() ? 160 : 0)
    return () => { clearTimeout(timer); generation.current++ }
    // Category resolution is an outcome of this query, not a new query dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope?.client, scope?.threadId, key])
  const enabled = !!scope && query !== null && !inviteLayer
  const loading = enabled && (search.key !== key || search.status === 'loading')
  const filter = inviteLayer ? 'members' : manualFilter ?? search.filter
  const options: readonly ReferencePickerOption[] = !enabled ? members : loading || search.status === 'error' ? []
    : filter === 'members' ? members : search.items.map(item => ({ kind: 'reference', item }))
  const more = async (): Promise<void> => {
    if (!scope || loading || morePending.current || !search.nextCursor || filter === 'members' || search.status !== 'ready') return
    const ticket = generation.current
    morePending.current = true
    setSearch(previous => ({ ...previous, status: 'more' }))
    try {
      const result = await scope.client.request<ReferencePage>('threadReferences.list', { threadId: scope.threadId, kind: filter, query, cursor: search.nextCursor })
      if (ticket !== generation.current || currentKey.current !== key) return
      setSearch(previous => ({ ...previous, status: 'ready', nextCursor: result.nextCursor,
        items: [...previous.items, ...result.items.filter(item => !previous.items.some(existing => existing.id === item.id))] }))
    } catch {
      if (ticket === generation.current && currentKey.current === key) setSearch(previous => ({ ...previous, status: 'ready' }))
    } finally { if (ticket === generation.current) morePending.current = false }
  }
  return { options, filter, loading, status: search.status, hasMore: !!search.nextCursor,
    selectFilter: (filter: ReferenceFilter) => setManual({ anchor, filter }), more,
    retry: () => setRetry(value => value + 1), query, key }
}
