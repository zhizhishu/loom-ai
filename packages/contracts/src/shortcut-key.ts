/** Shared key identity for Desktop recording, dispatch and the serialized HTML preview bridge. */
export type ShortcutKeyEvent = Pick<KeyboardEvent, 'key' | 'code' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'repeat' | 'isComposing'>
export function normalizeShortcut(event: ShortcutKeyEvent, platform: string): string | null {
  if (event.isComposing || event.repeat || ['Meta', 'Control', 'Alt', 'Shift', 'AltGraph', 'Process', 'Unidentified', 'Dead'].includes(event.key)) return null
  let key = event.key.length === 1 ? event.key.toUpperCase() : event.key
  if (event.code.startsWith('Digit')) key = event.code.slice(5)
  if (event.code.startsWith('Key')) key = event.code.slice(3)
  if (event.code === 'BracketLeft') key = '['
  if (event.code === 'BracketRight') key = ']'
  if (event.code === 'Comma') key = ','
  if (key === ' ') key = 'Space'
  if (key === '+' || event.code === 'Equal') key = 'Plus'
  const primary = platform === 'darwin' ? event.metaKey : event.ctrlKey
  const other = platform === 'darwin' ? (event.ctrlKey ? ['Ctrl'] : []) : (event.metaKey ? ['Meta'] : [])
  return [...(primary ? ['Mod'] : []), ...other, ...(event.altKey ? ['Alt'] : []), ...(event.shiftKey && key !== 'Plus' ? ['Shift'] : []), key].join('+')
}
