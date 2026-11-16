import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type {
  LoomArtifact,
  LoomCandidate,
  LoomClaim,
  LoomReview,
  LoomTask,
  LoomVerification,
  MissionRecord,
  ThreadSnapshot
} from '@contracts'
import type { ArtifactSelection, WorkBundle } from './types'
import { CLAIMS_LIST_METHOD, readV2RunFacts, type V2HostDeclaration, type V2RunPort } from './v2-run-service'
import { V2BotStatusPanel } from './V2BotStatusPanel'

// ------------------------------------------------------------------- fixtures
// 形状与 v2-run-service.test.ts 同源（最小字段 + 断言收敛），本文件只验证「渲染严格
// 跟随投影状态」：两 Bot 独立、四条产物状态互不推导、四种读态互不冒充、无伪造进度。

const member = (agentId: string, displayName: string, isDefaultLead = false): ThreadSnapshot['members'][number] => ({
  agentId,
  displayName,
  avatarRef: null,
  teamRole: 'engineer',
  accent: 'blue',
  membershipStatus: 'active',
  leaveRequestedAt: null,
  profilePresence: 'present',
  memberOrder: 0,
  isDefaultLead,
  version: 1
} as unknown as ThreadSnapshot['members'][number])

const run = (id: string, agentId: string, taskId: string, status = 'succeeded', waitReason: string | null = null): ThreadSnapshot['agentRuns'][number] => ({
  id,
  agentId,
  taskId,
  status,
  waitReason,
  startedAt: '2026-11-15T01:00:00Z',
  endedAt: status === 'running' ? null : '2026-11-15T01:10:00Z'
} as unknown as ThreadSnapshot['agentRuns'][number])

const thread = (over: {
  id?: string
  members?: ThreadSnapshot['members']
  agentRuns?: ThreadSnapshot['agentRuns']
} = {}): ThreadSnapshot => ({
  thread: {
    id: over.id ?? 'camp-1',
    defaultLeadAgentId: 'bot-a'
  },
  members: over.members ?? [member('bot-a', 'BotA', true), member('bot-b', 'BotB')],
  agentRuns: over.agentRuns ?? []
} as unknown as ThreadSnapshot)

const mission = (threadId = 'camp-1'): MissionRecord => ({
  missionId: 'rvm_1',
  threadId,
  title: '双 Bot 交付目标',
  description: '两个 Bot 各自真实分工',
  status: 'in_progress',
  memberAgentIds: ['bot-a', 'bot-b'],
  defaultLeadAgentId: 'bot-a'
} as unknown as MissionRecord)

const task = (taskId: string, assigneeAgentId: string | null): LoomTask => ({
  taskId,
  planId: 'plan-1',
  title: taskId,
  description: '',
  assigneeAgentId,
  status: 'ready',
  blockedReason: null,
  createdAt: '2026-11-15T00:00:00Z',
  updatedAt: '2026-11-15T00:00:00Z',
  revision: 1,
  acceptanceCriteria: { version: 'ac-1', criteria: [] }
} as unknown as LoomTask)

const artifact = (artifactId: string, over: Partial<LoomArtifact> = {}): LoomArtifact => ({
  artifactId,
  planId: 'plan-1',
  taskId: 'task-a',
  agentRunId: 'run-1',
  relativePath: 'docs/report.md',
  sha256: 'sha256-report-1234',
  sizeBytes: 1234,
  contentType: 'text/markdown',
  creatorId: 'bot-a',
  createdAt: '2026-11-15T02:00:00Z',
  ...over
})

const candidate = (candidateId: string, evidenceIds: string[]): LoomCandidate => ({
  candidateId,
  taskId: 'task-a',
  agentRunId: 'run-1',
  contentHash: 'hash-1',
  evidenceIds,
  acceptanceCriteria: { version: 'ac-1', criteria: [] },
  previousCandidateId: null,
  verificationStatus: 'unverified',
  acceptanceStatus: 'pending',
  createdAt: '2026-11-15T02:00:00Z'
})

const verification = (candidateId: string, result: 'passed' | 'failed'): LoomVerification => ({
  verificationId: 'ver-1',
  candidateId,
  method: 'rerun the tests',
  executorId: 'host',
  result,
  evidenceIds: [],
  verifiedAt: '2026-11-15T03:00:00Z'
})

const review = (candidateId: string, verdict: 'accepted' | 'rejected'): LoomReview => ({
  reviewId: 'rev-1',
  candidateId,
  acceptanceCriteriaVersion: 'ac-1',
  verdict,
  reason: 'looks right',
  criteriaResults: [],
  reviewerId: 'user',
  reviewedAt: '2026-11-15T04:00:00Z'
})

const claim = (claimId: string, taskId: string, claimantAgentId: string): LoomClaim => ({
  claimId,
  taskId,
  agentRunId: 'run-1',
  claimantAgentId,
  fenceGeneration: 1,
  claimedAt: '2026-11-15T00:00:00Z',
  leaseExpiresAt: '2026-11-15T01:00:00Z',
  releasedAt: null,
  expired: false
})

const bundle = (over: Partial<WorkBundle> = {}): WorkBundle => ({
  mission: mission(),
  plan: null,
  tasks: [task('task-a', 'bot-a'), task('task-b', 'bot-b')],
  candidates: [],
  artifacts: [],
  reviews: [],
  verifications: [],
  ...over
})

const declared = (...methods: string[]): V2HostDeclaration => ({ declaredMethods: methods })

const port = (request: ReturnType<typeof vi.fn>): V2RunPort => ({ request: request as V2RunPort['request'] })

const claimsReceipt = (claims: LoomClaim[], evaluatedAt = '2026-11-15T00:30:00Z') => ({
  evaluatedAt,
  claims
})

/** 与组件一致的装配方式：唯一读入口就是 readV2RunFacts，组件只收投影。
 * preferredFor 只做「拥有该证据的候选」这一条真实归属映射（evidenceIds 链接），
 * 不猜 candidate、不放宽真相；无归属时为 null，三态如实 unavailable(no_candidate)。 */
async function renderPanel(over: {
  bundle?: WorkBundle
  thread?: ThreadSnapshot
  declaration?: V2HostDeclaration | null
  receipt?: unknown
}): Promise<string> {
  const request = vi.fn().mockResolvedValue(
    over.receipt !== undefined ? over.receipt : claimsReceipt([])
  )
  const bundleRef = over.bundle ?? bundle()
  const facts = await readV2RunFacts({
    port: port(request),
    declaration: over.declaration === undefined ? declared(CLAIMS_LIST_METHOD) : over.declaration,
    missionId: 'rvm_1',
    bundle: bundleRef,
    thread: over.thread ?? thread(),
    preferredFor: artifact => bundleRef.candidates.find(
      entry => entry.evidenceIds.includes(artifact.artifactId)
    ) ?? null
  })
  return renderToStaticMarkup(
    <V2BotStatusPanel
      facts={facts}
      bundle={bundleRef}
      onArtifact={(_selection: ArtifactSelection) => {}}
    />
  )
}

// ---------------------------------------------------------------------- tests

describe('V2 run surface: actual records, readable actions, independent facts', () => {
  const ownedBundle = (over:Partial<WorkBundle>={}) => bundle({candidates:[candidate('cand-a',['art-a'])],artifacts:[artifact('art-a')],...over})
  it('explains a real waiting run but never displays a stale wait reason on another status', async()=>{
    const html=await renderPanel({thread:thread({agentRuns:[
      run('wait-1','bot-a','task-a','waiting','等待用户审批本次工具权限'),
      run('done-1','bot-b','task-b','succeeded','过期的等待原因')
    ]})})
    expect(html).toContain('等待中')
    expect(html).toContain('等待原因：等待用户审批本次工具权限')
    expect(html).not.toContain('过期的等待原因')
    expect(html).not.toContain('已接受')
  })
  it('shows named ownership, task titles and real execution states without claiming completion', async()=>{
    const html=await renderPanel({thread:thread({agentRuns:[run('run-a','bot-a','task-a','running'),run('run-b','bot-b','task-b','queued')]}),receipt:claimsReceipt([claim('claim-a','task-a','bot-a')])})
    expect(html).toContain('BotA');expect(html).toContain('BotB')
    expect(html).toContain('认领有效');expect(html).toContain('执行中');expect(html).toContain('排队中')
    expect(html).toContain('暂无认领记录');expect(html).not.toContain('无人工作');expect(html).not.toContain('>bot-a<')
  })
  it('does not expose a released or expired claim as the active owner', async()=>{
    for(const patch of [{expired:true},{releasedAt:'2026-11-15T00:20:00Z'}]) {
      const html=await renderPanel({receipt:claimsReceipt([{...claim('c','task-a','bot-a'),...patch}])})
      expect(html.split('<details')[0]).not.toContain('认领者：');expect(html).not.toContain('认领有效')
      expect(html).toContain(patch.expired?'认领已过期':'认领已释放')
    }
  })
  it('only calls an empty claim list empty when the host returned it', async()=>{
    const html=await renderPanel({receipt:claimsReceipt([])})
    expect(html).toContain('主机返回空认领列表');expect(html).not.toContain('>空闲<')
  })
  it('shows all three candidate statuses independently', async()=>{
    const html=await renderPanel({bundle:ownedBundle()})
    expect(html).toContain('未核验');expect(html).toContain('尚无评审');expect(html).toContain('待决定')
    expect(html).not.toContain('已接受')
  })
  it('an accepted review does not rewrite verification or acceptance', async()=>{
    const html=await renderPanel({bundle:ownedBundle({reviews:[review('cand-a','accepted')]})})
    expect(html).toMatch(/data-fact="review"[\s\S]*?已通过/)
    expect(html).toContain('未核验');expect(html).toContain('待决定');expect(html).not.toContain('已接受')
  })
  it('failed technical verification remains distinct from a pending review', async()=>{
    const html=await renderPanel({bundle:ownedBundle({verifications:[verification('cand-a','failed')]})})
    expect(html).toContain('未通过');expect(html).toContain('尚无评审');expect(html).toContain('待决定')
  })
  it('a registered file without a candidate cannot acquire review or acceptance', async()=>{
    const html=await renderPanel({bundle:bundle({artifacts:[artifact('art-a')]})})
    expect(html.split('尚未关联候选成果').length-1).toBe(3);expect(html).toContain('已登记')
    expect(html).not.toContain('待决定');expect(html).not.toContain('已接受')
  })
  it('missing declaration is unavailable, not an empty claim list', async()=>{
    const html=await renderPanel({declaration:null})
    expect(html).toContain('当前连接没有提供认领信息');expect(html).toContain('not_declared')
    expect(html).not.toContain('主机返回空认领列表')
  })
  it('RPC failures stay visible rather than becoming nobody-is-working', async()=>{
    const request=vi.fn().mockRejectedValue(new Error('connection lost'))
    const facts=await readV2RunFacts({port:port(request),declaration:declared(CLAIMS_LIST_METHOD),missionId:'rvm_1',bundle:bundle(),thread:thread()})
    const html=renderToStaticMarkup(<V2BotStatusPanel facts={facts} bundle={bundle()} onArtifact={()=>{}}/>)
    expect(html).toContain('读取失败：');expect(html).toContain('connection lost');expect(html).not.toContain('主机返回空认领列表')
  })
  it('malformed responses stay unknown', async()=>{
    const html=await renderPanel({receipt:{weird:true}})
    expect(html).toContain('回执无法识别');expect(html).not.toContain('主机返回空认领列表')
  })
  it('does not bake loopback development observations into current product facts', async()=>{
    const html=await renderPanel({})
    expect(html).not.toContain('Loopback');expect(html).not.toContain('当前真实 Provider 未核验')
    expect(html).not.toContain('模型请求尚未经实际回执验证');expect(html).not.toContain('mockProvider=true')
    expect(html).toContain('来源与诊断');expect(html).toContain('interface_not_available')
    expect(html).not.toMatch(/<details[^>]*\sopen/)
  })
  it('opening a file is the only artifact action, never acceptance', async()=>{
    const html=await renderPanel({bundle:ownedBundle()})
    expect(html).toContain('打开产物：report.md');expect(html).toContain('>report.md</strong>')
    expect(html).not.toMatch(/>确认接受<|>自动批准<|\d+\s*%/)
  })
  it('rejects a bundle from a different work before exposing file actions', async()=>{
    const b=ownedBundle();const facts=await readV2RunFacts({port:port(vi.fn().mockResolvedValue(claimsReceipt([]))),declaration:declared(CLAIMS_LIST_METHOD),missionId:'rvm_1',bundle:b,thread:thread()})
    const other={...b,mission:{...b.mission,missionId:'other'}}
    const html=renderToStaticMarkup(<V2BotStatusPanel facts={facts} bundle={other} onArtifact={()=>{}}/>)
    expect(html).toContain('工作上下文已变化');expect(html).not.toContain('打开产物：')
  })
})
