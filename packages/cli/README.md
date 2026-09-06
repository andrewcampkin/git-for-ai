# git-for-ai (CLI)

The user-facing package: a Commander.js wrapper over `@git-for-ai/core`. It parses flags,
calls into core, and formats output (including `--json`). It is what runs as
`git for-ai <command>` once `dist/bin.js` is on `PATH` as `git-for-ai`.

```
src/
├── bin.ts                 entry point — registers every subcommand
└── commands/              one file per command, matching architecture/CLI_REFERENCE.md
    ├── init.ts            opt a repo in: hooks, refspecs, .git-for-ai/
    ├── internal-hook.ts   git-hook dispatcher (commit-msg / post-commit / post-rewrite)
    ├── capture-session.ts Claude Code hook: capture a session at commit time
    ├── log.ts, show.ts, blame.ts, ask.ts, askTools.ts, queryDeps.ts
    ├── annotate.ts        the deliberate intent write path
    ├── report.ts          self-contained HTML/Markdown digest
    ├── review.ts, reviewGit.ts, reviewActions.ts   local review server + JSON API
    ├── reindex.ts, sync.ts, doctor.ts, config.ts, export.ts
    ├── relink.ts, reconcile.ts                      identity repair
    └── mcp.ts             stdio MCP server
```

Every command is a pure `run*` function plus a thin renderer, so the review server, the
desktop app, the MCP server and the `ask` toolbox all call the same code the terminal does.

Tests run against real temporary git repositories (`createFixtureRepo` from
`@git-for-ai/core/testing`); git is never mocked. The only mocked seam is external HTTP
(the Anthropic and Voyage APIs) via an injectable `fetchImpl`.

```sh
pnpm vitest run                 # this package's suite
pnpm vitest run src/commands/doctor.test.ts
```
