import { sha256 } from '@noble/hashes/sha2.js'

/** Bound both the temporary buffer and each synchronous hash update. Yield
 * between chunks so hashing a large upload cannot monopolize the UI thread. */
export async function fileDigest(file: Blob, signal: AbortSignal): Promise<string> {
  const digest = sha256.create()
  try {
    for (let offset = 0; offset < file.size; offset += 256 * 1024) {
      signal.throwIfAborted()
      digest.update(new Uint8Array(await file.slice(offset, offset + 256 * 1024).arrayBuffer()))
      if (offset + 256 * 1024 < file.size) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    signal.throwIfAborted()
    return Array.from(digest.digest(), byte => byte.toString(16).padStart(2, '0')).join('')
  } finally { digest.destroy() }
}
