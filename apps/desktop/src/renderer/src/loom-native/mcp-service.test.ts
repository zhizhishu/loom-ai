import { describe, expect, it, vi } from 'vitest'
import type {
  McpConfigView,
  McpImportCandidate,
  McpImportInspection,
  McpMutationResult,
  McpServerView
} from '@contracts'
import {
  buildMcpDefinitionJson,
  commitMcpImports,
  createMcpConnection,
  createMcpPort,
  McpRequestError,
  readMcpConnections,
  scanMcpImports,
  setMcpConnectionEnabled,
  type McpConnectionFields,
  type McpImportPick,
  type McpRpc,
  type McpStdioFields
} from './mcp-service'

/** 所有字符串都是合成的：不含任何真实凭据、主机名或路径。 */
const MASK = '********'
const DIGEST = 'sha256:' + 'a'.repeat(64)
const NEXT_DIGEST = 'sha256:' + 'b'.repeat(64)

function rpc(request: ReturnType<typeof vi.fn>): McpRpc {
  return { request } as unknown as McpRpc
}

function server(over: Partial<McpServerView> = {}): McpServerView {
  return {
    serverId: 'server-synthetic',
    name: 'docs',
    transport: 'stdio',
    endpoint: 'npx',
    enabled: false,
    assignedAgentIds: [],
    source: 'user',
    riskLevel: 'standard',
    riskAcknowledged: false,
    definitionJson: '{\n  "mcpServers": {\n    "docs": {\n      "command": "npx",\n      "env": {\n        "TOKEN": "********"\n      }\n    }\n  }\n}\n',
    ...over
  }
}

function config(over: Partial<McpConfigView> = {}): McpConfigView {
  return {
    path: '/synthetic/mcp.json',
    exists: true,
    configDigest: DIGEST,
    publicConfigJson: '{"mcpServers":{}}',
    servers: [server()],
    permissionIssue: false,
    ...over
  }
}

function candidate(over: Partial<McpImportCandidate> = {}): McpImportCandidate {
  return {
    candidateId: 'candidate-synthetic',
    sourceKind: 'codex',
    sourcePath: '/synthetic/codex/config.toml',
    sourceName: 'docs',
    proposedName: 'docs',
    sourceDefinitionJson: '{"command":"npx"}',
    normalizedDefinitionJson:
      '{\n  "mcpServers": {\n    "docs": {\n      "command": "npx",\n      "env": {\n        "TOKEN": "********"\n      }\n    }\n  }\n}',
    sourceEnabled: false,
    compatibility: 'portable',
    issues: [],
    conflict: 'none',
    ...over
  }
}

function inspection(over: Partial<McpImportInspection> = {}): McpImportInspection {
  return { configDigest: DIGEST, sources: [], candidates: [candidate()], ...over }
}

const stdioFields: McpStdioFields = {
  transport: 'stdio',
  name: 'docs',
  command: 'npx',
  args: ['-y', '@example/server'],
  env: [{ key: 'TOKEN', value: 'synthetic-token' }]
}

async function codeOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
  } catch (error: unknown) {
    return error instanceof McpRequestError ? error.code : `unexpected:${String(error)}`
  }
  return 'no-error'
}

describe('readMcpConnections', () => {
  it('maps the real view and reports masked credentials truthfully', async () => {
    const request = vi.fn().mockResolvedValue(config())
    const read = await readMcpConnections(rpc(request))
    expect(request).toHaveBeenCalledWith('mcp.config.get')
    expect(request).toHaveBeenCalledTimes(1)
    expect(read.status).toBe('ready')
    if (read.status !== 'ready') return
    expect(read.configDigest).toBe(DIGEST)
    expect(read.connections[0]).toMatchObject({
      serverId: 'server-synthetic',
      transport: 'stdio',
      enabled: false,
      assignedAgentIds: [],
      risk: { level: 'standard', acknowledged: false },
      authentication: { credential: 'environment', oauth: 'unsupported', valuesAreMasked: true }
    })
    // 读模型只有掩码，没有真实凭据。
    expect(read.connections[0].definitionJson).toContain(MASK)
  })

  it('never asks Core to reveal plaintext credentials', async () => {
    const request = vi.fn().mockResolvedValue(config())
    await readMcpConnections(rpc(request))
    expect(request.mock.calls.map((call) => call[0])).not.toContain('mcp.servers.reveal')
  })

  it('treats an unreadable payload as an error, never an empty list', async () => {
    const read = await readMcpConnections(rpc(vi.fn().mockResolvedValue(null)))
    expect(read.status).toBe('error')
    expect(read).not.toHaveProperty('connections')

    const failed = await readMcpConnections(
      rpc(vi.fn().mockRejectedValue(Object.assign(new Error('transport down'), { code: 'core_unavailable' })))
    )
    expect(failed).toEqual({ status: 'error', code: 'core_unavailable', message: 'transport down' })
  })

  it('keeps an HTTP connection with no headers at credential none', async () => {
    const request = vi.fn().mockResolvedValue(
      config({
        servers: [
          server({
            transport: 'streamable_http',
            endpoint: 'https://example.invalid/mcp',
            definitionJson: '{"mcpServers":{"docs":{"url":"https://example.invalid/mcp"}}}'
          })
        ]
      })
    )
    const read = await readMcpConnections(rpc(request))
    if (read.status !== 'ready') throw new Error('expected ready')
    expect(read.connections[0].authentication.credential).toBe('none')
  })
})

describe('buildMcpDefinitionJson', () => {
  it('writes only the standard stdio fields Core accepts', () => {
    const text = buildMcpDefinitionJson(stdioFields)
    expect(JSON.parse(text)).toEqual({
      mcpServers: {
        docs: { command: 'npx', args: ['-y', '@example/server'], env: { TOKEN: 'synthetic-token' } }
      }
    })
  })

  it('writes an http entry with headers', () => {
    const text = buildMcpDefinitionJson({
      transport: 'http',
      name: 'remote',
      url: 'https://example.invalid/mcp',
      headers: [{ key: 'Authorization', value: 'Bearer synthetic' }]
    })
    expect(JSON.parse(text)).toEqual({
      mcpServers: { remote: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer synthetic' } } }
    })
  })

  it('rejects invalid forms locally without inventing fields', () => {
    const cases: Array<[McpConnectionFields, string]> = [
      [{ ...stdioFields, name: '' }, 'local.mcp_invalid_form'],
      [{ ...stdioFields, name: '-leading-hyphen' }, 'local.mcp_invalid_form'],
      [{ ...stdioFields, command: '  ' }, 'local.mcp_invalid_form'],
      [{ ...stdioFields, env: [{ key: '1BAD', value: 'x' }] }, 'local.mcp_invalid_form'],
      [{ ...stdioFields, env: [{ key: 'A', value: '1' }, { key: 'A', value: '2' }] }, 'local.mcp_invalid_form'],
      [
        { transport: 'http', name: 'remote', url: 'ftp://example.invalid/mcp', headers: [] },
        'local.mcp_invalid_form'
      ],
      [
        { transport: 'http', name: 'remote', url: 'not a url', headers: [] },
        'local.mcp_invalid_form'
      ],
      [
        { transport: 'http', name: 'remote', url: 'https://example.invalid/mcp', headers: [{ key: 'Bad Key', value: 'x' }] },
        'local.mcp_invalid_form'
      ]
    ]
    for (const [fields, code] of cases) {
      let caught = ''
      try {
        buildMcpDefinitionJson(fields)
      } catch (error: unknown) {
        caught = error instanceof McpRequestError ? error.code : 'unexpected'
      }
      expect(caught).toBe(code)
    }
  })

  it('never lets a read mask stand in for a real value', () => {
    expect(() => buildMcpDefinitionJson({ ...stdioFields, env: [{ key: 'TOKEN', value: MASK }] }))
      .toThrowError(McpRequestError)
    try {
      buildMcpDefinitionJson({ ...stdioFields, args: [MASK] })
    } catch (error: unknown) {
      expect(error instanceof McpRequestError && error.code).toBe('local.mcp_masked_value')
    }
  })
})

describe('createMcpConnection', () => {
  it('sends exactly the documented payload and reports applied', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 'ok',
      configDigest: NEXT_DIGEST,
      config: config({ configDigest: NEXT_DIGEST })
    } satisfies McpMutationResult)
    const outcome = await createMcpConnection(rpc(request), stdioFields, DIGEST)
    expect(request).toHaveBeenCalledTimes(1)
    const [method, params] = request.mock.calls[0]
    expect(method).toBe('mcp.servers.create')
    expect(params).toEqual({
      expectedConfigDigest: DIGEST,
      definitionJson: buildMcpDefinitionJson(stdioFields)
    })
    // 建连接不启用、不分配：请求里只有这两项。
    expect(Object.keys(params).sort()).toEqual(['definitionJson', 'expectedConfigDigest'])
    expect(outcome).toEqual({ status: 'applied', configDigest: NEXT_DIGEST, config: expect.objectContaining({ configDigest: NEXT_DIGEST }) })
  })

  it('surfaces a digest conflict instead of a fake success', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 'conflict',
      actualConfigDigest: NEXT_DIGEST
    } satisfies McpMutationResult)
    const outcome = await createMcpConnection(rpc(request), stdioFields, DIGEST)
    expect(outcome).toEqual({ status: 'conflict', actualConfigDigest: NEXT_DIGEST })
  })

  it('surfaces Core validation issues and keeps the caller draft intact', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 'invalid',
      issues: [{ code: 'mcp.name_conflict', message: 'An MCP Server with this name already exists', field: 'mcpServers' }]
    } satisfies McpMutationResult)
    const fields: McpConnectionFields = { ...stdioFields, env: [{ key: 'TOKEN', value: 'synthetic-token' }] }
    const outcome = await createMcpConnection(rpc(request), fields, DIGEST)
    expect(outcome).toEqual({
      status: 'invalid',
      issues: [{ code: 'mcp.name_conflict', message: 'An MCP Server with this name already exists', field: 'mcpServers' }]
    })
    // 输入对象没有被改写，界面只在 applied 时自己清空草稿。
    expect(fields.env).toEqual([{ key: 'TOKEN', value: 'synthetic-token' }])
  })

  it('refuses a blank digest before talking to Core', async () => {
    const request = vi.fn()
    expect(await codeOf(() => createMcpConnection(rpc(request), stdioFields, '  '))).toBe('local.mcp_digest_required')
    expect(request).not.toHaveBeenCalled()
  })

  it('throws a typed error when the transport fails', async () => {
    const request = vi.fn().mockRejectedValue(new Error('socket closed'))
    await expect(createMcpConnection(rpc(request), stdioFields, DIGEST)).rejects.toBeInstanceOf(McpRequestError)
  })

  it('does not turn an unknown result shape into success', async () => {
    const request = vi.fn().mockResolvedValue({ status: 'something_else' })
    await expect(createMcpConnection(rpc(request), stdioFields, DIGEST)).rejects.toBeInstanceOf(McpRequestError)
  })
})

describe('setMcpConnectionEnabled', () => {
  it('sends the exact digest and never pre-approves risk', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 'ok',
      configDigest: NEXT_DIGEST,
      config: config({ configDigest: NEXT_DIGEST })
    } satisfies McpMutationResult)
    await setMcpConnectionEnabled(rpc(request), {
      serverId: 'server-synthetic',
      expectedConfigDigest: DIGEST,
      enabled: true
    })
    expect(request).toHaveBeenCalledWith('mcp.servers.setEnabled', {
      expectedConfigDigest: DIGEST,
      serverId: 'server-synthetic',
      enabled: true,
      acknowledgeHighRisk: false
    })
  })

  it('passes a risk acknowledgement through only when the user confirmed it', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 'risk_acknowledgement_required',
      serverId: 'server-synthetic'
    } satisfies McpMutationResult)
    const outcome = await setMcpConnectionEnabled(rpc(request), {
      serverId: 'server-synthetic',
      expectedConfigDigest: DIGEST,
      enabled: true
    })
    expect(outcome).toEqual({ status: 'risk_acknowledgement_required', serverId: 'server-synthetic' })

    request.mockResolvedValue({
      status: 'ok',
      configDigest: NEXT_DIGEST,
      config: config({ configDigest: NEXT_DIGEST })
    } satisfies McpMutationResult)
    await setMcpConnectionEnabled(rpc(request), {
      serverId: 'server-synthetic',
      expectedConfigDigest: DIGEST,
      enabled: true,
      acknowledgeHighRisk: true
    })
    expect(request.mock.calls.at(-1)?.[1]).toMatchObject({ acknowledgeHighRisk: true })
  })

  it('rejects a missing server id or digest locally', async () => {
    const request = vi.fn()
    expect(await codeOf(() => setMcpConnectionEnabled(rpc(request), { serverId: ' ', expectedConfigDigest: DIGEST, enabled: true })))
      .toBe('local.mcp_invalid_form')
    expect(await codeOf(() => setMcpConnectionEnabled(rpc(request), { serverId: 'server-synthetic', expectedConfigDigest: '', enabled: true })))
      .toBe('local.mcp_digest_required')
    expect(request).not.toHaveBeenCalled()
  })
})

describe('scanMcpImports and commitMcpImports', () => {
  it('reports a failed scan as an error, never as no candidates', async () => {
    const scan = await scanMcpImports(rpc(vi.fn().mockResolvedValue(null)))
    expect(scan.status).toBe('error')
    expect(scan).not.toHaveProperty('inspection')
  })

  it('commits the exact candidate id, digest and server-side definition', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 'ok',
      configDigest: NEXT_DIGEST,
      config: config({ configDigest: NEXT_DIGEST })
    } satisfies McpMutationResult)
    const scanned = inspection()
    await commitMcpImports(rpc(request), scanned, [
      { candidateId: 'candidate-synthetic', action: 'create' }
    ])
    expect(request).toHaveBeenCalledWith('mcp.import.commit', {
      expectedConfigDigest: DIGEST,
      selections: [
        {
          candidateId: 'candidate-synthetic',
          action: 'create',
          definitionJson: scanned.candidates[0].normalizedDefinitionJson,
          hasBlockingIssues: false
        }
      ]
    })
    // 掩码原样送回，由 Core 在服务端保留真实值：这里没有重建任何凭据。
    const sent = request.mock.calls[0][1].selections[0].definitionJson as string
    expect(sent).toContain(MASK)
    expect(sent).not.toContain('synthetic-token')
  })

  it('keeps a replace target only for replace', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 'ok',
      configDigest: NEXT_DIGEST,
      config: config({ configDigest: NEXT_DIGEST })
    } satisfies McpMutationResult)
    await commitMcpImports(rpc(request), inspection(), [
      { candidateId: 'candidate-synthetic', action: 'replace', replaceServerId: 'server-synthetic' }
    ])
    expect(request.mock.calls[0][1].selections[0]).toMatchObject({
      action: 'replace',
      replaceServerId: 'server-synthetic'
    })
  })

  it('refuses stale, unknown and unusable candidates before writing', async () => {
    const request = vi.fn()
    const picks: McpImportPick[] = [{ candidateId: 'candidate-other', action: 'create' }]
    expect(await codeOf(() => commitMcpImports(rpc(request), inspection(), picks)))
      .toBe('local.mcp_candidate_mismatch')
    expect(await codeOf(() => commitMcpImports(rpc(request), inspection({ configDigest: '' }), [
      { candidateId: 'candidate-synthetic', action: 'create' }
    ]))).toBe('local.mcp_digest_required')
    expect(await codeOf(() => commitMcpImports(rpc(request), inspection(), [])))
      .toBe('local.mcp_selection_empty')
    expect(await codeOf(() => commitMcpImports(rpc(request), inspection({
      candidates: [candidate({ compatibility: 'unsupported', normalizedDefinitionJson: null })]
    }), [{ candidateId: 'candidate-synthetic', action: 'create' }]))).toBe('local.mcp_candidate_unusable')
    expect(await codeOf(() => commitMcpImports(rpc(request), inspection({
      candidates: [candidate({ issues: [{ code: 'mcp.import_unknown_field', message: 'x', field: 'timeout', kind: 'blocker', blocking: true }] })]
    }), [{ candidateId: 'candidate-synthetic', action: 'create' }]))).toBe('local.mcp_candidate_unusable')
    expect(await codeOf(() => commitMcpImports(rpc(request), inspection(), [
      { candidateId: 'candidate-synthetic', action: 'create' },
      { candidateId: 'candidate-synthetic', action: 'create' }
    ]))).toBe('local.mcp_candidate_duplicate')
    expect(await codeOf(() => commitMcpImports(rpc(request), inspection(), [
      { candidateId: 'candidate-synthetic', action: 'replace' }
    ]))).toBe('local.mcp_replace_target_missing')
    expect(request).not.toHaveBeenCalled()
  })

  it('surfaces a rejected commit as conflict, not success', async () => {
    const request = vi.fn().mockResolvedValue({
      status: 'conflict',
      actualConfigDigest: NEXT_DIGEST
    } satisfies McpMutationResult)
    const outcome = await commitMcpImports(rpc(request), inspection(), [
      { candidateId: 'candidate-synthetic', action: 'create' }
    ])
    expect(outcome).toEqual({ status: 'conflict', actualConfigDigest: NEXT_DIGEST })
  })
})

describe('createMcpPort', () => {
  it('binds every operation to the same already-authenticated channel', async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(config())
      .mockResolvedValueOnce({ status: 'conflict', actualConfigDigest: NEXT_DIGEST })
    const port = createMcpPort(rpc(request))
    await port.read()
    await port.create(stdioFields, DIGEST)
    expect(request.mock.calls.map((call) => call[0])).toEqual(['mcp.config.get', 'mcp.servers.create'])
  })
})
