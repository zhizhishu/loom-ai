import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { AgentProfile } from './types'
import { runtimeLogoFor } from './runtime-logo'
import { Avatar } from './Avatar'

// Avatar must show the execution engine's real logo when a member has no personal
// avatar, and must never replace a member's own avatar with a runtime logo.
vi.mock('../MemberAvatar', async () => {
  const { createElement: h } = await import('react')
  return {
    MemberAvatar: vi.fn((props: { displayName: string }) =>
      h('span', { className: 'member-avatar', 'data-mock': 'member-avatar' }, props.displayName))
  }
})

const KIND_LOGO = {
  pi: /Pi Coding Agent/,
  'codex-cli': /<title>Codex<\/title>/,
  'claude-code-cli': /Claude Code/,
  'deepseek-harness': /DeepSeek/
} as const

const member = (overrides: Partial<AgentProfile>): AgentProfile => ({
  agentId: 'a-1',
  displayName: 'Pi',
  avatarRef: null,
  runtimeConfiguration: null,
  ...overrides
} as unknown as AgentProfile)

const avatarSrc = (html: string): string | null => {
  const raw = html.match(/class="ln-avatar-runtime"[^>]*src="([^"]*)"/)?.[1]
  if (!raw) return null
  try { return decodeURIComponent(raw) } catch { return raw }
}

describe('runtimeLogoFor', () => {
  it('maps Pi, Codex, Claude Code and DSH to four distinct bundled logos', () => {
    const logos = Object.keys(KIND_LOGO).map(kind => runtimeLogoFor(kind))
    for (const logo of logos) expect(logo).toBeTruthy()
    expect(new Set(logos).size).toBe(4)
  })

  it('falls back to null for unknown or missing runtimes so the letter placeholder stays', () => {
    expect(runtimeLogoFor('kiro-cli')).toBeNull()
    expect(runtimeLogoFor('')).toBeNull()
    expect(runtimeLogoFor(null)).toBeNull()
    expect(runtimeLogoFor(undefined)).toBeNull()
  })
})

describe('Avatar runtime fallback', () => {
  it.each(Object.entries(KIND_LOGO))('renders the %s logo when a member has no personal avatar', (kind, marker) => {
    const agent = member({ avatarRef: null, runtimeConfiguration: { adapterKind: kind } as never })
    const html = renderToStaticMarkup(createElement(Avatar, { agent, size: 34 }))
    expect(html).toContain('class="ln-avatar-runtime"')
    expect(html).toContain('aria-hidden="true"')
    expect(avatarSrc(html)).toMatch(marker)
  })

  it('keeps the letter placeholder for a member whose runtime has no local logo', () => {
    const agent = member({ avatarRef: null, runtimeConfiguration: { adapterKind: 'kiro-cli' } as never })
    const html = renderToStaticMarkup(createElement(Avatar, { agent, size: 34 }))
    expect(html).not.toContain('ln-avatar-runtime')
  })

  it('never replaces a member personal avatar with a runtime logo', () => {
    const agent = member({ avatarRef: 'rovai://member-avatar/builtin/muwa/v1', runtimeConfiguration: { adapterKind: 'pi' } as never })
    const html = renderToStaticMarkup(createElement(Avatar, { agent, size: 34 }))
    expect(html).not.toContain('ln-avatar-runtime')
    expect(html).toContain('data-mock="member-avatar"')
  })
})
