import { DEFAULT_APPEARANCE } from '../../shared/appearance'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppearanceSettings } from './AppearanceSettings'

describe('appearance settings', () => {
  it('renders all six global choices without Thread-specific controls', () => {
    const markup = renderToStaticMarkup(createElement(AppearanceSettings, {
      appearance: { ...DEFAULT_APPEARANCE, preference: 'system', resolvedTheme: 'night' },
      disabled: false,
      onChange: async (preferences) => ({ ...preferences, resolvedTheme: 'night' })
    }))

    expect(markup).toContain('跟随系统')
    expect(markup).toContain('Porcelain Day')
    expect(markup).toContain('Steel Night')
    expect(markup).toContain('晨雾')
    expect(markup).toContain('Morning Mist')
    expect(markup).toContain('朝霞')
    expect(markup).toContain('Dawn Glow')
    expect(markup).toContain('绯夜')
    expect(markup).toContain('Crimson Night')
    expect(markup).not.toContain('随系统外观自动使用瓷灰日间或 Steel Night')
    expect(markup).not.toContain('冷瓷灰与克制的 Steel 强调')
    expect(markup).not.toContain('冷石墨表面')
    expect(markup).not.toContain('选择偏好不会生成对话事件、消息或审计记录')
    expect(markup).not.toContain('Reserved')
    expect(markup).not.toContain('当前视觉语言')
    expect(markup).not.toContain('Steel Strong')
    expect(markup).not.toContain('Thread 主题')
  })
})

it.each(['horizon', 'classic-red', 'ember'] as const)('names the selected %s palette instead of just its light/dark mode', preference => {
  const labels = { horizon: '晨雾', 'classic-red': '朝霞', ember: '绯夜' }
  const markup = renderToStaticMarkup(createElement(AppearanceSettings, {
    appearance: { ...DEFAULT_APPEARANCE, preference, resolvedTheme: preference === 'ember' ? 'night' : 'day' },
    disabled: false,
    onChange: async preferences => ({ ...preferences, resolvedTheme: 'day' })
  }))
  expect(markup).toContain(`当前为${labels[preference]}`)
})


it('reports an unreadable preference source without claiming defaults were saved', () => {
  const markup = renderToStaticMarkup(createElement(AppearanceSettings, {
    appearance: { ...DEFAULT_APPEARANCE, resolvedTheme: 'day', degradation: { code: 'appearance_preferences_invalid', message: 'Invalid source', retryable: true, details: {} } },
    disabled: false,
    onChange: async (preferences) => ({ ...preferences, resolvedTheme: 'day' })
  }))
  expect(markup).toContain('无法读取已保存的外观设置，当前使用默认值。')
  expect(markup).toContain('保存当前设置')
  expect(markup).toContain('未保存')
  expect(markup).not.toContain('>已保存<')
})

it('keeps an existing nonpreset zoom value representable', () => {
  const markup = renderToStaticMarkup(createElement(AppearanceSettings, {
    appearance: { ...DEFAULT_APPEARANCE, zoomPercentage: 121, resolvedTheme: 'day' },
    disabled: false,
    onChange: async (preferences) => ({ ...preferences, resolvedTheme: 'day' })
  }))
  expect(markup).toContain('<option value="121" selected="">121%</option>')
})
