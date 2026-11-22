import type { HTMLAttributes } from 'react'

/*
 * 搬运自 Mikka `components/ui/empty.tsx`（`Empty / EmptyHeader / EmptyMedia / EmptyTitle /
 * EmptyDescription / EmptyContent`）。结构、`data-slot` 名与「图标 + 标题 + 说明 + 一个动作」
 * 的排列顺序照抄，Mikka 的 `issue-list.tsx:49-51`、`project-workspace.tsx:62` 就是这套用法：
 * 空与「没有匹配」两种文案分开，空态里放创建动作。
 *
 * 只换语言：Tailwind 类换成本壳的 `ln-empty__*` 类（样式在 `product.css`），文案仍由调用方
 * 传入（本壳的中文写在调用处，不建第二份文案表）。
 */

export function Empty({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="empty" className={['ln-empty', className].filter(Boolean).join(' ')} {...rest}>{children}</div>
}

export function EmptyHeader({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="empty-header" className={['ln-empty__header', className].filter(Boolean).join(' ')} {...rest}>{children}</div>
}

export function EmptyMedia({ variant = 'default', className, children, ...rest }: HTMLAttributes<HTMLDivElement> & { variant?: 'default' | 'icon' }) {
  return <div data-slot="empty-icon" data-variant={variant} className={['ln-empty__media', className].filter(Boolean).join(' ')} {...rest}>{children}</div>
}

export function EmptyTitle({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="empty-title" className={['ln-empty__title', className].filter(Boolean).join(' ')} {...rest}>{children}</div>
}

export function EmptyDescription({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="empty-description" className={['ln-empty__description', className].filter(Boolean).join(' ')} {...rest}>{children}</div>
}

export function EmptyContent({ className, children, ...rest }: HTMLAttributes<HTMLDivElement>) {
  return <div data-slot="empty-content" className={['ln-empty__content', className].filter(Boolean).join(' ')} {...rest}>{children}</div>
}
