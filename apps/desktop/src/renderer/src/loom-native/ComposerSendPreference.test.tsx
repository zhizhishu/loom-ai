import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import {
  COMPOSER_SEND_MODE_STORAGE_KEY,
  ComposerSendPreference,
  composerPrimaryEnterLabel,
  composerSendModeDescription,
  readComposerSendMode,
  readWebComposerSendMode,
  subscribeWebComposerSendMode,
  toggleComposerSendMode,
  writeWebComposerSendMode
} from './ComposerSendPreference'

// 「回车发送」是一个开关，不是两个单选：Mikka 设置行 + product.css 的 .ln-toggle。
describe('the preference is one switch named 回车发送', () => {
  it('renders a single switch that defaults to on (回车发送)', () => {
    const html = renderToStaticMarkup(createElement(ComposerSendPreference))
    expect(html.match(/role="switch"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="回车发送"')
    expect(html).toContain('ln-settings-row-title')
    expect(html).toContain('回车发送')
    expect(html).toContain('aria-checked="true"')
    expect(html).toContain(composerSendModeDescription('enter', 'darwin'))
    // 没有单选组，也没有把「发送方式」拆成两个选项。
    expect(html).not.toContain('type="radio"')
    expect(html).not.toContain('radiogroup')
    expect(html).not.toContain('role="alert"')
  })
})

describe('the switch flips between 回车发送 and 主修饰键 + 回车发送', () => {
  it('toggles in both directions', () => {
    expect(toggleComposerSendMode('enter')).toBe('primary-enter')
    expect(toggleComposerSendMode('primary-enter')).toBe('enter')
  })

  it('describes what the off state does on each platform', () => {
    expect(composerSendModeDescription('enter', 'darwin')).toBe('Enter 发送，Shift + Enter 换行')
    expect(composerSendModeDescription('primary-enter', 'darwin')).toBe('Enter 换行，⌘ + Enter 发送')
    expect(composerSendModeDescription('primary-enter', 'win32')).toBe('Enter 换行，Ctrl + Enter 发送')
    expect(composerPrimaryEnterLabel('darwin')).toBe('⌘ + Enter')
    expect(composerPrimaryEnterLabel('linux')).toBe('Ctrl + Enter')
  })
})

describe('stored values fall back to the default (on)', () => {
  it('reads only the two known modes', () => {
    expect(readComposerSendMode(null)).toBe('enter')
    expect(readComposerSendMode(undefined)).toBe('enter')
    expect(readComposerSendMode('')).toBe('enter')
    expect(readComposerSendMode('  PRIMARY-ENTER ')).toBe('primary-enter')
    expect(readComposerSendMode('primary-enter')).toBe('primary-enter')
    expect(readComposerSendMode('nonsense')).toBe('enter')
  })
})

describe('the web fallback keeps the value the user just tried to save', () => {
  it('shows the attempted value even when the write fails and storage still holds the old one', () => {
    const store = new Map<string, string>([[COMPOSER_SEND_MODE_STORAGE_KEY, 'enter']])
    let failing = true
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { if (failing) throw new Error('quota'); store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) }
    })
    try {
      expect(readWebComposerSendMode()).toBe('enter')
      writeWebComposerSendMode('primary-enter')
      // 存储里仍是旧的 'enter'，但用户看到的是刚点过的值。
      expect(store.get(COMPOSER_SEND_MODE_STORAGE_KEY)).toBe('enter')
      expect(readWebComposerSendMode()).toBe('primary-enter')
      failing = false
      writeWebComposerSendMode('enter')
      expect(readWebComposerSendMode()).toBe('enter')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not resurrect a value another tab cleared', () => {
    const handlers = new Map<string, (event: { key: string | null }) => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: (event: { key: string | null }) => void) => { handlers.set(type, handler) },
      removeEventListener: (type: string) => { handlers.delete(type) }
    })
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) }
    })
    const listener = vi.fn()
    const unsubscribe = subscribeWebComposerSendMode(listener)
    try {
      writeWebComposerSendMode('primary-enter')
      expect(readWebComposerSendMode()).toBe('primary-enter')
      // 另一个标签页清掉了这个键：本页回到默认，不把旧值当成还有效。
      store.delete(COMPOSER_SEND_MODE_STORAGE_KEY)
      handlers.get('storage')?.({ key: COMPOSER_SEND_MODE_STORAGE_KEY })
      expect(listener).toHaveBeenCalled()
      expect(readWebComposerSendMode()).toBe('enter')
    } finally {
      unsubscribe()
      vi.unstubAllGlobals()
      writeWebComposerSendMode('enter')
    }
  })
})

describe('a successful write leaves no in-memory copy behind', () => {
  it('reads the stored value on remount after another tab replaces it while no listeners are left', () => {
    const handlers = new Map<string, (event: { key: string | null }) => void>()
    vi.stubGlobal('window', {
      addEventListener: (type: string, handler: (event: { key: string | null }) => void) => { handlers.set(type, handler) },
      removeEventListener: (type: string) => { handlers.delete(type) }
    })
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => { store.set(key, value) },
      removeItem: (key: string) => { store.delete(key) }
    })
    const unsubscribe = subscribeWebComposerSendMode(vi.fn())
    try {
      // 写成功：存储里是 'primary-enter'，内存里不留副本。
      expect(writeWebComposerSendMode('primary-enter')).toBe('primary-enter')
      expect(store.get(COMPOSER_SEND_MODE_STORAGE_KEY)).toBe('primary-enter')
      // 所有订阅者卸载：本页没有监听者，别的标签页改存储时收不到 storage 事件。
      unsubscribe()
      expect(handlers.size).toBe(0)
      store.set(COMPOSER_SEND_MODE_STORAGE_KEY, 'enter')
      // 重新挂载必须读存储现状（回车发送），不能拿写成功时留下的旧副本让 Enter 换行。
      expect(readWebComposerSendMode()).toBe('enter')
    } finally {
      unsubscribe()
      // 在 stub 还在时写回默认：顺带把内存副本清空，不给后面的用例留状态。
      writeWebComposerSendMode('enter')
      vi.unstubAllGlobals()
    }
  })
})
