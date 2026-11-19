import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ThreadClient } from '../camp-client'
import { createMcpPort, type McpConnectionRead, type McpConnectionsRead, type McpFieldEntry, type McpWriteOutcome } from './mcp-service'
import { ChoiceMenu, FormMessage, SurfaceDialog } from './Controls'
import { Icon, IconButton } from './icons'

function outcomeError(value: McpWriteOutcome): string | null {
  if (value.status === 'applied') return null
  if (value.status === 'conflict') return '连接配置已经改变，请重新读取后再保存。输入内容仍保留。'
  if (value.status === 'risk_acknowledgement_required') return '这条连接需要确认风险后才能启用。'
  return value.issues.map(issue => issue.message).join('；') || '连接定义未被接受，请检查填写内容。'
}

export function McpConnections({ client, theme, onChanged, onDirty }: {
  client: ThreadClient; theme: 'day' | 'night'; onChanged(): void; onDirty?(value: boolean): void
}) {
  const port = useMemo(() => createMcpPort(client), [client])
  const [read, setRead] = useState<McpConnectionsRead | null>(null)
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [transport, setTransport] = useState<'stdio' | 'http'>('http')
  const [endpoint, setEndpoint] = useState('')
  const [args, setArgs] = useState('')
  const [pairs, setPairs] = useState<McpFieldEntry[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [risk, setRisk] = useState<McpConnectionRead | null>(null)
  const dirty = creating && Boolean(name || endpoint || args || pairs.some(pair => pair.key || pair.value))
  useEffect(() => { onDirty?.(dirty); return () => onDirty?.(false) }, [dirty, onDirty])
  const load = useCallback(async () => {
    const value = await port.read(); setRead(value)
  }, [port])
  useEffect(() => { let mounted = true; void port.read().then(value => { if (mounted) setRead(value) }); return () => { mounted = false } }, [port])
  const create = async () => {
    if (busy || read?.status !== 'ready') return
    setBusy(true); setError(''); setNotice('')
    try {
      const fields = transport === 'http'
        ? { transport: 'http' as const, name, url: endpoint, headers: pairs.filter(pair => pair.key || pair.value) }
        : { transport: 'stdio' as const, name, command: endpoint, args: args ? args.split('\n') : [], env: pairs.filter(pair => pair.key || pair.value) }
      const result = await port.create(fields, read.configDigest)
      const failure = outcomeError(result)
      if (failure) { setError(failure); return }
      setName(''); setEndpoint(''); setArgs(''); setPairs([]); setCreating(false)
      setNotice('连接已保存，默认停用且未分配。启用后，再到助手的能力页选择。')
      await load(); onChanged()
    } catch (cause) { setError(cause instanceof Error ? cause.message : '保存未完成，内容仍保留。') }
    finally { setBusy(false) }
  }
  const enable = async (connection: McpConnectionRead, acknowledgeHighRisk = false) => {
    if (busy || read?.status !== 'ready') return
    setBusy(true); setError(''); setNotice('')
    try {
      const result = await port.setEnabled({ serverId: connection.serverId, expectedConfigDigest: read.configDigest, enabled: !connection.enabled, acknowledgeHighRisk })
      const failure = outcomeError(result)
      if (failure) { setError(failure); return }
      setRisk(null); await load(); onChanged()
      setNotice(connection.enabled ? '连接已停用。正在执行的操作以运行时撤权结果为准。' : '连接已启用。实际连接状态以助手运行时回执为准。')
    } catch (cause) { setError(cause instanceof Error ? cause.message : '修改未完成。') }
    finally { setBusy(false) }
  }
  return <section className="ln-mcp-connections" aria-label="MCP 连接管理">
    <div className="ln-panel-title"><div><h3>工具连接</h3><small>保存在当前主机，不向浏览器回传已保存的密钥。</small></div><button type="button" className="ln-action" disabled={busy || creating || read?.status !== 'ready'} onClick={() => { setCreating(true); setError(''); setNotice('') }}><Icon name="plus" size={14}/>添加 MCP</button></div>
    {error && <FormMessage error>{error}</FormMessage>}{notice && <FormMessage>{notice}</FormMessage>}
    {!read ? <p className="ln-inspector-empty">正在读取连接…</p> : read.status === 'error' ? <><FormMessage error>{read.message}</FormMessage><button type="button" className="ln-action" onClick={() => { void load() }}>重新读取</button></> : <>
      {read.fileIssue && <FormMessage error>{read.fileIssue.message}</FormMessage>}
      {read.permissionIssue && <FormMessage error>当前主机的连接配置文件权限不满足要求。没有自动放宽权限。</FormMessage>}
      {creating && <form className="ln-native-create" onSubmit={event => { event.preventDefault(); void create() }}>
        <label className="ln-field"><span>连接名称</span><input value={name} onChange={event => setName(event.target.value)} disabled={busy} maxLength={120} autoComplete="off" aria-label="MCP 连接名称" placeholder="例如：设计文件、Git 服务"/></label>
        <label className="ln-field"><span>连接方式</span><ChoiceMenu theme={theme} label="MCP 连接方式" value={transport} disabled={busy} choices={[{ value:'http',label:'HTTP 服务',description:'连接一个已部署的 MCP 服务' },{ value:'stdio',label:'本机程序',description:'由运行端启动指定程序' }]} onChange={value => { setTransport(value as 'http' | 'stdio'); setPairs([]) }}/></label>
        <label className="ln-field"><span>{transport === 'http' ? '服务地址' : '程序路径或命令'}</span><input value={endpoint} onChange={event => setEndpoint(event.target.value)} disabled={busy} autoComplete="off" spellCheck={false} aria-label="MCP 连接地址" placeholder={transport === 'http' ? 'https://example.com/mcp' : '例如：npx 或程序的绝对路径'}/></label>
        {transport === 'stdio' && <label className="ln-field"><span>启动参数</span><textarea rows={3} value={args} onChange={event => setArgs(event.target.value)} disabled={busy} spellCheck={false} aria-label="MCP 启动参数" placeholder="每行一个参数；不会将它们拼成 Shell 命令"/></label>}
        <div className="ln-panel-title"><h3>{transport === 'http' ? '请求头 / 访问令牌' : '环境变量'}</h3><button type="button" className="ln-action" disabled={busy || pairs.length >= 20} onClick={() => setPairs(value => [...value,{ key:'',value:'' }])}>添加一项</button></div>
        {pairs.map((pair,index) => <div className="ln-native-key-value" key={index}><input value={pair.key} onChange={event => setPairs(current => current.map((row,i) => i === index ? { ...row,key:event.target.value } : row))} aria-label={`连接字段 ${index + 1} 名称`} placeholder={transport === 'http' ? '例如：Authorization' : '例如：SERVICE_TOKEN'} disabled={busy} autoComplete="off" spellCheck={false}/><input type="password" value={pair.value} onChange={event => setPairs(current => current.map((row,i) => i === index ? { ...row,value:event.target.value } : row))} aria-label={`连接字段 ${index + 1} 值`} placeholder="仅用于当前主机配置" disabled={busy} autoComplete="new-password"/><IconButton icon="close" label={`移除连接字段 ${index + 1}`} disabled={busy} onClick={() => setPairs(current => current.filter((_,i) => i !== index))}/></div>)}
        <p className="ln-native-help">保存只登记定义，不执行程序、不自动启用、不替助手授权。需要 OAuth 的服务请先使用对应客户端完成登录；这里不伪造登录状态。</p>
        <footer className="ln-form-actions"><button type="button" className="ln-action" disabled={busy} onClick={() => { setCreating(false); setName(''); setEndpoint(''); setArgs(''); setPairs([]) }}>取消</button><button type="submit" className="ln-action is-primary" disabled={busy || !name.trim() || !endpoint.trim()}>{busy ? '保存中…' : '保存连接，暂不启用'}</button></footer>
      </form>}
      {read.connections.map(connection => <article className="ln-native-resource" key={connection.serverId}><span className="ln-native-type"><Icon name="globe" size={18}/></span><div className="ln-native-resource-copy"><strong>{connection.name}</strong><p>{connection.transport === 'http' ? 'HTTP 服务' : '本机程序'} · {connection.enabled ? '已启用' : '已停用'} · {connection.assignedAgentIds.length} 位助手</p><small>{connection.authentication.credential === 'none' ? '未声明凭据' : '凭据保留在主机'}{connection.risk.level === 'high' ? ' · 高风险定义' : ''}</small>{connection.configurationIssues.map((issue,index) => <p className="ln-native-warning" key={index}>{issue.message}</p>)}</div><button type="button" className="ln-action" disabled={busy || read.permissionIssue} onClick={() => { if (!connection.enabled && connection.risk.level === 'high') setRisk(connection); else void enable(connection) }}>{connection.enabled ? '停用' : '启用'}</button></article>)}
      {!read.connections.length && !creating && <div className="ln-native-empty"><Icon name="globe" size={28}/><strong>还没有工具连接</strong><p>添加地址或本机程序，或从“客户端能力”导入已存在的连接。</p></div>}
    </>}
    <SurfaceDialog open={risk !== null} title="启用高风险连接？" description="这一步允许后续运行使用此连接，不会自动为任何助手勾选。" theme={theme} onClose={() => { if (!busy) setRisk(null) }} className="ln-room-dialog"><div className="ln-room-content"><div className="ln-review-card"><h3>{risk?.name}</h3><p>{risk?.transport === 'stdio' ? '此连接可能启动本机程序并访问主机资源。' : '此连接可能访问外部资源并产生副作用。'}</p></div>{error && <FormMessage error>{error}</FormMessage>}<div className="ln-form-actions"><button type="button" className="ln-action" disabled={busy} onClick={() => setRisk(null)}>取消</button><button type="button" className="ln-action is-primary" disabled={busy || !risk} onClick={() => { if (risk) void enable(risk,true) }}>确认这条连接并启用</button></div></div></SurfaceDialog>
  </section>
}
