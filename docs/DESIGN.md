# pi-bulletin — Design & Research Mapping (SPIKE)

Every component maps to a specific finding in the multi-agent LLM literature.
Sources are cited inline; full citations in
`docs/agent-teams-coordination-research-2026-08.md` (pi-harness).

## Components

```
                 ┌────────────────────────────────────────────┐
                 │               BULLETIN (shared state)      │
                 │  events.jsonl (append-only, cheap)         │
                 │  state.json (digest snapshot = the picture)│
                 └───────▲───────────────────────▲────────────┘
                         │ post/read (CHEAP)     │ digest (1 LLM call/round)
       ┌─────────────────┴──────┐      ┌─────────┴──────────┐
       │  Agent A..N (workers)  │      │  Lead/Summarizer   │
       │  fan out, observe, act │      │  bulletin_sync     │
       └────────────────────────┘      │  bulletin_conflicts│
                                       └────────────────────┘
```

1. **Shared bulletin (events.jsonl + state.json)** — agents communicate *only
   through the blackboard*; no direct agent-to-agent contact. This is the
   blackboard paradigm from the "Beyond Self-Talk" survey (§4.2.3) and the
   LbMAS design (arXiv 2507.01701): *"agents communicate solely through the
   blackboard without any direct contact."*
2. **Cheap eventing (bulletin_post / bulletin_read / bulletin_signal)** —
   zero LLM calls. Analogous to LatticeMind's (arXiv 2608.08236) *cheap
   symbolic conflict checks at write time*; and to Claude Teams' file-based
   mailboxes, minus the "message = injected LLM turn" cost.
3. **Cheap conflict detection (bulletin_conflicts)** — symbolic diff on
   `ref`/`value`, no LLM. LatticeMind: *"applies cheap symbolic conflict
   checks, and invokes LLM reconciliation only for unresolved semantic cases."*
4. **Batched digest (bulletin_sync, one LLM call per round)** — the
   "simultaneous-talk-with-summarizer" strategy from the survey (§4.1.3);
   Anthropic's lead-as-summarizer in their research system; LbMAS's control
   unit + cleaner. LbMAS's empirical result: **2.9–3.3 rounds on average** —
   reconciliation is batched, not continuous.
5. **Reconcile-on-conflict** — conflicts found cheaply; resolved in the next
   digest round by one resolver (the lead). Avoids the debate-loop failure
   mode and the "task derailment / information withholding / ignoring input"
   classes in MAST (arXiv 2503.13657, FC2 inter-agent misalignment).
6. **No peer nudge messages** — the biggest behavioral departure from
   pi-teams. MAST's finding that coordination failures are organizational
   (not model) failures is the reason the *protocol* is the product here, not
   the plumbing.

## 2026 evidence refresh (2026-08-23, `docs/research-report-2026.md`)

Four-agent research team (EM/tech-lead + efficiency/reconciliation/reliability/
accuracy lanes) refreshed the evidence base against late-2025/2026 sources.
**Verdict: CONFIRM the stance — update, not challenge.** Headline findings:

| Component | 2026 verdict | Key new evidence | Action |
|---|---|---|---|
| Eventing + watermarks | KEEP, extend | PatchBoard (2605.29313, verified): validated JSON-Patch shared state beats LangGraph/Flock 84.6% vs 30.8%/61.6% at 45.5k vs 368.3k/64.2k tokens/success (~8x). ESAA (2602.23193) is the same event-log+snapshot shape. LangGraph DeltaChannel (PR #7586): deltas beat full snapshots (O(N^2) -> 41-112x smaller). | Add writer attribution + per-event version; supersession marking |
| Symbolic conflict check | KEEP, upgrade | LatticeMind re-validated (2608.08236): -checker -12pts, -reconciler -14pts. CRDTs converge but leave 5-10% semantic conflicts (2510.18893) — can't replace symbolic checks. TOKI (2606.06240): losing claims must persist as audit rows. | Add evidence tiers + recency tiebreak + normalized dedupe (zero-LLM); keyed resolver log |
| Digest round | KEEP, structure | Tokenomics (2601.14470, verified): 59.4% of tokens in re-injection-heavy Code-Review; 53.9% input tokens. Full-history context degrades quality (2607.09493). ECHO (2606.31650): source-indexed records beat rolling summaries (43.4% vs 36.1% SUPO). | One digest/round stays; structure it (Decisions/Findings/Open with event IDs + status); never silently resolve contested items |
| Reconciliation | KEEP | Debate is a martingale: 2.1-3.4x tokens, equal/lower accuracy (2605.00914); voting explains most MAD gains (2508.17536). LLM judges flip 13.6% of repeated decisions (2606.13685) -> log keyed decisions + provenance. | Single resolver stays; LLM fires only on evidence ties |
| Compaction | KEEP, harden | fsync + torn-tail framing is the durability bar; OpenClaw lost messages on plain-file queue, moved to SQLite outbox (openclaw#32063). Compression loses hard constraints (2607.18265). | fsync after state.json commit; seq+length+checksum framing + torn-tail truncation; keep archive retrievable |
| Watchdog | KEEP, upgrade | Claude 600s inactivity timer killed healthy requests (claude-code#85265); LangGraph 1.2 run_timeout vs idle_timeout (PR #7599); MAS-FIRE (2602.19843): closed-loop supervision neutralizes >40% of faults. | Keep "idle lead WITH unread events"; add wall-clock per-round cap; nudge->kill with maxRetries |

Scope challenge: a 260-config controlled study (Nature MI 2026) found the
single-agent baseline is the strongest predictor of MAS gains (94%) —
multi-agent coordination must be earned per task, not assumed. Evidence
caveats (§6 of the report): most 2026 sources are unreviewed preprints;
memory-substrate results transfer to an event log by inference.

## Explicit non-goals (spike)

- No process spawning / terminal panes (pi-teams owns that layer; Claude
  Teams docs: use teams for parallel exploration, not same-file work).
- No task board / workflow engine (harness already has versioned tasks via
  `tasks.json` → `score_run.py`; MetaGPT-style SOP artifacts are a separate
  lever).
- No wire protocol (MCP/A2A/ANP exist; this is a same-machine file substrate
  for harness-launched sessions, per BACKLOG MSG-1 scope).

## Evaluation sketch (the actual open question)

Run the same 5-agent research task twice:
- A: pi-teams (mailbox model)
- B: pi-bulletin (bulletin model)

Measure: total tokens (from per-session Usage fields in `.pi/sessions/*.jsonl`
— the same parser pi-run `cost` uses; ad-hoc `pi` sessions do NOT write the
`.pi/cost-ledger.jsonl`), wall-clock, output quality (harness judge), and a
MAST-style failure-mode count on the transcripts. Hypothesis from the
literature: B uses fewer tokens (no per-message context injection; LbMAS
showed blackboard = lower token cost *and* better accuracy) with comparable
or better quality. If the data disagrees, the spike is retired — that is the
point of a spike. (Authoritative protocol: `docs/EVAL-PLAN.md`.)
