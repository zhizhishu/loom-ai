export function PanelToggleIcon({
  side,
  visible
}: {
  side: 'left' | 'right'
  visible: boolean
}): React.JSX.Element {
  const divider = side === 'left'
    ? visible ? 'M7.5 3.5v13' : 'M4.5 6.5v7'
    : visible ? 'M12.5 3.5v13' : 'M15.5 6.5v7'

  return (
    <svg viewBox="0 0 20 20" fill="none" aria-hidden="true" focusable="false">
      <rect x="2" y="3.5" width="16" height="13" rx="3" />
      <path d={divider} />
    </svg>
  )
}
