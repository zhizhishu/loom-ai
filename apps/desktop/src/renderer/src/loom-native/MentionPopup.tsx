import { Icon } from './icons'
import type { MentionMember } from './mention-completion'
import './m9-3.css'

/**
 * @ 补全候选列表。只负责显示和点选：键盘（↑↓ / Enter / Tab / Esc）由 ConversationView 的
 * textarea 处理，这里不抢按键，也不抢焦点（`onMouseDown` 阻止默认，插入点留在输入框里）。
 */
export function MentionPopup({ id, options, activeIndex, label = '选择要 @ 的助手', onPick, onHover }: {
  id: string
  options: readonly MentionMember[]
  activeIndex: number
  label?: string
  onPick(member: MentionMember): void
  onHover?(index: number): void
}): React.JSX.Element | null {
  if (options.length === 0) return null
  return <div className="ln-mention-popup" id={id} role="listbox" aria-label={label} data-slot="mention-popup">
    {options.map((member, index) => <button type="button" key={member.agentId} id={`${id}-option-${index}`}
      role="option" aria-selected={index === activeIndex}
      className={`ln-mention-option${index === activeIndex ? ' is-active' : ''}`}
      onMouseDown={event => event.preventDefault()}
      onMouseEnter={() => onHover?.(index)}
      onClick={() => onPick(member)}>
      <span className="ln-mention-option-name">@{member.displayName}</span>
      {index === activeIndex && <Icon name="right" size={12}/>}
    </button>)}
  </div>
}
