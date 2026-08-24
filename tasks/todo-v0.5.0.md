# Task List — v0.5.0 Auditable digest rounds

Spec: `docs/specs/auditable-digest-rounds.md` (H3 + M1 + M3)
Plan: `tasks/plan-v0.5.0.md`

## Phase 1: Store (foundation)

### Task 1: Types + postDigest fencing/validation/coverage

**Description:** In `src/store.ts`: add `DigestItem` interface; extend
`DigestState` with `round`, `lead`, `coverageFrom`, `coverageTo`; extend
`postDigest(team, from, digest, members, opts?)` with `opts.round`,
`opts.decisions`, `opts.findings`, `opts.open`. Enforce: first digest sets
lead + round 1; non-lead writes rejected; `opts.round` must equal
`state.round + 1` (stale retry rejected with expected round); evidence seqs
validated as positive integers ≤ seq high-watermark (reject naming bad
seqs); `coverageTo` = last live event seq, `coverageFrom` = previous digest
seq (0 first). Digest event data gains round/decisions/findings/open/
coverageFrom/coverageTo.

**Acceptance criteria:**
- [ ] `postDigest` with structured sections stores them on event + state
- [ ] Non-lead write throws; stale round throws with expected round in message
- [ ] Evidence seq beyond high-watermark throws naming the seq
- [ ] Coverage fields derived correctly (first digest: from 0, to last seq)
- [ ] Legacy 4-arg calls still work

**Verification:**
- [ ] `npm test`

**Dependencies:** None

**Files likely touched:**
- `src/store.ts`

**Estimated scope:** Medium (1 file)

### Task 2: replayState

**Description:** Add `replayState(team): DigestState | null` that reads
`digests.jsonl`, takes the last digest event, and rebuilds the latest state
(round/lead/coverage/sections from the event; members/digest defaults for
legacy events). Never reads `state.json`.

**Acceptance criteria:**
- [ ] After 2 digests, `replayState` equals `readState`
- [ ] Works when `state.json` is deleted/corrupt
- [ ] Legacy digest event (no round/sections) replays with defaults, no throw

**Verification:**
- [ ] `npm test`

**Dependencies:** Task 1

**Files likely touched:**
- `src/store.ts`

**Estimated scope:** Small (1 file)

### Task 3: Store tests

**Description:** Cover the spec's acceptance criteria: structured storage,
lead fencing, round fencing (stale retry), provenance validation (bad vs
valid evidence), coverage derivation, replay equality + corrupt-state
recovery, backward compat with legacy roots, zero-LLM guard (fetch never
called on the digest path).

**Acceptance criteria:**
- [ ] All store acceptance criteria covered by tests
- [ ] Zero-LLM guard test present

**Verification:**
- [ ] `npm test`

**Dependencies:** Tasks 1-2

**Files likely touched:**
- `src/store.test.ts`

**Estimated scope:** Medium (1 file)

## Checkpoint: Store

- [ ] Fencing tests pass (non-lead, stale round)
- [ ] Evidence validation errors name the bad seq
- [ ] `replayState` matches `readState`; legacy digests replay with defaults
- [ ] `npm test` green

## Phase 2: Extension surface

### Task 4: Extension tools

**Description:** In `extensions/index.ts`: `bulletin_sync` gains optional
`round`, `decisions`, `findings`, `open` (arrays of `{ref, text, status?,
evidence?}`); `bulletin_resolve` gains optional `rationale`; `bulletin_status`
shows round/lead/coverageFrom/coverageTo.

**Acceptance criteria:**
- [ ] `bulletin_sync` stores structured sections + round
- [ ] `bulletin_resolve` stores rationale
- [ ] `bulletin_status` renders round/lead/coverage

**Verification:**
- [ ] `npm test`
- [ ] `npm run typecheck`

**Dependencies:** Task 1

**Files likely touched:**
- `extensions/index.ts`

**Estimated scope:** Medium (1 file)

### Task 5: Extension tests

**Description:** Extend `extensions/index.test.ts`: sync with sections +
round through the tool path; resolve with rationale; status shows
round/lead; non-lead sync errors propagate as a tool error.

**Acceptance criteria:**
- [ ] Tool-path tests for the new params pass
- [ ] Existing registration tests stay green

**Verification:**
- [ ] `npm test`

**Dependencies:** Task 4

**Files likely touched:**
- `extensions/index.test.ts`

**Estimated scope:** Small (1 file)

## Checkpoint: Extension

- [ ] `bulletin_sync` accepts decisions/findings/open and stores them
- [ ] `bulletin_resolve` stores rationale
- [ ] `bulletin_status` shows round/lead/coverage
- [ ] `npm test` + `npm run typecheck` green

## Phase 3: Polish

### Task 6: Docs

**Description:** `skills/bulletin.md` — sync round now instructs: structure
the digest (Decisions/Findings/Open), attach event IDs as evidence, never
silently resolve contested items (put them in Open), pass the expected round
on retry; note fencing errors mean "read the bulletin, then re-sync round+1".
`README.md` — tools table updates for `bulletin_sync`/`bulletin_resolve`/
`bulletin_status`.

**Acceptance criteria:**
- [ ] Structured-digest protocol documented in the skill
- [ ] README tools table reflects new params

**Verification:**
- [ ] Docs read cleanly

**Dependencies:** Tasks 4-5

**Files likely touched:**
- `skills/bulletin.md`
- `README.md`

**Estimated scope:** Small (2 files)

### Task 7: Manual dryrun

**Description:** Scripted dryrun through the extension path: lead syncs a
structured digest (decisions with evidence seqs, open item), non-lead sync
errors, stale-round retry errors, delete `state.json` then verify
`replayState` matches, `bulletin_status` shows round/lead/coverage.

**Acceptance criteria:**
- [ ] Structured digest stored and visible in status
- [ ] Fencing errors surface the expected round
- [ ] Replay after state.json deletion matches

**Verification:**
- [ ] Observed in the dryrun output

**Dependencies:** Tasks 4-6

**Files likely touched:** none (scripted, removed after)

**Estimated scope:** XS

### Task 8: Full-suite verification

**Description:** Run the complete verification set.

**Acceptance criteria:**
- [ ] All spec acceptance criteria met
- [ ] Repo ready for review / commit / release(v0.5.0)

**Verification:**
- [ ] `npm test`
- [ ] `npm run typecheck`
- [ ] `python3 scripts/test_bulletin_watchdog.py`

**Dependencies:** Task 7

**Files likely touched:** none

**Estimated scope:** XS

## Checkpoint: Complete

- [ ] All acceptance criteria in the spec met
- [ ] Ready for review / commit / release(v0.5.0)
