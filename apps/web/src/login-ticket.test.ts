import { expect, it, vi } from 'vitest'
import { takeLoginTicket } from './login-ticket'

it('erases a scan fragment before validating it and preserves only existing route state', () => {
  const state = { rovai: { id: 'locator' } }
  const history = { state, replaceState: vi.fn() }
  const location = { hash: '#login-ticket=' + 'a'.repeat(64), pathname: '/', search: '' }
  expect(takeLoginTicket(location, history)).toBe('a'.repeat(64))
  expect(history.replaceState).toHaveBeenLastCalledWith(state, '', '/')
  for (const hash of ['#login-ticket=invalid', '#login-ticket=' + 'b'.repeat(64) + '&login-ticket=' + 'c'.repeat(64)]) {
    history.replaceState.mockClear()
    expect(() => takeLoginTicket({ ...location, hash }, history)).toThrow('链接无效')
    expect(history.replaceState).toHaveBeenCalledWith(state, '', '/')
  }
  history.replaceState.mockClear()
  expect(takeLoginTicket({ ...location, hash: '#ordinary-location' }, history)).toBeNull()
  expect(history.replaceState).not.toHaveBeenCalled()
})
