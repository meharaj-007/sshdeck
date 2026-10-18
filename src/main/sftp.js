const { Client } = require('ssh2');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const connections = new Map(); // serverId -> { client, sftp }
// Connects still in flight. A second caller during the handshake shares this
// promise instead of opening (and logging in with) a second connection.
const pending = new Map(); // serverId -> Promise<sftp>
const abandoned = new Set(); // serverIds disconnected while their connect was in flight

// Connecting takes a few seconds (TCP, key exchange, auth), so the renderer is
// told where it is rather than being left on a bare spinner.
const status = new EventEmitter();
const announce = (serverId, state, message) => status.emit('status', { serverId, state, message });

/* ---------- host key checking ---------- */

// The key blob is SSH wire format: a length-prefixed algorithm name followed by
// the rest of the key. known_hosts stores "<algo> <base64 of the whole blob>".
function keyLine(host, port, blob) {
  const nameLength = blob.readUInt32BE(0);
  const algorithm = blob.subarray(4, 4 + nameLength).toString('ascii');
  const target = port === 22 ? host : `[${host}]:${port}`;
  return `${target} ${algorithm} ${blob.toString('base64')}`;
}

function knownHostsPath() {
  return path.join(os.homedir(), '.ssh', 'known_hosts');
}

// ssh-keygen -F understands hashed known_hosts entries, which we cannot match by
// plain string search. Trust on first use, the same as the terminal's
// StrictHostKeyChecking=accept-new.
function verifyHostKey(host, port, blob) {
  return new Promise((resolve) => {
    const line = keyLine(host, port, blob);
    const encoded = blob.toString('base64');
    const target = port === 22 ? host : `[${host}]:${port}`;

    execFile('ssh-keygen', ['-F', target], (err, stdout) => {
      const known = stdout && stdout.split('\n').filter((l) => l && !l.startsWith('#'));
      if (known && known.length) {
        return resolve(known.some((l) => l.includes(encoded)));
      }
      // Not seen before: record it and accept.
      try {
        fs.mkdirSync(path.dirname(knownHostsPath()), { recursive: true, mode: 0o700 });
        fs.appendFileSync(knownHostsPath(), `${line}\n`, { mode: 0o600 });
      } catch {
        /* recording is best effort */
      }
      resolve(true);
    });
  });
}

/* ---------- connections ---------- */

function connect(server, secret) {
  const existing = connections.get(server.id);
  if (existing) return Promise.resolve(existing.sftp);
  if (pending.has(server.id)) return pending.get(server.id);

  announce(server.id, 'connecting');

  abandoned.delete(server.id);
  const attempt = open(server, secret).finally(() => {
    pending.delete(server.id);
    abandoned.delete(server.id);
  });
  pending.set(server.id, attempt);
  return attempt;
}

function open(server, secret) {
  return new Promise((resolve, reject) => {
    const client = new Client();
    const config = {
      host: server.host,
      port: server.port,
      username: server.user,
      readyTimeout: 20000,
      keepaliveInterval: 30000,
      hostVerifier: (blob, callback) =>
        verifyHostKey(server.host, server.port, blob).then(callback)
    };

    if (server.pemPath) {
      try {
        config.privateKey = fs.readFileSync(server.pemPath);
      } catch (err) {
        announce(server.id, 'error', `Cannot read key file: ${err.message}`);
        return reject(new Error(`Cannot read key file: ${err.message}`));
      }
      if (secret) config.passphrase = secret;
    } else {
      config.password = secret || '';
    }

    client.on('ready', () => {
      client.sftp((err, sftp) => {
        if (err) {
          client.end();
          return reject(err);
        }
        if (abandoned.has(server.id)) {
          client.end();
          return reject(new Error('Disconnected'));
        }
        connections.set(server.id, { client, sftp });
        announce(server.id, 'connected');
        resolve(sftp);
      });
    });
    // Only forget the cached entry if it is this client's: an old client closing
    // late must not evict the connection that replaced it.
    const forget = () => {
      if (connections.get(server.id)?.client === client) connections.delete(server.id);
    };
    client.on('error', (err) => {
      forget();
      announce(server.id, 'error', err.message);
      reject(err);
    });
    client.on('close', () => {
      forget();
      announce(server.id, 'closed');
    });

    client.connect(config);
  });
}

function disconnect(serverId) {
  if (pending.has(serverId)) abandoned.add(serverId);
  const entry = connections.get(serverId);
  if (!entry) return;
  connections.delete(serverId);
  entry.client.end();
}

function disconnectAll() {
  for (const id of [...connections.keys()]) disconnect(id);
}

function call(sftp, method, ...args) {
  return new Promise((resolve, reject) => {
    sftp[method](...args, (err, result) => (err ? reject(err) : resolve(result)));
  });
}

/* ---------- operations ---------- */

function toEntry(item) {
  const mode = item.attrs.mode;
  return {
    name: item.filename,
    isDirectory: (mode & 0o170000) === 0o040000,
    isSymlink: (mode & 0o170000) === 0o120000,
    size: item.attrs.size,
    mtime: item.attrs.mtime * 1000,
    mode: mode & 0o777
  };
}

async function list(sftp, dir) {
  const target = dir || (await call(sftp, 'realpath', '.'));
  const items = await call(sftp, 'readdir', target);
  const entries = items.map(toEntry).filter((e) => e.name !== '.' && e.name !== '..');

  // A symlinked directory should behave like a directory when clicked.
  await Promise.all(
    entries
      .filter((e) => e.isSymlink)
      .map(async (entry) => {
        try {
          const stats = await call(sftp, 'stat', path.posix.join(target, entry.name));
          entry.isDirectory = stats.isDirectory();
        } catch {
          /* broken link stays a file */
        }
      })
  );

  return { path: target, entries };
}

function download(sftp, remotePath, localPath, onProgress) {
  return new Promise((resolve, reject) => {
    sftp.fastGet(remotePath, localPath, { step: onProgress }, (err) => (err ? reject(err) : resolve()));
  });
}

function upload(sftp, localPath, remotePath, onProgress) {
  return new Promise((resolve, reject) => {
    sftp.fastPut(localPath, remotePath, { step: onProgress }, (err) => (err ? reject(err) : resolve()));
  });
}

const mkdir = (sftp, dir) => call(sftp, 'mkdir', dir);
const rename = (sftp, from, to) => call(sftp, 'rename', from, to);

// Deliberately not recursive. These are production servers; an accidental
// recursive delete is not recoverable, so a non-empty directory must fail.
const removeFile = (sftp, target) => call(sftp, 'unlink', target);

// SFTP reports every rmdir problem as a bare "Failure", and the overwhelmingly
// common cause is a non-empty directory. Say so instead.
async function removeDir(sftp, target) {
  try {
    await call(sftp, 'rmdir', target);
  } catch (err) {
    const { entries } = await list(sftp, target).catch(() => ({ entries: [] }));
    if (entries.length) throw new Error(`Directory is not empty (${entries.length} items)`);
    throw err;
  }
}

const isConnected = (serverId) => connections.has(serverId);

module.exports = {
  status,
  isConnected,
  connect,
  disconnect,
  disconnectAll,
  list,
  download,
  upload,
  mkdir,
  rename,
  removeFile,
  removeDir
};
