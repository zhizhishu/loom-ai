/** Display-only prefix. Decode a chunk at a time, stopping once the card has enough text. */
export function pastedTextPreview(bytes: Uint8Array): string {
  const decoder = new TextDecoder('utf-8')
  let preview = ''
  let count = 0
  let space = false
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    const end = Math.min(offset + 4096, bytes.length)
    const chunk = decoder.decode(bytes.subarray(offset, end), { stream: end < bytes.length })
    for (const character of chunk) {
      if (/[\s\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/u.test(character)) {
        space = count > 0
        continue
      }
      if (space && count < 160) { preview += ' '; count++ }
      if (count === 160) return preview.trimEnd()
      preview += character
      space = false
      if (++count === 160) return preview
    }
  }
  return preview
}
