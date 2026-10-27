/** A stationary text overlay; animation never changes the accessible label or layout. */
export function RunningText({ text, active = true, className = '' }: {
  text: string; active?: boolean; className?: string
}) {
  return <span className={`running-text ${className}`} title={text}>
    <span>{text}</span>
    {active && <span className="running-text-highlight" aria-hidden="true" data-text={text} />}
  </span>
}
