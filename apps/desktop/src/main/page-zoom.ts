import { APPEARANCE_ZOOM_FACTORS, APPEARANCE_ZOOM_OPTIONS } from '../shared/appearance'
import type { PageZoomAction } from '../shared/page-zoom-shortcut'
export { pageZoomAction, type PageZoomAction, type PageZoomKeyboardInput } from '../shared/page-zoom-shortcut'
export { MIN_PAGE_ZOOM_PERCENTAGE, MAX_PAGE_ZOOM_PERCENTAGE } from '../shared/appearance'

export function pageZoomPercentage(zoomFactor: number): number | null {
  if (!Number.isFinite(zoomFactor) || zoomFactor <= 0) return null
  return Math.round(zoomFactor * 100)
}

export function pageZoomFactor(percentage: number): number {
  const index = APPEARANCE_ZOOM_OPTIONS.indexOf(percentage)
  return index === -1 ? percentage / 100 : APPEARANCE_ZOOM_FACTORS[index]
}

export function nextPageZoomPercentage(
  currentZoomFactor: number,
  action: PageZoomAction
): number | null {
  const currentPercentage = pageZoomPercentage(currentZoomFactor)
  if (currentPercentage === null) return null
  if (action === 'reset') return 100

  if (action === 'in') {
    return APPEARANCE_ZOOM_OPTIONS.find((percentage) => percentage > currentPercentage)
      ?? currentPercentage
  }

  return APPEARANCE_ZOOM_OPTIONS.findLast((percentage) => percentage < currentPercentage)
    ?? currentPercentage
}
