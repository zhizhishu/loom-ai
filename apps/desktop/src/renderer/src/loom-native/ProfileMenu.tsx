// 抄自 mikka-current@250d2451（Win11 loom\_artifacts\reference-repos\mikka-current，或 Bero /bundles/refs/mikka-current）：components/workspace-menu.tsx
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { currentUserDisplayName } from '@contracts'
import { useCurrentUserProfile } from '../CurrentUserProfile'
import { Icon } from './icons'

/**
 * The account menu behind the rail's avatar, in the style of Mikka's workspace menu:
 * one flat list, 设置 with its shortcut, then the rest. Mounting it never covers the
 * avatar — the menu opens above it (`components/workspace-menu.tsx:79-80`) — and
 * 设置 carries `aria-keyshortcuts` (`:115-118`). Workspace switching and extra
 * accounts are left out: this build has one connection and one workspace.
 */
export function ProfileMenu({ theme, shortcutKey, onSettings, onHistory, onLogout }: {
  theme: 'day' | 'night'
  /** '⌘' or 'Ctrl' for the visible hint. */
  shortcutKey: string
  onSettings(): void
  onHistory?(): void
  onLogout?(): void
}) {
  const { profile } = useCurrentUserProfile()
  const name = currentUserDisplayName(profile)
  const initial = [...name][0] ?? 'L'
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <button type="button" className="ln-user-button" aria-label="个人与连接设置" title={name}>{initial}</button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <div className="ln-portal" data-theme={theme}>
        <DropdownMenu.Content className="ln-profile-menu" aria-label="个人与连接设置" side="top" align="start" sideOffset={8} collisionPadding={12}>
          <DropdownMenu.Label className="ln-profile-menu-label">{name}</DropdownMenu.Label>
          <DropdownMenu.Item className="ln-profile-menu-item" aria-keyshortcuts="Control+, Meta+," onSelect={onSettings}>
            <Icon name="settings" size={15}/><span>设置</span><kbd>{shortcutKey},</kbd>
          </DropdownMenu.Item>
          {onHistory && <DropdownMenu.Item className="ln-profile-menu-item" onSelect={onHistory}>
            <Icon name="clock" size={15}/><span>会话活动</span>
          </DropdownMenu.Item>}
          {onLogout && <>
            <DropdownMenu.Separator className="ln-profile-menu-separator"/>
            <DropdownMenu.Item className="ln-profile-menu-item is-danger" onSelect={onLogout}>
              <Icon name="left" size={15}/><span>退出当前连接</span>
            </DropdownMenu.Item>
          </>}
        </DropdownMenu.Content>
      </div>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>
}
