import type { WebContents } from 'electron'
import { nextPageZoomPercentage, pageZoomAction, pageZoomFactor } from './page-zoom'

/** The same native input boundary is installed in Desktop and its isolated acceptance fixture. */
export function installPageZoomShortcut(contents: WebContents, platform: NodeJS.Platform, isRecording: () => boolean, onChange: (percentage: number) => void): void {
  contents.on('before-input-event', (event, input) => {
    if (isRecording()) return
    const action = pageZoomAction(input, platform)
    if (action === null) return
    event.preventDefault()
    const percentage = nextPageZoomPercentage(contents.getZoomFactor(), action)
    if (percentage === null) return
    contents.setZoomFactor(pageZoomFactor(percentage))
    onChange(percentage)
  })
}
