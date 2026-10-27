import { match } from 'pinyin-pro'
import { fuzzyContains } from './thread-reference'

/** Pinyin expands member lookup only; query offsets and stored identities stay untouched. */
export function memberSearchMatches(value: string, query: string): boolean {
  if (fuzzyContains(value, query)) return true
  const text = value.normalize('NFKC').toLowerCase()
  const input = query.normalize('NFKC').toLowerCase()
  if (!/\p{Script=Han}/u.test(text) || !/[a-zü]/u.test(input)) return false
  return match(text, input, {
    precision: 'start',
    continuous: true,
    v: true,
    space: 'ignore'
  }) !== null
}
