import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AgentImage } from './AgentImage'
import { AgentImageCard } from './AgentImageCard'
import { ImageGeneration } from './ImageGeneration'
import { AgentMarkdown } from './AgentMarkdown'
import { imageCredit, imageSourceInMessage, plainText } from './agent-images'

const render = (el: Parameters<typeof renderToStaticMarkup>[0]): string => renderToStaticMarkup(el)
const markdown = (text: string): string => render(createElement(AgentMarkdown, { text }))
const picture = 'https://images.example.test/harbour.jpg'

describe('agent images in the native conversation', () => {
  it('shows a picture the reply carries as a lazy image, never as a blocking one', () => {
    const html = markdown(`![海港夜景](${picture})`)
    expect(html).toContain('class="ln-agent-image"')
    expect(html).toContain(`src="${picture}"`)
    expect(html).toContain('alt="海港夜景"')
    expect(html).toContain('loading="lazy"')
    expect(html).not.toContain('loading="eager"')
  })

  it('prints the markdown image title under the picture as its caption', () => {
    const html = markdown(`![海港](${picture} "傍晚的维多利亚港")`)
    expect(html).toContain('class="ln-agent-image-caption"')
    expect(html).toContain('傍晚的维多利亚港')
  })

  it('falls back to the alt text instead of loading a source it must not load', () => {
    for (const unsafe of ['data:image/png;base64,AAAA', 'http://images.example.test/a.png', 'javascript:alert(1)', '/local/a.png', '//images.example.test/a.png']) {
      const html = markdown(`![本地占位图](${unsafe})`)
      expect(html).not.toContain('<img')
      expect(html).toContain('ln-markdown-image-note')
      expect(html).toContain('本地占位图')
    }
  })

  it('keeps the plain 图片 label when a refused picture has no alt text', () => {
    expect(markdown('![](data:image/png;base64,AAAA)')).toContain('>图片<')
  })

  it('keeps a credit line only when the message carries one', () => {
    const withCredit = render(createElement(AgentImage, {
      src: picture, alt: '海港', title: 'Victoria Harbour', author: 'Some Photographer', license: 'CC BY-SA 4.0', source: 'https://commons.example.test/file'
    }))
    expect(withCredit).toContain('Victoria Harbour · Some Photographer · CC BY-SA 4.0')
    expect(withCredit).toContain('target="_blank"')
    expect(withCredit).toContain('rel="noopener noreferrer"')
    expect(render(createElement(AgentImage, { src: picture, alt: '海港' }))).not.toContain('ln-agent-image-caption')
  })

  it('never turns an unusable credit link into an anchor', () => {
    const html = render(createElement(AgentImage, { src: picture, alt: '海港', title: '海港', source: 'javascript:alert(1)' }))
    expect(html).not.toContain('javascript:')
    expect(html).toContain('>海港<')
  })

  it('shows the alt text alone when the source itself cannot be used', () => {
    const html = render(createElement(AgentImage, { src: 'http://images.example.test/a.png', alt: '海港', caption: '说明' }))
    expect(html).toBe('<span class="ln-agent-image-missing">海港</span>')
  })

  it('sizes the compact figure for a card instead of a reply', () => {
    const html = render(createElement(AgentImage, { src: picture, alt: '海港', compact: true }))
    expect(html).toContain('data-compact="true"')
  })
})



describe('image generation state card', () => {
  it('reserves space and exposes queued/generating/refining states', () => {
    for (const [status, text] of [['queued', '等待生成'], ['generating', '正在生成图片'], ['refining', '正在细化细节']] as const) {
      const html = render(createElement(ImageGeneration, { status, prompt: '海港夜景' }))
      expect(html).toContain(`data-status="${status}"`)
      expect(html).toContain('aspect-ratio')
      expect(html).toContain(text)
      expect(html).toContain('海港夜景')
    }
  })

  it('keeps retry inside the error card', () => {
    const html = render(createElement(ImageGeneration, { status: 'error', onRetry: () => undefined }))
    expect(html).toContain('role="alert"')
    expect(html).toContain('生成失败')
    expect(html).toContain('ln-image-generation-retry')
  })
})

describe('agent image card', () => {
  const card = { title: '需求工作坊', description: '梳理问题、边界与交付物。', src: picture, tags: ['需求', '设计'] }

  it('stacks picture, title, description and tags in upstream order', () => {
    const html = render(createElement(AgentImageCard, card))
    expect(html).toContain('role="group"')
    expect(html).toContain('aria-label="需求工作坊"')
    expect(html.indexOf('ln-agent-image-media')).toBeLessThan(html.indexOf('<h3>需求工作坊</h3>'))
    expect(html).toContain('<p>梳理问题、边界与交付物。</p>')
    expect(html).toContain('<li>需求</li>')
    expect(html).toContain('<li>设计</li>')
  })

  it('keeps the ask button disabled until a host can send the prompt', () => {
    const withoutHost = render(createElement(AgentImageCard, { ...card, prompt: '演示：了解需求工作坊' }))
    expect(withoutHost).toContain('继续了解')
    expect(withoutHost).toContain('disabled')
    const withHost = render(createElement(AgentImageCard, { ...card, prompt: '演示：了解需求工作坊', onPrompt: () => {} }))
    expect(withHost).not.toContain('disabled')
  })

  it('renders no footer when the card carries no prompt', () => {
    expect(render(createElement(AgentImageCard, card))).not.toContain('ln-agent-image-card-foot')
  })
})

describe('agent image helpers', () => {
  it('accepts only absolute https pictures without credentials', () => {
    expect(imageSourceInMessage(' https://images.example.test/a.png ')).toBe('https://images.example.test/a.png')
    expect(imageSourceInMessage('https://user:pass@images.example.test/a.png')).toBeNull()
    expect(imageSourceInMessage('http://images.example.test/a.png')).toBeNull()
    expect(imageSourceInMessage('data:image/png;base64,AAAA')).toBeNull()
    expect(imageSourceInMessage('javascript:alert(1)')).toBeNull()
    expect(imageSourceInMessage('//images.example.test/a.png')).toBeNull()
    expect(imageSourceInMessage('a.png')).toBeNull()
    expect(imageSourceInMessage('')).toBeNull()
    expect(imageSourceInMessage(undefined)).toBeNull()
  })

  it('strips markup and entities from credit text and caps the line', () => {
    expect(plainText('<a href="x">Some&nbsp;one</a> &amp; &quot;others&quot;')).toBe('Some&nbsp;one & "others"')
    expect(plainText(42)).toBe('42')
    expect(plainText(undefined)).toBe('')
    expect(plainText('a'.repeat(400))).toHaveLength(300)
  })

  it('credits only the parts it was given', () => {
    expect(imageCredit({ title: 'Victoria Harbour' })).toBe('Victoria Harbour')
    expect(imageCredit({ title: 'Victoria Harbour', license: 'CC BY-SA 4.0' })).toBe('Victoria Harbour · CC BY-SA 4.0')
    expect(imageCredit({})).toBeNull()
  })
})
