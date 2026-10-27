/** Read once and erase before awaiting storage, networking or rendering. The
 * one-time credential never becomes a route or a sessionStorage recovery value. */
export function takeLoginTicket(location: Pick<Location, 'hash' | 'pathname' | 'search'> = window.location,
  history: Pick<History, 'state' | 'replaceState'> = window.history): string | null {
  const fragment = new URLSearchParams(location.hash.slice(1))
  if (!fragment.has('login-ticket')) return null
  history.replaceState(history.state, '', location.pathname + location.search)
  const ticket = fragment.get('login-ticket')
  if (fragment.getAll('login-ticket').length !== 1 || !ticket || !/^[a-f0-9]{64}$/.test(ticket)) {
    throw new Error('扫码登录链接无效，请重新生成二维码。')
  }
  return ticket
}
