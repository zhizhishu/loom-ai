const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('shortcutsApi', {
  get: () => ipcRenderer.invoke('shortcuts:get'),
  save: input => ipcRenderer.invoke('shortcuts:save', input),
  setTasksEnabled: value => ipcRenderer.invoke('shortcuts:tasks', value),
  setRecording: value => ipcRenderer.invoke('shortcuts:record', value),
  onChanged: listener => { const handler = (_event, value) => listener(value); ipcRenderer.on('shortcuts:changed', handler); return () => ipcRenderer.removeListener('shortcuts:changed', handler) },
  onMouseSide: listener => { const handler = (_event, value) => listener(value); ipcRenderer.on('rovai:shortcut-mouse', handler); return () => ipcRenderer.removeListener('rovai:shortcut-mouse', handler) }
})

contextBridge.exposeInMainWorld('filePreviewApi', {
  ...Object.fromEntries(['updateRetention', 'bindThread', 'open', 'restore', 'reopen', 'readText', 'readPage', 'resolveLine', 'readBinary', 'prepareHtml', 'prepareHtmlSite', 'releaseHtmlSite', 'reload', 'release'].map(method => [method, args => ipcRenderer.invoke('shortcuts:preview', method, args)])),
  onExternalUpdate: () => () => {}
})
