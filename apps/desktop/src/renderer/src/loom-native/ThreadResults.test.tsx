import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { LoomArtifact, LoomCandidate, MissionRecord } from '@contracts'
import type { WorkBundle } from './types'
import { ThreadResults } from './ThreadResults'
import { threadResultEntries } from './thread-artifacts'

const artifact = (over: Partial<LoomArtifact>): LoomArtifact => ({
  artifactId: 'a1', planId: 'p1', taskId: 't1', agentRunId: 'r1',
  relativePath: 'out/report.md', sha256: 's', sizeBytes: 2048, contentType: null,
  creatorId: 'host', createdAt: '2026-11-26T10:00:00.000Z', ...over
})

const candidate = (over: Partial<LoomCandidate>): LoomCandidate => ({
  candidateId: 'c1', taskId: 't1', agentRunId: 'r1', contentHash: 'h', evidenceIds: ['a1'],
  acceptanceCriteria: { version: 'v1', criteria: [] }, previousCandidateId: null,
  verificationStatus: 'unverified', acceptanceStatus: 'accepted',
  createdAt: '2026-11-26T10:00:00.000Z', ...over
})

const bundle = (artifacts: LoomArtifact[], candidates: LoomCandidate[] = []): WorkBundle => ({
  mission: { missionId: 'm1', title: '发版', threadId: 'th-1' } as unknown as MissionRecord,
  plan: null, tasks: [], candidates, artifacts, reviews: [], verifications: []
})

const entries = threadResultEntries([bundle([
  artifact({ artifactId: 'a-plan', relativePath: 'docs/plans/auth-v1.md' }),
  artifact({ artifactId: 'a-code', relativePath: 'src/app.ts' }),
  artifact({ artifactId: 'a-report', relativePath: 'out/report.md' }),
  artifact({ artifactId: 'a-shot', relativePath: 'shots/run.png' }),
  artifact({ artifactId: 'a-video', relativePath: 'shots/demo.mp4', contentType: 'video/mp4' })
], [candidate({ candidateId: 'c-code', evidenceIds: ['a-code'], acceptanceStatus: 'accepted' })])], 'th-1')

describe('ThreadResults (成果段)', () => {
  it('draws one group per non-empty kind, each with its count, in the fixed order', () => {
    const html = renderToStaticMarkup(createElement(ThreadResults, { entries, onArtifact: () => {} }))
    expect(html).toContain('计划')
    expect(html).toContain('改动')
    expect(html).toContain('报告')
    expect(html).toContain('截图/录屏')
    expect(html).toContain('<h3>计划<span class="ln-result-count">1</span></h3>')
    expect(html).toContain('<h3>改动<span class="ln-result-count">1</span></h3>')
    expect(html).toContain('<h3>报告<span class="ln-result-count">1</span></h3>')
    expect(html).toContain('<h3>截图/录屏<span class="ln-result-count">2</span></h3>')
    expect(html.split('data-group="')).toHaveLength(5) // 四组 + 外层 aria 载体（空组不出现）
  })

  it('keeps the existing preview entry: every row carries the artifact and opens it through onArtifact', () => {
    const html = renderToStaticMarkup(createElement(ThreadResults, { entries, onArtifact: () => {} }))
    expect(html).toContain('data-artifact-id="a-plan"')
    expect(html).toContain('data-artifact-id="a-code"')
    expect(html).toContain('data-artifact-id="a-shot"')
    expect(html).toContain('data-artifact-id="a-video"')
    expect(html).toContain('data-capture-kind="video"')
    expect(html).toContain('ln-capture-grid')
    expect(html).toContain('ln-capture-play')
    expect(html).toContain('data-artifact-group="captures"')
    expect(html).toContain('aria-label="打开成果：auth-v1.md"')
    expect(html).toContain('已接受') // 候选状态词与聊天流产物卡一致
  })

  it('uses the shared empty pattern when the thread produced nothing', () => {
    const html = renderToStaticMarkup(createElement(ThreadResults, { entries: [], onArtifact: () => {} }))
    expect(html).toContain('data-slot="empty"')
    expect(html).toContain('data-slot="empty-icon"')
    expect(html).toContain('这场对话还没有成果')
    expect(html).toContain('助手交付的文件会归档在这里。')
    expect(html).not.toContain('ln-result-group')
    expect(html).not.toContain('ln-result-count')
  })
})
