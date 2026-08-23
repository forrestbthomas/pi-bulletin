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
