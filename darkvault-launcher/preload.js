const { contextBridge, ipcRenderer } = require('electron');
const call = n => a => ipcRenderer.invoke(n, a);
contextBridge.exposeInMainWorld('api', {
  auth: call('auth'), versions: call('versions'), microsoft: call('microsoft'),
  play: call('play'), skin: call('skin'), webskin: call('webskin'), site: call('site'), search: call('search'), install: call('install'), nick: call('nick'),
  onLog: f => ipcRenderer.on('log', (_, d) => f(d)), onClosed: f => ipcRenderer.on('closed', () => f())
});
