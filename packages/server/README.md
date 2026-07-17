# server (placeholder — not built)

This will be the self-hostable hosting component: a ref-relay tier (thin, maybe unnecessary —
plain git remotes may already accept our custom refs) plus the actual differentiated piece, a
shared team query/index service (Fastify + Postgres/pgvector).

Not scaffolded yet — no `package.json`, so pnpm doesn't treat this as a workspace package.

Design: [`architecture/MONOREPO_PLAN.md` §5](../../architecture/MONOREPO_PLAN.md#5-the-server-what-hosting-this-like-a-git-server-actually-means).
Build order: after the CLI works end-to-end and there's an actual second machine/user/team need —
see [`architecture/MONOREPO_PLAN.md` §4](../../architecture/MONOREPO_PLAN.md#4-build-order).
