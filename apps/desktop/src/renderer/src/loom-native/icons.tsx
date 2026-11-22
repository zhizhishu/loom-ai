import type { CSSProperties, ReactNode } from 'react'

export type IconName = 'home' | 'bulb' | 'board' | 'clock' | 'files' | 'settings' | 'search' | 'plus' | 'close' | 'left' | 'right' | 'down' | 'up' | 'panel' | 'expand' | 'chat' | 'globe' | 'download' | 'check' | 'hand' | 'progress' | 'blocked' | 'file' | 'image' | 'audio' | 'computer' | 'refresh' | 'attach' | 'copy' | 'stop' | 'more' | 'branch' | 'sun' | 'moon' | 'people' | 'minus' | 'user' | 'bell' | 'command' | 'info'
const paths: Record<IconName, ReactNode> = {
  minus: <path d="M5 12h14"/>,
  user: <><circle cx="12" cy="8" r="4"/><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0"/></>,
  bell: <><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15Z"/><path d="M10 20.5a2 2 0 0 0 4 0"/></>,
  command: <path d="M9 9V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3Z"/>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.5"/></>,
  people: <><circle cx="8" cy="7" r="3"/><path d="M2.5 19v-2a5.5 5.5 0 0 1 11 0v2M16 4.5a3 3 0 0 1 0 6M16.5 13a5 5 0 0 1 5 4v2"/></>,
  home: <><path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><path d="M9 21v-8h6v8"/></>,
  bulb: <><path d="M9 18h6m-5 3h4M8.2 14.5a6 6 0 1 1 7.6 0c-.8.6-.8 1.5-.8 2.5H9c0-1-.1-1.9-.8-2.5Z"/></>,
  board: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16m6-16v16"/></>,
  clock: <><circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/></>,
  files: <><rect x="8" y="3" width="12" height="15" rx="2"/><path d="M8 7H5a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-2"/></>,
  settings: <><path d="m9 3-1 3-3 1-2 3 2 3v3l3 2 2 3h4l2-3 3-2v-3l2-3-2-3-3-1-1-3Z"/><circle cx="12" cy="12" r="3"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/></>,
  plus: <path d="M12 5v14M5 12h14"/>, close: <path d="m6 6 12 12M18 6 6 18"/>,
  left: <path d="m14 6-6 6 6 6M8 12h12"/>, right: <path d="m10 6 6 6-6 6M4 12h12"/>, down: <path d="m6 9 6 6 6-6"/>, up: <path d="M12 19V5m-6 6 6-6 6 6"/>,
  panel: <><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/></>,
  expand: <path d="M14 4h6v6M20 4l-7 7M10 20H4v-6m0 6 7-7"/>,
  chat: <><path d="M20 14a2 2 0 0 1-2 2H9l-5 4V5a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2Z"/><path d="M8 7h8m-8 4h5"/></>,
  globe: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></>,
  check: <><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></>,
  hand: <path d="M8 13V6a1.5 1.5 0 0 1 3 0v5-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v6c0 4-3 7-7 7-3 0-5-2-7-5l-2-3a1.5 1.5 0 0 1 2-2l2 1Z"/>,
  progress: <path d="M12 3a9 9 0 1 1-8.5 12M3.5 9A9 9 0 0 1 8 4"/>,
  blocked: <><circle cx="12" cy="12" r="9"/><path d="m8 8 8 8m0-8-8 8"/></>,
  file: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><path d="M14 3v6h6M8 13h8m-8 4h6"/></>,
  // Mikka `components/icons` Image / AudioLines, for the two attachment kinds a card names.
  image: <><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.4"/><path d="m4 17 5-5 4 4 3-3 4 4"/></>,
  audio: <><path d="M3 11v2m4-6v10m4-13v16m4-11v6m4-4v2"/></>,
  computer: <><rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/></>,
  refresh: <><path d="M20 10a8 8 0 1 0-1 7M20 4v6h-6"/></>,
  attach: <path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2"/>,
  copy: <><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V3H3v13h5"/></>,
  stop: <rect x="6" y="6" width="12" height="12" rx="2"/>,
  more: <><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  branch: <><circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="5" r="2"/><path d="M6 7v10m12-10c0 7-12 3-12 10"/></>,
  sun: <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/></>,
  moon: <path d="M20 15A8 8 0 0 1 9 4a9 9 0 1 0 11 11Z"/>
}
/** Every icon name, for tests that check a name is drawable. */
export const ICON_NAMES = Object.keys(paths) as IconName[]

export function Icon({ name, size = 18, className = '', style }: { name: IconName; size?: number; className?: string; style?: CSSProperties }) {
  return <svg className={`ln-icon ${className}`} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>
}
export function IconButton({ icon, label, onClick, active, disabled, className = '' }: { icon: IconName; label: string; onClick?(): void; active?: boolean; disabled?: boolean; className?: string }) {
  return <button type="button" className={`ln-icon-button ${active ? 'is-active' : ''} ${className}`} aria-label={label} title={label} onClick={onClick} disabled={disabled}><Icon name={icon}/></button>
}
