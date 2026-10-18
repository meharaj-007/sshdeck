const { contextBridge, ipcRenderer } = require('electron');

// Subscribe to a main-process push. Returns a function that unsubscribes, so a
// view that goes away can stop listening.
function listen(channel, handler) {
  const listener = (_e, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('api', {
  listServers: () => ipcRenderer.invoke('servers:list'),
  saveServer: (server) => ipcRenderer.invoke('servers:save', server),
  deleteServer: (id) => ipcRenderer.invoke('servers:delete', id),
  pickKey: () => ipcRenderer.invoke('dialog:pickKey'),

  startSession: (payload) => ipcRenderer.invoke('session:start', payload),
  writeSession: (sessionId, data) => ipcRenderer.send('session:write', { sessionId, data }),
  resizeSession: (sessionId, cols, rows) => ipcRenderer.send('session:resize', { sessionId, cols, rows }),
  killSession: (sessionId) => ipcRenderer.send('session:kill', { sessionId }),

  onSessionData: (handler) => listen('session:data', handler),
  onSessionExit: (handler) => listen('session:exit', handler),

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
  onRemoteStatus: (handler) => listen('remote:status', handler),

  getSavedPaths: (serverId) => ipcRenderer.invoke('paths:get', serverId),
  savePath: (serverId, side, dir) => ipcRenderer.send('paths:set', { serverId, side, dir }),

  runTransfer: (payload) => ipcRenderer.invoke('transfer:run', payload),
  onTransferProgress: (handler) => listen('transfer:progress', handler)
});
