import { deflateSync } from 'node:zlib'
import {
  mkdir,
  readFile,
  rm,
  stat,
  utimes,
  writeFile
} from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MEMBER_AVATAR_LIMITS, inspectMemberAvatarUpload } from '@contracts'
import { browserMemberAvatars } from '../../../web/src/member-avatars'
import {
  inspectGif,
  inspectImage,
  inspectJpeg,
  inspectMemberAvatarSourceFile,
  inspectMemberAvatarUploadPng,
  inspectPng,
  MemberAvatarAssetService
} from './member-avatar-assets'

const temporaryDirectories: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  )
})

describe('member avatar image inspection', () => {
  it('sniffs PNG and JPEG from bytes rather than file extension', async () => {
    const directory = await temporaryDirectory()
    const png = makePng(512, 640)
    const misleadingPath = join(directory, 'portrait.jpg')
    await writeFile(misleadingPath, png)
    const selected = await inspectMemberAvatarSourceFile(misleadingPath)
    expect(selected.mediaType).toBe('image/png')
    expect(selected.displayName).toBe('portrait.jpg')
    expect([selected.inspectedWidth, selected.inspectedHeight]).toEqual([512, 640])
    expect(selected.byteLength).toBe(png.byteLength)

    const jpeg = makeJpegHeader(800, 600)
    expect(inspectJpeg(jpeg)).toEqual({
      mediaType: 'image/jpeg',
      width: 800,
      height: 600
    })
    expect(inspectImage(jpeg).mediaType).toBe('image/jpeg')
  })

  it('rejects animation, truncation, unsupported bytes and resource-heavy dimensions', async () => {
    const animated = makePng(512, 512, [
      pngChunk('acTL', u32Pair(2, 0))
    ])
    expect(() => inspectPng(animated)).toThrow('Animated PNG')
    expect(() => inspectPng(makePng(512, 512).subarray(0, 24))).toThrow()
    expect(() => inspectImage(Uint8Array.of(1, 2, 3, 4))).toThrow('Unsupported')

    const directory = await temporaryDirectory()
    const oversizedPixels = join(directory, 'huge.png')
    await writeFile(oversizedPixels, makePng(8000, 5000, [], false))
    await expect(inspectMemberAvatarSourceFile(oversizedPixels)).rejects.toThrow(
      'resource limit'
    )
  })

  it('accepts vendor metadata after IEND only at the upload boundary', async () => {
    const png = makePng(582, 584)
    const tail = new Uint8Array(281).fill(0x41)
    tail.set(new TextEncoder().encode(JSON.stringify({ vendor: 'vivo', meta: 'screenshot' })))
    const withTail = concat([png, tail])

    // ① Tolerant entry: same PNG passes and reports the exact canonical boundary.
    const upload = inspectMemberAvatarUploadPng(withTail)
    expect(upload.iendOffset).toBe(png.byteLength)
    expect(inspectMemberAvatarUpload(withTail).bytes).toEqual(png)
    expect([upload.width, upload.height]).toEqual([582, 584])

    // ② The shared strict parser is unchanged and rejects the same bytes.
    expect(() => inspectPng(withTail)).toThrow('Invalid PNG member avatar ending')
    expect(() => inspectImage(withTail)).toThrow('Invalid PNG member avatar ending')

    // ① The upload boundary returns the canonical PNG cropped before it
    // crosses into the renderer/native decoder.
    const directory = await temporaryDirectory()
    const path = join(directory, 'vivo-screenshot.png')
    await writeFile(path, withTail)
    const selected = await inspectMemberAvatarSourceFile(path)
    expect(selected.mediaType).toBe('image/png')
    expect([selected.inspectedWidth, selected.inspectedHeight]).toEqual([582, 584])
    expect(selected.byteLength).toBe(png.byteLength)
    expect(selected.bytes.byteLength).toBe(png.byteLength)
    expect(Array.from(selected.bytes)).toEqual(Array.from(png))
  })

  it('keeps the byte cap on the original input including the tail', async () => {
    const directory = await temporaryDirectory()
    const path = join(directory, 'oversized-tail.png')
    const padded = new Uint8Array(MEMBER_AVATAR_LIMITS.selectedFileBytes + 1024)
    padded.set(makePng(512, 512), 0)
    await writeFile(path, padded)
    await expect(inspectMemberAvatarSourceFile(path)).rejects.toThrow('byte limit')
  })

  it('sniffs animated GIF from bytes with frame and loop metadata', async () => {
    const gif = makeGif(512, 400, 2, 0)
    expect(inspectImage(gif)).toEqual({
      mediaType: 'image/gif',
      width: 512,
      height: 400,
      frameCount: 2,
      loopCount: 0
    })
    expect(inspectGif(makeGif(256, 256, 3, 5)).loopCount).toBe(5)
    expect(inspectGif(makeGif(256, 256, 1, null)).loopCount).toBeNull()
    // Browser file MIME is advisory: both clients sniff the same bytes.
    let changed: (() => void) | undefined
    const input = {
      files: [{ name: 'renamed.png', type: 'image/png', size: gif.byteLength, arrayBuffer: async () => gif.buffer }],
      addEventListener: (type: string, listener: () => void) => { if (type === 'change') changed = listener },
      click: () => changed?.(), remove: () => undefined
    }
    vi.stubGlobal('document', { createElement: () => input, body: { append: () => undefined } })
    const browser = browserMemberAvatars({ avatar: vi.fn() } as never)
    const browserImage = await browser.selectSource()
    expect(browserImage).toMatchObject({ mediaType: 'image/gif', frameCount: 2, loopCount: 0 })
    expect(browserImage?.bytes).toEqual(gif)
    const directory = await temporaryDirectory()
    const path = join(directory, 'animated.gif')
    await writeFile(path, gif)
    const selected = await inspectMemberAvatarSourceFile(path)
    expect(selected.mediaType).toBe('image/gif')
    expect([selected.inspectedWidth, selected.inspectedHeight]).toEqual([512, 400])
    expect(selected.frameCount).toBe(2)
    expect(selected.loopCount).toBe(0)
    expect(Array.from(selected.bytes)).toEqual(Array.from(gif))
    expect(selected.byteLength).toBe(gif.byteLength)
  })

  it('rejects GIF frame, dimension and cumulative decode limit violations', async () => {
    expect(() =>
      inspectGif(makeGif(256, 256, MEMBER_AVATAR_LIMITS.maximumGifFrames + 1, 0))
    ).toThrow('frame limit')
    expect(() => inspectGif(makeGif(4096, 4096, 10, 0))).toThrow(
      'cumulative decode resource limit'
    )
    expect(() => inspectGif(makeGif(255, 512, 1, 0))).not.toThrow()
    expect(() => inspectGif(makeGif(512, 512, 0, 0))).toThrow('contains no frames')
    const looping = makeGif(256, 256, 1, 3)
    for (let end = 0; end < looping.byteLength; end++) {
      expect(() => inspectGif(looping.subarray(0, end))).toThrow()
    }
    const outside = makeGif(256, 256, 1, null)
    writeU16LE(outside, 28, 256)
    expect(() => inspectGif(outside)).toThrow('canvas bounds')
    const unknownApp = Uint8Array.from(looping)
    unknownApp.set(new TextEncoder().encode('VENDOR01abc'), 22)
    expect(inspectGif(unknownApp)).toMatchObject({ frameCount: 1, loopCount: null })
    expect(() => inspectGif(makePng(512, 512))).toThrow('Unsupported')
  })
})

describe('managed member avatar asset service', () => {
  it('atomically saves and integrity-checks a compound avatar asset', async () => {
    const directory = await temporaryDirectory()
    const service = new MemberAvatarAssetService(directory)
    const sourcePng = makePng(256, 320)
    const iconPng = makePng(192, 192)
    const summary = await service.save({
      sourcePng,
      iconPng,
      sourceWidth: 256,
      sourceHeight: 320,
      crop: { centerX: 0.5, centerY: 0.5, size: 0.75 }
    })
    expect(summary.avatarRef).toMatch(
      /^rovai:\/\/member-avatar\/managed\/[0-9a-f-]{36}$/
    )

    const icon = await service.read(summary.avatarRef, 'icon')
    const portrait = await service.read(summary.avatarRef, 'portrait')
    expect(icon && [icon.width, icon.height]).toEqual([192, 192])
    expect(portrait && [portrait.width, portrait.height]).toEqual([256, 320])
    expect(icon?.crop).toEqual(summary.crop)
    expect(portrait?.crop).toEqual(summary.crop)
    expect(Array.from(icon?.bytes ?? [])).toEqual(Array.from(iconPng))
    expect(Array.from(portrait?.bytes ?? [])).toEqual(Array.from(sourcePng))

    const assetId = summary.avatarRef.split('/').at(-1) as string
    const assetDirectory = join(service.root, assetId)
    const manifest = JSON.parse(
      await readFile(join(assetDirectory, 'manifest.json'), 'utf8')
    ) as { source: { sha256: string }; icon: { sha256: string } }
    expect(manifest.source.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(manifest.icon.sha256).toMatch(/^[0-9a-f]{64}$/)
    if (process.platform !== 'win32') {
      expect((await stat(assetDirectory)).mode & 0o777).toBe(0o700)
      expect((await stat(join(assetDirectory, 'source.png'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(assetDirectory, 'icon-192.png'))).mode & 0o777).toBe(0o600)
      expect((await stat(join(assetDirectory, 'manifest.json'))).mode & 0o777).toBe(0o600)
    }
    expect(
      (await stat(service.root)).isDirectory()
    ).toBe(true)
    await expect(
      (await import('node:fs/promises')).readdir(service.root)
    ).resolves.not.toContainEqual(expect.stringMatching(/^\.tmp-/))
  })

  it('returns a controlled miss for unknown refs, corruption and traversal attempts', async () => {
    const directory = await temporaryDirectory()
    const service = new MemberAvatarAssetService(directory)
    const summary = await service.save({
      sourcePng: makePng(256, 256),
      iconPng: makePng(192, 192),
      sourceWidth: 256,
      sourceHeight: 256,
      crop: { centerX: 0.5, centerY: 0.5, size: 1 }
    })
    expect(await service.read('file:///tmp/avatar.png', 'icon')).toBeNull()
    expect(
      await service.read(
        'rovai://member-avatar/managed/../../outside',
        'portrait'
      )
    ).toBeNull()

    const assetId = summary.avatarRef.split('/').at(-1) as string
    await writeFile(join(service.root, assetId, 'icon-192.png'), makePng(191, 192))
    expect(await service.read(summary.avatarRef, 'icon')).toBeNull()
    expect(await service.read(summary.avatarRef, 'portrait')).not.toBeNull()
  })

  it('rejects invalid save payloads without publishing a final directory', async () => {
    const directory = await temporaryDirectory()
    const service = new MemberAvatarAssetService(directory)
    await expect(
      service.save({
        sourcePng: makePng(256, 256),
        iconPng: makePng(191, 192),
        sourceWidth: 256,
        sourceHeight: 256,
        crop: { centerX: 0.5, centerY: 0.5, size: 1 }
      })
    ).rejects.toThrow('192 by 192')
    await expect(
      service.save({
        sourcePng: makePng(256, 256),
        iconPng: makePng(192, 192),
        sourceWidth: 256,
        sourceHeight: 256,
        crop: { centerX: -1, centerY: 0.5, size: 1 }
      })
    ).rejects.toThrow('within source bounds')
    await expect(stat(service.root)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans only stale, strictly named temporary directories', async () => {
    const directory = await temporaryDirectory()
    const service = new MemberAvatarAssetService(directory)
    await mkdir(service.root, { recursive: true })
    const stale = `.tmp-${randomUUID()}`
    const fresh = `.tmp-${randomUUID()}`
    const final = randomUUID()
    const unrelated = '.tmp-not-an-avatar'
    for (const name of [stale, fresh, final, unrelated]) {
      await mkdir(join(service.root, name))
    }
    const now = Date.now()
    const oldSeconds = (now - 25 * 60 * 60 * 1000) / 1000
    await utimes(join(service.root, stale), oldSeconds, oldSeconds)
    const removed = await service.cleanupStaleTemporaryDirectories(now)
    expect(removed).toBe(1)
    const entries = await (await import('node:fs/promises')).readdir(service.root)
    expect(entries.sort()).toEqual([fresh, final, unrelated].sort())
  })
})

async function temporaryDirectory(): Promise<string> {
  const directory = join(tmpdir(), `rovai-member-avatar-test-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  temporaryDirectories.push(directory)
  return directory
}

function makePng(
  width: number,
  height: number,
  extraChunks: Uint8Array[] = [],
  includeImageData = true
): Uint8Array {
  const header = new Uint8Array(13)
  writeU32(header, 0, width)
  writeU32(header, 4, height)
  header[8] = 8
  header[9] = 6
  const chunks = [pngChunk('IHDR', header), ...extraChunks]
  if (includeImageData) {
    const rows = new Uint8Array((width * 4 + 1) * height)
    for (let row = 0; row < height; row += 1) {
      rows[row * (width * 4 + 1)] = 0
    }
    chunks.push(pngChunk('IDAT', deflateSync(rows)))
  }
  chunks.push(pngChunk('IEND', new Uint8Array()))
  return concat([
    Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
    ...chunks
  ])
}

function makeJpegHeader(width: number, height: number): Uint8Array {
  return Uint8Array.of(
    0xff, 0xd8,
    0xff, 0xc0,
    0x00, 0x08,
    0x08,
    (height >>> 8) & 0xff,
    height & 0xff,
    (width >>> 8) & 0xff,
    width & 0xff,
    0x01,
    0xff, 0xd9
  )
}

/** Structure-only GIF used to exercise the Main-side GIF walker. */
function makeGif(
  width: number,
  height: number,
  frameCount: number,
  loopCount: number | null
): Uint8Array {
  const parts: Uint8Array[] = [new TextEncoder().encode('GIF89a')]
  const lsd = new Uint8Array(7)
  writeU16LE(lsd, 0, width)
  writeU16LE(lsd, 2, height)
  lsd[4] = 0x80 | 0x00 // global color table, 2 entries
  parts.push(lsd)
  parts.push(Uint8Array.of(0, 0, 0, 255, 255, 255))
  if (loopCount !== null) {
    parts.push(
      Uint8Array.of(
        0x21, 0xff, 0x0b,
        0x4e, 0x45, 0x54, 0x53, 0x43, 0x41, 0x50, 0x45, 0x32, 0x2e, 0x30,
        0x03, 0x01,
        loopCount & 0xff,
        (loopCount >>> 8) & 0xff,
        0x00
      )
    )
  }
  for (let index = 0; index < frameCount; index += 1) {
    parts.push(Uint8Array.of(0x21, 0xf9, 0x04, 0x00, 0x0a, 0x00, 0x00, 0x00))
    const image = new Uint8Array(10)
    image[0] = 0x2c
    writeU16LE(image, 1, 0)
    writeU16LE(image, 3, 0)
    writeU16LE(image, 5, width)
    writeU16LE(image, 7, height)
    parts.push(image)
    parts.push(Uint8Array.of(0x08, 0x02, 0x00, 0x00, 0x00))
  }
  parts.push(Uint8Array.of(0x3b))
  return concat(parts)
}

function writeU16LE(target: Uint8Array, offset: number, value: number): void {
  target[offset] = value & 0xff
  target[offset + 1] = (value >>> 8) & 0xff
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type)
  const output = new Uint8Array(12 + data.byteLength)
  writeU32(output, 0, data.byteLength)
  output.set(typeBytes, 4)
  output.set(data, 8)
  writeU32(output, 8 + data.byteLength, crc32(concat([typeBytes, data])))
  return output
}

function u32Pair(first: number, second: number): Uint8Array {
  const value = new Uint8Array(8)
  writeU32(value, 0, first)
  writeU32(value, 4, second)
  return value
}

function writeU32(target: Uint8Array, offset: number, value: number): void {
  target[offset] = (value >>> 24) & 0xff
  target[offset + 1] = (value >>> 16) & 0xff
  target[offset + 2] = (value >>> 8) & 0xff
  target[offset + 3] = value & 0xff
}

function concat(parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(
    parts.reduce((total, part) => total + part.byteLength, 0)
  )
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.byteLength
  }
  return output
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
