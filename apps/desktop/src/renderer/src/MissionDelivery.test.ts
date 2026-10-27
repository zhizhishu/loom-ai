import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { MissionChangedFile } from '@contracts'
import { missionChangesVisible, missionCleanupAttentionVisible, missionFileTree, missionTreeWindow } from './MissionDelivery'

function changedFile(id: string, path: string): MissionChangedFile {
  return {
    id,
    path,
    oldPath: null,
    kind: 'modified',
    additions: 1,
    deletions: 1,
    binary: false,
    oldMode: '100644',
    newMode: '100644'
  }
}

function treeShape(nodes: ReturnType<typeof missionFileTree>): unknown[] {
  return nodes.map(node => node.kind === 'file'
    ? { kind: node.kind, name: node.name, path: node.path, id: node.file.id }
    : { kind: node.kind, name: node.name, path: node.path, count: node.count, children: treeShape(node.children) })
}

describe('Mission cumulative file tree', () => {
  it('mounts cumulative changes only after a Git workspace is ready', () => {
    expect(missionChangesVisible(true, null)).toBe(false)
    expect(missionChangesVisible(true, 'preparing')).toBe(false)
    expect(missionChangesVisible(true, 'cleanup_pending')).toBe(false)
    expect(missionChangesVisible(true, 'cleanup_failed')).toBe(false)
    expect(missionChangesVisible(true, 'cleaned')).toBe(false)
    expect(missionChangesVisible(false, 'ready')).toBe(false)
    expect(missionChangesVisible(true, 'ready')).toBe(true)
    expect(missionCleanupAttentionVisible('ready', 'mission.workspace_dirty')).toBe(true)
    expect(missionCleanupAttentionVisible('cleanup_failed', 'mission.branch_changed')).toBe(true)
    expect(missionCleanupAttentionVisible('ready', null)).toBe(false)
    expect(missionCleanupAttentionVisible('cleanup_pending', 'mission.git_failed')).toBe(false)
  })

  it('sorts directories before files, compresses single-directory chains and counts descendants', () => {
    const tree = missionFileTree([
      changedFile('readme', 'README.md'),
      changedFile('worker', 'src/runtime/worker.ts'),
      changedFile('cache', 'src/runtime/cache.ts'),
      changedFile('app', 'src/ui/App.tsx'),
      changedFile('logo', 'assets/icons/logo.png')
    ])

    expect(treeShape(tree)).toEqual([
      {
        kind: 'directory',
        name: 'assets/icons',
        path: 'assets/icons',
        count: 1,
        children: [
          { kind: 'file', name: 'logo.png', path: 'assets/icons/logo.png', id: 'logo' }
        ]
      },
      {
        kind: 'directory',
        name: 'src',
        path: 'src',
        count: 3,
        children: [
          {
            kind: 'directory',
            name: 'runtime',
            path: 'src/runtime',
            count: 2,
            children: [
              { kind: 'file', name: 'cache.ts', path: 'src/runtime/cache.ts', id: 'cache' },
              { kind: 'file', name: 'worker.ts', path: 'src/runtime/worker.ts', id: 'worker' }
            ]
          },
          {
            kind: 'directory',
            name: 'ui',
            path: 'src/ui',
            count: 1,
            children: [
              { kind: 'file', name: 'App.tsx', path: 'src/ui/App.tsx', id: 'app' }
            ]
          }
        ]
      },
      { kind: 'file', name: 'README.md', path: 'README.md', id: 'readme' }
    ])
  })

  it('does not retain flat-list selectors that leak into tree controls', () => {
    const css = readFileSync(new URL('./mission.css', import.meta.url), 'utf8')

    expect(css).not.toContain('.mission-diff-file-list button {')
    expect(css).not.toContain('.mission-diff-file-list button[aria-current="true"]')
  })

  it('calculates a bounded row window with overscan and full-height spacers', () => {
    expect(missionTreeWindow(1_200, 14_500, 480, 29)).toEqual({
      start: 492,
      end: 525,
      before: 14_268,
      after: 19_575
    })
    expect(missionTreeWindow(1_200, Number.POSITIVE_INFINITY, 480, 29)).toEqual({
      start: 0,
      end: 25,
      before: 0,
      after: 34_075
    })
    expect(missionTreeWindow(0, 0, 480, 29)).toEqual({ start: 0, end: 0, before: 0, after: 0 })
  })
})
