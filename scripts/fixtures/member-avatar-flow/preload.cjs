const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('avatarFixture', {
  request: (method, params) => ipcRenderer.invoke('avatar-fixture:request', method, params)
})
