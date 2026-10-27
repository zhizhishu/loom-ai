import type { AppearanceSnapshot, ThemeId } from '@contracts'
import type { BrowserWindow, BrowserWindowConstructorOptions } from 'electron'
import { resolveThemeId } from '../shared/appearance'

type WindowAppearance = Pick<AppearanceSnapshot, 'preference' | 'resolvedTheme'>

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  'autoHideMenuBar' | 'frame' | 'titleBarOverlay' | 'titleBarStyle' | 'trafficLightPosition'
>
type TitleBarOverlayOptions = Exclude<
  BrowserWindowConstructorOptions['titleBarOverlay'],
  boolean | undefined
>

const MACOS_TRAFFIC_LIGHT_POSITION = { x: 12, y: 14 } as const
const WINDOWS_TITLE_BAR_OVERLAYS: Record<ThemeId, TitleBarOverlayOptions> = {
  day: {
    color: '#f3f4f4',
    symbolColor: '#171b20'
  },
  night: {
    color: '#11161a',
    symbolColor: '#e7ecef'
  },
  horizon: {
    color: '#f3f1ec',
    symbolColor: '#30322f'
  },
  'classic-red': {
    color: '#f8f5f6',
    symbolColor: '#2b292c'
  },
  ember: {
    color: '#242424',
    symbolColor: '#e6e6e6'
  }
}

export function windowsTitleBarOverlay(appearance: WindowAppearance): TitleBarOverlayOptions {
  const theme = resolveThemeId(appearance.preference, appearance.resolvedTheme)
  return { ...WINDOWS_TITLE_BAR_OVERLAYS[theme] }
}

export function windowChromeOptions(
  platform: NodeJS.Platform,
  appearance: WindowAppearance
): WindowChromeOptions {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hidden',
      trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION
    }
  }
  if (platform === 'win32') {
    return {
      autoHideMenuBar: false,
      frame: true,
      titleBarStyle: 'hidden',
      titleBarOverlay: windowsTitleBarOverlay(appearance)
    }
  }
  return { frame: true }
}

export function applyWindowChromeAppearance(
  window: Pick<BrowserWindow, 'setTitleBarOverlay'>,
  platform: NodeJS.Platform,
  appearance: WindowAppearance
): void {
  if (platform === 'win32') window.setTitleBarOverlay(windowsTitleBarOverlay(appearance))
}
