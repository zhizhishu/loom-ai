import { useCallback, useEffect, useState } from 'react'
import type { ShortcutPreferences } from '@contracts'
import { useShortcuts } from '../ShortcutProvider'
import { SettingRow } from './SettingsPrimitives'
import './m9-3.css'

/**
 * 「发送消息」的偏好：回车发送（默认，与现有行为一致）或 Ctrl/⌘ + Enter 发送。
 *
 * 两个宿主一个口径：
 * - 桌面端（LoomApp 在 `ShortcutProvider` 里）用 provider 的 snapshot / save，发送键判定仍由
 *   `shared/shortcuts.ts` 的 `shouldSendComposerKey` 做，本文件不另立一套按键规则。
 *   设置还没读出来时按默认（回车发送）显示，**不读浏览器本地状态**，也不允许保存。
 * - Web 直连 LoomApp 没有 provider，退到 localStorage（默认同样是回车发送），同一文档内用
 *   模块级订阅广播；**只有写存储失败时**才记住「上次尝试的值」，不让读回的旧值盖掉它。
 *   写成功时内存里不留副本：订阅者全部卸载后别的标签页改了存储，重新挂载必须读到存储现状。
 *
 * 保存失败不假更新：桌面端 `save` 抛错时 snapshot 不会被改（provider 会重新读回服务端值），
 * 这里只把错误报出来。
 */
export type ComposerSendMode = ShortcutPreferences['sendMode']

export const COMPOSER_SEND_MODE_STORAGE_KEY = 'loom.composer.sendMode'
export const DEFAULT_COMPOSER_SEND_MODE: ComposerSendMode = 'enter'

/** 存下来的字符串 → 发送方式。缺失、无法识别一律回到默认（回车发送）。 */
export function readComposerSendMode(raw: string | null | undefined): ComposerSendMode {
  return (raw ?? '').trim().toLowerCase() === 'primary-enter' ? 'primary-enter' : DEFAULT_COMPOSER_SEND_MODE
}

export function serializeComposerSendMode(mode: ComposerSendMode): string { return mode }

/** 主修饰键 + Enter 的显示名（与 `useComposerSendShortcut` 同口径）。 */
export function composerPrimaryEnterLabel(platform: NodeJS.Platform): string {
  return platform === 'darwin' ? '⌘ + Enter' : 'Ctrl + Enter'
}

/** 开关的一次翻转：回车发送 ⇄ 主修饰键 + 回车发送。 */
export function toggleComposerSendMode(mode: ComposerSendMode): ComposerSendMode {
  return mode === 'enter' ? 'primary-enter' : 'enter'
}

/** 开关下面那行说明：开 = 回车发送，关 = 回车换行、主修饰键 + 回车发送。 */
export function composerSendModeDescription(mode: ComposerSendMode, platform: NodeJS.Platform): string {
  return mode === 'enter' ? 'Enter 发送，Shift + Enter 换行' : `Enter 换行，${composerPrimaryEnterLabel(platform)} 发送`
}

/** Web 直连没有 provider 的 platform，只能从浏览器读；读不到时按 mac 处理（与快捷键标签的兜底一致）。 */
export function detectComposerPlatform(): NodeJS.Platform {
  try {
    if (typeof navigator === 'undefined') return 'darwin'
    const source = `${navigator.platform ?? ''} ${navigator.userAgent ?? ''}`
    if (/mac|iphone|ipad|ipod/i.test(source)) return 'darwin'
    if (/win/i.test(source)) return 'win32'
    return 'linux'
  } catch { return 'darwin' }
}

const webListeners = new Set<() => void>()
/**
 * 本页最后一次**写失败**的值：存储被禁/超配额/不存在时，它才是用户看到的那个值。
 * 写成功时置空——否则没有监听者时别的标签页改了存储，重新挂载会读到这个旧副本。
 */
let attemptedMode: ComposerSendMode | null = null

function readBrowserStorage(): string | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage.getItem(COMPOSER_SEND_MODE_STORAGE_KEY) } catch { return null }
}

/** 当前 Web 偏好：写存储失败过就以那个值为准，否则读存储，最后才是默认。 */
export function readWebComposerSendMode(): ComposerSendMode {
  if (attemptedMode !== null) return attemptedMode
  const stored = readBrowserStorage()
  return stored === null ? DEFAULT_COMPOSER_SEND_MODE : readComposerSendMode(stored)
}

/** 写进浏览器存储；没有 localStorage、被禁或超配额时返回 false。 */
function writeBrowserStorage(mode: ComposerSendMode): boolean {
  try {
    if (typeof localStorage === 'undefined') return false
    localStorage.setItem(COMPOSER_SEND_MODE_STORAGE_KEY, serializeComposerSendMode(mode))
    return true
  } catch { return false }
}

/**
 * 写入并广播给同一文档的所有订阅者。
 * 写成功：清掉内存副本，之后一律读存储（别的标签页改过也不会被本页旧值盖住）。
 * 写失败：值留在内存里生效，免得读回的旧值盖掉用户刚点的那一下。
 */
export function writeWebComposerSendMode(mode: ComposerSendMode): ComposerSendMode {
  attemptedMode = writeBrowserStorage(mode) ? null : mode
  for (const listener of [...webListeners]) listener()
  return mode
}

/** 别的标签页改了这个键：以存储现状为准，丢掉本页的内存副本，被清掉就回到默认，不复活本页的旧值。 */
function adoptStoredComposerSendMode(): ComposerSendMode {
  attemptedMode = null
  return readWebComposerSendMode()
}

export function subscribeWebComposerSendMode(listener: () => void): () => void {
  webListeners.add(listener)
  // 同一文档靠上面的广播；别的标签页靠 storage 事件（key 为 null 表示整仓被清）。
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== COMPOSER_SEND_MODE_STORAGE_KEY && event.key !== null) return
    adoptStoredComposerSendMode()
    listener()
  }
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage)
  return () => {
    webListeners.delete(listener)
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage)
  }
}

export interface ComposerSendPreferenceState {
  sendMode: ComposerSendMode
  platform: NodeJS.Platform
  /** 桌面端由 ShortcutProvider 托管；Web 直连走 localStorage。 */
  managed: boolean
  /** 设置还没读出来：此时既不显示成「已改」，也不允许保存。 */
  loading: boolean
  saving: boolean
  error: string | null
  setSendMode(mode: ComposerSendMode): Promise<void>
}

export function useComposerSendPreference(): ComposerSendPreferenceState {
  const shortcuts = useShortcuts()
  // 桌面端不碰浏览器本地状态：只有没有 provider 时才在挂载时读一次。
  const [webMode, setWebMode] = useState<ComposerSendMode | null>(() => shortcuts ? null : readWebComposerSendMode())
  useEffect(() => {
    if (shortcuts) return
    setWebMode(readWebComposerSendMode())
    return subscribeWebComposerSendMode(() => setWebMode(readWebComposerSendMode()))
  }, [shortcuts])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = useCallback(async (mode: ComposerSendMode) => {
    if (!shortcuts) { setError(null); setWebMode(writeWebComposerSendMode(mode)); return }
    const snapshot = shortcuts.snapshot
    if (!snapshot) { setError('快捷键设置还没读出来，请稍后重试。'); return }
    setSaving(true); setError(null)
    try { await shortcuts.save({ ...snapshot.preferences, sendMode: mode }) }
    catch (cause) { setError(cause instanceof Error && cause.message ? cause.message : '无法保存发送方式，请重试。') }
    finally { setSaving(false) }
  }, [shortcuts])
  return {
    // 桌面端读到设置前一律按默认（回车发送）显示，不掺浏览器本地值。
    sendMode: shortcuts ? shortcuts.snapshot?.preferences.sendMode ?? DEFAULT_COMPOSER_SEND_MODE : webMode ?? DEFAULT_COMPOSER_SEND_MODE,
    platform: shortcuts?.platform ?? detectComposerPlatform(),
    managed: Boolean(shortcuts),
    loading: Boolean(shortcuts) && !shortcuts?.snapshot,
    saving,
    error,
    setSendMode: save
  }
}

/**
 * 可复用的设置项：一行「回车发送」开关（Mikka 的设置行 + `ln-toggle`）。
 * 等设置页挂载后由设置页消费；现在由 ConversationView 通过上面的 hook 消费同一个偏好。
 */
export function ComposerSendPreference(): React.JSX.Element {
  const { sendMode, platform, loading, saving, error, setSendMode } = useComposerSendPreference()
  const on = sendMode === 'enter'
  return <div className="ln-composer-preference" data-slot="composer-send-preference">
    <SettingRow title="回车发送" description={composerSendModeDescription(sendMode, platform)}>
      <button type="button" className="ln-toggle" role="switch" aria-checked={on} aria-label="回车发送"
        disabled={loading || saving} onClick={() => { void setSendMode(toggleComposerSendMode(sendMode)) }}><i/></button>
    </SettingRow>
    {error && <p className="ln-composer-preference-error" role="alert">{error}</p>}
  </div>
}
