# Contributing to SSHDeck

Thanks for helping out. SSHDeck is a small Electron app for macOS, so the setup is short.

## Setup

```bash
npm install                            # also rebuilds node-pty against Electron
env -u ELECTRON_RUN_AS_NODE npm start  # run the app
```

Some terminals and agent environments export `ELECTRON_RUN_AS_NODE=1`. With it set, Electron boots
as plain Node and dies with `Cannot read properties of undefined (reading 'whenReady')`, so launch
with `env -u ELECTRON_RUN_AS_NODE` as shown.

If `npm install` leaves you with `Electron failed to install correctly`, see Troubleshooting in
[README.md](README.md).

## Workflow

- `main` is always releasable. Nobody pushes to it directly; every change goes through a pull request.
- Outside contributors: fork the repo and open a PR from a branch on your fork.
- Collaborators: push a short-lived branch named after the change, e.g. `fix/sftp-timeout` or
  `feat/tab-reorder`, and open a PR against `main`.
- Keep a PR to one change. Rebase on `main` if it falls behind.
- CI must pass and a maintainer must approve before merge. Branches are deleted after merge.

## Releases

Releases are SemVer tags on `main` (`v1.1.0`, `v1.1.1`, ...) with a GitHub release and a DMG.
There are no release branches; a maintenance branch such as `1.x` is cut only if an older line needs
fixes after a newer major ships.

## Ground rules for changes

- **Deletes stay non-recursive.** Neither the local nor the SFTP side may delete a non-empty
  directory. These are production servers; do not add `fs.rm({recursive:true})` or `rm -rf`.
- **The password prompt is answered once.** Replaying a wrong secret walks into the server's
  login-attempt limit.
- **Secrets never go in argv or in `servers.json`.** Passwords live in the macOS Keychain and reach
  `security` on stdin.
- **The renderer has no bundler.** No `import` syntax in `src/renderer/`, no remote asset URLs; the
  CSP is `script-src 'self'`.
- The renderer reaches the system only through `window.api` in `src/main/preload.js`. Keep
  `contextIsolation` on and `nodeIntegration` off.

## Testing your change

There is no automated test suite yet. CI installs dependencies and syntax-checks every file. Before
opening a PR, run the app and exercise what you changed: connect to a key-auth and a password-auth
server if you touched sessions, and browse, transfer and delete in the file browser if you touched
SFTP. Say in the PR what you tested.

## Reporting bugs and security issues

Open an issue for bugs and feature requests. For anything security-sensitive (credential handling,
host key checks), use GitHub's private vulnerability reporting under the repo's Security tab instead
of a public issue.
