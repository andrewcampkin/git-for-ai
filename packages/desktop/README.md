# @git-for-ai/desktop

The Electron desktop shell (architecture/DESKTOP.md §4): a plain-Node main process that
starts the **same** local review server `git for-ai review` uses (127.0.0.1, random port,
read-only) and loads the **same** SPA (`packages/review-ui`) in the window. No logic is
duplicated here — the package depends on the CLI for the server and on review-ui for the
assets.

What the shell adds on top of the server:

- **Repo picker** — native folder dialog plus a recent-repos list (persisted as JSON in
  Electron `userData`); remembers and reopens the last repo. Single window in v1
  (window-per-repo is an open owner question, DESKTOP.md §6.2) — switching repos re-points
  the window and restarts the server.
- **Opt-in screen** — picking a git repo that hasn't run `git for-ai init` shows a plain
  explanation and an Initialize button wired to the same pure `runInit` the CLI uses (the
  one write action in the v1 shell; everything else stays the read-only server).
- **App shell** — window title `git-for-ai — <repo>` (internal name; public name TBD),
  remembered window bounds, standard menu (reload / devtools / zoom), single-instance
  lock, and graceful in-process server shutdown on close/quit (no orphaned processes).
- **Security posture** — `contextIsolation` on, `nodeIntegration` off, sandbox on. The SPA
  gets zero preload surface; only the local `file://` picker page sees the three-verb
  bridge (`pickFolder` / `openRepo` / `init`).

## Running

```
pnpm build                                   # root build first (server + SPA assets)
pnpm --filter @git-for-ai/desktop start      # launch the app from source
pnpm --filter @git-for-ai/desktop smoke      # self-verifying launch: open repo, hit /api/meta, quit
```

`smoke` opens `GIT_FOR_AI_DESKTOP_REPO` (or the cwd's repo), fetches `/api/meta` from the
in-process server, logs the result, and exits — the log lines are launch evidence.

Troubleshooting: if launch fails with a missing `node_modules/electron/dist/electron.exe`,
the binary-download postinstall didn't run during `pnpm install` (observed once) — run
`pnpm rebuild electron` from `packages/desktop`.

`electron-builder.yml` is checked in for the later packaging step (DESKTOP.md §5 step 5);
its appId/productName are placeholders until the public name is decided. No installer is
built yet.
