import { describe, expect, it } from 'vitest'
import {
  isMemberAvatarSourceLowQuality,
  normalizedMemberAvatarDimensions,
  validateDecodedMemberAvatarDimensions,
  validateGifMemberAvatarSource
} from './member-avatar-image'
import { MEMBER_AVATAR_LIMITS } from '@contracts'

describe('member avatar image limits', () => {
  it('normalizes without upsampling and caps the longest edge', () => {
    expect(normalizedMemberAvatarDimensions(1024, 1600)).toEqual({
      width: 1024,
      height: 1600
    })
    expect(normalizedMemberAvatarDimensions(4000, 3000)).toEqual({
      width: 2048,
      height: 1536
    })
    expect(normalizedMemberAvatarDimensions(3000, 4000)).toEqual({
      width: 1536,
      height: 2048
    })
  })

  it('rejects invalid, oversized and excessive-area dimensions', () => {
    for (const [width, height] of [
      [0, 512],
      [Number.NaN, 512],
      [8193, 512],
      [512, 8193],
      [8000, 5000]
    ]) {
      expect(() => validateDecodedMemberAvatarDimensions(width, height)).toThrow()
    }
  })

  it('warns below 512px while accepting small valid images', () => {
    expect(isMemberAvatarSourceLowQuality(64, 128)).toBe(true)
    expect(isMemberAvatarSourceLowQuality(256, 1024)).toBe(true)
    expect(isMemberAvatarSourceLowQuality(511, 800)).toBe(true)
    expect(isMemberAvatarSourceLowQuality(512, 512)).toBe(false)
  })

  it('validates animated GIF frame and cumulative decode limits', () => {
    expect(() => validateGifMemberAvatarSource(256, 256, 1)).not.toThrow()
    expect(() =>
      validateGifMemberAvatarSource(256, 256, MEMBER_AVATAR_LIMITS.maximumGifFrames)
    ).not.toThrow()
    expect(() =>
      validateGifMemberAvatarSource(256, 256, MEMBER_AVATAR_LIMITS.maximumGifFrames + 1)
    ).toThrow('200 帧')
    expect(() => validateGifMemberAvatarSource(0, 256, 1)).toThrow('尺寸无效')
    expect(() => validateGifMemberAvatarSource(255, 256, 1)).not.toThrow()
    expect(() => validateGifMemberAvatarSource(4096, 4096, 10)).toThrow('显示预算')
    expect(() => validateGifMemberAvatarSource(256, 256, 0)).toThrow('帧数无效')
  })
})
