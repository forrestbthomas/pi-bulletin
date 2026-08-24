# Implementation Plan: v0.4.0 — Durable & precise conflict core

Roadmap: `docs/ROADMAP.md` (Now milestone v0.4.0)
Specs: `docs/specs/durability-hardening.md` (H1),
       `docs/specs/conflict-supersession.md` (H2 + M4)
Task list: `tasks/todo-v0.4.0.md`

## Overview

Two specs ship together in v0.4.0: (1) durability hardening — fsync
discipline, atomic snapshot commits, torn-tail recovery — so the bulletin
survives crash/power loss without silent corruption; (2) evidence-tiered
conflict supersession + concurrent-write dots — so `bulletin_conflicts`
never silently erases a claim and distinguishes updates from cross-author
conflicts. Both are zero-LLM and on-disk-format compatible.

## Architecture Decisions

- **Durability in `src/store.ts`, not a new module.** The store is the
  single writer; adding a `writeFileAtomic` helper keeps the change small
  and testable (matches AGENTS.md: TS logic stays in `src/store.ts`).
- **JSONL stays.** Torn-tail recovery via parse-based truncation is
  sufficient for app-crash recovery; checksum framing is deferred to the
  replay milestone (L3) — no migration tooling needed.
- **Conflict upgrades are additive metadata, not a schema change.** New
  optional `status` on events and `decisionEvidence`/`supersedes` on
  resolutions; old events read with defaults.
- **Zero-LLM invariant enforced by tests** (no network calls in the store
  conflict path; canonicalization/tiering is deterministic code).
- **The checker reports tiers; it never resolves.** Resolution stays with
  the single resolver (the lead) per protocol.

## Task List

### Phase 1: Durability (foundation)

- [ ] Task 1: `writeFileAtomic` + `fsyncFile` helpers + torn-tail-tolerant
      `readEvents` — `src/store.ts`
- [ ] Task 2: fsync/atomic calls in `postEvent`, `postDigest`, `markRead`,
      `compact` (archive fsync + atomic live-log replace)
- [ ] Task 3: durability tests (hermetic temp roots, fs-call spies)

### Checkpoint: Durability

- [ ] Torn-tail fixture: readEvents returns good events, warns, truncates
- [ ] Atomic state commit: crash injection leaves previous state intact
- [ ] `npm test` green

### Phase 2: Conflict supersession (core)

- [ ] Task 4: canonicalization helpers (`canonRef`, `canonValue`)
- [ ] Task 5: `findConflictsSince` upgrade — author tracking, evidence
      tiers, update-vs-conflict, resolution/supersession, richer shape
- [ ] Task 6: extension surface — `bulletin_post` `status`,
      `bulletin_resolve` `decisionEvidence`/`supersedes`, enum validation
- [ ] Task 7: conflict tests (all acceptance scenarios)

### Checkpoint: Conflicts

- [ ] Dedupe FP removed; same-author update not a conflict; tiers correct
- [ ] Resolution stops re-flagging; losing claim preserved as superseded
- [ ] `npm test` + `npm run typecheck` green

### Phase 3: Polish

- [ ] Task 8: docs — `skills/bulletin.md` status vocabulary +
      conflict-report reading guidance; `README.md` mention
- [ ] Task 9: manual two-role dryrun (conflict → tier → resolve → clean)
- [ ] Task 10: full-suite verification (`npm test`, `npm run typecheck`)

### Checkpoint: Complete

- [ ] All acceptance criteria in both specs met
- [ ] Ready for review / commit / tag

## Risks and Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| fsync on every append slows posting | Low-Med | Appends are rare (findings, not chatter); measure in dryrun; defer batching to v0.6 watchdog work if needed |
| Torn-tail truncation deletes a good line | Low | Truncation only on unparseable lines; seq.json high-watermark keeps ids unique; archive is never truncated |
| Over-aggressive canonicalization merges distinct values | Med | Conservative rules only (trim/case/numeric); no stemming/synonyms; unit tests pin behavior |
| Status field misused by agents | Low | Skill documents vocabulary; invalid enums rejected by the tool |
| Extension output shape breaks existing consumers | Low | New fields additive; old fields unchanged |

## Open Questions

None blocking. Specs carry their own open questions (digest guidance for
soft conflicts; finding-vs-signal contradiction checks — both deferred).
