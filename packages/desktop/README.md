# desktop (placeholder — not built)

This will be an Electron + React shell around `@git-for-ai/core`, called in-process (Electron's
main process is just Node — no local server needed on one machine). For people who want
`blame --why` and `ask` as a GUI rather than a terminal command.

Not scaffolded yet — no `package.json`, so pnpm doesn't treat this as a workspace package.

Build order: after the CLI has real usage, so the GUI wraps something proven rather than
something guessed at — see
[`architecture/MONOREPO_PLAN.md` §4](../../architecture/MONOREPO_PLAN.md#4-build-order).
