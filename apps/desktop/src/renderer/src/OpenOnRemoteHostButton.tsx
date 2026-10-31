import { useEffect, useState } from 'react'
import type { RemoteHostApi, RemoteHostEntry } from '@contracts'
import { remoteHostMessage } from './RemoteHostsSettings'
import { UiText, uiAttribute } from './interface-language'
import './remote-connection.css'

/** What the button offers for a host list: nothing, one direct target, or a menu. */
export function remoteHostOffer(api: RemoteHostApi | null, hosts: readonly RemoteHostEntry[]):
  { kind: 'none' } | { kind: 'direct'; host: RemoteHostEntry } | { kind: 'menu'; hosts: readonly RemoteHostEntry[] } {
  if (!api || hosts.length === 0) return { kind: 'none' }
  return hosts.length === 1 ? { kind: 'direct', host: hosts[0] } : { kind: 'menu', hosts }
}

function remoteHostApi(): RemoteHostApi | null {
  return typeof window === 'undefined' ? null : window.rovai?.remoteHost ?? null
}

/**
 * Offered where a member's Runtime is unavailable on this computer: open a saved
 * remote Rovai Server instead, whose own Runtimes may cover it. Renders nothing
 * without the Desktop bridge (Web, standalone Server) or without saved hosts.
 * It only opens a stored entry by id; it never moves the Thread or its input.
 */
export function OpenOnRemoteHostButton({ api = remoteHostApi() }: { api?: RemoteHostApi | null }): React.JSX.Element | null {
  const [hosts, setHosts] = useState<RemoteHostEntry[]>([])
  const [menu, setMenu] = useState(false)
  const [error, setError] = useState('')
  const [opening, setOpening] = useState(false)

  useEffect(() => {
    if (!api) return
    let active = true
    void api.list().then(result => { if (active && result.ok) setHosts(result.value) }, () => undefined)
    return () => { active = false }
  }, [api])

  const offer = remoteHostOffer(api, hosts)
  if (offer.kind === 'none') return null

  async function open(id: string): Promise<void> {
    if (!api || opening) return
    setOpening(true); setError(''); setMenu(false)
    try {
      const result = await api.open({ id })
      if (!result.ok) setError(remoteHostMessage(result.code))
    } catch {
      setError(uiAttribute('无法在新窗口打开远端 Server，请重试。'))
    } finally { setOpening(false) }
  }

  const only = offer.kind === 'direct' ? offer.host : null
  return <span className="open-on-remote-host">
    <button
      type="button"
      className="quiet-button compact"
      disabled={opening}
      aria-haspopup={only ? undefined : 'menu'}
      aria-expanded={only ? undefined : menu}
      title={only ? uiAttribute('在远端主机「{0}」打开', only.label) : undefined}
      onClick={() => { if (only) void open(only.id); else setMenu(value => !value) }}
    >{opening ? <UiText zh={"正在打开…"} /> : <UiText zh={"在远端主机打开"} />}</button>
    {menu && !only && <span role="menu" className="open-on-remote-host-menu">
      {hosts.map(host => <button key={host.id} type="button" role="menuitem" className="quiet-button compact"
        onClick={() => void open(host.id)}>{host.label}</button>)}
    </span>}
    {error && <small className="remote-error" role="alert">{error}</small>}
  </span>
}
