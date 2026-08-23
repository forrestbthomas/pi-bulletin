# pi-bulletin vs pi-teams — Side-by-Side Eval Plan (rev 2, post-review)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or
> subagent-driven-development) to execute this plan phase-by-phase. Steps use
> checkbox (`- [ ]`) syntax for tracking. This is a *live experiment plan* —
> steps are operational (launch/record/commit), not code tasks.
>
> **Serves:** BACKLOG #12 MSG-1 (Cross-session peer messaging + bulletin
> fold-in) — this eval is the MSG-1 experiment vehicle; the verdict feeds
> MSG-1's charter-conformance DoD.
> **Review:** rev 1 reviewed by a fresh-context reviewer (2026-08-23,
> approve-with-fixes). Rev 2 incorporates all MAJORs and MINORs.

**Goal:** Measure whether the bulletin-first coordination design (pi-bulletin)
reduces coordination thrash and token cost versus the mailbox model (pi-teams)
on the same read-only parallel-review task, over two targets (dogfood +
fresh-eyes), and produce a written verdict against explicit acceptance criteria.

**Architecture:** 2×2 experiment. Protocol is the independent variable
(pi-teams mailbox vs pi-bulletin blackboard); target repo is the second factor
(pi-harness, context-rich; a pinned public repo, context-free). All other
conditions are fixed: identical task prompt, identical 5 roles, identical
model + thinking level, **identical pinned target checkouts**, read-only task
(agents never write files). Metrics: wall-clock, tokens, coordination events,
coordination LLM turns, conflicts, quality (blinded judge), MAST failure-mode
counts.

**Tech Stack:** Pi agent (provider **OpenRouter**, model `openai/gpt-5.6-terra`,
medium thinking — OpenAI direct credits exhausted 2026-08-23; OpenRouter
routes the SAME pinned model id, so results are OpenRouter-routed and a
re-run on OpenAI direct would re-baseline), tmux, pi-teams@0.9.14 (in
`try-pi-teams` worktree), pi-bulletin (in `spike-bulletin-protocol`
worktree), session JSONL transcripts (Usage fields), eval judge
(gpt-4.1-mini, blinded).

**Spec:** `spike/pi-bulletin/docs/DESIGN.md` (component-to-research mapping) and
`docs/agent-teams-coordination-research-2026-08.md` (evidence base). This plan
argues from those docs; executors read both.

## Global Constraints (invariants — do not deviate without recording why)

- **Task prompt is fixed text** (below). Same wording for every leg.
- **Roles are fixed**: `lead-synthesizer`, `bug-hunter`, `complexity-analyst`,
  `security-spotter`, `devil-advocate`. Same names/descriptions both protocols.
- **Model pinned**: provider `openrouter`, model `openai/gpt-5.6-terra`,
  thinking level `medium`, for every agent in every leg. (Route deviation
  2026-08-23: OpenAI direct credits exhausted; OpenRouter's defaultModel for
  this id is identical, so the pinned model is unchanged. Results are
  OpenRouter-routed; a future OpenAI-direct re-run re-baselines.) Post-hoc verify pi-teams teammates via
  `~/.pi/teams/<team>/config.json` (member `model`/`thinking`); any deviation
  ⇒ invalidate the cell or rerun.
- **Targets are pinned shared checkouts** (not the live worktrees):
  - harness target = fresh clone of pi-harness at commit `fbba1ca` (record the
    SHA actually used) → `eval-output/targets/harness`
  - public target = `spf13/cobra` at tag `v1.8.1` (swappable; record the
    repo+tag) → `eval-output/targets/cobra`
  Both legs of a target review the SAME checkout, so leg A and leg B see
  identical trees (no `spike/` delta, no branch drift).
- **Read-only**: agents never create/edit/delete files — including the final
  report. Reports are captured from the lead's final message in session JSONL
  by the helper (human/agent shell commands only, zero agent writes). Violation
  ⇒ note it; do not let either leg "fix" code.
- **Distinct coordination state per leg**: pi-teams team name and pi-bulletin
  `team_name`/`PI_BULLETIN_ROOT` must not collide (suffix per leg).
- **Session hygiene**: before each leg, archive/clear the worktree's
  `.pi/sessions/`; record the per-leg session file list (ids/timestamps) in the
  leg's `measurements.md` so token sums are auditable and no previous-leg or
  helper session leaks in.
- **Helper is shell-only**: the "helper" runs shell commands (tmux, git,
  reads) only — NO Pi session in the leg worktree, so it cannot pollute the
  token sum. Agent tool calls pass explicit bash `timeout:` and never start
  background/terminal-inheriting processes (AGENTS.md).
- **Eval-time settings override (recorded, then reverted)**: lower
  `retry.provider.timeoutMs` from 3600000 to ~600000 in the leg worktree's
  `.pi/settings.json` so a single stalled call cannot outlast a leg budget.
- **Hard budgets**: ≤ $8 per leg, ≤ 30 min wall-clock per leg (calibrated in
  pre-flight; see truncation rule), total ≤ $32 (Phase-1 gate may halve it).
- **No keys in artifacts**: sessions/transcripts are local-only; nothing
  containing API keys is committed.
- **Every leg ends with**: capture-before-cleanup, measurements row in
  `eval-output/<leg>/measurements.md`, one commit citing `BACKLOG #12 MSG-1`.

## Fixed artifacts

### Task prompt (verbatim, all legs)

```
Perform a read-only parallel review of this codebase. Do NOT modify any files.
Five agents each take one lens:

1. lead-synthesizer: do not investigate deeply yourself — collect the other
   agents' findings, resolve conflicts, and produce one prioritized findings
   report (top issues first, each with file/line evidence and a suggested fix).
2. bug-hunter: find real correctness bugs (not style nits). Evidence = code.
3. complexity-analyst: find over-complex or hard-to-maintain code paths.
4. security-spotter: find security-relevant issues (secrets, injection,
   unsafe defaults, missing validation). Evidence = code.
5. devil-advocate: for each major finding from others, play devil's advocate —
   is it actually a problem? Rank findings by real impact.

Synthesize into: a prioritized findings report (top 10 max, each with
file:line evidence, impact, suggested fix) plus a one-paragraph summary of
coordination quality (did the team's communication help or thrash?).
```

### Roles (both protocols)

| role | instruction (appended to spawn/system prompt) |
|---|---|
| lead-synthesizer | "You are the lead. Coordinate, resolve conflicts, do NOT duplicate others' investigation. Write the final report." |
| bug-hunter | "You are the bug-hunter lens. Find real correctness bugs with code evidence." |
| complexity-analyst | "You are the complexity lens. Find over-complex / hard-to-maintain code paths." |
| security-spotter | "You are the security lens. Find security-relevant issues with code evidence." |
| devil-advocate | "You are the devil's advocate. Stress-test others' findings; rank by real impact." |

### Spawn instruction for pi-teams legs (verbatim)

```
Create a team named '<team>' using openrouter/openai/gpt-5.6-terra with medium thinking. Spawn
all 5 teammates IN THE CURRENT WORKING DIRECTORY (<worktree root>): a
lead-synthesizer, a bug-hunter, a complexity-analyst, a security-spotter, and
a devil-advocate, each with the role instruction above. Then run the task
prompt verbatim.
```

Post-hoc verify: `~/.pi/teams/<team>/config.json` member `cwd` == worktree
root, `model` == `openrouter/openai/gpt-5.6-terra` (must start with
`openrouter/` — pi-teams would otherwise resolve the bare name to the direct
`openai` provider, which is out of credits and outside the pinned route),
`thinking` == medium.

### Measurements table (one row per leg; `eval-output/<leg>/measurements.md`)

| metric | definition / source |
|---|---|
| leg id / protocol / target / target SHA | recorded in the row header |
| wall-clock (start→done) | session notes; cross-check first/last message timestamps in session JSONL |
| total tokens (prompt+completion, summed) | per-session `Usage.Input/Output/TotalTokens` in `.pi/sessions/*.jsonl` (same parser pi-run `cost` uses — `internal/cli/cost.go`) |
| session file list | ids/timestamps archived before the leg (audit trail) |
| coordination events | pi-teams: messages across `~/.pi/teams/<team>/inboxes/*.json` (captured BEFORE shutdown); pi-bulletin: `bulletin_status` lastSeq / events.jsonl kind counts |
| coordination LLM turns (same unit both sides) | pi-teams: delivered inbox messages (each = 1 context injection); pi-bulletin: `kind="digest"` events + LLM reconcile rounds (digests.jsonl + conflict resolutions) |
| conflicts detected | pi-bulletin: `bulletin_conflicts` result — recorded as "signal conflicts" (cheap check only finds signal-vs-signal on same ref); pi-teams: n/a (record "—") |
| output quality (blinded judge 0–1) | judge pipeline (Phase 3.3); truncated reports marked "incomplete-at-cap" and excluded with disclosure |
| MAST failure-mode counts (by category) | transcript scan, protocol in Phase 3.2 |

## Leg matrix

| leg | protocol | target checkout | worktree | team name | driver |
|---|---|---|---|---|---|
| A | pi-teams | `eval-output/targets/harness@<sha>` | `try-pi-teams` | `teams-harness` | user (tmux) |
| B | pi-bulletin | `eval-output/targets/harness@<sha>` | `spike-bulletin-protocol` | `pb-harness` | user (tmux) + shell-only helper |
| C | pi-teams | `eval-output/targets/cobra@v1.8.1` | `try-pi-teams` | `teams-cobra` | user (tmux) |
| D | pi-bulletin | `eval-output/targets/cobra@v1.8.1` | `spike-bulletin-protocol` | `pb-cobra` | user (tmux) + shell-only helper |

Phase 1 = A+B (pilot). Phase 2 = C+D (fresh-eyes confirmation; **skippable
only if Phase 1 is decisive** per the defined gate).

---

## Phase 0: Setup + mandatory pre-flight

- [ ] **Step 0.1 — Verify environment.** `tmux -V`; `bw` session live
      (`BW_SESSION` set; refresh before EACH leg — vault sessions expire);
      `pi --version`; **model availability**: `pi --list-models` includes
      `openai/gpt-5.6-terra` (or the pinned alternative actually used — record
      it).
- [ ] **Step 0.2 — Confirm pi-teams leg environment.** In `try-pi-teams`
      worktree, confirm `npm:pi-teams@0.9.14` is in `.pi/settings.json`
      packages and `.pi/npm/package.json`.
- [ ] **Step 0.3 — Wire pi-bulletin into the spike worktree.** Add
      `"pi-bulletin": "file:../../spike/pi-bulletin"` to `.pi/npm/package.json`,
      add `"npm:pi-bulletin"` to `.pi/settings.json` `packages`, run `npm
      install` in `.pi/npm`. Fallback if `file:` refs unsupported: copy
      `spike/pi-bulletin` into `.pi/npm/node_modules/pi-bulletin` + same
      settings entry. Record which path worked.
- [ ] **Step 0.4 — Pin target checkouts.** Clone pi-harness at `fbba1ca` →
      `eval-output/targets/harness`; clone `spf13/cobra` at `v1.8.1` →
      `eval-output/targets/cobra`. Record actual SHAs. (`eval-output/targets/`
      is gitignored — the nested clones are scratch, not staged.)
- [ ] **Step 0.5 — MANDATORY capture dry-run, BOTH protocols (cheap).** One
      short run (2–3 min) of each protocol with 2 roles on a trivial question
      to verify: (a) bulletin tools register; (b) session JSONL lands in the
      worktree `.pi/sessions/` WITH `Usage` fields present; (c) pi-teams
      teammates spawn in the worktree root (check `config.json` `cwd`); (d)
      per-minute token/cost extrapolation to calibrate the leg cap (cap ≈
      slow-protocol observed time + 25% margin); (e) pi-bulletin digest round
      works end-to-end. **Any capture failure ⇒ fix setup before any paid run.**

      **Helper:** `scripts/run-leg.py <A|B|C|D> [--dryrun]` automates tmux
      setup, agent launch, prompt injection, attach, and capture for each leg
      (Python 3 stdlib; replaces an earlier bash version that broke on macOS
      bash 3.2). `scripts/tokens.py` sums per-session usage from captured
      session files.

## Phase 1: pi-harness pilot

### Leg A — pi-teams on harness (user-driven, tmux)

- [ ] **Step A.1 — Archive sessions + start tmux/Pi.** In `try-pi-teams`
      worktree: archive/clear `.pi/sessions/`, record start time. `tmux new -s
      teams-harness`; run `pi-run chat --provider openrouter --model
      openai/gpt-5.6-terra` (pi-run resolves pi via the absolute nvm path and
      pins the model).
- [ ] **Step A.2 — Create the team with the fixed spawn instruction.** Point
      the lead at the TARGET CHECKOUT (`eval-output/targets/harness`), not the
      worktree, for the review; spawn per the verbatim spawn instruction.
- [ ] **Step A.3 — Let it run.** Monitor via the agent panel. Wedged = no
      progress for ≥5 min (check pane/session output). Restart policy: a wedged
      teammate → message it to continue; a wedged LEAD twice in a row → abort
      the leg. Do not otherwise steer (steers recorded).
- [ ] **Step A.4 — Capture in the right order.** (1) copy team
      config/inboxes/task board (`~/.pi/teams/teams-harness/`,
      `~/.pi/tasks/teams-harness/`) and the lead's final report message into
      `eval-output/leg-a/` FIRST — shutdown/cleanup can remove them. (2) Then
      shut the team down gracefully so teammates exit and their session files
      flush to the worktree `.pi/sessions/`. (3) Then copy session files
      (`.pi/sessions/`) into `eval-output/leg-a/sessions/` — this is what makes
      the token sum complete (the dry-run proved teammate sessions only flush
      on exit). Clean up (`tmux kill-session`). The helper script prompts for
      the shutdown step.
- [ ] **Step A.5 — Verify + measure.** Post-hoc: `config.json` members'
      `cwd`/`model`/`thinking` — deviations invalidate the cell. Fill
      `eval-output/leg-a/measurements.md` per the table. If truncated at cap,
      mark `incomplete-at-cap`. Commit citing `BACKLOG #12 MSG-1`.

### Leg B — pi-bulletin on harness (user-driven, tmux + shell-only helper)

- [ ] **Step B.1 — Archive sessions + start tmux/Pi.** In
      `spike-bulletin-protocol` worktree: archive/clear `.pi/sessions/`;
      `tmux new -s pb-harness`; run `pi`.
- [ ] **Step B.2 — Launch 5 sessions with role env vars.** In 5 tmux panes,
      launch `PI_BULLETIN_AGENT=<role> PI_BULLETIN_ROOT=<eval-output>/bulletin
      pi-run chat --provider openrouter --model openai/gpt-5.6-terra`, all with
      team `pb-harness` and pointed at the TARGET CHECKOUT for the review. Give
      each its role instruction + task prompt. Record start time.
- [ ] **Step B.3 — Run the protocol.** Agents post findings to the bulletin;
      the lead runs `bulletin_conflicts` then `bulletin_sync` at round end
      (repeat rounds as needed). Wedged/restart: a wedged agent can be
      restarted cheaply (env vars) — restart rather than abort up to 2 agents.
- [ ] **Step B.4 — Capture + stop.** Record end time; capture session files +
      `bulletin_status` + `events.jsonl`/`digests.jsonl` into
      `eval-output/leg-b/`; close panes (`tmux kill-session`). Capture the lead
      report from session JSONL (zero agent writes).
- [ ] **Step B.5 — Measure + commit.** Fill `eval-output/leg-b/measurements.md`
      per the table; commit citing `BACKLOG #12 MSG-1`.
- [ ] **Step B.6 — Phase-1 verdict gate.** Compare A vs B on tokens, time,
      quality, MAST counts. **Gate (defined):** if all 3 criteria pass on the
      pilot, or ≥2 pass on both targets with none contradicting, Phase 2 is
      optional. Otherwise run Phase 2. Record the decision.

## Phase 2: public-repo fresh-eyes confirmation

### Leg C — pi-teams on cobra (user-driven, tmux)

- [ ] Repeat Leg A steps A.1–A.5 with target `eval-output/targets/cobra`, team
      `teams-cobra`, worktree `try-pi-teams`, output `eval-output/leg-c/`. Same
      task prompt + spawn instruction verbatim. Budget: ≤ $8, ≤ 30 min.

### Leg D — pi-bulletin on cobra (user-driven, tmux + shell-only helper)

- [ ] Repeat Leg B steps B.1–B.5 with target `eval-output/targets/cobra`, team
      `pb-cobra`, worktree `spike-bulletin-protocol`, output
      `eval-output/leg-d/`. Same task prompt verbatim. Budget: ≤ $8, ≤ 30 min.

## Phase 3: Analysis + verdict

- [ ] **Step 3.1 — Aggregate.** Copy all leg rows into `eval-output/summary.md`
      with the leg matrix.
- [ ] **Step 3.2 — MAST scan (defined protocol).** Per leg, read each agent's
      session transcript; count these modes, mapped to MAST categories: step
      repetition (FC1/FM-1.3), task derailment (FC2/FM-2.3), information
      withholding (FC2/FM-2.4), ignoring other agents' input (FC2/FM-2.5),
      premature termination (FC3/FM-3.1), incomplete/incorrect verification
      (FC3/FM-3.2/.3). One annotator (helper); each count needs a quoted
      evidence line. Record per-category totals.
- [ ] **Step 3.3 — Blinded quality judging.** Judge prompt: fixed rubric with
      per-dimension anchors — factual accuracy, completeness (all requested
      aspects), evidence quality (file:line), tool efficiency — 0–1 each,
      averaged. Judge model pinned and recorded (`gpt-4.1-mini`). **Blinding**:
      reports stripped of protocol/team markers, shuffled order, judged in one
      batch. Truncated-at-cap reports excluded with disclosure.
- [ ] **Step 3.4 — Verdict + MSG-1 DoD feed.** Write `eval-output/verdict.md`:
      which protocol won on tokens / time / quality, where thrash actually
      showed up, n=1-per-cell limitation stated, and an explicit
      **promote / retire / iterate** recommendation feeding MSG-1's
      charter-conformance DoD (charter: a standalone pi-bulletin OSS package is
      the vehicle; a harness runtime feature is NOT).
- [ ] **Step 3.5 — Update the research note.** Append the empirical results +
      promote/retire decision to `docs/agent-teams-coordination-research-2026-08.md`
      §"Decision log".
- [ ] **Step 3.6 — Commit.** `eval-output/summary.md`, `verdict.md`, research
      note update, in their respective repos, each citing `BACKLOG #12 MSG-1`.

## Acceptance criteria (verdict thresholds)

1. **Token hypothesis:** bulletin leg ≤ 60% of pi-teams leg tokens (summed
   across sessions, same target) ⇒ strong support. (Assumption: the 60% bar is
   derived from pi-teams' ~7× coordination amplification; recorded as an
   assumption, not a law.)
2. **Quality parity:** bulletin quality ≥ 0.8 × pi-teams quality (blinded judge
   0–1, same target) ⇒ no quality regression from the protocol. Truncated
   reports are excluded with disclosure, never judged as final.
3. **Thrash signal (same unit):** coordination LLM turns — pi-teams delivered
   inbox messages vs pi-bulletin digest events + reconcile rounds — are fewer
   for bulletin, OR wall-clock is comparable with fewer MAST FC2 (inter-agent)
   modes. Criterion 1 (tokens) is the cost arbiter; criterion 3 is supporting
   evidence.
4. **Consistency:** "directionally consistent" = all 3 criteria pass on the
   pilot target, OR ≥2 pass on both targets with none contradicting. If
   criteria 1–3 hold on both targets (or pass the pilot and are confirmed on
   the public repo) ⇒ pursue pi-bulletin as an OSS package. If tokens are not
   lower or quality regresses ⇒ retire the spike and record why.

## Abort criteria

- Any leg exceeds $8 or 30 min ⇒ stop that leg, record partial spend/time,
  mark `incomplete-at-cap`.
- **Mid-leg cost tripwire:** at ~15 min, check session JSONL usage totals; if
  projected spend > $8 ⇒ stop the leg.
- **Capture-integrity failure:** if session JSONL with Usage fields isn't
  being written after ~5 min (wrong spawn cwd / wrong session dir) ⇒ abort the
  leg (unmeasurable), fix, rerun.
- **Minimum-valid-team:** pi-teams requires ≥4 of 5 roles responsive (verify
  `config.json` members + pane presence); below that ⇒ abort the leg.
- **Model-pin violation:** post-hoc `config.json` `model`/`thinking` deviation
  ⇒ invalidate the cell or rerun.
- Orphaned tmux sessions accumulate (`tmux ls`) ⇒ kill and clean up, note it.
- API errors/wedges: >2 of 5 sessions wedged in a leg ⇒ abort (bullet leg may
  restart up to 2 agents cheaply first). Lead wedged twice ⇒ abort.
- `BW_SESSION` expiry mid-run ⇒ refresh before continuing; if a leg already
  started, record the gap.
- Bulletin tool registration fails in Phase 0 ⇒ fix or stop before spending.

## Risks & mitigations

| risk | mitigation |
|---|---|
| pi-teams teammate spawn outside the target/worktree | verbatim spawn instruction (cwd = worktree root; review target = pinned checkout) + post-hoc `config.json` check |
| pi-teams spawns non-pinned models ("smart model resolution") | pin model+thinking in spawn instruction; post-hoc `config.json` verification; invalidate cell on deviation |
| token capture polluted by prior/helper sessions | archive/clear `.pi/sessions/` before each leg; record session file list; helper is shell-only |
| task drift between legs | verbatim task prompt + role table; no per-leg rewording |
| agents write files despite read-only | read-only contract incl. report (captured from session JSONL); record violations |
| cost overrun / 1h per-call timeout | eval-time timeout override (600s); per-leg caps; mid-leg tripwire; Phase-1 gate before Phase 2 |
| judge bias | blinded, shuffled, pinned judge model, anchored rubric |
| truncation bias (pi-teams slow leg) | calibrated cap from pre-flight; `incomplete-at-cap` disclosure |
| interactive tmux driving | user drives; helper only scripts launches and captures artifacts (shell-only, bash `timeout:` on every call) |

## Review checklist (before execution)

- [ ] Task prompt identical across all 4 legs (verbatim copy used, not recalled).
- [ ] Model + thinking pinned identically; no cheap-tier substitution.
- [ ] Both targets are pinned shared checkouts — legs A/B see identical trees.
- [ ] Budgets and abort criteria are concrete numbers, not vibes; mid-leg
      tripwire defined.
- [ ] Measurement table fields capturable from session JSONL / bulletin status
      / transcripts — verified in the Phase 0.5 dry-run for BOTH protocols.
- [ ] Judge pipeline: pinned model, anchored rubric, blinded, shuffled.
- [ ] Both targets selected (harness @ SHA + cobra @ tag); Phase 2 gated.
- [ ] No API keys reach artifacts; no file writes in the target repos;
      eval-output/targets/ is gitignored.

## Decision log

- 2026-08-23: **Provider route → OpenRouter** (OpenAI direct credits exhausted).
  Pinned model unchanged (`openai/gpt-5.6-terra` — the openrouter provider's
  defaultModel is the identical id); launch becomes `pi-run chat --provider
  openrouter --model openai/gpt-5.6-terra`. Results are OpenRouter-routed; a
  future OpenAI-direct re-run re-baselines.
