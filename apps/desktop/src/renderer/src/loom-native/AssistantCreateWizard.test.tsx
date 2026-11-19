import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BusinessEnvironment } from '../business-environment'
import { AssistantCreateWizard } from './AssistantCreateWizard'
import { ASSISTANT_PRESETS } from './assistant-presets'

describe('assistant wizard initial screen',()=>{
  it('renders real animated draft avatars with stable identities, before creating any Core member',()=>{
    const markup=renderToStaticMarkup(<AssistantCreateWizard environment={{client:{}} as BusinessEnvironment} agents={[]} theme="day" onCreated={()=>{}} onDirtyChange={()=>{}} onBusyChange={()=>{}}/>)
    expect(markup).toContain('创建你的助手')
    expect(markup).toContain('选择能力')
    expect(markup).toContain('工作区域')
    expect(markup).toContain('ln-preset-grid')
    for(const preset of ASSISTANT_PRESETS)expect(markup).toContain(preset.name)
    expect(markup).not.toContain('叮叮')
    expect(markup).not.toContain('undefined的头像')
    expect(markup).toContain('open-bot-avatar')
  })
})
