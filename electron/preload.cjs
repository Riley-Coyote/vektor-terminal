// Preload script — runs in a sandboxed context before the renderer
// Exposes minimal, safe APIs to the web content

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('vektor', {
  platform: process.platform,
  isElectron: true,
  version: process.env.npm_package_version || '1.0.0',
});
