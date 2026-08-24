# FINAL RESEARCH REPORT — pi-bulletin Evidence Refresh (late-2025 / 2026)

Synthesis of four research lanes (efficiency, reconciliation, reliability, accuracy) against the 2025-08 evidence base. All arXiv IDs were verified against arxiv.org/abs unless flagged; flagged items marked **[UNVERIFIED]** or **[preprint/flag]**.

## 1. EXECUTIVE SUMMARY

**Verdict: CONFIRM the bulletin stance, with targeted cheap upgrades - update, not challenge.** Evidence strengthens blackboard-only shared state (PatchBoard 2605.29313: 8.1x token win), batched-digest over full-history injection (Tokenomics 2601.14470: 59.4% of tokens in re-injection; full history degrades quality, 2607.09493), symbolic-check-first reconciliation (LatticeMind 2608.08236: 12-14 accuracy points lost without checker/reconciler), single-resolver over debate (2605.00914: debate ≈ voting at 2.1-3.4x tokens), and the watchdog's progress-signal design (600s-inactivity false positive, claude-code#85265). Three cheap upgrades are warranted: (1) evidence-tiered supersession on the conflict check; (2) fsync/torn-tail durability + lead epoch/fencing; (3) structured digest with event-ID provenance. One scoping challenge: MAS overhead often loses to a strong single agent (Nature MI 2026; Hermosa) — gate multi-agent use per task.

## 2. FINDINGS BY LANE

### Lane 1 — Efficiency

1. **Structured shared state beats prose message-passing on tokens at ≥ parity accuracy.** PatchBoard (arXiv 2605.29313): validated JSON-Patch writes over schema'd state; 84.6% vs 30.8% (LangGraph)/61.6% (Flock) success on 630 ALFWorld episodes, at 45.5k vs 368.3k/64.2k tokens per success (~8x fewer). Stigmergy-MCP (GitHub, 3 runs): trace-based signals cut inter-agent tokens 46% (95% CI 38–54%), content transfer −72%. PACT (arXiv 2606.05304): compact action-state records halve input tokens on a SWE agent; "no fixed strategy is universally optimal."
2. **Digest-not-full-history is safer and cheaper.** Tokenomics (arXiv 2601.14470, 30 ChatDev tasks): Code-Review stage = 59.4% of tokens; inputs 53.9% (~2:1) - cost dominated by re-injection, not generation. Anthropic (official): 3-10x tokens vs single-agent (15x in their research system). Selective Shared Persistent Memory (arXiv 2607.09493): 96% completion vs 71–79% (none/full-history); summary-driven generation cuts cost 97x.
3. **Event-sourcing + materialized view is a named production pattern - structurally identical to events.jsonl + state.json.** ESAA (arXiv 2602.23193): validated intentions → deterministic orchestrator → activity.jsonl → materialized roadmap.json, hash-verified replay. LangGraph DeltaChannel (PR #7586): full-snapshot checkpointing is O(N²); deltas + periodic snapshots cut a 5.3GB checkpoint to 129MB (41x) at 200 turns, 221MB → 1.98MB (112x) at 500.
4. **Production platforms confirm the failure mode pi-bulletin avoids.** OpenAI Agents SDK forwards the full conversation on handoff (issue #2171; 3–6x cycle amplification); Microsoft's manager re-sends full context → quadratic duplication (issue #6298).
5. **Challenge (scope, not design): coordination must be earned.** Nature MI 2026 (260-config controlled study): single-agent baseline is the strongest predictor of MAS gains (94% held-out prediction); Hermosa (secondary): most coordination patterns < self-consistency.

### Lane 2 — Reconciliation

1. **Check-first, reconcile-on-demand: directly re-validated.** LatticeMind (arXiv 2608.08236): symbolic checker flags mechanical conflicts; LLM reconciler fires only on unresolved ties; ConflictBank (n=75): 0.97 vs 0.63 single-agent / 0.61 vote / 0.32 no-merge; ablation (n=50): −checker −12 pts, −reconciler −14 pts. Evidence-tiered supersession with recency tiebreak is zero-LLM for the common case (caveats: small n, one backbone).
2. **Write-time heuristics hide anomalies; losing claims must persist.** TOKI (arXiv 2606.06240): LWW, evidence-weighted merge, await-confirmation each admit replay-inconsistency / belief-drift / audit-erasure with an LLM judge on the write path; preserving the losing claim in an audit row is *proven necessary* for replay consistency. MemTxn (arXiv 2607.27834): write-time validation + durable snapshot journal; 0 FP/0 FN on a 60/179-item audit; +17.06-24.07 pts over Dense.
3. **Debate does not beat voting and costs more.** NeurIPS 2025 (arXiv 2508.17536): majority voting accounts for most MAD gains; debate alone is a martingale. 2026 replication (arXiv 2605.00914): 2.1–3.4x tokens for equal/lower accuracy; conformity up to 85.5%. LLM judges flip 13.6% of repeated identical decisions (2606.13685; 2604.22891) — a single resolver must log keyed decisions + provenance.
4. **CRDT convergence ≠ semantic consistency.** CodeCRDT (arXiv 2510.18893): 100% convergence, zero merge failures, yet 5-10% semantic conflicts persist (up to 39.4% slowdown) - pure CRDT merge cannot replace symbolic checks. CoAgent (arXiv 2606.15376): advisory concurrency within 5% of serial correctness at 1.4x speedup.
5. **Compression loses hard constraints.** Hand-off summarization breaks strict numeric/categorical constraints (2607.18265; 2608.16370) — keep raw events retrievable after compaction. SCF (arXiv 2604.16339, **[preprint/flag]**, single-author): 91.7% precision / 88.4% recall, 145ms overhead, unreplicated.

### Lane 3 — Reliability

1. **Closed-loop supervision beats linear chains under faults.** MAS-FIRE (arXiv 2602.19843): closed-loop designs neutralize >40% of faults that collapse linear workflows; stronger models do not uniformly improve robustness. ICML'25 (huang25ay, peer-reviewed): hierarchical topology most resilient (5.5% drop vs 10.5%/23.7%); an Inspector agent recovers up to 96.4% of injected errors. MAST v3 (2503.13657, updated 2025-10-26): failures remain design/organizational.
2. **Inactivity timers misfire; progress signals are the fix.** Claude Agent SDK's 600s stall timeout (re-arms on stream events) killed healthy long requests with slow time-to-first-chunk (claude-code#85265) — "idle lead WITH unread events" is the right progress-vs-liveness signal. LangGraph 1.2 (PR #7599): wall-clock `run_timeout` vs progress-resetting `idle_timeout` + heartbeat; timed-out buffered writes are discarded, not committed. A2A v1.0: no built-in heartbeat — stall detection is the client's job.
3. **Durability is fsync + framing, not write()/flush().** Page-cache writes are not durable; crash recovery needs length+checksum framing and torn-tail truncation; rename requires a directory fsync (0xKiire, secondary). SQLite WAL: atomic commit, one fsync/txn. OpenClaw's plain-file queue lost messages on crash; replaced by SQLite outbox + journaling + orphan replay (openclaw#32063). Delivery: at-least-once + idempotent consumer = effectively-once; appends are exactly-once *by construction*; watermark reads are monotonic.
4. **Leadership needs epochs/fencing, not TTL alone.** Kubernetes Lease (holderIdentity/renewTime/leaseDurationSeconds) is the canonical template; TTL alone is insufficient — a resource-side high-watermark must reject stale holders. Bulletin analog: `postDigest` carries round/epoch; the store rejects stale-epoch digests after takeover. Orphaned claims reclaim by PID-liveness + age TTL (keaz/aicore#376). LangGraph checkpointers resume crashed runs from the last node — archive, never delete, events newer than the digest's covered seq.

### Lane 4 — Accuracy

1. **Omission — not hallucination — is the dominant digest failure mode; self-check can't catch it.** ARC (arXiv 2505.23654, EACL 2026): coverage and faithfulness scored separately; EMNLP-2025 industry work confirms omission is decision-critical. SummQ (OpenReview WAQhCifBSb, **[preprint/flag]**): an independent quizzer exposes omissions that re-reading cannot.
2. **Digests must carry provenance; compression without it loses evidence.** ECHO (arXiv 2606.31650): source-indexed records beat rolling summaries (43.4% vs 36.1% SUPO on BrowseComp-Plus). Anthropic (official): subagents write artifacts and return lightweight references; lead-as-summarizer beat single-agent 90.2% internally (~15x chat tokens). HiddenBench (arXiv 2505.11556): 30.1% vs 80.7% with full information - premature convergence on shared evidence. Beyond Memory Majority (arXiv 2608.19701): shared upstream sources create false majorities.
3. **Status-annotated, structured state wins.** LatticeMind (0.97 vs 0.61; 12–14-point ablations). AgentCollabBench (arXiv 2605.08647): converging-DAG nodes discard minority-branch constraints; topology explains 7-40% of variance in information survival - contested/decided items must be explicit in the digest.
4. **Evaluation: isolate error sources and make it cheap.** MAST (arXiv 2503.13657, NeurIPS 2025): 14 failure modes in 3 categories - reuse as the digest-failure taxonomy. tau2-bench (arXiv 2506.07982): ablations separate reasoning vs coordination errors. OrchBench (arXiv 2607.25656): deterministic simulation correlates r=0.816 at 1.3% tokens / 10.3% wall-clock. General AgentBench (2602.18998): sequential scaling degrades past a context ceiling.
5. **Context management is a fidelity–reliability tradeoff.** AdaCoM (arXiv 2605.30785): capable agents need high fidelity; weaker agents need aggressive compression. MemAct (arXiv 2510.12635): -51% context at parity accuracy. Claim-level entailment is the stable faithfulness unit; reference-free metrics unreliable on long docs (arXiv 2511.07689).

## 3. IMPLICATIONS MAP

| Component | Verdict | Key evidence | Action |
|---|---|---|---|
| Eventing + watermarks | KEEP, extend | ESAA identical in shape (2602.23193); signals-not-prose (2606.05304, 2605.29313, stigmergy); LangGraph deltas (PR #7586) | Add writer attribution + per-event version; supersession marking; ≤50-char signals |
| Symbolic conflict check | KEEP, upgrade | LatticeMind re-verified (2608.08236); CRDTs insufficient (2510.18893) | Add normalized dedupe, evidence tiers + recency tiebreak, per-key dots, resource-collision checks — all zero-LLM |
| Digest round | KEEP, structure | Re-injection dominates cost (2601.14470); full history degrades (2607.09493); artifacts-not-content (Anthropic); provenance (2606.31650) | One digest per round; structure it — Decisions (event IDs), Findings (claim + event ID + status), Open questions (minority views), Coverage note; never silently resolve |
| Reconciliation | KEEP | Debate martingale at 2.1–3.4x tokens (2605.00914); judges flip 13.6% (2606.13685); TOKI audit rows (2606.06240) | Single resolver stays; LLM fires only on evidence ties; log keyed decisions |
| Compaction | KEEP, harden | fsync-only durability; torn-tail framing; OpenClaw crash loss (openclaw#32063); compression loses constraints (2607.18265) | fsync after state.json commit; seq+length+checksum framing + torn-tail truncation; temp+rename; archive retrievable; optional hash-verified replay (ESAA) |
| Watchdog | KEEP, upgrade | 600s stall false positive (claude-code#85265); run vs idle timeout (PR #7599); MAS-FIRE closed-loop (2602.19843) | Keep "idle lead WITH unread events"; wall-clock cap per round; nudge→kill with maxRetries; epoch/fencing on postDigest |

## 4. PRIORITIZED RECOMMENDATIONS

**HIGH** (next release)
- **H1 — Durability hardening** (src/store.ts): fsync after state.json commit; length+checksum framing + torn-tail truncation; temp-file + fsync + rename. Benefit: reliability. Effort: low. Evidence: fsync-only durability; SQLite WAL; OpenClaw#32063.
- **H2 — Evidence-tiered supersession + normalized dedupe in `bulletin_conflicts`**: status (proposed/confirmed/contested/superseded) + evidence score + recency tiebreak; canonicalize-then-exact-match. Benefit: accuracy (no silent LWW erasure) + efficiency. Effort: low. Evidence: 2608.08236; 2606.06240.
- **H3 — Structured digest with provenance**: four fixed sections; Decisions/Findings carry event IDs + status; contested never silently resolved. Benefit: accuracy (no information loss). Effort: low-medium. Evidence: 2606.31650; 2605.08647; Anthropic.
- **H4 — Two-axis fidelity audit in eval**: independent judge scores faithfulness AND coverage (omission); seed tracer facts. Benefit: accuracy measurement. Effort: low-medium. Evidence: 2505.23654; SummQ.

**MEDIUM**
- **M1 — Lead round epoch/fencing**: round id + lead identity in state.json; postDigest validates epoch. Benefit: reliability (no double-digest). Effort: medium. Evidence: Kubernetes Lease; stale-lock practice.
- **M2 — Two-tier watchdog** (scripts/bulletin_watchdog.py): wall-clock per-round cap + progress-idle-with-unread-events; nudge→kill with maxRetries. Benefit: reliability. Effort: low. Evidence: LangGraph PR #7599; claude-code#85265; MAS-FIRE 2602.19843.
- **M3 — Keyed resolver decision log / audit rows**: what won and why; replayable state.json. Benefit: reliability + audit. Effort: medium. Evidence: TOKI 2606.06240; MemTxn 2607.27834.
- **M4 — Per-key concurrent-write dot** (agent_id, seq) on same-ref writes. Benefit: conflict-detection accuracy. Effort: medium. Evidence: LatticeMind; MemTX 2607.23929.

**LOW**
- **L1 — Resource-collision checks** (dependency cycles; same port/file/branch claimed twice). Benefit: accuracy. Effort: medium. Evidence: 2608.08236.
- **L2 — SQLite WAL substrate** if multi-process atomicity needs grow (trades plain-file auditability). Benefit: reliability. Effort: medium. Evidence: sqlite.org/wal.html; OpenClaw#32063.
- **L3 — ESAA-style hash-verified replay** of events.jsonl. Benefit: audit/recovery. Effort: medium. Evidence: 2602.23193.
- **Skip — Embedding/near-duplicate middle tier** (breaks zero-LLM; speculative). Evidence: none until FP-rate data demands it.

## 5. OPEN QUESTIONS + SUGGESTED NEXT EXPERIMENTS (docs/EVAL-PLAN.md extensions)

1. **No head-to-head "batched digest vs per-message injection" on tokens × accuracy exists in one harness** (PatchBoard/PACT/Tokenomics closest). Experiment: add a third arm to EVAL-PLAN — pi-bulletin vs full-history-handoff vs single-strong-agent; record tokens, conflicts, digest fidelity, MAST counts.
2. **Conflict-check FP/FN on a bulletin-like substrate is unmeasured.** Experiment: seed labeled conflicts (LatticeMind-style tiers); measure FP/FN of same-ref-diff-value vs evidence-tier + dot rule; gate LLM reconcile on ties.
3. **Digest fidelity vs raw retention.** Experiment: seed canary facts (true, false-bait, contradictable); measure tracer survival, false-belief contagion, instruction decay; ablations: digest-with-references vs digest-only vs selective raw injection.
4. **Watchdog false-positive rates.** Experiment: log nudge/kill decisions and outcomes across legs; quantify misfires vs the 600s-kill mode.
5. **Cheap deterministic replay** (OrchBench pattern): replay digest rounds in a deterministic scorer; calibrate vs live runs (target r≈0.8).
6. **Verify the clawRxiv quadratic-overhead paper** — 2604.00736 **[UNVERIFIED]** (returns an unrelated RISC-V paper): search by title before citing the 50%@n=7 numbers; corroborated only by stigmergy + bug reports.
7. **ProtocolBench full text / A2A–MCP overhead numbers** remain unpublished/secondary.

## 6. EVIDENCE QUALITY CAVEATS

- **Recency:** most 2026 sources are arXiv preprints (2601–2608), not peer-reviewed; anchors: NeurIPS'25 (2508.17536), ICML'25 (huang25ay), EACL'26 (2505.23654), EMNLP'25 industry work, MAST (2503.13657); LatticeMind abstract-verified only.
- **n=1 / small-n:** Claude 600s stall bug, OpenClaw queue crash, SCF, Anthropic internal evals (directional), pi-bulletin's 2026-08-23 eval (single leg, $0.80/3 rounds).
- **Primary vs secondary:** briefs kept primary papers and official engineering docs; secondary measured sources (Systima, LangWatch, stigmergy, Hermosa, 0xKiire, orekhov/DistributedRequest) for pattern value only.
- **Unverified/flagged:** clawRxiv 2604.00736 (do not cite); ProtocolBench full text (secondary only); SummQ (OpenReview preprint); SCF (unreplicated); LatticeMind ConflictBank construction unaudited; MetaGPT 2308.00352 not re-verified.
- **Inferential transfer:** LatticeMind/TOKI/MemTxn/MemTX are memory substrates, not event logs — transfer to an append-only bulletin is inferred, not directly measured.
- **Speculative (flagged):** claim-level entailment fidelity check assumes judge quality; embedding middle tier; fsync cost unmeasured for this substrate.
