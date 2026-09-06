# @git-for-ai/desktop

The Electron desktop shell ([`architecture/DESKTOP.md`](../../architecture/DESKTOP.md) §4): a
plain-Node main process that starts the **same** local review server `git for-ai review`
uses (127.0.0.1, random port) and loads the **same** SPA (`packages/review-ui`) in the
window. No logic is duplicated here — the package depends on the CLI for the server and on
review-ui for the assets.

What the shell adds on top of the browser version:

- **Repo picker** — native folder dialog plus a recent-repos list (persisted as JSON in
  Electron `userData`); remembers and reopens the last repo. One window; switching repos
  re-points it and restarts the server.
- **Opt-in screen** — picking a git repo that has not run `git for-ai init` shows a plain
  explanation and an Initialize button wired to the same `runInit` the CLI uses.
- **Maintenance panel and guided repair** — checkup, update search, fetch/send, an
  annotate form on the change page, and repair offers on checkup findings. These are the
  app's only write path, gated behind a per-launch token that nothing else on the machine
  holds; the browser version never shows them.
- **App shell** — remembered window bounds, standard menu (reload / devtools / zoom),
  single-instance lock, and graceful in-process server shutdown on close/quit (no orphaned
  processes).
- **Security posture** — `contextIsolation` on, `nodeIntegration` off, sandbox on. The SPA
  gets zero preload surface; only the local `file://` picker page sees the three-verb bridge
  (`pickFolder` / `openRepo` / `init`).

## Running

```sh
pnpm build                                   # root build first (server + SPA assets)
pnpm --filter @git-for-ai/desktop start      # launch the app from source
pnpm --filter @git-for-ai/desktop smoke      # self-verifying launch: open repo, hit /api/meta, quit
```

`smoke` opens `GIT_FOR_AI_DESKTOP_REPO` (or the cwd's repo), fetches `/api/meta` from the
in-process server, logs the result, and exits.

Troubleshooting: if launch fails with a missing `node_modules/electron/dist/electron.exe`,
the binary-download postinstall did not run during `pnpm install` — run `pnpm rebuild
electron` from `packages/desktop`.

`electron-builder.yml` is checked in for packaging; its appId/productName are placeholders
and no installer is built.
