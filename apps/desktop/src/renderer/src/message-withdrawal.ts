import type { StoredCommandResult, ThreadMessageView } from '@contracts'
import { newCommandId } from '../../shared/command-id'
import { uiAttribute } from './interface-language'
import { MessageReeditStore, messageReeditDocument, type WithdrawalRequest } from './message-reedit-store'

export interface WithdrawalResult { result: StoredCommandResult; source: 'direct' | 'recovery' }

/** Adapts only message withdrawal; no general command queue or background retry loop. */
export class MessageWithdrawal {
  private readonly inFlight = new Map<string, Promise<void>>()
  // Request identity outlives transport errors even when there is no text copy.
  // No body is retained here, and only explicit retries use these memory-only entries.
  private readonly unsettled = new Map<string, WithdrawalRequest>()
  constructor(private readonly options: {
    store: MessageReeditStore
    request(request: WithdrawalRequest): Promise<WithdrawalResult>
    accepted(threadId: string, messageId: string): void
    refresh(threadId: string): Promise<unknown>
    notify(message: string): void
    rejectionMessage(result: StoredCommandResult): string
  }) {}

  withdraw(threadId: string, message: ThreadMessageView): Promise<void> {
    if (message.withdrawn || !message.canWithdraw || message.id.startsWith('optimistic:')) return Promise.resolve()
    const previous = this.unsettled.get(this.key(threadId, message.id)) ?? this.options.store.requestFor(threadId, message.id)
    const request = previous ?? { commandId: newCommandId(), command: { threadId, messageId: message.id, expectedVersion: message.version } }
    const running = this.inFlight.get(request.commandId)
    if (running) return running
    const document = messageReeditDocument(message)
    if (!previous && document && !this.options.store.stage(request, document)) {
      this.options.notify(uiAttribute('未能保存恢复内容，本次撤回后无法重新编辑。'))
    }
    return this.perform(request, Boolean(previous), Boolean(document))
  }
  recoverPending = (): void => {
    for (const request of this.options.store.pending()) {
      void this.perform(request, true, true).catch(() => undefined)
    }
  }
  private key(threadId: string, messageId: string): string { return JSON.stringify([threadId, messageId]) }
  private perform(request: WithdrawalRequest, recovered: boolean, hasText: boolean): Promise<void> {
    const running = this.inFlight.get(request.commandId)
    if (running) return running
    this.unsettled.set(this.key(request.command.threadId, request.command.messageId), request)
    const task = this.execute(request, recovered, hasText).finally(() => { this.inFlight.delete(request.commandId) })
    this.inFlight.set(request.commandId, task)
    return task
  }
  private async execute(request: WithdrawalRequest, recovered: boolean, hasText: boolean): Promise<void> {
    let response: WithdrawalResult
    try { response = await this.options.request(request) }
    catch { throw new Error(uiAttribute('撤回结果尚未确认，请恢复连接后重试。')) }
    const { result, source } = response
    const { threadId, messageId } = request.command
    const key = this.key(threadId, messageId)
    if (this.unsettled.get(key)?.commandId === request.commandId) this.unsettled.delete(key)
    if (result.status === 'rejected') {
      this.options.store.reject(request)
      throw new Error(this.options.rejectionMessage(result))
    }
    const restored = this.options.store.confirm(request, recovered || source === 'recovery')
    if (hasText && !restored) this.options.notify(uiAttribute('已撤回，本次无法重新编辑。'))
    this.options.accepted(threadId, messageId)
    try { await this.options.refresh(threadId) }
    catch { this.options.notify(uiAttribute('消息已撤回，会话暂未刷新，请稍后重试。')) }
  }
}
