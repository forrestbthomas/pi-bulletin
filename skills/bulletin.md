---
description: Coordinate multiple agents through a shared bulletin (blackboard) — cheap eventing, batched digests, reconcile-on-conflict. SPIKE.
---

# Bulletin Coordination (pi-bulletin, SPIKE)

Coordinate multiple agents on shared work through a **shared bulletin**, not
peer message passing. The bulletin is the single source of situational
awareness; agents **fan out → observe → sync in rounds**.

This is a research-backed alternative to pi-teams/Claude Agent Teams'
mailbox model (see `docs/DESIGN.md` in the package). It is a SPIKE — the
coordination substrate, not a UI; no terminal panes, no process spawning.

## Why

Peer message passing thrashes: every message is a full LLM turn injected into
the recipient's context, there is no shared picture, and coordination cost
grows with team size. The bulletin separates **cheap** from **expensive**:

- CHEAP (no LLM): post findings, read the bulletin, symbolic conflict checks.
- EXPENSIVE (LLM): exactly one digest per sync round; LLM reconciliation only
  for unresolved conflicts.

## Protocol

### 1. Setup

1. `bulletin_status(team_name=...)` — confirm the team and root. Use the same
   `team_name` across the whole team.
2. Record members when the first digest is written.

### 2. Fan out (work independently)

Work on your slice. When you learn something others may need:

- `bulletin_post(team_name, kind="finding", ref=<topic-or-file>, claim=<one-liner>)`
  - Prefer findings over directed messages. `ref` lets the cheap conflict
    checker key on it.
- For a compact state change (a port, a hash, a decision):
  - `bulletin_post(team_name, kind="signal", ref=<topic>, value=<compact>)`
  - Keep `value` tiny and structured. **Never** use a signal for prose.

Do NOT message other agents to "keep them posted" — they observe the
bulletin on their own cadence. Do NOT wait for acknowledgements.

### 3. Observe (cheap, frequent)

- `bulletin_read(team_name)` — catch up on what changed **since your last
  read** (per-agent watermark; the tool returns only NEW events and advances
  your cursor). Pass an explicit `since_seq` to re-read from a point.
- The read itself is a file read. The *cost* is the context you choose to
  load — so prefer `limit` over dumping everything.

### 4. Sync round (one LLM call per round — lead/summarizer only)

When a round of parallel work is done (or you have a natural checkpoint):

1. `bulletin_read(team_name)` — collect what's new since your last read.
2. `bulletin_conflicts(team_name, since_seq=<last digest seq>)` — cheap
   symbolic conflict check FIRST.
3. `bulletin_compact(team_name)` — CHEAP cleanup: archive events at or
   before the last digest into `archive.jsonl` so the live bulletin stays
   lean (the cleaner; keeps future rounds token-efficient).
4. Compress everything since the last digest into **one** digest (~200–500
   words): what was found, what changed, what is decided, what is open. Fold
   in any conflict resolutions (if a conflict is cheap to resolve, resolve it
   in the digest text; if it needs investigation, say so explicitly).
5. `bulletin_sync(team_name, digest=<your summary>, members=[...])`.

Other agents now read the digest as their shared picture. A digest is a
*snapshot*, not a command — teammates decide whether it changes their work.

### 5. Reconcile (only on conflict)

- Conflicts are normal (two agents touched the same `ref`). The cheap check
  finds them; the next sync round resolves them. Do NOT start a debate loop —
  one resolver (usually the lead) decides, records the decision, and the team
  moves on.
- **Record the decision**: `bulletin_resolve(team_name, ref=<topic>,
  decision=<choice>)` (LEAD ONLY). The symbolic checker stops flagging that
  ref, and the decision is folded into the next digest. If a conflict is
  material (changes someone's in-flight work), post a `signal` with the
  resolved `value` so the checker tracks the new baseline.
- **Evidence status**: when you post a `signal`/`finding`, you may attach
  `status` — `proposed` (default: an unconfirmed claim), `confirmed`
  (verified or corroborated), `contested` (in dispute), `superseded`
  (audit-only, not a live claim). The cheap checker uses these tiers: a
  confirmed claim beats a proposed one, and corroboration (≥2 agents posting
  the same canonical value) counts as confirmed automatically.
- **Reading `bulletin_conflicts` output**: cross-author divergent values are
  reported with a tier — `hard` (both sides confirmed; needs a decision),
  `medium` (one side confirmed), `soft` (both unconfirmed; often resolved by
  one more observation). Same-author later values appear as `update`, not
  conflict. A `superseded` line is an audit marker — the losing claim is
  kept in the log for the record, not deleted. Resolve cheap conflicts in
  the digest text; escalate `hard` ties explicitly.
- **Never silently erase a claim**: if a resolution invalidates a specific
  event, pass `supersedes=[<seq>]` to `bulletin_resolve` so the losing claim
  is preserved and marked, and future scans show the audit trail.

## Rules

- **The lead never waits for messages.** Teammates post findings to the
  bulletin; they do NOT send the lead (or each other) direct messages. The
  lead collects findings with `bulletin_read` and never asks anyone to
  "send lenses" — if you are the lead and you are idle waiting for input,
  you are misusing the protocol: run `bulletin_read` instead.
- **Never** use the bulletin for: permission grants, config changes, command
  execution, or anything that bypasses the harness's safety rules. It is a
  *coordination* channel only.
- Size cap: findings ≤ ~200 words; signals ≤ ~50 chars of `value`; digest ≤
  ~500 words.
- One writer per digest round (the lead/summarizer). Teammates post findings
  freely; they do not post digests.
- If you are blocked on information another agent has: post a `finding` with
  your question, continue on work that isn't blocked, and check the next
  digest. Do not message-spam.

## Watchdog

`scripts/start-team.py` runs a watchdog while a team is attached: if the
lead is idle ≥ N minutes (default 5) with unread bulletin events, it
injects a nudge into the lead's session telling it to `bulletin_read`.

- If you see the watchdog message, it is a *protocol reminder*, not a human
  command: run `bulletin_read` now, then `bulletin_conflicts` +
  `bulletin_sync` at round end. Never respond by asking teammates to send
  you anything — they never message the lead directly.
- The watchdog never writes to the bulletin; its audit trail is
  `watchdog.log` in the run's capture dir. Disable with `--no-watchdog`;
  tune with `--watchdog-idle-min`, `--watchdog-interval`,
  `--watchdog-nudge-min`.

## Example session (research task, 3 agents)

1. lead: `bulletin_status` → root confirmed.
2. lead tells each agent its slice (via normal task assignment, not the
   bulletin).
3. agent-a finds API moved: `bulletin_post(kind="finding", ref="api", claim="endpoint moved to /v2, old path 404s")`
4. agent-b sees `/v2` in its own work: posts `signal ref="api" value="v2"`.
5. agent-c (no change): reads digest at round end, continues.
6. lead: `bulletin_conflicts(since_seq=<d1>)` → clean; reads events; writes
   `bulletin_sync(digest="API moved to /v2 (agent-a); agent-b confirmed; docs updated...")`
7. Round 2 starts from the digest. No agent was interrupted mid-task by a
   message.
