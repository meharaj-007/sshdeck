const { app } = require('electron');
const fs = require('fs');
const path = require('path');

// Last directory each pane was showing, per server, so reopening a file browser
// lands where the previous tab left off instead of at home.
const file = () => path.join(app.getPath('userData'), 'paths.json');

let cache = null;
let writeTimer = null;

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(file(), 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('paths: failed to read paths.json', err);
    cache = {};
  }
  return cache;
}

// Navigation is chatty, so batch writes rather than hitting the disk per click.
function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(path.dirname(file()), { recursive: true });
      fs.writeFileSync(file(), JSON.stringify(cache, null, 2), { mode: 0o600 });
    } catch (err) {
      console.error('paths: failed to write paths.json', err);
    }
  }, 400);
}

function flush() {
  if (!writeTimer) return;
  clearTimeout(writeTimer);
  writeTimer = null;
  try {
    fs.writeFileSync(file(), JSON.stringify(cache || {}, null, 2), { mode: 0o600 });
  } catch (err) {
    console.error('paths: failed to write paths.json', err);
  }
}

function get(serverId) {
  return load()[serverId] || { local: null, remote: null };
}

function set(serverId, side, dir) {
  const all = load();
  const entry = all[serverId] || (all[serverId] = { local: null, remote: null });
  if (entry[side] === dir) return;
  entry[side] = dir;
  scheduleWrite();
}

function remove(serverId) {
  const all = load();
  if (!(serverId in all)) return;
  delete all[serverId];
  scheduleWrite();
}

module.exports = { get, set, remove, flush };
