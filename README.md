# SSHDeck

A small macOS desktop app that opens SSH sessions to your AWS and Hostinger servers in one click.

- Sidebar lists your servers, grouped by provider.
- Clicking a server opens a real terminal tab inside the app (xterm.js over a pty running `ssh`).
- The 🗂 button opens a two-pane file browser: local files on the left, remote files over SFTP on the right.
- AWS servers authenticate with a PEM key; Hostinger servers authenticate with a password.
- Passwords live in the macOS Keychain (service `SSHDeck`), never in the app's config file.
- Server definitions are stored in `~/Library/Application Support/SSHDeck/servers.json`.
  `productName` is pinned in `package.json` so the dev run and the packaged app share that one
  directory instead of each picking their own.

## Running

```bash
npm install
npm start
```

## File browser

The 🗂 button on a server row opens a dual-pane browser: this Mac on the left, the server over SFTP
on the right. Double-click a folder to enter it, Backspace goes up, and the path bar accepts a typed
path. Select files and hit ↑ / ↓ in the pane header, or drag a selection onto the other pane, to
transfer them. Transfers run one at a time with a progress bar along the bottom.

Enter renames the selection, ⌘Backspace deletes it, and ＋ makes a folder. Deletes are **not
recursive** on either side — a non-empty directory fails rather than taking its contents with it.
Folders are not transferred yet; select files.

Each pane remembers where it was, per server, in
`~/Library/Application Support/SSHDeck/paths.json`. Closing a file browser and reopening it — or
quitting and relaunching the app — puts both panes back in the folders you left them in. A
remembered folder that no longer exists falls back to home and says so.

The remote pane shows what it is doing while it works: `Connecting to user@host…` with a spinner
during the SSH handshake, then `Reading <path>…` while the directory loads. A failed listing replaces
the spinner with the error and a Retry button.

SFTP runs over its own connection (`ssh2`), separate from the terminal's `ssh` process, opened
lazily on first use and closed when the tab closes. Host keys are checked against `~/.ssh/known_hosts`
via `ssh-keygen -F`, and an unknown host is recorded on first use — the same trust-on-first-use rule
the terminal uses with `StrictHostKeyChecking=accept-new`.

## Adding a server

Click **+ Add server** (or press ⌘N) and fill in name, provider, host/IP, user, port, and either a
PEM key file or a password. ⌘W closes the active tab (closing asks for confirmation first).

If a PEM key is readable by other users, the app tightens it to `600` on connect — `ssh` refuses
to use a key with looser permissions.

For password servers the app watches the pty for the first `password:` prompt and types the stored
password once. It never retries, so a wrong password will not burn through login attempts.

## Layout

```
src/main/main.js       Electron main process and IPC surface
src/main/sessions.js   pty lifecycle: spawn ssh, auto-answer the password prompt, resize, kill
src/main/store.js      servers.json read/write
src/main/keychain.js   macOS Keychain wrapper around the `security` CLI
src/renderer/          UI: server list, tabs, terminals, add/edit form
```

## Installing from a release

Download the DMG from [Releases](https://github.com/meharaj-007/sshdeck/releases). Builds are
Apple Silicon (arm64) only.

The app is not notarized, so macOS blocks the first launch. On macOS 15 and later, right-click →
Open no longer gets past this. Instead:

1. Drag SSHDeck to Applications and try to open it once; macOS refuses.
2. Open System Settings → Privacy & Security, scroll to the message about SSHDeck, and click
   **Open Anyway**.

Or clear the quarantine flag from a terminal:

```bash
xattr -dr com.apple.quarantine /Applications/SSHDeck.app
```

## Building and installing locally (Dock)

```bash
npm run dist                            # builds dist/mac-arm64/SSHDeck.app and a DMG
ditto dist/mac-arm64/SSHDeck.app /Applications/SSHDeck.app
open -a SSHDeck
```

Then right-click the Dock icon -> Options -> Keep in Dock.

The build is ad-hoc signed (`"identity": null` under `build.mac`), so electron-builder never picks
up a personal signing certificate from the Keychain and embeds its owner's name in a published DMG.
That is fine for running it on this machine, but `spctl` rejects it, so other Macs need the
Gatekeeper steps above until there is a Developer ID and notarization.

Note that `open -a` passes the calling shell's environment to the app. Launching it from a shell
that exports `ELECTRON_RUN_AS_NODE=1` makes the packaged app start as plain Node and exit
immediately. Launching from Finder or the Dock is unaffected.

## Troubleshooting

`Electron failed to install correctly` after `npm install` means Electron's binary did not unpack.
Re-extract it from the download cache:

```bash
rm -rf node_modules/electron/dist
ditto -x -k ~/Library/Caches/electron/*/electron-v*-darwin-arm64.zip node_modules/electron/dist
printf 'Electron.app/Contents/MacOS/Electron' > node_modules/electron/path.txt
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). SSHDeck is released under the [MIT License](LICENSE).
