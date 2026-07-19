# Idea 03: Vector-Indexed Repository Brain

## Problem

Even with a perfect ledger of structured intent (Idea 01) and full session transcripts (Idea 02),
none of it is *findable* unless you already know which commit to look at. "Why does auth work this
way" or "find the commit where we decided against using Redis" are semantic questions that
grep/`git log --grep` handle badly. Text search only works if you guess the exact words someone
used months ago.

## Mechanism

A local, offline-first vector index sitting alongside the repo, embedding three kinds of content
into the same searchable space:

1. **Code chunks** — tree-sitter-parsed function/class-level chunks (not raw file splits), so
   embeddings align with meaningful units, following Continue.dev's proven approach rather than
   inventing a new chunking strategy.
2. **Ledger entries** (Idea 01) — the structured intent records, so "why" text is searchable
   alongside the code it explains.
3. **Session summaries** (Idea 02) — a compressed representation of session transcripts (not the
   full raw trace — too noisy/large to embed directly), so agent reasoning is searchable too.

Storage: **sqlite-vec** for the MVP — zero-dependency, single SQLite file, trivially backed up and
inspected, per the embedded-vector-DB comparison in the research doc. LanceDB is the flagged
upgrade path if/when schema or query needs outgrow a single SQLite file.

Embedding model: pluggable, defaulting to a **self-hosted, open-weight model** (Jina Embeddings v2
code, or Nomic Embed Code) to keep the "fully offline" promise intact, with **Voyage AI
voyage-code-3** available as an opt-in higher-quality API-backed alternative (Anthropic's
recommended embeddings provider, since Anthropic doesn't offer its own embeddings API) for users
willing to trade offline-ness for retrieval quality.

The index is incrementally updated on commit (new/changed chunks only, keyed to blob hashes so
unchanged code doesn't get re-embedded), mirroring Cursor's Merkle-tree incremental re-sync
approach but done locally instead of against a remote index.

## Pros

- This is the component that makes the ledger/session data actually usable day-to-day, not just an
  audit trail nobody reads.
- Local-first avoids the exact trap Sourcegraph hit with Cody Enterprise (they deprecated
  embeddings over cost and third-party data exposure) — no per-query API cost, no code leaving the
  machine unless the user opts into an API embedding provider.
- Incremental, blob-hash-keyed updates keep re-indexing cheap on typical commit sizes.

## Cons / risks

- Embedding quality genuinely matters and open-weight models lag the best API models on code
  retrieval benchmarks — the "offline-first" default is a real quality trade-off, not a free lunch.
  Needs to be stated plainly to users, not hidden.
- sqlite-vec is comparatively young; needs its own durability/backup story same as any local DB
  (what happens if the index file gets corrupted — full rebuild from git history should always be
  possible, i.e. the index must be a derived cache, never the source of truth).
- Chunking strategy (tree-sitter) needs per-language grammars — breadth of language support will
  lag a pure-text approach.

## Novelty vs. prior art

Aider deliberately avoids embeddings (PageRank over tree-sitter defs/refs instead) — a reasonable
alternative we considered and rejected here specifically because the goal isn't just "fit relevant
code in a context window" (Aider's actual goal) but "answer semantic questions about history and
intent," which needs a real similarity search over accumulated *reasoning* text, not just code
structure. Sem (Ataraxy Labs) stores an entity cache but it's unversioned and doesn't do
embeddings at all. Nobody in the landscape doc combines embeddings of code *and* embeddings of
captured intent/session data in one index.

## Effort estimate

Medium. The embedded-DB and chunking pieces are well-trodden (Continue.dev is a working reference
architecture); the new work is embedding ledger/session content alongside code and keeping the
whole thing incrementally in sync with commits.
