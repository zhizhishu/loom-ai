import { constants } from 'node:fs'
import { access, mkdir, readlink, symlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'

// Installed App initialization only. Runtime launch never installs or checks this
// entry. App updates replace the bundle at the same path, so the link stays valid.
export async function installBundledCliEntry(cliExecutable: string, home: string): Promise<void> {
  if (!isAbsolute(cliExecutable) || !isAbsolute(home)) {
    throw new Error('Bundled CLI installation requires absolute paths.')
  }
  await access(cliExecutable, constants.X_OK)
  const entry = join(home, '.local', 'bin', 'rovai')
  await mkdir(dirname(entry), { recursive: true })
  try {
    await symlink(cliExecutable, entry)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const target = await readlink(entry).catch(() => null)
    if (target === null || resolve(dirname(entry), target) !== resolve(cliExecutable)) {
      throw new Error(`The rovai command at ${entry} already belongs to another installation or user file; it was left unchanged.`)
    }
  }
}
