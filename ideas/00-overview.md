# Idea Overview & Comparison

Six standalone directions, each addressing a different facet of "hold the intent/understanding of
a repo alongside its diffs." They're not mutually exclusive — the [architecture spec](../architecture/ARCHITECTURE.md)
is a synthesis of the ones marked **MVP** below, with the rest as explicit roadmap items. See
[research/landscape.md](../research/landscape.md) for the prior-art this responds to.

| # | Idea | Answers | Status |
|---|---|---|---|
| [01](01-semantic-commit-ledger.md) | Semantic Commit Ledger | Where does structured intent live, and how does it survive rebase/amend/cherry-pick? | **MVP** — foundation everything else builds on |
| [02](02-agent-session-ledger.md) | Agent Session Ledger | How do we capture full AI agent reasoning (not just a one-line summary)? | **MVP** — this is the "intent source" you asked for |
| [03](03-vector-repo-index.md) | Vector-Indexed Repository Brain | How do we make repo history semantically searchable, not just grep-able? | **MVP** — this is the "encode as vectors" piece you asked for |
| [04](04-conversational-blame.md) | Conversational Blame / Repo Q&A | How does a person actually *use* 01-03 day to day? | **MVP** — the user-facing payoff, thin layer over 01-03 |
| [05](05-intent-knowledge-graph.md) | Intent Knowledge Graph | How do decisions/concepts get consolidated over time instead of just accumulating? | Roadmap (v2) — needs 01/02 populated with real data first |
| [06](06-semantic-drift-detector.md) | Semantic Diff & Drift Detector | How do we notice when code has quietly drifted from its documented intent? | Roadmap (v2) — needs 03's embeddings to be mature |

## Why this split and this MVP cut

Ideas 01–04 form one coherent pipeline: **01** is the durable record format and identity model,
**02** is the richest source of content for that record, **03** makes the accumulated records
(and the code itself) queryable by meaning, and **04** is the command a user actually types. None
of them are useful in isolation — a session ledger nobody can query is a graveyard of JSONL, and
a vector index over commits with no captured intent just re-embeds diffs (which existing tools
already do adequately, per the "sem" and Cursor/Continue prior art). Building all four is what
makes this different from the point-solutions already in the landscape doc.

05 and 06 are real and worth doing, but both are second-order: a knowledge graph has nothing to
consolidate until the ledger has weeks of real entries, and drift detection needs an embedding
index that's been tuned against real usage first. Sequencing them after the MVP avoids building
abstractions against imagined data.

## Relationship to existing prior art (short version)

- We are **not** inventing a new wire format for "file+line+revision → reasoning" — [Agent
  Trace](https://agent-trace.dev/) already exists as a multi-vendor RFC for that, and idea 01
  adopts it as (approximately) the record schema.
- We **are** solving the two things Agent Trace explicitly leaves open: a storage engine with a
  stable-identity model that survives git history rewrites, and a semantic query layer. Nobody in
  the landscape doc has both.
