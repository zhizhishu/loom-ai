import * as Popover from '@radix-ui/react-popover'
import type { RefObject } from 'react'
import { useUiText } from './interface-language'
import { ResourceReferenceIcon } from './FilePreviewTabIcon'

export function WebLinkActions({ target, anchor, portalContainer, onClose, onOpen, onCopy }: {
  target: string | null
  anchor: RefObject<{ getBoundingClientRect(): DOMRect }>
  portalContainer?: HTMLElement | null
  onClose(): void
  onOpen(): void
  onCopy(): void
}): React.JSX.Element {
  const t = useUiText()
  return <Popover.Root open={target !== null} onOpenChange={open => { if (!open) onClose() }} modal={false}>
    <Popover.Anchor virtualRef={anchor} />
    <Popover.Portal container={portalContainer}>
      <Popover.Content className="composer-web-link-actions" side="top" align="start" sideOffset={6}
        collisionPadding={12} data-quote-exclude
        onOpenAutoFocus={event => event.preventDefault()}
        onEscapeKeyDown={event => { event.preventDefault(); onClose() }}
        onCloseAutoFocus={event => event.preventDefault()}>
        <div className="composer-web-link-address">
          <ResourceReferenceIcon kind="web" className="resource-reference-icon web-reference-icon" />
          <span className="resource-reference-label">{target}</span>
        </div>
        <div className="composer-web-link-buttons">
          <button type="button" className="quiet-button" onPointerDown={event => event.preventDefault()}
            onClick={onOpen}>{t('打开链接')}</button>
          <button type="button" className="quiet-button" onPointerDown={event => event.preventDefault()}
            onClick={onCopy}>{t('复制链接')}</button>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>
}
