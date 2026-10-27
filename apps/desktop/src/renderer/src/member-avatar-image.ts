import {
  MEMBER_AVATAR_LIMITS,
  type MemberAvatarCrop,
  type MemberAvatarSourceSelection
} from '@contracts'
import { avatarCropToPixels, clampAvatarCrop } from './member-avatar-crop'
import { uiAttribute } from './interface-language'

export type NormalizedMemberAvatarSource =
  | {
      kind: 'raster'
      sourcePng: Uint8Array
      width: number
      height: number
    }
  | {
      kind: 'gif'
      sourceGif: Uint8Array
      width: number
      height: number
    }

export type NormalizedMemberAvatarAsset =
  Extract<NormalizedMemberAvatarSource, { kind: 'raster' }> & {
    iconPng: Uint8Array
    crop: MemberAvatarCrop
  }

export function validateDecodedMemberAvatarDimensions(
  width: number,
  height: number
): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(uiAttribute('头像尺寸无效'))
  }
  if (
    width < MEMBER_AVATAR_LIMITS.minimumDecodedEdge
    || height < MEMBER_AVATAR_LIMITS.minimumDecodedEdge
  ) {
    throw new Error(
      uiAttribute('头像至少需要 {0}×{1}px', MEMBER_AVATAR_LIMITS.minimumDecodedEdge, MEMBER_AVATAR_LIMITS.minimumDecodedEdge)
    )
  }
  if (
    width > MEMBER_AVATAR_LIMITS.maximumDecodedEdge
    || height > MEMBER_AVATAR_LIMITS.maximumDecodedEdge
  ) {
    throw new Error(uiAttribute('头像单边不能超过 {0}px', MEMBER_AVATAR_LIMITS.maximumDecodedEdge))
  }
  if (width * height > MEMBER_AVATAR_LIMITS.maximumDecodedPixels) {
    throw new Error(uiAttribute('头像总像素不能超过 3200 万'))
  }
}

/** Animated GIF sources carry explicit frame-count and cumulative decode caps so
 * a multi-frame file cannot exhaust renderer or Core decode resources. */
export function validateGifMemberAvatarSource(
  width: number,
  height: number,
  frameCount: number
): void {
  validateDecodedMemberAvatarDimensions(width, height)
  if (!Number.isInteger(frameCount) || frameCount <= 0) {
    throw new Error(uiAttribute('GIF 头像帧数无效'))
  }
  if (frameCount > MEMBER_AVATAR_LIMITS.maximumGifFrames) {
    throw new Error(
      uiAttribute('GIF 头像不能超过 {0} 帧', MEMBER_AVATAR_LIMITS.maximumGifFrames)
    )
  }
  if (width > MEMBER_AVATAR_LIMITS.displayGifMaximumEdge || height > MEMBER_AVATAR_LIMITS.displayGifMaximumEdge
    || width * height > MEMBER_AVATAR_LIMITS.displayGifMaximumPixels
    || width * height * frameCount > MEMBER_AVATAR_LIMITS.displayGifCumulativePixels) {
    throw new Error(uiAttribute('GIF 超出显示预算，请使用更小的图片'))
  }
}

export function normalizedMemberAvatarDimensions(
  width: number,
  height: number
): { width: number; height: number } {
  validateDecodedMemberAvatarDimensions(width, height)
  const longest = Math.max(width, height)
  if (longest <= MEMBER_AVATAR_LIMITS.normalizedMaximumEdge) return { width, height }
  const scale = MEMBER_AVATAR_LIMITS.normalizedMaximumEdge / longest
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  }
}

export function isMemberAvatarSourceLowQuality(width: number, height: number): boolean {
  validateDecodedMemberAvatarDimensions(width, height)
  return (
    width < MEMBER_AVATAR_LIMITS.qualityWarningEdge
    || height < MEMBER_AVATAR_LIMITS.qualityWarningEdge
  )
}

/** Blob for preview and crop `<img>`; GIF stays animated, PNG keeps its type. */
export function normalizedMemberAvatarBlob(
  source: NormalizedMemberAvatarSource
): Blob {
  return source.kind === 'gif'
    ? new Blob([Uint8Array.from(source.sourceGif).buffer], { type: 'image/gif' })
    : new Blob([Uint8Array.from(source.sourcePng).buffer], { type: 'image/png' })
}

export async function normalizeMemberAvatarSource(
  selection: MemberAvatarSourceSelection
): Promise<NormalizedMemberAvatarSource> {
  if (selection.byteLength !== selection.bytes.byteLength) {
    throw new Error('头像字节长度不一致')
  }
  if (selection.byteLength > MEMBER_AVATAR_LIMITS.selectedFileBytes) {
    throw new Error('头像不能超过 10 MiB')
  }
  validateDecodedMemberAvatarDimensions(
    selection.inspectedWidth,
    selection.inspectedHeight
  )

  if (selection.mediaType === 'image/gif') {
    if (
      selection.frameCount === undefined
      || selection.loopCount === undefined
    ) {
      throw new Error(uiAttribute('GIF 头像缺少帧信息'))
    }
    validateGifMemberAvatarSource(
      selection.inspectedWidth,
      selection.inspectedHeight,
      selection.frameCount
    )
    return {
      kind: 'gif',
      sourceGif: Uint8Array.from(selection.bytes),
      width: selection.inspectedWidth,
      height: selection.inspectedHeight
    }
  }

  const bitmap = await createImageBitmap(
    new Blob([ownedArrayBuffer(selection.bytes)], { type: selection.mediaType }),
    { imageOrientation: 'from-image' }
  )
  try {
    validateDecodedMemberAvatarDimensions(bitmap.width, bitmap.height)
    const dimensions = normalizedMemberAvatarDimensions(bitmap.width, bitmap.height)
    const canvas = document.createElement('canvas')
    canvas.width = dimensions.width
    canvas.height = dimensions.height
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) throw new Error('无法创建头像画布')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.clearRect(0, 0, dimensions.width, dimensions.height)
    context.drawImage(bitmap, 0, 0, dimensions.width, dimensions.height)
    const sourcePng = await canvasToPngBytes(canvas)
    if (sourcePng.byteLength > MEMBER_AVATAR_LIMITS.normalizedSourceBytes) {
      throw new Error('规范化头像超过 16 MiB')
    }
    return {
      kind: 'raster',
      sourcePng,
      width: dimensions.width,
      height: dimensions.height
    }
  } finally {
    bitmap.close()
  }
}

export async function deriveMemberAvatarIcon(
  source: Extract<NormalizedMemberAvatarSource, { kind: 'raster' }>,
  crop: MemberAvatarCrop
): Promise<NormalizedMemberAvatarAsset> {
  if (source.kind !== 'raster') {
    // Frame-accurate icon derivation lives in Core so the animation survives;
    // the renderer must never flatten a GIF through a canvas here.
    throw new Error(uiAttribute('GIF 头像由 Core 派生小头像'))
  }
  const safeCrop = clampAvatarCrop(crop, source.width, source.height)
  const bitmap = await createImageBitmap(
    new Blob([ownedArrayBuffer(source.sourcePng)], { type: 'image/png' })
  )
  try {
    if (bitmap.width !== source.width || bitmap.height !== source.height) {
      throw new Error('规范化头像尺寸不一致')
    }
    const rect = avatarCropToPixels(safeCrop, source.width, source.height)
    const canvas = document.createElement('canvas')
    canvas.width = MEMBER_AVATAR_LIMITS.iconEdge
    canvas.height = MEMBER_AVATAR_LIMITS.iconEdge
    const context = canvas.getContext('2d', { alpha: true })
    if (!context) throw new Error('无法创建小头像画布')
    context.imageSmoothingEnabled = true
    context.imageSmoothingQuality = 'high'
    context.clearRect(0, 0, canvas.width, canvas.height)
    context.drawImage(
      bitmap,
      rect.x,
      rect.y,
      rect.size,
      rect.size,
      0,
      0,
      canvas.width,
      canvas.height
    )
    const iconPng = await canvasToPngBytes(canvas)
    if (iconPng.byteLength > MEMBER_AVATAR_LIMITS.iconBytes) {
      throw new Error('派生小头像超过 1 MiB')
    }
    if (
      source.sourcePng.byteLength + iconPng.byteLength
      > MEMBER_AVATAR_LIMITS.saveIpcBytes
    ) {
      throw new Error('头像保存数据超过 17 MiB')
    }
    return {
      ...source,
      iconPng,
      crop: safeCrop
    }
  } finally {
    bitmap.close()
  }
}

function ownedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return Uint8Array.from(bytes).buffer
}

async function canvasToPngBytes(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => {
      if (value) resolve(value)
      else reject(new Error('无法编码 PNG 图片'))
    }, 'image/png')
  })
  return new Uint8Array(await blob.arrayBuffer())
}
