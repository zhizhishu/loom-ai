import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import test from 'node:test'

const repository = resolve(import.meta.dirname, '../..')
const scriptPath = join(repository, 'scripts/provision-remote-runtimes.sh')
const read = () => readFileSync(scriptPath, 'utf8')

test('Remote Runtime provisioning script installs the probed CLIs idempotently', () => {
  assert.ok(existsSync(scriptPath))
  const script = read()
  assert.match(script, /^#!\/bin\/sh\n/)
  assert.match(script, /^set -eu$/m)
  assert.match(script, /@anthropic-ai\/claude-code/)
  assert.match(script, /@openai\/codex/)
  assert.match(script, /npm install --global --prefix "\$npm_global_prefix" "\$package"/)
  assert.match(script, /already installed at/)
  assert.doesNotMatch(script, /\bread -r\b|\bsudo\b|\bapt(?:-get)?\b/)
})

test('Remote Runtime provisioning parses --only and --prefix and gates on Node.js 22 first', () => {
  const script = read()
  assert.match(script, /--only\)/)
  assert.match(script, /claude\|codex\) only=\$2;;/)
  assert.match(script, /--prefix\)/)
  assert.match(script, /npm prefix --global/)
  const gate = script.indexOf('is too old. Install Node.js 22')
  const install = script.indexOf('npm install --global')
  assert.ok(gate > 0 && install > gate, 'the Node.js version gate must precede any npm install')
})

test('Remote Runtime provisioning pipes no download into a shell and writes no credentials', () => {
  const script = read()
  assert.doesNotMatch(script, /\bcurl\b|\bwget\b/)
  assert.doesNotMatch(script, /\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/)
  assert.doesNotMatch(script, /ANTHROPIC_API_KEY|OPENAI_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_AUTH_TOKEN/)
  assert.doesNotMatch(script, /echo\b[^\n]*>/)
  assert.match(script, /codex login/)
  assert.match(script, /claude/)
})
