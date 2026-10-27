import { constants } from 'node:fs'
import { access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'

async function executable(directory) {
  try {
    await access(join(directory, process.platform === 'win32' ? 'cargo.exe' : 'cargo'), constants.X_OK)
    return true
  } catch (error) {
    if (['ENOENT', 'EACCES'].includes(error.code)) return false
    throw error
  }
}

// A GUI-launched App may only inherit the system PATH. The Host already knows
// its Node executable; make that runtime and Cargo available to all children.
export async function evaluationBuildPath(path = process.env.PATH ?? '', fallbackDirectories = [
  join(homedir(), '.cargo', 'bin'),
  '/opt/homebrew/opt/rustup/bin',
  '/usr/local/opt/rustup/bin',
  '/opt/homebrew/bin',
  '/usr/local/bin'
]) {
  const nodeDirectory = dirname(process.execPath)
  const withNode = path.split(delimiter).includes(nodeDirectory)
    ? path
    : [nodeDirectory, path].filter(Boolean).join(delimiter)
  for (const directory of withNode.split(delimiter).filter(Boolean)) if (await executable(directory)) return withNode
  for (const directory of fallbackDirectories) if (await executable(directory)) return [directory, withNode].filter(Boolean).join(delimiter)
  throw new Error('Cargo executable is unavailable to the Evaluation Host')
}
