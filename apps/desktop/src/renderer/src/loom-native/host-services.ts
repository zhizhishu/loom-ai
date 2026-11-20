import type { NativeSource } from './native-source-presentation'
/** Authenticated Host capabilities, deliberately separate from Core domain RPC.
 * A desktop, local Web Host or paired cloud Host implements the same port. No
 * caller receives credentials, arbitrary filesystem access or a shell endpoint. */
export type NativeKind = 'skill' | 'mcp' | 'rule' | 'hook'
export type NativeRuntime = 'claude-code-cli' | 'codex-cli' | 'deepseek-harness' | 'pi'
export type NativeProgram = {
  kind: NativeRuntime; label: string; detected: boolean; evidence: string
  installationId?: string | null; executablePath?: string | null
  pathState?: string | null; enabled?: boolean | null
}
export type NativeCapability = {
  sourceId: string; kind: NativeKind; name: string; runtime: NativeRuntime
  sourceScope: 'user' | 'project'; sourcePath: string; digest: string
  compatibility?: string; aliasSource?: string; importable: boolean; import?: { status: 'importable' | 'not-importable'; operation?: string; reason?: string }
  masked?: { command?: string | null; argsCount?: number; envCount?: number; urlOrigin?: string | null }
  hook?: { event: string; commandDigest?: string; executed: false }
  truncated?: boolean
}
export type NativeCatalog = {
  protocolVersion: 1; programs: NativeProgram[]; items: NativeCapability[]
  sources?: NativeSource[]
  errors: { scope: string; runtime?: string; code: string; detail?: string }[]
  truncated: { limitHit: boolean; visited: number; visitedItems: number; depth: number }
  home?: { root: string; admitted: boolean }
}
export type NativePreview = {
  protocolVersion: 1; sourceId: string; digest: string; kind: NativeKind; available: boolean
  content?: { format: 'markdown' | 'json'; text: string }; truncated: boolean
  reason?: { code: string; message: string }
}
export type ScreenBounds = { x: number; y: number; width: number; height: number }
export type ComputerDevice = { deviceId: string; platform: string; bounds: ScreenBounds }
export type ComputerView = ComputerDevice & { viewId: string; expiresAt: number; serverTime: number }
export type ComputerControl = { controlId: string; viewId: string; generation: number; expiresAt: number; totalDeadline: number; seq?: number; serverTime?: number }
export type ComputerStatus = {
  configured: boolean; ready: boolean; reason: string | null; device: ComputerDevice | null
  view: Pick<ComputerView, 'viewId' | 'bounds' | 'expiresAt'> | null
  control: ComputerControl | null; serverTime: number
  limits: { maxTextCodepoints: number; minFrameIntervalMs: number; controlTotalSeconds: number; inputIdleSeconds: number }
}
export type ComputerEvent =
  | { kind: 'pointer'; action: 'click' | 'move'; x: number; y: number; button?: 'left' | 'right' | 'middle' }
  | { kind: 'wheel'; x: number; y: number; delta: number }
  | { kind: 'key'; key: string }
  | { kind: 'text'; text: string }
export type ComputerFrame = { blob: Blob; bounds: ScreenBounds; width: number; height: number; seq: number; capturedAt: number }
export type ComputerLeaseIdentity = { viewId: string; controlId: string; generation: number }
export type ComputerAgentGrant = {
  grantId: string; assistantId: string; deviceId: string; scope: 'view' | 'control'
  /** The paired node that owns `deviceId`, or null when the grant covers this computer. */
  nodeId?: string | null
  serverId: string | null; expiresAt: number; validForSeconds: number
  state: 'active' | 'expired' | 'revoked' | 'owner_session_closed'
}
export type ComputerAgentGrants = {
  grants: ComputerAgentGrant[]
  limits: { configured: boolean; reason: string | null; maxGrants: number; maxGrantSeconds: number; runtimes: string[]; piEnabled: boolean }
}
export interface ComputerAgentPort {
  list(): Promise<ComputerAgentGrants>
  grant(input: { assistantId: string; deviceId: string; scope: 'view' | 'control'; expectedConfigDigest: string; ttlSeconds: number; nodeId?: string }): Promise<ComputerAgentGrant>
  revoke(grantId: string): Promise<{ revoked: boolean; grantId: string }>
}
export interface ComputerPort {
  agents?: ComputerAgentPort
  status(): Promise<ComputerStatus>
  startView(deviceId: string): Promise<ComputerView>
  frame(viewId: string, signal?: AbortSignal): Promise<ComputerFrame>
  acquire(viewId: string, deviceId: string): Promise<ComputerControl>
  heartbeat(identity: ComputerLeaseIdentity): Promise<ComputerControl>
  release(identity: ComputerLeaseIdentity): Promise<unknown>
  stop(viewId: string): Promise<unknown>
  input(identity: ComputerLeaseIdentity, seq: number, event: ComputerEvent): Promise<{ applied: boolean; seq: number; generation: number }>
}
export interface HostWorkbench {
  catalog(threadId?: string): Promise<NativeCatalog>
  preview(sourceId: string, expectedDigest: string, threadId?: string): Promise<NativePreview>
  importMcp(sourceId: string, expectedDigest: string, expectedConfigDigest: string, threadId?: string): Promise<{ status: string; serverId?: string | null; name?: string; enabled?: boolean; assignedAgentIds?: string[] }>
  computer: ComputerPort
  remoteComputer?(nodeId: string): ComputerPort
  computerNodes?(): Promise<{ nodeId: string; displayName: string; status: string; computerProtocolVersions: number[]; os: string | null }[]>
}

export function hostFeatureError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  const messages: Record<string, string> = {
    computer_agent_unsupported: '当前主机还没有启用助手电脑工具。',
    computer_agent_runtime_unsupported: '这个助手的运行端还未接入电脑工具，请先选择已支持的运行端。',
    computer_agent_target_unsupported: '助手目前不在这台主机执行，不能授予这台电脑的控制。',
    computer_agent_digest_mismatch: '工具配置已经变化，请重新检查后授权。',
    computer_agent_grant_conflict: '已有同范围授权，请查看并先撤销旧授权。',
    computer_agent_control_held: '电脑正在由另一个会话控制，请先归还控制。',
    computer_agent_cleanup_unconfirmed: '输入已被撤销，但工具清理尚未确认，请检查连接后刷新。',
    computer_unsupported: '这台主机尚未启用电脑服务。',
    computer_helper_not_configured: '这台主机尚未配置电脑服务。',
    computer_backend_unavailable: '这台主机没有可访问的图形桌面。',
    computer_encoder_unavailable: '电脑服务的画面编码组件不可用。',
    computer_session_locked: '这台主机的桌面已锁定，请先在主机解锁。',
    computer_control_held: '已有另一个会话在控制这台电脑，请先归还控制。',
    computer_lease_expired: '控制授权已到期，已停止发送输入。',
    computer_view_unknown: '画面会话已失效，请重新连接。',
    computer_view_expired: '查看授权已到期，请重新连接。',
    computer_input_stale: '控制身份已变更，旧输入已丢弃。',
    computer_input_out_of_order: '重复或过期输入已被拒绝。',
    computer_input_invalid: '这次输入不受支持；请使用普通文字或下方的按键。',
    computer_busy: '电脑服务正在处理另一个请求，请稍后重试。',
    computer_timeout: '电脑响应超时，不能确定输入结果，控制已停止。',
    computer_input_failed: '主机未确认输入结果，控制已停止，未自动重放。',
    computer_input_unknown: '主机未确认输入结果，控制已撤销，没有自动重放。',
    computer_unavailable: '电脑服务暂时不可用；输入已停止。',
    discovery_home_required: '这台主机尚未设置原生客户端发现范围。',
    discovery_home_invalid: '主机的原生客户端目录不可用。',
    session_required: '连接已失效，请重新登录。'
  }
  return messages[code] ?? (error instanceof Error ? error.message : '主机请求未完成，请检查连接。')
}

/** Map inside the actual painted image, not a letterboxed parent rectangle. */
export function screenPoint(rect: Pick<DOMRect, 'left' | 'top' | 'width' | 'height'>, bounds: ScreenBounds, clientX: number, clientY: number): { x: number; y: number } | null {
  if (rect.width <= 0 || rect.height <= 0 || bounds.width <= 0 || bounds.height <= 0) return null
  const x = (clientX - rect.left) / rect.width
  const y = (clientY - rect.top) / rect.height
  if (x < 0 || y < 0 || x >= 1 || y >= 1) return null
  return { x: bounds.x + Math.min(bounds.width - 1, Math.floor(x * bounds.width)), y: bounds.y + Math.min(bounds.height - 1, Math.floor(y * bounds.height)) }
}
