const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = () => path.join(app.getPath('userData'), 'servers.json');

// A missing file is an empty list. An unreadable one is an error, not an empty
// list: returning [] here would let the next save overwrite every server.
function load() {
  let raw;
  try {
    raw = fs.readFileSync(file(), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`servers.json is corrupt and was left untouched (${file()}): ${err.message}`);
  }
  if (!data || !Array.isArray(data.servers)) {
    throw new Error(`servers.json has no server list and was left untouched (${file()})`);
  }
  return data.servers;
}

// Write to a temp file and rename over the original, so a crash mid-write
// leaves either the old file or the new one, never half of one.
function save(servers) {
  const target = file();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ servers }, null, 2), { mode: 0o600 });
  fs.renameSync(temp, target);
}

function normalize(input) {
  return {
    id: input.id || crypto.randomUUID(),
    name: (input.name || '').trim(),
    provider: input.provider === 'hostinger' ? 'hostinger' : 'aws',
    host: (input.host || '').trim(),
    user: (input.user || '').trim() || 'root',
    port: Number(input.port) || 22,
    pemPath: (input.pemPath || '').trim(),
    // password itself never lands here; it lives in the macOS Keychain
    hasPassword: Boolean(input.hasPassword)
  };
}

function upsert(input) {
  const servers = load();
  const server = normalize(input);
  const index = servers.findIndex((s) => s.id === server.id);
  if (index === -1) servers.push(server);
  else servers[index] = server;
  save(servers);
  return server;
}

function remove(id) {
  save(load().filter((s) => s.id !== id));
}

module.exports = { load, upsert, remove, file };
