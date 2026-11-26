import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * 把 pdf.js 的运行时资产从 node_modules 复制到 Renderer 的 public 目录。
 *
 * 生产 `loadFile` 下页面只能通过主进程的 `rovai-pdfjs://asset/…` 读这些文件，主进程的资产
 * 根是 `out/renderer/pdfjs`（Vite public 目录的构建输出）。所以缺任何一项都必须让安装失败：
 * 静默跳过只会换来一个「打开 PDF 就报错」的构建产物。
 */

const ROOT = resolve(import.meta.dirname, '..')
const FROM = join(ROOT, 'node_modules', 'pdfjs-dist')
const TO = join(ROOT, 'apps', 'desktop', 'src', 'renderer', 'public', 'pdfjs')

/** 少一项，PDF 预览就会出现字体、编码或解码失败；这里的清单就是最低要求。 */
const ASSETS = [
  ['legacy/build/pdf.worker.min.mjs', 'pdf.worker.min.mjs'],
  ['cmaps', 'cmaps'],
  ['standard_fonts', 'standard_fonts'],
  ['wasm', 'wasm'],
  ['iccs', 'iccs']
]

if (!existsSync(FROM)) {
  console.error(`pdfjs-dist is not installed at ${FROM}; renderer PDF preview assets cannot be generated.`)
  process.exit(1)
}

const missing = ASSETS
  .map(([source]) => source)
  .filter((source) => !existsSync(join(FROM, source)))

if (missing.length > 0) {
  console.error(`pdfjs-dist is missing required assets: ${missing.join(', ')}`)
  process.exit(1)
}

rmSync(TO, { recursive: true, force: true })
mkdirSync(TO, { recursive: true })
for (const [source, destination] of ASSETS) {
  cpSync(join(FROM, source), join(TO, destination), { recursive: true })
}

const empty = ASSETS
  .map(([, destination]) => destination)
  .filter((destination) => !existsSync(join(TO, destination)))

if (empty.length > 0) {
  console.error(`pdf.js assets were not copied: ${empty.join(', ')}`)
  process.exit(1)
}

console.log(`pdf.js runtime assets copied to ${TO}`)
