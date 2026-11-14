import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { LoomArtifactPreviewResult, MissionRecord } from '@contracts'
import type { WorkBundle, LoomArtifact, LoomCandidate, LoomTask, ConversationItem } from './types'
import { Sidebar } from './Sidebar'
import { Markdown } from './ConversationView'
import { workStatus } from './Inspector'
import { artifactCandidateFacts, previewStateFromResult, reviewDraftComplete, submitArtifactReview, artifactFileName, type LoomRpc } from './artifact-service'

const criteria = { version: 'pinned-v1', criteria: [{ criterionId: 'a', text: 'Content verified' }, { criterionId: 'b', text: 'Review complete' }] }
const task = { taskId:'t',planId:'p',title:'Actual work',description:'Actual description',assigneeAgentId:'a',status:'ready',acceptanceCriteria:criteria,blockedReason:null,createdAt:'2026-11-13T00:00:00Z',updatedAt:'2026-11-13T00:00:00Z',revision:1 } satisfies LoomTask
const artifact = { artifactId:'file1',planId:'p',taskId:'t',agentRunId:'r',relativePath:'out/report.md',sha256:'a'.repeat(64),sizeBytes:32,contentType:'text/markdown',creatorId:'a',createdAt:'2026-11-13T00:00:00Z' } satisfies LoomArtifact
const first = { candidateId:'c1',taskId:'t',agentRunId:'r',contentHash:'a'.repeat(64),evidenceIds:['file1'],acceptanceCriteria:criteria,previousCandidateId:null,verificationStatus:'unverified',acceptanceStatus:'pending',createdAt:'2026-11-13T00:00:00Z' } satisfies LoomCandidate
const second: LoomCandidate = { ...first,candidateId:'c2',evidenceIds:['file2'],previousCandidateId:'c1',createdAt:'2026-11-13T00:01:00Z' }
const mission = { missionId:'m',threadId:'th',title:'Real mission',runningAgentIds:[] } as unknown as MissionRecord
function bundle(candidates: LoomCandidate[] = [first]): WorkBundle { return {mission,plan:null,tasks:[task],candidates,artifacts:[artifact],reviews:[],verifications:[]} }
const preview: LoomArtifactPreviewResult = { artifactId:'file1',relativePath:'out/report.md',contentType:'text/markdown',sizeBytes:32,sha256:artifact.sha256,text:'# Exact archived text',unavailableReason:null }

describe('native reference frontend boundaries', () => {
  it('renders a unified conversation sidebar without the old shell or project headings', () => {
    const items: ConversationItem[] = [{id:'th',title:'Actual conversation',subtitle:'Latest actual reply',agentId:null,threadId:'th',missionId:'m',unread:true,updatedAt:null}]
    const html = renderToStaticMarkup(createElement(Sidebar,{agents:[],items,selectedId:'th',loading:false,onSelect:()=>{},onCreate:()=>{},onCollapse:()=>{}}))
    expect(html).toContain('ln-conversation-row is-selected')
    expect(html).toContain('Actual conversation'); expect(html).toContain('Latest actual reply')
    expect(html).toContain('aria-current="page"');expect(html).toContain('ln-unread-dot')
    expect(html).not.toMatch(/unified-sidebar|camp-nav|mission-rail|Rovai|ROVAI|使命板|项目目录/)
  })
  it('keeps rich table/code/list structure instead of flattening messages', () => {
    const html=renderToStaticMarkup(createElement(Markdown,{text:'| PR | Status |\n|---|---|\n| #1 | Review |\n\n1. First\n2. Next\n\n```ts\nconst a = 1\n```'}))
    expect(html).toContain('<table>');expect(html).toContain('<ol>');expect(html).toContain('<pre>')
  })
  it('does not turn arbitrary Markdown scripts into executable HTML', () => {
    const html=renderToStaticMarkup(createElement(Markdown,{text:'<script>alert(1)</script>'}))
    expect(html).not.toContain('<script>')
  })
  it('does not label ready work as running without actual run state', () => {
    expect(workStatus({task,mission,candidate:null}).group).toBe('待开始')
  })
  it('uses actual running agent membership to show execution', () => {
    expect(workStatus({task,mission:{...mission,runningAgentIds:['a']},candidate:null}).group).toBe('进行中')
  })
  it('keeps pending acceptance separate from done', () => {
    expect(workStatus({task:{...task,status:'done'},mission,candidate:first}).group).toBe('等待你')
  })
  it('does not hide blocked work behind a pending candidate', () => {
    expect(workStatus({task:{...task,status:'blocked'},mission,candidate:first}).group).toBe('受阻')
  })
})

describe('native immutable artifact and explicit acceptance', () => {
  it('returns the exact archived text, not the current disk contents', () => {
    expect(previewStateFromResult(preview)).toEqual({status:'ready',text:preview.text})
  })
  it.each(['binary','too_large','not_archived'] as const)('preserves unavailable state %s', reason => {
    expect(previewStateFromResult({...preview,text:null,unavailableReason:reason})).toEqual({status:'unavailable',reason})
  })
  it('reports invalid preview payload as error instead of pretending no archive exists', () => {
    expect(previewStateFromResult({...preview,text:null})).toMatchObject({status:'error'})
  })
  it('historical file stays attached to its historical candidate and cannot be accepted', () => {
    const facts=artifactCandidateFacts(bundle([first,second]),artifact,first)
    expect(facts.candidate?.candidateId).toBe('c1');expect(facts.latest).toBe(false);expect(facts.reviewable).toBe(false)
  })
  it('does not swap evidence ownership to an unrelated preferred candidate', () => {
    expect(artifactCandidateFacts(bundle([first,second]),artifact,second).candidate?.candidateId).toBe('c1')
  })
  it('uses the candidate-pinned criteria rather than plan mutation', () => {
    expect(artifactCandidateFacts(bundle(),artifact,first).criteriaVersion).toBe('pinned-v1')
  })
  it('requires nonblank reason and every criterion for acceptance', () => {
    const facts=artifactCandidateFacts(bundle(),artifact,first)
    expect(reviewDraftComplete({candidateId:'c1',verdict:'accepted',reason:'  ',satisfied:['a','b']},facts)).toBe(false)
    expect(reviewDraftComplete({candidateId:'c1',verdict:'accepted',reason:'Reviewed',satisfied:['a']},facts)).toBe(false)
    expect(reviewDraftComplete({candidateId:'c1',verdict:'accepted',reason:'Reviewed',satisfied:['a','b']},facts)).toBe(true)
    expect(reviewDraftComplete({candidateId:'c1',verdict:'rejected',reason:'Needs revision',satisfied:[]},facts)).toBe(true)
  })
  it('cannot submit a historical review even if invoked outside the component', async () => {
    const request=vi.fn();const facts=artifactCandidateFacts(bundle([first,second]),artifact,first)
    await expect(submitArtifactReview({request} as unknown as LoomRpc,'m',facts,{candidateId:'c1',verdict:'accepted',reason:'Yes',satisfied:['a','b']})).rejects.toThrow()
    expect(request).not.toHaveBeenCalled()
  })
  it('submits exactly the pinned candidate and criteria with no spoofed reviewer identity', async () => {
    const request=vi.fn().mockResolvedValue({});const facts=artifactCandidateFacts(bundle(),artifact,first)
    await submitArtifactReview({request} as unknown as LoomRpc,'m',facts,{candidateId:'c1',verdict:'accepted',reason:' Reviewed ',satisfied:['a','b']})
    expect(request).toHaveBeenCalledTimes(1)
    const [method,input]=request.mock.calls[0]
    expect(method).toBe('loom.review.record');expect(input).toMatchObject({missionId:'m',candidateId:'c1',taskId:'t',acceptanceCriteriaVersion:'pinned-v1',reason:'Reviewed'})
    expect(input).not.toHaveProperty('reviewerId');expect(input.criteriaResults).toHaveLength(2)
  })
  it('keeps filenames without promoting path strings into file access', () => {expect(artifactFileName('out/report.md')).toBe('report.md')})
})
