# pi-bulletin Roadmap (2026-08)

Outcome-based roadmap derived from the 2026 evidence refresh
(`docs/research-report-2026.md`, committed `2fe7b30`). Milestones are
versioned releases (the project cuts releases by tagging main). Each
milestone is an *outcome*, not a feature list; the "Items" column names the
report recommendations that serve it.

**North star:** the bulletin stays the cheapest correct coordination
substrate — zero-LLM eventing, one LLM call per round, no information lost,
no crash corruption. Every milestone preserves the 2025-08 stance that the
2026 evidence CONFIRMED: blackboard + cheap eventing + batched digest +
reconcile-on-conflict + watchdog.

| Horizon | Milestone | Outcome | Items (report recs) | Evidence | Status |
|---|---|---|---|---|---|
| **Now** | **v0.4.0 — Durable & precise conflict core** | The bulletin survives crash/power loss without silent corruption, and conflicting claims are never silently erased — still zero LLM calls | H1 durability hardening (fsync, framing, torn-tail); H2 evidence-tiered supersession + normalized dedupe; M4 per-key concurrent-write dot | PatchBoard 2605.29313 (validated writes, 8x token win); TOKI 2606.06240 (losing claims must persist); OpenClaw #32063 (plain-file queue lost messages) | Shaped → spec written (this cycle) |
| **Next** | **v0.5.0 — Auditable digest rounds** | Every digest is a structured, provenance-carrying snapshot (Decisions/Findings/Open with event IDs + status); double-digests and stale-lead digests are impossible; resolutions are replayable | H3 structured digest with provenance; M1 lead round epoch/fencing; M3 keyed resolver decision log / audit rows | ECHO 2606.31650 (source-indexed beats rolling summaries 43.4% vs 36.1% SUPO); Kubernetes Lease (fencing, not TTL); LLM judges flip 13.6% of repeated decisions (2606.13685) | Shaped (partially, from report) → spec next cycle |
| **Next** | **v0.6.0 — Watchdog v2 + measured fidelity** | Watchdog distinguishes stalled from slow (wall-clock round cap + progress-idle); eval measures digest fidelity on two axes (faithfulness + coverage) and coordination overhead vs a single strong agent | M2 two-tier watchdog; H4 two-axis fidelity audit; report §5 eval extensions (3rd arm, canary facts, conflict FP/FN, watchdog misfire log) | claude-code #85265 (600s inactivity killed healthy runs); ARC 2505.23654 / SummQ (omission is the dominant failure); OrchBench 2607.25656 (deterministic replay, r=0.816 at 1.3% tokens) | Shaped (partially) → spec next cycle |
| **Later** | **v0.7.0+ — Hardening & audit** | Cheap deterministic replay of the bulletin; resource-collision checks; SQLite WAL only if multi-process atomicity demands it | L3 ESAA-style hash-verified replay; L1 resource-collision checks; L2 SQLite WAL substrate (conditional) | ESAA 2602.23193 (hash-verified replay); CodeCRDT 2510.18893 (CRDTs insufficient — keep symbolic) | Unvalidated; promote with evidence |
| **Later** | **Scope gate — coordination must be earned** | Multi-agent use is gated per task: a single strong agent is the baseline; MAS is chosen only where coordination demonstrably adds value | Report §2 Lane 1 finding 5 | Nature MI 2026 (single-agent baseline predicts MAS gains 94%) | Unvalidated; feeds eval design |
| **Never (recorded)** | Embedding/near-duplicate middle tier | — | Report "Skip" item | breaks zero-LLM; no FP-rate evidence | Killed unless data demands |

## Cycle rules (Shape Up)

- **Now = committed, 1–3 items.** v0.4.0 ships this cycle; nothing else is
  in flight.
- **Next = shaped, not assigned.** v0.5.0/v0.6.0 may change based on what
  v0.4.0's eval teaches us.
- **Later = raw.** Promoted only with evidence; pruned quarterly.
- No dates beyond 6 weeks; milestones move when the work moves, not on a
  calendar.
- Cool-down between cycles: fixes, exploration, shaping the next milestone.

## How a milestone ships

1. Spec under `docs/specs/` (pattern: `watchdog-stall-detection.md`).
2. Task list under `tasks/` (pattern: `plan.md` + `todo.md`).
3. Implementation, then verification gate (`npm test`, `npm run typecheck`,
   Python tests, manual dryrun as applicable).
4. Tag + release on merged main tip (project release procedure).

## Evidence quality caveats (carried from the report)

Most 2026 sources are unreviewed preprints; memory-substrate results
(TOKI/MemTxn) transfer to an event log by inference; one cited ID
(2604.00736) is flagged unverified and is not used here. Re-verify the
load-bearing claims before each milestone's spec is finalized.
