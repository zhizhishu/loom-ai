import { fileURLToPath } from 'node:url'
import { runMacosReleaseBuild } from './lib/macos-release-build-retry.mjs'

const [arch, ...extra] = process.argv.slice(2)
if (!['arm64', 'x64'].includes(arch) || extra.length) {
  console.error('Usage: node scripts/retry-macos-build.mjs <arm64|x64>')
  process.exit(2)
}
try {
  await runMacosReleaseBuild(arch, { cwd: fileURLToPath(new URL('..', import.meta.url)) })
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
}
