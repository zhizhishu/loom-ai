import { describe, expect, it } from 'vitest'
import { isReferenceDirectoryEvent } from './useReferenceAvailability'
import invalidations from '../../../../../packages/contracts/fixtures/thread-reference-invalidation.json'
import { fuzzyContains } from './thread-reference'
import cases from '../../../../../packages/contracts/fixtures/thread-reference-search.json'

describe('reference title search', () => {
  it.each(['爱丽丝的会话', '爱丽丝的使命'])('keeps %s on literal title matching', title => {
    expect(fuzzyContains(title, 'aili')).toBe(false)
    expect(fuzzyContains(title, 'als')).toBe(false)
    expect(fuzzyContains(title, '爱丽')).toBe(true)
    expect(fuzzyContains(title, '爱丝')).toBe(true)
  })
  it.each(cases)('matches $title / $query consistently with the Core directory', ({ title, query, expected }) => {
    expect(fuzzyContains(title, query)).toBe(expected)
  })
})

it.each(invalidations)('refreshes directory for $method / $params.reason only when needed', ({ expected, ...event }) => {
  expect(isReferenceDirectoryEvent(event)).toBe(expected)
})
