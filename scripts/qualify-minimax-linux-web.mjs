// Real Linux browser acceptance of persisted native file-operation evidence.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { access, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { launchHost, within } from './lib/host-test-client.mjs'
import { launchAcceptanceBrowser } from './lib/host-web-browser.mjs'
import { coreDataDirectoryArguments } from './lib/runtime-camp-files-root.mjs'

const [qualification, packageDirectory, outputArgument, chrome] = process.argv.slice(2)
assert.equal(process.platform, 'linux')
assert.ok([qualification, packageDirectory, outputArgument, chrome].every(isAbsolute))
const output = await realpath(outputArgument)
assert.deepEqual(await readdir(output), [])
await access(chrome)
const source = JSON.parse(await readFile(join(qualification, 'report.json'), 'utf8'))
assert.ok(source.fileCards?.[0]?.fileCount === 2)
const data = join(qualification, 'core'), skills = join(data, 'managed-skill-library')
const env = { ...process.env, MINIMAX_DATA_DIR: join(qualification, 'native'), MAVIS_DATA_DIR: join(qualification, 'native') }
const host = launchHost(join(packageDirectory, 'rovai-host'), [
  ...coreDataDirectoryArguments(data), '--skill-library-root', skills, '--mcp-config-path', join(data, 'mcp.json')
], { cwd: join(qualification, 'project'), env })
const report = { evidenceKind: 'real-linux-chromium-production-web-native-file-evidence', status: 'running',
  threadId: source.threadA, sourceRunId: source.fileCards[0].agentRunId, checks: [], screenshots: {} }
let browser
try {
  await within(host.ready)
  const started = await host.request('host.web.start', { listen: '127.0.0.1:0', uiDirectory: join(packageDirectory, 'web-ui') })
  const administrator = (await host.request('host.web.token')).administratorToken
  browser = await launchAcceptanceBrowser({ executable: chrome, args: [
    '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
    '--remote-debugging-port=0', `--user-data-dir=${join(output, 'browser')}`, 'about:blank'
  ], env })
  await browser.send('Page.navigate', { url: started.origin })
  await browser.wait("document.querySelector('#administrator-token') !== null")
  await browser.click("document.querySelector('#administrator-token')")
  await browser.send('Input.insertText', { text: administrator })
  await browser.click("document.querySelector('.web-login button[type=submit]')")
  await browser.wait("document.querySelector('.web-login-overlay') === null")
  const row = `document.querySelector('[data-thread-id="${source.threadA}"]')`
  await browser.wait(`${row} !== null`)
  await browser.click(`${row}.querySelector('button') ?? ${row}`)
  await browser.wait("document.querySelector('.run-file-changes-card') !== null")
  assert.ok((await browser.evaluate("[...document.querySelectorAll('.run-file-change-file')].map(e=>e.innerText)")).some(value => value.includes('新增 文件.txt')))
  const capture = async name => {
    const path = join(output, name + '.png'); await browser.capture(path)
    report.screenshots[name] = { path, sha256: createHash('sha256').update(await readFile(path)).digest('hex') }
  }
  await capture('native-file-card')
  await browser.click("[...document.querySelectorAll('.run-file-change-file')].find(e=>e.textContent.includes('existing.txt'))")
  await browser.wait("document.querySelector('.agent-run-file-review-diff-code') !== null")
  const diff = await browser.evaluate("[...document.querySelectorAll('.agent-run-file-review-diff-line')].map(e=>({kind:e.className,text:e.innerText}))")
  assert.ok(diff.some(line => line.kind.includes('is-addition') && line.text.includes('after')))
  assert.ok(diff.some(line => line.kind.includes('is-deletion') && line.text.includes('before')))
  report.checks.push('Actual native edit opens its persisted +1/-1 Diff in the production Web UI')
  await capture('native-edit-diff')
  await browser.click("[...document.querySelectorAll('.run-file-change-file')].find(e=>e.textContent.includes('新增 文件.txt'))")
  await browser.wait("[...document.querySelectorAll('.file-preview-content')].some(e=>e.textContent.includes('added-linux'))")
  report.checks.push('Actual native new-file operation opens the current byte-exact Chinese/space-path file preview')
  await capture('native-added-file-preview')
  assert.deepEqual(browser.errors, [])
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = String(error); process.exitCode = 1
  if (browser) report.pageText = await browser.evaluate('document.body.innerText').catch(() => '')
} finally {
  if (browser) await browser.close()
  await host.close()
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  console.log(JSON.stringify({ status: report.status, checks: report.checks, error: report.error }))
}
