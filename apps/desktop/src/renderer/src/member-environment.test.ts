import { describe, expect, it } from 'vitest'
import { mergeEnvironment, parseMemberEnvironment } from './member-environment'

const parse = (text: string, windows = false) => parseMemberEnvironment(text, windows, 'pi', undefined)

describe('member environment JSON boundary', () => {
  it('normalizes primitives without changing drafts or literal strings and merges the actual string values', () => {
    const draft = '{ "TIMEOUT_MS": 60000, "RATIO": 1.5, "ZERO": 0, "NEGATIVE_ZERO": -0, "YES": true, "NO": false, "EMPTY": "", "PADDED": "00123", "MAX": 9007199254740991 }'
    const values = parse(draft)
    expect(values).toEqual({ TIMEOUT_MS: '60000', RATIO: '1.5', ZERO: '0', NEGATIVE_ZERO: '0', YES: 'true', NO: 'false', EMPTY: '', PADDED: '00123', MAX: '9007199254740991' })
    expect(draft).toContain('"TIMEOUT_MS": 60000')
    const literal = { KEY: '<saved>', EMPTY: '', LITERAL: ' $HOME ${VAR} ~ " quote\n$(echo no) ', JSON: '{"enabled":true}' }
    expect(parse(JSON.stringify(literal))).toEqual(literal)
    expect(parse('')).toEqual({})
    const common = parse('{"TIMEOUT_MS":60000,"NO":true,"EMPTY":"default"}')
    const local = parse('{"NO":false,"EMPTY":"","ZERO":0}')
    expect(mergeEnvironment(common, local, true)).toEqual({ TIMEOUT_MS: '60000', NO: 'false', EMPTY: '', ZERO: '0' })
    expect(mergeEnvironment(common, local, false)).toEqual(local)
    expect(mergeEnvironment(common, {}, true)).toEqual(common)
  })
  it('names unsupported values and unsafe numbers without dropping entries', () => {
    for (const value of ['null', '[]', '{}']) {
      expect(() => parse(`{"VALID":0,"OPTIONS":${value}}`)).toThrow('变量「OPTIONS」的值仅支持字符串、数字或布尔值。')
    }
    for (const value of ['1e400', '-1e400', '9007199254740992', '9007199254740993', '-9007199254740993']) {
      expect(() => parse(`{"LIMIT":${value}}`)).toThrow('变量「LIMIT」的数字无法安全表示，请改用字符串。')
      expect(parse(`{"LIMIT":"${value}"}`)).toEqual({ LIMIT: value })
    }
  })
  it('rejects duplicate decoded keys, Windows aliases, invalid names and reserved variables', () => {
    for (const text of ['{"A":1,"\\u0041":false}', '[]', 'null', '{"1KEY":"x"}', '{"A-B":"x"}', '{"rovai_TOKEN":"secret"}', '{"CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST":"1"}', '{"X":"\\u0000"}']) {
      expect(() => parse(text)).toThrow()
    }
    expect(() => parse('{"Path":0,"PATH":false}', true)).toThrow()
    expect(parse('{"Path":0,"PATH":false}')).toEqual({ Path: '0', PATH: 'false' })
    expect(parse('{"Key2":true}', true)).toEqual({ KEY2: 'true' })
    expect(() => parseMemberEnvironment('{"ANTHROPIC_MODEL":"relay"}', false, 'claude-code-cli', { mode: 'explicit', modelId: 'selected', options: {} })).toThrow()
    expect(parseMemberEnvironment('{"ANTHROPIC_MODEL":"relay"}', false, 'claude-code-cli', { mode: 'runtime_default' })).toEqual({ ANTHROPIC_MODEL: 'relay' })
  })
  it('accepts large maps and long names within the retained UTF-8 capacity limits', () => {
    const values = Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`KEY_${index}`, '']))
    values['K'.repeat(257)] = 'long name'
    expect(parse(JSON.stringify(values))).toEqual(values)
    expect(() => parse(JSON.stringify({ X: '界'.repeat(21846) }))).toThrow('64 KiB')
    expect(() => parse(JSON.stringify({ A: 'x'.repeat(65536), B: 'x'.repeat(65536) }))).toThrow('总长度')
  })
  it('passes through a URL-only override without provider credential pairing', () => {
    expect(parseMemberEnvironment('{"ANTHROPIC_BASE_URL":"https://b.example"}', false, 'claude-code-cli', undefined))
      .toEqual({ ANTHROPIC_BASE_URL: 'https://b.example' })
  })
})
