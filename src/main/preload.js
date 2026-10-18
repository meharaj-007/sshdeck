const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  listServers: () => ipcRenderer.invoke('servers:list'),
  saveServer: (server) => ipcRenderer.invoke('servers:save', server),
  deleteServer: (id) => ipcRenderer.invoke('servers:delete', id),
  pickKey: () => ipcRenderer.invoke('dialog:pickKey'),

  startSession: (payload) => ipcRenderer.invoke('session:start', payload),
  writeSession: (sessionId, data) => ipcRenderer.send('session:write', { sessionId, data }),
  resizeSession: (sessionId, cols, rows) => ipcRenderer.send('session:resize', { sessionId, cols, rows }),
  killSession: (sessionId) => ipcRenderer.send('session:kill', { sessionId }),

  onSessionData: (handler) => ipcRenderer.on('session:data', (_e, payload) => handler(payload)),
  onSessionExit: (handler) => ipcRenderer.on('session:exit', (_e, payload) => handler(payload)),

  localHome: () => ipcRenderer.invoke('local:home'),
  localList: (dir) => ipcRenderer.invoke('local:list', dir),
  localMkdir: (dir) => ipcRenderer.invoke('local:mkdir', dir),
  localRename: (from, to) => ipcRenderer.invoke('local:rename', { from, to }),
  localRemove: (target, isDirectory) => ipcRenderer.invoke('local:remove', { target, isDirectory }),

  remoteList: (serverId, dir) => ipcRenderer.invoke('remote:list', { serverId, dir }),
  remoteMkdir: (serverId, dir) => ipcRenderer.invoke('remote:mkdir', { serverId, dir }),
  remoteRename: (serverId, from, to) => ipcRenderer.invoke('remote:rename', { serverId, from, to }),
  remoteRemove: (serverId, target, isDirectory) =>
    ipcRenderer.invoke('remote:remove', { serverId, target, isDirectory }),
  remoteDisconnect: (serverId) => ipcRenderer.invoke('remote:disconnect', serverId),

  remoteIsConnected: (serverId) => ipcRenderer.invoke('remote:isConnected', serverId),
  onRemoteStatus: (handler) => ipcRenderer.on('remote:status', (_e, payload) => handler(payload)),

  getSavedPaths: (serverId) => ipcRenderer.invoke('paths:get', serverId),
  savePath: (serverId, side, dir) => ipcRenderer.send('paths:set', { serverId, side, dir }),

  runTransfer: (payload) => ipcRenderer.invoke('transfer:run', payload),
  onTransferProgress: (handler) => ipcRenderer.on('transfer:progress', (_e, payload) => handler(payload))
});
