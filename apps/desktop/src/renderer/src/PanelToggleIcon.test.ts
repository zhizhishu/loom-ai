import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PanelToggleIcon } from './PanelToggleIcon'

describe('PanelToggleIcon', () => {
  it.each([
    ['left', true, 'M7.5 3.5v13'],
    ['left', false, 'M4.5 6.5v7'],
    ['right', true, 'M12.5 3.5v13'],
    ['right', false, 'M15.5 6.5v7']
  ] as const)('shows the rounded %s window when visibility is %s', (side, visible, divider) => {
    const markup = renderToStaticMarkup(createElement(PanelToggleIcon, { side, visible }))

    expect(markup).toContain(`d="${divider}"`)
    expect(markup).toContain('rx="3"')
    expect(markup).toContain('fill="none"')
    expect(markup).toContain('aria-hidden="true"')
  })
})
