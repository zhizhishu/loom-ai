export interface PageZoomKeyboardInput {
  type: string
  key: string
  code: string
  isComposing: boolean
  control: boolean
  alt: boolean
  meta: boolean
}

export type PageZoomAction = 'in' | 'out' | 'reset'

export function pageZoomAction(
  input: PageZoomKeyboardInput,
  platform: NodeJS.Platform
): PageZoomAction | null {
  if (input.type !== 'keyDown' || input.isComposing || input.alt) return null
  const primaryModifier = platform === 'darwin' ? input.meta : input.control
  const secondaryModifier = platform === 'darwin' ? input.control : input.meta
  if (!primaryModifier || secondaryModifier) return null

  if (input.key === '-' || input.code === 'Minus' || input.code === 'NumpadSubtract') {
    return 'out'
  }
  if (input.key === '=' || input.key === '+' || input.code === 'Equal' || input.code === 'NumpadAdd') {
    return 'in'
  }
  if (input.key === '0' || input.code === 'Digit0' || input.code === 'Numpad0') {
    return 'reset'
  }
  return null
}

/** Bindings retain the logical key, not its physical code. Include the admitted
 * aliases produced by Shift+Minus and NumLock-off Numpad0 as well. */
export function reservedPageZoomShortcut(binding: string, platform: NodeJS.Platform): PageZoomAction | null {
  const parts = binding.split('+'), key = parts.pop() ?? ''
  return pageZoomAction({ type: 'keyDown', isComposing: false,
    key: key === 'Plus' ? '+' : key,
    code: key === '_' ? 'Minus' : key === 'Insert' ? 'Numpad0' : '',
    meta: platform === 'darwin' ? parts.includes('Mod') : parts.includes('Meta'),
    control: platform === 'darwin' ? parts.includes('Ctrl') : parts.includes('Mod'),
    alt: parts.includes('Alt') }, platform)
}
