# Idea 04: Conversational Blame / Repo Q&A

## Problem

Ideas 01–03 build a rich store of intent, sessions, and semantic search — but "rich store" isn't a
product, it's infrastructure. The actual moment of value is someone staring at a confusing function
and wanting a straight answer to "why is this here," "what was tried before this," or "is this
still needed." `git blame` gives you a commit SHA and an author. It doesn't give you an answer.

## Mechanism

A CLI surface (`git-for-ai ask`, `git-for-ai blame --why`, `git-for-ai log --intent`) that does
retrieval-augmented generation over the stack built by 01–03:

- `git-for-ai blame --why <file>:<line>` — resolves the line to its owning commit(s) via normal
  git blame, pulls the Semantic Commit Ledger entry (Idea 01) for that change-id, pulls the linked
  session summary (Idea 02) if one exists, and synthesizes a plain-language answer: what changed,
  why, what alternatives were considered, whether it's since been touched by later commits (chains
  of related change-ids, not just the single most recent blame hit).
- `git-for-ai ask "<question>"` — a general RAG query over the vector index (Idea 03), for
  questions that aren't anchored to one line, e.g. "why don't we use Redis here."
- `git-for-ai log --intent <path>` — like `git log` but annotated with the one-line intent summary
  per commit instead of (or alongside) the raw commit message, for a fast "what has actually
  happened to this area of the code and why" scan.

This is intentionally the *thinnest* layer in the whole system — no new storage, no new capture
mechanism, just retrieval + a synthesis prompt over data 01–03 already produced.

## Pros

- This is the feature a user actually asks for by name ("why is this here") — everything else is
  invisible plumbing in service of this.
- Because it's thin, it's cheap to build once 01–03 exist, and cheap to demo early even with a
  half-populated ledger (degrades gracefully to "here's the raw commit message" when no ledger
  entry exists for older history).
- Doubles as the natural place to surface *gaps* in the system honestly — e.g. "no captured intent
  for this commit, here's what git itself knows" rather than hallucinating a plausible-sounding
  reason.

## Cons / risks

- Answer quality is entirely bounded by how good 01–03's captured data is — this idea can't fix a
  thin or low-quality ledger, and shipping it before the ledger has real data risks the first
  impression being "the AI made something up," which is exactly the trust failure mode to avoid.
  Needs a visible confidence/provenance indicator (what data it actually drew from) on every answer.
- Retrofitting old history (commits made before git-for-ai existed) means most answers for
  legacy code will honestly be "no captured intent, inferring from diff + message only" — worth
  setting expectations rather than over-promising retroactive magic.

## Novelty vs. prior art

Nothing in the landscape doc offers a synthesized natural-language answer combining blame +
structured intent + session reasoning + related-commit chaining; the closest adjacent pieces are
git-ai's AI-aware `blame` (attribution only, no synthesis) and CodeRabbit's PR-level summaries
(scoped to a single PR, not full history).

## Effort estimate

Low-medium, contingent entirely on 01–03 being in place first. This is explicitly sequenced last.
