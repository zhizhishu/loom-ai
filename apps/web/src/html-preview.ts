import type { FilePreviewHtmlSite, FilePreviewOperationResult, FilePreviewTextContent } from '@contracts'
import { normalizeShortcut } from '../../../packages/contracts/src/shortcut-key'
import { previewBrowserBridge } from '../../../packages/html-preview/src/browser-bridge'
import { injectPreviewScript } from '../../../packages/html-preview/src/document'
import { createFileFindDomIndex } from '../../../packages/html-preview/src/find-dom'
import { parseHtmlPreviewDiagnostic } from '../../../packages/html-preview/src/protocol'
import type { ConsoleClient } from './client'
import { newCommandId } from '../../desktop/src/shared/command-id'

/** Only authorized document bytes are passed to the preview; source reads stay on
 * the Host API. Trusted HTML shares the browser origin and its native storage. */
export async function createBrowserHtmlPreview(transport: Pick<ConsoleClient, 'files'>, request: { handleId: string; expectedGeneration: string }): Promise<FilePreviewOperationResult<FilePreviewHtmlSite>> {
  const result = await transport.files<FilePreviewOperationResult<FilePreviewTextContent & { resourceBasePath?: string }>>('readHtml', request)
  if (!result.ok) return result
  if (result.value.contentGeneration !== request.expectedGeneration) {
    return { ok: false, error: { code: 'read_failed', message: '文件已变化，请重新打开。', retryable: true } }
  }
  const previewId = newCommandId(), generation = result.value.contentGeneration
  const entryUrl = `${location.origin}/preview.html#${previewId}.${generation}`
  // Use the same non-reserializing injection and bounded diagnostic/find bridge
  // as Desktop. The browser sandbox has no service-side diagnostic stream.
  const resourceBase = result.value.resourceBasePath ? new URL(result.value.resourceBasePath, location.origin).href : undefined
  const initial = injectPreviewScript(result.value.text, '', resourceBase)
  const config = { previewId, generation, documentId: newCommandId(), origin: location.origin, hostOrigin: location.origin,
    documentUrl: entryUrl, documentError: null, browserDocument: true, map: initial.map }
  const scriptUrl = (): string => {
    const source = `(${previewBrowserBridge.toString()})(${JSON.stringify(config)},${createFileFindDomIndex.toString()},${parseHtmlPreviewDiagnostic.toString()},${normalizeShortcut.toString()});`
    return `data:text/javascript;base64,${btoa(Array.from(new TextEncoder().encode(source), byte => String.fromCharCode(byte)).join(''))}`
  }
  let injected = injectPreviewScript(result.value.text, scriptUrl(), resourceBase)
  // Including the injection length in the bridge can change the script's length.
  // It converges once the decimal field has its final number of digits.
  for (let attempt = 0; attempt < 5 && config.map.length !== injected.map.length; attempt += 1) {
    config.map = injected.map
    injected = injectPreviewScript(result.value.text, scriptUrl(), resourceBase)
  }
  if (config.map.length !== injected.map.length) throw new Error('无法建立 HTML 预览。')
  return { ok: true, value: { previewId, generation, origin: location.origin, entryUrl, documentUrl: entryUrl,
    sandboxedDocument: injected.html, contentGeneration: generation, contentVersion: result.value.contentVersion } }
}
