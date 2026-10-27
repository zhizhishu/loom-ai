// Destructive opt-in probe boundary: never enumerate a shared native history
// tree or select targets by substring. The caller stops its Core before this.
import assert from 'node:assert/strict'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export async function sharedNativeTestHistory({ kind, root, id, project, stages, boundId }) {
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  assert.equal(boundId, id, 'Deletion target must still be this fixture Conversation binding')
  const seed = stages.find(stage => stage.stage === 'seed')
  assert.equal(seed?.status, 'succeeded')
  assert.equal(seed.currentId, id)
  assert.ok(!seed.previousId, 'The fixture must have created its own native target')
  assert.ok(stages.some(stage => ['cold', 'cold-recheck'].includes(stage.stage)
    && stage.status === 'succeeded' && stage.previousId === id && stage.currentId === id))
  assert.ok(seed.requests.some(row => row.direction === 'launch' && row.cwd === project),
    'The observed native launch must belong to this test project')
  const exactPath = join(root, kind === 'antigravity-app' ? `${id}.db` : id)
  assert.equal(await realpath(exactPath), exactPath, 'Native target must not redirect outside the exact path')
  if (kind === 'trae-cn-cli') {
    assert.ok((await lstat(exactPath)).isDirectory())
    const metadataPath = join(exactPath, 'session.json')
    assert.ok((await lstat(metadataPath)).isFile(), 'Native metadata must be a regular file')
    const session = JSON.parse(await readFile(metadataPath, 'utf8'))
    assert.equal(session.id, id)
    assert.equal(session.metadata?.cwd, project)
    return [exactPath]
  }
  assert.equal(kind, 'antigravity-app')
  assert.ok((await lstat(exactPath)).isFile())
  const db = new DatabaseSync(exactPath, { readOnly: true })
  try {
    const identities = db.prepare('SELECT cascade_id FROM trajectory_meta').all()
    assert.equal(identities.length, 1)
    assert.equal(identities[0].cascade_id, id)
  } finally { db.close() }
  const paths = [exactPath]
  for (const suffix of ['-wal', '-shm']) {
    const path = exactPath + suffix
    try {
      assert.ok((await lstat(path)).isFile(), 'Native sidecar must be a regular file')
      paths.push(path)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  return paths
}
