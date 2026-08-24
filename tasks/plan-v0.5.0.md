# Implementation Plan: v0.5.0 — Auditable digest rounds

Roadmap: `docs/ROADMAP.md` (Next milestone v0.5.0)
Spec: `docs/specs/auditable-digest-rounds.md` (H3 + M1 + M3)
Task list: `tasks/todo-v0.5.0.md`

## Overview

Make the digest round auditable and single-writer: structured digest with
event-ID provenance (H3), monotonic round + lead fencing on `postDigest`
(M1), and keyed resolutions with a replayable snapshot (M3). All changes are
additive/backward compatible, zero-LLM, in the existing digest write path.

## Architecture Decisions

- **One spec for H3+M1+M3.** They touch the same write path
  (`postDigest`/`state.json`/`bulletin_sync`); splitting them would duplicate
  the type and fencing work.
- **Fencing in the store, not the tool.** `postDigest` rejects
  non-lead/stale-round writes so every writer (agent, retry, stale session)
  is fenced at the substrate. The tool stays thin.
- **Provenance validated cheaply.** `evidence` seqs are checked against the
  `seq.json` high-watermark (a file read) — no LLM, no network. Bad evidence
  errors with the offending seq so the lead can fix and retry.
- **Coverage note is derived, not authored.** `coverageTo` = last live event
  seq at digest time; `coverageFrom` = previous digest seq. The lead cannot
  misstate what the digest covers.
- **Replay is a store function, not a tool.** `replayState` reads
  `digests.jsonl` and rebuilds state; used for recovery/audit and covered by
  tests. (ESAA-style hash verification stays L3.)

## Task List

### Phase 1: Store (foundation)

- [ ] Task 1: Types + `postDigest` opts (round/decisions/findings/open),
      lead + round fencing, evidence validation, coverage derivation —
      `src/store.ts`
- [ ] Task 2: `replayState(team)` from `digests.jsonl` — `src/store.ts`
- [ ] Task 3: store tests (fencing, validation, structured storage, replay,
      backward compat, zero-LLM guard)

### Checkpoint: Store

- [ ] Fencing tests pass (non-lead, stale round)
- [ ] Evidence validation errors name the bad seq
- [ ] `replayState` matches `readState`; legacy digests replay with defaults
- [ ] `npm test` green

### Phase 2: Extension surface

- [ ] Task 4: `bulletin_sync` structured params + round;
      `bulletin_resolve` rationale; `bulletin_status` round/lead/coverage —
      `extensions/index.ts`
- [ ] Task 5: extension tests

### Checkpoint: Extension

- [ ] `bulletin_sync` accepts decisions/findings/open and stores them
- [ ] `bulletin_resolve` stores rationale
- [ ] `bulletin_status` shows round/lead/coverage
- [ ] `npm test` + `npm run typecheck` green

### Phase 3: Polish

- [ ] Task 6: docs — `skills/bulletin.md` structured-digest protocol,
      `README.md` tools table/status line
- [ ] Task 7: manual dryrun (structured sync, fencing errors, replay after
      deleting state.json)
- [ ] Task 8: full-suite verification

### Checkpoint: Complete

- [ ] All spec acceptance criteria met
- [ ] Ready for review / commit / release(v0.5.0)

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Fencing breaks legit lead restart | Med | Restart keeps `PI_BULLETIN_AGENT`; round check only rejects stale in-flight syncs (lead re-reads, posts round+1) |
| Evidence validation too strict (archived seqs) | Low | Validate against high-watermark, not live events — archived evidence stays valid |
| Legacy teams (0.4.0 digests) break | Med | Additive fields with defaults; replay/readState tolerate missing round/sections |
| Lead forgets structured sections | Low | Skill mandates structure; tool accepts optional arrays, prose digest remains required |
| Contested items silently resolved in prose | Med | Skill: contested → Open section; structured fields make it auditable (follow-up cross-check deferred) |

## Open Questions

None blocking. Spec carries future candidates (Open-vs-conflicts
cross-check, auto-render digest from sections).
