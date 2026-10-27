import { MEMBER_AVATAR_LIMITS, validateMemberAvatarDimensions } from './member-avatar'

type PngInspection = {
  mediaType: 'image/png'
  width: number
  height: number
}

type MemberAvatarUploadPngInspection = PngInspection & {
  /** Byte offset just past the final IEND chunk — the canonical PNG boundary. */
  iendOffset: number
}

type JpegInspection = {
  mediaType: 'image/jpeg'
  width: number
  height: number
}

type GifInspection = {
  mediaType: 'image/gif'
  width: number
  height: number
  frameCount: number
  loopCount: number | null
}

type ImageInspection = PngInspection | JpegInspection | GifInspection

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10] as const
const GIF_SIGNATURES = [
  [0x47, 0x49, 0x46, 0x38, 0x37, 0x61],
  [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]
] as const
export function inspectImage(bytes: Uint8Array): ImageInspection {
  if (hasPrefix(bytes, PNG_SIGNATURE)) return inspectPng(bytes)
  if (isGif(bytes)) return inspectGif(bytes)
  return inspectJpeg(bytes)
}

function isGif(bytes: Uint8Array): boolean {
  return GIF_SIGNATURES.some((signature) => hasPrefix(bytes, signature))
}

export function inspectGif(bytes: Uint8Array): GifInspection {
  if (!isGif(bytes)) throw new Error('Unsupported member avatar image type')
  if (bytes.byteLength < 13) throw new Error('Truncated GIF member avatar')
  const width = readU16LE(bytes, 6)
  const height = readU16LE(bytes, 8)
  if (width === 0 || height === 0) {
    throw new Error('Invalid GIF member avatar dimensions')
  }
  validateMemberAvatarDimensions(width, height)
  const packed = bytes[10]
  const globalTableBytes = packed & 0x80
    ? 3 << ((packed & 0x07) + 1)
    : 0
  let offset = 13 + globalTableBytes
  if (offset > bytes.byteLength) throw new Error('Truncated GIF member avatar')
  let frameCount = 0
  let loopCount: number | null = null
  let sawEnd = false
  while (offset < bytes.byteLength) {
    const block = bytes[offset]
    if (block === 0x3b) {
      sawEnd = true
      break
    }
    if (block === 0x21) {
      if (offset + 2 >= bytes.byteLength) throw new Error('Truncated GIF member avatar')
      offset += 2
      const label = bytes[offset - 1]
      if (label === 0xff) {
        const size = bytes[offset]
        offset += 1
        if (size !== 11 || offset + size >= bytes.byteLength) throw new Error('Invalid GIF application extension')
        const app = bytes.subarray(offset, offset + size)
        offset += size
        if (['NETSCAPE2.0', 'ANIMEXTS1.0'].includes(bytesToAscii(app))) {
          // Peek the loop-count sub-block; skipGifSubBlocks consumes it after.
          const sub = bytes[offset]
          if (sub === 3 && offset + 4 < bytes.byteLength) {
            const payload = bytes.subarray(offset + 1, offset + 4)
            if (payload[0] === 0x01) {
              loopCount = payload[1] | (payload[2] << 8)
            }
          }
        }
      }
      offset = skipGifSubBlocks(bytes, offset)
      continue
    }
    if (block === 0x2c) {
      if (offset + 10 >= bytes.byteLength) throw new Error('Truncated GIF member avatar')
      const left = readU16LE(bytes, offset + 1)
      const top = readU16LE(bytes, offset + 3)
      const frameWidth = readU16LE(bytes, offset + 5)
      const frameHeight = readU16LE(bytes, offset + 7)
      if (!frameWidth || !frameHeight || left + frameWidth > width || top + frameHeight > height) {
        throw new Error('GIF frame exceeds the canvas bounds')
      }
      frameCount += 1
      if (frameCount > MEMBER_AVATAR_LIMITS.maximumGifFrames) {
        throw new Error('Animated member avatar exceeds the frame limit')
      }
      offset += 9
      const imagePacked = bytes[offset]
      offset += 1
      const localTableBytes = imagePacked & 0x80
        ? 3 << ((imagePacked & 0x07) + 1)
        : 0
      offset += localTableBytes + 1
      offset = skipGifSubBlocks(bytes, offset)
      continue
    }
    throw new Error('Invalid GIF member avatar structure')
  }
  if (!sawEnd) throw new Error('Truncated GIF member avatar')
  if (frameCount === 0) throw new Error('GIF member avatar contains no frames')
  const cumulative = width * height * frameCount
  if (cumulative > MEMBER_AVATAR_LIMITS.maximumGifCumulativeDecodedPixels) {
    throw new Error('Animated member avatar exceeds the cumulative decode resource limit')
  }
  return { mediaType: 'image/gif', width, height, frameCount, loopCount }
}

function skipGifSubBlocks(bytes: Uint8Array, offset: number): number {
  let cursor = offset
  for (;;) {
    if (cursor >= bytes.byteLength) throw new Error('Truncated GIF member avatar')
    const size = bytes[cursor]
    cursor += 1
    if (size === 0) return cursor
    cursor += size
    if (cursor > bytes.byteLength) throw new Error('Truncated GIF member avatar')
  }
}

function bytesToAscii(bytes: Uint8Array): string {
  return String.fromCharCode(...bytes)
}

export function inspectPng(bytes: Uint8Array): PngInspection {
  const { iendOffset: _iendOffset, ...inspection } = inspectPngCore(bytes, false)
  return inspection
}

/** Member-avatar upload boundary parser. Real-world devices (e.g. vivo phone
 * screenshots) append vendor metadata after IEND; crop to `iendOffset` before
 * the bytes cross into a native decoder. The shared `inspectPng` stays strict. */
export function inspectMemberAvatarUploadPng(
  bytes: Uint8Array
): MemberAvatarUploadPngInspection {
  return inspectPngCore(bytes, true)
}

function inspectPngCore(
  bytes: Uint8Array,
  tolerateTrailingBytes: boolean
): MemberAvatarUploadPngInspection {
  if (!hasPrefix(bytes, PNG_SIGNATURE)) throw new Error('Unsupported member avatar image type')
  let offset: number = PNG_SIGNATURE.length
  let width = 0
  let height = 0
  let iendOffset = 0
  let sawHeader = false
  let sawEnd = false
  while (offset < bytes.byteLength) {
    if (offset + 12 > bytes.byteLength) throw new Error('Truncated PNG member avatar')
    const length = readU32(bytes, offset)
    const typeOffset = offset + 4
    const dataOffset = offset + 8
    const endOffset = dataOffset + length + 4
    if (endOffset < dataOffset || endOffset > bytes.byteLength) {
      throw new Error('Invalid PNG member avatar chunk length')
    }
    const type = ascii(bytes, typeOffset, 4)
    if (!sawHeader && type !== 'IHDR') throw new Error('PNG member avatar is missing IHDR')
    if (type === 'IHDR') {
      if (sawHeader || length !== 13) throw new Error('Invalid PNG member avatar IHDR')
      width = readU32(bytes, dataOffset)
      height = readU32(bytes, dataOffset + 4)
      const bitDepth = bytes[dataOffset + 8]
      const colorType = bytes[dataOffset + 9]
      const compression = bytes[dataOffset + 10]
      const filter = bytes[dataOffset + 11]
      const interlace = bytes[dataOffset + 12]
      if (
        !validPngColorDepth(colorType, bitDepth)
        || compression !== 0
        || filter !== 0
        || (interlace !== 0 && interlace !== 1)
        || width === 0
        || height === 0
      ) {
        throw new Error('Unsupported PNG member avatar encoding')
      }
      sawHeader = true
    } else if (type === 'acTL') {
      throw new Error('Animated PNG member avatars are not supported')
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('Invalid PNG member avatar ending')
      if (!tolerateTrailingBytes && endOffset !== bytes.byteLength) {
        throw new Error('Invalid PNG member avatar ending')
      }
      iendOffset = endOffset
      sawEnd = true
      break
    }
    offset = endOffset
  }
  if (!sawHeader || !sawEnd) throw new Error('Incomplete PNG member avatar')
  return { mediaType: 'image/png', width, height, iendOffset }
}

export function inspectJpeg(bytes: Uint8Array): JpegInspection {
  if (bytes.byteLength < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error('Unsupported member avatar image type')
  }
  let offset = 2
  while (offset < bytes.byteLength) {
    while (offset < bytes.byteLength && bytes[offset] === 0xff) offset += 1
    if (offset >= bytes.byteLength) break
    const marker = bytes[offset]
    offset += 1
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (offset + 2 > bytes.byteLength) throw new Error('Truncated JPEG member avatar')
    const length = readU16(bytes, offset)
    if (length < 2 || offset + length > bytes.byteLength) {
      throw new Error('Invalid JPEG member avatar segment')
    }
    if (isJpegStartOfFrame(marker)) {
      if (length < 8) throw new Error('Invalid JPEG member avatar dimensions')
      const height = readU16(bytes, offset + 3)
      const width = readU16(bytes, offset + 5)
      if (width === 0 || height === 0) {
        throw new Error('Invalid JPEG member avatar dimensions')
      }
      return { mediaType: 'image/jpeg', width, height }
    }
    offset += length
  }
  throw new Error('JPEG member avatar is missing dimensions')
}

function hasPrefix(bytes: Uint8Array, prefix: readonly number[]): boolean {
  return (
    bytes.byteLength >= prefix.length
    && prefix.every((value, index) => bytes[index] === value)
  )
}

function readU16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] << 8) | bytes[offset + 1]
}

function readU16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readU32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset] * 0x1000000
    + bytes[offset + 1] * 0x10000
    + bytes[offset + 2] * 0x100
    + bytes[offset + 3]
  )
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length))
}

function validPngColorDepth(colorType: number, bitDepth: number): boolean {
  if (colorType === 0) return [1, 2, 4, 8, 16].includes(bitDepth)
  if (colorType === 2 || colorType === 4 || colorType === 6) {
    return bitDepth === 8 || bitDepth === 16
  }
  return colorType === 3 && [1, 2, 4, 8].includes(bitDepth)
}

function isJpegStartOfFrame(marker: number): boolean {
  return [
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf
  ].includes(marker)
}


/** Checks original upload size before removing device metadata. Both clients
 * use the same byte-based format and animation admission. */
export function inspectMemberAvatarUpload(bytes: Uint8Array): {
  inspection: ImageInspection
  bytes: Uint8Array
} {
  if (bytes.byteLength > MEMBER_AVATAR_LIMITS.selectedFileBytes) {
    throw new Error('Member avatar exceeds the selected file byte limit')
  }
  const inspection = hasPrefix(bytes, PNG_SIGNATURE)
    ? inspectMemberAvatarUploadPng(bytes)
    : inspectImage(bytes)
  validateMemberAvatarDimensions(inspection.width, inspection.height)
  if (inspection.mediaType === 'image/gif') {
    const pixels = inspection.width * inspection.height
    if (inspection.width > MEMBER_AVATAR_LIMITS.displayGifMaximumEdge
      || inspection.height > MEMBER_AVATAR_LIMITS.displayGifMaximumEdge
      || pixels > MEMBER_AVATAR_LIMITS.displayGifMaximumPixels
      || pixels * inspection.frameCount > MEMBER_AVATAR_LIMITS.displayGifCumulativePixels) {
      throw new Error('GIF exceeds the display budget; choose a smaller file')
    }
  }
  return {
    inspection,
    bytes: 'iendOffset' in inspection && typeof inspection.iendOffset === 'number'
      ? bytes.subarray(0, inspection.iendOffset) : bytes
  }
}
