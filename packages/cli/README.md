# git-for-ai (CLI)

The user-facing package. Thin Commander.js wrapper over `@git-for-ai/core` — parses flags, calls
into core, formats output (including `--json`). This is what gets published to npm and invoked as
`git for-ai <command>`.

```
src/
├── bin.ts             entry point — registers every subcommand below
└── commands/
    ├── init.ts
    ├── capture-session.ts   (internal, hook-invoked)
    ├── log.ts
    ├── blame.ts
    ├── ask.ts
    ├── sync.ts
    ├── reindex.ts
    ├── doctor.ts
    ├── show.ts
    ├── reconcile.ts
    ├── relink.ts
    ├── export.ts
    └── config.ts
```

One file per command, matching [`architecture/CLI_REFERENCE.md`](../../architecture/CLI_REFERENCE.md)
exactly. Depends on `@git-for-ai/core` and `@git-for-ai/schemas`.

Status: scaffolded, not yet implemented. See
[`architecture/CLI_PLAN.md`](../../architecture/CLI_PLAN.md) for the build order — this is the
first package that needs to fully work.
