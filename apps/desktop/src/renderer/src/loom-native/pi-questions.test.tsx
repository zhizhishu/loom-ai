import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ThreadClient } from '../camp-client'
import { PiQuestionCard } from './PiQuestionCard'
import { answerPiQuestion, questionKey, type PiQuestion } from './pi-questions'
import { workStatus } from './Inspector'

const question: PiQuestion = {
  threadId: 'thread-1', agentRunId: 'run-1', executionEpoch: 3, hostInstanceId: 'host-1',
  taskId: 'task-1', status: 'waiting_for_user',
  request: { id: 'native-opaque-id', method: 'select', title: 'Which option?', options: ['A', 'B'] }
}

describe('Pi question card and action', () => {
  it('sends the exact native answer with its originating route, without creating a chat message', async () => {
    const calls: unknown[] = []
    const client = { request: async (method: string, params: unknown) => { calls.push([method, params]) } } as unknown as ThreadClient
    for (const answer of [{ value: 'B' }, { value: '' }, { confirmed: false }, { cancelled: true as const }]) {
      await answerPiQuestion(client, question, answer)
      expect(calls.at(-1)).toEqual(['pi.extensionUi.respond', {
        threadId: 'thread-1', agentRunId: 'run-1', executionEpoch: 3, hostInstanceId: 'host-1', requestId: 'native-opaque-id', ...answer
      }])
    }
    expect(questionKey({ ...question, executionEpoch: 4 })).not.toBe(questionKey(question))
    const failing = { request: async () => { throw new Error('stale request') } } as unknown as ThreadClient
    await expect(answerPiQuestion(failing, question, { value: 'B' })).rejects.toThrow('stale request')
  })

  it('renders all dialog forms, verbatim choices, editor prefill and explicit cancellation', () => {
    for (const method of ['select', 'input', 'editor', 'confirm'] as const) {
      const html = renderToStaticMarkup(<PiQuestionCard name="助手" question={{ ...question, request: {
        ...question.request, method, message: 'Details', placeholder: 'Write here', prefill: 'line 1\nline 2'
      } }} onAnswer={async () => {}}/>)
      expect(html).toContain('等你回答')
      expect(html).toContain('取消')
      expect(html).toContain('Which option?')
      if (method === 'select') { expect(html).toContain('>A</button>'); expect(html).toContain('>B</button>') }
      if (method === 'editor') { expect(html).toContain('<textarea'); expect(html).toContain('line 1\nline 2') }
      if (method === 'input') expect(html).toContain('placeholder="Write here"')
      if (method === 'confirm') { expect(html).toContain('>是</button>'); expect(html).toContain('>否</button>') }
    }
  })

  it('gives an actual pending question precedence in task presentation', () => {
    expect(workStatus({ waitingForAnswer: true } as Parameters<typeof workStatus>[0]))
      .toEqual({ label: '等你回答', group: '等待你', icon: 'chat' })
  })
})
