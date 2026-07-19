# Idea 05: Intent Knowledge Graph (Roadmap)

## Problem

A ledger (Idea 01) is append-only by nature — every commit adds an entry, nothing ever
consolidates. Over months, the same architectural decision gets re-explained a dozen times, old
rationale contradicts new rationale with nothing flagging the conflict, and there's no single
place that represents "here's the current understanding of the auth subsystem" — only a long
scroll of historical entries a human or an agent has to reconstruct meaning from every time.

## Mechanism

A durable graph, separate from (but derived from) the ledger: nodes are concepts/decisions/
components ("auth flow," "why we don't use Redis," "the payments retry policy"), edges connect
nodes to the commits/ledger entries that created, modified, or superseded them. A periodic
consolidation pass (agent-driven, analogous to the `consolidate-memory` pattern: merge duplicate
nodes, mark stale ones, flag direct contradictions between an old node's rationale and a new
commit's stated intent) keeps the graph as a living summary rather than an ever-growing pile.

This is deliberately modeled after the same shape as this very Claude Code session's own memory
system (`MEMORY.md` + per-topic files with frontmatter, linked via `[[name]]` references, with
periodic consolidation) — the pattern already works for "durable, cross-session, non-code-derived
understanding," and a repo's architectural intent has the same shape as a user's preferences: it
decays, it needs pruning, and duplicates need merging rather than infinite accumulation.

## Pros

- Solves the "ledger becomes an unread graveyard" failure mode that pure append-only logging (Idea
  01 alone) is prone to over a long-lived repo.
- Gives `git-for-ai ask` (Idea 04) a much higher-quality thing to retrieve from than raw historical
  entries — a maintained node beats re-synthesizing from ten scattered commits every time.
- The consolidation pass is a natural place to surface genuine architectural drift to a human (see
  Idea 06) — "this decision's rationale hasn't been touched in 8 months but the code around it has
  changed 40 times since."

## Cons / risks

- This is the idea most dependent on having real, populated data first — building graph
  consolidation logic against a nearly-empty ledger means designing against imagined data, which
  is explicitly the trap to avoid. Correctly sequenced as v2, after 01/02 have real usage.
  history, and edge cases (e.g. what does "merge" even mean for two contradictory rationales) are
  genuinely unclear without real examples in hand.
- Consolidation quality depends on a summarization/merge step that itself needs a capable model —
  cost and latency of periodic re-consolidation on a large repo needs benchmarking before
  committing to a design.

## Novelty vs. prior art

No project in the landscape doc attempts consolidation/decay at all — every "intent-adjacent" tool
found (Agent Trace, git-ai, Lore, ai-trailers) is purely additive/append-only. This is the piece
with no existing analog in the source-control space, though the general pattern (living memory
with merge/decay) is well-established in AI-agent-memory literature outside of VCS.

## Effort estimate

High, and explicitly not part of the MVP. Revisit once the ledger has months of real entries.
