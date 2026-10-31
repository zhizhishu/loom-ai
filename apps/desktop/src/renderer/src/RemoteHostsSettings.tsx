import { useEffect, useState } from 'react'
import type { RemoteHostApi, RemoteHostCode, RemoteHostEntry } from '@contracts'
import { REMOTE_HOST_LABEL_LIMIT, REMOTE_HOST_LIMIT } from '../../shared/remote-host'
import { SettingsPageHeader } from './SettingsPageHeader'
import { UiText, uiAttribute, useUiText } from './interface-language'
import './remote-connection.css'

/** One sentence per Main-process failure code; unknown codes fall back. */
function remoteHostMessage(code: RemoteHostCode): string {
  switch (code) {
    case 'remote_host_url_invalid':
      return uiAttribute('地址格式不正确，请填写完整的 http:// 或 https:// 地址。')
    case 'remote_host_url_protocol':
      return uiAttribute('只支持 http:// 或 https:// 地址。')
    case 'remote_host_url_credentials':
      return uiAttribute('地址里不能包含用户名或密码。')
    case 'remote_host_url_path':
      return uiAttribute('只填写 Server 根地址，不要带路径、查询参数或片段。')
    case 'remote_host_exists':
      return uiAttribute('这个地址已经添加过了。')
    case 'remote_host_limit':
      return uiAttribute('最多保存 {0} 个远端主机，请先移除一个。', REMOTE_HOST_LIMIT)
    case 'remote_host_not_found':
      return uiAttribute('这个远端主机已不在列表中，请重新读取。')
    case 'remote_host_forbidden':
      return uiAttribute('只能在 App 主窗口中管理远端主机。')
    case 'remote_host_unavailable':
      return uiAttribute('远端主机列表尚未就绪，请重新读取。')
    case 'remote_host_operation_invalid':
      return uiAttribute('不支持这个远端主机操作。')
    default:
      return uiAttribute('远端主机操作未能完成，请重试。')
  }
}

/**
 * Saved remote Rovai Servers. The list only holds names and origins; each entry
 * signs in through that Server's own login page in an isolated window, so this
 * page never asks for and never shows a token.
 */
export function RemoteHostsSettings({ api }: { api: RemoteHostApi }): React.JSX.Element {
  const t = useUiText()
  const [hosts, setHosts] = useState<RemoteHostEntry[] | null>(null)
  const [readError, setReadError] = useState('')
  const [reload, setReload] = useState(0)
  const [listError, setListError] = useState('')
  const [address, setAddress] = useState('')
  const [label, setLabel] = useState('')
  const [formError, setFormError] = useState('')
  const [adding, setAdding] = useState(false)
  const [removing, setRemoving] = useState<string | null>(null)
  const [opening, setOpening] = useState<string | null>(null)
  const busy = adding || removing !== null || opening !== null

  useEffect(() => {
    let active = true
    setHosts(null)
    setReadError('')
    void api.list().then((result) => {
      if (!active) return
      if (result.ok) {
        setHosts(result.value)
        return
      }
      setReadError(remoteHostMessage(result.code))
    }, () => {
      if (active) setReadError(uiAttribute('远端主机列表暂时无法读取，请重试。'))
    })
    return () => { active = false }
  }, [api, reload])

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    if (busy) return
    const draft = address.trim()
    if (!draft) {
      setFormError(uiAttribute('请填写远端 Server 地址。'))
      document.getElementById('remote-host-address')?.focus()
      return
    }
    setAdding(true)
    setFormError('')
    setListError('')
    try {
      const result = await api.add({ address: draft, label: label.trim() || undefined })
      if (!result.ok) {
        setFormError(remoteHostMessage(result.code))
        document.getElementById('remote-host-address')?.focus()
        return
      }
      setAddress('')
      setLabel('')
      setHosts(current => [...(current ?? []).filter(host => host.id !== result.value.id), result.value])
    } catch {
      // The add may have landed; re-read the list instead of repeating it.
      setFormError(uiAttribute('添加结果尚未确认，正在重新读取列表。'))
      setReload(value => value + 1)
    } finally {
      setAdding(false)
    }
  }

  async function remove(id: string): Promise<void> {
    if (busy) return
    setRemoving(id)
    setListError('')
    setFormError('')
    try {
      const result = await api.remove({ id })
      if (!result.ok) {
        setListError(remoteHostMessage(result.code))
        return
      }
      setHosts(result.value)
    } catch {
      setListError(uiAttribute('移除结果尚未确认，正在重新读取列表。'))
      setReload(value => value + 1)
    } finally {
      setRemoving(null)
    }
  }

  async function open(id: string): Promise<void> {
    if (busy) return
    setOpening(id)
    setListError('')
    setFormError('')
    try {
      const result = await api.open({ id })
      if (!result.ok) setListError(remoteHostMessage(result.code))
    } catch {
      setListError(uiAttribute('无法在新窗口打开远端 Server，请重试。'))
    } finally {
      setOpening(null)
    }
  }

  return <div className="general-settings remote-connection-page">
    <SettingsPageHeader
      eyebrow="Settings / Remote hosts"
      title={uiAttribute("远端主机")}
      description={uiAttribute("连接你在其他机器上部署的 Rovai Server。打开后在新窗口里用该 Server 的登录 Token 登录；Token 不会保存在本机列表里。")}
    />
    <div className="general-settings-body">
      <section className="general-settings-section remote-access-fields" aria-label={uiAttribute("已保存的远端主机")} aria-busy={hosts === null}>
        {hosts === null && !readError && <p className="remote-state" role="status"><UiText zh={"正在读取远端主机…"} /></p>}
        {readError && <div className="remote-field">
          <p className="remote-error" id="remote-host-list-error" role="alert">{readError}</p>
          <button type="button" className="quiet-button compact" onClick={() => setReload(value => value + 1)}><UiText zh={"重新读取"} /></button>
        </div>}
        {hosts?.length === 0 && <p className="remote-footnote" role="status"><UiText zh={"还没有添加远端主机。"} /></p>}
        {hosts && hosts.length > 0 && <div className="remote-addresses">
          {hosts.map(host => <div className="remote-connection-address" key={host.id} data-remote-host={host.id}>
            <div className="remote-copy"><strong>{host.label}</strong></div>
            <div className="remote-address-value"><code>{host.origin}</code></div>
            <div className="remote-address-actions">
              <button type="button" className="quiet-button compact" disabled={busy} onClick={() => void open(host.id)}>
                {opening === host.id ? <UiText zh={"正在打开…"} /> : <UiText zh={"打开"} />}
              </button>
              <button type="button" className="quiet-button compact danger-text" disabled={busy} onClick={() => void remove(host.id)}>
                {removing === host.id ? <UiText zh={"正在移除…"} /> : <UiText zh={"移除"} />}
              </button>
            </div>
          </div>)}
        </div>}
        {listError && <p className="remote-error" role="alert">{listError}</p>}
      </section>
      <section className="general-settings-section remote-access-fields" aria-label={uiAttribute("添加远端主机")}>
        <form className="remote-host-form" onSubmit={event => void submit(event)} aria-busy={adding}>
          <div className="remote-field">
            <label htmlFor="remote-host-address"><UiText zh={"地址"} /></label>
            <input id="remote-host-address" type="text" inputMode="url" autoComplete="off" spellCheck={false}
              placeholder="http://100.64.0.7:8767" value={address} disabled={adding}
              aria-invalid={formError ? true : undefined} aria-describedby="remote-host-address-note"
              onChange={(event) => { setAddress(event.target.value); setFormError('') }} />
          </div>
          <div className="remote-field">
            <label htmlFor="remote-host-label"><UiText zh={"名称（可选）"} /></label>
            <input id="remote-host-label" type="text" maxLength={REMOTE_HOST_LABEL_LIMIT} autoComplete="off"
              value={label} disabled={adding} onChange={event => setLabel(event.target.value)} />
          </div>
          <button type="submit" className="primary-button" disabled={busy || !address.trim()}>
            {adding ? <UiText zh={"正在添加…"} /> : <UiText zh={"添加"} />}
          </button>
        </form>
        <p id="remote-host-address-note" className="remote-footnote">
          {t('填写 http:// 或 https:// 开头的 Server 根地址，不要带路径、查询参数或片段。最多保存 {0} 个。', REMOTE_HOST_LIMIT)}
        </p>
        {formError && <p className="remote-error" id="remote-host-error" role="alert">{formError}</p>}
      </section>
    </div>
  </div>
}
