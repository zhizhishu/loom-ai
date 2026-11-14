import type { ReactNode } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import * as Menu from '@radix-ui/react-dropdown-menu'
import { Icon } from './icons'

export type Choice = { value: string; label: string; description?: string; icon?: ReactNode; disabled?: boolean }

/** One keyboard-accessible, theme-scoped menu instead of browser-native select chrome. */
export function ChoiceMenu({ value, choices, onChange, label, theme = 'day', disabled, className = '' }: {
  value: string; choices: readonly Choice[]; onChange(value: string): void; label: string
  theme?: 'day' | 'night'; disabled?: boolean; className?: string
}) {
  const selected = choices.find(item => item.value === value)
  return <Menu.Root><Menu.Trigger asChild><button type="button" className={`ln-choice ${className}`} aria-label={label} disabled={disabled}>
    {selected?.icon}<span>{selected?.label ?? '请选择'}</span><Icon name="down" size={13}/>
  </button></Menu.Trigger><Menu.Portal><div className="ln-portal" data-theme={theme}>
    <Menu.Content className="ln-choice-menu" align="end" sideOffset={7} collisionPadding={12}>
      <Menu.RadioGroup value={value} onValueChange={onChange}>{choices.map(choice => <Menu.RadioItem key={choice.value} value={choice.value} className="ln-choice-item" disabled={choice.disabled}>
        {choice.icon}<span><strong>{choice.label}</strong>{choice.description && <small>{choice.description}</small>}</span>
        <Menu.ItemIndicator className="ln-choice-check"><Icon name="check" size={15}/></Menu.ItemIndicator>
      </Menu.RadioItem>)}</Menu.RadioGroup>
    </Menu.Content>
  </div></Menu.Portal></Menu.Root>
}

export function SurfaceDialog({ open, title, description, theme = 'day', onClose, children, className = '' }: {
  open: boolean; title: string; description?: string; theme?: 'day' | 'night'; onClose(): void; children: ReactNode; className?: string
}) {
  return <Dialog.Root open={open} onOpenChange={value => { if (!value) onClose() }}><Dialog.Portal>
    <div className="ln-portal" data-theme={theme}><Dialog.Overlay className="ln-modal-backdrop"/>
      <Dialog.Content className={`ln-surface-dialog ${className}`} {...(!description ? { 'aria-describedby': undefined } : {})}>
        <header className="ln-surface-title"><div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div>
          <button type="button" className="ln-icon-button" aria-label="关闭窗口" onClick={onClose}><Icon name="close"/></button></header>
        {children}
      </Dialog.Content>
    </div>
  </Dialog.Portal></Dialog.Root>
}

export function FormMessage({ error, children }: { error?: boolean; children: ReactNode }) {
  return <p className={`ln-form-message ${error ? 'is-error' : ''}`} role={error ? 'alert' : 'status'}>{children}</p>
}

export function UnsavedNotice({ onDiscard, onKeep }: { onDiscard(): void; onKeep(): void }) {
  return <div className="ln-unsaved-notice" role="alert"><span>还有未保存的修改。</span><button type="button" onClick={onKeep}>继续编辑</button><button type="button" onClick={onDiscard}>放弃修改并关闭</button></div>
}
