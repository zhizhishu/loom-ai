/** Validate without normalizing the supplied address or guessing a protocol. */
export function isWebUrl(value: string): boolean {
  if (!/^https?:\/\//iu.test(value) || /[\s\u0000-\u001f\u007f\\]/u.test(value)) return false
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && Boolean(url.hostname)
  } catch { return false }
}
