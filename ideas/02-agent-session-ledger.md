# Idea 02: Agent Session Ledger

## Problem

The richest available source of "why" isn't a commit message a human dashes off after the fact —
it's the AI agent's actual plan and reasoning trail from the session that produced the change. But
today that context evaporates: Claude Code's session JSONL is unstable-format and deleted after 30
days by default; Cursor doesn't persist Composer sessions at all; Aider is the one honorable
exception (writes full chat to `.aider.chat.history.md`), but nobody links a session to a specific
commit via a resolvable, structured reference.

## Mechanism

Capture full agent session context automatically at commit time, using hooks that already exist:

1. A `PostToolUse` hook matching `Bash` + a filter on `git commit` (or, in Claude Code, ideally a
   dedicated event if one ships — see open feature requests) fires right as a commit is created.
2. At that moment, the hook has `session_id` and `transcript_path` available (every Claude Code
   hook payload carries these). It extracts the *relevant slice* of the session — not the whole
   multi-hour transcript, but the plan (captured separately via a `PostToolUse` hook on
   `ExitPlanMode`) plus the tool-call trail since the last commit — and normalizes it into an
   **OpenTelemetry GenAI semantic-convention** shaped record (spans for LLM calls / tool
   invocations / agent steps), since that's the closest thing to a portable, tool-agnostic trace
   format that already exists and that other agent tools (LangChain, CrewAI) already emit natively.
3. The normalized trace is content-addressed (hashed) and stored as a git object under a dedicated
   ref namespace, `refs/git-for-ai/sessions/<hash-prefix>/<hash>` — following git-annex's pattern of
   "bookkeeping lives in an ordinary git ref, bulk payload is content-addressed" rather than
   git-lfs's external-server pattern, since we want this to work with zero external services.
4. The Semantic Commit Ledger entry (Idea 01) for that commit gets a pointer field:
   `session_ref: <hash>` — the "resolvable session-id trailer" that research confirmed nobody has
   built yet.

## Pros

- Turns "why did the agent do this" from an unanswerable question (transcript already deleted) into
  a `git-for-ai show <commit>` command.
- OTel-GenAI shape means transcripts aren't a bespoke format — tooling that already speaks OTel
  (observability platforms, LangSmith/Langfuse via their OTel ingestion) could consume it too.
- Reuses existing Claude Code hook surface area — no new integration point needed for the MVP,
  just glue code.
- Degrades gracefully for human-only commits: no session, no session_ref, ledger entry just has a
  human-written intent summary instead (see Idea 01).

## Cons / risks

- Claude Code's transcript JSONL format is explicitly called out as internal/unstable — this
  capture mechanism will need updating as Claude Code evolves, and should not assume the current
  format is a stable contract.
- No dedicated plan-lifecycle event exists yet in Claude Code (only a `PostToolUse` match on the
  `ExitPlanMode` tool name), so plan capture is a workaround until/unless a first-class event ships.
- Session transcripts can be large and may contain sensitive content (file contents, credentials
  pasted into chat, etc.) — needs a redaction/opt-out story before this is safe to push to a shared
  remote (see architecture spec, §Privacy).
- Only captures Claude Code sessions in the MVP; other agents (Aider, Cursor, Copilot Workspace)
  would need their own adapters, and two (Cursor, Copilot Workspace) don't expose session data to
  the filesystem at all today.

## Novelty vs. prior art

`.aider.chat.history.md` is the only existing example of "session context lives in the repo," but
it's an unstructured markdown dump with no per-commit linkage. `ai-trailers` captures prompts but
not full reasoning/tool-call trails, and stores them as trailer text, not as a queryable object.
Nothing found captures a structured, replayable session trace and links it to a commit via a
resolvable reference.

## Effort estimate

Medium-high. The hook wiring is straightforward; the harder work is defining what to extract from
a raw transcript (all of it? just the plan + final tool calls?) and building redaction defaults
that make this safe to turn on without a privacy review each time.
