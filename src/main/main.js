const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const store = require('./store');
const keychain = require('./keychain');
const sessions = require('./sessions');
const sftp = require('./sftp');
const localfs = require('./localfs');
const paths = require('./paths');

let win = null;

// Connection progress is broadcast, not requested: any pane watching a server
// should light up regardless of which one triggered the connect.
sftp.status.on('status', (payload) => {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send('remote:status', payload);
  }
});

function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 820,
    minHeight: 520,
    title: 'SSHDeck',
    backgroundColor: '#11131a',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  // The app is one page. Dropping a file on the window would otherwise navigate
  // to it, throwing away the UI (and orphaning live sessions) and handing the
  // dropped page the preload's window.api.
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  sessions.killAll();
  sftp.disconnectAll();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  sessions.killAll();
  sftp.disconnectAll();
  paths.flush();
});

ipcMain.handle('servers:list', () => store.load());

ipcMain.handle('servers:save', async (_event, input) => {
  const server = store.upsert({ ...input, hasPassword: Boolean(input.password) || Boolean(input.hasPassword) });
  if (input.password) await keychain.set(server.id, input.password);
  else if (!server.hasPassword) await keychain.clear(server.id);
  return server;
});

ipcMain.handle('servers:delete', async (_event, id) => {
  sessions.killServer(id);
  sftp.disconnect(id);
  store.remove(id);
  paths.remove(id);
  await keychain.clear(id);
});

ipcMain.handle('dialog:pickKey', async () => {
  const result = await dialog.showOpenDialog(win, {
    title: 'Select PEM key',
    defaultPath: path.join(app.getPath('home'), '.ssh'),
    properties: ['openFile', 'showHiddenFiles'],
    filters: [{ name: 'Keys', extensions: ['pem', 'key', 'cer', ''] }]
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('session:start', async (event, { sessionId, serverId, cols, rows }) => {
  const server = store.load().find((s) => s.id === serverId);
  if (!server) throw new Error('Server not found');
  const secret = server.hasPassword ? await keychain.get(server.id) : null;
  const send = (channel, payload) => {
    if (!event.sender.isDestroyed()) event.sender.send(channel, payload);
  };
  const { notes } = sessions.start({
    id: sessionId,
    server,
    secret,
    cols,
    rows,
    onData: (data) => send('session:data', { sessionId, data }),
    onExit: (exitCode) => send('session:exit', { sessionId, exitCode })
  });
  // Passwords saved before the Keychain fix were stored empty.
  if (server.hasPassword && !secret) {
    notes.push('No password found in the Keychain for this server. Edit the server and enter it again.');
  }
  return { notes };
});

ipcMain.on('session:write', (_event, { sessionId, data }) => sessions.write(sessionId, data));
ipcMain.on('session:resize', (_event, { sessionId, cols, rows }) => sessions.resize(sessionId, cols, rows));
ipcMain.on('session:kill', (_event, { sessionId }) => sessions.kill(sessionId));

/* ---------------- file browser ---------------- */

// One SFTP channel per server, opened on first use and reused by every pane.
async function sftpFor(serverId) {
  const server = store.load().find((s) => s.id === serverId);
  if (!server) throw new Error('Server not found');
  const secret = server.hasPassword ? await keychain.get(server.id) : null;
  return sftp.connect(server, secret);
}

ipcMain.handle('local:home', () => localfs.home());
ipcMain.handle('local:list', (_event, dir) => localfs.list(dir));
ipcMain.handle('local:mkdir', (_event, dir) => localfs.mkdir(dir));
ipcMain.handle('local:rename', (_event, { from, to }) => localfs.rename(from, to));
ipcMain.handle('local:remove', (_event, { target, isDirectory }) =>
  isDirectory ? localfs.removeDir(target) : localfs.removeFile(target)
);

ipcMain.handle('remote:list', async (_event, { serverId, dir }) => sftp.list(await sftpFor(serverId), dir));
ipcMain.handle('remote:mkdir', async (_event, { serverId, dir }) => sftp.mkdir(await sftpFor(serverId), dir));
ipcMain.handle('remote:rename', async (_event, { serverId, from, to }) =>
  sftp.rename(await sftpFor(serverId), from, to)
);
ipcMain.handle('remote:remove', async (_event, { serverId, target, isDirectory }) => {
  const channel = await sftpFor(serverId);
  return isDirectory ? sftp.removeDir(channel, target) : sftp.removeFile(channel, target);
});
ipcMain.handle('remote:disconnect', (_event, serverId) => sftp.disconnect(serverId));
ipcMain.handle('remote:isConnected', (_event, serverId) => sftp.isConnected(serverId));

ipcMain.handle('paths:get', (_event, serverId) => paths.get(serverId));
ipcMain.on('paths:set', (_event, { serverId, side, dir }) => paths.set(serverId, side, dir));

ipcMain.handle('transfer:run', async (event, { transferId, serverId, direction, localPath, remotePath }) => {
  const channel = await sftpFor(serverId);
  const send = (transferred, _chunk, total) => {
    if (!event.sender.isDestroyed()) {
      event.sender.send('transfer:progress', { transferId, transferred, total });
    }
  };
  if (direction === 'download') await sftp.download(channel, remotePath, localPath, send);
  else await sftp.upload(channel, localPath, remotePath, send);
});
