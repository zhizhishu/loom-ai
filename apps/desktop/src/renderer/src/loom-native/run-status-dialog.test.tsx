import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { RunStatusDialog } from './RunStatusDialog'

vi.mock('./Controls', async original => ({
  ...await original<typeof import('./Controls')>(),
  SurfaceDialog: ({ children }: { children: ReactNode }) => children
}))

it('uses the shared empty pattern when no work is selected', () => {
  const html = renderToStaticMarkup(createElement(RunStatusDialog, {
    open: true,
    port: {} as never,
    bundle: null,
    thread: null,
    theme: 'day',
    onClose: () => {},
    onArtifact: () => {},
    onCreateWork: () => {}
  }))
  expect(html).toContain('data-slot="empty"')
  expect(html).toContain('data-slot="empty-icon"')
  expect(html).toContain('还没有选择工作')
  expect(html).toContain('选择一项工作，查看助手分工、执行记录和成果。')
  expect(html).toContain('创建一项工作')
})
