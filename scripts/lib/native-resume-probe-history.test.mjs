import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { sharedNativeTestHistory } from './native-resume-probe-history.mjs'

test('shared native deletion requires an exact fresh fixture target and native ownership', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'rovai-history-owner-')))
  const id = '00000000-0000-4000-8000-000000000001', project = join(root, 'project')
  const base = { root, id, project, boundId: id, stages: [
    { stage: 'seed', status: 'succeeded', currentId: id, requests: [{ direction: 'launch', cwd: project }] },
    { stage: 'cold', status: 'succeeded', previousId: id, currentId: id }
  ] }
  try {
    const path = join(root, id), metadata = join(path, 'session.json')
    await mkdir(path)
    const put = (targetId = id, cwd = project) => writeFile(metadata, JSON.stringify({ id: targetId, metadata: { cwd } }))
    await put()
    await mkdir(join(root, `unrelated-${id}-suffix`))
    assert.deepEqual(await sharedNativeTestHistory({ ...base, kind: 'trae-cn-cli' }), [path])
    for (const [target, cwd] of [['other', project], [id, '/another-project']]) {
      await put(target, cwd)
      await assert.rejects(sharedNativeTestHistory({ ...base, kind: 'trae-cn-cli' }))
    }
    await put()
    for (const overrides of [{ boundId: 'other' }, { id: '../outside' }, { stages: [] }, { project: '/another' }]) {
      await assert.rejects(sharedNativeTestHistory({ ...base, ...overrides, kind: 'trae-cn-cli' }))
    }
    // The real shared-store probe is macOS-only; Windows symlinks can require
    // privileges unavailable to the ordinary Node test runner.
    if (process.platform !== 'win32') {
      await rm(metadata)
      await writeFile(join(root, 'redirect.json'), JSON.stringify({ id, metadata: { cwd: project } }))
      await symlink(join(root, 'redirect.json'), metadata)
      await assert.rejects(sharedNativeTestHistory({ ...base, kind: 'trae-cn-cli' }))
    }

    const dbPath = join(root, `${id}.db`)
    const db = new DatabaseSync(dbPath)
    db.exec('CREATE TABLE trajectory_meta (cascade_id TEXT)')
    db.prepare('INSERT INTO trajectory_meta VALUES (?)').run(id)
    db.close()
    assert.deepEqual(await sharedNativeTestHistory({ ...base, kind: 'antigravity-app' }), [dbPath])
    const wrong = new DatabaseSync(dbPath)
    wrong.exec("UPDATE trajectory_meta SET cascade_id='other'")
    wrong.close()
    await assert.rejects(sharedNativeTestHistory({ ...base, kind: 'antigravity-app' }))
  } finally { await rm(root, { recursive: true, force: true }) }
})
