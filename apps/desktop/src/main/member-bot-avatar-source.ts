import { constants } from 'node:fs'
import { readFile, mkdir, lstat, open, link, unlink } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  MEMBER_AVATAR_LIMITS,
  parseControlledMemberAvatarRef,
  type MemberAvatarRendition,
  type BuiltinMemberAvatarRole
} from '@contracts'
import luokeIconPath from '../renderer/src/assets/characters/luoke/icon-192.png?asset'
import mianzhiIconPath from '../renderer/src/assets/characters/mianzhi/icon-192.png?asset'
import muwaIconPath from '../renderer/src/assets/characters/muwa/icon-192.png?asset'
import qiluIconPath from '../renderer/src/assets/characters/qilu/icon-192.png?asset'
import type { MemberBotAvatarSource } from './feishu-member-bot-provisioner'
import { inspectPng } from './member-avatar-assets'

export interface MemberBotAvatarSourceOptions {
  targetEdge?: number
  publicationIntentId?: string
  /** Whether an absent reference is a usable channel default that can be frozen. */
  allowDefaultAvatar?: boolean
}

export interface MemberBotAvatarSourceResolver {
  resolve(avatarRef: string | null, options?: MemberBotAvatarSourceOptions): Promise<MemberBotAvatarSource | undefined>
}

type ManagedAvatarExport = { read(avatarRef: string, rendition: 'icon', targetEdge?: number): Promise<MemberAvatarRendition | null> }
type ReadBuiltinAvatar = (role: BuiltinMemberAvatarRole) => Promise<Uint8Array>

const BUILTIN_ICON_PATHS: Readonly<Record<BuiltinMemberAvatarRole, string>> = {
  luoke: luokeIconPath,
  muwa: muwaIconPath,
  mianzhi: mianzhiIconPath,
  qilu: qiluIconPath
}

export class ControlledMemberBotAvatarSourceResolver implements MemberBotAvatarSourceResolver {
  readonly #managedAvatars: ManagedAvatarExport
  readonly #readBuiltinAvatar: ReadBuiltinAvatar
  readonly #snapshotDirectory?: string

  constructor(
    managedAvatars: ManagedAvatarExport,
    readBuiltinAvatar: ReadBuiltinAvatar = readPackagedBuiltinAvatar,
    snapshotDirectory?: string
  ) {
    this.#managedAvatars = managedAvatars
    this.#readBuiltinAvatar = readBuiltinAvatar
    this.#snapshotDirectory = snapshotDirectory
  }

  async resolve(avatarRef: string | null, options: MemberBotAvatarSourceOptions = {}): Promise<MemberBotAvatarSource | undefined> {
    const edge = options.targetEdge ?? MEMBER_AVATAR_LIMITS.iconEdge
    if (!Number.isInteger(edge) || edge < 1 || edge > 512) throw new Error('member_bot_avatar_export_size_invalid')
    if (!options.publicationIntentId || !this.#snapshotDirectory) return this.#read(avatarRef, edge)
    const root = this.#snapshotDirectory
    await mkdir(root, { recursive: true, mode: 0o700 })
    const directory = await lstat(root)
    if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('member_bot_avatar_snapshot_invalid')
    const key = createHash('sha256').update(options.publicationIntentId).digest('hex')
    const file = join(root, `${key}-${edge}.json`)
    const existing = await readSnapshot(file)
    if (existing !== null) return existing.image
    const image = await this.#read(avatarRef, edge)
    // A channel that requires an image must be able to retry after the user
    // supplies one. Only usable images/defaults become immutable snapshots.
    if (!image && options.allowDefaultAvatar === false) return undefined
    const temporary = join(root, `.tmp-${randomUUID()}`)
    const handle = await open(temporary, 'wx', 0o600)
    try {
      try {
        const png = image?.pngBytes
        await handle.writeFile(JSON.stringify(png ? { version: 1, width: image.width, height: image.height,
          pngBase64: Buffer.from(png).toString('base64'), sha256: digest(png) } : { version: 1, pngBase64: null }))
        await handle.sync()
      } finally { await handle.close() }
      // Atomic first writer wins, so concurrent retries cannot replace a frozen
      // publication with a newer member image.
      try { await link(temporary, file) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error }
      if (process.platform !== 'win32') {
        const directoryHandle = await open(root, constants.O_RDONLY)
        try { await directoryHandle.sync() } finally { await directoryHandle.close() }
      }
      const frozen = await readSnapshot(file)
      if (!frozen) throw new Error('member_bot_avatar_snapshot_unavailable')
      return frozen.image
    } finally { await unlink(temporary) }
  }

  async #read(avatarRef: string | null, edge: number): Promise<MemberBotAvatarSource | undefined> {
    if (avatarRef === null) return undefined
    const parsed = parseControlledMemberAvatarRef(avatarRef)
    if (!parsed) throw new Error('feishu_member_bot_avatar_ref_invalid')

    if (parsed.kind === 'managed') {
      const rendition = await this.#managedAvatars.read(avatarRef, 'icon', edge)
      if (!rendition || rendition.mediaType !== 'image/png'
        || rendition.width !== edge || rendition.height !== edge) {
        throw new Error('feishu_member_bot_avatar_unavailable')
      }
      return {
        pngBytes: rendition.bytes,
        width: rendition.width,
        height: rendition.height
      }
    }

    const bytes = await this.#readBuiltinAvatar(parsed.role)
    let inspection: ReturnType<typeof inspectPng>
    try {
      inspection = inspectPng(bytes)
    } catch {
      throw new Error('feishu_member_bot_avatar_unavailable')
    }
    if (
      inspection.width !== MEMBER_AVATAR_LIMITS.iconEdge
      || inspection.height !== MEMBER_AVATAR_LIMITS.iconEdge
    ) throw new Error('feishu_member_bot_avatar_unavailable')
    return {
      pngBytes: bytes,
      width: inspection.width,
      height: inspection.height
    }
  }
}

async function readPackagedBuiltinAvatar(role: BuiltinMemberAvatarRole): Promise<Uint8Array> {
  try {
    return new Uint8Array(await readFile(BUILTIN_ICON_PATHS[role]))
  } catch {
    throw new Error('feishu_member_bot_avatar_unavailable')
  }
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }

async function readSnapshot(path: string): Promise<{ image: MemberBotAvatarSource | undefined } | null> {
  let handle
  try {
    const entry = await lstat(path)
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('member_bot_avatar_snapshot_invalid')
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const info = await handle.stat()
    if (!info.isFile() || info.size > 3 * 1024 * 1024) throw new Error('member_bot_avatar_snapshot_invalid')
    const bytes = await handle.readFile()
    if (bytes.length !== info.size) throw new Error('member_bot_avatar_snapshot_invalid')
    const value = JSON.parse(bytes.toString('utf8'))
    if (value?.version !== 1) throw new Error('member_bot_avatar_snapshot_invalid')
    if (value.pngBase64 === null) return { image: undefined }
    if (typeof value.pngBase64 !== 'string') throw new Error('member_bot_avatar_snapshot_invalid')
    const pngBytes = Uint8Array.from(Buffer.from(value.pngBase64, 'base64'))
    const png = inspectPng(pngBytes)
    if (digest(pngBytes) !== value.sha256 || png.width !== value.width || png.height !== value.height
      || png.width !== png.height || png.width > 512) throw new Error('member_bot_avatar_snapshot_invalid')
    return { image: { pngBytes, width: png.width, height: png.height } }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  } finally { await handle?.close() }
}
