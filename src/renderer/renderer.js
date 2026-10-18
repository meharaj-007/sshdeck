const { Terminal } = window;
const { FitAddon } = window.FitAddon;

const listEl = document.getElementById('server-list');
const tabsEl = document.getElementById('tabs');
const termsEl = document.getElementById('terminals');
const emptyEl = document.getElementById('empty');
const searchEl = document.getElementById('search');
const modalEl = document.getElementById('modal');
const formEl = document.getElementById('server-form');
const errorEl = document.getElementById('form-error');
const deleteBtn = document.getElementById('delete-server');
const keyField = document.getElementById('key-field');
const passwordField = document.getElementById('password-field');

const THEME = {
  background: '#11131a',
  foreground: '#e6e9f2',
  cursor: '#5b8cff',
  selectionBackground: '#2c3448',
  black: '#11131a', red: '#e5645f', green: '#7fd18a', yellow: '#f0a03c',
  blue: '#5b8cff', magenta: '#b58bff', cyan: '#57c8d6', white: '#e6e9f2'
};

let servers = [];
let editingId = null;
const tabs = new Map(); // sessionId -> { server, term, fit, host, tab, dead }
let activeId = null;

/* ---------------- server list ---------------- */

async function refreshServers() {
  try {
    servers = await window.api.listServers();
  } catch (err) {
    servers = [];
    listEl.innerHTML = '';
    const note = document.createElement('p');
    note.className = 'empty-list';
    note.textContent = err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    listEl.append(note);
    return;
  }
  renderList();
}

function renderList() {
  const query = searchEl.value.trim().toLowerCase();
  const matches = servers.filter((s) =>
    !query || `${s.name} ${s.host} ${s.user}`.toLowerCase().includes(query)
  );

  listEl.innerHTML = '';
  if (!matches.length) {
    const note = document.createElement('p');
    note.className = 'empty-list';
    note.textContent = servers.length ? 'No match.' : 'No servers yet.';
    listEl.append(note);
    return;
  }

  const liveServerIds = new Set(
    [...tabs.values()].filter((t) => t.kind === 'term' && !t.dead).map((t) => t.server.id)
  );

  for (const provider of ['aws', 'hostinger']) {
    const group = matches.filter((s) => s.provider === provider);
    if (!group.length) continue;

    const label = document.createElement('div');
    label.className = 'group-label';
    label.textContent = provider === 'aws' ? 'AWS' : 'Hostinger';
    listEl.append(label);

    for (const server of group) {
      const row = document.createElement('div');
      row.className = 'server' + (liveServerIds.has(server.id) ? ' live' : '');
      row.title = `${server.user}@${server.host}:${server.port}`;
      row.onclick = () => openTerminal(server);
      row.innerHTML = `
        <span class="dot ${server.provider}"></span>
        <span class="server-text">
          <span class="server-name"></span>
          <span class="server-host"></span>
        </span>
        <button class="action files" title="Open files">🗂</button>
        <button class="action edit" title="Edit">⋯</button>`;
      row.querySelector('.server-name').textContent = server.name || server.host;
      row.querySelector('.server-host').textContent = `${server.user}@${server.host}`;
      row.querySelector('.edit').onclick = (event) => {
        event.stopPropagation();
        openForm(server);
      };
      row.querySelector('.files').onclick = (event) => {
        event.stopPropagation();
        openFiles(server);
      };
      listEl.append(row);
    }
  }
}

/* ---------------- sessions ---------------- */

// Every tab — terminal or file browser — gets a host element, a tab button, and
// an entry in `tabs`. `kind` decides what lives inside.
function addTab({ id, kind, server, host, label }) {
  const tab = document.createElement('div');
  // Prefixed so the modifier cannot collide with a component class elsewhere —
  // a bare `files` here was picked up by the file browser's own `.files` rule.
  tab.className = `tab tab-${kind}`;
  tab.innerHTML = '<span class="tab-kind"></span><span class="tab-name"></span><button class="close" title="Close">×</button>';
  tab.querySelector('.tab-kind').textContent = kind === 'files' ? '🗂' : '›';
  tab.querySelector('.tab-name').textContent = label;
  tab.onclick = () => activate(id);
  tab.querySelector('.close').onclick = (event) => {
    event.stopPropagation();
    closeTab(id);
  };
  tabsEl.append(tab);
  termsEl.append(host);
  return tab;
}

function openFiles(server) {
  const existing = [...tabs.entries()].find(([, t]) => t.kind === 'files' && t.server.id === server.id);
  if (existing) return activate(existing[0]);

  const id = `files:${server.id}`;
  const view = window.createFilesView(server);
  const host = document.createElement('div');
  host.className = 'files-host';
  host.append(view.element);

  const tab = addTab({ id, kind: 'files', server, host, label: server.name || server.host });
  tabs.set(id, { kind: 'files', server, view, host, tab, dead: false });
  activate(id);
}

function openTerminal(server) {
  const existing = [...tabs.entries()].find(
    ([, t]) => t.kind === 'term' && t.server.id === server.id && !t.dead
  );
  if (existing) return activate(existing[0]);

  const sessionId = `${server.id}:${Date.now()}`;

  const host = document.createElement('div');
  host.className = 'term-host';

  const term = new Terminal({
    theme: THEME,
    fontFamily: 'SFMono-Regular, Menlo, monospace',
    fontSize: 13,
    cursorBlink: true,
    scrollback: 10000,
    allowProposedApi: true
  });
  const fit = new FitAddon();
  term.loadAddon(fit);

  term.onData((data) => window.api.writeSession(sessionId, data));
  term.onResize(({ cols, rows }) => window.api.resizeSession(sessionId, cols, rows));

  const tab = addTab({
    id: sessionId,
    kind: 'term',
    server,
    host,
    label: server.name || server.host
  });

  term.open(host);
  fit.fit();

  tabs.set(sessionId, { kind: 'term', server, term, fit, host, tab, dead: false });
  activate(sessionId);

  term.writeln(`\x1b[90mConnecting to ${server.user}@${server.host}:${server.port}…\x1b[0m`);
  window.api
    .startSession({ sessionId, serverId: server.id, cols: term.cols, rows: term.rows })
    .then(({ notes }) => notes.forEach((note) => term.writeln(`\x1b[90m${note}\x1b[0m`)))
    .catch((err) => {
      term.writeln(`\r\n\x1b[31m${err.message}\x1b[0m`);
      markDead(sessionId);
    });

  renderList();
}

function activate(sessionId) {
  activeId = sessionId;
  for (const [id, t] of tabs) {
    const on = id === sessionId;
    t.host.hidden = !on;
    t.tab.classList.toggle('active', on);
    if (on) {
      if (t.kind === 'term') {
        t.fit.fit();
        t.term.focus();
      } else {
        t.view.focus();
      }
    }
  }
  emptyEl.hidden = tabs.size > 0;
}

function markDead(sessionId) {
  const entry = tabs.get(sessionId);
  if (!entry) return;
  entry.dead = true;
  entry.tab.classList.add('dead');
  renderList();
}

function closeTab(sessionId, { force = false } = {}) {
  const entry = tabs.get(sessionId);
  if (!entry) return;

  const label = entry.server.name || entry.server.host;
  const what = entry.kind === 'files'
    ? entry.view.busy()
      ? `A transfer for ${label} is still running. Closing stops it and leaves a partial file. Close anyway?`
      : `Close the file browser for ${label}?`
    : entry.dead
      ? `Close this finished session for ${label}?`
      : `Close this tab? The SSH session to ${label} will be disconnected.`;
  if (!force && !window.confirm(what)) return;

  if (entry.kind === 'term') {
    window.api.killSession(sessionId);
    entry.term.dispose();
  } else {
    entry.view.dispose();
  }
  entry.host.remove();
  entry.tab.remove();
  tabs.delete(sessionId);
  if (activeId === sessionId) {
    const next = [...tabs.keys()].pop();
    if (next) activate(next);
    else {
      activeId = null;
      emptyEl.hidden = false;
    }
  }
  renderList();
}

window.api.onSessionData(({ sessionId, data }) => tabs.get(sessionId)?.term.write(data));
window.api.onSessionExit(({ sessionId, exitCode }) => {
  const entry = tabs.get(sessionId);
  if (!entry) return;
  entry.term.writeln(`\r\n\x1b[90mSession ended (exit ${exitCode}). Click the server again to reconnect.\x1b[0m`);
  markDead(sessionId);
});

/* ---------------- form ---------------- */

function setAuthMode(mode) {
  keyField.hidden = mode !== 'key';
  passwordField.hidden = mode !== 'password';
}

function openForm(server) {
  editingId = server ? server.id : null;
  formEl.reset();
  errorEl.hidden = true;
  document.getElementById('modal-title').textContent = server ? 'Edit server' : 'Add server';
  deleteBtn.hidden = !server;

  if (server) {
    formEl.name.value = server.name;
    formEl.provider.value = server.provider;
    formEl.host.value = server.host;
    formEl.user.value = server.user;
    formEl.port.value = server.port;
    formEl.pemPath.value = server.pemPath;
    const mode = server.pemPath ? 'key' : 'password';
    formEl.auth.value = mode;
    setAuthMode(mode);
    formEl.password.placeholder = server.hasPassword ? 'Unchanged — type to replace' : 'Password';
  } else {
    setAuthMode('key');
    formEl.password.placeholder = 'Password';
  }

  modalEl.hidden = false;
  formEl.name.focus();
}

function closeForm() {
  modalEl.hidden = true;
  editingId = null;
}

formEl.addEventListener('change', (event) => {
  if (event.target.name === 'auth') setAuthMode(event.target.value);
});

document.getElementById('browse-key').onclick = async () => {
  const picked = await window.api.pickKey();
  if (picked) formEl.pemPath.value = picked;
};

formEl.onsubmit = async (event) => {
  event.preventDefault();
  const mode = formEl.auth.value;
  const existing = servers.find((s) => s.id === editingId);
  const password = formEl.password.value;

  if (mode === 'key' && !formEl.pemPath.value) return showError('Pick a PEM key file.');
  if (mode === 'password' && !password && !existing?.hasPassword) return showError('Enter a password.');

  try {
    await window.api.saveServer({
      id: editingId,
      name: formEl.name.value,
      provider: formEl.provider.value,
      host: formEl.host.value,
      user: formEl.user.value,
      port: formEl.port.value,
      pemPath: mode === 'key' ? formEl.pemPath.value : '',
      password: mode === 'password' ? password : '',
      hasPassword: mode === 'password' && (Boolean(password) || Boolean(existing?.hasPassword))
    });
  } catch (err) {
    return showError(err.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  }

  closeForm();
  refreshServers();
};

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

deleteBtn.onclick = async () => {
  if (!editingId) return;
  const server = servers.find((s) => s.id === editingId);
  const label = server ? server.name || server.host : 'this server';
  const live = [...tabs.values()].some((t) => t.server.id === editingId && !t.dead);
  const message = `Delete ${label}? Its saved password is removed from the Keychain.` +
    (live ? ' Its open sessions and file browser will be closed.' : '');
  if (!window.confirm(message)) return;

  const id = editingId;
  await window.api.deleteServer(id);
  for (const [tabId, t] of [...tabs]) {
    if (t.server.id === id) closeTab(tabId, { force: true });
  }
  closeForm();
  refreshServers();
};

document.getElementById('cancel').onclick = closeForm;
document.getElementById('add-server').onclick = () => openForm(null);
searchEl.oninput = renderList;

modalEl.onmousedown = (event) => {
  if (event.target === modalEl) closeForm();
};

window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !modalEl.hidden) closeForm();
  if (event.metaKey && event.key === 'n') {
    event.preventDefault();
    openForm(null);
  }
  if (event.metaKey && event.key === 'w' && activeId) {
    event.preventDefault();
    closeTab(activeId);
  }
});

window.addEventListener('resize', () => {
  const entry = activeId && tabs.get(activeId);
  if (entry && entry.kind === 'term') entry.fit.fit();
});

// A file dragged in from Finder must not open as a page. The file panes handle
// their own pane-to-pane drops before these run.
document.addEventListener('dragover', (event) => event.preventDefault());
document.addEventListener('drop', (event) => event.preventDefault());

refreshServers();
