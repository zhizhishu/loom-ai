import test from 'node:test'
import assert from 'node:assert/strict'
import { capabilityAcceptancePrompt, parseArguments } from '../accept-core-dsh-capabilities.mjs'

test('the original registry acceptance remains byte-for-byte unchanged by default', () => {
  const echoMarker = 'MCP_MARK_public_test_nonce'
  assert.equal(capabilityAcceptancePrompt({ echoMarker }), [
    'This is an isolated LOOM acceptance. Use the provided capabilities exactly as instructed.',
    '1. Load the isolated acceptance skill and return the skill marker it contains.',
    '2. Return the rule marker from your selected rule.',
    `3. Call the parity MCP tool echo exactly once with text ${echoMarker} and return its actual result.`,
    '4. Then reply exactly DONE.',
    'Do not read or write files, do not run shell commands, and do not ask for broader permissions.'
  ].join('\n'))
  assert.equal(parseArguments([]).skillTransport, undefined)
})

test('frozen-resource reading is explicit, narrow and is not a native-registry claim', () => {
  const input = { skillTransport: 'core-index-read', echoMarker: 'MCP_MARK_public',
    skillMarker: 'SKILL_MARK_must_stay_private', ruleMarker: 'RULE_MARK_must_stay_private',
    root: 'C:/not-an-authorized-path' }
  const prompt = capabilityAcceptancePrompt(input)
  assert.match(prompt, /this Run's \[ROVAI_ADDITIONAL_SKILLS\] root/u)
  assert.match(prompt, /single selected SKILL\.md read/u)
  assert.match(prompt, /not the native skill registry/u)
  assert.match(prompt, /native tool refuses, stop/u)
  assert.match(prompt, /do not search other roots, change configuration, request broader permissions, or bypass/u)
  assert.match(prompt, /Do not write any file or run a shell command/u)
  for (const secret of [input.skillMarker, input.ruleMarker, input.root]) assert.equal(prompt.includes(secret), false)
  assert.equal(parseArguments(['--skill-transport', 'core-index-read']).skillTransport, 'core-index-read')
  assert.equal(parseArguments(['--skill-transport', 'native-registry']).skillTransport, 'native-registry')
})

test('an unrecognized transport or a broader permission mode is never an implicit fallback', () => {
  for (const skillTransport of ['', 'auto', 'all-files', 'native-registry,core-index-read']) {
    assert.throws(() => capabilityAcceptancePrompt({ skillTransport }), /unknown Skill transport/u)
    assert.throws(() => parseArguments(['--skill-transport', skillTransport]), /skill-transport/u)
  }
  assert.throws(() => parseArguments(['--skill-transport', 'core-index-read', '--permission-mode', 'danger-full-access']), /permission-mode/u)
})
