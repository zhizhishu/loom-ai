import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { missionAttachmentDrafts, missionLocalAttachmentView, type MissionDraftAttachment } from './MissionDefinitionEditor'
import { attachmentFormatLabel } from './attachment-presentation'
import type { AgentProfile, MissionDescriptionContent, MissionRecord } from '@contracts'
import { MissionDescription } from './MissionDescription'
import { MissionPeopleProvider } from './MissionControls'
import { missionContentFromDocument, missionDescriptionContent, missionDescriptionDocument, missionDescriptionText, missionMentionIds, unavailableMissionMentionIds } from './mission-description'

describe('Mission description identity and repair', () => {
  it('round-trips ordered identities and literal @ text while resolving current names', () => {
    const content: MissionDescriptionContent = [
      { kind: 'text', text: '请 @手写名字 与 ' },
      { kind: 'member_mention', agentId: 'alice' },
      { kind: 'text', text: '\n复核：' },
      { kind: 'member_mention', agentId: 'alice' }
    ]
    expect(missionContentFromDocument(missionDescriptionDocument(content))).toEqual(content)
    expect(missionMentionIds(content)).toEqual(['alice'])
    expect(missionDescriptionText(content, [{ agentId: 'alice', displayName: '新名字' }])).toBe('请 @手写名字 与 @新名字\n复核：@新名字')
    expect(missionMentionIds(missionDescriptionContent('@新名字'))).toEqual([])
  })

  it('allows active away references and requires unavailable references to be removed', () => {
    const content: MissionDescriptionContent = ['present', 'away', 'removed', 'missing']
      .map(agentId => ({ kind: 'member_mention', agentId }))
    const agents = ['present', 'away', 'removed'].map(presence => ({ agentId: presence, presence })) as AgentProfile[]
    expect(unavailableMissionMentionIds(content, agents, ['away'])).toEqual(['removed', 'missing'])
    expect(unavailableMissionMentionIds(content, agents, [])).toEqual(['away', 'removed', 'missing'])
    expect(unavailableMissionMentionIds(content, agents, ['away'], ['present'])).toEqual(['present', 'removed', 'missing'])
    expect(unavailableMissionMentionIds([], agents, [], ['present'])).toEqual([])
  })

  it('decorates only web URLs while retaining literal text and ordered member identities', () => {
    const content: MissionDescriptionContent = [
      { kind: 'text', text: '参考 https://example.com/plan，交给 ' },
      { kind: 'member_mention', agentId: 'alice' },
      { kind: 'text', text: '\n**原文** [网页](http://example.com/info) [文件](docs/plan.md) javascript:alert(1)' }
    ]
    const agents = [{ agentId: 'alice', displayName: '新名字', presence: 'present' }] as AgentProfile[]
    const mission = { description: '', descriptionContent: content, memberAgentIds: ['alice'] } as MissionRecord
    const before = JSON.stringify(mission)
    const markup = renderToStaticMarkup(createElement(MissionPeopleProvider, { agents, children: createElement(MissionDescription, { mission }) }))
    expect(markup.replace(/<[^>]*>/gu, '')).toBe(missionDescriptionText(content, agents))
    expect(markup.match(/<a /gu)).toHaveLength(2)
    expect(markup.match(/data-resource-type="web"/gu)).toHaveLength(2)
    expect(markup).toContain('aria-label="查看新名字的基础信息"')
    expect(markup).not.toContain('rovai-file-reference')
    expect(markup).not.toContain('<strong>')
    expect(markup).not.toContain('href="javascript:')
    expect(JSON.stringify(mission)).toBe(before)
  })

  it('keeps legacy literal mentions when adding web link presentation', () => {
    const mission = { description: '@手写名字 https://example.com/legacy', memberAgentIds: [] } as unknown as MissionRecord
    const markup = renderToStaticMarkup(createElement(MissionDescription, { mission }))
    expect(markup.replace(/<[^>]*>/gu, '')).toBe(mission.description)
    expect(markup).toContain('data-resource-type="web"')
    expect(markup).not.toContain('message-mention-token')
  })
})

describe('Mission attachment presentation', () => {
  it('preserves a dragged directory hint for retry and presents it as DIR', () => {
    const file = new File([], '需求资料')
    const attachment: MissionDraftAttachment = {
      kind: 'local',
      id: 'mission-directory',
      file,
      kindHint: 'directory'
    }

    expect(missionAttachmentDrafts([attachment])).toEqual([{
      id: 'mission-directory',
      file,
      kindHint: 'directory'
    }])
    const view = missionLocalAttachmentView(attachment)
    expect(view).toEqual({
      id: 'mission-directory',
      displayName: '需求资料',
      kind: 'directory',
      fileCount: null,
      mediaType: 'inode/directory',
      byteSize: null,
      previewKind: 'none',
      availability: 'unknown'
    })
    expect(attachmentFormatLabel(view.displayName, view.kind)).toBe('DIR')
  })
})
