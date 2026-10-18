const { app } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const file = () => path.join(app.getPath('userData'), 'servers.json');

function load() {
  try {
    const raw = fs.readFileSync(file(), 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data.servers) ? data.servers : [];
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('store: failed to read servers.json', err);
    return [];
  }
}

function save(servers) {
  const dir = path.dirname(file());
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(), JSON.stringify({ servers }, null, 2), { mode: 0o600 });
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
