import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:http'
import { once } from 'node:events'

const probe = fileURLToPath(new URL('../../docker/healthcheck.sh', import.meta.url)).replaceAll('\\', '/')
const shell = process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : '/bin/sh'
const stub = `curl() {
  printf '%s\\n' "$@" > "$CHECK_ARGS"
  printf '%s' "$CHECK_STATUS"
  return "$CHECK_EXIT"
}
. "$1"`

function check(listen, status = '200', curlExit = '0') {
  const directory = mkdtempSync(join(tmpdir(), 'loom-health-test-'))
  const record = join(directory, 'curl-args').replaceAll('\\', '/')
  try {
    const env = { ...process.env, CHECK_ARGS: record, CHECK_STATUS: status, CHECK_EXIT: curlExit }
    if (listen === undefined) delete env.LISTEN
    else env.LISTEN = listen
    const result = spawnSync(shell, ['-c', stub, 'health-test', probe], { env, encoding: 'utf8', timeout: 10000 })
    assert.ifError(result.error)
    return { code: result.status, args: existsSync(record) ? readFileSync(record, 'utf8').trim().split('\n') : [], stderr: result.stderr }
  } finally { rmSync(directory, { recursive: true, force: true }) }
}

for (const [listen, url] of [
  [undefined, 'http://127.0.0.1:8767/'],
  ['0.0.0.0:18767', 'http://127.0.0.1:18767/'],
  ['127.0.0.1:18768', 'http://127.0.0.1:18768/'],
  ['[::]:18767', 'http://[::1]:18767/'],
  ['[::1]:8767', 'http://[::1]:8767/'],
  ['10.0.0.8:8767', 'http://10.0.0.8:8767/']
]) {
  test(`container probe follows ${listen ?? 'default LISTEN'} without a proxy or credential`, () => {
    const result = check(listen)
    assert.equal(result.code, 0, result.stderr)
    assert.equal(result.args.at(-1), url)
    assert.deepEqual(result.args.slice(0, 4), ['--noproxy', '*', '--max-time', '4'])
    assert.ok(!result.args.includes('-L'), 'redirects must not count as the bound service')
    assert.ok(!result.args.includes('-H'), 'health checking must not use an Owner token')
  })
}

test('invalid listen addresses and ports never call curl', () => {
  for (const listen of ['8767', ':8767', '0.0.0.0:0', '0.0.0.0:65536', '0.0.0.0:-1', '0.0.0.0:8;echo bad', '0.0.0.0:999999999999999999999', 'https://user:password@example.test:8767']) {
    const result = check(listen)
    assert.equal(result.code, 1, listen)
    assert.deepEqual(result.args, [], listen)
    assert.ok(!result.stderr.includes('password'), 'invalid input is not echoed')
  }
})

test('connection failures, redirects and non-200 responses remain unhealthy', () => {
  assert.equal(check('127.0.0.1:18767', '000', '7').code, 1)
  for (const status of ['301', '401', '404', '503']) assert.equal(check('127.0.0.1:18767', status).code, 1)
})

test('the real shell and curl probe a non-default listener and reject a failing listener', async () => {
  let status = 200
  const server = createServer((_request, response) => { response.writeHead(status); response.end('health fixture') })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const port = server.address().port
  const execute = () => new Promise((resolve, reject) => {
    const child = spawn(shell, [probe], {
      env: { ...process.env, LISTEN: `127.0.0.1:${port}`, HTTP_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9' },
      stdio: ['ignore', 'ignore', 'pipe']
    })
    let stderr = ''
    child.stderr.on('data', data => { stderr += data.toString() })
    const timeout = setTimeout(() => child.kill(), 10000)
    child.once('error', reject)
    child.once('close', code => { clearTimeout(timeout); resolve({ code, stderr }) })
  })
  try {
    assert.equal((await execute()).code, 0)
    status = 503
    assert.equal((await execute()).code, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
})
