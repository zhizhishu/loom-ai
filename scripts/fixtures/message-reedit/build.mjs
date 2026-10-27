import { build } from 'vite'
import react from '@vitejs/plugin-react'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { execFileSync } from 'node:child_process'
const root = resolve(import.meta.dirname, '../../..')
const out = resolve(process.argv[2] ?? join(root, 'docs/prototypes/withdraw-reedit-v4'))
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
function once(code, from, to) {
  if (code.split(from).length !== 2) throw Error('Review seam changed: ' + from)
  return code.replace(from, to)
}
const reviewPlugin = { name: 'isolated-reedit-review', enforce: 'pre', transform(code, id) {
  if (id.endsWith('/ThreadWorkspace.tsx')) {
    return { code: `import { review as reeditReview } from ${JSON.stringify(join(import.meta.dirname, 'model.ts'))};\n`
      + once(code, '  const composerHandleRef = useRef<StructuredMentionComposerHandle>(null)',
        '  const composerHandleRef = useRef<StructuredMentionComposerHandle>(null)\n  reeditReview.editorRef = composerHandleRef'), map: null }
  }
  if (id.endsWith('/camp-composer-local-store.ts')) return { code: once(code,
    "const STORAGE_PREFIX = 'rovai.camp-composer-draft.v1:'", "const STORAGE_PREFIX = 'rovai.withdraw-reedit-review.v4.draft:'"), map: null }
} }
const result = await build({ configFile: false, root: import.meta.dirname, base: './', logLevel: 'warn',
  plugins: [reviewPlugin, react()], resolve: { alias: { '@contracts': join(root, 'packages/contracts/src/index.ts') } },
  define: { __SOURCE_COMMIT__: JSON.stringify(sourceCommit) },
  build: { write: false, assetsInlineLimit: Number.MAX_SAFE_INTEGER, cssCodeSplit: false, rollupOptions: { output: { inlineDynamicImports: true } } } })
const bundle = (Array.isArray(result) ? result[0] : result).output
const js = bundle.filter(item => item.type === 'chunk').map(item => item.code).join('\n')
const css = bundle.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => item.source).join('\n')
await mkdir(out, { recursive: true })
const html = '<!doctype html><html lang="zh-CN" data-theme="day"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Rovai · 两分钟内重新编辑</title><style>'
  + css + '</style></head><body><div id="root"></div><script type="module">' + js.replaceAll('</script', '<\\/script') + '</script></body></html>'
await writeFile(join(out, 'rovai-withdraw-reedit.html'), html)
console.log(JSON.stringify({ out, sourceCommit, bytes: Buffer.byteLength(html) }))
