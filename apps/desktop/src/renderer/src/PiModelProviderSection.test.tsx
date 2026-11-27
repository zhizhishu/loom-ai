import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PiModelProviderSettings } from '@contracts'
import type { ThreadClient } from './camp-client'
import { PiModelProviderSection, savePiModelProvider } from './PiModelProviderSection'

const snapshot: PiModelProviderSettings = {
  status: 'ready', providerId: 'loom', baseUrl: 'https://gateway.example/v1', api: 'openai-completions',
  modelIds: ['oct-model'], modelId: 'oct-model', apiKeyEnv: 'OCT_API_KEY', keyConfigured: true, keyLast4: '1234', keyRevision: 3
}

function requester() {
  const calls: Array<[string, unknown]> = []
  const client = {
    request: async (method: string, params?: unknown) => {
      calls.push([method, params])
      return method === 'pi.modelProvider.save' ? snapshot : { ready: true, outcome: 'ready' }
    }
  } as unknown as Pick<ThreadClient, 'request'>
  return { calls, client }
}

describe('Pi provider settings form', () => {
  it('renders one gateway, model and key row with its own save action', () => {
    const markup = renderToStaticMarkup(<PiModelProviderSection disabled={false}/>)
    expect(markup).toContain('Pi 连接')
    expect(markup).toContain('aria-label="网关地址"')
    expect(markup).toContain('placeholder="https://gateway.example/v1"')
    expect(markup).toContain('aria-label="模型 ID"')
    expect(markup).toContain('aria-label="Key"')
    expect(markup).toContain('type="password"')
    expect(markup).toContain('保存连接')
    // Nothing renders a stored key back into the form.
    expect(markup).not.toMatch(/value="sk-/)
  })

  it('saves the provider with its environment key and then revalidates Pi', async () => {
    const { calls, client } = requester()
    const saved = await savePiModelProvider(client, {
      baseUrl: ' https://gateway.example/v1 ', modelId: ' oct-model ', apiKey: ' sk-live-1234 ', keyRevision: 3
    })
    expect(saved).toEqual(snapshot)
    expect(calls).toEqual([
      ['pi.modelProvider.save', {
        baseUrl: 'https://gateway.example/v1', modelId: 'oct-model', keyRevision: 3, apiKey: 'sk-live-1234'
      }],
      ['runtime.product.check', { runtimeKind: 'pi' }]
    ])
  })

  it('keeps the stored key when the key field is empty and refuses an incomplete form', async () => {
    const { calls, client } = requester()
    await savePiModelProvider(client, { baseUrl: 'https://gateway.example/v1', modelId: 'oct-model', apiKey: '  ', keyRevision: 3 })
    expect(calls[0]).toEqual(['pi.modelProvider.save', {
      baseUrl: 'https://gateway.example/v1', modelId: 'oct-model', keyRevision: 3
    }])
    const invalid = requester()
    await expect(savePiModelProvider(invalid.client, { baseUrl: ' ', modelId: 'oct-model', apiKey: 'sk-live-1234', keyRevision: 3 }))
      .rejects.toThrow('请填写网关地址。')
    await expect(savePiModelProvider(invalid.client, { baseUrl: 'https://gateway.example/v1', modelId: '', apiKey: '', keyRevision: 3 }))
      .rejects.toThrow('请填写模型 ID。')
    expect(invalid.calls).toEqual([])
  })
})
