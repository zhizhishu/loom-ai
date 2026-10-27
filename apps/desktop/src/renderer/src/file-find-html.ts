import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useShortcuts } from './ShortcutProvider'
import { useFileFindAdapter, useOptionalFileFind, type FileFindAdapter } from './FilePreviewFind'
import type { HtmlPreviewHostChannel } from '../../../../../packages/html-preview/src/host-channel'
import { useFilePreview } from './FilePreviewContext'
import type { FileFindDocument } from './file-find'

export function useHtmlFileFind(frame: RefObject<HTMLIFrameElement | null>, channel: HtmlPreviewHostChannel | null): void {
  const { resolvedTheme } = useFilePreview()
  const invalidate = useRef<(() => void) | null>(null)
  const shortcuts = useShortcuts()
  const shortcutState = useRef(shortcuts)
  shortcutState.current = shortcuts
  const binding = shortcuts?.snapshot?.preferences.bindings.find ?? null
  const platform = shortcuts?.platform
  const registry = useOptionalFileFind()
  const control = useRef(registry)
  control.current = registry
  const requests = useRef(new Map<number, { resolve(value: FileFindDocument[]): void; reject(error: Error): void }>())
  const sequence = useRef(0)
  const [ready, setReady] = useState<HtmlPreviewHostChannel | null>(null)
  useEffect(() => {
    if (!channel) return undefined
    const syncShortcut = (): void => {
      const current = shortcutState.current
      if (current) channel.send('find-shortcut', { binding: current.snapshot?.preferences.bindings.find ?? null, platform: current.platform })
    }
    const unsubscribe = channel.subscribe(message => {
      if (message.type === 'connecting') { setReady(null); invalidate.current?.(); return }
      if (message.type === 'find-invalidated') { invalidate.current?.(); return }
      if (message.type === 'connected') { syncShortcut(); return }
      if (message.type === 'find-ready') { syncShortcut(); setReady(channel); return }
      if (message.type === 'find-open') {
        const current = shortcutState.current
        if (!current) control.current?.controller?.open()
        else if (typeof message.binding === 'string' && message.binding === current.snapshot?.preferences.bindings.find
          && message.platform === current.platform && frame.current === document.activeElement
          && frame.current?.checkVisibility({ visibilityProperty: true, opacityProperty: true })) current.dispatch('find', frame.current)
        return
      }
      if (message.type === 'find-close') { control.current?.controller?.close(); return }
      if (message.type !== 'find-document' || !Number.isSafeInteger(message.requestId)) return
      const request = requests.current.get(message.requestId as number)
      if (!request) return
      if (typeof message.text === 'string' && message.text.length <= 8 * 1024 * 1024) request.resolve([{ id: 'html', text: message.text }])
      else request.reject(new Error('页面正文过大或已变化，暂时无法查找。'))
    })
    if (channel.connected) { syncShortcut(); setReady(channel) }
    return () => {
      unsubscribe()
      for (const request of requests.current.values()) request.reject(new DOMException('Aborted', 'AbortError'))
      requests.current.clear()
    }
  }, [channel, frame])
  useEffect(() => {
    if (platform) channel?.send('find-shortcut', { binding, platform })
  }, [channel, binding, platform])
  const adapter = useMemo<FileFindAdapter | null>(() => {
    if (!channel || ready !== channel) return null
    const send = (type: string, data: Record<string, unknown> = {}): void => channel.send(type, data)
    return {
      scopeLabel: '页面可见文本',
      subscribe(callback) { invalidate.current = callback; return () => { invalidate.current = null } },
      documents(_options, signal) {
        return new Promise((resolve, reject) => {
          if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return }
          const requestId = ++sequence.current
          const finish = (error?: Error, value?: FileFindDocument[]): void => {
            clearTimeout(timer)
            signal.removeEventListener('abort', abort)
            requests.current.delete(requestId)
            if (error) reject(error)
            else resolve(value ?? [])
          }
          const abort = (): void => finish(new DOMException('Aborted', 'AbortError'))
          const timer = setTimeout(() => finish(new Error('页面未响应查找，请重试。')), 1500)
          signal.addEventListener('abort', abort, { once: true })
          requests.current.set(requestId, { resolve: value => finish(undefined, value), reject: error => finish(error) })
          send('find-snapshot', { requestId })
        })
      },
      show(matches, current, scroll) {
        const style = frame.current ? getComputedStyle(frame.current) : null
        send('find-matches', { matches, current, scroll,
          colors: ['--conversation-find-match', '--conversation-find-current', '--ink'].map(name => style?.getPropertyValue(name).trim() ?? '') })
      },
      clear: () => send('find-clear'),
      focus: () => frame.current?.focus({ preventScroll: true })
    }
  }, [channel, frame, ready, resolvedTheme])
  useFileFindAdapter(adapter)
}
