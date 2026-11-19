// QA-only transport. The actual Core RPC lives in the owning isolated Node test.
// Electron has no access to daily user data or a network RPC listener.
const {contextBridge,ipcRenderer}=require('electron')
contextBridge.exposeInMainWorld('loomQaCore',{
 request:(method,params)=>ipcRenderer.invoke('loomqa:core-request',{method,params})
})
