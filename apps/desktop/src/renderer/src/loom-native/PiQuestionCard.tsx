import { useRef, useState } from 'react'
import { readErrorMessage } from '../error-message'
import type { PiAnswer, PiQuestion } from './pi-questions'
import { Icon } from './icons'

export function PiQuestionCard({ question, name, onAnswer }: {
  question: PiQuestion; name: string; onAnswer(question: PiQuestion, answer: PiAnswer): Promise<void>
}) {
  const request = question.request
  const [value, setValue] = useState(request.prefill ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef(false)
  const submit = async (answer: PiAnswer) => {
    if (inflight.current) return
    inflight.current = true; setBusy(true); setError(null)
    try { await onAnswer(question, answer) }
    catch (failure) { setError(readErrorMessage(failure)) }
    finally { inflight.current = false; setBusy(false) }
  }
  return <section className="ln-approval-request ln-question-request" aria-label="等你回答" aria-busy={busy}>
    <strong><Icon name="chat" size={16}/>{name}<span className="ln-approval-state">等你回答</span></strong>
    <p>{request.title}</p>{request.message && <p>{request.message}</p>}
    {(request.method === 'input' || request.method === 'editor') && <form onSubmit={event => { event.preventDefault(); void submit({ value }) }}>
      {request.method === 'editor'
        ? <textarea aria-label={request.title} value={value} disabled={busy} onChange={event => setValue(event.target.value)}/>
        : <input aria-label={request.title} placeholder={request.placeholder ?? ''} value={value} disabled={busy} onChange={event => setValue(event.target.value)}/>}
      <button type="submit" disabled={busy}>{busy ? '正在提交…' : '提交回答'}</button>
    </form>}
    <div>{request.method === 'select' && request.options.map((option, index) => <button type="button" key={index} disabled={busy} onClick={() => { void submit({ value: option }) }}>{option}</button>)}
      {request.method === 'confirm' && <><button type="button" disabled={busy} onClick={() => { void submit({ confirmed: true }) }}>是</button><button type="button" disabled={busy} onClick={() => { void submit({ confirmed: false }) }}>否</button></>}
      <button type="button" disabled={busy} onClick={() => { void submit({ cancelled: true }) }}>取消</button>
    </div>
    {error && <p role="alert" className="ln-inline-error">{error}</p>}
  </section>
}
