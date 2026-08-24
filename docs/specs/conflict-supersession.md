# Spec: Evidence-tiered supersession + concurrent-write dots in `bulletin_conflicts` (H2 + M4)

## Goal

Upgrade the cheap symbolic conflict check so it never silently erases a
claim, distinguishes same-author updates from cross-author conflicts, and
weights conflicts by evidence status (proposed/confirmed/contested/
superseded) — all zero-LLM, in `src/store.ts`.

## Problem Statement

`findConflictsSince` (store.ts:134-165) today:
- **Last-write-wins silently.** When the same `ref` gets a different
  `value`, it records a conflict and sets "latest wins for future diffs"
  (store.ts:162). The losing claim stays in the log but is *semantically
  erased* — no status change, no audit marker.
- **No evidence tiers.** A single agent's unconfirmed claim and a
  confirmed/corroborated claim are treated identically. TOKI (2606.06240)
  shows LWW + evidence-weighted merge without preserving the losing claim
  causes replay-inconsistency / belief-drift / audit-erasure; LatticeMind
  (2608.08236) shows the checker is worth 12 points and the reconciler 14.
- **No normalized dedupe.** `value: "v2"` vs `value: "v2 "` (trailing
  space) or `ref: "API"` vs `ref: "api"` are flagged as conflicts — false
  positives the lead must waste a digest round on.
- **No writer identity.** Two signals from the *same* agent (a correction)
  are indistinguishable from two agents disagreeing. Same-author updates
  should be exactly that — updates, not conflicts; cross-author divergence
  is the thing worth flagging.

## Context From Memory

- Report verdict (CONFIRM stance) explicitly keeps the symbolic checker and
  recommends: "evidence tiers + recency tiebreak + normalized dedupe
  (zero-LLM); keyed resolver log" (research-report-2026.md §3 Implications
  Map → Symbolic conflict check).
- Protocol rule: conflicts are resolved by ONE resolver (the lead) at the
  next digest round, never a debate loop. The checker's job is to *surface
  the right conflicts cheaply*, not to resolve them.
- `bulletin_resolve` already exists (records a resolution event; the checker
  stops flagging a resolved ref). This spec makes resolution auditable and
  gives the checker evidence to work with.

## In Scope

- **Event metadata** (additive, optional):
  - `signal`/`finding` events may carry `data.status`:
    `proposed` (default) | `confirmed` | `contested` | `superseded`.
  - `resolution` events gain optional `data.decisionEvidence` (list of event
    seqs that motivated the decision) and `data.supersedes` (list of event
    seqs invalidated by this decision). Existing events without these fields
    keep working (defaults).
- **Normalized dedupe** — canonicalize before compare:
  - `ref`: trim + lower-case (topic keys are case-insensitive).
  - `value`: trim; collapse internal whitespace; numeric strings compared as
    numbers when both parse; otherwise exact string compare after
    canonicalization. Never over-merge: canonicalization is conservative
    (no stemming, no synonym mapping).
- **Evidence-tiered supersession** in `findConflictsSince`:
  - Track per-ref state: `{ author, seq, value, status, evidenceCount }`
    where `evidenceCount` = distinct authors who wrote the same canonical
    value for that ref (corroboration) + 1.
  - Conflict classification on divergent canonical values:
    - same author, later seq → **update** (not a conflict; latest wins for
      that author; record in the returned shape as `kind: "update"` for
      transparency).
    - different authors →
      - both `confirmed` → `tier: "hard"`
      - either side `confirmed`, other `proposed`/`contested` → `tier:
        "medium"`
      - both `proposed`/`contested` → `tier: "soft"`
  - Recency tiebreak only when evidence ties; the conflict is still
    reported (never silently resolved).
  - A later `resolution` for a ref marks it `resolved`; the checker stops
    re-flagging it, and the losing seqs from `supersedes` are marked
    `superseded` in the returned shape (audit trail — claims are never
    deleted, only re-labeled).
- **Output shape** of `findConflictsSince` (extended, backward compatible):
  each item gains `{ tier: "hard"|"medium"|"soft", authors: [a, b],
  kind: "conflict"|"update", status: "active"|"resolved"|"superseded" }`.
- **Extension surface** (`extensions/index.ts`, thin): `bulletin_conflicts`
  returns the richer shape; `bulletin_post` accepts optional `status`
  (validated enum) and `bulletin_resolve` accepts optional `decisionEvidence`
  / `supersedes`. `skills/bulletin.md` documents the status vocabulary so
  agents can confirm/corroborate findings.
- Tests: extend `src/store.test.ts` with the acceptance scenarios below.

## Out Of Scope

- LLM reconciliation (still the lead's job at the digest round — the checker
  only reports tiers; the lead decides when a `medium`/`hard` conflict needs
  an LLM call).
- Embedding/near-duplicate detection (roadmap "Skip" item — breaks zero-LLM).
- CRDTs / semantic entailment checks (CodeCRDT 2510.18893: convergence ≠
  semantic consistency; keep symbolic for v1).
- Schema migration tooling — metadata is optional on new events; old events
  read with defaults.

## Constraints

- **Zero LLM**: all canonicalization, evidence counting, tiering, and
  supersession is deterministic code in `src/store.ts`. No model calls, no
  embeddings.
- On-disk format unchanged (same JSONL events; new optional fields).
- Existing tests stay green; new tests are additive.
- Protocol invariant: one writer per digest round; the checker is
  read-only.

## Assumptions

- `data.status` is set by the posting agent from the skill's vocabulary;
  absent status = `proposed` (safe default — unconfirmed).
- "Confirmed" means corroborated: either the posting agent asserts it
  (`status: "confirmed"`) or ≥2 distinct authors wrote the same canonical
  value (evidenceCount ≥ 2). Both are cheap and auditable.
- Same-author later value is a correction by default; a same-author
  *revert* (back to an earlier value) is still treated as an update, not a
  conflict — the digest can note it.
- The lead reads `tier` and may resolve cheaply (`bulletin_resolve`) without
  an LLM call for obvious cases (typo, superseded baseline), matching the
  protocol's "if a conflict is cheap to resolve, resolve it in the digest".

## Acceptance Criteria

- **Dedupe FP removed:** same `ref` (case differences) and `value` (trailing
  space / numeric string) → NO conflict.
- **Same-author update, not conflict:** agent A posts `ref=x value=v1`,
  then `ref=x value=v2` → one `kind:"update"` entry, no `tier`, latest
  value is the baseline.
- **Cross-author conflict with tier:** A posts `proposed v1`; B posts
  `proposed v2` → `kind:"conflict", tier:"soft"`. If both are
  `confirmed` → `tier:"hard"`. Mixed → `tier:"medium"`.
- **Corroboration:** A posts `v1`; B posts `v1` (same canonical value) →
  no conflict, `evidenceCount` for `v1` becomes 2 (B's write is an
  agreement, not a conflict).
- **Resolution stops re-flagging + audit:** after `bulletin_resolve(ref=x,
  decision=..., supersedes=[seqA])`, a later conflict scan reports
  `status:"resolved"` (or omits active conflicts) and the losing seq is
  `superseded` — the event is NOT deleted from the log.
- **Recency tiebreak only on ties:** divergent confirmed values with equal
  evidence → latest seq wins as baseline AND the conflict is still
  reported with `tier:"hard"` (no silent LWW).
- **Backward compatible:** a root with only legacy events (no `status`) →
  all treated as `proposed`; output shape contains the new fields with
  sensible defaults; no throw.
- **Zero-LLM enforced:** store module imports unchanged; no network calls in
  the conflict path (spy/test guard).
- **CI:** `npm test`, `npm run typecheck` pass.

## Edge Cases

- Same ref, same value, different authors (agreement) → never a conflict,
  evidence increments.
- `ref` missing on a signal → skipped (existing behavior).
- Resolution with `supersedes` referencing an unknown seq → ignored
  gracefully.
- Status enum on the wire: invalid value rejected by the extension tool
  (`bulletin_post` returns an error, no event written).
- Compaction interplay: superseded/resolved refs live in archived events;
  live-log scanning still correct because the checker only looks at events
  since `sinceSeq` (existing watermark semantics).

## Validation Plan

- `npm test` (vitest, new scenarios in `src/store.test.ts`)
- `npm run typecheck`
- Manual: two-role dryrun where agents post conflicting confirmed signals on
  one ref; run `bulletin_conflicts`, verify tier + authors; resolve; verify
  re-scan is clean and the losing claim is still visible in the log
  (`events.jsonl` grep).

## Execution Plan

1. Add canonicalization helpers (`canonRef`, `canonValue`) + unit tests.
2. Extend `findConflictsSince` state tracking (author, status, evidence,
   tier, update vs conflict, resolution/supersession).
3. Extend `bulletin_post` (optional `status`), `bulletin_resolve`
   (optional `decisionEvidence`/`supersedes`) in `extensions/index.ts`;
   validate enums.
4. Update `skills/bulletin.md` status vocabulary + conflict-report reading
   guidance.
5. Add tests for all acceptance scenarios; full-suite verification.

## Open Questions

- Should `tier:"soft"` conflicts auto-resolve by recency in the *digest
  text* guidance? (Recommendation: no — always surface; the lead decides.
  Cheap to revisit with eval data.)
- Should the checker also flag `finding`-on-`signal` contradictions (prose
  vs structured value)? (Out of scope v1 — prose needs an LLM to compare;
  that's a later eval question, not a symbolic check.)

## Self-Check

- Status: Ready for implementation (pending roadmap approval)
- Blocking Questions: None
- Safe To Implement: Yes
- Notes: Pure additive, zero-LLM; matches H2+M4 in `docs/ROADMAP.md` (Now
  milestone v0.4.0).
