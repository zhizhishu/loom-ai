import { useCallback, useEffect, useRef, useState } from 'react'
import type { Team } from '@contracts'
import type { ThreadClient } from './camp-client'
import { readErrorMessage } from './error-message'

/** One authoritative library; remote invalidations also refresh after reconnect. */
export function useTeams(client: ThreadClient, enabled: boolean) {
  const [teams, setTeams] = useState<Team[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const generation = useRef(0)
  const refresh = useCallback(async (): Promise<Team[]> => {
    const request = ++generation.current
    setLoading(true)
    try {
      const next = await client.request<Team[]>('teams.list')
      if (request === generation.current) { setTeams(next); setError(null); setLoading(false) }
      return next
    } catch (error) {
      if (request === generation.current) { setError(readErrorMessage(error)); setLoading(false) }
      throw error
    }
  }, [client])
  useEffect(() => {
    if (!enabled) return
    const reload = (): void => { void refresh().catch(() => undefined) }
    reload()
    const events = client.onEvent?.(event => { if (event.method === 'teams.changed') reload() })
    const invalidations = client.onInvalidated?.(change => {
      if (!change || change.resync || change.teamsChanged) reload()
    })
    return () => { generation.current++; events?.(); invalidations?.() }
  }, [client, enabled, refresh])
  return { teams, loading, error, refresh }
}
