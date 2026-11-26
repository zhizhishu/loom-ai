import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createPdfjsAssetHandler,
  parsePdfjsAssetUrl,
  pdfjsAssetContentType,
  resolvePdfjsAssetPath
} from './pdfjs-asset-protocol'

const ROOT = resolve('/app/out/renderer/pdfjs')
const inside = (path: string | null): boolean =>
  path !== null && (path === ROOT || path.startsWith(`${ROOT}${sep}`))

describe('pdf.js privileged protocol request parsing', () => {
  it('accepts the asset URLs the renderer actually builds', () => {
    expect(parsePdfjsAssetUrl('rovai-pdfjs://asset/cmaps/Adobe-Japan1-UCS2.bcmap'))
      .toEqual(['cmaps', 'Adobe-Japan1-UCS2.bcmap'])
    expect(parsePdfjsAssetUrl('rovai-pdfjs://asset/wasm/openjpeg.wasm')).toEqual(['wasm', 'openjpeg.wasm'])
    expect(parsePdfjsAssetUrl('rovai-pdfjs://asset/standard_fonts/FoxitSans.pfb'))
      .toEqual(['standard_fonts', 'FoxitSans.pfb'])
    expect(parsePdfjsAssetUrl('rovai-pdfjs://asset/iccs/CGATS001Compat-v2-micro.icc'))
      .toEqual(['iccs', 'CGATS001Compat-v2-micro.icc'])
    // worker 地址带 `?v=<版本>`：查询串只做缓存破除，不参与取文件。
    expect(parsePdfjsAssetUrl('rovai-pdfjs://asset/pdf.worker.min.mjs?v=6.4.299'))
      .toEqual(['pdf.worker.min.mjs'])
  })

  it('rejects absolute paths, backslash escapes, and foreign origins', () => {
    for (const url of [
      'rovai-pdfjs://asset//etc/passwd',
      'rovai-pdfjs://asset/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      'rovai-pdfjs://asset/cmaps\\..\\..\\secret.bcmap',
      'rovai-pdfjs://asset/..%5c..%5csecret.bcmap',
      'rovai-pdfjs://asset/C:/Windows/win.ini',
      'rovai-pdfjs://asset/cmaps/%00.bcmap',
      'rovai-pdfjs://asset/',
      'rovai-pdfjs://asset',
      'rovai-pdfjs://asset/cmaps/',
      'rovai-pdfjs://evil/cmaps/x.bcmap',
      'rovai-pdfjs://user:pass@asset/cmaps/x.bcmap',
      'rovai-pdfjs://asset:8080/cmaps/x.bcmap',
      'file:///app/out/renderer/pdfjs/cmaps/x.bcmap',
      'https://asset/cmaps/x.bcmap',
      'not a url'
    ]) expect(parsePdfjsAssetUrl(url)).toBeNull()
  })

  it('never resolves outside the asset root, however the path is spelled', () => {
    for (const url of [
      'rovai-pdfjs://asset/../../../etc/passwd',
      'rovai-pdfjs://asset/cmaps/%2e%2e/%2e%2e/secret.bcmap',
      'rovai-pdfjs://asset/./cmaps/UniJIS-UCS2-H.bcmap'
    ]) expect(inside(resolvePdfjsAssetPath(ROOT, url))).toBe(true)
    // 点段被 URL 解析归一后仍在白名单根内：`/etc/passwd` 只是根下的 `etc/passwd`，读不到系统文件。
    expect(resolvePdfjsAssetPath(ROOT, 'rovai-pdfjs://asset/../../../etc/passwd'))
      .toBe(join(ROOT, 'etc', 'passwd'))
    expect(resolvePdfjsAssetPath(ROOT, 'rovai-pdfjs://asset/cmaps/UniJIS-UCS2-H.bcmap'))
      .toBe(join(ROOT, 'cmaps', 'UniJIS-UCS2-H.bcmap'))
    for (const url of [
      'rovai-pdfjs://asset/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      'rovai-pdfjs://asset/..%5c..%5csecret.bcmap',
      'rovai-pdfjs://asset//etc/passwd'
    ]) expect(resolvePdfjsAssetPath(ROOT, url)).toBeNull()
  })

  it('serves module workers and wasm with usable content types', () => {
    expect(pdfjsAssetContentType('pdf.worker.min.mjs')).toContain('text/javascript')
    expect(pdfjsAssetContentType('openjpeg.wasm')).toBe('application/wasm')
    // 其余资产可以退化成不透明字节，但不能是空串或错误类型。
    for (const path of ['UniJIS-UCS2-H.bcmap', 'FoxitSans.pfb', 'CGATS001Compat-v2-micro.icc']) {
      expect(pdfjsAssetContentType(path)).toBe('application/octet-stream')
    }
  })
})

describe('pdf.js privileged protocol handler', () => {
  const roots: string[] = []
  afterEach(async () => {
    await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  })
  const fixture = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), 'rovai-pdfjs-'))
    roots.push(root)
    await mkdir(join(root, 'cmaps'), { recursive: true })
    await writeFile(join(root, 'cmaps', 'UniJIS-UCS2-H.bcmap'), 'bcmap-bytes')
    await writeFile(join(root, 'pdf.worker.min.mjs'), 'export const worker = true')
    return root
  }

  it('returns the file with CORS and content type headers', async () => {
    const handle = createPdfjsAssetHandler(await fixture())
    const response = await handle(new Request('rovai-pdfjs://asset/pdf.worker.min.mjs?v=6.4.299'))
    expect(response.status).toBe(200)
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('*')
    expect(response.headers.get('Content-Type')).toContain('text/javascript')
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(await response.text()).toBe('export const worker = true')
  })

  it('answers traversal and missing assets with 404', async () => {
    const handle = createPdfjsAssetHandler(await fixture())
    for (const url of [
      'rovai-pdfjs://asset/%2e%2e%2f%2e%2e%2fetc%2fpasswd',
      'rovai-pdfjs://asset/..%5c..%5coutside.txt',
      'rovai-pdfjs://asset//etc/passwd',
      'rovai-pdfjs://asset/cmaps/',
      'rovai-pdfjs://asset/absent.bcmap'
    ]) expect((await handle(new Request(url))).status).toBe(404)
  })

  it('only serves reads', async () => {
    const handle = createPdfjsAssetHandler(await fixture())
    expect((await handle(new Request('rovai-pdfjs://asset/pdf.worker.min.mjs', { method: 'POST' }))).status).toBe(405)
    const head = await handle(new Request('rovai-pdfjs://asset/pdf.worker.min.mjs', { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })
})
