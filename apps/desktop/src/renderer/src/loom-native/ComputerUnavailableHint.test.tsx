import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ComputerStatus } from './host-services'
import { COMPUTER_HINT_HELP_ID, ComputerUnavailableHintView, computerHintModel, selectRetry, type ComputerHintInput } from './ComputerUnavailableHint'

// 只验证「提示是否出现、三个按钮是否可点、有没有外链」：模型是纯函数，
// 视图走 SSR 字符串，不引入 DOM 依赖，也不接触 Host 端口或授权。

const status = (over: Partial<ComputerStatus> = {}): ComputerStatus => ({
  configured: true,
  ready: true,
  reason: null,
  device: { deviceId: 'local', platform: 'win32', bounds: { x: 0, y: 0, width: 1280, height: 800 } },
  view: null,
  control: null,
  serverTime: 1_700_000_000_000,
  limits: { maxTextCodepoints: 2048, minFrameIntervalMs: 650, controlTotalSeconds: 300, inputIdleSeconds: 60 },
  ...over
})

const input = (over: Partial<ComputerHintInput> = {}): ComputerHintInput => ({
  hasPort: true,
  status: status(),
  viewActive: false,
  busy: false,
  hasRefresh: true,
  hasRetryDiscovery: false,
  hasOpenSettings: false,
  statusFailed: false,
  ...over
})

const markup = (over: Partial<ComputerHintInput> = {}, helpOpen = false) =>
  renderToStaticMarkup(
    <ComputerUnavailableHintView model={computerHintModel(input(over))} helpOpen={helpOpen} />
  )

const button = (html: string, label: string) => new RegExp(`<button[^>]*>${label}</button>`).exec(html)?.[0] ?? null

describe('computerHintModel 出现条件', () => {
  it('健康且已就绪的设备不出提示', () => {
    const model = computerHintModel(input())
    expect(model.show).toBe(false)
    expect(model.reason).toBe(null)
    expect(renderToStaticMarkup(<ComputerUnavailableHintView model={model} helpOpen={false} />)).toBe('')
  })

  it('查看进行中即便状态未就绪也不出提示', () => {
    const model = computerHintModel(input({ viewActive: true, status: status({ ready: false, reason: 'computer_backend_unavailable' }) }))
    expect(model.show).toBe(false)
  })

  it('状态未知时先不判不可用', () => {
    expect(computerHintModel(input({ status: null })).show).toBe(false)
  })

  it('没有端口时提示不支持，且能如实说明没有检查入口', () => {
    const model = computerHintModel(input({ hasPort: false, hasRefresh: false, status: null }))
    expect(model.show).toBe(true)
    expect(model.reason).toBe('unsupported')
    expect(model.retry.disabled).toBe(true)
    expect(model.retry.note).toContain('没有电脑画面接口')
    expect(model.settings.disabled).toBe(true)
    expect(model.settings.note).toContain('设置 › 设备')
    expect(model.help.label).toBe('设置帮助')
  })

  it('未配置 / 无桌面 / 未就绪三种原因互不冒充', () => {
    expect(computerHintModel(input({ status: status({ configured: false, ready: false, device: null }) })).reason).toBe('not-configured')
    expect(computerHintModel(input({ status: status({ ready: false, device: null }) })).reason).toBe('device-missing')
    expect(computerHintModel(input({ status: status({ ready: false, reason: 'computer_session_locked' }) })).reason).toBe('not-ready')
  })

  it('端口在就能重新检查，检查中禁用并换标签', () => {
    expect(computerHintModel(input({ status: status({ ready: false }) })).retry.disabled).toBe(false)
    expect(computerHintModel(input({ status: status({ ready: false }), busy: true })).retry).toMatchObject({ disabled: true, label: '检查中…', note: null })
  })

  it('可重新检查只认真实回调，不拿端口当检查能力', () => {
    const model = computerHintModel(input({ status: status({ ready: false }), hasRefresh: false }))
    expect(model.retry.disabled).toBe(true)
    expect(model.retry.note).toContain('无法重新检查')
  })

  it('重新检查优先用真实的状态重读，发现回调只做后备', () => {
    const refresh = () => {}
    const discovery = () => {}
    expect(selectRetry({ refreshStatus: refresh, retryDiscovery: discovery })).toBe(refresh)
    expect(selectRetry({ retryDiscovery: discovery })).toBe(discovery)
    expect(selectRetry({ refreshStatus: refresh })).toBe(refresh)
    expect(selectRetry({})).toBe(undefined)
  })

  it('状态读取真失败时即便从没拿到状态也出提示，且可重新检查', () => {
    const model = computerHintModel(input({ status: null, statusFailed: true }))
    expect(model.show).toBe(true)
    expect(model.reason).toBe('check-failed')
    expect(model.retry.disabled).toBe(false)
    expect(model.message).toContain('没能确认这台电脑的状态')
  })

  it('上一次读到健康状态但本次读取失败时也不冒充健康', () => {
    expect(computerHintModel(input({ statusFailed: true })).reason).toBe('check-failed')
  })

  it('失败标记不越过查看中的静默', () => {
    expect(computerHintModel(input({ viewActive: true, statusFailed: true, status: null })).show).toBe(false)
  })

  it('只有真正的设备发现回调也能重新检查', () => {
    const model = computerHintModel(input({ hasPort: false, hasRefresh: false, hasRetryDiscovery: true }))
    expect(model.retry.disabled).toBe(false)
    expect(model.retry.note).toBe(null)
  })

  it('有设置回调才可打开电脑设置', () => {
    expect(computerHintModel(input({ status: status({ ready: false }), hasOpenSettings: true })).settings).toMatchObject({ disabled: false, note: null })
    expect(computerHintModel(input({ status: status({ ready: false }) })).settings.disabled).toBe(true)
  })
})

describe('ComputerUnavailableHintView 渲染', () => {
  it('三个按钮都是真实 type=button，且没有外链', () => {
    const html = markup({ status: status({ ready: false }) })
    expect(html).toContain('data-testid="computer-unavailable-hint"')
    expect(html.match(/type="button"/g)).toHaveLength(3)
    expect(button(html, '重新检查')).not.toBe(null)
    expect(button(html, '打开电脑设置')).not.toBe(null)
    expect(button(html, '设置帮助')).not.toBe(null)
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href')
    expect(html).not.toContain('target="_blank"')
  })

  it('缺回调时按钮保留但禁用，并写出原因', () => {
    const html = markup({ hasPort: false, hasRefresh: false, status: null })
    expect(button(html, '重新检查')).toContain('disabled')
    expect(button(html, '打开电脑设置')).toContain('disabled')
    expect(button(html, '设置帮助')).not.toContain('disabled')
    expect(html).toContain('没有电脑画面接口')
    expect(html).toContain('设置 › 设备')
  })

  it('回调齐备时前两个按钮可点，帮助仍可点', () => {
    const html = markup({ status: status({ ready: false }), hasOpenSettings: true })
    expect(button(html, '重新检查')).not.toContain('disabled')
    expect(button(html, '打开电脑设置')).not.toContain('disabled')
    expect(button(html, '设置帮助')).not.toContain('disabled')
    expect(html).not.toContain('设置 › 设备')
  })

  it('帮助是就地展开：收起时 aria-expanded=false 且正文隐藏，展开后同一 id 可见', () => {
    const closed = markup({ status: status({ ready: false }) })
    const open = markup({ status: status({ ready: false }) }, true)
    expect(button(closed, '设置帮助')).toContain('aria-expanded="false"')
    expect(button(open, '设置帮助')).toContain('aria-expanded="true"')
    expect(button(closed, '设置帮助')).toContain(`aria-controls="${COMPUTER_HINT_HELP_ID}"`)
    expect(closed).toContain(`id="${COMPUTER_HINT_HELP_ID}"`)
    expect(closed).toMatch(new RegExp(`id="${COMPUTER_HINT_HELP_ID}"[^>]*hidden`))
    expect(open).not.toMatch(new RegExp(`id="${COMPUTER_HINT_HELP_ID}"[^>]*hidden`))
    expect(open).toContain('屏控必须由目标 Host 提供并单独授权')
    expect(open).not.toContain('<a')
  })

  it('没有端口时说明设备本身不支持查看', () => {
    expect(markup({ hasPort: false, hasRefresh: false, status: null })).toContain('这台设备没有提供电脑画面接口，无法在这里检查。')
  })

  it('状态读取失败时提示带齐三个控件，且仍无外链', () => {
    const html = markup({ status: null, statusFailed: true })
    expect(html).toContain('没能确认这台电脑的状态')
    expect(html.match(/type="button"/g)).toHaveLength(3)
    expect(button(html, '重新检查')).not.toBe(null)
    expect(button(html, '重新检查')).not.toContain('disabled')
    expect(button(html, '打开电脑设置')).not.toBe(null)
    expect(button(html, '设置帮助')).not.toBe(null)
    expect(html).not.toContain('<a')
    expect(html).not.toContain('href')
  })
})
