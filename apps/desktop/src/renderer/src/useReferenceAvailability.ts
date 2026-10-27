import { useEffect, useState } from 'react'
import type { ComposerDocument, CoreEvent, ReferenceCandidate, ReferenceIdentity } from '@contracts'
import type { ReferenceScope } from './useReferencePicker'
import { isReferenceAtom, referenceIdentity } from './thread-reference'

/** Only directory identity/label changes affect a saved reference. Runtime output does not. */
export function isReferenceDirectoryEvent(event: CoreEvent): boolean {
  const params = event.params && typeof event.params === 'object' ? event.params as Record<string, unknown> : {}
  if (event.method === 'missions.invalidated') return params.reason === 'missions.update' || params.reason === 'missions.updateWithAttachments' || params.reason === 'missions.agentUpdated'
  return event.method === 'navigation.invalidated' && ['camps.rename', 'camps.delete_accepted', 'camp.deleted'].includes(String(params.reason))
}

const EMPTY = new Map<string, ReferenceCandidate | null>()

export function composerReferenceIdentities(document: ComposerDocument): ReferenceIdentity[] {
  return [...new Map(document.segments.flatMap(segment => segment.kind === 'atom' && isReferenceAtom(segment.atom)
    ? [[referenceIdentity(segment.atom).id, referenceIdentity(segment.atom)] as const] : [])).values()]
}

export function useReferenceAvailability(scope: ReferenceScope | undefined, identities: ReferenceIdentity[]) {
  const key = JSON.stringify(identities)
  const [state, setState] = useState<{ scope: string; items: Map<string, ReferenceCandidate | null> }>({ scope: '', items: new Map() })
  useEffect(() => {
    if (!scope || !identities.length) return
    let cancelled = false, reading = false, dirty = false
    const refs = JSON.parse(key) as ReferenceIdentity[]
    let timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      if (cancelled) return
      if (reading) { dirty = true; return }
      reading = true
      const found = new Map<string, ReferenceCandidate | null>()
      try {
        for (let start = 0; start < refs.length; start += 128) {
          const batch = refs.slice(start, start + 128)
          const result = await scope.client.request<Array<ReferenceCandidate | null>>('threadReferences.resolve', { threadId: scope.threadId, references: batch })
          if (cancelled) return
          batch.forEach((ref, index) => found.set(ref.id, result[index] ?? null))
        }
        if (!cancelled) setState({ scope: scope.threadId, items: found })
      } catch { /* A transport failure does not declare a target deleted. Core validates publication. */ }
      finally {
        reading = false
        if (dirty && !cancelled) { dirty = false; refresh() }
      }
    }
    const refresh = () => {
      if (reading) { dirty = true; return }
      // Coalesce without postponing an existing deadline; at most one read is in flight.
      if (timer !== undefined) return
      timer = setTimeout(() => { timer = undefined; void read() }, 150)
    }
    const stopEvent = scope.client.onEvent?.(event => {
      if (!isReferenceDirectoryEvent(event)) return
      const { threadId } = event.params as { threadId?: string }
      if (threadId && !refs.some(ref => ref.kind === 'mission' || ref.id === threadId)) return
      if (event.method === 'missions.invalidated' && !refs.some(ref => ref.kind === 'mission')) return
      refresh()
    })
    const stopInvalidated = scope.client.onInvalidated?.(change => {
      if (!change || change.resync || change.referencesChanged) refresh()
    })
    void read()
    return () => { cancelled = true; clearTimeout(timer); stopEvent?.(); stopInvalidated?.() }
  }, [scope?.threadId, scope?.client, key])
  return state.scope === scope?.threadId ? state.items : EMPTY
}
