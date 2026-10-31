#!/usr/bin/env node
// One declarative profile for every assistant, applied to any Rovai host.
//
//   node scripts/loom-profile.mjs export --host <origin> --token-file <path> [--out profile.json]
//   node scripts/loom-profile.mjs apply  --host <origin> --token-file <path> --profile profile.json [--dry-run]
//
// A profile carries each member's identity / rules (the six agent_profile fields), the MCP
// servers with the members they are assigned to, and the Toolbox Skill selection. Members are
// matched across hosts by display name, because agent ids differ per database. MCP secrets are
// never exported: the host masks them as ******** and apply refuses to send a masked value, so
// fill secrets with `--mcp-secrets <file>` (an mcpServers JSON kept outside the profile).
// The token file holds the target host's administrator token; it is read, never printed.

import { readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export const PROFILE_VERSION = 1
const PROTOCOL_VERSION = 5
const MASK = '********'
const MEMBER_FIELDS = ['displayName', 'teamRole', 'professionalResponsibilities', 'personalityTraits', 'workingPrinciples', 'growthTopic']

export class ProfileError extends Error {
  constructor (code, message) { super(message); this.code = code }
}

export function parseArguments (argv) {
  const [command, ...rest] = argv
  const options = { command, dryRun: false }
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index]
    if (flag === '--dry-run') { options.dryRun = true; continue }
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) throw new ProfileError('usage', `${flag} needs a value`)
    const key = { '--host': 'host', '--token-file': 'tokenFile', '--out': 'out', '--profile': 'profile', '--mcp-secrets': 'mcpSecrets' }[flag]
    if (!key) throw new ProfileError('usage', `unknown option ${flag}`)
    options[key] = value
    index += 1
  }
  if (command !== 'export' && command !== 'apply') throw new ProfileError('usage', 'command must be export or apply')
  if (!options.host || !options.tokenFile) throw new ProfileError('usage', '--host and --token-file are required')
  if (command === 'apply' && !options.profile) throw new ProfileError('usage', 'apply needs --profile')
  const url = new URL(options.host)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new ProfileError('usage', '--host must be http(s)')
  options.host = url.origin
  return options
}

export function readToken (path) {
  const text = readFileSync(path, 'utf8')
  const line = text.split(/\r?\n/u).map(value => value.trim()).find(value => /^(token=)?[0-9a-f]{64}$/u.test(value))
  if (!line) throw new ProfileError('token', `no 64-hex administrator token in ${path}`)
  return line.replace(/^token=/u, '')
}

export class HostClient {
  constructor (origin, fetchImpl = globalThis.fetch) { this.origin = origin; this.fetch = fetchImpl; this.session = null }

  async login (administratorToken) {
    const response = await this.fetch(`${this.origin}/api/v1/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.origin },
      body: JSON.stringify({ protocolVersion: PROTOCOL_VERSION, administratorToken })
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || typeof body.token !== 'string') throw new ProfileError('login', `login failed: ${body?.error?.code ?? response.status}`)
    this.session = body.token
  }

  async request (operation, params = {}) {
    const response = await this.fetch(`${this.origin}/api/v1/request`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: this.origin, authorization: `Bearer ${this.session}` },
      body: JSON.stringify({ operation, params })
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok || body.error) throw new ProfileError('request', `${operation} failed: ${JSON.stringify(body.error ?? response.status)}`)
    return body.result
  }
}

const command = (payload) => ({ commandId: randomUUID(), command: payload })

function memberProfile (member) {
  return Object.fromEntries(MEMBER_FIELDS.map(field => [field, member[field] ?? (field === 'personalityTraits' ? [] : '')]))
}

export async function exportProfile (client) {
  const members = (await client.request('members.list')).filter(member => !member.removedAt)
  const nameOf = new Map(members.map(member => [member.agentId, member.displayName]))
  const mcp = await client.request('mcp.config.get')
  const toolbox = await client.request('toolbox.list')
  return {
    version: PROFILE_VERSION,
    members: members.map(memberProfile),
    mcpServers: mcp.servers.map(server => ({
      name: server.name,
      enabled: server.enabled,
      definition: JSON.parse(server.definitionJson),
      members: server.assignedAgentIds.map(id => nameOf.get(id)).filter(Boolean)
    })),
    toolbox: toolbox.map(skill => ({ skill: skill.name, members: skill.memberIds.map(id => nameOf.get(id)).filter(Boolean) }))
  }
}

export function validateProfile (profile) {
  if (!profile || profile.version !== PROFILE_VERSION) throw new ProfileError('profile', `profile version must be ${PROFILE_VERSION}`)
  const names = new Set()
  for (const member of profile.members ?? []) {
    if (typeof member.displayName !== 'string' || !member.displayName.trim()) throw new ProfileError('profile', 'every member needs a displayName')
    if (names.has(member.displayName)) throw new ProfileError('profile', `duplicate member ${member.displayName}`)
    names.add(member.displayName)
  }
  return profile
}

function containsMask (value) {
  if (typeof value === 'string') return value.includes(MASK)
  if (Array.isArray(value)) return value.some(containsMask)
  if (value && typeof value === 'object') return Object.values(value).some(containsMask)
  return false
}

/** Plan every write first; apply runs the plan only when nothing is ambiguous. */
export async function planApply (client, profile, secrets = {}) {
  validateProfile(profile)
  const plan = []
  const existing = (await client.request('members.list')).filter(member => !member.removedAt)
  const byName = new Map(existing.map(member => [member.displayName, member]))
  for (const wanted of profile.members ?? []) {
    const current = byName.get(wanted.displayName)
    const target = memberProfile(wanted)
    if (!current) { plan.push({ kind: 'member.create', name: wanted.displayName, payload: target }); continue }
    const same = MEMBER_FIELDS.every(field => JSON.stringify(current[field] ?? '') === JSON.stringify(target[field]))
    if (!same) plan.push({ kind: 'member.update', name: wanted.displayName, payload: { agentId: current.agentId, expectedVersion: current.version, ...target } })
  }
  const mcp = await client.request('mcp.config.get')
  const serverByName = new Map(mcp.servers.map(server => [server.name, server]))
  for (const server of profile.mcpServers ?? []) {
    const definition = secrets[server.name] ?? server.definition
    const current = serverByName.get(server.name)
    if (!current) {
      if (containsMask(definition)) throw new ProfileError('secret', `MCP server ${server.name} has masked values; supply them with --mcp-secrets`)
      plan.push({ kind: 'mcp.create', name: server.name, definition })
    }
    plan.push({ kind: 'mcp.members', name: server.name, members: server.members ?? [] })
  }
  for (const entry of profile.toolbox ?? []) plan.push({ kind: 'toolbox.members', name: entry.skill, members: entry.members ?? [] })
  return plan
}

export async function runPlan (client, plan) {
  const done = []
  for (const step of plan.filter(step => step.kind.startsWith('member.'))) {
    await client.request(step.kind === 'member.create' ? 'members.create' : 'members.update', command(step.payload))
    done.push(`${step.kind} ${step.name}`)
  }
  const members = (await client.request('members.list')).filter(member => !member.removedAt)
  const idOf = (name) => {
    const member = members.find(candidate => candidate.displayName === name)
    if (!member) throw new ProfileError('profile', `member ${name} is not on this host`)
    return member.agentId
  }
  for (const step of plan.filter(step => step.kind === 'mcp.create')) {
    const config = await client.request('mcp.config.get')
    await client.request('mcp.servers.create', {
      expectedConfigDigest: config.configDigest,
      definitionJson: JSON.stringify({ mcpServers: { [step.name]: step.definition } })
    })
    done.push(`mcp.create ${step.name}`)
  }
  for (const step of plan.filter(step => step.kind === 'mcp.members')) {
    const config = await client.request('mcp.config.get')
    const server = config.servers.find(candidate => candidate.name === step.name)
    if (!server) throw new ProfileError('apply', `MCP server ${step.name} missing after create`)
    await client.request('mcp.servers.setMembers', {
      expectedConfigDigest: config.configDigest, serverId: server.serverId, agentIds: step.members.map(idOf)
    })
    done.push(`mcp.members ${step.name}`)
  }
  for (const step of plan.filter(step => step.kind === 'toolbox.members')) {
    const skills = await client.request('toolbox.list')
    const skill = skills.find(candidate => candidate.name === step.name)
    if (!skill) throw new ProfileError('apply', `Toolbox Skill ${step.name} is not on this host`)
    await client.request('toolbox.setMembers', command({ skillName: step.name, memberIds: step.members.map(idOf), expectedVersion: skill.version }))
    done.push(`toolbox.members ${step.name}`)
  }
  return done
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  const client = new HostClient(options.host)
  await client.login(readToken(options.tokenFile))
  if (options.command === 'export') {
    const text = `${JSON.stringify(await exportProfile(client), null, 2)}\n`
    if (options.out) writeFileSync(options.out, text, { mode: 0o600 }); else process.stdout.write(text)
    return
  }
  const profile = JSON.parse(readFileSync(options.profile, 'utf8'))
  const secrets = options.mcpSecrets ? (JSON.parse(readFileSync(options.mcpSecrets, 'utf8')).mcpServers ?? {}) : {}
  const plan = await planApply(client, profile, secrets)
  for (const step of plan) process.stdout.write(`${options.dryRun ? 'plan' : 'apply'}: ${step.kind} ${step.name}\n`)
  if (!options.dryRun) for (const line of await runPlan(client, plan)) process.stdout.write(`done: ${line}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { process.stderr.write(`loom-profile: ${error.code ?? 'error'}: ${error.message}\n`); process.exit(1) })
}
