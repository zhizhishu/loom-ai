import { describe, expect, it } from 'vitest'
import { clampPanelWidth, storedPanelWidth, fittedPanelWidths } from './panel-resize'

describe('LOOM persisted split layout', () => {
  it('keeps a readable middle column when dragging either divider', () => {
    expect(clampPanelWidth('sidebar',450,1280,{ sidebar:264, inspector:470 },true,true)).toBe(450)
    expect(clampPanelWidth('sidebar',500,1020,{ sidebar:264, inspector:360 },true,true)).toBe(324)
    expect(clampPanelWidth('inspector',700,1280,{ sidebar:264, inspector:470 },true,true)).toBe(680)
    expect(clampPanelWidth('inspector',700,1280,{ sidebar:264, inspector:470 },false,true)).toBe(700)
  })
  it('fits saved panel widths to a changed RDP/virtual-monitor viewport',() => {
    const preferred={sidebar:264,inspector:470}
    expect(fittedPanelWidths(1440,preferred,true,true)).toEqual(preferred)
    expect(fittedPanelWidths(1024,preferred,true,true)).toEqual({sidebar:264,inspector:424})
    expect(fittedPanelWidths(801,preferred,true,true)).toEqual({sidebar:220,inspector:245})
    expect(fittedPanelWidths(1024,preferred,false,true)).toEqual({sidebar:0,inspector:470})
    // The return value is a fresh effective layout; saved preference is never overwritten.
    expect(preferred).toEqual({sidebar:264,inspector:470})
  })
  it('rejects invalid or gigantic stored widths', () => {
    expect(storedPanelWidth(null,264,'sidebar')).toBe(264)
    expect(storedPanelWidth('oops',264,'sidebar')).toBe(264)
    expect(storedPanelWidth('9999',264,'sidebar')).toBe(510)
    expect(storedPanelWidth('1',470,'inspector')).toBe(245)
  })
})
