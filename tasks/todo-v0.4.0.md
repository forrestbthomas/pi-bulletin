# Task List — v0.4.0 Durable & precise conflict core

Specs: `docs/specs/durability-hardening.md` (H1),
       `docs/specs/conflict-supersession.md` (H2 + M4)
Plan: `tasks/plan-v0.4.0.md`

## Phase 1: Durability (foundation)

### Task 1: Atomic write + fsync helpers + torn-tail recovery

**Description:** In `src/store.ts`, add `fsyncFile(path)` and
`writeFileAtomic(path, data)` (temp file → fsync → rename → dir fsync).
Make `readEvents` torn-tail tolerant: on an unparseable trailing line, log
a warning to stderr, truncate the file to the last good line, and return
the good events — never throw.

**Acceptance criteria:**
- [ ] `readEvents` on a fixture with N valid lines + partial tail returns N
      events, prints one warning, truncates the file
- [ ] `writeFileAtomic` never leaves a half-written file at `path` (crash
      injection test: failure before rename keeps previous content)
- [ ] Empty / no-trailing-newline files → no warning, empty result

**Verification:**
- [ ] `npm test` (new durability tests pass)
- [ ] `npm run typecheck`

**Dependencies:** None

**Files likely touched:**
- `src/store.ts`
- `src/store.test.ts` (or `src/durability.test.ts`)

**Estimated scope:** Medium (1-2 files)

### Task 2: fsync/atomic call sites

**Description:** Call the helpers in the write paths: `postEvent` (fsync
events.jsonl after append), `postDigest` (fsync events.jsonl + atomic
state.json), `markRead` (best-effort fsync watermarks.json), `compact`
(fsync archive append, then atomic replace of events.jsonl).

**Acceptance criteria:**
- [ ] Append → fsync order in `postEvent` (spy-verified)
- [ ] `state.json` written via `writeFileAtomic`
- [ ] `compact` replaces live log atomically; failure between archive and
      replace leaves original live log intact

**Verification:**
- [ ] `npm test` (fs-call spies pass)
- [ ] `npm run typecheck`

**Dependencies:** Task 1

**Files likely touched:**
- `src/store.ts`

**Estimated scope:** Small (1 file)

### Task 3: Durability tests

**Description:** Hermetic `PI_BULLETIN_ROOT` fixtures covering torn tail,
atomic state commit crash injection, compaction atomicity, backward
compatibility with a pre-existing JSONL root, and the seq invariant.

**Acceptance criteria:**
- [ ] All durability acceptance criteria in the spec covered by tests
- [ ] Backward-compat test: existing root reads identically before/after

**Verification:**
- [ ] `npm test`

**Dependencies:** Tasks 1-2

**Files likely touched:**
- `src/store.test.ts` (or `src/durability.test.ts`)

**Estimated scope:** Medium (1 file)

## Checkpoint: Durability

- [ ] Torn-tail fixture recovers with a warning, no throw
- [ ] Atomic state commit survives crash injection
- [ ] `npm test` green

## Phase 2: Conflict supersession (core)

### Task 4: Canonicalization helpers

**Description:** Add `canonRef` (trim + lower-case) and `canonValue`
(trim; collapse whitespace; numeric compare when both parse; else exact
string). Conservative — no stemming or synonyms.

**Acceptance criteria:**
- [ ] `ref:"API"` ≡ `ref:"api"`; `value:" v2 "` ≡ `value:"v2"`;
      `value:"42"` ≡ `value:42` (numeric); `"v2"` ≢ `"v2.0"`
- [ ] Unit tests pin each rule

**Verification:**
- [ ] `npm test`

**Dependencies:** None

**Files likely touched:**
- `src/store.ts`
- `src/store.test.ts`

**Estimated scope:** Small (2 files)

### Task 5: `findConflictsSince` upgrade

**Description:** Track per-ref `{author, seq, value, status,
evidenceCount}`; classify same-author later value as `kind:"update"`;
classify cross-author divergence by tier (hard/medium/soft); count
corroboration (distinct authors, same canonical value); honor resolutions
(+ `supersedes` marking); recency tiebreak only on ties, conflict still
reported. Extend the output shape additively.

**Acceptance criteria:**
- [ ] Same-author update → `kind:"update"`, no tier
- [ ] Cross-author divergence → correct tier (soft/medium/hard)
- [ ] Corroboration increments evidenceCount, no conflict
- [ ] Resolution stops re-flagging; losing seq marked `superseded`
- [ ] Tiebreak on ties only; conflict still reported on ties
- [ ] Legacy events (no status) → treated as `proposed`; no throw

**Verification:**
- [ ] `npm test` (all conflict scenarios)
- [ ] `npm run typecheck`

**Dependencies:** Task 4

**Files likely touched:**
- `src/store.ts`
- `src/store.test.ts`

**Estimated scope:** Medium (2 files)

### Task 6: Extension surface

**Description:** In `extensions/index.ts`: `bulletin_post` accepts optional
`status` (validated enum proposed/confirmed/contested/superseded);
`bulletin_resolve` accepts optional `decisionEvidence`/`supersedes`.
Invalid status → tool error, no event written.

**Acceptance criteria:**
- [ ] Status validated; invalid rejected before write
- [ ] `bulletin_conflicts` returns the richer shape with defaults for
      legacy events

**Verification:**
- [ ] `npm test` (extension tests)
- [ ] `npm run typecheck`

**Dependencies:** Task 5

**Files likely touched:**
- `extensions/index.ts`
- `extensions/index.test.ts` (if present)

**Estimated scope:** Small (2 files)

### Task 7: Conflict tests

**Description:** Cover every acceptance scenario in the conflict spec:
dedupe FP removal, update-vs-conflict, tiers, corroboration, resolution
audit, tiebreak, backward compat, zero-LLM guard (no network calls in the
conflict path).

**Acceptance criteria:**
- [ ] All spec acceptance criteria covered by tests
- [ ] Zero-LLM guard test present

**Verification:**
- [ ] `npm test`

**Dependencies:** Tasks 5-6

**Files likely touched:**
- `src/store.test.ts`
- `extensions/index.test.ts`

**Estimated scope:** Medium (1-2 files)

## Checkpoint: Conflicts

- [ ] Dedupe FP removed; update not a conflict; tiers correct
- [ ] Resolution stops re-flagging; losing claim preserved
- [ ] `npm test` + `npm run typecheck` green

## Phase 3: Polish

### Task 8: Docs

**Description:** `skills/bulletin.md` — status vocabulary
(proposed/confirmed/contested/superseded), how to corroborate a finding
(post same canonical value), and how to read `bulletin_conflicts` output
(tiers; resolve cheaply in the digest, escalate hard ties). `README.md`
mention of the durability guarantees.

**Acceptance criteria:**
- [ ] Status vocabulary documented
- [ ] Conflict-reading guidance documented
- [ ] README notes durability guarantees

**Verification:**
- [ ] Docs read cleanly

**Dependencies:** Tasks 5-6

**Files likely touched:**
- `skills/bulletin.md`
- `README.md`

**Estimated scope:** Small (2 files)

### Task 9: Manual end-to-end verification

**Description:** Two-role dryrun: agents post conflicting confirmed signals
on one ref; run `bulletin_conflicts` (verify tier + authors); resolve;
re-scan clean; confirm losing claim still visible in `events.jsonl`.

**Acceptance criteria:**
- [ ] Conflict surfaced with correct tier and authors
- [ ] After resolve, re-scan is clean and the losing claim is still in the
      log
- [ ] No LLM calls on the conflict path (observe tool calls)

**Verification:**
- [ ] Observed in a live dryrun

**Dependencies:** Tasks 6-8

**Files likely touched:** none (manual)

**Estimated scope:** XS

### Task 10: Full-suite verification

**Description:** Run the complete verification set for both specs.

**Acceptance criteria:**
- [ ] All spec acceptance criteria met
- [ ] Repo ready for review / commit / tag

**Verification:**
- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] Python watchdog tests still pass (`python3
      scripts/test_bulletin_watchdog.py`)

**Dependencies:** Task 9

**Files likely touched:** none

**Estimated scope:** XS

## Checkpoint: Complete

- [ ] All acceptance criteria in both specs met
- [ ] Ready for review / commit / tag
