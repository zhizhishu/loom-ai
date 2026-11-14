import { examples, validateAvatar, type AvatarDefinition } from 'open-bot-avatar'
import book from './assets/open-bot-avatar/book.json'
import brain from './assets/open-bot-avatar/brain.json'
import bull from './assets/open-bot-avatar/bull.json'
import bunny from './assets/open-bot-avatar/bunny.json'
import camera from './assets/open-bot-avatar/camera.json'
import cat from './assets/open-bot-avatar/cat.json'
import cloud from './assets/open-bot-avatar/cloud.json'
import ghost from './assets/open-bot-avatar/ghost.json'
import magnifier from './assets/open-bot-avatar/magnifier.json'
import paintBrush from './assets/open-bot-avatar/paint-brush.json'
import palette from './assets/open-bot-avatar/palette.json'
import rocket from './assets/open-bot-avatar/rocket.json'
import shield from './assets/open-bot-avatar/shield.json'
import star from './assets/open-bot-avatar/star.json'
import witchHat from './assets/open-bot-avatar/witch-hat.json'
import paletteColors from './assets/open-bot-avatar/colors.json'

export interface OpenBotAvatarShape {
  id: string
  name: string
  /** Curated body color used when a ref does not carry one. */
  defaultColor: string
  definition: AvatarDefinition
}

const RAW_DEFINITIONS: readonly unknown[] = [
  // Official engine examples first (controller, mug, sprout, …), then the
  // vendored gallery; duplicates and invalid entries are dropped below.
  ...examples,
  book,
  brain,
  bull,
  bunny,
  camera,
  cat,
  cloud,
  ghost,
  magnifier,
  paintBrush,
  palette,
  rocket,
  shield,
  star,
  witchHat
]

const DEFAULT_COLOR = '#f97316'
const COLORS = paletteColors as Readonly<Record<string, string>>

/**
 * The curated, offline shape library. Definitions ship as data and are
 * validated locally, so a broken or duplicated entry is dropped instead of
 * reaching the renderer. Only these ids may appear in a bot avatar ref.
 */
export const OPEN_BOT_AVATAR_SHAPES: readonly OpenBotAvatarShape[] = (() => {
  const shapes: OpenBotAvatarShape[] = []
  const seen = new Set<string>()
  for (const raw of RAW_DEFINITIONS) {
    const result = validateAvatar(raw)
    if (!result.ok) continue
    const { id, name } = result.value
    if (seen.has(id)) continue
    seen.add(id)
    shapes.push({
      id,
      name,
      defaultColor: COLORS[id] ?? DEFAULT_COLOR,
      definition: result.value as AvatarDefinition
    })
  }
  return shapes
})()

const SHAPES_BY_ID = new Map(OPEN_BOT_AVATAR_SHAPES.map(shape => [shape.id, shape]))

export function openBotAvatarShape(id: string): OpenBotAvatarShape | null {
  return SHAPES_BY_ID.get(id) ?? null
}

/** Seven body colors offered next to the shape grid. */
export const OPEN_BOT_AVATAR_COLORS = [
  '#1f7cf2',
  '#f97316',
  '#ec4899',
  '#8b5cf6',
  '#1fbf68',
  '#14b3a5',
  '#f4c026'
] as const
