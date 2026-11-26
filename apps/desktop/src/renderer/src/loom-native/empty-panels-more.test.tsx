import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it, vi } from 'vitest'
import { RoomDialog } from './RoomDialog'
import { WorkspaceManager } from './WorkspaceManager'

vi.mock('./Controls', async original => ({
  ...await original<typeof import('./Controls')>(),
  SurfaceDialog: ({ children }: { children: ReactNode }) => children
}))

const environment = {
  client: { request: vi.fn() },
  selectWorkspaceDirectory: vi.fn(),
  preferences: {
    navigationPreferences: {
      get: vi.fn(),
      registerProjects: vi.fn(),
      removeProject: vi.fn()
    }
  }
} as never

it('uses the shared empty pattern when creating a room without assistants', () => {
  const html = renderToStaticMarkup(createElement(RoomDialog, {
    open: true,
    environment,
    agents: [],
    onClose: () => {},
    onCreated: async () => {},
    onNewAssistant: () => {}
  }))
  expect(html).toContain('data-slot="empty"')
  expect(html).toContain('data-slot="empty-icon"')
  expect(html).toContain('还没有可选的助手')
  expect(html).toContain('新建助手')
})

it('uses the shared empty pattern when no project directory is registered', () => {
  const html = renderToStaticMarkup(createElement(WorkspaceManager, {
    embedded: true,
    environment,
    theme: 'day',
    onClose: () => {},
    onStart: () => {}
  }))
  expect(html).toContain('data-slot="empty"')
  expect(html).toContain('data-slot="empty-icon"')
  expect(html).toContain('还没有登记项目')
  expect(html).toContain('添加目录')
})
