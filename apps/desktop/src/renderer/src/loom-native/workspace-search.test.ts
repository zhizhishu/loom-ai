import { describe, expect, it } from 'vitest'
import { searchWorkspace } from './workspace-search'
import type { AgentProfile, ConversationItem, WorkBundle } from './types'

const agents = [
  { agentId: 'a', displayName: 'Hanzi', presence: 'present', removedAt: null },
  { agentId: 'retired', displayName: 'Retired Hanzi', presence: 'removed', removedAt: '2026-01-01' }
] as AgentProfile[]
const conversations: ConversationItem[] = [
  { id:'thread', threadId:'thread', agentId:'a', missionId:'mission', title:'Website launch', subtitle:'Preparing the report', unread:false, updatedAt:null },
  { id:'agent:a', threadId:null, agentId:'a', missionId:null, title:'Hanzi', subtitle:'Assistant', unread:false, updatedAt:null }
]
const bundles = [{
  mission:{ missionId:'mission', threadId:'thread', title:'Website launch' },
  tasks:[{ taskId:'task', title:'Review landing page', description:'Verify keyboard navigation' }],
  candidates:[{ candidateId:'candidate', taskId:'task', evidenceIds:['artifact'], createdAt:'2026-01-01' }],
  artifacts:[{ artifactId:'artifact', taskId:'task', relativePath:'reports/accessibility.md' }]
}] as unknown as WorkBundle[]

describe('workspace search from Core read projections', () => {
  it('finds work by title and description across the workspace', () => {
    const found = searchWorkspace('LANDING keyboard', conversations, agents, bundles)
    expect(found.work.map(row => row.task.taskId)).toEqual(['task'])
    expect(found.conversations).toEqual([])
  })
  it('finds archived filenames and preserves exact evidence ownership', () => {
    const found = searchWorkspace('accessibility', conversations, agents, bundles)
    expect(found.artifacts[0].artifact.artifactId).toBe('artifact')
    expect(found.artifacts[0].candidate?.candidateId).toBe('candidate')
    expect(found.artifacts[0].bundle).toBe(bundles[0])
  })
  it('excludes removed assistants and does not duplicate virtual assistant rows as chats', () => {
    const found = searchWorkspace('hanzi', conversations, agents, bundles)
    expect(found.assistants.map(row => row.agentId)).toEqual(['a'])
    expect(found.conversations).toEqual([])
  })
  it('supports normalized full-width queries and actual mission context', () => {
    const found = searchWorkspace('ＷＥＢＳＩＴＥ', conversations, agents, bundles)
    expect(found.conversations).toHaveLength(1)
    expect(found.work).toHaveLength(1)
    expect(found.artifacts).toHaveLength(1)
  })
  it('deduplicates refresh overlap while preserving a count beyond each section limit', () => {
    const found = searchWorkspace('', [...conversations, ...conversations], agents, [...bundles, ...bundles], 1)
    expect(found.total).toBe(4)
    expect(found.conversations).toHaveLength(1)
    expect(found.work).toHaveLength(1)
  })
})
