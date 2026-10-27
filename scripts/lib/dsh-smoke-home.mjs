// Acceptance-only settings projection. Credentials stay in the caller's
// environment; the production Adapter continues to use DSH's native Home.
import { chmod, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export async function prepareDshSmokeHome(home, extraPatches = []) {
  await mkdir(home, { recursive: true, mode: 0o700 })
  const settings = process.env.ROVAI_DSH_SMOKE_SETTINGS_PATH
  if (settings) {
    const target = join(home, 'settings.yaml')
    await copyFile(settings, target)
    await chmod(target, 0o600)
  }
  const patchPath = process.env.ROVAI_DSH_SMOKE_PATCH_PATH
  const patches = patchPath ? JSON.parse(await readFile(patchPath, 'utf8')) : []
  if (!Array.isArray(patches)) throw new Error('DSH smoke patch must be a JSON array')
  if (patches.length || extraPatches.length) {
    await writeFile(join(home, 'cordis.patch.yml'), JSON.stringify([...patches, ...extraPatches]), { mode: 0o600 })
  }
}
