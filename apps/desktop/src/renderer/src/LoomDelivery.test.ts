import { describe, expect, it } from 'vitest'
import { loomArtifactLabel, loomDeliveryTitle, loomPreviewKind, previewFromResult } from './LoomDelivery'
import type { LoomArtifact, LoomTask } from '@contracts'

function artifact(overrides: Partial<LoomArtifact> & Pick<LoomArtifact, 'artifactId'>): LoomArtifact {
  return {
    planId: 'plan-1',
    taskId: 'task-1',
    agentRunId: null,
    relativePath: `${overrides.artifactId}.md`,
    sha256: 'a'.repeat(64),
    sizeBytes: 12,
    creatorId: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  } as LoomArtifact
}

function task(overrides: Partial<LoomTask> & Pick<LoomTask, 'taskId'>): LoomTask {
  return {
    planId: 'plan-1',
    title: '任务标题',
    status: 'ready',
    assigneeAgentId: null,
    blockedReason: null,
    createdAt: '2024-01-01T00:00:00.000Z',
    ...overrides
  } as LoomTask
}

describe('LoomDelivery 标题与文件名', () => {
  it('文件标题只取最后一段，不显示整条相对路径', () => {
    expect(loomArtifactLabel('docs/design/delivery.md')).toBe('delivery.md')
    expect(loomArtifactLabel('docs\\design\\delivery.md')).toBe('delivery.md')
    expect(loomArtifactLabel('delivery.md')).toBe('delivery.md')
  })

  it('任务名优先于文件名', () => {
    const artifacts = new Map([['artifact-1', artifact({ artifactId: 'artifact-1', relativePath: 'out/report.md' })]])
    const title = loomDeliveryTitle(
      { taskId: 'task-1', evidenceIds: ['artifact-1'] },
      [task({ taskId: 'task-1', title: '写交付说明' })],
      artifacts)
    expect(title).toBe('写交付说明')
  })

  it('没有任务或用空任务名时回落到第一份证据的文件名', () => {
    const artifacts = new Map([['artifact-1', artifact({ artifactId: 'artifact-1', relativePath: 'out/report.md' })]])
    expect(loomDeliveryTitle({ taskId: 'task-9', evidenceIds: ['artifact-1'] }, [], artifacts)).toBe('report.md')
    expect(loomDeliveryTitle(
      { taskId: 'task-1', evidenceIds: ['artifact-1'] },
      [task({ taskId: 'task-1', title: '   ' })],
      artifacts)).toBe('report.md')
  })

  it('拿不到任何标题时返回 null，由界面给中性占位', () => {
    expect(loomDeliveryTitle({ taskId: 'task-9', evidenceIds: [] }, [], new Map())).toBeNull()
    expect(loomDeliveryTitle({ taskId: 'task-9', evidenceIds: ['missing'] }, [], new Map())).toBeNull()
  })
})

describe('LoomDelivery 正文渲染方式', () => {
  it('Markdown 走 SafeMarkdown，其余按纯文本', () => {
    expect(loomPreviewKind('notes.md')).toBe('markdown')
    expect(loomPreviewKind('NOTES.MD')).toBe('markdown')
    expect(loomPreviewKind('notes.markdown')).toBe('markdown')
    expect(loomPreviewKind('report.json')).toBe('text')
    expect(loomPreviewKind('main.rs')).toBe('text')
    expect(loomPreviewKind('README')).toBe('text')
  })
})

describe('LoomDelivery 预览结果映射', () => {
  const base = {
    artifactId: 'artifact-1',
    relativePath: 'out/report.md',
    contentType: 'text/markdown',
    sizeBytes: 12,
    sha256: 'a'.repeat(64)
  }
  it('有正文就是 ready', () => {
    expect(previewFromResult({ ...base, text: '# 标题', unavailableReason: null }))
      .toEqual({ status: 'ready', text: '# 标题' })
  })
  it('Core 给的原因原样透传', () => {
    expect(previewFromResult({ ...base, text: null, unavailableReason: 'too_large' }))
      .toEqual({ status: 'unavailable', reason: 'too_large' })
    expect(previewFromResult({ ...base, text: null, unavailableReason: 'binary' }))
      .toEqual({ status: 'unavailable', reason: 'binary' })
  })
  it('没正文也没原因是读失败，不假装成 not_archived', () => {
    expect(previewFromResult({ ...base, text: null, unavailableReason: null }))
      .toMatchObject({ status: 'error' })
  })
})
