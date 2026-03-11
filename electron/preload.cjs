// Preload script — runs in a sandboxed context before the renderer
// Exposes minimal, safe APIs to the web content

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('vektor', {
  platform: process.platform,
  isElectron: true,
  version: process.env.npm_package_version || '1.0.0',

  // Detached window IPC
  openDetachedWindow: (opts) => ipcRenderer.invoke('open-detached-window', opts),
  closeDetachedWindow: (paneId) => ipcRenderer.send('close-detached-window', paneId),
  setDetachedOpacity: (paneId, opacity) => ipcRenderer.send('set-detached-opacity', paneId, opacity),
  onDetachedWindowClosed: (callback) => {
    ipcRenderer.on('detached-window-closed', (_event, paneId) => callback(paneId));
  },
});
