import { describe, expect, it } from 'vitest'
import { clampNavigationWidth, navigationDragLayout, navigationMaxWidth, parseNavigationLayout } from './navigation-layout'

describe('navigation layout preferences and collapse threshold', () => {
  it('recovers from corrupt storage and keeps a saved expanded width while collapsed', () => {
    for (const raw of [null, '{', 'null', 'false', '{"width":"300","collapsed":"true"}']) expect(parseNavigationLayout(raw)).toEqual({ width: 270, collapsed: false })
    expect(parseNavigationLayout('{"width":1e999}').width).toBe(270)
    expect(parseNavigationLayout('{"width":350,"collapsed":true}')).toEqual({ width: 350, collapsed: true })
    expect(parseNavigationLayout('{"width":0}').width).toBe(200)
    expect(parseNavigationLayout('{"width":900}').width).toBe(420)
  })
  it('uses the readable minimum as a snap threshold without erasing the pre-gesture width', () => {
    const before = { width: 350, collapsed: false }
    expect(navigationDragLayout(200, before, 420)).toEqual({ width: 200, collapsed: false })
    expect(navigationDragLayout(199, before, 420)).toEqual({ width: 350, collapsed: true })
    expect(navigationDragLayout(-10, before, 420)).toEqual({ width: 350, collapsed: true })
    expect(navigationDragLayout(260, { ...before, collapsed: true }, 420)).toEqual({ width: 260, collapsed: false })
    expect(navigationDragLayout(600, before, 300)).toEqual({ width: 300, collapsed: false })
  })
  it('reserves content space as a display constraint without changing the preference', () => {
    const saved = parseNavigationLayout('{"width":410}')
    expect(clampNavigationWidth(saved.width, navigationMaxWidth(900))).toBe(300)
    expect(clampNavigationWidth(saved.width, navigationMaxWidth(1440))).toBe(410)
    expect(navigationMaxWidth(520)).toBe(200)
  })
})
