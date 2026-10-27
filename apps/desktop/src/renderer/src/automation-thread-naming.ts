import type { AutomationThreadNaming } from '@contracts'

export function defaultThreadNaming(): AutomationThreadNaming {
  return { includeDate: true, includeTime: true, dateFormat: 'iso', timeFormat: '24', position: 'suffix' }
}

/** Preview only. Core owns occurrence time, local timezone and the stored title. */
export function automationTitlePreview(name: string, prompt: string, naming: AutomationThreadNaming, at: Date): string {
  const normalizedName = name.trim().replace(/\s+/gu, ' ')
  const promptScalars = Array.from(prompt.trim().replace(/\s+/gu, ' '))
  const base = normalizedName || promptScalars.slice(0, 20).join('') + (promptScalars.length > 20 ? '…' : '')
  const pad = (value: number): string => String(value).padStart(2, '0')
  const month = pad(at.getMonth() + 1)
  const day = pad(at.getDate())
  const date = `${at.getFullYear()}-${month}-${day}`
  const time = `${pad(at.getHours())}:${pad(at.getMinutes())}`
  const stamp = [naming.includeDate ? date : '', naming.includeTime ? time : ''].filter(Boolean).join(' ')
  if (!stamp) return base
  return naming.position === 'prefix' ? `${stamp} · ${base}` : `${base} · ${stamp}`
}
