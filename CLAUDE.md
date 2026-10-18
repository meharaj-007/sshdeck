# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

SSHDeck: an Electron desktop app (macOS) that lists SSH servers in a sidebar and opens each one as a
real terminal tab inside the app. AWS servers authenticate with a PEM key, Hostinger servers with a
password. No test suite, no linter, no build step for the renderer — the HTML/CSS/JS are loaded
directly off disk.

## Commands

```bash
npm install                            # also runs electron-rebuild for node-pty (postinstall)
env -u ELECTRON_RUN_AS_NODE npm start  # run the app
npm run dist                           # electron-builder -> unsigned DMG in dist/
```

`ELECTRON_RUN_AS_NODE=1` is exported in some agent/terminal environments. If it is set, `electron .`
boots as plain Node and dies with `Cannot read properties of undefined (reading 'whenReady')`.
Always launch with `env -u ELECTRON_RUN_AS_NODE`.

To exercise main-process code without opening a window, run it under Electron's own Node — that
binary has the ABI `node-pty` was rebuilt against, so plain `node` cannot load it:

```bash
ELECTRON_RUN_AS_NODE=1 node_modules/.bin/electron script.js
```

`sessions.js` is the one module worth driving this way; it only pulls in `node-pty`, `fs`, and `os`,
so it can be started against a dead host to confirm the pty path still works end to end.

## Architecture

Three processes, strict `contextIsolation`, no `nodeIntegration`. The renderer touches the system
only through the `window.api` surface defined in `src/main/preload.js`.

- `src/main/main.js` — window creation plus the whole IPC surface. Request/response over
  `ipcMain.handle` (`servers:list|save|delete`, `dialog:pickKey`, `session:start`); fire-and-forget
  over `ipcMain.on` (`session:write|resize|kill`). Terminal output flows the other way as
  `session:data` / `session:exit` pushes to the sender.
- `src/main/sessions.js` — owns every pty. Spawns `/usr/bin/ssh` with flags derived from the server
  record and keeps a `Map` of live terminals keyed by session id.
- `src/main/store.js` — `servers.json` in `app.getPath('userData')`, written mode 600. Records are
  normalized on write, and carry `hasPassword: boolean` only; the password itself is never in this file.
- `src/main/keychain.js` — shells out to the `security` CLI, service name `SSHDeck`, account = server id.
- `src/main/sftp.js` — SFTP over `ssh2`, one channel per server, cached in a `Map` and reused by
  every pane. Host keys go through `ssh-keygen -F` against `~/.ssh/known_hosts` with trust-on-first-use.
- `src/main/localfs.js` — the local half of the file browser, same entry shape as the remote half.
- `src/main/paths.js` — `paths.json`, the last directory each pane was showing per server. Writes are
  debounced 400ms because navigation is chatty, and flushed on quit.
- `src/renderer/renderer.js` — server list, tabs, and one xterm instance per session.
- `src/renderer/files.js` — `window.createFilesView(server)`, the dual-pane browser.

### Session identity

A server id is stable; a session id is `${serverId}:${Date.now()}`. Clicking a server reuses its
live tab if one exists and spawns a new session otherwise, so one server can have several dead tabs
and at most one live tab. `renderList()` derives the "connected" highlight from the tab map, which
means it must be called after any tab open/close/death.

### Tabs

`tabs` holds both kinds of tab, discriminated by `kind`: `'term'` (xterm + pty) and `'files'`
(`createFilesView`). Anything walking that map has to branch — `activate`, `closeTab`, the window
resize handler, and the sidebar's live-connection highlight all do. A terminal id is
`serverId:timestamp` so a server can have several; a files tab id is `files:serverId` so it is
a singleton per server.

Closing any tab asks for confirmation first (`window.confirm`), including via ⌘W.

### Pane path memory

`navigate()` in `files.js` persists the resolved path (not the requested one) on every successful
listing, and a new files view restores both panes from `paths.json` before its first listing. The
restore treats a failed listing as "folder is gone" only when the fallback listing succeeds —
otherwise the connection is what failed, and its error message has to survive.

### Connection status

`sftp.js` is an `EventEmitter` (`sftp.status`) emitting `connecting` / `connected` / `error` /
`closed` per server; `main.js` broadcasts those to every window as `remote:status`. It is a broadcast
rather than a request because one connection is shared by every pane watching that server, and a
connect triggered by one pane has to light up the others. `files.js` drives the remote pane's
overlay from it — spinner while connecting or reading, error text plus a Retry button on failure.
`connect()` announces nothing when it returns a cached channel, so no spinner flashes on an already
open connection.

### Deletes are not recursive

Neither `localfs.removeDir` nor `sftp.removeDir` recurses, on either side. These are production
servers and a recursive delete is not recoverable, so a non-empty directory must fail. `sftp.rmdir`
reports every failure as a bare `Failure`, so `removeDir` re-lists the directory to say whether it
was non-empty. Do not "fix" this by reaching for `fs.rm({recursive:true})` or `rm -rf`.

### Auth flow

Key auth appends `-i <pem> -o IdentitiesOnly=yes`. Password auth appends
`-o PubkeyAuthentication=no -o PreferredAuthentications=keyboard-interactive,password` so ssh does
not burn attempts on agent keys first.

For password auth, `sessions.js` watches the last 200 bytes of pty output for a trailing
`password:` / `passphrase:` prompt and writes the Keychain secret once. **Keep it once.** Replaying a
wrong secret walks into the server's login-attempt limit, and `sshd` prompts three times per
connection. After that first answer the user types manually.

`ensureKeyPermissions` chmods a group/other-readable PEM to 600 before connecting, because ssh
refuses the key otherwise, and reports it back through the `notes` array in the `session:start`
reply so the terminal can show what changed.

Passwords reach `security` on stdin (`-w` with no value), never as an argv element — argv is visible
to every user on the machine via `ps`.

## Renderer constraints

`index.html` sets a CSP with `script-src 'self'`, and the page is loaded from `file://`. xterm ships
UMD only, so it is pulled in as two classic `<script>` tags from `../../node_modules/@xterm/...` and
read off the globals `window.Terminal` and `window.FitAddon.FitAddon`. There is no bundler; do not
introduce `import` syntax in the renderer without adding one, and do not add remote asset URLs.

`window.prompt` does not exist in Electron; `files.js` has an `askText` modal that stands in for it.
`window.confirm` does work and is used for deletes and tab closes.

Every tab keeps its own `FitAddon`. Call `fit()` after making a terminal visible — a hidden xterm
measures as zero and comes back with a broken geometry.

## Electron binary

`npm install` has been observed leaving `node_modules/electron/dist` partially extracted (a few
hundred KB instead of ~242 MB), which surfaces as `Electron failed to install correctly`. Re-extract
from the download cache rather than reinstalling; the recipe is under Troubleshooting in README.md.
