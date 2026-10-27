import { readFileSync } from 'node:fs'
import type { ResolvedTheme, ThemePreference } from '@contracts'
import { describe, expect, it, vi } from 'vitest'

import {
  applyWindowChromeAppearance,
  windowChromeOptions,
  windowsTitleBarOverlay
} from './window-chrome'

const rendererStyles = readFileSync(new URL('../../../../packages/ui/src/theme.css', import.meta.url), 'utf8')

function themeToken(selector: string, token: string): string {
  const start = rendererStyles.indexOf(`${selector} {`)
  const end = rendererStyles.indexOf('\n}', start)
  const block = start >= 0 && end > start ? rendererStyles.slice(start, end) : ''
  const value = block.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1]?.trim()
  if (!value) throw new Error(`Missing ${token} in ${selector}`)
  return value
}

describe('window chrome', () => {
  it('preserves the existing hidden macOS title bar and traffic lights', () => {
    expect(windowChromeOptions('darwin', { preference: 'ember', resolvedTheme: 'night' })).toEqual({
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 12, y: 14 }
    })
  })

  it('hides the Windows title strip while preserving native controls', () => {
    const options = windowChromeOptions('win32', { preference: 'day', resolvedTheme: 'day' })
    expect(options).toEqual({
      autoHideMenuBar: false,
      frame: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#f3f4f4',
        symbolColor: '#171b20'
      }
    })
    expect(options).not.toHaveProperty('trafficLightPosition')
    expect(options.titleBarOverlay).not.toHaveProperty('height')
  })

  const preferences: ThemePreference[] = ['system', 'day', 'night', 'horizon', 'classic-red', 'ember']
  const modes: ResolvedTheme[] = ['day', 'night']
  it.each(preferences.flatMap(preference => modes.map(resolvedTheme => ({ preference, resolvedTheme }))))(
    'uses the $preference palette with $resolvedTheme mode at creation and on updates',
    appearance => {
      const theme = appearance.preference === 'system' ? appearance.resolvedTheme : appearance.preference
      const selector = theme === 'day' ? ':root'
        : theme === 'night' ? ':root[data-theme="night"]' : `:root[data-theme-id="${theme}"]`
      const expected = {
        color: themeToken(selector, '--rail'),
        symbolColor: themeToken(selector, '--ink')
      }
      expect(windowsTitleBarOverlay(appearance)).toEqual(expected)
      expect(windowChromeOptions('win32', appearance).titleBarOverlay).toEqual(expected)
      const setTitleBarOverlay = vi.fn()
      applyWindowChromeAppearance({ setTitleBarOverlay }, 'win32', appearance)
      expect(setTitleBarOverlay).toHaveBeenCalledExactlyOnceWith(expected)
    }
  )

  it.each(['darwin', 'linux'] as const)('does not set Windows overlay colors on %s', platform => {
    const setTitleBarOverlay = vi.fn()
    applyWindowChromeAppearance({ setTitleBarOverlay }, platform, { preference: 'classic-red', resolvedTheme: 'day' })
    expect(setTitleBarOverlay).not.toHaveBeenCalled()
  })

  it('leaves other desktop platforms on their native frame', () => {
    expect(windowChromeOptions('linux', { preference: 'day', resolvedTheme: 'day' })).toEqual({ frame: true })
  })
})
