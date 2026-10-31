import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { exportProfile, parseArguments, planApply, readToken, runPlan } from '../loom-profile.mjs'

/** An in-memory host that answers the six operations the profile tool uses. */
function fakeHost ({ members = [], servers = [], toolbox = [] } = {}) {
  const state = { members: structuredClone(members), servers: structuredClone(servers), toolbox: structuredClone(toolbox), digest: 1, calls: [] }
  return {
    state,
    async request (operation, params = {}) {
      state.calls.push(operation)
      switch (operation) {
        case 'members.list': return structuredClone(state.members)
        case 'members.create': {
          const member = { agentId: `agent_${state.members.length + 1}`, version: 1, removedAt: null, ...params.command }
          state.members.push(member); return { status: 'applied' }
        }
        case 'members.update': {
          const member = state.members.find(item => item.agentId === params.command.agentId)
          assert.equal(params.command.expectedVersion, member.version)
          Object.assign(member, params.command, { version: member.version + 1 }); return { status: 'applied' }
        }
        case 'mcp.config.get': return { configDigest: `d${state.digest}`, servers: structuredClone(state.servers) }
        case 'mcp.servers.create': {
          assert.equal(params.expectedConfigDigest, `d${state.digest}`)
          const [[name, definition]] = Object.entries(JSON.parse(params.definitionJson).mcpServers)
          state.servers.push({ serverId: `srv_${name}`, name, enabled: true, assignedAgentIds: [], definitionJson: JSON.stringify(definition) })
          state.digest += 1; return {}
        }
        case 'mcp.servers.setMembers': {
          assert.equal(params.expectedConfigDigest, `d${state.digest}`)
          state.servers.find(item => item.serverId === params.serverId).assignedAgentIds = params.agentIds
          state.digest += 1; return {}
        }
        case 'toolbox.list': return structuredClone(state.toolbox)
        case 'toolbox.setMembers': {
          const skill = state.toolbox.find(item => item.name === params.command.skillName)
          assert.equal(params.command.expectedVersion, skill.version)
          skill.memberIds = params.command.memberIds; skill.version = `${skill.version}+`; return {}
        }
        default: throw new Error(`unexpected ${operation}`)
      }
    }
  }
}

const dingding = { agentId: 'a1', version: 3, removedAt: null, displayName: '叮叮', teamRole: '队长', professionalResponsibilities: '拆计划', personalityTraits: ['稳'], workingPrinciples: '先读再写', growthTopic: 'LOOM' }

test('a profile exported from one host applies to another by member name', async () => {
  const source = fakeHost({
    members: [dingding, { ...dingding, agentId: 'a2', displayName: '芝士', teamRole: '队员' }],
    servers: [{ serverId: 's1', name: 'docs', enabled: true, assignedAgentIds: ['a2'], definitionJson: JSON.stringify({ command: 'docs-mcp', args: [] }) }],
    toolbox: [{ name: 'member-studio', memberIds: ['a1'], version: 'v1' }]
  })
  const profile = await exportProfile(source)
  assert.deepEqual(profile.members.map(member => member.displayName), ['叮叮', '芝士'])
  assert.deepEqual(profile.mcpServers[0].members, ['芝士'])
  assert.deepEqual(profile.toolbox, [{ skill: 'member-studio', members: ['叮叮'] }])
  assert.equal(JSON.stringify(profile).includes('a1'), false, 'agent ids never travel between hosts')

  const target = fakeHost({ members: [{ ...dingding, agentId: 'x9', version: 7, teamRole: '旧角色' }], toolbox: [{ name: 'member-studio', memberIds: [], version: 'v5' }] })
  const plan = await planApply(target, profile)
  assert.deepEqual(plan.map(step => `${step.kind} ${step.name}`), [
    'member.update 叮叮', 'member.create 芝士', 'mcp.create docs', 'mcp.members docs', 'toolbox.members member-studio'
  ])
  await runPlan(target, plan)
  assert.equal(target.state.members.find(member => member.displayName === '叮叮').teamRole, '队长')
  const cheese = target.state.members.find(member => member.displayName === '芝士')
  assert.deepEqual(target.state.servers[0].assignedAgentIds, [cheese.agentId])
  assert.deepEqual(target.state.toolbox[0].memberIds, ['x9'])

  const again = await planApply(target, await exportProfile(target))
  assert.deepEqual(again.filter(step => step.kind.startsWith('member.') || step.kind === 'mcp.create'), [], 're-applying the same profile changes no member or server')
})

test('masked MCP secrets are never sent; a secrets file fills them', async () => {
  const profile = { version: 1, members: [], mcpServers: [{ name: 'api', definition: { url: 'https://x', headers: { Authorization: '********' } }, members: [] }], toolbox: [] }
  await assert.rejects(planApply(fakeHost(), profile), { code: 'secret' })
  const plan = await planApply(fakeHost(), profile, { api: { url: 'https://x', headers: { Authorization: 'Bearer real' } } })
  assert.equal(plan[0].kind, 'mcp.create')
  assert.equal(plan[0].definition.headers.Authorization, 'Bearer real')
})

test('arguments, tokens and profile validation fail closed', async () => {
  assert.throws(() => parseArguments(['export']), { code: 'usage' })
  assert.throws(() => parseArguments(['wipe', '--host', 'https://h', '--token-file', 't']), { code: 'usage' })
  assert.throws(() => parseArguments(['export', '--host', 'file:///etc', '--token-file', 't']), { code: 'usage' })
  assert.equal(parseArguments(['apply', '--host', 'https://h.example/x', '--token-file', 't', '--profile', 'p', '--dry-run']).host, 'https://h.example')
  const directory = mkdtempSync(join(tmpdir(), 'loom-profile-'))
  const tokenFile = join(directory, 'server.txt')
  writeFileSync(tokenFile, `# comment\nurl=https://h\ntoken=${'a'.repeat(64)}\n`)
  assert.equal(readToken(tokenFile), 'a'.repeat(64))
  writeFileSync(tokenFile, 'nothing here\n')
  assert.throws(() => readToken(tokenFile), { code: 'token' })
  await assert.rejects(planApply(fakeHost(), { version: 2 }), { code: 'profile' })
  await assert.rejects(planApply(fakeHost(), { version: 1, members: [{ displayName: 'a' }, { displayName: 'a' }] }), { code: 'profile' })
})
