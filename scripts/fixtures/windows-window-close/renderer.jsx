import React from 'react'
import { createRoot } from 'react-dom/client'
import { GeneralSettings } from '@renderer/GeneralSettings'
import { WindowCloseDialog } from '@renderer/WindowCloseSettings'
import { DEFAULT_GENERAL_PREFERENCES } from '@shared/general-preferences-model'
import { initializeInterfaceLanguage, changeInterfaceLanguage } from '@renderer/interface-language'
import '@renderer/styles.css'
import '@renderer/member-editor.css'

let preferences = { ...DEFAULT_GENERAL_PREFERENCES, interfaceLanguagePreference: 'zh-CN', interfaceLanguage: 'zh-CN' }
const api = {
  get: async () => preferences,
  setInterfaceLanguagePreference: async preference => (preferences = { ...preferences, interfaceLanguagePreference: preference, interfaceLanguage: preference === 'system' ? preferences.systemLanguage : preference, languageRevision: preferences.languageRevision + 1 }),
  setStartupLocationMode: async startupLocationMode => (preferences = { ...preferences, startupLocationMode }),
  setWorldMapEnabled: async worldMapEnabled => (preferences = { ...preferences, worldMapEnabled })
}
const controls = { getResetCapability: async () => ({ canReset: true, reason: null }), resetBounds: async () => ({ performed: true, reason: null }) }
initializeInterfaceLanguage(preferences)
document.documentElement.dataset.theme = 'day'
createRoot(document.getElementById('root')).render(<>
  <div className="settings-panel settings-panel-general" style={{ height: '100vh', overflow: 'auto' }}>
    <GeneralSettings api={api} windowControls={controls} windowClose={window.closeTestApi} initialPreferences={preferences} />
    <input id="preserved-draft" aria-label="Fixture draft" defaultValue="Keep this unsaved draft" />
  </div>
  <WindowCloseDialog api={window.closeTestApi} />
</>)
window.closeFixture = { language: interfaceLanguage => changeInterfaceLanguage(api, interfaceLanguage) }
