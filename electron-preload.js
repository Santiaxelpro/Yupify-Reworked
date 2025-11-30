const { contextBridge } = require('electron');

// Exponer APIs seguras al renderer
contextBridge.exposeInMainWorld('electron', {
  platform: process.platform,
  version: process.version
});
