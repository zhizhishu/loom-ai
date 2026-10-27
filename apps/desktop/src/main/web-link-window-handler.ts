import { isWebUrl } from '../web-url'

/** The existing new-window channel owns external launch and its native failure UI. */
export function webLinkWindowHandler(open: (url: string) => Promise<void>, failed: () => Promise<unknown>) {
  return ({ url }: { url: string }): { action: 'deny' } => {
    if (isWebUrl(url)) {
      void (async () => {
        try { await open(url) }
        catch { await failed() }
      })().catch(() => undefined)
    }
    return { action: 'deny' }
  }
}
