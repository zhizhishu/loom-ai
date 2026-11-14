import type {
  McpConfigIssue,
  McpConfigView,
  McpImportCandidate,
  McpImportInspection,
  McpImportSelection,
  McpMutationResult,
  McpServerView
} from '@contracts'
// 只借类型：ThreadClient 是已认证的 Core 通道，这里不发任何自制 RPC。
import type { ThreadClient } from '../camp-client'
import { readErrorMessage } from '../error-message'

/**
 * MCP 连接的数据层：只包住既有 Core 的 mcp.* 方法，不含 React、不含样式。
 *
 * 四条硬边界：
 * 1. 只用已存在的方法：mcp.config.get / mcp.servers.create / mcp.servers.setEnabled /
 *    mcp.import.scan / mcp.import.commit。不新增 RPC，也不碰 mcp.servers.reveal：
 *    读出明文存储凭据不属于这个模块的能力。
 * 2. 读模型里 Core 已经用掩码替换了敏感值（`definitionJson` 是脱敏投影），
 *    这里从不把掩码当真实值回写；导入提交原样发送候选自带的 `normalizedDefinitionJson`，
 *    凭据值留在服务端。
 * 3. 建连接和导入都不自动启用、不自动分配队员：Core 建出来就是 enabled=false 且无分配。
 * 4. 被拒绝、冲突、未知失败三者不互相冒充：运输层错误抛出，域内拒绝返回明确状态。
 */

export type McpRpc = Pick<ThreadClient, 'request'>

/** 本地拒绝用 local. 前缀，永不伪装成 Core 错误码。 */
export type McpErrorCode =
  | 'local.mcp_invalid_form'
  | 'local.mcp_digest_required'
  | 'local.mcp_masked_value'
  | 'local.mcp_candidate_mismatch'
  | 'local.mcp_candidate_unusable'
  | 'local.mcp_candidate_duplicate'
  | 'local.mcp_selection_empty'
  | 'local.mcp_replace_target_missing'

/** Core 拒绝或本地前置拒绝。code 原样保留，界面靠它区分「过期」「非法」「要确认风险」。 */
export class McpRequestError extends Error {
  constructor(readonly code: string, message: string, readonly details?: unknown) {
    super(message)
    this.name = 'McpRequestError'
  }
}

function localError(code: McpErrorCode, message: string): McpRequestError {
  return new McpRequestError(code, message)
}

/** 任何失败都收敛成带 code 的实例；未知码保留为空串，界面自己决定措辞。 */
function asMcpError(error: unknown): McpRequestError {
  if (error instanceof McpRequestError) return error
  const code = typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : ''
  return new McpRequestError(code, readErrorMessage(error, code || 'MCP 请求失败'))
}

/** Core 侧的只读掩码与保留标记；出现在新值里说明调用方把掩码当凭据了。 */
const READ_ONLY_MASK = '********'
const PRESERVE_STORED_VALUE_MARKER = '__ROVAI_PRESERVE_STORED_VALUE__'

/** 与 Core 的准入上限同值；本地只做前置拒绝，绝不放宽服务端判断。 */
const MAX_NAME_LENGTH = 64
const MAX_ARGUMENTS = 256
const MAX_MAP_ENTRIES = 128
const MAX_STRING_BYTES = 64 * 1024

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/u
const HEADER_NAME_PATTERN = /^[A-Za-z0-9!#$%&'*+\-.^_`|~]+$/u

/** 用户界面的两种运输方式；http 在 Core 里叫 streamable_http。 */
export type McpTransport = 'stdio' | 'http'

/** 一条用户填的键值（env 或 header）。值是用户自己输入的，或读模型里的掩码。 */
export type McpFieldEntry = { key: string, value: string }

export type McpStdioFields = {
  transport: 'stdio'
  name: string
  command: string
  args: readonly string[]
  env: readonly McpFieldEntry[]
}

export type McpHttpFields = {
  transport: 'http'
  name: string
  url: string
  headers: readonly McpFieldEntry[]
}

/** 建连接时用户填的结构化字段。凭据只在这里出现，且只进入这一次 create 调用。 */
export type McpConnectionFields = McpStdioFields | McpHttpFields

/**
 * 这条连接的凭据放在哪、能不能自己配 OAuth。
 * Core 没有 MCP 的 OAuth 流程，所以这里永远如实报 unsupported，不做假的「一键登录」。
 */
export type McpAuthenticationCapability = {
  credential: 'environment' | 'request_headers' | 'none'
  oauth: 'unsupported'
  /** 读模型里的敏感值只有掩码，真实值留在服务端。 */
  valuesAreMasked: true
}

export type McpConnectionRead = {
  serverId: string
  name: string
  transport: McpTransport
  endpoint: string
  enabled: boolean
  assignedAgentIds: string[]
  source: 'user' | 'import'
  risk: { level: 'standard' | 'high', acknowledged: boolean }
  /** Core 返回的脱敏定义，含掩码；只用于展示与编辑基线，不是凭据。 */
  definitionJson: string
  configurationIssues: McpConfigIssue[]
  authentication: McpAuthenticationCapability
}

/** 读取只有 ready / error 两种；读失败绝不当成「一条都没有」。 */
export type McpConnectionsRead =
  | {
    status: 'ready'
    configDigest: string
    path: string
    exists: boolean
    connections: McpConnectionRead[]
    fileIssue: McpConfigIssue | null
    permissionIssue: boolean
  }
  | { status: 'error', code: string, message: string }

export type McpScanRead =
  | { status: 'ready', inspection: McpImportInspection }
  | { status: 'error', code: string, message: string }

/**
 * 写操作的结果：applied 是 Core 真写了；其余三种都是没写。
 * conflict / invalid / risk_acknowledgement_required 原样透传，不做「大概成功」。
 */
export type McpWriteOutcome =
  | { status: 'applied', configDigest: string, config: McpConfigView }
  | { status: 'conflict', actualConfigDigest: string }
  | { status: 'invalid', issues: McpConfigIssue[] }
  | { status: 'risk_acknowledgement_required', serverId: string }

export type McpEnableInput = {
  serverId: string
  /** 必须来自最近一次读取的那份 configDigest；界面不能自己猜。 */
  expectedConfigDigest: string
  enabled: boolean
  /** 只在用户当场确认过高风险时传 true；默认一律不勾。 */
  acknowledgeHighRisk?: boolean
}

/** 一次导入里用户点的候选。candidateId 是身份，名字不是。 */
export type McpImportPick = {
  candidateId: string
  action: 'create' | 'replace'
  replaceServerId?: string | null
}

function transportOf(server: McpServerView): McpTransport {
  return server.transport === 'stdio' ? 'stdio' : 'http'
}

function authenticationOf(server: McpServerView): McpAuthenticationCapability {
  if (server.transport === 'stdio') {
    return { credential: 'environment', oauth: 'unsupported', valuesAreMasked: true }
  }
  // 没有 header 的 HTTP 连接通常没有凭据；有 header 就把凭据放在 header 里。
  return {
    credential: server.definitionJson.includes('"headers"') ? 'request_headers' : 'none',
    oauth: 'unsupported',
    valuesAreMasked: true
  }
}

function toConnectionRead(server: McpServerView): McpConnectionRead {
  return {
    serverId: server.serverId,
    name: server.name,
    transport: transportOf(server),
    endpoint: server.endpoint,
    enabled: server.enabled,
    assignedAgentIds: [...server.assignedAgentIds],
    source: server.source,
    risk: { level: server.riskLevel, acknowledged: server.riskAcknowledged },
    definitionJson: server.definitionJson,
    configurationIssues: [...(server.configurationIssues ?? [])],
    authentication: authenticationOf(server)
  }
}

/** 一次完整读取。Core 是启用/分配状态的唯一来源，这里不做乐观合并。 */
export async function readMcpConnections(rpc: McpRpc): Promise<McpConnectionsRead> {
  try {
    const view = await rpc.request<McpConfigView>('mcp.config.get')
    // 响应不是一份真实配置就报错：空数组会被界面读成「用户没有 MCP」。
    if (!view || !Array.isArray(view.servers) || typeof view.configDigest !== 'string') {
      return { status: 'error', code: 'local.mcp_invalid_form', message: 'MCP 配置读取结果不完整，请重新读取。' }
    }
    return {
      status: 'ready',
      configDigest: view.configDigest,
      path: view.path,
      exists: view.exists,
      connections: view.servers.map(toConnectionRead),
      fileIssue: view.fileIssue ?? null,
      permissionIssue: view.permissionIssue
    }
  } catch (error: unknown) {
    const failure = asMcpError(error)
    return { status: 'error', code: failure.code, message: failure.message }
  }
}

function isPreservationMarker(value: string): boolean {
  return value === READ_ONLY_MASK || value === PRESERVE_STORED_VALUE_MARKER
}

function invalidForm(message: string): McpRequestError {
  return localError('local.mcp_invalid_form', message)
}

function checkedName(raw: string): string {
  const name = raw.trim()
  if (!NAME_PATTERN.test(name) || name.length > MAX_NAME_LENGTH) {
    throw invalidForm('名称只能是 1–64 位字母、数字、下划线或连字符，并以字母或数字开头。')
  }
  return name
}

function checkedText(value: string, message: string): string {
  if (value.length > MAX_STRING_BYTES) throw invalidForm(message)
  return value
}

function checkedPairs(
  entries: readonly McpFieldEntry[],
  field: 'env' | 'headers'
): Record<string, string> | null {
  if (entries.length > MAX_MAP_ENTRIES) throw invalidForm(field === 'env' ? '环境变量太多了。' : '请求头太多了。')
  const values = new Map<string, string>()
  for (const entry of entries) {
    const key = entry.key.trim()
    const value = entry.value
    const validKey = field === 'env' ? ENV_NAME_PATTERN.test(key) : HEADER_NAME_PATTERN.test(key)
    if (!validKey) throw invalidForm(field === 'env' ? '环境变量名不合法。' : '请求头名称不合法。')
    if (values.has(key)) throw invalidForm(field === 'env' ? '环境变量名重复了。' : '请求头名称重复了。')
    if (value.length > MAX_STRING_BYTES) throw invalidForm(field === 'env' ? '环境变量的值太长。' : '请求头的值太长。')
    if (field === 'headers' && (value.includes('\r') || value.includes('\n'))) {
      throw invalidForm('请求头的值不能换行。')
    }
    // 掩码是「服务端还有值」的占位，不是可以新写入的凭据。
    if (isPreservationMarker(value)) {
      throw localError('local.mcp_masked_value', '掩码不能当新值提交，请重新输入真实内容。')
    }
    values.set(key, value)
  }
  return values.size ? Object.fromEntries(values) : null
}

function checkedUrl(raw: string): string {
  const url = checkedText(raw.trim(), '地址太长。')
  if (!url) throw invalidForm('请填写 MCP 的地址。')
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw invalidForm('地址必须是完整的 http(s) URL。')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw invalidForm('地址只支持 http 或 https。')
  }
  return url
}

/**
 * 结构化字段 → Core 要的那份 `definitionJson`（单个 mcpServers 条目）。
 * 只写标准字段，不塞任何本地私有键；不含掩码。
 */
export function buildMcpDefinitionJson(fields: McpConnectionFields): string {
  const name = checkedName(fields.name)
  if (fields.transport === 'stdio') {
    const command = checkedText(fields.command.trim(), '命令太长。')
    if (!command) throw invalidForm('stdio 连接需要一个命令。')
    if (fields.args.length > MAX_ARGUMENTS) throw invalidForm('参数太多了。')
    const args = fields.args.map((arg) => checkedText(arg, '参数太长。'))
    for (const arg of args) {
      if (isPreservationMarker(arg)) throw localError('local.mcp_masked_value', '掩码不能当新参数提交，请重新输入真实内容。')
    }
    const env = checkedPairs(fields.env, 'env')
    return JSON.stringify(
      {
        mcpServers: {
          [name]: {
            command,
            ...(args.length ? { args } : {}),
            ...(env ? { env } : {})
          }
        }
      },
      null,
      2
    )
  }
  const url = checkedUrl(fields.url)
  const headers = checkedPairs(fields.headers, 'headers')
  return JSON.stringify(
    { mcpServers: { [name]: { url, ...(headers ? { headers } : {}) } } },
    null,
    2
  )
}

function writeOutcome(result: McpMutationResult): McpWriteOutcome {
  switch (result?.status) {
    case 'ok':
      return { status: 'applied', configDigest: result.configDigest, config: result.config }
    case 'conflict':
      return { status: 'conflict', actualConfigDigest: result.actualConfigDigest }
    case 'invalid':
      return { status: 'invalid', issues: result.issues }
    case 'risk_acknowledgement_required':
      return { status: 'risk_acknowledgement_required', serverId: result.serverId }
    default:
      // 形状不认识就报未知，不冒充任何一种结果。
      throw new McpRequestError('', 'MCP 配置返回了无法识别的结果，请重新读取后再试。')
  }
}

function checkedDigest(expected: string): string {
  const digest = (expected ?? '').trim()
  if (!digest) throw localError('local.mcp_digest_required', '缺少配置版本，请重新读取 MCP 后再试。')
  return digest
}

/**
 * 用结构化字段建一条连接。Core 建出来是停用、未分配的：
 * 启用和分配都要用户另外点，本函数不代劳。
 * 输入对象不会被改写；界面只在返回 applied 时清空草稿。
 */
export async function createMcpConnection(
  rpc: McpRpc,
  fields: McpConnectionFields,
  expectedConfigDigest: string
): Promise<McpWriteOutcome> {
  const digest = checkedDigest(expectedConfigDigest)
  const definitionJson = buildMcpDefinitionJson(fields)
  let result: McpMutationResult
  try {
    result = await rpc.request<McpMutationResult>('mcp.servers.create', {
      expectedConfigDigest: digest,
      definitionJson
    })
  } catch (error: unknown) {
    throw asMcpError(error)
  }
  return writeOutcome(result)
}

/** 启用/停用一条已有连接。必须带精确 configDigest；高风险确认只在用户真的确认过时传。 */
export async function setMcpConnectionEnabled(
  rpc: McpRpc,
  input: McpEnableInput
): Promise<McpWriteOutcome> {
  const serverId = (input.serverId ?? '').trim()
  if (!serverId) throw localError('local.mcp_invalid_form', '缺少要启停的连接。')
  const digest = checkedDigest(input.expectedConfigDigest)
  let result: McpMutationResult
  try {
    result = await rpc.request<McpMutationResult>('mcp.servers.setEnabled', {
      expectedConfigDigest: digest,
      serverId,
      enabled: input.enabled === true,
      acknowledgeHighRisk: input.acknowledgeHighRisk === true
    })
  } catch (error: unknown) {
    throw asMcpError(error)
  }
  return writeOutcome(result)
}

/** 只读扫描本机已有应用的 MCP 配置。扫描失败不是「没有可导入项」。 */
export async function scanMcpImports(rpc: McpRpc): Promise<McpScanRead> {
  try {
    const inspection = await rpc.request<McpImportInspection>('mcp.import.scan')
    if (!inspection || !Array.isArray(inspection.candidates) || typeof inspection.configDigest !== 'string') {
      return { status: 'error', code: 'local.mcp_invalid_form', message: '扫描结果不完整，请重新扫描。' }
    }
    return { status: 'ready', inspection }
  } catch (error: unknown) {
    const failure = asMcpError(error)
    return { status: 'error', code: failure.code, message: failure.message }
  }
}

function primaryCandidate(inspection: McpImportInspection, candidateId: string): McpImportCandidate {
  const candidate = inspection.candidates.find((entry) => entry.candidateId === candidateId)
  if (!candidate) throw localError('local.mcp_candidate_mismatch', '这次扫描里没有这个候选，请重新扫描。')
  if (candidate.duplicateOfCandidateId) {
    throw localError('local.mcp_candidate_mismatch', '这个候选是同一次扫描里的重复项，请选择主候选。')
  }
  if (candidate.compatibility === 'unsupported' || candidate.normalizedDefinitionJson === null) {
    throw localError('local.mcp_candidate_unusable', '这个配置暂不支持自动导入。')
  }
  if (candidate.issues.some((issue) => issue.blocking)) {
    throw localError('local.mcp_candidate_unusable', '这个配置还有必须先解决的问题，不能导入。')
  }
  return candidate
}

/**
 * 按用户点的候选提交导入。身份、目标版本和正文都来自这一次扫描：
 * expectedConfigDigest 用 inspection.configDigest，正文原样用候选的 normalizedDefinitionJson
 * （里面只有掩码，真实凭据留在服务端由 Core 自己保留），绝不从掩码重建。
 */
export async function commitMcpImports(
  rpc: McpRpc,
  inspection: McpImportInspection,
  picks: readonly McpImportPick[]
): Promise<McpWriteOutcome> {
  const digest = checkedDigest(inspection?.configDigest ?? '')
  if (!picks.length) throw localError('local.mcp_selection_empty', '请选择要导入的 MCP。')
  const seen = new Set<string>()
  const selections: McpImportSelection[] = picks.map((pick) => {
    const candidateId = (pick.candidateId ?? '').trim()
    if (!candidateId) throw localError('local.mcp_candidate_mismatch', '导入项缺少候选标识，请重新扫描。')
    if (seen.has(candidateId)) throw localError('local.mcp_candidate_duplicate', '同一个候选被选了两次。')
    seen.add(candidateId)
    const candidate = primaryCandidate(inspection, candidateId)
    // 运行时值来自界面和存储，不靠类型收窄当校验。
    const action: 'create' | 'replace' | null =
      pick.action === 'replace' ? 'replace' : pick.action === 'create' ? 'create' : null
    if (!action) throw localError('local.mcp_invalid_form', '请选择创建或覆盖。')
    const replaceServerId = (pick.replaceServerId ?? '').trim()
    if (action === 'replace' && !replaceServerId) {
      throw localError('local.mcp_replace_target_missing', '覆盖需要一个已有连接的标识。')
    }
    return {
      candidateId: candidate.candidateId,
      action,
      ...(action === 'replace' ? { replaceServerId } : {}),
      definitionJson: candidate.normalizedDefinitionJson as string,
      hasBlockingIssues: false
    }
  })
  let result: McpMutationResult
  try {
    result = await rpc.request<McpMutationResult>('mcp.import.commit', {
      expectedConfigDigest: digest,
      selections
    })
  } catch (error: unknown) {
    throw asMcpError(error)
  }
  return writeOutcome(result)
}

export type McpPort = {
  read(): Promise<McpConnectionsRead>
  create(fields: McpConnectionFields, expectedConfigDigest: string): Promise<McpWriteOutcome>
  setEnabled(input: McpEnableInput): Promise<McpWriteOutcome>
  scan(): Promise<McpScanRead>
  commit(inspection: McpImportInspection, picks: readonly McpImportPick[]): Promise<McpWriteOutcome>
}

/** 把 useThreadClient() 的返回值直接绑成一个端口，界面只管调用。 */
export function createMcpPort(rpc: McpRpc): McpPort {
  return {
    read: () => readMcpConnections(rpc),
    create: (fields, expectedConfigDigest) => createMcpConnection(rpc, fields, expectedConfigDigest),
    setEnabled: (input) => setMcpConnectionEnabled(rpc, input),
    scan: () => scanMcpImports(rpc),
    commit: (inspection, picks) => commitMcpImports(rpc, inspection, picks)
  }
}
