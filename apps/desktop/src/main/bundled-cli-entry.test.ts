import { mkdtemp, mkdir, readFile, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { installBundledCliEntry } from './bundled-cli-entry'

const roots: string[] = []
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'rovai-cli-install-'))
  roots.push(root)
  const cli = join(root, 'Rovai AI.app', 'Contents', 'Resources', 'bin', 'rovai')
  const home = join(root, 'user')
  await mkdir(dirname(cli), { recursive: true })
  await writeFile(cli, '#!/bin/sh\necho first\n', { mode: 0o755 })
  return { cli, home, entry: join(home, '.local', 'bin', 'rovai') }
}
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('installed bundled CLI entry', () => {
  it('provides the bundled command once and follows an in-place App update', async () => {
    const { cli, home, entry } = await fixture()
    await Promise.all([installBundledCliEntry(cli, home), installBundledCliEntry(cli, home)])
    expect(await readlink(entry)).toBe(cli)
    await writeFile(cli, '#!/bin/sh\necho updated\n')
    await installBundledCliEntry(cli, home)
    expect(await readFile(entry, 'utf8')).toContain('updated')
  })

  it('preserves user files and foreign links, including broken ones', async () => {
    const { cli, home, entry } = await fixture()
    await mkdir(dirname(entry), { recursive: true })
    await writeFile(entry, 'user command')
    await expect(installBundledCliEntry(cli, home)).rejects.toThrow('left unchanged')
    expect(await readFile(entry, 'utf8')).toBe('user command')
    await rm(entry)
    const foreign = join(home, 'missing-foreign-cli')
    await symlink(foreign, entry)
    await expect(installBundledCliEntry(cli, home)).rejects.toThrow('left unchanged')
    expect(await readlink(entry)).toBe(foreign)
  })
})
