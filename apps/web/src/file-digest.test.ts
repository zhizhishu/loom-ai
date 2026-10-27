import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { fileDigest } from './file-digest'

it('hashes bounded slices with the original SHA-256 result and honors cancellation', async () => {
  for (const text of ['', '你好🌸', 'hello🌸'.repeat(100_000)]) {
    const file = new Blob([text])
    const slice = file.slice.bind(file)
    file.arrayBuffer = async () => { throw Error('Complete buffering is forbidden') }
    file.slice = (start = 0, end = file.size) => {
      expect(end - start).toBeLessThanOrEqual(256 * 1024)
      return slice(start, end)
    }
    expect(await fileDigest(file, new AbortController().signal)).toBe(createHash('sha256').update(text).digest('hex'))
  }
  const abort = new AbortController(); abort.abort()
  await expect(fileDigest(new Blob(['file']), abort.signal)).rejects.toMatchObject({ name: 'AbortError' })
})
