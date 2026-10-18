/* Dual-pane file browser: local filesystem on the left, the server over SFTP on
   the right. Exposed as window.createFilesView(server) by renderer.js. */

const parentOf = (p) => {
  const trimmed = p.replace(/\/+$/, '');
  const cut = trimmed.lastIndexOf('/');
  if (cut <= 0) return '/';
  return trimmed.slice(0, cut);
};

const joinPath = (dir, name) => (dir === '/' ? `/${name}` : `${dir.replace(/\/+$/, '')}/${name}`);

function formatSize(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || unit === 0 ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

function formatDate(ms) {
  if (!ms) return '';
  const d = new Date(ms);
  const now = new Date();
  const opts = d.getFullYear() === now.getFullYear()
    ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
    : { year: 'numeric', month: 'short', day: 'numeric' };
  return d.toLocaleString(undefined, opts);
}

function sortEntries(entries) {
  return [...entries].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
}

function askText(title, value) {
  // Electron does not implement window.prompt, so this is the stand-in.
  return new Promise((resolve) => {
    const backdrop = document.createElement('div');
    backdrop.className = 'modal';
    backdrop.innerHTML = `
      <form class="sheet small">
        <h2></h2>
        <input name="value" autocomplete="off" spellcheck="false" />
        <div class="actions">
          <span class="spacer"></span>
          <button type="button" class="ghost">Cancel</button>
          <button type="submit" class="primary">OK</button>
        </div>
      </form>`;
    backdrop.querySelector('h2').textContent = title;
    const input = backdrop.querySelector('input');
    input.value = value || '';

    const close = (result) => {
      backdrop.remove();
      resolve(result);
    };
    backdrop.querySelector('form').onsubmit = (event) => {
      event.preventDefault();
      close(input.value.trim() || null);
    };
    backdrop.querySelector('.ghost').onclick = () => close(null);
    backdrop.onmousedown = (event) => {
      if (event.target === backdrop) close(null);
    };
    backdrop.onkeydown = (event) => {
      if (event.key === 'Escape') close(null);
      event.stopPropagation();
    };

    document.body.append(backdrop);
    input.focus();
    input.select();
  });
}

window.createFilesView = function createFilesView(server) {
  const root = document.createElement('div');
  root.className = 'files';
  root.innerHTML = `
    <div class="pane" data-side="local"></div>
    <div class="divider"></div>
    <div class="pane" data-side="remote"></div>
    <div class="transfer-bar" hidden><span class="transfer-label"></span><div class="bar"><i></i></div></div>`;

  const bar = root.querySelector('.transfer-bar');
  const barLabel = root.querySelector('.transfer-label');
  const barFill = root.querySelector('.bar i');

  const panes = {};
  let disposed = false;

  /* ---------------- one pane ---------------- */

  function buildPane(side) {
    const el = root.querySelector(`.pane[data-side="${side}"]`);
    const remote = side === 'remote';
    el.innerHTML = `
      <header>
        <span class="pane-title"></span>
        <div class="pane-tools">
          <button class="icon up" title="Parent folder">↑</button>
          <button class="icon refresh" title="Refresh">⟳</button>
          <button class="icon newdir" title="New folder">＋</button>
          <button class="icon send" title=""></button>
        </div>
      </header>
      <input class="path" spellcheck="false" autocomplete="off" />
      <div class="rows-wrap">
        <div class="rows"></div>
        <div class="pane-overlay" hidden>
          <span class="spinner"></span>
          <span class="overlay-text"></span>
          <button type="button" class="ghost retry" hidden>Retry</button>
        </div>
      </div>
      <footer class="pane-status"></footer>`;

    el.querySelector('.pane-title').textContent = remote ? server.name || server.host : 'This Mac';
    const send = el.querySelector('.send');
    send.textContent = remote ? '↓' : '↑';
    send.title = remote ? 'Download selected' : 'Upload selected';

    const pane = {
      side,
      remote,
      el,
      rowsEl: el.querySelector('.rows'),
      pathEl: el.querySelector('.path'),
      statusEl: el.querySelector('.pane-status'),
      overlayEl: el.querySelector('.pane-overlay'),
      overlayTextEl: el.querySelector('.overlay-text'),
      spinnerEl: el.querySelector('.spinner'),
      retryEl: el.querySelector('.retry'),
      path: '',
      entries: [],
      selected: new Set(),
      anchor: null
    };

    el.querySelector('.up').onclick = () => navigate(pane, parentOf(pane.path));
    el.querySelector('.refresh').onclick = () => navigate(pane, pane.path);
    el.querySelector('.newdir').onclick = () => createFolder(pane);
    send.onclick = () => transferSelected(pane);

    pane.pathEl.onkeydown = (event) => {
      if (event.key === 'Enter') navigate(pane, pane.pathEl.value.trim());
      if (event.key === 'Escape') pane.pathEl.value = pane.path;
      event.stopPropagation();
    };

    // Dropping a selection from the other pane transfers it here.
    el.ondragover = (event) => {
      if (event.dataTransfer.types.includes('text/x-sshdeck-side')) {
        event.preventDefault();
        el.classList.add('drop-target');
      }
    };
    el.ondragleave = () => el.classList.remove('drop-target');
    el.ondrop = (event) => {
      el.classList.remove('drop-target');
      const from = event.dataTransfer.getData('text/x-sshdeck-side');
      if (from && from !== side) {
        event.preventDefault();
        transferSelected(panes[from]);
      }
    };

    panes[side] = pane;
    return pane;
  }

  /* ---------------- connection state ---------------- */

  const address = `${server.user}@${server.host}`;
  let connState = 'unknown';

  window.api.remoteIsConnected(server.id).then((yes) => {
    if (connState === 'unknown') connState = yes ? 'connected' : 'idle';
  });

  window.api.onRemoteStatus((payload) => {
    if (disposed || payload.serverId !== server.id) return;
    connState = payload.state;
    const pane = panes.remote;
    if (!pane) return;

    if (payload.state === 'connecting' && !pane.overlayEl.hidden) {
      showOverlay(pane, `Connecting to ${address}…`);
    }
    if (payload.state === 'connected' && !pane.overlayEl.hidden) {
      showOverlay(pane, `Reading ${pane.pathEl.value || 'home'}…`);
    }
    if (payload.state === 'closed') {
      pane.statusEl.textContent = 'Disconnected — the next action reconnects.';
    }
  });

  function showOverlay(pane, text, { retry } = {}) {
    pane.overlayTextEl.textContent = text;
    pane.spinnerEl.hidden = Boolean(retry);
    pane.retryEl.hidden = !retry;
    pane.retryEl.onclick = retry || null;
    pane.overlayEl.hidden = false;
  }

  function hideOverlay(pane) {
    pane.overlayEl.hidden = true;
    pane.retryEl.onclick = null;
  }

  /* ---------------- listing ---------------- */

  async function navigate(pane, target) {
    pane.statusEl.textContent = 'Loading…';
    if (pane.remote) {
      showOverlay(
        pane,
        connState === 'connected' ? `Reading ${target || 'home'}…` : `Connecting to ${address}…`
      );
    }
    try {
      const result = pane.remote
        ? await window.api.remoteList(server.id, target || undefined)
        : await window.api.localList(target || undefined);
      if (disposed) return true;
      pane.path = result.path;
      pane.pathEl.value = result.path;
      pane.entries = sortEntries(result.entries);
      pane.selected.clear();
      pane.anchor = null;
      renderRows(pane);
      hideOverlay(pane);
      window.api.savePath(server.id, pane.side, result.path);
      return true;
    } catch (err) {
      const message = err.message
        .replace(/^Error invoking remote method '[^']+': /, '')
        .replace(/^Error:\s*/, '');
      pane.pathEl.value = pane.path;
      pane.statusEl.textContent = message;
      if (pane.remote) {
        showOverlay(pane, message, { retry: () => navigate(pane, target) });
      }
      return false;
    }
  }

  function renderRows(pane) {
    pane.rowsEl.innerHTML = '';
    for (const entry of pane.entries) {
      const row = document.createElement('div');
      row.className = 'row' + (entry.isDirectory ? ' dir' : '') + (pane.selected.has(entry.name) ? ' selected' : '');
      row.draggable = true;
      row.innerHTML = `
        <span class="glyph">${entry.isDirectory ? '📁' : '📄'}</span>
        <span class="fname"></span>
        <span class="fsize"></span>
        <span class="fdate"></span>`;
      row.querySelector('.fname').textContent = entry.name + (entry.isSymlink ? ' ↗' : '');
      row.querySelector('.fsize').textContent = entry.isDirectory ? '' : formatSize(entry.size);
      row.querySelector('.fdate').textContent = formatDate(entry.mtime);

      row.onclick = (event) => select(pane, entry, event);
      row.ondblclick = () => {
        if (entry.isDirectory) navigate(pane, joinPath(pane.path, entry.name));
      };
      row.ondragstart = (event) => {
        if (!pane.selected.has(entry.name)) select(pane, entry, {});
        event.dataTransfer.setData('text/x-sshdeck-side', pane.side);
        event.dataTransfer.effectAllowed = 'copy';
      };
      pane.rowsEl.append(row);
    }
    updateStatus(pane);
  }

  function select(pane, entry, event) {
    const names = pane.entries.map((e) => e.name);
    if (event.shiftKey && pane.anchor) {
      const from = names.indexOf(pane.anchor);
      const to = names.indexOf(entry.name);
      pane.selected = new Set(names.slice(Math.min(from, to), Math.max(from, to) + 1));
    } else if (event.metaKey) {
      if (pane.selected.has(entry.name)) pane.selected.delete(entry.name);
      else pane.selected.add(entry.name);
      pane.anchor = entry.name;
    } else {
      pane.selected = new Set([entry.name]);
      pane.anchor = entry.name;
    }
    renderRows(pane);
  }

  function updateStatus(pane) {
    const count = pane.selected.size;
    pane.statusEl.textContent = count
      ? `${count} selected`
      : `${pane.entries.length} item${pane.entries.length === 1 ? '' : 's'}`;
  }

  /* ---------------- mutations ---------------- */

  async function createFolder(pane) {
    const name = await askText(`New folder in ${pane.path}`, '');
    if (!name) return;
    const target = joinPath(pane.path, name);
    try {
      if (pane.remote) await window.api.remoteMkdir(server.id, target);
      else await window.api.localMkdir(target);
      navigate(pane, pane.path);
    } catch (err) {
      pane.statusEl.textContent = err.message;
    }
  }

  async function removeSelected(pane) {
    const targets = pane.entries.filter((e) => pane.selected.has(e.name));
    if (!targets.length) return;
    const where = pane.remote ? `${server.name || server.host}` : 'this Mac';
    const names = targets.map((t) => t.name).join(', ');
    if (!window.confirm(`Delete ${targets.length} item(s) on ${where}?\n\n${names}`)) return;

    for (const entry of targets) {
      const target = joinPath(pane.path, entry.name);
      try {
        if (pane.remote) await window.api.remoteRemove(server.id, target, entry.isDirectory);
        else await window.api.localRemove(target, entry.isDirectory);
      } catch (err) {
        // Directories are removed non-recursively on purpose, so a non-empty one
        // fails here rather than taking its contents with it.
        pane.statusEl.textContent = `${entry.name}: ${err.message.split(': ').pop()}`;
      }
    }
    navigate(pane, pane.path);
  }

  async function renameSelected(pane) {
    const [name] = [...pane.selected];
    if (!name) return;
    const next = await askText('Rename to', name);
    if (!next || next === name) return;
    const from = joinPath(pane.path, name);
    const to = joinPath(pane.path, next);
    try {
      if (pane.remote) await window.api.remoteRename(server.id, from, to);
      else await window.api.localRename(from, to);
      navigate(pane, pane.path);
    } catch (err) {
      pane.statusEl.textContent = err.message;
    }
  }

  /* ---------------- transfers ---------------- */

  const transfers = new Map(); // transferId -> { total, transferred }
  let queue = Promise.resolve();

  window.api.onTransferProgress(({ transferId, transferred, total }) => {
    const t = transfers.get(transferId);
    if (!t) return;
    t.transferred = transferred;
    t.total = total;
    barFill.style.width = `${total ? Math.round((transferred / total) * 100) : 0}%`;
  });

  function transferSelected(pane) {
    const source = pane;
    const destination = panes[pane.remote ? 'local' : 'remote'];
    const items = source.entries.filter((e) => source.selected.has(e.name) && !e.isDirectory);
    const skipped = source.selected.size - items.length;
    if (!items.length) {
      source.statusEl.textContent = skipped ? 'Folders are not transferred yet — select files.' : 'Nothing selected.';
      return;
    }

    for (const entry of items) {
      const transferId = `${Date.now()}-${entry.name}`;
      const localPath = source.remote
        ? joinPath(destination.path, entry.name)
        : joinPath(source.path, entry.name);
      const remotePath = source.remote
        ? joinPath(source.path, entry.name)
        : joinPath(destination.path, entry.name);

      queue = queue.then(async () => {
        if (disposed) return;
        transfers.set(transferId, { transferred: 0, total: entry.size });
        bar.hidden = false;
        barFill.style.width = '0%';
        barLabel.textContent = `${source.remote ? 'Downloading' : 'Uploading'} ${entry.name}`;
        try {
          await window.api.runTransfer({
            transferId,
            serverId: server.id,
            direction: source.remote ? 'download' : 'upload',
            localPath,
            remotePath
          });
          if (!disposed) navigate(destination, destination.path);
        } catch (err) {
          barLabel.textContent = `${entry.name}: ${err.message.split(': ').pop()}`;
        } finally {
          transfers.delete(transferId);
          if (!transfers.size) setTimeout(() => { bar.hidden = transfers.size === 0 ? true : false; }, 1200);
        }
      });
    }
    if (skipped) source.statusEl.textContent = `${skipped} folder(s) skipped — files only.`;
  }

  /* ---------------- wiring ---------------- */

  const local = buildPane('local');
  const remote = buildPane('remote');

  function activePane() {
    return root.querySelector('.pane:focus-within') === remote.el ? remote : local;
  }

  root.tabIndex = 0;
  root.addEventListener('keydown', (event) => {
    if (event.target.classList.contains('path')) return;
    const pane = activePane();
    if (event.key === 'Backspace') {
      event.preventDefault();
      navigate(pane, parentOf(pane.path));
    }
    if (event.key === 'Delete' || (event.metaKey && event.key === 'Backspace')) {
      event.preventDefault();
      removeSelected(pane);
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      renameSelected(pane);
    }
  });

  // Draggable split.
  const divider = root.querySelector('.divider');
  divider.onmousedown = (event) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = local.el.getBoundingClientRect().width;
    const total = root.getBoundingClientRect().width;
    const move = (e) => {
      const ratio = Math.min(0.8, Math.max(0.2, (startWidth + e.clientX - startX) / total));
      root.style.gridTemplateColumns = `${ratio}fr 6px ${1 - ratio}fr`;
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  };

  // Reopen where this server's panes were last left. A remembered folder can be
  // gone by now, so fall back to the default and say why.
  (async () => {
    const saved = await window.api.getSavedPaths(server.id);

    const home = await window.api.localHome();
    if (saved.local && saved.local !== home) {
      if (!(await navigate(local, saved.local)) && (await navigate(local, home))) {
        local.statusEl.textContent = `${saved.local} is gone — showing home.`;
      }
    } else {
      await navigate(local, home);
    }

    if (saved.remote) {
      // A failed listing here can also mean the connection died, so only blame the
      // remembered folder when the fallback actually works.
      if (!(await navigate(remote, saved.remote)) && (await navigate(remote, ''))) {
        hideOverlay(remote);
        remote.statusEl.textContent = `${saved.remote} is gone — showing home.`;
      }
    } else {
      await navigate(remote, '');
    }
  })();

  return {
    element: root,
    focus: () => root.focus(),
    dispose: () => {
      disposed = true;
      window.api.remoteDisconnect(server.id);
    }
  };
};
