# git-for-ai — Data Model Reference

Companion to [`ARCHITECTURE.md`](./ARCHITECTURE.md). This file is the exhaustive, field-level
definition of every record type, its on-disk/in-git encoding, canonicalization rules, and worked
examples. `ARCHITECTURE.md` §6 gives the summary shapes; this file is the authority on the details.

All records are JSON. All timestamps are RFC 3339 UTC (`Z`). All hashes are lowercase hex. Every
record carries a `schema` field of the form `git-for-ai/<type>@<major>`; consumers must reject a
record whose major version they don't understand rather than guess.

---

## 1. Change-id

- **Type:** opaque 128-bit identifier.
- **Encoding:** 32 lowercase hex characters, e.g. `9f2c1a7b6e4d0f83c5a1b2d3e4f50617`.
- **Generation:** cryptographically-random at first commit (never content-derived — see
  ARCHITECTURE §7.7). Adopted from an existing `Change-Id`/Gerrit trailer when present.
- **Trailer form:** in a commit message, rendered as `Change-Id: I9f2c1a7b6e4d0f83c5a1b2d3e4f50617`
  (leading `I` for Gerrit visual parity; the `I` is not part of the canonical id).
- **`c/` reference form:** where a field may hold either a commit SHA or a change-id (e.g.
  `reasoning.related`), a change-id is prefixed `c/` to disambiguate: `c/9f2c1a7b...`.

---

## 2. Ledger entry

Stored in git notes under `refs/notes/git-for-ai/intent`, attached to the commit object. The note
body is an append-only entry log (see §2.4 on why append-only).

### 2.1 Note body wire format

**Current format (`ledger-note@2`, JSONL — the 2026-07-18 W3 decision):** the note body is one
line per entry, each line a *canonical* JSON object (keys sorted at every level, no insignificant
whitespace — the same canonicalization as §3.1):

```jsonc
{"change_id":"9f2c1a7b…","entry":{ /* one ledger-entry object */ },"schema":"git-for-ai/ledger-note@2"}
{"change_id":"9f2c1a7b…","entry":{ /* a later entry */ },"schema":"git-for-ai/ledger-note@2"}
```

Every line is an independently-valid record carrying the note's anchoring (schema tag +
change-id), so the line-oriented `cat_sort_uniq` notes-merge is conflict-free *by construction*:
cat/sort/uniq of two divergently-appended notes yields the union of their entry lines, canonical
serialization makes identical entries byte-identical (so `uniq` dedupes rather than duplicates),
and line order is meaningless — readers order entries by `created_at`.

**Legacy format (`ledger-note@1`):** the whole note body is one pretty-printed JSON envelope —
`{ "schema": "git-for-ai/ledger-note@1", "change_id": …, "entries": [ … ] }`. Readers MUST accept
both formats; writers MUST emit only `@2`. A legacy note is migrated opportunistically the next
time an entry is appended to it (never via a mass rewrite; reads never write).

### 2.2 Ledger entry object — field by field

| Field | Type | Req | Description |
|---|---|---|---|
| `schema` | string | yes | `git-for-ai/ledger-entry@1`. |
| `change_id` | hex(32) | yes | Stable identity. Matches the enclosing note envelope. |
| `revision` | hex(40) | yes | Commit SHA this entry was authored against (the SHA at write time). |
| `created_at` | rfc3339 | yes | When this entry was written. Primary sort key for "effective entry". |
| `author` | object | yes | See §2.3. Who/what produced the change. |
| `scope` | array\<ScopeItem> | yes | Agent-Trace-shaped file/line-range/blob list this change touched. |
| `summary` | string | yes | One-line human-readable "what changed". Used by `log --intent`. |
| `reasoning` | object | no | Lore-vocabulary "why" payload. See §2.5. Absent for thin/human commits. |
| `session_ref` | string\|null | no | `sha256:<hash>` pointer into the sessions ref, or `null`. |
| `session_refs` | array\<string> | no | Present only after a squash fold: all absorbed session pointers. |
| `provenance` | enum | yes | `agent-captured` \| `human-authored` \| `inferred`. |
| `folded_into` | hex(32) | no | Present on an absorbed entry after a squash; points at the surviving change-id. |
| `redaction_note` | string | no | Present if the linked session was dropped (e.g. fail-closed redaction). |

#### ScopeItem

| Field | Type | Req | Description |
|---|---|---|---|
| `path` | string | yes | Repo-relative POSIX path. |
| `range` | [int, int] | no | 1-based inclusive `[start_line, end_line]`. Absent = whole file. |
| `blob` | hex(40) | yes | Git blob SHA of the file version this range refers to (ties scope to content). |

### 2.3 `author` object

| Field | Type | Req | Description |
|---|---|---|---|
| `type` | enum | yes | `agent` \| `human` \| `mixed`. |
| `tool` | string | no | e.g. `claude-code`. Absent for pure-human. |
| `model` | string | no | e.g. `claude-opus-4-8`. |
| `human` | string | no | The human on the keyboard (email/handle), e.g. `andrewcampkin@gmail.com`. |

### 2.4 Why `entries` is an append-only array

A note is modeled as an append log, not a mutable document (git-appraise's insight). A correction to
intent is a *new* entry appended with a later `created_at`, never an in-place edit. This makes the
`cat_sort_uniq` notes-merge strategy conflict-free by construction (ARCHITECTURE §12.2): with the
§2.1 JSONL format, two divergent branches each appended distinct canonical-JSON lines, and union
merge keeps both.

**Effective-entry resolution** (what a reader treats as "the" intent for a change): the entry with
the newest `created_at`; ties broken by `(author.human, revision, sha256(entry))` lexicographic
order, so every machine picks the same effective entry deterministically. Superseded entries are
retained and viewable with `git for-ai show <change> --history`.

### 2.5 `reasoning` block (Lore vocabulary) {#reasoning-block}

| Field | Type | Description |
|---|---|---|
| `intent` | string | The goal — what outcome the change is trying to achieve. |
| `constraints` | array\<string> | Hard requirements the change had to respect. |
| `rejected` | array\<{option, why}> | Alternatives considered and *why they were rejected*. High-value for `ask`. |
| `confidence` | float 0..1 | Agent/author confidence in the approach. |
| `scope_risk` | enum | `low` \| `medium` \| `high` — blast radius of the change. |
| `reversibility` | enum | `easy` \| `moderate` \| `hard` — how hard to undo. |
| `directive` | string | The originating instruction/prompt, if captured (redacted). |
| `tested` | array\<string> | How it was verified (commands run, manual checks). |
| `related` | array\<string> | Related commit SHAs or `c/`-prefixed change-ids. |

All `reasoning` fields are optional; a sparse block is valid. `rejected` and `intent` are the two
that most improve `ask`/`blame` answers and should be populated whenever the session provides them.

### 2.6 Worked example

```jsonc
{
  "schema": "git-for-ai/ledger-note@1",
  "change_id": "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
  "entries": [
    {
      "schema": "git-for-ai/ledger-entry@1",
      "change_id": "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
      "revision": "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
      "created_at": "2026-07-17T09:22:41Z",
      "author": { "type": "agent", "tool": "claude-code", "model": "claude-opus-4-8",
                  "human": "andrewcampkin@gmail.com" },
      "scope": [
        { "path": "src/auth/session.rs", "range": [40, 118], "blob": "af19c2b7e0d1f2a3b4c5d6e7f8091a2b3c4d5e6f" }
      ],
      "summary": "Switch session store from in-proc map to signed-cookie tokens.",
      "reasoning": {
        "intent": "Make auth stateless so the API can run >1 replica without sticky sessions.",
        "constraints": ["must not break existing /login clients", "no new infra services"],
        "rejected": [
          { "option": "Redis session store", "why": "adds an infra dependency we explicitly want to avoid" }
        ],
        "confidence": 0.82,
        "scope_risk": "medium",
        "reversibility": "easy",
        "directive": "make auth work across multiple replicas",
        "tested": ["cargo test auth::", "manual: login/logout round-trip"],
        "related": ["3d1f0a2b4c6d8e0f1a2b3c4d5e6f7081", "c/7a2b9c0d1e2f3a4b5c6d7e8f9012a3b4"]
      },
      "session_ref": "sha256:1f4e9caa77bb33cc22dd11ee00ff9988aabbccddeeff00112233445566778899",
      "provenance": "agent-captured"
    }
  ]
}
```

---

## 3. Session record

Content-addressed and stored as a git blob reachable from `refs/git-for-ai/sessions/<aa>/<hash>`
(sharded by first hash byte). Shape follows OpenTelemetry GenAI semantic conventions so external
OTel-aware tooling can consume it.

### 3.1 Content addressing / canonicalization

The `session_ref` is `sha256:` + the hex sha256 of the **canonical serialization** of the record:
UTF-8, JSON with keys sorted lexicographically at every level, no insignificant whitespace, arrays
in their meaningful order (spans in temporal order). Canonicalization is what makes the hash stable
across machines and re-serializations — two captures of identical content produce the same hash and
therefore the same git object (no duplicate, no merge). The hash is computed over the record
**after** redaction, so it reflects exactly what is stored.

### 3.2 Session record — field by field

| Field | Type | Req | Description |
|---|---|---|---|
| `schema` | string | yes | `git-for-ai/session@1`. |
| `session_id` | string | yes | Claude Code `session_id` (join key back to the originating session). |
| `agent` | object | yes | `{ tool, version, model }`. |
| `captured_at` | rfc3339 | yes | When capture ran. |
| `commit_range` | object | yes | `{ since, until }` commit SHAs — the slice this trace covers. |
| `redaction` | object | yes | `{ applied: bool, rules: [string], redacted_count: int, truncated_count: int }`. |
| `source_fingerprint` | string | yes | Fingerprint of the transcript-format adapter used (for future re-parse audits). |
| `spans` | array\<Span> | yes | Temporally-ordered OTel-GenAI spans. See §3.3. |
| `summary` | string | no | Compressed representation used for embedding (ARCHITECTURE §11.1). |

### 3.3 Span object (OTel-GenAI-shaped)

| Field | Type | Req | Description |
|---|---|---|---|
| `span_id` | string | yes | Unique within the record. |
| `parent_id` | string | no | Parent span for nested structure. |
| `kind` | enum | yes | `agent.plan` \| `gen_ai.completion` \| `gen_ai.tool.execution` \| `agent.step`. |
| `name` | string | no | e.g. tool name (`Edit`, `Bash`). |
| `start` / `end` | rfc3339 | no | Span timing when available from the transcript. |
| `attributes` | object | no | OTel-style key/values (e.g. `{ "file": "src/auth/session.rs" }`). |
| `body` | object | no | Kind-specific payload: `plan` text, `text` of a model turn (redacted), `diff_summary`. |

Span `body` model turns store a **redacted or summarized** representation, not raw verbatim model
output, to bound size and reduce leak surface. The plan span (`agent.plan`) carries the full plan
text from `ExitPlanMode` (redacted).

### 3.4 Worked example

```jsonc
{
  "schema": "git-for-ai/session@1",
  "session_id": "b1e2c3d4-5678-90ab-cdef-1234567890ab",
  "agent": { "tool": "claude-code", "version": "2.x", "model": "claude-opus-4-8" },
  "captured_at": "2026-07-17T09:22:41Z",
  "commit_range": { "since": "a1b2c3d4e5f60718293a4b5c6d7e8f9001122334",
                    "until": "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70" },
  "redaction": { "applied": true, "rules": ["aws-key", "generic-token"],
                 "redacted_count": 3, "truncated_count": 0 },
  "source_fingerprint": "claude-code-jsonl/2026.07",
  "spans": [
    { "span_id": "s1", "kind": "agent.plan", "start": "2026-07-17T09:05:00Z", "end": "2026-07-17T09:05:02Z",
      "body": { "plan": "1. Extract session logic into session.rs\n2. Replace in-proc map with signed cookie\n3. Add tests" } },
    { "span_id": "s2", "parent_id": "s1", "kind": "gen_ai.tool.execution", "name": "Edit",
      "attributes": { "file": "src/auth/session.rs" }, "body": { "diff_summary": "replace HashMap store with cookie codec" } },
    { "span_id": "s3", "parent_id": "s1", "kind": "gen_ai.tool.execution", "name": "Bash",
      "attributes": { "command": "cargo test auth::" }, "body": { "exit": 0 } },
    { "span_id": "s4", "kind": "gen_ai.completion",
      "body": { "text": "Chose signed cookies over Redis to avoid a new infra dependency «redacted:generic-token»" } }
  ],
  "summary": "Agent refactored auth to stateless signed-cookie sessions; rejected Redis to avoid infra dep; tests pass."
}
```

---

## 4. Change-map

Stored under `refs/git-for-ai/change-map`, which points at a **tree** (not a single blob). The table
is sharded into files by change-id prefix so concurrent edits to different changes touch different
files.

### 4.1 On-disk (in-tree) layout

```
change-map/                      # the tree the ref points at
├── 9f/2c1a7b6e4d0f83c5a1b2d3e4f50617.json     # one file per change-id, sharded by first 2 hex
├── 3d/1f0a2b4c6d8e0f1a2b3c4d5e6f70819a.json
└── ...
```

Sharding by the first byte (`9f/`) keeps any one directory tree small and, crucially, makes
multi-user merges local: two people editing two different changes never write the same file, so
git merges them without conflict (ARCHITECTURE §12.2).

### 4.2 Change-map entry — field by field

| Field | Type | Req | Description |
|---|---|---|---|
| `schema` | string | yes | `git-for-ai/change-map-entry@1`. |
| `change_id` | hex(32) | yes | The stable id (also encoded in the filename). |
| `head` | hex(40) | yes | Current commit SHA for this change. |
| `history` | array\<hex(40)> | yes | Every SHA this change has had, oldest first, `head` last. |
| `trailer_seen` | bool | yes | Whether a `Change-Id` trailer exists in the commit message (recovery hint). |
| `origin` | enum | yes | How the entry was created: `post-commit` \| `post-rewrite` \| `trailer-recovery` \| `inferred` \| `orphan-recovery` \| `rebuild-map`. |
| `folded_into` | hex(32) | no | If this change was absorbed by a squash, the surviving change-id. |
| `absorbed` | array\<hex(32)> | no | On a surviving change, the change-ids it absorbed via squash. |
| `divergent_heads` | array\<hex(40)> | no | Multi-user only: unreconciled competing heads (§4.3). |
| `updated_at` | rfc3339 | yes | Last modification. |

### 4.3 Merge semantics (custom 3-way driver)

When two clones both modified the same change file:

1. **`history`** — union both lists, preserve order by first-appearance, dedupe.
2. **`head`** — if one side's `head` is a git-descendant of the other's, take the descendant. If
   neither descends from the other, record **both** under `divergent_heads` and leave `head` at the
   lexicographically-lower SHA as a deterministic placeholder; `doctor` surfaces the divergence and
   `reconcile`/`relink` resolves it (v1.1 UX).
3. **`absorbed` / `folded_into`** — union; a change absorbed on either side stays absorbed.
4. **`trailer_seen`** — logical OR.

This is the one place git-for-ai owns merge logic itself (git-bug-style), because notes'
`cat_sort_uniq` can't express "pick the descendant head."

### 4.4 Worked example

```jsonc
{
  "schema": "git-for-ai/change-map-entry@1",
  "change_id": "9f2c1a7b6e4d0f83c5a1b2d3e4f50617",
  "head": "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70",
  "history": [
    "a0f1c2d3e4f5061728394a5b6c7d8e9f00112233",   // first commit
    "3d4e5f60718293a4b5c6d7e8f9001122334455667",   // after amend
    "b7c3e2a1d9f8c0b4a6e5d7f9081a2b3c4d5e6f70"      // current head, after rebase
  ],
  "trailer_seen": true,
  "origin": "post-rewrite",
  "updated_at": "2026-07-17T09:40:12Z"
}
```

---

## 5. Repo config (`.git-for-ai/config.toml`)

Local, not synced (it can hold provider choices and per-machine paths). Illustrative:

```toml
schema = "git-for-ai/config@1"

[embedder]
provider = "jina-v2-code"      # jina-v2-code | nomic-embed-code | voyage-code-3
dim = 768
offline = true                 # false only for API providers
voyage_consent = false         # must be explicitly set true to enable voyage (§14.14 of ARCHITECTURE)

[capture]
enabled = true                 # set by `init`; the per-repo opt-in switch
never_capture = [".env*", "*.pem", "*secrets*", "id_rsa*", "*.key"]
max_span_bytes = 16384

[redaction]
ruleset = "builtin@1"
extra_patterns = []            # user-added regexes

[index]
hybrid = true                  # keyword FTS5 + vector (recommended default)
```

### 5.1 `state.json` (index bookkeeping)

```jsonc
{
  "schema": "git-for-ai/index-state@1",
  "last_indexed_commit": "b7c3e2a1d9f8...",
  "model_fingerprint": "jina-v2-code/768",     // provider id + dim; change ⇒ reindex --full
  "vec_schema_version": 1,
  "chunk_count": 1284,
  "updated_at": "2026-07-17T09:41:00Z"
}
```

---

## 6. Versioning and compatibility rules

- Every record's `schema` is `git-for-ai/<type>@<major>`. A consumer MUST reject a record whose
  major it does not implement (fail loud, don't silently mis-read).
- Minor/additive fields are added without bumping major; unknown fields MUST be ignored by readers
  (forward-compat), never dropped on rewrite (so an old client round-tripping a note doesn't strip a
  newer client's fields — writers preserve unknown keys).
- The `Change-Id` trailer format is frozen at `Change-Id: I<32hex>` for portability; it never gets a
  version suffix (it must remain parseable by non-git-for-ai tooling, including Gerrit).

---

*End of DATA_MODEL.md. Back to [`ARCHITECTURE.md`](./ARCHITECTURE.md).*
