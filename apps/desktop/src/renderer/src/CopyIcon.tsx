export function CopyIcon({ copied = false }: { copied?: boolean }): React.JSX.Element {
  return <svg viewBox="0 0 24 24" aria-hidden="true">
    {copied ? <path d="m5 12 4 4 10-10" /> : <>
      <rect x="8" y="8" width="11" height="11" rx="2" />
      <path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" />
    </>}
  </svg>
}
