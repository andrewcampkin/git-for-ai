# Idea 06: Semantic Diff & Drift Detector (Roadmap)

## Problem

A textual diff tells you lines changed. It doesn't tell you whether the *documented intent* for
that code still matches what the code actually does. Over many commits, small individually-
reasonable changes can accumulate into a component that quietly no longer does what its ledger
entry (Idea 01) or knowledge-graph node (Idea 05) says it does — and nothing flags this, because
each individual commit looked fine in isolation.

## Mechanism

Using the vector index (Idea 03), periodically (or on-demand via `git-for-ai check-drift <path>`)
compare the embedding of a component's *current* code against the embedding of its *declared
intent* (from the ledger or knowledge-graph node). A growing distance between "what this claims to
do" and "what this embeds as actually doing" is a drift signal worth surfacing to a human — not as
an auto-fail gate, but as a prompt: "the auth module's embedding has drifted 40% from its last
recorded intent over the last 12 commits — does the ledger entry need updating, or did the code
quietly change behavior?"

This also enables a lighter-weight "conceptual diff" for review: instead of (or alongside) a line
diff, show what capability/behavior actually changed in a PR, by diffing the before/after
embeddings of the touched chunks and summarizing the delta in the same pass that generates the
ledger entry (Idea 01) for the commit.

## Pros

- Directly targets a failure mode that's specific to AI-assisted development: agents are good at
  making locally-reasonable changes that can still add up to global architectural erosion nobody
  notices, because no individual diff looked wrong.
- Reuses the embedding infrastructure from Idea 03 — no new storage engine needed, just a new
  comparison/alerting layer on top.
- The "conceptual diff" framing is also just a nicer PR review UX independent of drift-detection,
  giving this idea value even before drift-detection thresholds are tuned well.

## Cons / risks

- Threshold-tuning for "how much embedding distance is actually concerning" is an open research
  question — get it wrong and this is either noisy (alert fatigue, users disable it) or useless
  (never fires). Needs real usage data before committing to specific thresholds, hence roadmap not
  MVP.
- Risks false confidence: an embedding-distance metric measuring "conceptual drift" is a proxy, not
  ground truth — needs to be framed to users as a prompt to look, never as a verdict.
- CodeScene's "behavioral code analysis" is the closest existing product and it's mature/well-
  funded — worth evaluating directly as a build-vs-integrate decision before investing heavily
  here, rather than assuming we should build this from scratch.

## Novelty vs. prior art

The "Semantic Commit" paper ([arXiv 2504.09283](https://arxiv.org/html/2504.09283v1)) is the
closest direct precedent (knowledge-graph RAG to detect conflicts between changes and stated
intent specs) but is academic/prototype-stage, not a shipped tool. CodeScene is the closest shipped
product but targets technical-debt/hotspot risk, not intent-vs-behavior divergence specifically.
Nobody combines this with a locally-embedded, git-native intent ledger the way this would.

## Effort estimate

High, and explicitly not part of the MVP — needs Idea 03's embedding index mature and Idea 01's
ledger populated with real intent statements to compare against, plus real-world threshold tuning.
