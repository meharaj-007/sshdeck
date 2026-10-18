const pty = require('node-pty');
const fs = require('fs');
const os = require('os');

const sessions = new Map();

// ssh refuses to use a key file that other users can read. Tighten it rather
// than making the user go find the error message in the terminal output.
function ensureKeyPermissions(pemPath) {
  const stat = fs.statSync(pemPath);
  if (stat.mode & 0o077) {
    fs.chmodSync(pemPath, 0o600);
    return true;
  }
  return false;
}

function buildArgs(server) {
  const args = [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ServerAliveInterval=30',
    '-p', String(server.port)
  ];
  if (server.pemPath) {
    args.push('-i', server.pemPath, '-o', 'IdentitiesOnly=yes');
  } else if (server.hasPassword) {
    args.push('-o', 'PubkeyAuthentication=no', '-o', 'PreferredAuthentications=keyboard-interactive,password');
  }
  args.push(`${server.user}@${server.host}`);
  return args;
}

function start({ id, server, secret, cols, rows, onData, onExit }) {
  const notes = [];
  if (server.pemPath) {
    if (!fs.existsSync(server.pemPath)) throw new Error(`Key file not found: ${server.pemPath}`);
    if (ensureKeyPermissions(server.pemPath)) notes.push(`Tightened permissions on ${server.pemPath} to 600.`);
  }

  const term = pty.spawn('/usr/bin/ssh', buildArgs(server), {
    name: 'xterm-256color',
    cols: cols || 80,
    rows: rows || 24,
    cwd: os.homedir(),
    env: { ...process.env, TERM: 'xterm-256color', LANG: process.env.LANG || 'en_US.UTF-8' }
  });

  // Answer the first password/passphrase prompt from the Keychain. Only once:
  // if the secret is wrong, replaying it just burns login attempts.
  let tail = '';
  let answered = !secret;

  const onTerminalData = (data) => {
    if (!answered) {
      tail = (tail + data).slice(-200);
      if (/(password|passphrase)[^\n]*:\s*$/i.test(tail)) {
        answered = true;
        term.write(`${secret}\r`);
      }
    }
    onData(data);
  };

  term.onData(onTerminalData);
  term.onExit(({ exitCode }) => {
    sessions.delete(id);
    onExit(exitCode);
  });

  sessions.set(id, term);
  return { notes };
}

function write(id, data) {
  sessions.get(id)?.write(data);
}

function resize(id, cols, rows) {
  try {
    sessions.get(id)?.resize(cols, rows);
  } catch {
    /* terminal already gone */
  }
}

function kill(id) {
  const term = sessions.get(id);
  if (!term) return;
  sessions.delete(id);
  try {
    term.kill();
  } catch {
    /* already exited */
  }
}

// Session ids are `${serverId}:${timestamp}`, so a server's sessions are found
// by prefix; kill(serverId) on its own would match nothing.
function killServer(serverId) {
  for (const id of [...sessions.keys()]) {
    if (id.startsWith(`${serverId}:`)) kill(id);
  }
}

function killAll() {
  for (const id of [...sessions.keys()]) kill(id);
}

module.exports = { start, write, resize, kill, killServer, killAll };
