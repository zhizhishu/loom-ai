import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadClient } from '../camp-client'
import { readErrorMessage } from '../error-message'

export interface PiQuestion {
  threadId: string
  agentRunId: string
  executionEpoch: number
  hostInstanceId: string
  agentId?: string
  taskId?: string | null
  status: 'waiting_for_user'
  request: { id: string; method: 'select' | 'input' | 'editor' | 'confirm'; title: string; options: string[]; message?: string | null; placeholder?: string | null; prefill?: string | null }
}
export type PiAnswer = { value: string } | { confirmed: boolean } | { cancelled: true }
export const questionKey = (question: PiQuestion): string => JSON.stringify([
  question.hostInstanceId, question.agentRunId, question.executionEpoch, question.request.id
])

export async function answerPiQuestion(client: Pick<ThreadClient, 'request'>, question: PiQuestion, answer: PiAnswer): Promise<void> {
  await client.request('pi.extensionUi.respond', {
    threadId: question.threadId, agentRunId: question.agentRunId,
    executionEpoch: question.executionEpoch, hostInstanceId: question.hostInstanceId,
    requestId: question.request.id, ...answer
  })
}

/** Read ephemeral questions on open/reconnect as well as events; polling also removes timed-out dialogs. */
export function usePiQuestions(client: ThreadClient) {
  const [questions, setQuestions] = useState<PiQuestion[]>([])
  const [error, setError] = useState<string | null>(null)
  const refreshRef = useRef<() => Promise<void>>(async () => {})
  useEffect(() => {
    let disposed = false
    let reading = false
    let refreshAgain = false
    setQuestions([])
    const refresh = async () => {
      if (reading) { refreshAgain = true; return }
      reading = true
      try {
        const next = await client.request<PiQuestion[]>('pi.extensionUi.pending', {})
        if (!disposed) { setQuestions(next); setError(null) }
      } catch (failure) {
        if (!disposed) setError(readErrorMessage(failure))
      } finally {
        reading = false
        if (refreshAgain && !disposed) { refreshAgain = false; void refresh() }
      }
    }
    refreshRef.current = refresh
    void refresh()
    const off = client.onEvent?.(event => {
      if (event.method === 'pi.extensionUi.changed' || event.method === 'agent_run.terminal' || event.method === 'agent_run.cancelled') void refresh()
    })
    const offInvalidated = client.onInvalidated?.(() => { void refresh() })
    const timer = setInterval(() => { void refresh() }, 1500)
    return () => { disposed = true; clearInterval(timer); off?.(); offInvalidated?.() }
  }, [client])
  const answer = useCallback(async (question: PiQuestion, response: PiAnswer) => {
    await answerPiQuestion(client, question, response)
    setQuestions(current => current.filter(item => questionKey(item) !== questionKey(question)))
    await refreshRef.current()
  }, [client])
  return { questions, error, answer }
}
