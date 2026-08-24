# Spec: Auditable digest rounds — structured digest, round fencing, keyed resolver log (H3 + M1 + M3)

## Goal

Make the digest round *auditable and single-writer*: (1) the digest becomes a
structured snapshot with provenance — Decisions / Findings / Open questions,
each item carrying event-ID evidence and status, never silently resolving a
contested item (H3); (2) digest writes are fenced by a monotonic round and
lead identity, so a stale or duplicate lead cannot write a second digest for
the same round (M1); (3) resolutions are keyed and the state snapshot is
replayable from the digest log (M3).

## Problem Statement

Today `postDigest` (store.ts:243) writes a free-text digest and overwrites
`state.json` unconditionally:

1. **No structure / no provenance (H3).** The digest is a ~200-500 word prose
   string. There is no machine-readable "what was decided / what was found /
   what is open", no event-ID evidence tying digest claims back to the log,
   and no coverage note (which events this digest folded in). A lead can
   silently resolve a contested item in prose and the team has no way to
   audit it. ECHO (2606.31650) shows source-indexed records beat rolling
   summaries (43.4% vs 36.1% SUPO); AgentCollabBench (2605.08647) shows
   converging topologies discard minority-branch constraints — contested and
   decided items must be explicit.
2. **No fencing (M1).** Any agent (or a stale/restarted lead session) can
   call `bulletin_sync` and overwrite the digest + state. Two leads or a
   retry after a crash produce a double digest for the same round. The
   protocol says "one writer per digest round" but the store does not
   enforce it. Kubernetes Lease pattern: TTL alone is insufficient; a
   resource-side epoch must reject stale holders.
3. **Resolutions not keyed to rounds (M3).** `bulletin_resolve` records
   `{ref, decision, decisionEvidence?, supersedes?}` (v0.4.0) but nothing
   links a resolution to the digest round that folded it in, and `state.json`
   cannot be rebuilt from the digest log (`digests.jsonl`) without trusting
   the snapshot file.

## Context From Memory

- v0.4.0 (committed `eb628f4`, released) added durability + evidence-tiered
  conflicts; resolutions already carry `decisionEvidence`/`supersedes` and
  the checker preserves superseded claims as audit markers.
- `digests.jsonl` is already an append-only audit of sync rounds
  (store.ts:104, appended in `postDigest`).
- Roadmap v0.5.0 — Auditable digest rounds: "Every digest is a structured,
  provenance-carrying snapshot (Decisions/Findings/Open with event IDs +
  status); double-digests and stale-lead digests are impossible; resolutions
  are replayable." Evidence: ECHO 2606.31650, 2605.08647, Anthropic
  artifacts-not-content, Kubernetes Lease, TOKI 2606.06240, MemTxn
  2607.27834, LLM-judge flip 13.6% (2606.13685).

## In Scope

- **Structured digest event + state** (`src/store.ts`):
  - `postDigest` gains an optional 5th param `opts`:
    `{ round?, decisions?, findings?, open? }`.
  - Digest event `data` gains `round`, `decisions`, `findings`, `open`,
    `coverageFrom`, `coverageTo`.
  - `DigestState` gains `round`, `lead`, `coverageFrom`, `coverageTo`
    (existing fields unchanged).
  - `DigestItem = { ref: string; text: string; status?: ClaimStatus;
    evidence?: number[] }`.
- **Round fencing (M1)** in `postDigest`:
  - First digest sets `lead = from` and `round = 1`.
  - Subsequent digests reject when `from !== state.lead` (single writer per
    round, enforced in code).
  - `round` is monotonic: if `opts.round` is provided it must equal
    `state.round + 1` (reject stale retries with the expected round in the
    message); if omitted, `state.round + 1` is used.
- **Cheap provenance validation (H3)**: `decisions`/`findings`/`open`
  `evidence` seqs must be positive integers ≤ the current seq high-watermark
  (`seq.json.last`). Reject with a clear error listing the bad seq(s) so the
  lead can fix and retry. No LLM, no network.
- **Coverage note**: `coverageTo` defaults to the last event seq at digest
  time; `coverageFrom` defaults to the previous digest's seq (or 0).
- **Keyed resolver log (M3)**:
  - `bulletin_resolve` gains optional `rationale` (free-text why), stored as
    `data.rationale` alongside existing `decisionEvidence`/`supersedes`.
  - Digest `decisions` items reference resolution event seqs via `evidence`,
    tying "what won" to the resolution audit row.
  - New export `replayState(team): DigestState | null` — rebuilds the latest
    state from `digests.jsonl` (last digest event), not from `state.json`.
- **Extension surface** (`extensions/index.ts`, thin):
  - `bulletin_sync` gains `round` (optional), `decisions`, `findings`,
    `open` (arrays of `{ref, text, status?, evidence?}`).
  - `bulletin_resolve` gains `rationale` (optional).
  - `bulletin_status` shows `round`, `lead`, `coverageFrom`, `coverageTo`.
- **Skill** (`skills/bulletin.md`): sync round now instructs the lead to
  structure the digest (Decisions/Findings/Open), attach event IDs as
  evidence, never silently resolve contested items (put them in Open), and
  pass the expected round on retry.
- Tests: extend `src/store.test.ts` + `extensions/index.test.ts` with the
  acceptance scenarios.

## Out Of Scope

- Hash-verified replay / ESAA-style checksums (roadmap L3, later).
- Automatic lead takeover / re-election (watchdog escalation stays a
  human/launcher decision).
- Multi-lead or leader-election protocol (protocol is one lead).
- Editing/amending a posted digest (append-only; a correction is a new
  round).
- `bulletin_sync` rendering a structured digest to prose (the lead writes
  both; the tool stores both).

## Constraints

- Backward compatible: existing 4-arg `postDigest(team, from, digest,
  members)` calls keep working; old digest events/state read with defaults.
- Zero-LLM: fencing and provenance validation are pure file I/O in
  `src/store.ts`.
- On-disk format unchanged (same JSONL; additive fields).
- Keep `npm test`, `npm run typecheck`, and the watchdog Python tests green.

## Assumptions

- The lead identity is `PI_BULLETIN_AGENT` (same as `bulletin_post`).
- A restarted lead session keeps the same `PI_BULLETIN_AGENT`, so it passes
  the lead check; the round check prevents a stale in-flight sync from the
  old session.
- `seq.json` is the authoritative high-watermark (updated synchronously in
  `postEvent`); evidence seqs are validated against it.
- Digest prose (`digest` field) stays the human-readable summary; the
  structured sections are the machine-auditable picture.

## Acceptance Criteria

- **Structured digest stored**: `postDigest` with `decisions`/`findings`/
  `open` stores them on the event and in `state`; `readState` returns them.
- **Coverage note**: `coverageTo` = last event seq at digest time;
  `coverageFrom` = previous digest seq (0 on first).
- **Lead fencing**: after lead `alice` posts digest 1, `postDigest` from
  `bob` throws (single writer per round); `alice` can post round 2.
- **Round fencing**: `postDigest` with `round: 1` again throws (stale
  retry) with the expected round in the error; omitted round auto-increments.
- **Provenance validation**: a decision with `evidence: [9999]` (beyond the
  high-watermark) throws naming seq 9999; a decision with `evidence: [1]`
  (valid) succeeds.
- **Keyed resolutions**: `bulletin_resolve` with `rationale` stores it;
  digest `decisions[].evidence` referencing the resolution seq ties the
  decision to the audit row.
- **Replay**: after 2 digests, `replayState(team)` equals `readState(team)`
  even if `state.json` is deleted/corrupt.
- **Backward compat**: a legacy digest event (no round/sections) replays
  with `round: 0`/empty sections and does not throw; `status()` still
  reports counts/state on a legacy root.
- **Zero-LLM enforced**: no network calls in the digest/fencing path
  (test-guarded).
- **CI**: `npm test`, `npm run typecheck`, watchdog Python tests pass.

## Edge Cases

- First digest: no prior state → `round = 1`, `lead = from`, `coverageFrom
  = 0`.
- Retry after crash: the event append happened but state write failed →
  same round rejected (stale); lead re-reads and posts round+1.
- Evidence seq of an archived (compacted) event: valid as long as ≤
  high-watermark (provenance survives compaction).
- `opts.round` omitted but state missing (fresh team) → round 1.
- Empty `decisions`/`findings`/`open` arrays → stored as `[]`, not null.
- `bulletin_sync` from a non-lead on a team with no digest yet → allowed
  (first digest sets the lead).

## Validation Plan

- `npm test` (existing + new store/extension scenarios)
- `npm run typecheck`
- `python3 scripts/test_bulletin_watchdog.py`
- Manual dryrun: lead syncs a structured digest (decisions with evidence),
  a second lead attempt errors, a stale-round retry errors, `replayState`
  matches after deleting `state.json`, `bulletin_status` shows round/lead.

## Execution Plan

1. Extend `DigestState` + `DigestItem` types; `postDigest` gains `opts`
   (round/decisions/findings/open) with lead + round fencing and evidence
   validation; add `replayState`.
2. Extension: `bulletin_sync` structured params + round; `bulletin_resolve`
   `rationale`; `bulletin_status` round/lead/coverage.
3. Tests: fencing, provenance validation, structured storage, replay,
   backward compat, zero-LLM guard.
4. Skill + README updates (structured digest protocol).
5. Manual dryrun + full-suite verification.

## Open Questions

- Should `bulletin_conflicts` also surface "contested items that the last
  digest put in Open"? (Deferred — the digest sections are the record; a
  follow-up could cross-check Open vs live conflicts.)
- Should `bulletin_sync` auto-render a prose digest from the sections if the
  lead omits `digest`? (Deferred — keep the lead-authored prose for v1.)

## Self-Check

- Status: Ready for implementation
- Blocking Questions: None
- Safe To Implement: Yes
- Notes: Additive + backward compatible; matches H3/M1/M3 in
  `docs/ROADMAP.md` (Next milestone v0.5.0).
