// 抄自 mikka-current@250d2451（Win11 loom\_artifacts\reference-repos\mikka-current，或 Bero /bundles/refs/mikka-current）：components/settings/primitives.tsx
import type { ReactNode } from 'react'
import { Icon, type IconName } from './icons'

/**
 * Settings section: a titled group of rows.
 *
 * Deliberately surface-free — no background, border or radius. Rows are separated
 * by hairlines so the settings page reads as one continuous column instead of a
 * stack of cards (Mikka `components/settings/primitives.tsx:36-40`).
 */
export function SettingsSection({
  id,
  title,
  description,
  action,
  children
}: {
  id?: string
  /** Left out when the page title already names the group (Mikka `:47-48`). */
  title?: string
  description?: string
  action?: ReactNode
  children: ReactNode
}) {
  return <section className="ln-settings-section" aria-labelledby={title ? id : undefined}>
    {(title || action) && <header className="ln-settings-section-head">
      <div className="ln-settings-section-copy">
        {title && <h2 id={id} className="ln-settings-section-title">{title}</h2>}
        {description && <p className="ln-settings-section-description">{description}</p>}
      </div>
      {action && <div className="ln-settings-section-action">{action}</div>}
    </header>}
    <div className="ln-settings-rows" data-settings-rows="">{children}</div>
  </section>
}

/**
 * One setting = one row: title and description on the left, value or control on
 * the right. Never give a single row a background, border or radius; if a row
 * needs to look different, change what it contains (Mikka `:70-81`).
 */
export function SettingRow({
  title,
  description,
  icon,
  children
}: {
  title: string
  description?: ReactNode
  /** The named thing's icon, before the title (Mikka R-74). */
  icon?: IconName
  children?: ReactNode
}) {
  return <div className="ln-settings-row">
    <div className="ln-settings-row-copy">
      {icon && <Icon name={icon} size={17}/>}
      <div>
        <span className="ln-settings-row-title">{title}</span>
        {description && <p className="ln-settings-row-description">{description}</p>}
      </div>
    </div>
    <div className="ln-settings-row-control">{children}</div>
  </div>
}

/** A section that is still loading keeps its shape instead of rendering nothing
 * (Mikka `:9-24`). */
export function SettingsLoading({ label, rows = 3 }: { label: string; rows?: number }) {
  return <div className="ln-settings-rows" data-loading-placeholder="" role="status" aria-label={label}>
    <span className="ln-sr-only">{label}</span>
    {Array.from({ length: rows }, (_, index) => <div className="ln-settings-row is-loading" key={index}>
      <div className="ln-settings-row-copy"><div><span className="ln-settings-skeleton"/></div></div>
      <div className="ln-settings-row-control"><span className="ln-settings-skeleton is-short"/></div>
    </div>)}
  </div>
}

/** A save that failed: the value is already restored and the button retries the
 * same change (Mikka `:26-32`). */
export function SettingsSaveError({ message, retryLabel, onRetry }: { message: string; retryLabel: string; onRetry(): void }) {
  return <div className="ln-settings-save-error" role="alert">
    <span>{message}</span>
    <button type="button" className="ln-action" onClick={onRetry}>{retryLabel}</button>
  </div>
}
