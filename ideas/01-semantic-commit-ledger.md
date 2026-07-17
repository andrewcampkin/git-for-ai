# Idea 01: Semantic Commit Ledger

## Problem

Git durably stores *what* changed (a snapshot diff). It does not durably store *why* — the
reasoning, the constraints, the alternatives considered, the plan that was executed. Every
existing attempt to bolt this on (commit messages, PR descriptions, `Co-authored-by` trailers)
either gets lost at squash-merge time, lives in a platform database that's discarded on export, or
is free text with no stable identity to key off of.

## Mechanism

A **Semantic Commit Ledger**: a structured JSON record per logical change, modeled closely on the
[Agent Trace](https://agent-trace.dev/) schema (file/line-range/revision → reasoning record), and
attached to the commit via **git notes** under a dedicated namespace (`refs/notes/git-for-ai/intent`),
not via commit message trailers — trailers mutate the message (and therefore the hash) and can't
hold arbitrary-sized structured data cleanly.

The record is keyed by a **stable change-id**, not the commit SHA, using a hybrid of the two
approaches research turned up:

- **Primary**: an external mapping table (jj-style) maintained in a dedicated git ref
  (`refs/git-for-ai/change-map`, itself an ordinary git object so it syncs via normal push/fetch —
  avoiding jj's actual weakness, which is that its table lives *outside* git entirely).
- **Fallback**: a `Change-Id`-style trailer written into the commit message at first-commit time,
  for interoperability with tools (or humans) that never installed our tooling, and as a recovery
  path if the change-map ref is ever lost or the repo is cloned by someone without git-for-ai
  hooks installed.

A `post-rewrite` hook migrates ledger entries on amend/rebase/squash (handling the documented
many-old-SHA-to-one-new-SHA case for squashes). Because `post-rewrite` is *not* fired for
cherry-pick or `filter-branch`/`filter-repo`, the change-id trailer is the fallback identity that
lets the ledger entry be re-associated even when the hook doesn't fire — see
[architecture spec, §Identity](../architecture/ARCHITECTURE.md) for the exact resolution algorithm.

## Pros

- Doesn't touch git's object model or fork git — pure notes + refs + hooks, all standard plumbing.
- Notes ref syncs like any git ref once configured — no new server, no new protocol.
- Solves the one problem no existing tool in the landscape doc solves well: metadata that reliably
  survives the *full* set of history-rewriting operations, not just amend/rebase.
- Interoperates with Agent Trace rather than competing with it, which matters if we later want
  external tools (editors, CI, review bots) to read our data.

## Cons / risks

- Notes-based merge conflicts are real when two people amend the same logical change on different
  branches; needs a defined merge strategy (likely `cat_sort_uniq`-style, append-only entries
  rather than mutation, à la git-appraise) rather than "resolve manually" as the default UX.
- Requires every contributor to have the hooks installed for full fidelity; degrades gracefully
  (fallback trailer) but not silently — a repo without git-for-ai installed just has no ledger.
- Adds a second concept of identity (change-id vs. commit SHA) that every command and every user
  needs to understand, at least a little.

## Novelty vs. prior art

Closest analogs: Gerrit Change-Id (identity only, no rich payload), git-ai (notes-based, but for
line attribution not reasoning), git-appraise (notes-based structured JSON, but for code review
state not intent), Jujutsu (best identity model, but external to git). Nobody combines "stable
identity + rich structured payload + full git-native sync" the way this does.

## Effort estimate

Medium. The hook plumbing and merge-strategy design are the hard parts; the record schema itself
can start as a near-direct port of Agent Trace's shape.
